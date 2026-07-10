/**
 * Bot 界面 i18n。英语是兜底语言(fallback = en),不是中文。
 * 字典 src/i18n/<lang>.json;缺 key 回退 en,再回退 key 本身。
 *
 * 语言选择:
 *   门户(私聊)——已开通租户用 tenant.nativeLang;未开通用 Telegram 客户端 language_code;兜底 en。
 *   中继(控制台)——用 tenant.nativeLang(控制台是给租户看的);兜底 en。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "i18n");
export const FALLBACK = "en";

// bot 界面已本地化的语言(缺失 key 自动回退 en)。
// 繁体中文(zh-hant/zh-tw)由 resolveUiLang 归并到 zh;ar/ur 为 RTL。
export const SUPPORTED = ["en", "zh", "es", "pt", "ru", "fr", "id", "vi", "th", "tr", "hi", "bn", "ar", "ur"];

const DICTS: Record<string, Record<string, string>> = {};
for (const code of SUPPORTED) {
  try {
    DICTS[code] = JSON.parse(readFileSync(join(DIR, `${code}.json`), "utf8"));
  } catch {
    DICTS[code] = {};
  }
}

/** 把 nativeLang / Telegram language_code 归一到已支持的界面语言,否则英语兜底 */
export function resolveUiLang(code?: string | null): string {
  if (!code) return FALLBACK;
  const c = code.toLowerCase();
  if (c.startsWith("zh")) return "zh";
  const two = c.slice(0, 2);
  return SUPPORTED.includes(two) ? two : FALLBACK;
}

/** 取文案。lang 缺失该 key 时回退英文,再回退 key 本身。vars 用 {name} 占位插值。 */
export function t(key: string, lang?: string | null, vars?: Record<string, string | number>): string {
  const code = resolveUiLang(lang);
  let s = DICTS[code]?.[key] ?? DICTS[FALLBACK]?.[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}
