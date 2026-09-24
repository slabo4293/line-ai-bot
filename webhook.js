import crypto from "node:crypto";

function verifyLineSignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function removeMentionRanges(text, mention) {
  const ranges = (mention?.mentionees || [])
    .filter(m => m.type === "user" && m.isSelf === true)
    .map(m => ({ index: m.index, length: m.length }))
    .sort((a, b) => b.index - a.index);

  let result = text;
  for (const r of ranges) {
    result = result.slice(0, r.index) + result.slice(r.index + r.length);
  }
  return result.trim();
}

async function askOpenAI(input) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      instructions:
        "あなたはLINEグループ内で質問に答えるAIアシスタントです。日本語では丁寧かつ簡潔に回答してください。",
      input
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${detail}`);
  }

  const data = await response.json();
  if (data.output_text) return data.output_text;

  const texts = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) texts.push(content.text);
    }
  }
  return texts.join("\n").trim() || "回答を生成できませんでした。";
}

async function replyLine(replyToken, text) {
  const response = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: text.slice(0, 5000) }]
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`LINE reply error ${response.status}: ${detail}`);
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, service: "line-ai-mention-bot" });
  }
  if (req.method !== "POST") {
    return res.status(405).end();
  }

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks);

    const signature = req.headers["x-line-signature"];
    if (!verifyLineSignature(rawBody, signature, process.env.LINE_CHANNEL_SECRET)) {
      return res.status(401).send("Invalid signature");
    }

    const body = JSON.parse(rawBody.toString("utf8"));

    // Acknowledge webhook quickly; processing continues in this invocation.
    for (const event of body.events || []) {
      if (
        event.type !== "message" ||
        event.message?.type !== "text" ||
        !event.replyToken
      ) continue;

      // In group/room chats, respond ONLY to a real mention of this bot.
      // In a 1-to-1 chat, respond to normal text as well.
      const isGroup = event.source?.type === "group" || event.source?.type === "room";
      const mention = event.message?.mention;
      const botWasMentioned = (mention?.mentionees || []).some(
        m => m.type === "user" && m.isSelf === true
      );

      if (isGroup && !botWasMentioned) continue;

      let question = event.message.text || "";
      if (botWasMentioned) question = removeMentionRanges(question, mention);
      if (!question) question = "何かお手伝いできることはありますか？";

      try {
        const answer = await askOpenAI(question);
        await replyLine(event.replyToken, answer);
      } catch (err) {
        console.error(err);
        try {
          await replyLine(event.replyToken, "申し訳ありません。AIへの接続でエラーが発生しました。");
        } catch (replyErr) {
          console.error(replyErr);
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).send("Internal Server Error");
  }
}
