import crypto from "crypto";

export const config = {
  api: { bodyParser: false },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifySignature(rawBody, signature) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !signature) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getQuestion(event) {
  const text = event.message?.text ?? "";
  const sourceType = event.source?.type;
  const isGroup = sourceType === "group" || sourceType === "room";

  if (!isGroup) return text.trim();

  const mentions = event.message?.mention?.mentionees ?? [];
  const botMentions = mentions.filter((item) => item.isSelf === true);
  if (botMentions.length === 0) return null;

  let question = text;
  for (const mention of botMentions.sort((a, b) => b.index - a.index)) {
    if (
      typeof mention.index === "number" &&
      typeof mention.length === "number"
    ) {
      question =
        question.slice(0, mention.index) +
        question.slice(mention.index + mention.length);
    }
  }

  return question.trim();
}

async function askGemini(question) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEYが設定されていません");

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: question }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 1500,
        },
      }),
      signal: AbortSignal.timeout(22000),
    }
  );

  if (!response.ok) {
    const details = await response.text();
    console.error("Gemini error:", response.status, details);
    throw new Error(`Gemini HTTP ${response.status}`);
  }

  const data = await response.json();
  const answer = (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();

  if (!answer) throw new Error("Geminiから文章が返りませんでした");
  return answer;
}

async function replyLINE(replyToken, message) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error("LINE_CHANNEL_ACCESS_TOKENが設定されていません");

  const response = await fetch(
    "https://api.line.me/v2/bot/message/reply",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          {
            type: "text",
            text: String(message).slice(0, 5000),
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    console.error("LINE reply error:", response.status, await response.text());
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("LINE AI Bot is running");
  }

  try {
    const rawBody = await readRawBody(req);
    if (!verifySignature(rawBody, req.headers["x-line-signature"])) {
      return res.status(401).send("Invalid signature");
    }

    const body = JSON.parse(rawBody.toString("utf8"));

    for (const event of body.events ?? []) {
      if (
        event.type !== "message" ||
        event.message?.type !== "text" ||
        !event.replyToken
      ) {
        continue;
      }

      const question = getQuestion(event);
      if (question === null) continue;

      let answer;
      if (!question) {
        answer = "メンションの後に質問を入力してください。";
      } else {
        try {
          answer = await askGemini(question);
        } catch (error) {
          console.error("AI接続エラー:", error);
          answer = `AI接続エラー: ${error.message}`;
        }
      }

      await replyLINE(event.replyToken, answer);
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).send("Internal Server Error");
  }
}
