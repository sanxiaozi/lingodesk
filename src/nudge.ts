/**
 * 开通卡点自动催办:定时扫描"开通了但卡在半路"的租户,按卡点私聊一条
 * 只讲下一步的消息。每个卡点终身只提醒一次(OpsEvent 去重),不骚扰。
 * 目标:自动转化卡住的新用户(日报暴露的高卡顿率),不依赖人工跟进。
 */
import type { Api } from "grammy";
import { prisma, onboardingStage, hasNudged, logEvent } from "./db.js";
import { t } from "./i18n.js";

const MIN_AGE_MS = 2 * 3600_000; // 开通满 2 小时才催,给自然完成留时间

export async function nudgeStuckTenants(api: Api): Promise<void> {
  const tenants = await prisma.tenant.findMany({ where: { status: "active" } });
  for (const tn of tenants) {
    if (Date.now() - tn.createdAt.getTime() < MIN_AGE_MS) continue;
    const stage = onboardingStage(tn);
    if (!stage) continue;
    if (await hasNudged(tn.id, stage)) continue;
    try {
      await api.sendMessage(Number(tn.id), t(`portal.nudge_${stage}`, tn.nativeLang, { ownbot: tn.botUsername }));
      logEvent(tn.id, "onboarding_nudge", stage, tn.username || tn.name);
      console.log(`📣 已催办 ${tn.id} @${tn.botUsername}(卡点:${stage})`);
    } catch (e) {
      // 用户没和门户 bot 说过话时无法私聊 —— 静默跳过(开通必经门户,理论上不会发生)
      console.error(`催办 ${tn.id} 失败:`, e instanceof Error ? e.message : e);
    }
  }
}
