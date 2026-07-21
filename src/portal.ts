/**
 * 开通门户:官方 bot 的私聊侧 —— 用户自助提交自己的 bot token,分钟级开通。
 * 挂载顺序:在中继 handler 之后(中继不匹配的私聊消息会 next() 流到这里)。
 *
 * 用户命令:/start 引导;发 token = 开通/换 token;/status 状态;/native <码> 母语;/enable 恢复
 * 管理命令(仅 ADMIN_USER_ID):/tenants 列表;/disable <id>;/enable <id>
 */
import type { Bot } from "grammy";
import { config } from "./config.js";
import { t, resolveUiLang } from "./i18n.js";
import { encrypt, decrypt } from "./crypto.js";
import {
  getTenant,
  getTenantByBotId,
  getAllTenants,
  upsertTenant,
  setTenantStatus,
  setTenantNativeLang,
  tenantUsage,
  currentUsage,
  tenantMonthStats,
  monthlyHistory,
  setPlanPro,
  setPlanFree,
  logEvent,
  isOverQuota,
  bumpOutbound,
  getOrCreateLiteUser,
  updateLiteUser,
  liteUsage,
  isLiteOverQuota,
  bumpLite,
} from "./db.js";
import { translateInbound, translateOutbound } from "./ai/translate.js";
import { startTenant, stopTenant, isRunning, getRunningCount } from "./manager.js";
import { sendProInvoice, handleSuccessfulPayment, paySupportText } from "./billing.js";

/** 套餐 + 本月额度展示行(计费关时不显示) */
function planLine(
  tenant: { plan: string; proUntil: Date | null } & Record<string, unknown>,
  lang?: string | null,
): string | null {
  if (!config.billingEnabled) return null;
  if (tenant.plan === "pro") {
    const until = tenant.proUntil
      ? t("portal.plan_pro_until", lang, { date: tenant.proUntil.toISOString().slice(0, 10) })
      : "";
    return t("portal.plan_pro", lang, { until });
  }
  const used = currentUsage(tenant as never);
  return t("portal.plan_free", lang, { used, quota: config.freeQuota });
}

const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

/** HTML 转义(parse_mode: HTML 消息里的用户内容必须转义) */
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 私聊翻译「↔️ 反向」:方向判断错时一键翻转(内存暂存原文,重启失效可接受)
const flipStore = new Map<number, { text: string; native: string; target: string; cur: "in" | "out" }>();
let flipSeq = 0;

/** 调 getMe 校验 token,返回 bot 身份(含是否开了 Business Mode)或 null */
async function validateToken(token: string): Promise<{ id: string; username: string; canBusiness: boolean } | null> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const j = (await r.json()) as {
      ok: boolean;
      result?: { id: number; username?: string; can_connect_to_business?: boolean };
    };
    if (!j.ok || !j.result) return null;
    return {
      id: String(j.result.id),
      username: j.result.username ?? "",
      canBusiness: j.result.can_connect_to_business === true,
    };
  } catch {
    return null;
  }
}

export function attachPortal(bot: Bot): void {
  bot.on("message:text", async (ctx, next) => {
    if (ctx.chat.type !== "private") return next();
    const text = ctx.message.text.trim();
    const uid = String(ctx.from.id);
    const isAdmin = config.adminUserId !== undefined && uid === config.adminUserId;
    // 语言:已开通租户用 nativeLang;未开通用 Telegram 客户端 language_code;兜底 en
    const lang = (await getTenant(uid))?.nativeLang || resolveUiLang(ctx.from.language_code);

    // ── 管理命令 ──────────────────────────────────────────────────────
    if (
      isAdmin &&
      (text === "/tenants" ||
        text.startsWith("/disable ") ||
        (text.startsWith("/enable ") && text.split(/\s+/)[1]) ||
        text.startsWith("/grant ") ||
        text.startsWith("/revoke "))
    ) {
      const [cmd, arg, arg2] = text.split(/\s+/);
      if (cmd === "/grant") {
        const tn = await getTenant(arg!);
        if (!tn) {
          await ctx.reply(t("portal.admin_no_tenant", lang));
          return;
        }
        const months = Number(arg2) || 12;
        await setPlanPro(tn.id, new Date(Date.now() + months * 30 * 86_400_000), "admin_grant");
        await ctx.reply(t("portal.admin_grant_ok", lang, { id: tn.id, bot: tn.botUsername, months }));
        return;
      }
      if (cmd === "/revoke") {
        const tn = await getTenant(arg!);
        if (!tn) {
          await ctx.reply(t("portal.admin_no_tenant", lang));
          return;
        }
        await setPlanFree(tn.id);
        await ctx.reply(t("portal.admin_revoke_ok", lang, { id: tn.id, bot: tn.botUsername }));
        return;
      }
      if (cmd === "/tenants") {
        const list = await getAllTenants();
        if (!list.length) {
          await ctx.reply(t("portal.admin_no_tenants", lang));
          return;
        }
        const lines = await Promise.all(
          list.map(async (tn) => {
            const u = await tenantUsage(tn.id);
            const run = isRunning(tn.id) ? "🟢" : "⚪";
            const status = `${tn.status}${tn.statusNote ? `:${tn.statusNote}` : ""}`;
            return t("portal.admin_tenant_line", lang, {
              run,
              id: tn.id,
              bot: tn.botUsername,
              status,
              contacts: u.contacts,
              inMsgs: u.inMsgs,
              outMsgs: u.outMsgs,
              forum: tn.forumChatId ? "✓" : "✗",
            });
          }),
        );
        await ctx.reply(
          t("portal.admin_tenants_header", lang, { count: list.length, running: getRunningCount() }) +
            "\n" +
            lines.join("\n"),
        );
      } else if (cmd === "/disable") {
        const tn = await getTenant(arg!);
        if (!tn) {
          await ctx.reply(t("portal.admin_no_tenant", lang));
          return;
        }
        await setTenantStatus(tn.id, "disabled", "disabled by admin");
        await stopTenant(tn.id);
        await ctx.reply(t("portal.admin_disable_ok", lang, { id: tn.id, bot: tn.botUsername }));
      } else {
        const tn = await getTenant(arg!);
        if (!tn) {
          await ctx.reply(t("portal.admin_no_tenant", lang));
          return;
        }
        await setTenantStatus(tn.id, "active");
        await startTenant({ ...tn, status: "active" });
        await ctx.reply(t("portal.admin_enable_ok", lang, { id: tn.id, bot: tn.botUsername }));
      }
      return;
    }

    // ── 用户命令 ──────────────────────────────────────────────────────
    // deep link:控制台超额引导过来的 https://t.me/LingoDeskbot?start=subscribe
    if (text === "/start subscribe" || text === "/subscribe") {
      // 有租户看租户套餐;没租户 = 轻量用户(内联/私聊翻译)也允许直接订 Pro
      const tn = await getTenant(uid);
      const lu = tn ? null : await getOrCreateLiteUser(uid, ctx.from.language_code);
      if ((tn ?? lu)?.plan === "pro") {
        await ctx.reply(t("portal.subscribe_already_pro", lang));
        return;
      }
      try {
        await sendProInvoice(config.botToken, ctx.chat.id, lang);
      } catch (e) {
        console.error("发订阅发票失败:", e);
        await ctx.reply(t("portal.subscribe_invoice_fail", lang));
      }
      return;
    }

    if (text === "/paysupport") {
      await ctx.reply(paySupportText(lang), { link_preview_options: { is_disabled: true } });
      return;
    }

    // 免 Premium 玩法总览(官网/欢迎语导流入口)
    if (text === "/free" || text === "/start free") {
      await ctx.reply(t("portal.free_guide", lang, { bot: ctx.me.username }), { link_preview_options: { is_disabled: true } });
      return;
    }

    if (text === "/start" || text === "/help") {
      // 非 Premium 用户在欢迎语后追加提示:完整中继需 Premium,免费三件套现在就能用
      const premiumNote = ctx.from.is_premium
        ? ""
        : "\n\n" + t("portal.welcome_premium_note", lang, { bot: ctx.me.username });
      await ctx.reply(t("portal.welcome", lang) + premiumNote, { link_preview_options: { is_disabled: true } });
      return;
    }

    if (text === "/status") {
      const tn = await getTenant(uid);
      if (!tn) {
        await ctx.reply(t("portal.status_not_activated", lang));
        return;
      }
      const u = await tenantUsage(tn.id);
      // 实时复查 Business Mode(用户开关 BotFather 后无事件,只能主动查)
      const live = await validateToken(decrypt(tn.botToken)).catch(() => null);
      const bizMode =
        live === null
          ? t("portal.status_biz_unknown", lang)
          : live.canBusiness
            ? t("portal.status_biz_on", lang)
            : t("portal.status_biz_off", lang);
      const state =
        tn.status === "active"
          ? isRunning(tn.id)
            ? t("portal.status_running", lang)
            : t("portal.status_starting", lang)
          : t("portal.status_disabled", lang, { note: tn.statusNote ?? "" });
      // 未连接时:没有 Premium 的账号根本没有「Telegram Business」入口,要说真话并指路免费玩法
      const connVal = tn.connId
        ? "✅"
        : ctx.from.is_premium
          ? t("portal.status_conn_off", lang)
          : t("portal.status_conn_need_premium", lang, { bot: ctx.me.username, ownbot: tn.botUsername });
      // 回复权限在未绑定连接前无意义,显示 —(避免误导性的 ✅)
      const replyVal = tn.connId ? (tn.canReply ? "✅" : t("portal.status_reply_off", lang)) : "—";
      const forumVal = tn.forumChatId ? t("portal.status_forum_ok", lang) : t("portal.status_forum_off", lang);
      await ctx.reply(
        [
          t("portal.status_bot", lang, { bot: tn.botUsername }),
          t("portal.status_state", lang, { state }),
          t("portal.status_secretary", lang, { mode: bizMode }),
          t("portal.status_conn", lang, { val: connVal }),
          t("portal.status_reply", lang, { val: replyVal }),
          t("portal.status_forum", lang, { val: forumVal }),
          t("portal.status_native", lang, { lang: tn.nativeLang }),
          planLine(tn, lang),
          t("portal.status_totals", lang, { contacts: u.contacts, inMsgs: u.inMsgs, outMsgs: u.outMsgs }),
        ]
          .filter(Boolean)
          .join("\n"),
      );
      return;
    }

    if (text === "/usage") {
      const tn = await getTenant(uid);
      if (!tn) {
        // 轻量用户:只展示额度与近月流水(无中继消息统计)
        const lu = await getOrCreateLiteUser(uid, ctx.from.language_code);
        const quotaLine = config.billingEnabled
          ? lu.plan === "pro"
            ? t("portal.usage_quota_pro", lang)
            : t("portal.usage_quota_free", lang, { used: liteUsage(lu), quota: config.freeQuota })
          : t("portal.usage_quota_unlimited", lang);
        const hist = await monthlyHistory(uid, 3);
        const histLines = hist.length ? hist.map((h) => `   ${h.month}: ${h.outCount}`).join("\n") : "   —";
        await ctx.reply([t("portal.usage_header", lang), quotaLine, t("portal.usage_history", lang), histLines].join("\n"));
        return;
      }
      const [m, hist] = await Promise.all([tenantMonthStats(tn.id), monthlyHistory(tn.id, 3)]);
      const quotaLine = config.billingEnabled
        ? tn.plan === "pro"
          ? t("portal.usage_quota_pro", lang)
          : t("portal.usage_quota_free", lang, { used: currentUsage(tn), quota: config.freeQuota })
        : t("portal.usage_quota_unlimited", lang);
      const histLines = hist.length
        ? hist.map((h) => `   ${h.month}: ${h.outCount}`).join("\n")
        : `   —`;
      await ctx.reply(
        [
          t("portal.usage_header", lang),
          quotaLine,
          t("portal.usage_month", lang, { inMsgs: m.inMsgs, outMsgs: m.outMsgs, newContacts: m.newContacts }),
          t("portal.usage_history", lang),
          histLines,
        ].join("\n"),
      );
      return;
    }

    if (isAdmin && text === "/dashboard") {
      const list = await getAllTenants();
      const rows = await Promise.all(
        list.map(async (tn) => {
          const m = await tenantMonthStats(tn.id);
          return { tn, m, used: currentUsage(tn) };
        }),
      );
      rows.sort((a, b) => b.used - a.used);
      const body = rows
        .map(
          (r) =>
            `${r.tn.plan === "pro" ? "⭐" : "  "} @${r.tn.botUsername} — 出站 ${r.used}${r.tn.plan === "free" ? `/${config.freeQuota}` : ""} · 收 ${r.m.inMsgs} · 新客 ${r.m.newContacts}`,
        )
        .join("\n");
      await ctx.reply(`📊 本月用量看板(${list.length} 租户)\n${body || "(无租户)"}`);
      return;
    }

    if (text.startsWith("/native")) {
      const code = (text.split(/\s+/)[1] ?? "").toLowerCase();
      if (!/^[a-z]{2,3}$/.test(code)) {
        await ctx.reply(t("portal.native_usage", lang));
        return;
      }
      const tn = await getTenant(uid);
      if (tn) {
        await setTenantNativeLang(uid, code);
      } else {
        // 未开通也能用:内联/私聊翻译的母语设置
        await getOrCreateLiteUser(uid, ctx.from.language_code);
        await updateLiteUser(uid, { nativeLang: code });
      }
      await ctx.reply(t("portal.native_set", code, { lang: code }));
      return;
    }

    // /to <码>:内联/私聊翻译的译出目标语(免 Premium 玩法)
    if (text.startsWith("/to")) {
      const code = (text.split(/\s+/)[1] ?? "").toLowerCase();
      if (!/^[a-z]{2,3}$/.test(code)) {
        await ctx.reply(t("portal.to_usage", lang));
        return;
      }
      await getOrCreateLiteUser(uid, ctx.from.language_code);
      await updateLiteUser(uid, { targetLang: code });
      await ctx.reply(t("portal.to_set", lang, { lang: code, bot: ctx.me.username }));
      return;
    }

    if (text === "/bind" || text.startsWith("/bind@")) {
      const tn = await getTenant(uid);
      await ctx.reply(
        tn
          ? t("portal.bind_in_group", lang, { bot: tn.botUsername })
          : t("portal.bind_not_activated", lang),
      );
      return;
    }

    if (text === "/enable") {
      const tn = await getTenant(uid);
      if (!tn) {
        await ctx.reply(t("portal.not_activated_short", lang));
        return;
      }
      await setTenantStatus(tn.id, "active");
      await startTenant({ ...tn, status: "active" });
      await ctx.reply(t("portal.enable_ok", lang));
      return;
    }

    // ── token 提交 = 开通/换 token ────────────────────────────────────
    if (TOKEN_RE.test(text)) {
      // 尽快删掉带 token 的消息(降低泄露面)。
      // 注:提交门户 bot 自己的 token 也是合法的 —— 持有 token 即所有权证明,
      // 这是自托管用户把自己注册为第一租户的方式(实例复用门户 bot,见 manager)。
      const delToken = ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      const me = await validateToken(text);
      if (!me) {
        await delToken;
        logEvent(uid, "token_invalid", "", ctx.from.username ?? ctx.from.first_name ?? "");
        await ctx.reply(t("portal.token_invalid", lang));
        return;
      }
      const clash = await getTenantByBotId(me.id);
      if (clash && clash.id !== uid) {
        await delToken;
        logEvent(uid, "token_clash", `@${me.username} 已被 ${clash.id} 注册`, ctx.from.username ?? ctx.from.first_name ?? "");
        await ctx.reply(t("portal.token_clash", lang));
        return;
      }
      const tenant = await upsertTenant({
        id: uid,
        botId: me.id,
        botUsername: me.username,
        botToken: encrypt(text),
        name: ctx.from.first_name ?? "",
        username: ctx.from.username ?? "",
      });
      await startTenant(tenant);
      await delToken;
      // 最高频卡点前置拦截:Business Mode 没开就把修复指引顶在最前面
      if (!me.canBusiness) logEvent(uid, "secretary_mode_off", `@${me.username}`, ctx.from.username ?? ctx.from.first_name ?? "");
      // 非 Premium 账号:Telegram Business 入口根本不存在,提前说明白 + 指路免费玩法
      if (!ctx.from.is_premium) logEvent(uid, "no_premium_activation", `@${me.username}`, ctx.from.username ?? ctx.from.first_name ?? "");
      const premiumWarn = ctx.from.is_premium ? "" : t("portal.premium_needed_notice", lang, { bot: ctx.me.username, ownbot: me.username }) + "\n\n";
      const prefix = premiumWarn + (me.canBusiness ? "" : t("portal.business_mode_fix", lang) + "\n\n");
      await ctx.reply(prefix + t("portal.activated", lang, { bot: me.username }), {
        link_preview_options: { is_disabled: true },
      });
      console.log(`🎫 新租户开通:${uid}(@${ctx.from.username ?? "?"})→ bot @${me.username}`);
      return;
    }

    // 未识别的命令 → 兜底引导
    if (text.startsWith("/")) {
      await ctx.reply(
        config.billingEnabled
          ? t("portal.fallback_billing", lang)
          : t("portal.fallback_nobilling", lang),
      );
      return;
    }

    // ── 免 Premium 私聊翻译:非命令文本/转发的消息 = 翻译请求 ──────────
    // 外语 → 译成母语看懂;母语 → 译成 /to 目标语(译文 <code> 可点按复制)
    const tn2 = await getTenant(uid);
    const lu = await getOrCreateLiteUser(uid, ctx.from.language_code);
    const native = tn2?.nativeLang || lu.nativeLang;
    if (tn2 ? isOverQuota(tn2) : isLiteOverQuota(lu)) {
      await ctx.reply(t("portal.lite_quota_full", lang, { quota: config.freeQuota }));
      return;
    }
    try {
      const firstUse = !tn2 && lu.usageMonth === ""; // 从未用过 → 附一次玩法提示
      const r = await translateInbound(text, native);
      let out = r.native;
      let dir = native;
      let cur: "in" | "out" = "in";
      if (r.lang === native && native !== lu.targetLang) {
        out = await translateOutbound(text, lu.targetLang);
        dir = lu.targetLang;
        cur = "out";
      }
      const hint = firstUse ? `\n\n${escHtml(t("portal.lite_hint", lang, { lang: lu.targetLang, bot: ctx.me.username }))}` : "";
      // ↔️ 反向按钮:短句语种判断偶尔会错,一键翻转方向
      const fToken = ++flipSeq;
      flipStore.set(fToken, { text, native, target: lu.targetLang, cur });
      if (flipStore.size > 500) flipStore.delete(flipStore.keys().next().value!);
      await ctx.reply(`🌐 → ${dir}\n<code>${escHtml(out)}</code>${hint}`, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "↔️", callback_data: `flip:${fToken}` }]] },
      });
      if (tn2) await bumpOutbound(tn2.id);
      else await bumpLite(uid);
    } catch (e) {
      console.error("私聊翻译失败:", e);
      await ctx.reply(
        config.billingEnabled ? t("portal.fallback_billing", lang) : t("portal.fallback_nobilling", lang),
      );
    }
  });

  // 订阅支付:预检查(须 10 秒内应答 true,否则不扣款)
  bot.on("pre_checkout_query", async (ctx) => {
    await ctx.answerPreCheckoutQuery(true).catch((e) => console.error("pre_checkout 应答失败:", e));
  });

  // 订阅支付:成功(首购 + 每月自动续费都到这里)
  bot.on("message:successful_payment", (ctx) => handleSuccessfulPayment(ctx));

  // ── 私聊翻译「↔️ 反向」回调(共享实例上 relay 的 send/cancel/tpl 会先处理并 next 其余) ──
  bot.on("callback_query:data", async (ctx, next) => {
    const [action, arg] = ctx.callbackQuery.data.split(":");
    if (action !== "flip") return next();
    const st = flipStore.get(Number(arg));
    if (!st) {
      await ctx.answerCallbackQuery("⌛").catch(() => {});
      return;
    }
    try {
      st.cur = st.cur === "out" ? "in" : "out";
      const out = st.cur === "out" ? await translateOutbound(st.text, st.target) : (await translateInbound(st.text, st.native)).native;
      const dir = st.cur === "out" ? st.target : st.native;
      await ctx
        .editMessageText(`🌐 → ${dir}\n<code>${escHtml(out)}</code>`, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "↔️", callback_data: `flip:${arg}` }]] },
        })
        .catch(() => {});
      await ctx.answerCallbackQuery();
    } catch (e) {
      console.error("反向翻译失败:", e);
      await ctx.answerCallbackQuery("⚠️").catch(() => {});
    }
  });

  // ── 免 Premium 内联翻译:任意聊天里打 @bot 文字 → 点选即以本人名义发出译文 ──
  // 需在 BotFather 开启 /setinline;计量在 chosen_inline_result(真正发出才扣额度,
  // 需 /setinlinefeedback 100%)。350ms 防抖:只译用户停顿后的最后一版,免得每敲一键都调 AI。
  const inlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  bot.on("inline_query", async (ctx) => {
    const q = ctx.inlineQuery.query.trim();
    const uid = String(ctx.from.id);
    if (q.length < 2) {
      await ctx.answerInlineQuery([], { cache_time: 0 }).catch(() => {});
      return;
    }
    const prev = inlineTimers.get(uid);
    if (prev) clearTimeout(prev);
    inlineTimers.set(
      uid,
      setTimeout(async () => {
        inlineTimers.delete(uid);
        try {
          const tn = await getTenant(uid);
          const lu = await getOrCreateLiteUser(uid, ctx.from.language_code);
          const lang2 = tn?.nativeLang || lu.nativeLang;
          if (tn ? isOverQuota(tn) : isLiteOverQuota(lu)) {
            // 额度用尽:不给结果,给一个跳到私聊订阅的按钮
            await ctx.answerInlineQuery([], {
              cache_time: 5,
              is_personal: true,
              button: { text: t("portal.inline_quota_btn", lang2), start_parameter: "subscribe" },
            });
            return;
          }
          const native = tn?.nativeLang || lu.nativeLang;
          const r = await translateInbound(q, native);
          const outbound = r.lang === native && native !== lu.targetLang;
          const out = outbound ? await translateOutbound(q, lu.targetLang) : r.native;
          const dir = outbound ? lu.targetLang : native;
          // 两个结果:纯译文 / 双语版(原文+译文,谈生意常用,双方都看得懂)
          await ctx.answerInlineQuery(
            [
              {
                type: "article",
                id: "tr",
                title: out.slice(0, 64),
                description: `🌐 → ${dir}`,
                input_message_content: { message_text: out },
              },
              {
                type: "article",
                id: "bi",
                title: `💬 ${q.slice(0, 32)} …`,
                description: t("portal.inline_bilingual", lang2),
                input_message_content: { message_text: `${q}\n———\n${out}` },
              },
            ],
            { cache_time: 30, is_personal: true },
          );
        } catch (e) {
          console.error("内联翻译失败:", e);
          await ctx.answerInlineQuery([], { cache_time: 0 }).catch(() => {});
        }
      }, 350),
    );
  });

  // 用户真的点选发出了译文 → 计一条额度
  bot.on("chosen_inline_result", async (ctx) => {
    const uid = String(ctx.from.id);
    const tn = await getTenant(uid);
    if (tn) await bumpOutbound(tn.id);
    else await bumpLite(uid);
  });
}
