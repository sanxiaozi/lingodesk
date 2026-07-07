/**
 * 辅助:读取 bot 最近收到的 updates,打印各 chat/user 的 id(填 .env 用)。
 * 用法:① .env 先填 BOT_TOKEN ② 在控制台群里随便发一句、并用你自己的账号私聊 bot 发 /start
 *      ③ 确保 bot 没在运行(同一 token 同时只能有一个 getUpdates) ④ npm run ids
 */
import dotenv from "dotenv";
dotenv.config({ override: true });

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("❌ 先在 .env 填 BOT_TOKEN 再跑这个脚本。");
  process.exit(1);
}

const allowed = encodeURIComponent(JSON.stringify(["message", "my_chat_member"]));
const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?allowed_updates=${allowed}`);
const j = (await res.json()) as {
  ok: boolean;
  description?: string;
  result?: {
    message?: { chat?: ChatInfo; from?: FromInfo };
    my_chat_member?: { chat?: ChatInfo; from?: FromInfo };
  }[];
};
interface ChatInfo {
  id: number;
  type: string;
  title?: string;
  username?: string;
}
interface FromInfo {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

if (!j.ok) {
  console.error(`❌ getUpdates 失败:${j.description ?? "未知错误"}(409 = bot 正在运行,先 Ctrl+C 停掉 npm run dev 再跑)`);
  process.exit(1);
}
const updates = j.result ?? [];
if (!updates.length) {
  console.log("(空)bot 还没收到任何消息。先:① 在控制台群里随便发一句 ② 用你的账号私聊 bot 发 /start,然后重跑本命令。");
  process.exit(0);
}

const chats = new Map<number, string>();
const users = new Map<number, string>();
for (const u of updates) {
  const msg = u.message ?? u.my_chat_member;
  if (!msg) continue;
  const c = msg.chat;
  if (c) chats.set(c.id, `${c.type}${c.title ? ` · ${c.title}` : ""}${c.username ? ` · @${c.username}` : ""}`);
  const f = msg.from;
  if (f && !f.is_bot) users.set(f.id, `${f.first_name ?? ""}${f.username ? ` @${f.username}` : ""}`.trim());
}

console.log("── 群/会话(supergroup 且 -100 开头的那行 = FORUM_CHAT_ID)──");
for (const [id, desc] of chats) console.log(`  ${id}\t${desc}`);
console.log("── 用户(你自己那行 = OWNER_USER_ID)──");
for (const [id, desc] of users) console.log(`  ${id}\t${desc}`);
process.exit(0);
