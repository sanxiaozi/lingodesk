# LingoDesk — 开发计划

> 在 Telegram 上用母语和全世界聊天。收→译→回→译全自动的跨语言沟通中继。
> 域名:lingodesk.org。派生自 liteapks-biz-bot 的双向翻译主线,剥离了报价/收款/垃圾审核等业务专属功能。

## 产品形态

- 用户在自己的 **Telegram Business 真人号** 上绑定 LingoDesk bot。
- 客户/朋友用任意语言私聊用户真人号 → bot 回灌 → 自动译中 → 在用户的**控制台论坛群**为每个联系人开专属 Topic,弹双语卡片。
- 用户在 Topic 里打中文 → 自动译成对方语种 → 预览确认 → **以用户本人名义**发出。
- 双向消息 + 文件全部存档,可追溯。

## M0 — 单租户 MVP(当前阶段)✅ 代码就绪

- [x] 数据模型:Contact / Message / Asset / AppState(SQLite)
- [x] 翻译层:Claude 主 + OpenAI 兜底;入站译中+语种检测,出站纯翻译引擎(防出戏)
- [x] 入站:文本双语卡片 / 表情+自动开场白 / 媒体转发+存档 / 你手动回复回灌
- [x] 出站:中文→客户语,预览确认后发;文件直发;/lang 手动纠正语种
- [x] 语种首次锁定(短消息易误判,锁定后仅 /lang 可改)
- [x] 每客户 connId(为多连接/多租户铺路),Topic 7 天无往来自动归档
- [ ] 实测跑通:BotFather 建 bot → Business 绑定 → 建论坛群 → 配 .env → 试聊

## M1 — 多租户 SaaS 化

一个 bot 服务 N 个付费用户(每个用户 = 一个租户 = 一条 business_connection):

- datasource 改 `postgresql`,所有表加 `tenantId`(= 绑定用户的 owner user.id)
- `business_connection` 事件即租户注册入口:自动建租户档案
- 每租户一个控制台论坛群(bot 引导用户建群、拉 bot、发 `/bind` 绑定 forumChatId)
- 路由:入站按 `business_connection_id` → 租户;出站按 forumChatId → 租户
- 租户级配置:开场白文案、归档天数、母语(不一定是中文 → 译中层参数化为「译成租户母语」)

## M2 — 商业化

- 计费:免费额度(N 条译文/月)+ 订阅(Telegram Stars 或 USDT,复用 biz-bot 的 tron 对账)
- lingodesk.org 落地页:产品介绍 + 绑定引导 + 定价
- 用量统计与限额(按租户按月计译文条数)

## 技术备忘

- grammy + Prisma + tsx,与 biz-bot 同栈,验证过的坑直接复用:
  - `allowed_updates` 必须显式含 `business_*`,否则收不到回灌
  - connection_id 会失效:每条入站消息实时刷新 + DB 持久化,重启恢复
  - `BUSINESS_PEER_USAGE_MISSING`:客户太久没往来,bot 不能主动发起
  - 同一客户入站消息需串行(withLock),防并发建重复 Topic
- 单实例 long polling;多租户后仍单 bot 单实例,量大再切 webhook
