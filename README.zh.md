# LingoDesk 🌐

> 在 Telegram 上用母语和全世界聊天。收 → 译 → 回 → 译,全自动。

**[官网](https://lingodesk.org/zh/)** · **[图文安装教程](https://lingodesk.org/zh/setup/)** · **[English](README.md)**

客户用任意语言私聊你的 **Telegram 真人号**,LingoDesk(经 Telegram Business)自动把消息译成中文、在你的控制台群里为每个客户开一个专属话题;你用中文回复,自动译回对方语言、预览确认后**以你本人名义**发出。客户全程看不到任何机器人。

## 能做什么

- **入站**:客户消息自动译中,双语卡片弹到该客户专属 Topic;表情/贴纸识别;图片/语音/文件/视频转发进 Topic 并本地存档
- **出站**:你在 Topic 里打中文 → 译成客户语 → 预览确认 → 以你名义发出;也可直接发文件给客户
- **稳健**:Claude 主引擎 + OpenAI 可选兜底;`business_connection_id` 实时刷新并持久化;每客户语种锁定;7 天无往来自动归档、来新消息自动复活
- **命令**:`/lang <码>` 手动纠正客户语种,`/help` 帮助

## 两种用法

1. **自托管** —— 免费开源,按下方快速开始跑起来,或看更详细的[图文教程](https://lingodesk.org/zh/setup/)(约 15 分钟)。
2. **托管到我们的服务器** —— 不想自己运维?我们替你跑:[hello@lingodesk.org](mailto:hello@lingodesk.org?subject=LingoDesk%20托管)。

## 前置条件

- **Telegram Premium**(Business 回灌是 Premium 专属,硬性前提)
- Node.js ≥ 20(或 Docker)
- `ANTHROPIC_API_KEY`(必填)+ `OPENAI_API_KEY`(可选兜底)

## 快速开始

```bash
git clone https://github.com/sanxiaozi/lingodesk.git
cd lingodesk
npm install
cp .env.example .env
```

1. 用 [@BotFather](https://t.me/BotFather) 建 bot(`/newbot`),然后在 *Bot Settings* 里 **开启 Business Mode**、**关闭 Group Privacy**(两个都必做)。
2. 手机 → 设置 → **Telegram Business** → **Chatbots** → 绑定你的 bot,勾选「回复消息」权限。
3. 建一个群拉入 bot,开启 **话题(Topics)**,把 bot 设为管理员并勾选 **管理话题**。
4. 把 `BOT_TOKEN` 填进 `.env`,在群里发一句、再用自己账号私聊 bot 发 `/start`,然后跑 `npm run ids` —— 直接打印出 `FORUM_CHAT_ID` 和 `OWNER_USER_ID`。
5. 补全 `.env`(加上 `ANTHROPIC_API_KEY`),然后:

```bash
npm run db:push   # 建表(仅首次)
npm run start     # 开发时用 npm run dev(热重载)
```

哪一步卡住了?[图文教程](https://lingodesk.org/zh/setup/)覆盖每个界面和所有已知坑。

## 部署到自己的服务器

**Docker(推荐):**

```bash
git clone https://github.com/sanxiaozi/lingodesk.git && cd lingodesk
cp .env.example .env   # 填好四个必填项
docker compose up -d --build
docker compose logs -f # 看到启动横幅即成功
```

数据库和媒体存档持久化在宿主机 `./data` 和 `./storage`。

**裸 Node + pm2:**

```bash
pm2 start "npm run start" --name lingodesk
pm2 save && pm2 startup
```

> ⚠️ 同一个 bot token **全球只能一个实例在跑**,否则 Telegram 报 `409 Conflict`。

## 已知限制

`BUSINESS_PEER_USAGE_MISSING`:Telegram Business 的硬规则 —— bot **只能回复近期主动给你发过消息的客户**,不能给太久没往来的客户主动发起。遇到时让对方先发一句激活,或你在真人号手动回这一次(草稿会保留)。

## 架构 / 路线图

见 [PLAN.md](PLAN.md):M0 单租户 MVP(当前)→ M1 多租户 SaaS → M2 商业化。

## 协议

[MIT](LICENSE)
