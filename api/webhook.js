import crypto from "crypto";

export const config = {
  api: { bodyParser: false },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifySignature(raw, signature) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || typeof signature !== "string") {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(raw)
    .digest("base64");

  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length &&
      crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function conversationId(event) {
  const source = event.source;

  if (source?.type === "group" && source.groupId) {
    return `group:${source.groupId}`;
  }
  if (source?.type === "room" && source.roomId) {
    return `room:${source.roomId}`;
  }
  if (source?.type === "user" && source.userId) {
    return `user:${source.userId}`;
  }
  return null;
}

function getQuestion(event) {
  const text = event.message?.text;
  if (typeof text !== "string") return null;

  const type = event.source?.type;

  // 1対1のトークではメンション不要
  if (type !== "group" && type !== "room") {
    return text.trim();
  }

  const mentions =
    event.message?.mention?.mentionees ?? [];

  const botMentions = mentions
    .filter(m => m.isSelf === true)
    .sort((a, b) => b.index - a.index);

  // グループではBotへのメンションが必要
  if (botMentions.length === 0) return null;

  let question = text;

  for (const m of botMentions) {
    if (
      Number.isInteger(m.index) &&
      Number.isInteger(m.length) &&
      m.index >= 0 &&
      m.length >= 0
    ) {
      question =
        question.slice(0, m.index) +
        question.slice(m.index + m.length);
    }
  }

  return question.trim();
}

function supabaseBaseUrl() {
  const value = process.env.SUPABASE_URL?.trim();

  if (!value) {
    throw new Error("SUPABASE_URLが未設定です");
  }

  const url = new URL(value);

  // 環境変数がプロジェクトURLでもData API URLでも対応
  url.pathname = "/rest/v1/";
  url.search = "";
  url.hash = "";

  return url.toString();
}

async function dbRequest(path, options = {}) {
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!key) {
    throw new Error(
      "SUPABASE_SECRET_KEYが未設定です"
    );
  }

  const headers = {
    apikey: key,
    "Content-Type": "application/json",
    ...(key.startsWith("sb_secret_")
      ? {}
      : { Authorization: `Bearer ${key}` }),
    ...(options.headers ?? {}),
  };

  const response = await fetch(
    new URL(path, supabaseBaseUrl()),
    {
      ...options,
      headers,
      signal: AbortSignal.timeout(6000),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${await response.text()}`
    );
  }

  return response;
}

async function getHistory(id) {
  const params = new URLSearchParams({
    conversation_id: `eq.${id}`,
    select: "role,content,created_at",
    order: "created_at.desc",
    limit: "20",
  });

  const response = await dbRequest(
    `line_messages?${params.toString()}`,
    { method: "GET" }
  );

  const rows = await response.json();
  return Array.isArray(rows) ? rows.reverse() : [];
}

async function saveMessage(id, role, content) {
  await dbRequest("line_messages", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      conversation_id: id,
      role,
      content,
    }),
  });
}
async function askGemini(question, history) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error("GEMINI_API_KEYが未設定です");
  }

  const contents = history
    .filter(item =>
      (item.role === "user" ||
       item.role === "assistant") &&
      typeof item.content === "string" &&
      item.content.trim()
    )
    .map(item => ({
      role: item.role === "assistant"
        ? "model"
        : "user",
      parts: [{ text: item.content }],
    }));

  contents.push({
    role: "user",
    parts: [{ text: question }],
  });

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4096,
          thinkingConfig: {
            thinkingLevel: "low",
          },
        },
      }),
      signal: AbortSignal.timeout(25000),
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Gemini ${response.status}: ${JSON.stringify(data)}`
    );
  }

  const answer = data?.candidates?.[0]?.content?.parts
    ?.filter(part =>
      typeof part.text === "string" &&
      part.thought !== true
    )
    .map(part => part.text)
    .join("")
    .trim();

  if (!answer) {
    throw new Error(
      `Geminiの回答が空です: ${
        data?.candidates?.[0]?.finishReason ?? "不明"
      }`
    );
  }

  return answer;
}

async function replyToLine(replyToken, text) {
  const token =
    process.env.LINE_CHANNEL_ACCESS_TOKEN;

  if (!token || !replyToken) {
    throw new Error("LINEの返信設定がありません");
  }

  const response = await fetch(
    "https://api.line.me/v2/bot/message/reply",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: [{
          type: "text",
          text: text.slice(0, 5000),
        }],
      }),
      signal: AbortSignal.timeout(8000),
    }
  );

  if (!response.ok) {
    throw new Error(
      `LINE ${response.status}: ${await response.text()}`
    );
  }
}
async function handleEvent(event) {
  if (
    event.type !== "message" ||
    event.message?.type !== "text"
  ) {
    return;
  }

  const question = getQuestion(event);
  if (!question) return;

  const id = conversationId(event);
  if (!id) return;

  let history = [];

  try {
    history = await getHistory(id);
  } catch (error) {
    console.error("履歴取得エラー:", error);
  }

  let answer;

  try {
    answer = await askGemini(
      question,
      history
    );
  } catch (error) {
    console.error("Geminiエラー:", error);

    await replyToLine(
      event.replyToken,
      "申し訳ありません。回答を生成できませんでした。少し時間をおいて再度お試しください。"
    );
    return;
  }

  // 返信を履歴保存より先に行う
  await replyToLine(
    event.replyToken,
    answer
  );

  try {
    await saveMessage(id, "user", question);
    await saveMessage(id, "assistant", answer);
  } catch (error) {
    console.error("履歴保存エラー:", error);
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      message: "LINE AI Bot is running",
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({
      error: "Method Not Allowed",
    });
  }

  try {
    const raw = await readRawBody(req);
    const signature =
      req.headers["x-line-signature"];

    if (!verifySignature(raw, signature)) {
      return res.status(401).json({
        error: "Invalid LINE signature",
      });
    }

    let body;

    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).json({
        error: "Invalid JSON",
      });
    }

    const events = Array.isArray(body.events)
      ? body.events
      : [];

    for (const event of events) {
      try {
        await handleEvent(event);
      } catch (error) {
        console.error(
          "LINEイベントエラー:",
          error
        );
      }
    }

    return res.status(200).json({
      ok: true,
    });
  } catch (error) {
    console.error("Webhookエラー:", error);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
}
