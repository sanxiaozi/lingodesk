# LingoDesk

> 在 Telegram 上用母语和全世界聊天。收 → 译 → 回 → 译,全自动。
> lingodesk.org

客户用任意语言私聊你的 Telegram 真人号,LingoDesk 自动把消息译成中文、在你的控制台群里为每个客户开一个专属话题;你用中文回复,自动译回对方语言、预览确认后**以你本人名义**发出。你永远只用母语工作,客户那边全程看不到中文。

## 能做什么

- **入站**:客户消息自动译中,双语卡片弹到该客户专属 Topic;表情/贴纸识别;图片/语音/文件/视频转发进 Topic 并本地存档
- **出站**:你在 Topic 里打中文 → 译成客户语 → 预览确认 → 以你名义发出;也可直接发文件给客户
- **稳健**:Claude 主 + OpenAI 兜底;connection_id 实时刷新+持久化;每客户语种锁定;7 天无往来自动归档、来新消息自动复活
- **命令**:`/lang <码>` 手动纠正客户语种,`/help` 帮助

## 前置条件

1. **Telegram Premium**(Business 功能的前提)
2. 一个 Bot(BotFather 创建,拿到 `BOT_TOKEN`)
3. 一个开启了「话题(Topics)」的超级群,作为控制台
4. `ANTHROPIC_API_KEY`(必填)+ `OPENAI_API_KEY`(可选兜底)

## 快速开始

### 1. 创建 Bot

BotFather → `/newbot` → 记下 `BOT_TOKEN`。

### 2. 绑定 Business

Telegram 设置 → **Business** → **Chatbots** → 填入你的 bot 用户名 → 授予「回复消息」权限。

### 3. 建控制台群

- 新建群 → 升级为超级群 → 群设置里开启 **话题(Topics)**
- 把 bot 拉进群,设为管理员并勾选 **管理话题** 权限
- 在群里发条消息,从 [@RawDataBot](https://t.me/RawDataBot) 或启动日志拿到 `chat_id`(`-100` 开头)

### 4. 配置 `.env`

```bash
cp .env.example .env
```

填入 `BOT_TOKEN`、`FORUM_CHAT_ID`、`OWNER_USER_ID`(你自己的 Telegram user.id)、`ANTHROPIC_API_KEY`,可选 `OPENAI_API_KEY`。

### 5. 初始化并启动

```bash
npm install          # 安装依赖
npm run db:push      # 建表(SQLite)
npm run start        # 启动;开发时用 npm run dev(热重载)
```

### 6. 触发 Business 连接

首次到 **Business → Chatbots** 重连一次,或让客户发条消息 —— bot 会自动捕获并持久化 `business_connection_id`。之后重启不丢。

## 部署(自有 VPS)

单实例 long polling(**全局只能一个实例**,否则 `getUpdates` 409)。推荐 pm2 常驻:

```bash
pm2 start "npm run start" --name lingodesk
pm2 save && pm2 startup
```

## 已知限制

`BUSINESS_PEER_USAGE_MISSING`:这是 Telegram Business 的硬规则 —— bot **只能回复近期主动给你发过消息的客户**,不能给太久没往来的客户主动发起。遇到时让对方先发一句激活,或你在真人号手动回这一次(草稿会保留)。

## 架构 / 路线图

见 [PLAN.md](PLAN.md):M0 单租户 MVP(当前)→ M1 多租户 SaaS → M2 商业化。
