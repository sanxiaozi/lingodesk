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
  setPlanPro,
  setPlanFree,
  logEvent,
} from "./db.js";
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
      const tn = await getTenant(uid);
      if (!tn) {
        await ctx.reply(t("portal.subscribe_not_activated", lang));
        return;
      }
      if (tn.plan === "pro") {
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

    if (text === "/start" || text === "/help") {
      await ctx.reply(t("portal.welcome", lang), { link_preview_options: { is_disabled: true } });
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
      const connVal = tn.connId ? "✅" : t("portal.status_conn_off", lang);
      const replyVal = tn.canReply ? "✅" : t("portal.status_reply_off", lang);
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

    if (text.startsWith("/native")) {
      const code = (text.split(/\s+/)[1] ?? "").toLowerCase();
      if (!/^[a-z]{2,3}$/.test(code)) {
        await ctx.reply(t("portal.native_usage", lang));
        return;
      }
      const tn = await getTenant(uid);
      if (!tn) {
        await ctx.reply(t("portal.not_activated_short", lang));
        return;
      }
      await setTenantNativeLang(uid, code);
      await ctx.reply(t("portal.native_set", lang, { lang: code }));
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
      const prefix = me.canBusiness ? "" : t("portal.business_mode_fix", lang) + "\n\n";
      await ctx.reply(prefix + t("portal.activated", lang, { bot: me.username }), {
        link_preview_options: { is_disabled: true },
      });
      console.log(`🎫 新租户开通:${uid}(@${ctx.from.username ?? "?"})→ bot @${me.username}`);
      return;
    }

    // 兜底引导
    await ctx.reply(
      config.billingEnabled
        ? t("portal.fallback_billing", lang)
        : t("portal.fallback_nobilling", lang),
    );
  });

  // 订阅支付:预检查(须 10 秒内应答 true,否则不扣款)
  bot.on("pre_checkout_query", async (ctx) => {
    await ctx.answerPreCheckoutQuery(true).catch((e) => console.error("pre_checkout 应答失败:", e));
  });

  // 订阅支付:成功(首购 + 每月自动续费都到这里)
  bot.on("message:successful_payment", (ctx) => handleSuccessfulPayment(ctx));
}
