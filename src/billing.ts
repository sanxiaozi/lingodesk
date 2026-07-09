/**
 * 计费:Telegram Stars 月订阅(唯一支持 30 天周期,自动续费)。
 * 收款集中在官方门户 bot —— 用户在 @LingoDeskbot 私聊里订阅,Stars 进平台账户,
 * 付款成功后按 owner user.id 关联到其租户,置 plan=pro。
 *
 * 注:sendInvoice 直接走 Bot API(当前 grammy 版本的类型未含 subscription_period),最可控。
 */
import type { Context } from "grammy";
import { config } from "./config.js";
import { getTenant, setPlanPro } from "./db.js";

export const PRO_PAYLOAD = "lingodesk_pro_monthly";
const PERIOD = 2592000; // 30 天(秒),Telegram 订阅唯一允许的周期

/** 给某人发 Pro 月订阅发票(Telegram Stars,自动续订) */
export async function sendProInvoice(token: string, chatId: number): Promise<void> {
  const r = await fetch(`https://api.telegram.org/bot${token}/sendInvoice`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      title: "LingoDesk Pro",
      description: "无限翻译额度 + 无限联系人 + 优先支持。每月自动续费,可随时取消。",
      payload: PRO_PAYLOAD,
      currency: "XTR", // Telegram Stars
      prices: [{ label: "LingoDesk Pro / 月", amount: config.priceStars }],
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
  const t = await getTenant(uid);
  // 用 Telegram 给的订阅到期时间;缺则按 30 天
  const until = sp.subscription_expiration_date
    ? new Date(sp.subscription_expiration_date * 1000)
    : new Date(Date.now() + PERIOD * 1000);
  const isRenewal = sp.is_recurring === true && sp.is_first_recurring !== true;
  if (t) {
    await setPlanPro(uid, until, sp.telegram_payment_charge_id);
    console.log(`💫 ${isRenewal ? "续费" : "订阅"} Pro:${uid} @${t.botUsername} → ${until.toISOString().slice(0, 10)}`);
  }
  await ctx.reply(
    !t
      ? "收到付款,但还没找到你的租户档案 🤔 先发 bot token 开通;如需帮助发 /paysupport。"
      : isRenewal
        ? "✅ LingoDesk Pro 已自动续费,谢谢支持!"
        : "🎉 已升级 LingoDesk Pro!翻译额度解锁为无限,每月自动续费。想取消随时在 Telegram 的 设置 → 我的星星(My Stars)里操作。",
  );
}

export const PAYSUPPORT_TEXT = [
  "💬 LingoDesk Pro · 支付支持",
  "",
  "· 查看 / 取消订阅:Telegram → 设置 → 我的星星(My Stars)→ 找到 LingoDesk 订阅,可随时取消(用到当前周期结束不再续费)。",
  "· 退款、扣费异常或其它问题:邮件 hello@lingodesk.org,附上你的 @用户名,我们尽快处理。",
  "· 发 /status 查看你当前套餐与本月用量。",
].join("\n");
