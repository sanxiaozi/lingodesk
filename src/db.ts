/**
 * 数据访问层(SQLite/Prisma),M1 多租户版。
 * 迁 Postgres 时本文件无需改动,只改 schema.prisma 的 datasource。
 */
import { PrismaClient, type Tenant, type Contact } from "@prisma/client";

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

/** business_connection 事件:刷新连接与 owner */
export function setTenantConn(id: string, connId: string, ownerUserId?: string) {
  return prisma.tenant.update({
    where: { id },
    data: { connId, ownerUserId: ownerUserId ?? undefined },
  });
}

/** 设置租户母语 */
export function setTenantNativeLang(id: string, nativeLang: string) {
  return prisma.tenant.update({ where: { id }, data: { nativeLang } });
}

/** 租户消息用量(为计费铺路;从 Message 表按需统计,不另建表) */
export async function tenantUsage(id: string): Promise<{ contacts: number; inMsgs: number; outMsgs: number }> {
  const [contacts, inMsgs, outMsgs] = await Promise.all([
    prisma.contact.count({ where: { tenantId: id } }),
    prisma.message.count({ where: { direction: "in", contact: { tenantId: id } } }),
    prisma.message.count({ where: { direction: "out", contact: { tenantId: id } } }),
  ]);
  return { contacts, inMsgs, outMsgs };
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
