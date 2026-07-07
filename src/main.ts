/**
 * 入口:启动 bot(long polling)。
 * 注意:全局只能有一个实例在跑(否则 getUpdates 409),启动前确保探针/其它实例已停。
 */
import { bot, archiveStaleTopics, loadSavedState } from "./bot.js";

// 启动前从 DB 恢复上次有效的 business connection_id(防 restart 后用失效的 .env 旧值)
await loadSavedState();

// 每小时检查一次,归档不活跃 Topic
setInterval(() => {
  archiveStaleTopics().catch((e) => console.error("归档任务出错:", e));
}, 3_600_000);

bot.start({
  // 必须显式声明,否则收不到 business_* / my_chat_member 更新
  allowed_updates: ["business_connection", "business_message", "message", "callback_query", "my_chat_member"],
  onStart: (me) => {
    console.log("─".repeat(60));
    console.log(`🚀 LingoDesk 已启动,bot = @${me.username}`);
    console.log("   收→译→回→译 跨语言沟通中继:");
    console.log("   · 控制台群零配置:把 bot 拉进开启话题的群即自动绑定(或群里发 /bind)");
    console.log("   · 客户私聊你真人号 → 自动译中 + 在控制台 Topic 弹双语卡片");
    console.log("   · 你在 Topic 内打中文 → 预览确认 → 译客户语,以你名义发出");
    console.log("─".repeat(60));
  },
});
