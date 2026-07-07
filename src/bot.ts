/**
 * LingoDesk 核心中继:收→译→回→译。
 *
 * 零配置绑定:控制台群无需填 chat_id —— bot 被拉进开启话题的群时自动绑定,
 * 或在群里发 /bind 手动绑定/换绑;owner user.id 从 business_connection 自动捕获。
 *
 * 入站(客户私聊你的真人号,经 Telegram Business 回灌):
 *   · 你手动回复回灌 → 存档,并取消该客户待发的开场白
 *   · 表情(贴纸/纯 emoji)→ 显示具体表情;新客户未破冰则安排延迟自动开场白
 *   · 其它媒体 → 转发进 Topic + 下载存档(Asset)
 *   · 文本 → 译中 + 检测语种(首次锁定),在客户专属 Topic 弹双语卡片
 * 出站(你在控制台 Topic 打中文):
 *   · 译客户语 → 预览确认 → 经 business_connection 以你名义发出 → 存档
 *   · 文件/图/视频 → 直接转发给客户 + 存档
 */
import { Bot, type Context } from "grammy";
import { config } from "./config.js";
import { translateFromZh, translateToZh } from "./ai/translate.js";
import { downloadTgFile } from "./storage.js";
import {
  getContactByCustomer,
  getContactByThread,
  createContact,
  setLang,
  touchContact,
  markGreeted,
  logMessage,
  createAsset,
  setArchived,
  getStaleContacts,
  getAppState,
  setAppState,
} from "./db.js";

export const bot = new Bot(config.botToken);

let connectionId: string | undefined = config.businessConnId;
let ownerUserId: number | undefined = config.ownerUserId;
let forumChatId: number | undefined = config.forumChatId;

/** 启动时从 DB 恢复运行时状态(.env 显式配置优先) */
export async function loadSavedState(): Promise<void> {
  const c = await getAppState("connectionId");
  if (c) connectionId = c;
  const o = await getAppState("ownerUserId");
  if (o) ownerUserId = Number(o);
  if (!forumChatId) {
    const f = await getAppState("forumChatId");
    if (f) forumChatId = Number(f);
  }
  // 有连接但没 owner(用户绑定 Chatbots 发生在 bot 启动之前,business_connection 事件收不到)→ 主动补查
  if (connectionId && !ownerUserId) {
    try {
      const bc = await bot.api.raw.getBusinessConnection({ business_connection_id: connectionId });
      ownerUserId = Number(bc.user.id);
      await setAppState("ownerUserId", String(bc.user.id));
      console.log(`🔎 已从 Business 连接补查 owner=${ownerUserId}`);
    } catch (e) {
      console.warn("补查 business connection 失败(等下一个事件自动捕获):", e instanceof Error ? e.message : e);
    }
  }
}

/** 绑定控制台论坛群并持久化 */
async function bindForum(chatId: number): Promise<void> {
  forumChatId = chatId;
  await setAppState("forumChatId", String(chatId)).catch(() => {});
  console.log(`📌 已绑定控制台论坛群:${chatId}`);
}

const BIND_OK =
  "✅ 本群已绑定为 LingoDesk 控制台。\n客户私聊你的真人号时,这里会自动弹出专属话题和双语卡片;你在话题里打中文即可回复。";

const displayName = (from?: { username?: string; first_name?: string; id?: number }): string =>
  from?.username ? `@${from.username}` : (from?.first_name ?? `用户${from?.id ?? "?"}`);

/** 语种未知时默认英文(国际通用) */
const resolveLang = (lang?: string | null): string =>
  lang && lang !== "unknown" && lang !== "und" ? lang : "en";

/** 判断文本是否纯表情(无字母数字、含至少一个表情符号) */
function isEmojiOnly(t: string): boolean {
  const s = t.trim();
  if (!s) return false;
  if (/[\p{L}\p{N}]/u.test(s)) return false;
  return /\p{Extended_Pictographic}/u.test(s);
}

// ── 开场白定时器(内存,重启丢失可接受,延迟仅 30s) ──────────────────────
const greetTimers = new Map<string, ReturnType<typeof setTimeout>>();

// 出站待确认译文(预览 → 你点发送后才发客户),内存存储,重启失效
interface PendingOut {
  contactId: string;
  chatId: string;
  connId?: string;
  lang: string;
  translated: string;
  zh: string;
}
const pendingOut = new Map<number, PendingOut>();
let pendingSeq = 0;

// 同一客户的入站消息串行处理(防并发建重复 Topic / 主键冲突丢消息)
const inboundLocks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = inboundLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  inboundLocks.set(
    key,
    run.catch(() => {}),
  );
  return run;
}

function cancelGreeting(customerId: string): void {
  const t = greetTimers.get(customerId);
  if (t) {
    clearTimeout(t);
    greetTimers.delete(customerId);
  }
}

function scheduleGreeting(customerId: string, chatId: string, forum: number, threadId: number, connId?: string): void {
  cancelGreeting(customerId);
  const timer = setTimeout(async () => {
    greetTimers.delete(customerId);
    try {
      const c = await getContactByCustomer(customerId);
      if (!c || c.greeted) return; // 期间已破冰
      const conn = connId ?? connectionId;
      if (!conn) return;
      const g = config.greeting;
      await bot.api.sendMessage(Number(chatId), g, { business_connection_id: conn });
      await bot.api.sendMessage(forum, `🤖 [${Math.round(config.greetDelayMs / 1000)}s 自动开场白] ${g}`, {
        message_thread_id: threadId,
      });
      await markGreeted(customerId);
      await logMessage({ contactId: customerId, direction: "out", originalText: g, zhText: "[自动开场白]" });
    } catch (e) {
      console.error("自动开场白发送失败:", e);
    }
  }, config.greetDelayMs);
  greetTimers.set(customerId, timer);
}

/** 渲染双语卡片 */
function renderCard(name: string, isNew: boolean, lang: string, original: string, zh: string): string {
  const lines = [
    `${isNew ? "🆕新客户" : "💬"} ${name}(${lang})`,
    `原文:${original}`,
    `🇨🇳 ${zh}`,
    "─────",
    `↳ 本话题内打中文,自动译 ${resolveLang(lang)} 以你名义发出`,
  ];
  return lines.join("\n");
}

// ── 动态捕获 business_connection_id ───────────────────────────────────
bot.on("business_connection", async (ctx) => {
  const bc = ctx.businessConnection;
  connectionId = bc.id;
  ownerUserId = Number(bc.user.id);
  await setAppState("connectionId", bc.id).catch(() => {});
  await setAppState("ownerUserId", String(bc.user.id)).catch(() => {});
  const canReply = bc.rights?.can_reply ?? false;
  console.log(`🔗 业务连接更新:conn=${bc.id} owner=${ownerUserId} can_reply=${canReply} enabled=${bc.is_enabled}`);
});

// ── 零配置绑定:bot 被拉进开启话题的群 → 自动绑定为控制台 ────────────────
bot.on("my_chat_member", async (ctx) => {
  if (forumChatId) return; // 已有控制台,换绑用 /bind
  const mc = ctx.myChatMember;
  const status = mc.new_chat_member.status;
  const chat = mc.chat;
  if (chat.type !== "supergroup" || !chat.is_forum) return;
  if (status !== "member" && status !== "administrator") return;
  await bindForum(chat.id);
  try {
    await ctx.api.sendMessage(chat.id, BIND_OK);
  } catch {
    /* 无发言权限等,静默 */
  }
});

// ── 入站 ──────────────────────────────────────────────────────────────
bot.on("business_message", (ctx) => {
  const m = ctx.businessMessage;
  return withLock(String(m.from?.id ?? m.chat.id), async () => {
    // 每条入站消息自带当前有效的 connection_id,用它实时刷新(防 restart 后旧 id 失效)
    const msgConn = m.business_connection_id;
    if (msgConn && msgConn !== connectionId) {
      connectionId = msgConn;
      await setAppState("connectionId", msgConn).catch(() => {});
    }
    const forum = forumChatId;
    if (forum === undefined) {
      console.warn("⚠️ 收到客户消息但控制台群还没绑定:把 bot 拉进开启话题的群,或在群里发 /bind。");
      return;
    }
    const fromId = m.from?.id;

    // 你本人手动回复也会回灌:存档 + 取消待发开场白
    if (fromId !== undefined && fromId === ownerUserId) {
      cancelGreeting(String(m.chat.id));
      const contact = await getContactByCustomer(String(m.chat.id));
      if (contact && contact.threadId != null && m.text) {
        await ctx.api.sendMessage(forum, `📝 [你手动回复] ${m.text}`, {
          message_thread_id: contact.threadId,
        });
        await logMessage({ contactId: contact.id, direction: "manual", originalText: m.text });
      }
      return;
    }

    if (fromId === undefined || !m.from) return;

    const customerId = String(fromId);
    const chatId = String(m.chat.id);
    const name = displayName(m.from);
    const existing = await getContactByCustomer(customerId);

    // 归档的 Topic 收到新消息 → 复活并顶起
    if (existing && existing.archived && existing.threadId != null) {
      try {
        await ctx.api.reopenForumTopic(forum, existing.threadId);
      } catch (e) {
        console.error("复活 Topic 失败:", e);
      }
      await setArchived(customerId, false);
    }

    // 确保有 Topic(返回 threadId 与是否新建)
    const ensureThread = async (): Promise<{ threadId: number; isNew: boolean }> => {
      if (existing?.threadId != null) return { threadId: existing.threadId, isNew: false };
      const t = await ctx.api.createForumTopic(forum, name);
      await createContact({ id: customerId, chatId, threadId: t.message_thread_id, name, connId: msgConn });
      return { threadId: t.message_thread_id, isNew: true };
    };

    // 表情消息(贴纸 或 纯 emoji 文本)→ 显示具体表情 + 新客户安排自动开场白
    const sticker = m.sticker;
    const emojiText = m.text && isEmojiOnly(m.text) ? m.text : null;
    if (sticker || emojiText) {
      const { threadId } = await ensureThread();
      if (existing) await touchContact(customerId, msgConn);
      const shown = sticker ? `贴纸 ${sticker.emoji ?? "❓"}` : `表情 ${emojiText}`;
      await ctx.api.sendMessage(forum, `😊 客户发来${shown}`, { message_thread_id: threadId });
      await logMessage({
        contactId: customerId,
        direction: "in",
        originalText: sticker ? (sticker.emoji ?? "[sticker]") : emojiText!,
        mediaType: "emoji",
      });
      const c = existing ?? (await getContactByCustomer(customerId));
      if (!c?.greeted) scheduleGreeting(customerId, chatId, forum, threadId, msgConn);
      return;
    }

    // 其它媒体(图/语音/文件/视频)→ 转发素材进 Topic + 落 Asset
    if (!m.text) {
      cancelGreeting(customerId);
      const { threadId } = await ensureThread();
      if (existing) await touchContact(customerId, msgConn);
      const caption = `📎 ${name} 发来素材`;
      const opts = { message_thread_id: threadId, caption };
      let mediaType = "非文本";
      let fileId: string | undefined;
      let fileName: string | undefined;
      let size: number | undefined;
      try {
        if (m.photo?.length) {
          const ph = m.photo[m.photo.length - 1]!;
          fileId = ph.file_id;
          size = ph.file_size;
          mediaType = "photo";
          fileName = `photo_${ph.file_unique_id}.jpg`;
          await ctx.api.sendPhoto(forum, fileId, opts);
        } else if (m.voice) {
          fileId = m.voice.file_id;
          size = m.voice.file_size;
          mediaType = "voice";
          fileName = `voice_${m.voice.file_unique_id}.ogg`;
          await ctx.api.sendVoice(forum, fileId, opts);
        } else if (m.document) {
          fileId = m.document.file_id;
          size = m.document.file_size;
          mediaType = "document";
          fileName = m.document.file_name ?? `doc_${m.document.file_unique_id}`;
          await ctx.api.sendDocument(forum, fileId, opts);
        } else if (m.video) {
          fileId = m.video.file_id;
          size = m.video.file_size;
          mediaType = "video";
          fileName = m.video.file_name ?? `video_${m.video.file_unique_id}.mp4`;
          await ctx.api.sendVideo(forum, fileId, opts);
        } else {
          await ctx.api.sendMessage(forum, `📎 ${name} 发来非文本消息`, { message_thread_id: threadId });
        }
      } catch (e) {
        console.error("媒体转发失败:", e);
        await ctx.api.sendMessage(forum, `📎 ${name} 发来[${mediaType}],转发失败`, {
          message_thread_id: threadId,
        });
      }
      if (fileId) {
        const localPath = await downloadTgFile(fileId, customerId, fileName ?? mediaType);
        await createAsset({ contactId: customerId, direction: "in", type: mediaType, fileId, fileName, localPath: localPath ?? undefined, size });
        await ctx.api.sendMessage(
          forum,
          `💾 已存档${localPath ? "(已下载)" : "(>20MB 仅云端)"}:${fileName ?? mediaType}`,
          { message_thread_id: threadId },
        );
      }
      await logMessage({ contactId: customerId, direction: "in", originalText: `[${mediaType}]`, mediaType });
      return;
    }

    // 文本 → 取消开场白 + 译中(检测语种)
    cancelGreeting(customerId);
    const { threadId, isNew } = await ensureThread();
    if (existing) await touchContact(customerId, msgConn);

    let lang = existing?.lang ?? "unknown";
    let zh = m.text;
    try {
      const r = await translateToZh(m.text);
      zh = r.zh;
      // 语种首次锁定:短消息易误判,已锁定后不再自动改(用 /lang 手动纠正)
      if (lang === "unknown" && r.lang !== "unknown") {
        lang = r.lang;
        await setLang(customerId, lang);
      }
    } catch (e) {
      console.error("翻译失败,原文落档:", e);
      await ctx.api.sendMessage(forum, `⚠️ 翻译暂时失败,客户原文(请手动处理):\n${m.text}`, {
        message_thread_id: threadId,
      });
      await logMessage({ contactId: customerId, direction: "in", originalText: m.text });
      return;
    }

    await ctx.api.sendMessage(forum, renderCard(name, isNew, lang, m.text, zh), {
      message_thread_id: threadId,
    });
    await logMessage({ contactId: customerId, direction: "in", originalText: m.text, originalLang: lang, zhText: zh });
  });
});

// ── 出站:你在 Topic 里打中文 → 译客户语 → 以你名义发出 ──────────────────
bot.on("message", async (ctx) => {
  if (ctx.from?.id === ctx.me.id) return;

  // /bind:把当前群绑定/换绑为控制台(必须是开启话题的超级群)
  const rawText = ctx.message.text?.trim();
  if (rawText === "/bind" || rawText?.startsWith("/bind@")) {
    if (ctx.chat.type === "supergroup" && ctx.chat.is_forum) {
      await bindForum(ctx.chat.id);
      await ctx.reply(BIND_OK, { message_thread_id: ctx.message.message_thread_id });
    } else {
      await ctx.reply("请先在群设置里开启「话题(Topics)」,再在群里发 /bind。");
    }
    return;
  }

  const forum = forumChatId;
  if (forum === undefined || ctx.chat.id !== forum) return;
  const threadId = ctx.message.message_thread_id;
  if (threadId === undefined) return;

  const contact = await getContactByThread(threadId);
  if (!contact) return; // 非客户 Topic(General 等),不响应

  const conn = contact.connId ?? connectionId;

  // 出站文件:你在客户 Topic 里发文件/视频/图 → 经 Business 转发给客户 + 存档
  const outDoc = ctx.message.document;
  const outVideo = ctx.message.video;
  const outPhoto = ctx.message.photo;
  if (outDoc || outVideo || (outPhoto && outPhoto.length)) {
    if (!conn) {
      await ctx.reply("⚠️ 尚无 business_connection_id,去 Chatbots 重连。", { message_thread_id: threadId });
      return;
    }
    try {
      let fileId: string;
      let type: string;
      let fileName: string | undefined;
      let size: number | undefined;
      if (outDoc) {
        fileId = outDoc.file_id;
        type = "document";
        fileName = outDoc.file_name ?? `doc_${outDoc.file_unique_id}`;
        size = outDoc.file_size;
        await ctx.api.sendDocument(Number(contact.chatId), fileId, { business_connection_id: conn });
      } else if (outVideo) {
        fileId = outVideo.file_id;
        type = "video";
        fileName = outVideo.file_name ?? `video_${outVideo.file_unique_id}.mp4`;
        size = outVideo.file_size;
        await ctx.api.sendVideo(Number(contact.chatId), fileId, { business_connection_id: conn });
      } else {
        const ph = outPhoto![outPhoto!.length - 1]!;
        fileId = ph.file_id;
        type = "photo";
        fileName = `photo_${ph.file_unique_id}.jpg`;
        size = ph.file_size;
        await ctx.api.sendPhoto(Number(contact.chatId), fileId, { business_connection_id: conn });
      }
      const localPath = await downloadTgFile(fileId, contact.id, fileName ?? type);
      await createAsset({ contactId: contact.id, direction: "out", type, fileId, fileName, localPath: localPath ?? undefined, size });
      await logMessage({ contactId: contact.id, direction: "out", originalText: `[发送${type}] ${fileName ?? ""}`, mediaType: type });
      await ctx.reply(`📤 已把文件发给客户${localPath ? " · 💾已存档" : " · (>20MB 仅云端)"}`, { message_thread_id: threadId });
    } catch (e) {
      console.error("出站文件失败:", e);
      await ctx.reply("⚠️ 发送文件失败,看日志。", { message_thread_id: threadId });
    }
    return;
  }

  const zh = ctx.message.text;
  if (!zh) return;

  // 话题内命令
  if (zh.startsWith("/")) {
    const [cmd, arg] = zh.trim().split(/\s+/);
    if (cmd === "/lang") {
      const code = (arg ?? "").toLowerCase();
      if (!/^[a-z]{2,3}$/.test(code)) {
        await ctx.reply("用法:/lang <ISO639-1 语种码>,例如 /lang es", { message_thread_id: threadId });
        return;
      }
      await setLang(contact.id, code);
      await ctx.reply(`✅ 已把「${contact.name}」的语种改为 ${code},后续出站按此翻译。`, { message_thread_id: threadId });
    } else if (cmd === "/help") {
      await ctx.reply(
        "话题命令:\n/lang <码> — 手动修正客户语种(如 /lang es)\n/bind — 把某个群绑定为控制台\n直接打中文 = 翻译预览后发给客户",
        { message_thread_id: threadId },
      );
    } else {
      await ctx.reply("未知命令,发 /help 查看。", { message_thread_id: threadId });
    }
    return;
  }

  if (!conn) {
    await ctx.reply("⚠️ 尚未捕获 business_connection_id,去 Chatbots 设置重连一下触发。", {
      message_thread_id: threadId,
    });
    return;
  }

  // 你在话题里回了 → 取消该客户待发的自动开场白
  cancelGreeting(contact.id);

  // 翻译后先在 Topic 给你预览,确认才发客户(杜绝误发)
  const targetLang = resolveLang(contact.lang);
  const translated = await translateFromZh(zh, targetLang);
  const token = ++pendingSeq;
  pendingOut.set(token, { contactId: contact.id, chatId: contact.chatId, connId: contact.connId ?? undefined, lang: targetLang, translated, zh });
  await ctx.api.sendMessage(
    forum,
    `📤 译文预览(→${targetLang}),确认后才发给客户:\n\n${translated}\n\n(你的中文:${zh})`,
    {
      message_thread_id: threadId,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ 发送给客户", callback_data: `send:${token}` },
            { text: "✏️ 取消", callback_data: `cancel:${token}` },
          ],
        ],
      },
    },
  );
});

// ── 按钮回调:出站确认 ─────────────────────────────────────────────────
bot.on("callback_query:data", async (ctx) => {
  const [action, arg] = ctx.callbackQuery.data.split(":");
  const token = Number(arg);
  const p = pendingOut.get(token);
  if (!p) {
    await ctx.answerCallbackQuery("此预览已失效(可能 bot 重启过),请重新打中文。");
    return;
  }
  if (action === "cancel") {
    pendingOut.delete(token);
    await ctx.editMessageText(`✏️ 已取消(未发送)\n原中文:${p.zh}`);
    await ctx.answerCallbackQuery("已取消");
    return;
  }
  if (action === "send") {
    const conn = p.connId ?? connectionId;
    if (!conn) {
      await ctx.answerCallbackQuery("尚无 business_connection_id,去 Chatbots 重连一下。");
      return;
    }
    try {
      await ctx.api.sendMessage(Number(p.chatId), p.translated, { business_connection_id: conn });
      await ctx.editMessageText(`✅ 已发送 → (${p.lang}) ${p.translated}`);
      await logMessage({ contactId: p.contactId, direction: "out", originalText: p.translated, originalLang: p.lang, zhText: p.zh });
      pendingOut.delete(token);
      await ctx.answerCallbackQuery("已发送");
    } catch (e) {
      console.error("发送失败:", e);
      const em = e instanceof Error ? e.message : "";
      let tip = "发送失败,看日志。";
      if (em.includes("BUSINESS_PEER_USAGE_MISSING") || em.includes("PEER_ID_INVALID")) {
        tip = "该客户太久没往来,Telegram 不让 bot 主动发起。让 TA 先发一句,或你在真人号手动回这次。草稿已保留。";
      } else if (em.includes("business connection not found") || em.includes("BUSINESS_CONNECTION_INVALID")) {
        tip = "Business 连接失效,让客户发条消息刷新或去 Chatbots 重连。草稿已保留。";
      }
      await ctx.answerCallbackQuery(tip);
    }
  }
});

bot.catch((err) => console.error("‼️ bot 出错:", err));

/** 归档超过 archiveAfterDays 天无往来的活跃 Topic(由 main.ts 定时调用) */
export async function archiveStaleTopics(): Promise<void> {
  const forum = forumChatId;
  if (forum === undefined) return;
  const cutoff = new Date(Date.now() - config.archiveAfterDays * 86_400_000);
  const stale = await getStaleContacts(cutoff);
  for (const c of stale) {
    if (c.threadId == null) continue;
    try {
      await bot.api.closeForumTopic(forum, c.threadId);
      await setArchived(c.id, true);
    } catch (e) {
      console.error(`归档 Topic 失败 ${c.id}:`, e);
    }
  }
  if (stale.length) console.log(`📁 已归档 ${stale.length} 个不活跃 Topic`);
}
