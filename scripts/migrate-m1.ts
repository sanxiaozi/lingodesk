/**
 * M0 → M1 迁移:把单租户老库(dev.db.bak)的数据搬进新多租户库,老数据成为第一个租户。
 * 前提:① 老库已备份为 prisma/dev.db.bak ② 新库已 prisma db push 建好表
 * ③ .env 里 BOT_TOKEN(即老实例的 bot)与 TOKEN_SECRET 已配置
 * 用法:npx tsx scripts/migrate-m1.ts
 */
import { prisma } from "../src/db.js";
import { config } from "../src/config.js";
import { encrypt } from "../src/crypto.js";

// 老库的 AppState(经 ATTACH 读)
async function oldState(key: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<{ value: string }[]>(`SELECT value FROM old.AppState WHERE key = ?`, key);
  return rows[0]?.value ?? null;
}

await prisma.$executeRawUnsafe(`ATTACH DATABASE 'prisma/dev.db.bak' AS old`);

const ownerUserId = await oldState("ownerUserId");
const connectionId = await oldState("connectionId");
const forumChatId = await oldState("forumChatId");
if (!ownerUserId) {
  console.error("❌ 老库里没有 ownerUserId,无法确定租户身份,中止。");
  process.exit(1);
}

// 老实例的 bot = .env 里的 BOT_TOKEN,查它的身份
const r = await fetch(`https://api.telegram.org/bot${config.botToken}/getMe`);
const j = (await r.json()) as { ok: boolean; result?: { id: number; username?: string } };
if (!j.ok || !j.result) {
  console.error("❌ BOT_TOKEN getMe 失败,中止。");
  process.exit(1);
}

const tenantId = ownerUserId;
await prisma.tenant.upsert({
  where: { id: tenantId },
  create: {
    id: tenantId,
    botId: String(j.result.id),
    botUsername: j.result.username ?? "",
    botToken: encrypt(config.botToken),
    ownerUserId,
    connId: connectionId ?? "",
    forumChatId: forumChatId ?? null,
    nativeLang: "zh",
  },
  update: {},
});
console.log(`✅ 租户 ${tenantId} → bot @${j.result.username}`);

// 联系人:老表主键是客户 tgId(String),迁为自增 id + tenantId
await prisma.$executeRawUnsafe(
  `INSERT INTO Contact (tenantId, tgId, chatId, threadId, lang, name, archived, greeted, connId, lastActiveAt, createdAt, updatedAt)
   SELECT '${tenantId}', id, chatId, threadId, lang, name, archived, greeted, connId, lastActiveAt, createdAt, updatedAt FROM old.Contact`,
);
// 消息/媒体:按 tgId 关联回新联系人的自增 id;zhText → nativeText
await prisma.$executeRawUnsafe(
  `INSERT INTO Message (contactId, direction, originalText, originalLang, nativeText, mediaType, createdAt)
   SELECT c.id, m.direction, m.originalText, m.originalLang, m.zhText, m.mediaType, m.createdAt
   FROM old.Message m JOIN Contact c ON c.tgId = m.contactId AND c.tenantId = '${tenantId}'`,
);
await prisma.$executeRawUnsafe(
  `INSERT INTO Asset (contactId, direction, type, fileId, fileName, localPath, size, createdAt)
   SELECT c.id, a.direction, a.type, a.fileId, a.fileName, a.localPath, a.size, a.createdAt
   FROM old.Asset a JOIN Contact c ON c.tgId = a.contactId AND c.tenantId = '${tenantId}'`,
);

const [contacts, msgs, assets] = await Promise.all([prisma.contact.count(), prisma.message.count(), prisma.asset.count()]);
console.log(`✅ 迁移完成:联系人 ${contacts},消息 ${msgs},媒体 ${assets}`);
process.exit(0);
