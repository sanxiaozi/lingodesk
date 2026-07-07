/**
 * 配置读取与校验 —— 统一从 .env 读,缺关键项直接报错退出。
 * override:true 让项目 .env 优先于 shell 环境变量(避免 shell 里空/冲突的 KEY 覆盖)。
 */
import dotenv from "dotenv";

dotenv.config({ override: true });

function required(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`❌ 缺少环境变量 ${key},请在 .env 中配置。`);
    process.exit(1);
  }
  return v;
}

export const config = {
  /** BotFather 的 token */
  botToken: required("BOT_TOKEN"),
  /** 控制台论坛超级群 chat_id(可选:留空则运行时自动绑定 —— bot 进群自动识别,或在群里发 /bind) */
  forumChatId: process.env.FORUM_CHAT_ID ? Number(process.env.FORUM_CHAT_ID) : undefined,
  /** 首次启动前的 business_connection_id(运行时会被动态更新覆盖) */
  businessConnId: process.env.BUSINESS_CONNECTION_ID || undefined,
  /** 你自己的 user.id(判断消息方向:入站客户 / 出站你自己发的) */
  ownerUserId: process.env.OWNER_USER_ID ? Number(process.env.OWNER_USER_ID) : undefined,
  /** Claude API key */
  anthropicKey: required("ANTHROPIC_API_KEY"),
  /** 翻译用模型(默认 haiku 省成本) */
  model: process.env.LLM_MODEL || "claude-haiku-4-5",
  /** OpenAI 备用(Claude 调用失败时自动兜底) */
  openaiKey: process.env.OPENAI_API_KEY || undefined,
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  /** 新客户只发表情/无文本时,延迟多少毫秒自动发开场白 */
  greetDelayMs: process.env.GREET_DELAY_MS ? Number(process.env.GREET_DELAY_MS) : 30_000,
  /** 自动开场白(默认英语,通用) */
  greeting: process.env.GREETING || "Hi 👋 Thanks for reaching out! How can I help you today?",
  /** Topic 多少天无往来后自动归档(默认 7) */
  archiveAfterDays: process.env.ARCHIVE_AFTER_DAYS ? Number(process.env.ARCHIVE_AFTER_DAYS) : 7,
  /** 文件本地存档目录 */
  storageDir: process.env.STORAGE_DIR || "storage",
};
