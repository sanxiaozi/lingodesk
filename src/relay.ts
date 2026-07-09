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
import { translateInbound, translateOutbound } from "./ai/translate.js";
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
} from "./db.js";

const BIND_OK =
  "✅ 本群已绑定为你的 LingoDesk 控制台。\n客户私聊你的真人号时,这里会自动弹出专属话题和双语卡片;你在话题里打母语即可回复。";

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
        const conn = connId ?? t?.connId;
        if (!conn) return;
        const g = config.greeting;
        await bot.api.sendMessage(Number(chatId), g, { business_connection_id: conn });
        await bot.api.sendMessage(forum, `🤖 [${Math.round(config.greetDelayMs / 1000)}s 自动开场白] ${g}`, {
          message_thread_id: threadId,
        });
        await markGreeted(c.id);
        await logMessage({ contactId: c.id, direction: "out", originalText: g, nativeText: "[自动开场白]" });
      } catch (e) {
        console.error(`[${tenantId}] 自动开场白发送失败:`, e);
      }
    }, config.greetDelayMs);
    greetTimers.set(tgId, timer);
  }

  /** 渲染双语卡片 */
  function renderCard(name: string, isNew: boolean, lang: string, original: string, native: string): string {
    return [
      `${isNew ? "🆕新客户" : "💬"} ${name}(${lang})`,
      `原文:${original}`,
      `🌐 ${native}`,
      "─────",
      `↳ 本话题内打母语,自动译 ${resolveLang(lang)} 以你名义发出`,
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
      await notify(
        [
          "⚠️ 检测到你绑定了 bot 但没打开「回复消息」权限 —— 现在能收到翻译,但点「发送给客户」会失败。",
          "",
          "修复:设置 → Telegram Business → 聊天自动化(Chatbots) → 选中你的 bot → 打开「回复消息(Reply to messages)」权限。",
          "开完权限立即生效,回到话题里重新点发送即可。",
        ].join("\n"),
      );
    }
  });

  // ── 零配置绑定:bot 被拉进开启话题的群 → 自动绑定为控制台 ──────────────
  bot.on("my_chat_member", async (ctx, next) => {
    const mc = ctx.myChatMember;
    const status = mc.new_chat_member.status;
    const chat = mc.chat;
    if (chat.type !== "supergroup" || !chat.is_forum) return next();
    if (status !== "member" && status !== "administrator") return next();
    const t = await getTenant(tenantId);
    if (!t || t.forumChatId) return next(); // 已有控制台,换绑用 /bind
    await setTenantForum(tenantId, String(chat.id));
    console.log(`[${tenantId}] 📌 已自动绑定控制台群:${chat.id}`);
    try {
      await ctx.api.sendMessage(chat.id, BIND_OK);
    } catch {
      /* 无发言权限等,静默 */
    }
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
            `📤 你主动联系了 ${peerName} —— 已建话题。在这里打${t.nativeLang === "zh" ? "中文" : "母语"}即可继续和 TA 聊(自动翻译成对方语言;对方语种默认英语,可用 /lang 修正)。`,
            { message_thread_id: topic.message_thread_id },
          );
        }
        if (contact?.threadId != null && m.text) {
          const tag = justCreated ? "📨 [你刚发出]" : "📝 [你手动回复]";
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
        const shown = sticker ? `贴纸 ${sticker.emoji ?? "❓"}` : `表情 ${emojiText}`;
        await ctx.api.sendMessage(forum, `😊 客户发来${shown}`, { message_thread_id: contact.threadId });
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
        const caption = `📎 ${name} 发来素材`;
        const opts = { message_thread_id: contact.threadId, caption };
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
            await ctx.api.sendMessage(forum, `📎 ${name} 发来非文本消息`, { message_thread_id: contact.threadId });
          }
        } catch (e) {
          console.error(`[${tenantId}] 媒体转发失败:`, e);
          await ctx.api.sendMessage(forum, `📎 ${name} 发来[${mediaType}],转发失败`, {
            message_thread_id: contact.threadId,
          });
        }
        if (fileId) {
          const localPath = await downloadTgFile(bot.token, fileId, `${tenantId}/${tgId}`, fileName ?? mediaType);
          await createAsset({ contactId: contact.id, direction: "in", type: mediaType, fileId, fileName, localPath: localPath ?? undefined, size });
          await ctx.api.sendMessage(
            forum,
            `💾 已存档${localPath ? "(已下载)" : "(>20MB 仅云端)"}:${fileName ?? mediaType}`,
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
        await ctx.api.sendMessage(forum, `⚠️ 翻译暂时失败,客户原文(请手动处理):\n${m.text}`, {
          message_thread_id: contact.threadId,
        });
        await logMessage({ contactId: contact.id, direction: "in", originalText: m.text });
        return;
      }

      await ctx.api.sendMessage(forum, renderCard(name, isNew, lang, m.text, native), {
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
        await ctx.reply("只有绑定了本 bot 的账号本人可以 /bind。");
        return;
      }
      if (ctx.chat.type === "supergroup" && ctx.chat.is_forum) {
        await setTenantForum(tenantId, String(ctx.chat.id));
        console.log(`[${tenantId}] 📌 已绑定控制台群:${ctx.chat.id}`);
        await ctx.reply(BIND_OK, { message_thread_id: ctx.message.message_thread_id });
      } else {
        await ctx.reply("请先在群设置里开启「话题(Topics)」,再在群里发 /bind。");
      }
      return;
    }

    const t = await getTenant(tenantId);
    if (!t?.forumChatId || ctx.chat.id !== Number(t.forumChatId)) return next();
    const threadId = ctx.message.message_thread_id;
    if (threadId === undefined) return;

    const contact = await getContactByThread(tenantId, threadId);
    if (!contact) return; // 非客户 Topic(General 等),不响应

    const conn = contact.connId ?? t.connId;

    // 出站文件:在客户 Topic 里发文件/视频/图 → 经 Business 转发给客户 + 存档
    const outDoc = ctx.message.document;
    const outVideo = ctx.message.video;
    const outPhoto = ctx.message.photo;
    if (outDoc || outVideo || (outPhoto && outPhoto.length)) {
      if (!conn) {
        await ctx.reply("⚠️ 尚无 business_connection,去 Telegram Business → Chatbots 重连。", { message_thread_id: threadId });
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
        await ctx.reply(`📤 已把文件发给客户${localPath ? " · 💾已存档" : " · (>20MB 仅云端)"}`, { message_thread_id: threadId });
      } catch (e) {
        console.error(`[${tenantId}] 出站文件失败:`, e);
        await ctx.reply("⚠️ 发送文件失败,请稍后再试。", { message_thread_id: threadId });
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
          await ctx.reply("用法:/lang <ISO639-1 语种码>,例如 /lang es", { message_thread_id: threadId });
          return;
        }
        await setLang(contact.id, code);
        await ctx.reply(`✅ 已把「${contact.name}」的语种改为 ${code},后续出站按此翻译。`, { message_thread_id: threadId });
      } else if (cmd === "/help") {
        await ctx.reply(
          "话题命令:\n/lang <码> — 手动修正客户语种(如 /lang es)\n/bind — 把某个群绑定为控制台\n直接打母语 = 翻译预览后发给客户",
          { message_thread_id: threadId },
        );
      } else {
        await ctx.reply("未知命令,发 /help 查看。", { message_thread_id: threadId });
      }
      return;
    }

    if (!conn) {
      await ctx.reply("⚠️ 尚未捕获 business_connection,去 Telegram Business → Chatbots 重连一下触发。", {
        message_thread_id: threadId,
      });
      return;
    }

    // 租户在话题里回了 → 取消该客户待发的自动开场白
    cancelGreeting(contact.tgId);

    // 翻译后先在 Topic 预览,确认才发客户(杜绝误发)
    const targetLang = resolveLang(contact.lang);
    const translated = await translateOutbound(text, targetLang);
    const token = ++pendingSeq;
    pendingOut.set(token, { contactId: contact.id, chatId: contact.chatId, connId: contact.connId ?? undefined, lang: targetLang, translated, original: text });
    await ctx.api.sendMessage(
      Number(t.forumChatId),
      `📤 译文预览(→${targetLang}),确认后才发给客户:\n\n${translated}\n\n(你的原话:${text})`,
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

  // ── 按钮回调:出站确认 ───────────────────────────────────────────────
  bot.on("callback_query:data", async (ctx, next) => {
    const [action, arg] = ctx.callbackQuery.data.split(":");
    if (action !== "send" && action !== "cancel") return next();
    const token = Number(arg);
    const p = pendingOut.get(token);
    if (!p) {
      await ctx.answerCallbackQuery("此预览已失效(可能服务重启过),请重新打字。");
      return;
    }
    if (action === "cancel") {
      pendingOut.delete(token);
      await ctx.editMessageText(`✏️ 已取消(未发送)\n原话:${p.original}`);
      await ctx.answerCallbackQuery("已取消");
      return;
    }
    const t = await getTenant(tenantId);
    const conn = p.connId ?? t?.connId;
    if (!conn) {
      await ctx.answerCallbackQuery("尚无 business_connection,去 Chatbots 重连一下。");
      return;
    }
    try {
      await ctx.api.sendMessage(Number(p.chatId), p.translated, { business_connection_id: conn });
      await ctx.editMessageText(`✅ 已发送 → (${p.lang}) ${p.translated}`);
      await logMessage({ contactId: p.contactId, direction: "out", originalText: p.translated, originalLang: p.lang, nativeText: p.original });
      pendingOut.delete(token);
      await ctx.answerCallbackQuery("已发送");
    } catch (e) {
      console.error(`[${tenantId}] 发送失败:`, e);
      const em = e instanceof Error ? e.message : "";
      let tip = "发送失败,稍后再试。";
      if (em.includes("BUSINESS_PEER_INVALID")) {
        tip = "发送被拒:多半是没开「回复消息」权限。去 设置→Telegram Business→聊天自动化→你的 bot→打开「回复消息」;也检查该客户是否在 bot 可访问的聊天范围内。改完重新点发送,草稿已保留。";
      } else if (em.includes("BUSINESS_PEER_USAGE_MISSING") || em.includes("BUSINESS_CHAT_INACTIVE") || em.includes("PEER_ID_INVALID")) {
        tip = "该客户超过 24 小时没往来,Telegram 不让 bot 主动发起(防滥用硬规则)。让 TA 先发一句,或你手动回这次。草稿已保留。";
      } else if (em.includes("business connection not found") || em.includes("BUSINESS_CONNECTION_INVALID")) {
        tip = "Business 连接失效,让客户发条消息刷新或去 Chatbots 重连。草稿已保留。";
      }
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
