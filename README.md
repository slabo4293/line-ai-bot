# LINE AI Mention Bot

Vercel + LINE Messaging API + OpenAI Responses API.

## Environment Variables
- LINE_CHANNEL_SECRET
- LINE_CHANNEL_ACCESS_TOKEN
- OPENAI_API_KEY
- OPENAI_MODEL (optional; defaults to gpt-5-mini)

## Webhook
After deployment, set the LINE Messaging API Webhook URL to:

https://YOUR-VERCEL-DOMAIN/api/webhook

## Behavior
- Group/room: replies only when the LINE Official Account itself is actually mentioned.
- 1-to-1 chat: replies to ordinary text messages.
- Verifies LINE x-line-signature before processing events.
