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
  if (event.type !== "message" || event.message?.type !== "text") {
    return null;
  }

  const text = event.message.text || "";
  const sourceType = event.source?.type;

  if (sourceType !== "group" && sourceType !== "room") {
    return text.trim();
  }

  const mentions = event.message.mention?.mentionees || [];
  const botMentions = mentions
    .filter((mention) => mention.isSelf === true)
    .sort((a, b) => b.index - a.index);

  if (botMentions.length === 0) return null;

  let question = text;
  for (const mention of botMentions) {
    question =
      question.slice(0, mention.index) +
      question.slice(mention.index + mention.length);
  }

  return question.trim();
}

async function replyLINE(replyToken, text) {
  const response = await fetch(
    "https://api.line.me/v2/bot/message/reply",
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        replyToken,
        messages: [
          { type: "text", text: String(text).slice(0, 5000) },
        ],
      }),
    }
  );

  if (!response.ok) {
    console.error("LINE reply error:", response.status, await response.text());
  }
}

async function askOpenAI(question) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-5-mini",
        input: question,
      }),
    }
  );

  if (!response.ok) {
    console.error("OpenAI error:", response.status, await response.text());
    throw new Error("OpenAI request failed");
  }

  const data = await response.json();
  const answer =
    data.output_text ||
    data.output
      ?.flatMap((item) => item.content || [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text)
      .join("\n");

  if (!answer?.trim()) throw new Error("OpenAI returned no text");
  return answer.trim();
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

    for (const event of body.events || []) {
      if (!event.replyToken) continue;

      const question = getQuestion(event);
      if (!question) continue;

      try {
        const answer = await askOpenAI(question);
        await replyLINE(event.replyToken, answer);
      } catch (error) {
        console.error("Bot error:", error);
        await replyLINE(
          event.replyToken,
          "AIへの接続でエラーが発生しました。"
        );
      }
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).send("Internal Server Error");
  }
}
