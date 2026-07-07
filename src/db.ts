/**
 * 数据访问层(SQLite/Prisma)。封装 Contact / Message / Asset / AppState。
 * 迁 Postgres(多租户)时本文件无需改动,只改 schema.prisma 的 datasource。
 */
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

// 并发写稳健:WAL 模式 + 忙等超时(定时任务与消息处理会并发写 SQLite)
await prisma.$executeRawUnsafe("PRAGMA journal_mode=WAL").catch(() => {});
await prisma.$executeRawUnsafe("PRAGMA busy_timeout=5000").catch(() => {});

/** 按客户 user.id 查映射 */
export function getContactByCustomer(customerId: string) {
  return prisma.contact.findUnique({ where: { id: customerId } });
}

/** 按 Topic thread_id 反查客户(出站用) */
export function getContactByThread(threadId: number) {
  return prisma.contact.findUnique({ where: { threadId } });
}

/** 新建客户映射 */
export function createContact(data: { id: string; chatId: string; threadId: number; name: string; connId?: string }) {
  return prisma.contact.create({ data });
}

/** 锁定/修正客户语种(自动检测首次锁定,或 /lang 手动覆盖) */
export function setLang(customerId: string, lang: string) {
  return prisma.contact.update({ where: { id: customerId }, data: { lang } });
}

/** 每条入站消息触达:刷新末次往来 + 最新 connId + 解除归档 */
export function touchContact(customerId: string, connId?: string) {
  return prisma.contact.update({
    where: { id: customerId },
    data: { lastActiveAt: new Date(), archived: false, connId: connId ?? undefined },
  });
}

/** 标记已发过自动开场白 */
export function markGreeted(customerId: string) {
  return prisma.contact.update({ where: { id: customerId }, data: { greeted: true } });
}

/** 记一条双语消息 */
export function logMessage(data: {
  contactId: string;
  direction: "in" | "out" | "manual";
  originalText: string;
  originalLang?: string;
  zhText?: string;
  mediaType?: string;
}) {
  return prisma.message.create({
    data: {
      contactId: data.contactId,
      direction: data.direction,
      originalText: data.originalText,
      originalLang: data.originalLang ?? "",
      zhText: data.zhText ?? "",
      mediaType: data.mediaType ?? null,
    },
  });
}

/** 记一条媒体素材(双向) */
export function createAsset(data: {
  contactId: string;
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

/** 设置归档状态 */
export function setArchived(customerId: string, archived: boolean) {
  return prisma.contact.update({ where: { id: customerId }, data: { archived } });
}

/** 取超过 cutoff 仍活跃(未归档)的客户(用于自动归档) */
export function getStaleContacts(cutoff: Date) {
  return prisma.contact.findMany({ where: { archived: false, lastActiveAt: { lt: cutoff } } });
}

/** KV:读 */
export async function getAppState(key: string): Promise<string | null> {
  const r = await prisma.appState.findUnique({ where: { key } });
  return r?.value ?? null;
}

/** KV:写(upsert) */
export function setAppState(key: string, value: string) {
  return prisma.appState.upsert({ where: { key }, create: { key, value }, update: { value } });
}
