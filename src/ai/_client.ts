/**
 * AI 客户端:Claude 主 + OpenAI 兜底。翻译层统一走 complete()。
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { config } from "../config.js";

export const client = new Anthropic({ apiKey: config.anthropicKey });
const openai = config.openaiKey ? new OpenAI({ apiKey: config.openaiKey }) : null;

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
  if (!openai) throw new Error("OpenAI 未配置(OPENAI_API_KEY 为空)");
  const resp = await openai.chat.completions.create({
    model: config.openaiModel,
    max_completion_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return (resp.choices[0]?.message?.content ?? "").trim();
}

/** 统一 AI 调用:先 Claude,失败自动兜底 OpenAI(返回纯文本) */
export async function complete(system: string, user: string, maxTokens = 2048): Promise<string> {
  try {
    return await callClaude(system, user, maxTokens);
  } catch (e) {
    console.error("⚠️ Claude 调用失败,切换 OpenAI 备用:", e instanceof Error ? e.message : e);
    return await callOpenAI(system, user, maxTokens);
  }
}
