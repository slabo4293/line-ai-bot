import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
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

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

function isBotMentioned(event) {
  const mentionees = event?.message?.mention?.mentionees || [];
  return mentionees.some((m) => m.isSelf === true);
}

function removeBotMention(event) {
  const text = event?.message?.text || "";
  const mentionees = event?.message?.mention?.mentionees || [];

  const selfMentions = mentionees
    .filter((m) => m.isSelf === true)
    .sort((a, b) => b.index - a.index);

  let result = text;

  for (const mention of selfMentions) {
    result =
      result.slice(0, mention.index) +
      result.slice(mention.index + mention.length);
  }

  return result.trim();
}

async function askOpenAI(question) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      input: question,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("OpenAI error:", error);
    throw new Error("OpenAI request failed");
  }

  const data = await response.json();

  if (data.output_text) {
    return data.output_text;
  }

  const texts = [];

  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        texts.push(content.text);
      }
    }
  }

  return texts.join("\n") || "回答を生成できませんでした。";
}

async function replyLINE(replyToken, text) {
  const response = await fetch(
    "https://api.line.me/v2/bot/message/reply",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
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
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error("LINE reply error:", error);
    throw new Error("LINE reply failed");
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("LINE AI Bot is running");
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["x-line-signature"];

  if (!verifySignature(rawBody, signature)) {
    return res.status(401).send("Invalid signature");
  }

  let body;

  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  // LINEのWebhook検証用
  if (!body.events || body.events.length === 0) {
    return res.status(200).send("OK");
  }

  // LINE側への応答を先に返す
  res.status(200).send("OK");

  for (const event of body.events) {
    try {
      if (
        event.type !== "message" ||
        event.message?.type !== "text" ||
        !event.replyToken
      ) {
        continue;
      }

      const sourceType = event.source?.type;

      // グループ・複数人トークでは
      // Bot自身が実際に@メンションされた時だけ回答
      if (
        (sourceType === "group" || sourceType === "room") &&
        !isBotMentioned(event)
      ) {
        continue;
      }

      const question =
        sourceType === "group" || sourceType === "room"
          ? removeBotMention(event)
          : event.message.text.trim();

      if (!question) continue;

      const answer = await askOpenAI(question);
      await replyLINE(event.replyToken, answer);
    } catch (error) {
      console.error("Webhook event error:", error);
    }
  }
      }
