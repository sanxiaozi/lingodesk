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

## Pricing & ways to run

- **Free** (cloud-hosted) — 300 translated replies/month, unlimited contacts, all features. Do the Telegram-side setup from your phone, DM your bot token to [@LingoDeskbot](https://t.me/LingoDeskbot) for **instant activation** (translation engine included). See the [setup guide](https://lingodesk.org/setup/) (~10 min).
- **Pro** — **500 ⭐/month (≈ $7)** via Telegram Stars: unlimited translations + priority support. Cancel anytime.
- **Self-hosted** — **free forever** (MIT), quick start below. The same codebase is multi-tenant: your instance can host other users too (they DM their tokens to *your* portal bot), and billing is off by default.

## Self-host requirements

- **Telegram Premium** (Telegram Business relay is Premium-only — hard requirement for both modes)
- Node.js ≥ 20 (or Docker)
- An Anthropic API key (plus an optional OpenAI key as fallback)

## Quick start (self-host)

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`), then in *Bot Settings* turn **Business Mode on** and **Group Privacy off**.
2. Phone → Settings → **Telegram Business** → **Chatbots** → link your bot with the *Reply to messages* permission.
3. Create a group with the bot, enable **Topics**, promote the bot to admin with **Manage Topics**.
4. Then:

```bash
git clone https://github.com/sanxiaozi/lingodesk.git
cd lingodesk
npm install
cp .env.example .env   # required: BOT_TOKEN, ANTHROPIC_API_KEY, TOKEN_SECRET (openssl rand -hex 32)
npm run db:push        # initialize SQLite (first run only)
npm run start          # or: npm run dev (hot reload)
```

5. DM your own bot its token (the same one from `.env`) — possessing the token proves ownership, so it registers you as the first tenant instantly. Then send `/bind` in your console group. Group ID and user ID are detected automatically — nothing to look up.

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
