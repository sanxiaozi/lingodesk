/**
 * 计费:Telegram Stars 月订阅(唯一支持 30 天周期,自动续费)。
 * 收款集中在官方门户 bot —— 用户在 @LingoDeskbot 私聊里订阅,Stars 进平台账户,
 * 付款成功后按 owner user.id 关联到其租户,置 plan=pro。
 *
 * 注:sendInvoice 直接走 Bot API(当前 grammy 版本的类型未含 subscription_period),最可控。
 */
import type { Context } from "grammy";
import { config } from "./config.js";
import { t, resolveUiLang } from "./i18n.js";
import { getTenant, setPlanPro, setLitePlanPro } from "./db.js";

export const PRO_PAYLOAD = "lingodesk_pro_monthly";
const PERIOD = 2592000; // 30 天(秒),Telegram 订阅唯一允许的周期

/** 给某人发 Pro 月订阅发票(Telegram Stars,自动续订) */
export async function sendProInvoice(token: string, chatId: number, lang?: string | null): Promise<void> {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendInvoice`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      title: t("billing.invoice_title", lang),
      description: t("billing.invoice_desc", lang),
      payload: PRO_PAYLOAD,
      currency: "XTR", // Telegram Stars
      prices: [{ label: t("billing.invoice_price_label", lang), amount: config.priceStars }],
      subscription_period: PERIOD,
    }),
  });
  const j = (await r.json()) as { ok: boolean; description?: string };
  if (!j.ok) throw new Error(`sendInvoice 失败:${j.description ?? "未知"}`);
}

interface StarPayment {
  invoice_payload: string;
  telegram_payment_charge_id: string;
  subscription_expiration_date?: number;
  is_recurring?: boolean;
  is_first_recurring?: boolean;
}

/** 处理支付成功:置租户 Pro(首购与自动续费都走这里) */
export async function handleSuccessfulPayment(ctx: Context): Promise<void> {
  const sp = ctx.message?.successful_payment as StarPayment | undefined;
  if (!sp || sp.invoice_payload !== PRO_PAYLOAD || !ctx.from) return;
  const uid = String(ctx.from.id);
  const tenant = await getTenant(uid);
  const lang = tenant?.nativeLang || resolveUiLang(ctx.from?.language_code);
  // 用 Telegram 给的订阅到期时间;缺则按 30 天
  const until = sp.subscription_expiration_date
    ? new Date(sp.subscription_expiration_date * 1000)
    : new Date(Date.now() + PERIOD * 1000);
  const isRenewal = sp.is_recurring === true && sp.is_first_recurring !== true;
  if (tenant) {
    await setPlanPro(uid, until, sp.telegram_payment_charge_id);
    console.log(`💫 ${isRenewal ? "续费" : "订阅"} Pro:${uid} @${tenant.botUsername} → ${until.toISOString().slice(0, 10)}`);
  } else {
    // 无租户的轻量用户(内联/私聊翻译)也能直接订 Pro
    await setLitePlanPro(uid, until, sp.telegram_payment_charge_id);
    console.log(`💫 ${isRenewal ? "续费" : "订阅"} Lite Pro:${uid} → ${until.toISOString().slice(0, 10)}`);
  }
  await ctx.reply(isRenewal ? t("billing.pay_renewed", lang) : t("billing.pay_upgraded", lang));
}

/** 支付支持文案(给某语言的租户看) */
export function paySupportText(lang?: string | null): string {
  return t("billing.paysupport", lang);
}
