/**
 * BotManager:一个进程持有 N 个 grammy Bot 实例(每租户自己的 token 各自 long polling)。
 * · 启动时拉起全部 active 租户;门户提交新 token 后热挂载,无需重启进程
 * · 租户 token 与官方门户 bot 相同 → 复用门户实例挂中继(官方 bot 兼任该租户的中继)
 * · token 失效(401)/多实例冲突(409)→ 自动停用租户 + 经门户 bot 通知用户
 */
import { Bot, GrammyError } from "grammy";
import { config } from "./config.js";
import { decrypt } from "./crypto.js";
import { attachRelay, archiveTopicsFor } from "./relay.js";
import { type Tenant, getActiveTenants, setTenantStatus, getStaleContacts } from "./db.js";

const ALLOWED_UPDATES = ["business_connection", "business_message", "message", "callback_query", "my_chat_member"] as const;

const running = new Map<string, Bot>(); // tenantId -> 实例(含共享门户实例)
let portalBot: Bot | undefined;
let portalTenantId: string | undefined; // 官方 bot 兼任中继的租户

export function getRunningCount(): number {
  return running.size;
}

export function isRunning(tenantId: string): boolean {
  return running.has(tenantId);
}

/** 经门户 bot 私聊通知租户(尽力而为) */
export async function notifyTenant(tenantId: string, text: string): Promise<void> {
  try {
    await portalBot?.api.sendMessage(Number(tenantId), text);
  } catch {
    /* 用户没跟门户对话过等,忽略 */
  }
}

async function handleFatal(tenantId: string, e: unknown): Promise<void> {
  const em = e instanceof Error ? e.message : String(e);
  if (e instanceof GrammyError && e.error_code === 401) {
    await setTenantStatus(tenantId, "disabled", "token 已失效(401)");
    running.delete(tenantId);
    console.warn(`[${tenantId}] ⛔ token 失效,已停用`);
    await notifyTenant(tenantId, "⚠️ 你的 bot token 已失效(可能在 BotFather 重置过)。服务已暂停,重新发送新 token 给我即可恢复。");
  } else if (e instanceof GrammyError && e.error_code === 409) {
    await setTenantStatus(tenantId, "disabled", "409:该 token 在别处也在运行");
    running.delete(tenantId);
    console.warn(`[${tenantId}] ⛔ 409 冲突,已停用`);
    await notifyTenant(
      tenantId,
      "⚠️ 你的 bot 在其它地方也在运行(比如你自己部署了一份),同一 token 全球只能一个实例。已暂停云端实例;想用云端就先停掉你那份,再发 /enable 给我。",
    );
  } else {
    console.error(`[${tenantId}] 实例异常退出:`, em);
  }
}

/** 拉起一个租户实例(已在跑则先停旧的;token=门户 token 则复用门户实例) */
export async function startTenant(t: Tenant): Promise<void> {
  await stopTenant(t.id);
  const token = decrypt(t.botToken);

  const notify = (text: string) => notifyTenant(t.id, text);

  if (portalBot && token === config.botToken) {
    // 官方门户 bot 兼任该租户的中继:同一实例挂两套 handler(中继在 portal 之前挂,见 main.ts 顺序)
    attachRelay(portalBot, t.id, notify);
    running.set(t.id, portalBot);
    portalTenantId = t.id;
    console.log(`[${t.id}] ▶️ 中继挂载到官方门户实例(@${t.botUsername})`);
    return;
  }

  const b = new Bot(token);
  attachRelay(b, t.id, notify);
  running.set(t.id, b);
  void b
    .start({
      allowed_updates: [...ALLOWED_UPDATES],
      onStart: () => console.log(`[${t.id}] ▶️ 实例已启动 @${t.botUsername}`),
    })
    .catch((e) => handleFatal(t.id, e));
}

export async function stopTenant(tenantId: string): Promise<void> {
  const b = running.get(tenantId);
  if (!b) return;
  running.delete(tenantId);
  if (b === portalBot) {
    // 门户实例不真正停(还要做开通入口);中继 handler 留着但租户可能已 disabled,由 relay 侧按 DB 状态自然失效
    portalTenantId = undefined;
    return;
  }
  try {
    await b.stop();
  } catch {
    /* 忽略 */
  }
}

/** 启动时拉起全部 active 租户 */
export async function startAll(portal: Bot): Promise<void> {
  portalBot = portal;
  const tenants = await getActiveTenants();
  for (const t of tenants) {
    try {
      await startTenant(t);
    } catch (e) {
      await handleFatal(t.id, e);
    }
  }
  console.log(`👥 已拉起 ${running.size}/${tenants.length} 个租户实例(其中门户兼任:${portalTenantId ? 1 : 0})`);
}

/** 归档所有租户超期无往来的 Topic(main.ts 定时调用) */
export async function archiveStaleTopics(): Promise<void> {
  const cutoff = new Date(Date.now() - config.archiveAfterDays * 86_400_000);
  const stale = await getStaleContacts(cutoff);
  const byTenant = new Map<string, { tenant: Tenant; items: { contactId: number; threadId: number }[] }>();
  for (const c of stale) {
    if (c.threadId == null) continue;
    const g = byTenant.get(c.tenantId) ?? { tenant: c.tenant, items: [] };
    g.items.push({ contactId: c.id, threadId: c.threadId });
    byTenant.set(c.tenantId, g);
  }
  let n = 0;
  for (const { tenant, items } of byTenant.values()) {
    const b = running.get(tenant.id);
    if (!b) continue; // 实例没在跑(disabled 等),跳过
    await archiveTopicsFor(b, tenant, items);
    n += items.length;
  }
  if (n) console.log(`📁 已归档 ${n} 个不活跃 Topic`);
}
