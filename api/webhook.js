import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

// ========================================
// 共通処理
// ========================================

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

function verifySignature(rawBody, signature) {
  const secret = process.env.LINE_CHANNEL_SECRET;

  if (!secret || typeof signature !== "string") {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  try {
    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(signature);

    return (
      expectedBuffer.length === receivedBuffer.length &&
      crypto.timingSafeEqual(
        expectedBuffer,
        receivedBuffer
      )
    );
  } catch {
    return false;
  }
}

// ========================================
// LINEの質問を取り出す
// ========================================

function getConversationId(event) {
  const source = event.source;

  if (!source) {
    return null;
  }

  if (source.type === "group" && source.groupId) {
    return `group:${source.groupId}`;
  }

  if (source.type === "room" && source.roomId) {
    return `room:${source.roomId}`;
  }

  if (source.type === "user" && source.userId) {
    return `user:${source.userId}`;
  }

  return null;
}

function isGroupOrRoom(event) {
  return (
    event.source?.type === "group" ||
    event.source?.type === "room"
  );
}

function getQuestion(event) {
  const messageText = event.message?.text;

  if (typeof messageText !== "string") {
    return null;
  }

  // 1対1のトークではメンション不要
  if (!isGroupOrRoom(event)) {
    return messageText.trim();
  }

  const mentions =
    event.message?.mention?.mentionees ?? [];

  const botMentions = mentions.filter(
    (mention) => mention.isSelf === true
  );

  // グループ・複数人トークではBotへのメンションが必要
  if (botMentions.length === 0) {
    return null;
  }

  let question = messageText;

  // 後ろのメンションから削除し、前の位置がずれないようにする
  const sortedMentions = [...botMentions].sort(
    (a, b) => b.index - a.index
  );

  for (const mention of sortedMentions) {
    if (
      Number.isInteger(mention.index) &&
      Number.isInteger(mention.length) &&
      mention.index >= 0 &&
      mention.length >= 0
    ) {
      question =
        question.slice(0, mention.index) +
        question.slice(
          mention.index + mention.length
        );
    }
  }

  return question.trim();
}

// ========================================
// Supabase
// ========================================

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL または SUPABASE_SECRET_KEY が未設定です"
    );
  }

  return {
    url: url.replace(/\/+$/, ""),
    key,
  };
}

async function supabaseRequest(path, options = {}) {
  const { url, key } = getSupabaseConfig();

  // sb_secret_... はapikeyヘッダーで送る。
  // 旧service_roleキーの場合のみBearer認証も付ける。
  const authorizationHeaders = key.startsWith(
    "sb_secret_"
  )
    ? {}
    : { Authorization: `Bearer ${key}` };

  const response = await fetch(
    `${url}/rest/v1/${path}`,
    {
      ...options,

      headers: {
        apikey: key,
        ...authorizationHeaders,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },

      signal: AbortSignal.timeout(8000),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Supabase error ${response.status}: ${errorText}`
    );
  }

  return response;
}

async function getConversationHistory(
  conversationId,
  limit = 20
) {
  if (!conversationId) {
    return [];
  }

  const params = new URLSearchParams({
    conversation_id: `eq.${conversationId}`,
    select: "role,content,created_at",
    order: "created_at.desc",
    limit: String(limit),
  });

  const response = await supabaseRequest(
    `line_messages?${params.toString()}`,
    {
      method: "GET",
    }
  );

  const rows = await response.json();

  if (!Array.isArray(rows)) {
    return [];
  }

  // 古い発言から順にGeminiへ渡す
  return rows.reverse();
}

async function saveMessage({
  conversationId,
  role,
  text,
}) {
  if (!conversationId || !text) {
    return;
  }

  await supabaseRequest("line_messages", {
    method: "POST",

    headers: {
      Prefer: "return=minimal",
    },

    body: JSON.stringify({
      conversation_id: conversationId,
      role,
      content: text,
    }),
  });
}

// ========================================
// Gemini
// ========================================

async function askGemini(question, history) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY が未設定です"
    );
  }

  const contents = [];

  for (const item of history) {
    if (
      typeof item?.content !== "string" ||
      !item.content.trim()
    ) {
      continue;
    }

    if (
      item.role !== "user" &&
      item.role !== "assistant"
    ) {
      continue;
    }

    contents.push({
      role:
        item.role === "assistant"
          ? "model"
          : "user",

      parts: [
        {
          text: item.content,
        },
      ],
    });
  }

  contents.push({
    role: "user",

    parts: [
      {
        text: question,
      },
    ],
  });

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },

      body: JSON.stringify({
        contents,

        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4096,

          thinkingConfig: {
            thinkingBudget: 512,
          },
        },
      }),

      signal: AbortSignal.timeout(30000),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Gemini error ${response.status}: ${JSON.stringify(data)}`
    );
  }

  const answer = data?.candidates?.[0]?.content?.parts
    ?.filter(
      (part) =>
        typeof part.text === "string" &&
        part.thought !== true
    )
    .map((part) => part.text)
    .join("")
    .trim();

  if (!answer) {
    const finishReason =
      data?.candidates?.[0]?.finishReason ??
      "不明";

    throw new Error(
      `Geminiの回答が空です。finishReason: ${finishReason}`
    );
  }

  return answer;
}

// ========================================
// LINEへ返信
// ========================================

async function replyToLine(replyToken, text) {
  const accessToken =
    process.env.LINE_CHANNEL_ACCESS_TOKEN;

  if (!accessToken) {
    throw new Error(
      "LINE_CHANNEL_ACCESS_TOKEN が未設定です"
    );
  }

  if (!replyToken) {
    throw new Error(
      "LINEのreplyTokenがありません"
    );
  }

  const response = await fetch(
    "https://api.line.me/v2/bot/message/reply",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },

      body: JSON.stringify({
        replyToken,

        messages: [
          {
            type: "text",
            text: text.slice(0, 5000),
          },
        ],
      }),

      signal: AbortSignal.timeout(8000),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `LINE reply error ${response.status}: ${errorText}`
    );
  }
}

// ========================================
// LINEイベント処理
// ========================================

async function handleEvent(event) {
  if (
    event.type !== "message" ||
    event.message?.type !== "text"
  ) {
    return;
  }

  const question = getQuestion(event);

  // メンションなし、または質問文が空の場合
  if (!question) {
    return;
  }

  const conversationId =
    getConversationId(event);

  if (!conversationId) {
    return;
  }

  let history = [];

  try {
    history = await getConversationHistory(
      conversationId,
      20
    );
  } catch (error) {
    // 履歴が読めなくても今回の質問には回答する
    console.error(
      "会話履歴の取得に失敗:",
      error
    );
  }

  let answer;

  try {
    answer = await askGemini(
      question,
      history
    );
  } catch (error) {
    console.error(
      "Geminiの回答生成に失敗:",
      error
    );

    await replyToLine(
      event.replyToken,
      "申し訳ありません。現在、回答を生成できませんでした。少し時間をおいて、もう一度お試しください。"
    );

    return;
  }

  // 保存処理より先にLINEへ返信する
  await replyToLine(
    event.replyToken,
    answer
  );

  // 保存失敗で返信済みの処理を失敗扱いにしない
  try {
    await saveMessage({
      conversationId,
      role: "user",
      text: question,
    });

    await saveMessage({
      conversationId,
      role: "assistant",
      text: answer,
    });
  } catch (error) {
    console.error(
      "会話履歴の保存に失敗:",
      error
    );
  }
}

// ========================================
// Vercel API Handler
// ========================================

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "LINE AI Bot is running",
    });
  }

  if (req.method !== "POST") {
    res.setHeader(
      "Allow",
      ["GET", "POST"]
    );

    return res.status(405).json({
      error: "Method Not Allowed",
    });
  }

  try {
    const rawBody =
      await readRawBody(req);

    const signature =
      req.headers["x-line-signature"];

    if (
      !verifySignature(
        rawBody,
        signature
      )
    ) {
      return res.status(401).json({
        error: "Invalid LINE signature",
      });
    }

    let body;

    try {
      body = JSON.parse(
        rawBody.toString("utf8")
      );
    } catch {
      return res.status
