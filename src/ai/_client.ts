/**
 * AI 客户端:三级翻译引擎链 Claude Haiku(主)→ OpenAI → DeepSeek,带熔断与降级告警。
 *
 * 可靠性分层:
 *   · 瞬时抖动 —— Anthropic SDK 自带重试(429/5xx 指数回退 2 次),到这里的失败都是"真失败"。
 *   · 持续故障 —— 熔断器:某引擎连续 TRIP_AFTER 次失败即熔断 COOLDOWN_MS,
 *     期间请求直接走下一级(不再白等超时);到点放行一条探测,成功即恢复。
 *   · 可见性 —— 主引擎跌出/恢复时经门户 bot 私聊管理员(main.ts 注入)+ 记 OpsEvent(进日报)。
 * 未配置 key 的引擎自动跳过;全链不可用才抛错(调用方按"翻译失败"兜底,原文落档)。
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "../config.js";
import { logEvent } from "../db.js";

export const client = new Anthropic({ apiKey: config.anthropicKey });
const openai = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey }) : null;
// DeepSeek 走 OpenAI 兼容协议,换 baseURL 即接入
const deepseek = config.deepseekKey
  ? new OpenAI({ apiKey: config.deepseekKey, baseURL: config.deepseekBaseUrl })
  : null;

/** 取响应纯文本 */
export function extractText(resp: Anthropic.Message): string {
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** 容错解析 JSON(剥离 ```json 围栏/多余文字) */
export function parseJsonLoose(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return {};
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return {};
  }
}

/** 不翻译规则(通用:URL/价格/品牌名/用户名/技术术语原样保留) */
export const NO_TRANSLATE_RULE =
  "不翻译以下内容,原样保留:URL、价格数字及货币单位、品牌名、@用户名、邮箱、技术术语、代码/命令。";

async function callClaude(system: string, user: string, maxTokens: number): Promise<string> {
  const resp = await client.messages.create({
    model: config.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  });
  return extractText(resp);
}

async function callOpenAI(system: string, user: string, maxTokens: number): Promise<string> {
  const resp = await openai!.chat.completions.create({
    model: config.openaiModel,
    max_completion_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return (resp.choices[0]?.message?.content ?? "").trim();
}

async function callDeepSeek(system: string, user: string, maxTokens: number): Promise<string> {
  const resp = await deepseek!.chat.completions.create({
    model: config.deepseekModel,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return (resp.choices[0]?.message?.content ?? "").trim();
}

// ── 熔断器 ────────────────────────────────────────────────────────────
const TRIP_AFTER = 3; // 连续失败几次后熔断
const COOLDOWN_MS = 5 * 60_000; // 熔断时长;到点放行一条探测

interface Engine {
  name: string;
  configured: () => boolean;
  call: (system: string, user: string, maxTokens: number) => Promise<string>;
  fails: number;
  openUntil: number;
}

const engines: Engine[] = [
  { name: "Claude", configured: () => true, call: callClaude, fails: 0, openUntil: 0 },
  { name: "OpenAI", configured: () => !!openai, call: callOpenAI, fails: 0, openUntil: 0 },
  { name: "DeepSeek", configured: () => !!deepseek, call: callDeepSeek, fails: 0, openUntil: 0 },
];

// 降级/恢复告警(main.ts 注入:经门户 bot 私聊管理员;未注入则仅日志)
let notifyAdmin: ((text: string) => Promise<void>) | undefined;
export function setEngineNotify(fn: (text: string) => Promise<void>): void {
  notifyAdmin = fn;
}

let claudeDownNotified = false; // 状态去重:跌出通知一次,恢复通知一次

/** 统一 AI 调用:按链尝试,熔断中的引擎跳过(冷却到点放行探测),全链失败才抛错 */
export async function complete(system: string, user: string, maxTokens = 2048): Promise<string> {
  let lastErr: unknown;
  for (const e of engines) {
    if (!e.configured()) continue;
    if (e.fails >= TRIP_AFTER && Date.now() < e.openUntil) continue; // 熔断中,直接走下一级
    try {
      const out = await e.call(system, user, maxTokens);
      e.fails = 0;
      e.openUntil = 0;
      // 主引擎状态变化告警(仅在真正熔断跌出/恢复时各通知一次,避免单次抖动刷屏)
      if (e.name !== "Claude" && engines[0]!.fails >= TRIP_AFTER && !claudeDownNotified) {
        claudeDownNotified = true;
        const msg = `⚠️ 翻译主引擎 Claude 连续失败已熔断,已自动降级到 ${e.name}。恢复后会自动切回并通知你。`;
        logEvent("system", "engine_failover", `Claude → ${e.name}`);
        console.warn(msg);
        notifyAdmin?.(msg).catch(() => {});
      } else if (e.name === "Claude" && claudeDownNotified) {
        claudeDownNotified = false;
        const msg = "✅ 翻译主引擎 Claude 已恢复,已自动切回。";
        logEvent("system", "engine_recovered", "Claude 恢复");
        console.warn(msg);
        notifyAdmin?.(msg).catch(() => {});
      }
      return out;
    } catch (err) {
      lastErr = err;
      e.fails++;
      if (e.fails >= TRIP_AFTER) e.openUntil = Date.now() + COOLDOWN_MS;
      console.error(
        `⚠️ 引擎 ${e.name} 调用失败(连续 ${e.fails} 次${e.fails >= TRIP_AFTER ? ",已熔断" : ""}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  throw new Error(
    `所有已配置的翻译引擎均不可用:${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}
