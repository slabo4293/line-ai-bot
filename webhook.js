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

  if (!secret || !signature) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  try {
    const expectedBuffer = Buffer.from(expected);
    const signatureBuffer = Buffer.from(signature);

    if (expectedBuffer.length !== signatureBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      expectedBuffer,
      signatureBuffer
    );
  } catch (error) {
    console.error("Signature verification error:", error);
    return false;
  }
}

function isBotMentioned(event) {
  const mentionees =
    event?.message?.mention?.mentionees ?? [];

  console.log(
    "MENTIONEES:",
    JSON.stringify(mentionees)
  );

  return mentionees.some(
    (mention) => mention?.isSelf === true
  );
}

function removeBotMention(event) {
  const text = event?.message?.text ?? "";

  const mentionees =
    event?.message?.mention?.mentionees ?? [];

  const selfMentions = mentionees
    .filter((mention) => mention?.isSelf === true)
    .sort((a, b) => b.index - a.index);

  let result = text;

  for (const mention of selfMentions) {
    if (
      typeof mention.index !== "number" ||
      typeof mention.length !== "number"
    ) {
      continue;
    }

    result =
      result.slice(0, mention.index) +
      result.slice(mention.index + mention.length);
  }

  return result.trim();
}

async function askOpenAI(question) {
  console.log("Sending question to OpenAI:", question);

  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",

      headers: {
        Authorization:
          `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        model:
          process.env.OPENAI_MODEL ||
          "gpt-5-mini",

        input: question,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    console.error(
      "OpenAI API error:",
      response.status,
      errorText
    );

    throw new Error(
      `OpenAI request failed: ${response.status}`
    );
  }

  const data = await response.json();

  if (
    typeof data.output_text === "string" &&
    data.output_text.trim()
  ) {
    return data.output_text.trim();
  }

  const texts = [];

  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      if (
        content.type === "output_text" &&
        typeof content.text === "string"
      ) {
        texts.push(content.text);
      }
    }
  }

  const result = texts.join("\n").trim();

  if (!result) {
    throw new Error(
      "OpenAI returned no text response"
    );
  }

  return result;
}

async function replyLINE(replyToken, text) {
  console.log("Sending reply to LINE");

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
          {
            type: "text",
            text: String(text).slice(0, 5000),
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    console.error(
      "LINE reply API error:",
      response.status,
      errorText
    );

    throw new Error(
      `LINE reply failed: ${response.status}`
    );
  }

  console.log("LINE reply succeeded");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res
      .status(200)
      .send("LINE AI Bot is running");
  }

  try {
    const rawBody = await readRawBody(req);

    const signature =
      req.headers["x-line-signature"];

    if (!verifySignature(rawBody, signature)) {
      console.error("Invalid LINE signature");

      return res
        .status(401)
        .send("Invalid signature");
    }

    let body;

    try {
      body = JSON.parse(
        rawBody.toString("utf8")
      );
    } catch (error) {
      console.error(
        "JSON parse error:",
        error
      );

      return res
        .status(400)
        .send("Invalid JSON");
    }

    console.log(
      "LINE WEBHOOK:",
      JSON.stringify(body)
    );

    if (
      !Array.isArray(body.events) ||
      body.events.length === 0
    ) {
      return res
        .status(200)
        .send("OK");
    }

    for (const event of body.events) {
      try {
        console.log(
          "LINE EVENT:",
          JSON.stringify(event)
        );

        if (
          event.type !== "message" ||
          event.message?.type !== "text" ||
          !event.replyToken
        ) {
          continue;
        }

        const sourceType =
          event.source?.type;

        const isGroup =
          sourceType === "group" ||
          sourceType === "room";

        if (isGroup) {
          const mentioned =
            isBotMentioned(event);

          console.log(
            "BOT MENTIONED:",
            mentioned
          );

          if (!mentioned) {
            continue;
          }
        }

        const question = isGroup
          ? removeBotMention(event)
          : event.message.text.trim();

        console.log(
          "QUESTION:",
          question
        );

        if (!question) {
          continue;
        }

        const answer =
          await askOpenAI(question);

        await replyLINE(
          event.replyToken,
          answer
        );
      } catch (error) {
        console.error(
          "Webhook event error:",
          error
        );
      }
    }

    // 重要：
    // OpenAIとLINEへの返信処理が完了してから
    // Vercelのレスポンスを終了する
    return res
      .status(200)
      .send("OK");

  } catch (error) {
    console.error(
      "Webhook fatal error:",
      error
    );

    return res
      .status(500)
      .send("Internal Server Error");
  }
      }
