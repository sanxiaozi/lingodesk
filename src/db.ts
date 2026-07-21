/**
 * 数据访问层(SQLite/Prisma),M1 多租户版。
 * 迁 Postgres 时本文件无需改动,只改 schema.prisma 的 datasource。
 */
import { PrismaClient, type Tenant, type Contact } from "@prisma/client";
import { config } from "./config.js";

export const prisma = new PrismaClient();
export type { Tenant, Contact };

// 并发写稳健:WAL 模式 + 忙等超时(N 个 bot 实例与定时任务会并发写 SQLite)
await prisma.$executeRawUnsafe("PRAGMA journal_mode=WAL").catch(() => {});
await prisma.$executeRawUnsafe("PRAGMA busy_timeout=5000").catch(() => {});

// ── 租户 ──────────────────────────────────────────────────────────────

/** 注册/换 token 重开通(门户提交时调用)。同一提交者重复提交 = 更新。 */
export function upsertTenant(d: {
  id: string;
  botId: string;
  botUsername: string;
  botToken: string;
  name?: string;
  username?: string;
}) {
  return prisma.tenant.upsert({
    where: { id: d.id },
    create: { ...d, name: d.name ?? "", username: d.username ?? "", ownerUserId: d.id },
    update: {
      botId: d.botId,
      botUsername: d.botUsername,
      botToken: d.botToken,
      status: "active",
      statusNote: "",
    },
  });
}

export function getTenant(id: string) {
  return prisma.tenant.findUnique({ where: { id } });
}

export function getTenantByBotId(botId: string) {
  return prisma.tenant.findUnique({ where: { botId } });
}

export function getActiveTenants() {
  return prisma.tenant.findMany({ where: { status: "active" } });
}

export function getAllTenants() {
  return prisma.tenant.findMany({ orderBy: { createdAt: "asc" } });
}

export function setTenantStatus(id: string, status: "active" | "disabled", note = "") {
  return prisma.tenant.update({ where: { id }, data: { status, statusNote: note } });
}

/** 绑定/换绑控制台群 */
export function setTenantForum(id: string, forumChatId: string) {
  return prisma.tenant.update({ where: { id }, data: { forumChatId } });
}

/** business_connection 事件:刷新连接、owner 与回复权限 */
export function setTenantConn(id: string, connId: string, ownerUserId?: string, canReply?: boolean) {
  return prisma.tenant.update({
    where: { id },
    data: { connId, ownerUserId: ownerUserId ?? undefined, canReply: canReply ?? undefined },
  });
}

/** 设置租户母语 */
export function setTenantNativeLang(id: string, nativeLang: string) {
  return prisma.tenant.update({ where: { id }, data: { nativeLang } });
}

/** 租户消息用量(累计,从 Message 表统计) */
export async function tenantUsage(id: string): Promise<{ contacts: number; inMsgs: number; outMsgs: number }> {
  const [contacts, inMsgs, outMsgs] = await Promise.all([
    prisma.contact.count({ where: { tenantId: id } }),
    prisma.message.count({ where: { direction: "in", contact: { tenantId: id } } }),
    prisma.message.count({ where: { direction: "out", contact: { tenantId: id } } }),
  ]);
  return { contacts, inMsgs, outMsgs };
}

// ── 计费(Telegram Stars 订阅) ────────────────────────────────────────

/** 当前计量月份键 "YYYY-MM" */
function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 本月已用出站条数(跨月视为 0) */
export function currentUsage(t: Tenant): number {
  return t.usageMonth === monthKey() ? t.usageCount : 0;
}

/** 运营事件埋点(用户遇到的问题;fire-and-forget,失败静默,绝不影响主流程) */
export function logEvent(userId: string, type: string, detail = "", username = ""): void {
  prisma.opsEvent.create({ data: { userId, type, detail, username } }).catch(() => {});
}

/** 是否已超免费额度(计费开启 + free + 本月用量达标才 true) */
export function isOverQuota(t: Tenant): boolean {
  if (!config.billingEnabled || t.plan === "pro") return false;
  return currentUsage(t) >= config.freeQuota;
}

/** 出站发送成功后计一条(跨月自动重置为 1);同时累计 MonthlyUsage 月度流水(看板/对账) */
export async function bumpOutbound(tenantId: string): Promise<void> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId } });
  if (!t) return;
  const mk = monthKey();
  await prisma.tenant.update({
    where: { id: tenantId },
    data: t.usageMonth === mk ? { usageCount: { increment: 1 } } : { usageMonth: mk, usageCount: 1 },
  });
  await prisma.monthlyUsage
    .upsert({
      where: { tenantId_month: { tenantId, month: mk } },
      create: { tenantId, month: mk, outCount: 1 },
      update: { outCount: { increment: 1 } },
    })
    .catch(() => {}); // 流水失败不影响计量主链路
}

// ── 常用回复模板 ──────────────────────────────────────────────────────
export function getTemplates(tenantId: string) {
  return prisma.template.findMany({ where: { tenantId }, orderBy: { label: "asc" } });
}

export function getTemplate(id: number) {
  return prisma.template.findUnique({ where: { id } });
}

export function upsertTemplate(tenantId: string, label: string, text: string) {
  return prisma.template.upsert({
    where: { tenantId_label: { tenantId, label } },
    create: { tenantId, label, text },
    update: { text },
  });
}

export async function delTemplate(tenantId: string, label: string): Promise<boolean> {
  const r = await prisma.template.deleteMany({ where: { tenantId, label } });
  return r.count > 0;
}

// ── 跨语言群/频道 ─────────────────────────────────────────────────────
export function getGroupChat(tenantId: string, chatId: string) {
  return prisma.groupChat.findUnique({ where: { tenantId_chatId: { tenantId, chatId } } });
}

export function upsertGroupChat(tenantId: string, chatId: string, d: { title?: string; kind?: string; targetLang?: string; enabled?: boolean }) {
  return prisma.groupChat.upsert({
    where: { tenantId_chatId: { tenantId, chatId } },
    create: { tenantId, chatId, title: d.title ?? "", kind: d.kind ?? "group", targetLang: d.targetLang ?? "en", enabled: d.enabled ?? true },
    update: d,
  });
}

// ── 用量看板 ──────────────────────────────────────────────────────────
/** 近 N 个月的计费口径出站流水(含群翻译),新→旧 */
export function monthlyHistory(tenantId: string, months = 3) {
  return prisma.monthlyUsage.findMany({ where: { tenantId }, orderBy: { month: "desc" }, take: months });
}

/** 某租户本月消息收/发统计(自然月,UTC) */
export async function tenantMonthStats(tenantId: string): Promise<{ inMsgs: number; outMsgs: number; newContacts: number }> {
  const start = new Date(`${monthKey()}-01T00:00:00Z`);
  const [inMsgs, outMsgs, newContacts] = await Promise.all([
    prisma.message.count({ where: { contact: { tenantId }, direction: "in", createdAt: { gte: start } } }),
    prisma.message.count({ where: { contact: { tenantId }, direction: { in: ["out", "manual"] }, createdAt: { gte: start } } }),
    prisma.contact.count({ where: { tenantId, createdAt: { gte: start } } }),
  ]);
  return { inMsgs, outMsgs, newContacts };
}

/** 某联系人最近 N 条往来(旧→新,给 AI 拟稿当上下文) */
export async function recentMessages(contactId: number, n = 10) {
  const rows = await prisma.message.findMany({ where: { contactId }, orderBy: { id: "desc" }, take: n });
  return rows.reverse();
}

/** 置为 Pro(订阅成功/续费);proUntil 用 Telegram 给的到期时间 */
export function setPlanPro(id: string, proUntil: Date, chargeId?: string) {
  return prisma.tenant.update({
    where: { id },
    data: { plan: "pro", proUntil, subChargeId: chargeId ?? undefined },
  });
}

/** 降级 free(到期/取消) */
export function setPlanFree(id: string) {
  return prisma.tenant.update({ where: { id }, data: { plan: "free", proUntil: null } });
}

/** 到期未续费的 Pro 自动降级 free(定时调用),返回降级数量 */
export async function expireStalePro(): Promise<number> {
  const r = await prisma.tenant.updateMany({
    where: { plan: "pro", proUntil: { lt: new Date() } },
    data: { plan: "free", proUntil: null },
  });
  const r2 = await prisma.liteUser.updateMany({
    where: { plan: "pro", proUntil: { lt: new Date() } },
    data: { plan: "free", proUntil: null },
  });
  return r.count + r2.count;
}

// ── 轻量用户(免 Premium 玩法:内联/私聊翻译) ─────────────────────────
export type { LiteUser } from "@prisma/client";

/** 取或建轻量用户;首次按 Telegram 客户端语言初始化母语 */
export function getOrCreateLiteUser(id: string, langCode?: string) {
  const native = (langCode ?? "en").toLowerCase().startsWith("zh") ? "zh" : (langCode ?? "en").slice(0, 2) || "en";
  return prisma.liteUser.upsert({ where: { id }, create: { id, nativeLang: native }, update: {} });
}

export function updateLiteUser(id: string, data: { nativeLang?: string; targetLang?: string }) {
  return prisma.liteUser.update({ where: { id }, data });
}

export function liteUsage(u: { usageMonth: string; usageCount: number }): number {
  return u.usageMonth === monthKey() ? u.usageCount : 0;
}

export function isLiteOverQuota(u: { plan: string; usageMonth: string; usageCount: number }): boolean {
  if (!config.billingEnabled || u.plan === "pro") return false;
  return liteUsage(u) >= config.freeQuota;
}

/** 轻量用户计一条翻译(跨月重置;同时写 MonthlyUsage 流水,tenantId 复用其 user.id) */
export async function bumpLite(id: string): Promise<void> {
  const u = await prisma.liteUser.findUnique({ where: { id } });
  if (!u) return;
  const mk = monthKey();
  await prisma.liteUser.update({
    where: { id },
    data: u.usageMonth === mk ? { usageCount: { increment: 1 } } : { usageMonth: mk, usageCount: 1 },
  });
  await prisma.monthlyUsage
    .upsert({
      where: { tenantId_month: { tenantId: id, month: mk } },
      create: { tenantId: id, month: mk, outCount: 1 },
      update: { outCount: { increment: 1 } },
    })
    .catch(() => {});
}

export function setLitePlanPro(id: string, proUntil: Date, chargeId?: string) {
  return prisma.liteUser.upsert({
    where: { id },
    create: { id, plan: "pro", proUntil, subChargeId: chargeId ?? "" },
    update: { plan: "pro", proUntil, ...(chargeId ? { subChargeId: chargeId } : {}) },
  });
}

// ── 联系人 ────────────────────────────────────────────────────────────

/** 按(租户,客户 user.id)查联系人 */
export function getContact(tenantId: string, tgId: string) {
  return prisma.contact.findUnique({ where: { tenantId_tgId: { tenantId, tgId } } });
}

/** 按(租户,Topic thread_id)反查联系人(出站用) */
export function getContactByThread(tenantId: string, threadId: number) {
  return prisma.contact.findUnique({ where: { tenantId_threadId: { tenantId, threadId } } });
}

/** 新建联系人 */
export function createContact(data: {
  tenantId: string;
  tgId: string;
  chatId: string;
  threadId: number;
  name: string;
  connId?: string;
  viaBot?: boolean;
}) {
  return prisma.contact.create({ data });
}

/** 锁定/修正客户语种(自动检测首次锁定,或 /lang 手动覆盖) */
export function setLang(contactId: number, lang: string) {
  return prisma.contact.update({ where: { id: contactId }, data: { lang } });
}

/** 每条入站消息触达:刷新末次往来 + 最新 connId + 解除归档 */
export function touchContact(contactId: number, connId?: string) {
  return prisma.contact.update({
    where: { id: contactId },
    data: { lastActiveAt: new Date(), archived: false, connId: connId ?? undefined },
  });
}

/** 标记已发过自动开场白 */
export function markGreeted(contactId: number) {
  return prisma.contact.update({ where: { id: contactId }, data: { greeted: true } });
}

/** 设置归档状态 */
export function setArchived(contactId: number, archived: boolean) {
  return prisma.contact.update({ where: { id: contactId }, data: { archived } });
}

/** 取超过 cutoff 仍活跃(未归档)的联系人,带租户(用于自动归档) */
export function getStaleContacts(cutoff: Date) {
  return prisma.contact.findMany({
    where: { archived: false, lastActiveAt: { lt: cutoff } },
    include: { tenant: true },
  });
}

// ── 消息 / 媒体 ───────────────────────────────────────────────────────

/** 记一条双语消息 */
export function logMessage(data: {
  contactId: number;
  direction: "in" | "out" | "manual";
  originalText: string;
  originalLang?: string;
  nativeText?: string;
  mediaType?: string;
}) {
  return prisma.message.create({
    data: {
      contactId: data.contactId,
      direction: data.direction,
      originalText: data.originalText,
      originalLang: data.originalLang ?? "",
      nativeText: data.nativeText ?? "",
      mediaType: data.mediaType ?? null,
    },
  });
}

/** 记一条媒体素材(双向) */
export function createAsset(data: {
  contactId: number;
  direction?: string;
  type: string;
  fileId: string;
  fileName?: string;
  localPath?: string;
  size?: number;
}) {
  return prisma.asset.create({
    data: {
      contactId: data.contactId,
      direction: data.direction ?? "in",
      type: data.type,
      fileId: data.fileId,
      fileName: data.fileName ?? null,
      localPath: data.localPath ?? null,
      size: data.size ?? null,
    },
  });
}

// ── KV ────────────────────────────────────────────────────────────────

export async function getAppState(key: string): Promise<string | null> {
  const r = await prisma.appState.findUnique({ where: { key } });
  return r?.value ?? null;
}

export function setAppState(key: string, value: string) {
  return prisma.appState.upsert({ where: { key }, create: { key, value }, update: { value } });
}
