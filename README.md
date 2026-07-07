# LingoDesk 🌐

> Chat with the world in your native language on Telegram.
> Receive → translate → reply → translate. Fully automatic.

**[Website](https://lingodesk.org)** · **[Illustrated setup guide](https://lingodesk.org/setup/)** · **[中文文档](README.zh.md)**

Customers message your **personal Telegram account** in any language. LingoDesk (via Telegram Business) translates every message into your language and drops it into a dedicated topic in your private console group — one topic per contact. You reply in your language; it's translated back, previewed for your confirmation, and sent **as you**. The other side never sees a bot.

## Features

- **Inbound**: auto-translated bilingual cards per contact topic; sticker/emoji recognition; photos, voice, documents and video forwarded into the topic and archived locally
- **Outbound**: type in your language → translated → preview → sent from your own account on confirmation; send files directly too
- **Robust**: Claude as the primary engine with optional OpenAI fallback; `business_connection_id` auto-refreshed and persisted; per-contact language lock; topics auto-archive after 7 idle days and revive on new messages
- **Commands**: `/lang <code>` to correct a contact's language, `/help` for the list

## Two ways to run it

1. **Self-host** — free and open source. Follow the quick start below, or the fully illustrated [step-by-step guide](https://lingodesk.org/setup/) (~15 minutes).
2. **Hosted by us** — don't want to run a server? We operate it for you: [hello@lingodesk.org](mailto:hello@lingodesk.org?subject=LingoDesk%20hosted).

## Requirements

- **Telegram Premium** (Telegram Business relay is Premium-only — hard requirement)
- Node.js ≥ 20 (or Docker)
- An Anthropic API key (plus an optional OpenAI key as fallback)

## Quick start

```bash
git clone https://github.com/sanxiaozi/lingodesk.git
cd lingodesk
npm install
cp .env.example .env
```

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`), then in *Bot Settings* turn **Business Mode on** and **Group Privacy off**.
2. Phone → Settings → **Telegram Business** → **Chatbots** → link your bot with the *Reply to messages* permission.
3. Create a group with the bot, enable **Topics**, promote the bot to admin with **Manage Topics**.
4. Put `BOT_TOKEN` into `.env`, post one message in the group, DM the bot `/start` from your account, then run `npm run ids` — it prints `FORUM_CHAT_ID` and `OWNER_USER_ID`.
5. Complete `.env` (add `ANTHROPIC_API_KEY`), then:

```bash
npm run db:push   # initialize SQLite (first run only)
npm run start     # or: npm run dev (hot reload)
```

Stuck anywhere? The [illustrated guide](https://lingodesk.org/setup/) covers every screen and every known pitfall.

## Deploy on your server

**Docker (recommended):**

```bash
git clone https://github.com/sanxiaozi/lingodesk.git && cd lingodesk
cp .env.example .env   # fill in the four required values
docker compose up -d --build
docker compose logs -f # watch the startup banner
```

Database and media archives persist in `./data` and `./storage` on the host.

**Bare Node with pm2:**

```bash
pm2 start "npm run start" --name lingodesk
pm2 save && pm2 startup
```

> ⚠️ One bot token = **one running instance globally**, or Telegram answers `409 Conflict`.

## Known limitation

`BUSINESS_PEER_USAGE_MISSING`: a Telegram Business rule — the bot can only reply to contacts who messaged you recently; it cannot initiate to long-idle chats. Ask the contact to send anything to reactivate, or reply manually from your phone that once (your draft is kept).

## Architecture & roadmap

See [PLAN.md](PLAN.md): M0 single-tenant MVP (current) → M1 multi-tenant SaaS → M2 billing & hosted service.

## License

[MIT](LICENSE)
