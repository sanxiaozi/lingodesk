/**
 * 开通门户:官方 bot 的私聊侧 —— 用户自助提交自己的 bot token,分钟级开通。
 * 挂载顺序:在中继 handler 之后(中继不匹配的私聊消息会 next() 流到这里)。
 *
 * 用户命令:/start 引导;发 token = 开通/换 token;/status 状态;/native <码> 母语;/enable 恢复
 * 管理命令(仅 ADMIN_USER_ID):/tenants 列表;/disable <id>;/enable <id>
 */
import type { Bot } from "grammy";
import { config } from "./config.js";
import { encrypt } from "./crypto.js";
import {
  getTenant,
  getTenantByBotId,
  getAllTenants,
  upsertTenant,
  setTenantStatus,
  setTenantNativeLang,
  tenantUsage,
} from "./db.js";
import { startTenant, stopTenant, isRunning, getRunningCount } from "./manager.js";

const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

const WELCOME = [
  "👋 欢迎使用 LingoDesk —— 在 Telegram 上用母语和全世界聊天。",
  "",
  "开通只要三步(详细图文:lingodesk.org/setup/):",
  "1️⃣ 在 @BotFather 创建你自己的 bot(/newbot),并在 Bot Settings 里开启 Business Mode、关闭 Group Privacy",
  "2️⃣ 把拿到的 token(形如 123456:ABC...)直接发给我,我立刻为你开通",
  "3️⃣ 按回复里的指引绑定 Telegram Business、建控制台群发 /bind",
  "",
  "Send me your bot token from @BotFather to activate. Full guide: lingodesk.org/setup/",
  "",
  "其它命令:/status 查看状态 · /native <语种码> 设置你的母语(默认中文)",
].join("\n");

/** 调 getMe 校验 token,返回 bot 身份或 null */
async function validateToken(token: string): Promise<{ id: string; username: string } | null> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const j = (await r.json()) as { ok: boolean; result?: { id: number; username?: string } };
    if (!j.ok || !j.result) return null;
    return { id: String(j.result.id), username: j.result.username ?? "" };
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

    // ── 管理命令 ──────────────────────────────────────────────────────
    if (isAdmin && (text === "/tenants" || text.startsWith("/disable ") || (text.startsWith("/enable ") && text.split(/\s+/)[1]))) {
      const [cmd, arg] = text.split(/\s+/);
      if (cmd === "/tenants") {
        const list = await getAllTenants();
        if (!list.length) {
          await ctx.reply("(还没有租户)");
          return;
        }
        const lines = await Promise.all(
          list.map(async (t) => {
            const u = await tenantUsage(t.id);
            const run = isRunning(t.id) ? "🟢" : "⚪";
            return `${run} ${t.id} @${t.botUsername} [${t.status}${t.statusNote ? `:${t.statusNote}` : ""}] 客户${u.contacts} 收${u.inMsgs}/发${u.outMsgs} 群${t.forumChatId ? "✓" : "✗"}`;
          }),
        );
        await ctx.reply(`租户 ${list.length} 个,实例在跑 ${getRunningCount()} 个:\n${lines.join("\n")}`);
      } else if (cmd === "/disable") {
        const t = await getTenant(arg!);
        if (!t) {
          await ctx.reply("没有这个租户 id。");
          return;
        }
        await setTenantStatus(t.id, "disabled", "管理员手动停用");
        await stopTenant(t.id);
        await ctx.reply(`⛔ 已停用 ${t.id} @${t.botUsername}`);
      } else {
        const t = await getTenant(arg!);
        if (!t) {
          await ctx.reply("没有这个租户 id。");
          return;
        }
        await setTenantStatus(t.id, "active");
        await startTenant({ ...t, status: "active" });
        await ctx.reply(`▶️ 已恢复 ${t.id} @${t.botUsername}`);
      }
      return;
    }

    // ── 用户命令 ──────────────────────────────────────────────────────
    if (text === "/start" || text === "/help") {
      await ctx.reply(WELCOME, { link_preview_options: { is_disabled: true } });
      return;
    }

    if (text === "/status") {
      const t = await getTenant(uid);
      if (!t) {
        await ctx.reply("你还没开通。把你在 @BotFather 拿到的 bot token 发给我即可,发 /start 看引导。");
        return;
      }
      const u = await tenantUsage(t.id);
      await ctx.reply(
        [
          `🤖 你的 bot:@${t.botUsername}`,
          `状态:${t.status === "active" ? (isRunning(t.id) ? "🟢 运行中" : "🟡 启动中") : `⛔ 已停用(${t.statusNote})`}`,
          `Business 连接:${t.connId ? "✅" : "❌ 去 Telegram Business → Chatbots 绑定你的 bot"}`,
          `控制台群:${t.forumChatId ? "✅ 已绑定" : "❌ 建群拉入你的 bot,群里发 /bind"}`,
          `母语:${t.nativeLang}(/native <码> 可改)`,
          `用量:客户 ${u.contacts} · 收 ${u.inMsgs} 条 · 发 ${u.outMsgs} 条`,
        ].join("\n"),
      );
      return;
    }

    if (text.startsWith("/native")) {
      const code = (text.split(/\s+/)[1] ?? "").toLowerCase();
      if (!/^[a-z]{2,3}$/.test(code)) {
        await ctx.reply("用法:/native <ISO639-1 语种码>,例如 /native zh(中文)、/native en(英语)。客户消息将译成这个语言。");
        return;
      }
      const t = await getTenant(uid);
      if (!t) {
        await ctx.reply("你还没开通,先把 bot token 发给我。");
        return;
      }
      await setTenantNativeLang(uid, code);
      await ctx.reply(`✅ 母语已设为 ${code},之后客户消息都译成它。`);
      return;
    }

    if (text === "/enable") {
      const t = await getTenant(uid);
      if (!t) {
        await ctx.reply("你还没开通,先把 bot token 发给我。");
        return;
      }
      await setTenantStatus(t.id, "active");
      await startTenant({ ...t, status: "active" });
      await ctx.reply("▶️ 已尝试恢复你的实例,发 /status 查看。");
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
        await ctx.reply("❌ 这个 token 校验失败(格式对但 Telegram 不认)。去 @BotFather → /mybots → API Token 重新复制一次。\n(原消息已删除)");
        return;
      }
      const clash = await getTenantByBotId(me.id);
      if (clash && clash.id !== uid) {
        await delToken;
        await ctx.reply("❌ 这个 bot 已被其他账号注册过。如果它确实是你的,先在 @BotFather 用 Revoke 重置 token 再提交新的。");
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
      await ctx.reply(
        [
          `🎉 开通成功!你的翻译中继 @${me.username} 已在云端运行。(你发的 token 消息我已删除)`,
          "",
          "接下来两步(手机上完成,图文版:lingodesk.org/setup/):",
          `1️⃣ 设置 → Telegram Business → Chatbots → 绑定 @${me.username},打开「回复消息」权限`,
          `2️⃣ 新建一个群、开启「话题(Topics)」、拉入 @${me.username} 设为管理员(勾「管理话题」),群里发 /bind`,
          "",
          "完成后让任何人用外语私聊你试一条,双语卡片就会弹进群里。/status 随时查进度。",
        ].join("\n"),
        { link_preview_options: { is_disabled: true } },
      );
      console.log(`🎫 新租户开通:${uid}(@${ctx.from.username ?? "?"})→ bot @${me.username}`);
      return;
    }

    // 兜底引导
    await ctx.reply("没看懂 🙂 发 /start 看开通引导;开通后发 /status 查看状态。");
  });
}
