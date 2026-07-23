/**
 * 入口:官方门户 bot(自助开通 + 订阅收款)+ N 个租户中继实例。
 * 挂载顺序很重要:先 startAll(若官方 bot 兼任某租户中继,把中继 handler 挂上),
 * 再 attachPortal(私聊开通/支付),最后 start —— 中继不匹配的更新会 next() 流到门户。
 */
import { Bot } from "grammy";
import { config } from "./config.js";
import { attachPortal } from "./portal.js";
import { startAll, archiveStaleTopics, getRunningCount, setPortalUsername, stopAllGraceful } from "./manager.js";
import { expireStalePro } from "./db.js";
import { t, SUPPORTED } from "./i18n.js";
import { setEngineNotify } from "./ai/_client.js";
import { nudgeStuckTenants } from "./nudge.js";
import type { LanguageCode } from "@grammyjs/types";

const portal = new Bot(config.botToken);

// 翻译引擎降级/恢复 → 经门户 bot 私聊管理员
if (config.adminUserId) {
  setEngineNotify(async (text) => {
    await portal.api.sendMessage(config.adminUserId!, text);
  });
}

/**
 * 为门户 bot 注册 15 种界面语言的私聊命令菜单(用户在输入框打 / 时看到本地语提示)。
 * en 作为默认菜单(不带 language_code);其余语言各设一份,缺失描述自动回退英文。
 * 计费关闭时不展示 /subscribe /paysupport。
 */
async function setPortalCommands() {
  for (const code of SUPPORTED) {
    const cmds = [
      { command: "start", description: t("cmd.start", code) },
      { command: "free", description: t("cmd.free", code) },
      { command: "status", description: t("cmd.status", code) },
      { command: "usage", description: t("cmd.usage", code) },
      { command: "native", description: t("cmd.native", code) },
      { command: "to", description: t("cmd.to", code) },
    ];
    if (config.billingEnabled) {
      cmds.push({ command: "subscribe", description: t("cmd.subscribe", code) });
      cmds.push({ command: "paysupport", description: t("cmd.paysupport", code) });
    }
    await portal.api.setMyCommands(cmds, {
      scope: { type: "all_private_chats" },
      // en 写入默认菜单(language_code 省略),其它语言各写一份
      ...(code === "en" ? {} : { language_code: code as LanguageCode }),
    });
  }
}

await startAll(portal);
attachPortal(portal);

// 每小时检查一次,归档各租户不活跃 Topic
setInterval(() => {
  archiveStaleTopics().catch((e) => console.error("归档任务出错:", e));
}, 3_600_000);

// 每 6 小时把到期未续费的 Pro 降级 free
setInterval(() => {
  expireStalePro()
    .then((n) => n && console.log(`⬇️ ${n} 个到期 Pro 已降级 free`))
    .catch((e) => console.error("Pro 到期降级出错:", e));
}, 6 * 3_600_000);

// 开通卡点自动催办:启动 1 分钟后跑一次(马上覆盖存量卡住用户),之后每 6 小时
setTimeout(() => nudgeStuckTenants(portal.api).catch((e) => console.error("催办任务出错:", e)), 60_000);
setInterval(() => {
  nudgeStuckTenants(portal.api).catch((e) => console.error("催办任务出错:", e));
}, 6 * 3_600_000);

// 优雅停机:pm2 restart 发信号后先停轮询、把在飞更新处理完再退出。
// 否则更新已被 getUpdates 取走(offset 前移)却没处理完,进程一死消息永久丢失 —— 线上真实丢过。
let shuttingDown = false;
async function shutdown(sig: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${sig},优雅停机:停止轮询并处理完在飞更新…`);
  try {
    await Promise.allSettled([portal.stop(), stopAllGraceful()]);
    console.log("✅ 优雅停机完成");
  } finally {
    process.exit(0);
  }
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void portal.start({
  // 必须显式声明,否则收不到 business_* / my_chat_member / pre_checkout_query 更新
  allowed_updates: [
    "business_connection",
    "business_message",
    "message",
    "channel_post",
    "callback_query",
    "my_chat_member",
    "pre_checkout_query",
    "inline_query",
    "chosen_inline_result",
  ],
  onStart: (me) => {
    setPortalUsername(me.username);
    // 注册多语言命令菜单(失败不阻塞启动)
    setPortalCommands().catch((e) => console.error("设置命令菜单出错:", e));
    console.log("─".repeat(60));
    console.log(`🚀 LingoDesk M1 已启动,官方门户 = @${me.username}`);
    console.log(`   · 私聊 @${me.username} 发 bot token = 自助开通(分钟级)`);
    console.log(`   · 计费:${config.billingEnabled ? `开启(Pro ${config.priceStars}⭐/月,免费额度 ${config.freeQuota} 条/月)` : "关闭(不限量)"}`);
    console.log(`   · 租户实例:${getRunningCount()} 个在跑,每租户自己的 bot,互相隔离`);
    console.log("─".repeat(60));
  },
});
