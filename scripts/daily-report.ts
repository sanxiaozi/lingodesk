/**
 * 每日运营日报 —— 统计昨日(北京时间)数据 + Claude 一句话点评,经官方门户 bot 推送给管理员。
 * 服务器 cron 触发(UTC 01:00 = 北京 09:00):
 *   0 1 * * * cd /root/lingodesk && ./node_modules/.bin/tsx scripts/daily-report.ts >> /var/log/lingodesk-report.log 2>&1
 * 本地试跑:npm run report:daily
 * 设计:AI 点评失败不影响推送(降级为纯指标);推送失败退出码 1 便于 cron 告警。
 */
import { PrismaClient } from "@prisma/client";
import { config } from "../src/config.js";
import { complete } from "../src/ai/_client.js";

const prisma = new PrismaClient();

// ── 北京时间日界(服务器是 UTC,所有"昨日"按北京时间算) ──
const CN_OFFSET = 8 * 3600_000;
const nowCn = new Date(Date.now() + CN_OFFSET);
const todayCn0 = new Date(Date.UTC(nowCn.getUTCFullYear(), nowCn.getUTCMonth(), nowCn.getUTCDate()) - CN_OFFSET);
const d1 = new Date(todayCn0.getTime() - 86400_000); // 昨日 00:00(北京)
const d2 = new Date(todayCn0.getTime() - 2 * 86400_000); // 前日 00:00(北京)
const dateLabel = new Date(d1.getTime() + CN_OFFSET).toISOString().slice(0, 10);
const weekday = "日一二三四五六"[new Date(d1.getTime() + CN_OFFSET).getUTCDay()];

/** 统计某时段消息量(经 contact 关联到租户) */
async function msgStats(gte: Date, lt: Date) {
  const rows = await prisma.message.findMany({
    where: { createdAt: { gte, lt } },
    select: { direction: true, contact: { select: { tenantId: true, name: true } } },
  });
  const io = { in: 0, out: 0 };
  const byTenant = new Map<string, { in: number; out: number }>();
  for (const r of rows) {
    const key = r.direction === "in" ? "in" : "out"; // out + manual 都算"发"
    io[key]++;
    const t = byTenant.get(r.contact.tenantId) ?? { in: 0, out: 0 };
    t[key]++;
    byTenant.set(r.contact.tenantId, t);
  }
  return { io, byTenant };
}

async function main() {
  if (!config.adminUserId) throw new Error("未配置 ADMIN_USER_ID,无推送目标");

  const [tenants, yesterday, dayBefore, newContacts, events] = await Promise.all([
    prisma.tenant.findMany({
      select: {
        id: true, botUsername: true, name: true, username: true, status: true, statusNote: true,
        plan: true, proUntil: true, usageMonth: true, usageCount: true, createdAt: true,
        connId: true, canReply: true, forumChatId: true,
      },
    }),
    msgStats(d1, todayCn0),
    msgStats(d2, d1),
    prisma.contact.count({ where: { createdAt: { gte: d1, lt: todayCn0 } } }),
    prisma.opsEvent.findMany({ where: { createdAt: { gte: d1, lt: todayCn0 } }, orderBy: { createdAt: "asc" } }),
  ]);
  const [liteTotal, liteNew] = await Promise.all([
    prisma.liteUser.count(),
    prisma.liteUser.count({ where: { createdAt: { gte: d1, lt: todayCn0 } } }),
  ]);

  const active = tenants.filter((t) => t.status === "active");
  const disabled = tenants.filter((t) => t.status !== "active");
  const newTenants = tenants.filter((t) => t.createdAt >= d1 && t.createdAt < todayCn0);
  const pro = tenants.filter((t) => t.plan === "pro");
  const curMonth = new Date(nowCn).toISOString().slice(0, 7);
  // 免费额度预警(≥80% = 转化线索);Pro 3 天内到期 = 续费观察
  const quotaWarn = tenants.filter(
    (t) => t.plan === "free" && t.usageMonth === curMonth && t.usageCount >= config.freeQuota * 0.8,
  );
  const proExpiring = pro.filter(
    (t) => t.proUntil && t.proUntil.getTime() - Date.now() < 3 * 86400_000,
  );

  const tname = (t: { name: string; username: string; botUsername: string }) =>
    t.name || (t.username && `@${t.username}`) || `@${t.botUsername}`;

  // 昨日活跃租户排行(按消息量)
  const ranking = [...yesterday.byTenant.entries()]
    .map(([id, v]) => ({ t: tenants.find((x) => x.id === id), ...v }))
    .filter((r) => r.t)
    .sort((a, b) => b.in + b.out - (a.in + a.out))
    .slice(0, 5);

  // ── 组装指标文本 ──
  const lines = [
    `📊 <b>LingoDesk 日报</b> · ${dateLabel}(周${weekday})`,
    ``,
    `👥 租户 ${tenants.length}(活跃 ${active.length}${disabled.length ? ` · 停用 ${disabled.length}` : ""})· 新开通 ${newTenants.length}${newTenants.length ? ":" + newTenants.map(tname).join("、") : ""}`,
    `💬 昨日消息:收 ${yesterday.io.in} · 发 ${yesterday.io.out}(前日 收 ${dayBefore.io.in} / 发 ${dayBefore.io.out})`,
    `🆕 新客户联系人 ${newContacts}`,
    `🆓 轻量用户(内联/私聊翻译):${liteTotal} 个(昨日新增 ${liteNew})`,
    `⭐ Pro ${pro.length} 个${proExpiring.length ? ` · ⏳ 3天内到期:${proExpiring.map(tname).join("、")}` : ""}`,
  ];
  if (quotaWarn.length)
    lines.push(`🈵 额度预警(≥80%):${quotaWarn.map((t) => `${tname(t)} ${t.usageCount}/${config.freeQuota}`).join("、")}`);
  if (disabled.length)
    lines.push(`⚠️ 停用实例:${disabled.map((t) => `@${t.botUsername}(${t.statusNote || "手动"})`).join("、")}`);
  if (ranking.length) {
    lines.push(``, `🏆 昨日活跃:`);
    for (const r of ranking) lines.push(`   ${tname(r.t!)} — 收 ${r.in} / 发 ${r.out}`);
  }

  // ── 昨日用户问题(OpsEvent 埋点:含没开通成功、根本不在租户表里的人) ──
  const EVENT_LABEL: Record<string, string> = {
    token_invalid: "提交的 bot token 无效",
    token_clash: "token 已被他人注册",
    secretary_mode_off: "Secretary Mode 未开启",
    reply_perm_missing: "未开「回复消息」权限",
    translate_fail: "翻译失败",
    send_fail: "发送给客户失败",
    engine_failover: "翻译主引擎熔断,已降级备用",
    engine_recovered: "翻译主引擎恢复",
    no_premium_activation: "无 Premium 却开通了中继(会卡在 Business 绑定,已获免费玩法指引)",
    onboarding_nudge: "系统自动催办了开通卡点",
  };
  // 同一人同一问题合并计次,保留最后一次 detail
  const probMap = new Map<string, { who: string; label: string; detail: string; n: number }>();
  for (const ev of events) {
    const who = ev.username ? `@${ev.username}` : ev.userId;
    const key = `${ev.userId}|${ev.type}`;
    const cur = probMap.get(key);
    if (cur) { cur.n++; cur.detail = ev.detail || cur.detail; }
    else probMap.set(key, { who, label: EVENT_LABEL[ev.type] ?? ev.type, detail: ev.detail, n: 1 });
  }
  const problems = [...probMap.values()];
  if (problems.length) {
    lines.push(``, `🚨 <b>昨日用户问题</b>(${events.length} 次):`);
    for (const p of problems)
      lines.push(`   ${p.who} — ${p.label}${p.detail ? `(${p.detail})` : ""}${p.n > 1 ? ` ×${p.n}` : ""}`);
  }

  // ── 新租户开通漏斗:近 14 天开通但没走完设置的,点出卡点与卡龄(优先级与自动催办一致:先建群) ──
  const stuck = tenants
    .filter((t) => t.status === "active" && Date.now() - t.createdAt.getTime() < 14 * 86400_000)
    .map((t) => {
      const stage = !t.forumChatId
        ? "还没建控制台群 /bind(两条路径都卡在这)"
        : !t.connId
          ? "控制台就绪;未绑 Business —— 无 Premium 可直接走 Bot 门面,其实已可用"
          : !t.canReply
            ? "已绑定,但没开「回复消息」权限(能收不能发)"
            : null;
      if (!stage) return null;
      const days = Math.floor((Date.now() - t.createdAt.getTime()) / 86400_000);
      return `   ${tname(t)}(@${t.botUsername})— ${stage} · 卡 ${days} 天(已自动催办)`;
    })
    .filter(Boolean) as string[];
  if (stuck.length) lines.push(``, `🧭 <b>新租户卡在设置中</b>:`, ...stuck);

  // ── AI 点评(失败降级为纯指标,不阻塞推送) ──
  try {
    const stats = {
      日期: dateLabel,
      租户: { 总数: tenants.length, 活跃: active.length, 新开通: newTenants.length, Pro: pro.length },
      消息: { 昨日: yesterday.io, 前日: dayBefore.io },
      新客户: newContacts,
      额度预警: quotaWarn.map((t) => ({ 租户: tname(t), 用量: `${t.usageCount}/${config.freeQuota}` })),
      Pro即将到期: proExpiring.map(tname),
      停用: disabled.map((t) => ({ bot: t.botUsername, 原因: t.statusNote })),
      昨日用户问题: problems.map((p) => `${p.who}:${p.label}${p.detail ? `(${p.detail})` : ""}${p.n > 1 ? ` ×${p.n}` : ""}`),
      新租户卡在设置中: stuck.map((s) => s.trim()),
      轻量用户: { 总数: liteTotal, 昨日新增: liteNew },
    };
    const comment = await complete(
      "你是 LingoDesk(Telegram 翻译中继 SaaS)的运营分析师。基于日报数据,用简体中文给创始人 2-3 句最值得注意的观察和行动建议。直接说重点,不要客套、不要重复罗列数据本身。",
      JSON.stringify(stats),
      300,
    );
    if (comment) lines.push(``, `🤖 <b>点评</b>:${comment}`);
  } catch (e) {
    console.error("AI 点评失败(已降级纯指标):", e instanceof Error ? e.message : e);
  }

  // ── 经官方门户 bot 推送给管理员 ──
  const resp = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: config.adminUserId, text: lines.join("\n"), parse_mode: "HTML" }),
  });
  const body = (await resp.json()) as { ok: boolean; description?: string };
  if (!body.ok) throw new Error(`推送失败:${body.description}`);
  console.log(`✅ 日报已推送(${dateLabel})`);
}

main()
  .catch((e) => {
    console.error("❌ 日报失败:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
