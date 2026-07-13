/**
 * 中继核心:把「收→译→回→译」整套 handler 挂到某个租户的 bot 实例上。
 * 每个租户自己的 bot 各自轮询,天然隔离;官方门户 bot 若也绑了 Business,
 * 则同一实例先挂本模块(业务/群消息),再挂 portal(私聊),互不抢消息(不匹配即 next)。
 *
 * 入站(客户私聊租户真人号,经 Telegram Business 回灌):
 *   · 租户手动回复回灌 → 存档,并取消该客户待发的开场白
 *   · 表情(贴纸/纯 emoji)→ 显示具体表情;新客户未破冰则安排延迟自动开场白
 *   · 其它媒体 → 转发进 Topic + 下载存档(Asset)
 *   · 文本 → 译成租户母语 + 检测语种(首次锁定),在客户专属 Topic 弹双语卡片
 * 出站(租户在控制台 Topic 打母语):
 *   · 译客户语 → 预览确认 → 经 business_connection 以租户名义发出 → 存档
 *   · 文件/图/视频 → 直接转发给客户 + 存档
 */
import type { Bot } from "grammy";
import { config } from "./config.js";
import { t as tr } from "./i18n.js";
import { translateInbound, translateOutbound, langName } from "./ai/translate.js";
import { complete } from "./ai/_client.js";
import { downloadTgFile } from "./storage.js";
import {
  type Tenant,
  getTenant,
  setTenantConn,
  setTenantForum,
  getContact,
  getContactByThread,
  createContact,
  setLang,
  touchContact,
  markGreeted,
  logMessage,
  createAsset,
  setArchived,
  isOverQuota,
  bumpOutbound,
  logEvent,
  getTemplates,
  getTemplate,
  upsertTemplate,
  delTemplate,
  getGroupChat,
  upsertGroupChat,
  recentMessages,
} from "./db.js";
import { getPortalUsername } from "./manager.js";

const displayName = (from?: { username?: string; first_name?: string; id?: number }): string =>
  from?.username ? `@${from.username}` : (from?.first_name ?? `User ${from?.id ?? "?"}`);

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

interface PendingOut {
  contactId: number;
  chatId: string;
  connId?: string;
  lang: string;
  translated: string;
  original: string;
}

/** 把整套中继 handler 挂到 bot 实例上(每租户一份闭包状态)。notify=经门户私聊提醒租户(可选) */
export function attachRelay(bot: Bot, tenantId: string, notify?: (text: string) => Promise<void>): void {
  // 开场白定时器(内存,重启丢失可接受,延迟仅 30s)
  const greetTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // 出站待确认译文(预览 → 确认后才发客户),内存存储,重启失效
  const pendingOut = new Map<number, PendingOut>();
  let pendingSeq = 0;

  /** 统一出站预览:母语文本 → 译客户语 → Topic 里弹预览卡(确认才发)。打字/模板/AI 拟稿共用 */
  async function startPreview(t: Tenant, contact: { id: number; chatId: string; connId: string | null; lang: string }, threadId: number, text: string): Promise<void> {
    const targetLang = resolveLang(contact.lang);
    const translated = await translateOutbound(text, targetLang);
    const token = ++pendingSeq;
    pendingOut.set(token, { contactId: contact.id, chatId: contact.chatId, connId: contact.connId ?? undefined, lang: targetLang, translated, original: text });
    await bot.api.sendMessage(
      Number(t.forumChatId),
      tr("relay.preview", t.nativeLang, { lang: targetLang, translated, original: text }),
      {
        message_thread_id: threadId,
        reply_markup: {
          inline_keyboard: [
            [
              { text: tr("relay.btn_send", t.nativeLang), callback_data: `send:${token}` },
              { text: tr("relay.btn_cancel", t.nativeLang), callback_data: `cancel:${token}` },
            ],
          ],
        },
      },
    );
  }

  // 群翻译超额提醒限频(每群最多 6 小时提示一次,防刷屏)
  const groupQuotaNoticeAt = new Map<string, number>();

  /**
   * 群/频道消息双向翻译(与项目宗旨一致:各说母语,彼此都懂):
   *   · 你的母语消息 → 译成群目标语贴出(对方看懂你)
   *   · 其它任何语言 → 译成你的母语贴出(你看懂对方)
   *   · 母语 = 目标语时退化为单向(全部译成目标语)
   * 占免费额度(Pro 不限),超额静默+限频提醒。
   */
  async function groupTranslate(chatId: number, messageId: number, text: string, t: Tenant, g: { targetLang: string }): Promise<void> {
    if (isOverQuota(t)) {
      const key = String(chatId);
      if (Date.now() - (groupQuotaNoticeAt.get(key) ?? 0) > 6 * 3600_000) {
        groupQuotaNoticeAt.set(key, Date.now());
        const url = `https://t.me/${getPortalUsername()}?start=subscribe`;
        await bot.api
          .sendMessage(chatId, tr("relay.group_quota", t.nativeLang, { quota: config.freeQuota, url }))
          .catch(() => {});
      }
      return;
    }
    try {
      // 先按「译入母语」走一次(顺带检测语种)
      const r = await translateInbound(text, t.nativeLang);
      let out: string;
      if (r.lang === t.nativeLang && t.nativeLang !== g.targetLang) {
        // 你在说母语 → 译成群目标语给对方
        out = await translateOutbound(text, g.targetLang);
      } else {
        // 对方在说外语 → 用刚才的母语译文给你
        out = r.native;
      }
      // 译文与原文相同(如原文已是对应目标语)→ 不贴,避免噪音
      if (!out || out.trim() === text.trim()) return;
      await bot.api.sendMessage(chatId, `🌐 ${out}`, { reply_parameters: { message_id: messageId } });
      await bumpOutbound(t.id);
    } catch (e) {
      console.error(`[${tenantId}] 群翻译失败:`, e);
    }
  }
  // 同一客户的入站消息串行处理(防并发建重复 Topic / 唯一键冲突丢消息)
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

  function cancelGreeting(tgId: string): void {
    const t = greetTimers.get(tgId);
    if (t) {
      clearTimeout(t);
      greetTimers.delete(tgId);
    }
  }

  function scheduleGreeting(tgId: string, chatId: string, forum: number, threadId: number, connId?: string): void {
    cancelGreeting(tgId);
    const timer = setTimeout(async () => {
      greetTimers.delete(tgId);
      try {
        const c = await getContact(tenantId, tgId);
        if (!c || c.greeted) return; // 期间已破冰
        const t = await getTenant(tenantId);
        const conn = t?.connId ?? connId; // 租户最新连接优先(owner 重连后旧 id 会失效)
        if (!conn) return;
        const g = config.greeting;
        await bot.api.sendMessage(Number(chatId), g, { business_connection_id: conn });
        await bot.api.sendMessage(
          forum,
          tr("relay.auto_greeting", t?.nativeLang, { sec: Math.round(config.greetDelayMs / 1000), greeting: g }),
          { message_thread_id: threadId },
        );
        await markGreeted(c.id);
        await logMessage({ contactId: c.id, direction: "out", originalText: g, nativeText: "[自动开场白]" });
      } catch (e) {
        console.error(`[${tenantId}] 自动开场白发送失败:`, e);
      }
    }, config.greetDelayMs);
    greetTimers.set(tgId, timer);
  }

  /** 渲染双语卡片。uiLang=租户母语(卡片标签用它);lang=客户语种(展示 + 出站目标) */
  function renderCard(name: string, isNew: boolean, lang: string, original: string, native: string, uiLang?: string | null): string {
    return [
      `${isNew ? tr("relay.card_new", uiLang) : "💬"} ${name}(${lang})`,
      tr("relay.card_original", uiLang, { text: original }),
      `🌐 ${native}`,
      "─────",
      tr("relay.card_footer", uiLang, { lang: resolveLang(lang) }),
    ].join("\n");
  }

  // ── 动态捕获 business_connection(连接建立/权限变更) ─────────────────
  bot.on("business_connection", async (ctx) => {
    const bc = ctx.businessConnection;
    const canReply = bc.rights?.can_reply ?? false;
    await setTenantConn(tenantId, bc.id, String(bc.user.id), canReply).catch((e) => console.error(`[${tenantId}]`, e));
    console.log(`[${tenantId}] 🔗 业务连接更新:owner=${bc.user.id} can_reply=${canReply} enabled=${bc.is_enabled}`);
    // 绑定了但没给「回复消息」权限 = 能收不能发,主动提醒(等到发送失败就晚了)
    if (bc.is_enabled && !canReply && notify) {
      const tn = await getTenant(tenantId);
      logEvent(tenantId, "reply_perm_missing", "", tn?.username || tn?.name || "");
      await notify(tr("relay.reply_perm_warn", tn?.nativeLang));
    }
  });

  // ── 零配置绑定:bot 被拉进开启话题的群 → 自动绑定为控制台 ──────────────
  bot.on("my_chat_member", async (ctx, next) => {
    const mc = ctx.myChatMember;
    const status = mc.new_chat_member.status;
    const chat = mc.chat;
    if (status !== "member" && status !== "administrator") return next();
    const t = await getTenant(tenantId);
    if (!t) return next();
    // 话题超级群且尚无控制台 → 自动绑定为控制台(换绑用 /bind)
    if (chat.type === "supergroup" && chat.is_forum && !t.forumChatId) {
      await setTenantForum(tenantId, String(chat.id));
      console.log(`[${tenantId}] 📌 已自动绑定控制台群:${chat.id}`);
      try {
        await ctx.api.sendMessage(chat.id, tr("relay.bind_ok", t.nativeLang));
      } catch {
        /* 无发言权限等,静默 */
      }
      return;
    }
    // 其它群/频道(或控制台已有)→ 首次进入时给跨语言模式指引
    if (chat.type === "group" || chat.type === "supergroup" || chat.type === "channel") {
      if (t.forumChatId && String(chat.id) === t.forumChatId) return next();
      const g = await getGroupChat(tenantId, String(chat.id));
      if (!g) {
        try {
          await ctx.api.sendMessage(chat.id, tr("relay.group_hint", t.nativeLang));
        } catch {
          /* 频道无发帖权限等,静默 */
        }
      }
      return;
    }
    return next();
  });

  // ── 入站 ────────────────────────────────────────────────────────────
  bot.on("business_message", (ctx) => {
    const m = ctx.businessMessage;
    return withLock(String(m.from?.id ?? m.chat.id), async () => {
      const t = await getTenant(tenantId);
      if (!t) return;
      // 每条入站消息自带当前有效的 connection_id,用它实时刷新(防旧 id 失效)
      const msgConn = m.business_connection_id;
      if (msgConn && msgConn !== t.connId) {
        await setTenantConn(tenantId, msgConn).catch(() => {});
      }
      if (!t.forumChatId) {
        console.warn(`[${tenantId}] ⚠️ 收到客户消息但控制台群还没绑定(/bind)。`);
        return;
      }
      const forum = Number(t.forumChatId);
      const fromId = m.from?.id;
      const ownerId = t.ownerUserId || t.id;

      // 租户本人的消息也会回灌:① 在已有话题里手动回复 ② 主动发起给一个新联系人 → 建话题,之后可在控制台继续聊。
      // 这样不必等对方先来消息:你在真人号对任意人说句话,TA 就出现在控制台。
      if (fromId !== undefined && String(fromId) === ownerId) {
        const peerId = String(m.chat.id);
        cancelGreeting(peerId);
        let contact = await getContact(tenantId, peerId);
        let justCreated = false;
        // 主动发起:owner 给还没有话题的人发消息 → 建话题(仅一对一私聊,群不建)
        if (!contact && m.chat.type === "private") {
          const peerName = displayName({ username: m.chat.username, first_name: m.chat.first_name, id: m.chat.id });
          const topic = await ctx.api.createForumTopic(forum, peerName);
          contact = await createContact({ tenantId, tgId: peerId, chatId: peerId, threadId: topic.message_thread_id, name: peerName, connId: msgConn });
          justCreated = true;
          await ctx.api.sendMessage(
            forum,
            tr("relay.owner_initiated", t.nativeLang, { name: peerName }),
            { message_thread_id: topic.message_thread_id },
          );
        }
        if (contact?.threadId != null && m.text) {
          const tag = justCreated ? tr("relay.tag_just_sent", t.nativeLang) : tr("relay.tag_manual_reply", t.nativeLang);
          await ctx.api.sendMessage(forum, `${tag} ${m.text}`, { message_thread_id: contact.threadId });
          await logMessage({ contactId: contact.id, direction: "manual", originalText: m.text });
        }
        return;
      }

      if (fromId === undefined || !m.from) return;

      const tgId = String(fromId);
      const chatId = String(m.chat.id);
      const name = displayName(m.from);
      const existing = await getContact(tenantId, tgId);

      // 归档的 Topic 收到新消息 → 复活并顶起
      if (existing && existing.archived && existing.threadId != null) {
        try {
          await ctx.api.reopenForumTopic(forum, existing.threadId);
        } catch (e) {
          console.error(`[${tenantId}] 复活 Topic 失败:`, e);
        }
        await setArchived(existing.id, false);
      }

      // 确保有 Topic(返回联系人与是否新建)
      const ensureContact = async (): Promise<{ contact: { id: number; threadId: number }; isNew: boolean }> => {
        if (existing?.threadId != null) return { contact: { id: existing.id, threadId: existing.threadId }, isNew: false };
        const topic = await ctx.api.createForumTopic(forum, name);
        const c = await createContact({ tenantId, tgId, chatId, threadId: topic.message_thread_id, name, connId: msgConn });
        return { contact: { id: c.id, threadId: topic.message_thread_id }, isNew: true };
      };

      // 表情消息(贴纸 或 纯 emoji 文本)→ 显示具体表情 + 新客户安排自动开场白
      const sticker = m.sticker;
      const emojiText = m.text && isEmojiOnly(m.text) ? m.text : null;
      if (sticker || emojiText) {
        const { contact } = await ensureContact();
        if (existing) await touchContact(existing.id, msgConn);
        const shown = sticker
          ? tr("relay.sticker", t.nativeLang, { emoji: sticker.emoji ?? "❓" })
          : tr("relay.emoji", t.nativeLang, { emoji: emojiText! });
        await ctx.api.sendMessage(forum, tr("relay.emoji_received", t.nativeLang, { shown }), { message_thread_id: contact.threadId });
        await logMessage({
          contactId: contact.id,
          direction: "in",
          originalText: sticker ? (sticker.emoji ?? "[sticker]") : emojiText!,
          mediaType: "emoji",
        });
        const c = existing ?? (await getContact(tenantId, tgId));
        if (!c?.greeted) scheduleGreeting(tgId, chatId, forum, contact.threadId, msgConn);
        return;
      }

      // 其它媒体(图/语音/文件/视频)→ 转发素材进 Topic + 落 Asset
      if (!m.text) {
        cancelGreeting(tgId);
        const { contact } = await ensureContact();
        if (existing) await touchContact(existing.id, msgConn);
        const caption = tr("relay.media_caption", t.nativeLang, { name });
        const opts = { message_thread_id: contact.threadId, caption };
        let mediaType = "file";
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
            await ctx.api.sendMessage(forum, tr("relay.media_nontext", t.nativeLang, { name }), { message_thread_id: contact.threadId });
          }
        } catch (e) {
          console.error(`[${tenantId}] 媒体转发失败:`, e);
          await ctx.api.sendMessage(forum, tr("relay.media_forward_fail", t.nativeLang, { name, type: mediaType }), {
            message_thread_id: contact.threadId,
          });
        }
        if (fileId) {
          const localPath = await downloadTgFile(bot.token, fileId, `${tenantId}/${tgId}`, fileName ?? mediaType);
          await createAsset({ contactId: contact.id, direction: "in", type: mediaType, fileId, fileName, localPath: localPath ?? undefined, size });
          const note = localPath ? tr("relay.archived_downloaded_note", t.nativeLang) : tr("relay.archived_cloud_note", t.nativeLang);
          await ctx.api.sendMessage(
            forum,
            tr("relay.archived", t.nativeLang, { note, name: fileName ?? mediaType }),
            { message_thread_id: contact.threadId },
          );
        }
        await logMessage({ contactId: contact.id, direction: "in", originalText: `[${mediaType}]`, mediaType });
        return;
      }

      // 文本 → 取消开场白 + 译成租户母语(检测语种)
      cancelGreeting(tgId);
      const { contact, isNew } = await ensureContact();
      if (existing) await touchContact(existing.id, msgConn);

      let lang = existing?.lang ?? "unknown";
      let native = m.text;
      try {
        const r = await translateInbound(m.text, t.nativeLang);
        native = r.native;
        // 语种首次锁定:短消息易误判,已锁定后不再自动改(用 /lang 手动纠正)
        if (lang === "unknown" && r.lang !== "unknown") {
          lang = r.lang;
          await setLang(contact.id, lang);
        }
      } catch (e) {
        console.error(`[${tenantId}] 翻译失败,原文落档:`, e);
        logEvent(tenantId, "translate_fail", (e instanceof Error ? e.message : String(e)).slice(0, 120), t.username || t.name);
        await ctx.api.sendMessage(forum, tr("relay.translate_fail", t.nativeLang, { text: m.text }), {
          message_thread_id: contact.threadId,
        });
        await logMessage({ contactId: contact.id, direction: "in", originalText: m.text });
        return;
      }

      await ctx.api.sendMessage(forum, renderCard(name, isNew, lang, m.text, native, t.nativeLang), {
        message_thread_id: contact.threadId,
      });
      await logMessage({ contactId: contact.id, direction: "in", originalText: m.text, originalLang: lang, nativeText: native });
    });
  });

  // ── 出站:租户在 Topic 里打母语 → 译客户语 → 以租户名义发出 ─────────────
  bot.on("message", async (ctx, next) => {
    if (ctx.from?.id === ctx.me.id) return;

    // /bind:把当前群绑定/换绑为控制台(仅租户本人;必须是开启话题的超级群)。
    // 私聊里的 /bind 交给门户回指引(在共享实例上 next() 流向 portal),别在这里误导。
    const rawText = ctx.message.text?.trim();
    if (rawText === "/bind" || rawText?.startsWith("/bind@")) {
      if (ctx.chat.type === "private") return next();
      const t = await getTenant(tenantId);
      if (!t) return next();
      if (String(ctx.from?.id) !== (t.ownerUserId || t.id)) {
        await ctx.reply(tr("relay.bind_owner_only", t.nativeLang));
        return;
      }
      if (ctx.chat.type === "supergroup" && ctx.chat.is_forum) {
        await setTenantForum(tenantId, String(ctx.chat.id));
        console.log(`[${tenantId}] 📌 已绑定控制台群:${ctx.chat.id}`);
        await ctx.reply(tr("relay.bind_ok", t.nativeLang), { message_thread_id: ctx.message.message_thread_id });
      } else {
        await ctx.reply(tr("relay.bind_need_topics", t.nativeLang));
      }
      return;
    }

    const t = await getTenant(tenantId);

    // ── 跨语言群组:注册过的普通群(非控制台)自动把非目标语消息翻成目标语回帖 ──
    if ((ctx.chat.type === "group" || ctx.chat.type === "supergroup") && !(t?.forumChatId && ctx.chat.id === Number(t.forumChatId))) {
      // /glang <码>|off:开关本群跨语言模式(仅租户本人)
      if (rawText === "/glang" || rawText?.startsWith("/glang ") || rawText?.startsWith("/glang@")) {
        if (!t) return next();
        if (String(ctx.from?.id) !== (t.ownerUserId || t.id)) {
          await ctx.reply(tr("relay.glang_owner_only", t.nativeLang));
          return;
        }
        const garg = rawText.replace(/^\/glang(@\S+)?\s*/, "").trim().toLowerCase();
        if (garg === "off") {
          await upsertGroupChat(tenantId, String(ctx.chat.id), { enabled: false });
          await ctx.reply(tr("relay.glang_off", t.nativeLang));
        } else if (/^[a-z]{2,3}$/.test(garg)) {
          await upsertGroupChat(tenantId, String(ctx.chat.id), { title: "title" in ctx.chat ? (ctx.chat.title ?? "") : "", kind: "group", targetLang: garg, enabled: true });
          await ctx.reply(tr("relay.glang_set", t.nativeLang, { lang: garg }));
        } else {
          await ctx.reply(tr("relay.glang_usage", t.nativeLang));
        }
        return;
      }
      const g = await getGroupChat(tenantId, String(ctx.chat.id));
      if (g?.enabled && t) {
        const gtext = ctx.message.text ?? ctx.message.caption;
        if (gtext && !gtext.startsWith("/") && gtext.length >= 2 && !ctx.from?.is_bot)
          await groupTranslate(ctx.chat.id, ctx.message.message_id, gtext, t, g);
        return;
      }
      return next();
    }

    if (!t?.forumChatId || ctx.chat.id !== Number(t.forumChatId)) return next();
    const threadId = ctx.message.message_thread_id;
    if (threadId === undefined) return;

    const contact = await getContactByThread(tenantId, threadId);
    if (!contact) return; // 非客户 Topic(General 等),不响应

    const conn = t.connId ?? contact.connId; // 租户最新连接优先(owner 重连后旧 id 会失效)

    // 出站文件:在客户 Topic 里发文件/视频/图 → 经 Business 转发给客户 + 存档
    const outDoc = ctx.message.document;
    const outVideo = ctx.message.video;
    const outPhoto = ctx.message.photo;
    if (outDoc || outVideo || (outPhoto && outPhoto.length)) {
      if (!conn) {
        await ctx.reply(tr("relay.no_conn_file", t.nativeLang), { message_thread_id: threadId });
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
        const localPath = await downloadTgFile(bot.token, fileId, `${tenantId}/${contact.tgId}`, fileName ?? type);
        await createAsset({ contactId: contact.id, direction: "out", type, fileId, fileName, localPath: localPath ?? undefined, size });
        await logMessage({ contactId: contact.id, direction: "out", originalText: `[发送${type}] ${fileName ?? ""}`, mediaType: type });
        const note = localPath ? tr("relay.file_sent_archived_note", t.nativeLang) : tr("relay.file_sent_cloud_note", t.nativeLang);
        await ctx.reply(tr("relay.file_sent", t.nativeLang, { note }), { message_thread_id: threadId });
      } catch (e) {
        console.error(`[${tenantId}] 出站文件失败:`, e);
        await ctx.reply(tr("relay.file_send_fail", t.nativeLang), { message_thread_id: threadId });
      }
      return;
    }

    const text = ctx.message.text;
    if (!text) return;

    // 话题内命令
    if (text.startsWith("/")) {
      const [cmd, arg] = text.trim().split(/\s+/);
      if (cmd === "/lang") {
        const code = (arg ?? "").toLowerCase();
        if (!/^[a-z]{2,3}$/.test(code)) {
          await ctx.reply(tr("relay.lang_usage", t.nativeLang), { message_thread_id: threadId });
          return;
        }
        await setLang(contact.id, code);
        await ctx.reply(tr("relay.lang_set", t.nativeLang, { name: contact.name, code }), { message_thread_id: threadId });
      } else if (cmd === "/t") {
        // 模板列表 → inline 按钮,点按走翻译预览
        const list = await getTemplates(tenantId);
        if (!list.length) {
          await ctx.reply(tr("relay.tpl_empty", t.nativeLang), { message_thread_id: threadId });
          return;
        }
        const rows: { text: string; callback_data: string }[][] = [];
        for (let i = 0; i < list.length; i += 2)
          rows.push(list.slice(i, i + 2).map((tp) => ({ text: tp.label, callback_data: `tpl:${tp.id}` })));
        await ctx.reply(tr("relay.tpl_pick", t.nativeLang), { message_thread_id: threadId, reply_markup: { inline_keyboard: rows } });
      } else if (cmd === "/t_add") {
        const m2 = text.match(/^\/t_add\s+(\S+)\s+([\s\S]+)/);
        if (!m2) {
          await ctx.reply(tr("relay.tpl_usage", t.nativeLang), { message_thread_id: threadId });
          return;
        }
        await upsertTemplate(tenantId, m2[1]!.slice(0, 32), m2[2]!.trim());
        await ctx.reply(tr("relay.tpl_added", t.nativeLang, { label: m2[1]!.slice(0, 32) }), { message_thread_id: threadId });
      } else if (cmd === "/t_del") {
        if (!arg) {
          await ctx.reply(tr("relay.tpl_usage", t.nativeLang), { message_thread_id: threadId });
          return;
        }
        const ok = await delTemplate(tenantId, arg);
        await ctx.reply(tr(ok ? "relay.tpl_deleted" : "relay.tpl_missing", t.nativeLang, { label: arg }), { message_thread_id: threadId });
      } else if (cmd === "/draft") {
        // AI 拟稿:客户最近对话 + 可选要点 → 母语草稿 → 直接进翻译预览
        const brief = text.replace(/^\/draft\s*/, "").trim();
        try {
          const history = await recentMessages(contact.id, 10);
          const dialog = history
            .map((m2) => `${m2.direction === "in" ? `客户(${contact.name})` : "我"}:${m2.nativeText || m2.originalText}`)
            .join("\n");
          const draft = await complete(
            `你是用户的商务沟通助理。根据与客户的最近对话${brief ? "和用户给出的要点" : ""},用${langName(t.nativeLang)}以用户第一人称口吻拟一条自然、得体、简洁的回复。只输出回复正文,不要任何解释或前后缀。`,
            `最近对话:\n${dialog || "(暂无历史)"}\n${brief ? `\n用户要点:${brief}` : "\n(无要点,请根据对话上下文拟最合适的回复)"}`,
            500,
          );
          if (!draft) throw new Error("empty draft");
          await startPreview(t, contact, threadId, draft);
        } catch (e) {
          console.error(`[${tenantId}] 拟稿失败:`, e);
          await ctx.reply(tr("relay.draft_fail", t.nativeLang), { message_thread_id: threadId });
        }
      } else if (cmd === "/help") {
        await ctx.reply(tr("relay.help", t.nativeLang), { message_thread_id: threadId });
      } else {
        await ctx.reply(tr("relay.unknown_cmd", t.nativeLang), { message_thread_id: threadId });
      }
      return;
    }

    if (!conn) {
      await ctx.reply(tr("relay.no_conn_text", t.nativeLang), {
        message_thread_id: threadId,
      });
      return;
    }

    // 租户在话题里回了 → 取消该客户待发的自动开场白
    cancelGreeting(contact.tgId);

    // 翻译后先在 Topic 预览,确认才发客户(杜绝误发)
    await startPreview(t, contact, threadId, text);
  });

  // ── 跨语言频道:发帖后自动跟发译文;频道内发 /glang 配置(能发帖即视为管理员) ──
  bot.on("channel_post", async (ctx) => {
    const post = ctx.channelPost;
    const text = post.text ?? post.caption;
    if (!text) return;
    const t = await getTenant(tenantId);
    if (!t) return;
    const chatId = String(ctx.chat.id);
    if (text.startsWith("/glang")) {
      const garg = text.replace(/^\/glang(@\S+)?\s*/, "").trim().toLowerCase();
      if (garg === "off") {
        await upsertGroupChat(tenantId, chatId, { enabled: false });
        await ctx.reply(tr("relay.glang_off", t.nativeLang)).catch(() => {});
      } else if (/^[a-z]{2,3}$/.test(garg)) {
        await upsertGroupChat(tenantId, chatId, { title: ctx.chat.title ?? "", kind: "channel", targetLang: garg, enabled: true });
        await ctx.reply(tr("relay.glang_set", t.nativeLang, { lang: garg })).catch(() => {});
      } else {
        await ctx.reply(tr("relay.glang_usage", t.nativeLang)).catch(() => {});
      }
      return;
    }
    const g = await getGroupChat(tenantId, chatId);
    if (!g?.enabled || text.length < 2) return;
    await groupTranslate(ctx.chat.id, post.message_id, text, t, g);
  });

  // ── 按钮回调:出站确认 / 模板选发 ────────────────────────────────────
  bot.on("callback_query:data", async (ctx, next) => {
    const [action, arg] = ctx.callbackQuery.data.split(":");

    // 模板按钮:模板文案 → 常规翻译预览流程(与打字完全一致,确认才发)
    if (action === "tpl") {
      const t = await getTenant(tenantId);
      const threadId = ctx.callbackQuery.message?.message_thread_id;
      if (!t?.forumChatId || threadId === undefined) return void (await ctx.answerCallbackQuery());
      const tp = await getTemplate(Number(arg));
      if (!tp || tp.tenantId !== tenantId) {
        await ctx.answerCallbackQuery(tr("relay.tpl_gone", t.nativeLang));
        return;
      }
      const contact = await getContactByThread(tenantId, threadId);
      if (!contact) return void (await ctx.answerCallbackQuery());
      await ctx.answerCallbackQuery();
      await startPreview(t, contact, threadId, tp.text);
      return;
    }

    if (action !== "send" && action !== "cancel") return next();
    const token = Number(arg);
    const p = pendingOut.get(token);
    const t = await getTenant(tenantId);
    const lang = t?.nativeLang;
    if (!p) {
      await ctx.answerCallbackQuery(tr("relay.preview_expired", lang));
      return;
    }
    if (action === "cancel") {
      pendingOut.delete(token);
      await ctx.editMessageText(tr("relay.cancelled", lang, { original: p.original }));
      await ctx.answerCallbackQuery(tr("relay.cb_cancelled", lang));
      return;
    }
    // 免费额度门:超额则拦发送(草稿保留),在话题里给升级入口。入站永不受限,不丢客户消息。
    if (t && isOverQuota(t)) {
      const thread = ctx.callbackQuery.message?.message_thread_id;
      const url = `https://t.me/${getPortalUsername()}?start=subscribe`;
      await ctx.answerCallbackQuery({ text: tr("relay.cb_quota", lang), show_alert: true });
      await ctx.api.sendMessage(
        Number(t.forumChatId),
        tr("relay.quota_full", lang, { quota: config.freeQuota, price: config.priceStars }),
        { message_thread_id: thread, reply_markup: { inline_keyboard: [[{ text: tr("relay.btn_upgrade", lang), url }]] } },
      );
      return;
    }
    const conn = t?.connId ?? p.connId; // 租户最新连接优先(owner 重连后草稿里的旧 id 会失效)
    if (!conn) {
      await ctx.answerCallbackQuery(tr("relay.cb_no_conn", lang));
      return;
    }
    const doSend = async (cid: string) => {
      await ctx.api.sendMessage(Number(p.chatId), p.translated, { business_connection_id: cid });
      await ctx.editMessageText(tr("relay.sent", lang, { lang: p.lang, translated: p.translated }));
      await logMessage({ contactId: p.contactId, direction: "out", originalText: p.translated, originalLang: p.lang, nativeText: p.original });
      await bumpOutbound(tenantId); // 计一条出站(免费额度计量)
      pendingOut.delete(token);
    };
    try {
      await doSend(conn);
      await ctx.answerCallbackQuery(tr("relay.cb_sent", lang));
    } catch (e) {
      const em = e instanceof Error ? e.message : "";
      // 连接失效:多半是 owner 刚去 Chatbots 重连过、草稿里的 conn 已旧 —— 拉租户最新 conn 自动重发一次
      if (em.includes("business connection not found") || em.includes("BUSINESS_CONNECTION_INVALID")) {
        const fresh = (await getTenant(tenantId))?.connId;
        if (fresh && fresh !== conn) {
          try {
            await doSend(fresh);
            await ctx.answerCallbackQuery(tr("relay.cb_sent", lang));
            return;
          } catch (e2) {
            console.error(`[${tenantId}] 用最新连接重发仍失败:`, e2);
          }
        }
      }
      console.error(`[${tenantId}] 发送失败:`, e);
      let tip = tr("relay.tip_generic", lang);
      let failKind = "unknown";
      if (em.includes("BUSINESS_PEER_INVALID")) {
        tip = tr("relay.tip_peer_invalid", lang);
        failKind = "BUSINESS_PEER_INVALID(多半是回复权限没开)";
      } else if (em.includes("BUSINESS_PEER_USAGE_MISSING") || em.includes("BUSINESS_CHAT_INACTIVE") || em.includes("PEER_ID_INVALID")) {
        tip = tr("relay.tip_peer_usage", lang);
        failKind = "对方超 24h 未互动,bot 不能主动发起";
      } else if (em.includes("business connection not found") || em.includes("BUSINESS_CONNECTION_INVALID")) {
        tip = tr("relay.tip_conn_invalid", lang);
        failKind = "Business 连接失效";
      }
      logEvent(tenantId, "send_fail", failKind === "unknown" ? em.slice(0, 120) : failKind, t?.username || t?.name || "");
      await ctx.answerCallbackQuery(tip);
    }
  });

  bot.catch((err) => console.error(`[${tenantId}] ‼️ bot 出错:`, err));
}

/** 归档某租户超期无往来的 Topic(由 manager 拿着对应 bot 实例调用) */
export async function archiveTopicsFor(bot: Bot, tenant: Tenant, threadIds: { contactId: number; threadId: number }[]): Promise<void> {
  if (!tenant.forumChatId) return;
  for (const { contactId, threadId } of threadIds) {
    try {
      await bot.api.closeForumTopic(Number(tenant.forumChatId), threadId);
      await setArchived(contactId, true);
    } catch (e) {
      console.error(`[${tenant.id}] 归档 Topic 失败:`, e);
    }
  }
}
