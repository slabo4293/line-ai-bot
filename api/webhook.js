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

  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);

    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ----------------------------
// LINE情報
// ----------------------------

function getConversationId(event) {
  if (event.source?.type === "group") {
    return `group:${event.source.groupId}`;
  }

  if (event.source?.type === "room") {
    return `room:${event.source.roomId}`;
  }

  if (event.source?.type === "user") {
    return `user:${event.source.userId}`;
  }

  return null;
}

function isGroupOrRoom(event) {
  return (
    event.source?.type === "group" ||
    event.source?.type === "room"
  );
}

function isBotMentioned(event) {
  const mentions =
    event.message?.mention?.mentionees ?? [];

  return mentions.some(
    (item) => item.isSelf === true
  );
}

function getQuestion(event) {
  const text = event.message?.text ?? "";

  // 1対1ではメンション不要
  if (!isGroupOrRoom(event)) {
    return text.trim();
  }

  const mentions =
    event.message?.mention?.mentionees ?? [];

  const botMentions = mentions.filter(
    (item) => item.isSelf === true
  );

  // グループではメンションされていなければ返信しない
  if (botMentions.length === 0) {
    return null;
  }

  let question = text;

  // @AI部分だけ取り除く
  for (
    const mention of [...botMentions].sort(
      (a, b) => b.index - a.index
    )
  ) {
    if (
      typeof mention.index === "number" &&
      typeof mention.length === "number"
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

// ----------------------------
// Supabase
// ----------------------------

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;

  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Supabase環境変数が設定されていません"
    );
  }

  return { url, key };
}

async function saveMessage(event) {
  const conversationId =
    getConversationId(event);

  if (!conversationId) return;

  const text = event.message?.text?.trim();

  if (!text)
