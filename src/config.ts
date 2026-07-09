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
  /** 官方门户 bot 的 token(自助开通入口;若它也绑了 Business,则同时兼任该租户的中继) */
  botToken: required("BOT_TOKEN"),
  /** 租户 token 静态加密密钥(openssl rand -hex 32 生成;换掉会导致已存 token 全部失效) */
  tokenSecret: required("TOKEN_SECRET"),
  /** 管理员 Telegram user.id(门户里 /tenants 等管理命令;不填则管理命令关闭) */
  adminUserId: process.env.ADMIN_USER_ID || undefined,
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
  /** 是否启用计费(官方云托管设 1;自托管默认关,所有人无限不计费) */
  billingEnabled: process.env.BILLING_ENABLED === "1",
  /** Pro 月订阅价格(Telegram Stars) */
  priceStars: process.env.PRICE_STARS ? Number(process.env.PRICE_STARS) : 500,
  /** 免费版每月出站发送额度(条) */
  freeQuota: process.env.FREE_QUOTA ? Number(process.env.FREE_QUOTA) : 300,
};
