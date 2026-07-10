/**
 * 官网 i18n 静态构建(零依赖)。
 * 源:web/templates/*.html(占位化骨架) + web/i18n/<lang>.json(文案字典) + web/assets/*。
 * 产物:site/<lang>/...(en 输出到 site/ 根)。改一处文案 → 全 15 语言重建。
 *
 * 占位协议(模板里):
 *   {{lang}} {{htmlLang}} {{dir}} {{base}}   —— 语言/方向/内链前缀(en 为空,其它 /<code>)
 *   {{hreflang}} {{langSwitcher}} {{autoRedirect}}  —— 构建时生成的块
 *   {{some.key}}                              —— 文案,查当前语言字典,缺失回退 en
 * 用法:node scripts/build-site.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "web");
const OUT = join(ROOT, "site");
const BASE_URL = "https://lingodesk.org";

// 15 界面语言。label = 切换器里的自称;html = <html lang>;dir = 文字方向
const LANGS = [
  { code: "en", label: "English", html: "en", dir: "ltr" },
  { code: "zh", label: "简体中文", html: "zh-CN", dir: "ltr" },
  { code: "zh-tw", label: "繁體中文", html: "zh-Hant", dir: "ltr" },
  { code: "es", label: "Español", html: "es", dir: "ltr" },
  { code: "pt", label: "Português", html: "pt", dir: "ltr" },
  { code: "ru", label: "Русский", html: "ru", dir: "ltr" },
  { code: "fr", label: "Français", html: "fr", dir: "ltr" },
  { code: "id", label: "Bahasa Indonesia", html: "id", dir: "ltr" },
  { code: "vi", label: "Tiếng Việt", html: "vi", dir: "ltr" },
  { code: "th", label: "ไทย", html: "th", dir: "ltr" },
  { code: "tr", label: "Türkçe", html: "tr", dir: "ltr" },
  { code: "hi", label: "हिन्दी", html: "hi", dir: "ltr" },
  { code: "bn", label: "বাংলা", html: "bn", dir: "ltr" },
  { code: "ar", label: "العربية", html: "ar", dir: "rtl" },
  { code: "ur", label: "اردو", html: "ur", dir: "rtl" },
];

// 页面:模板名 → 输出路径(相对语言根)+ 逻辑 path(切换器/hreflang/跳转用)
const PAGES = [
  { tmpl: "index", out: "index.html", path: "/" },
  { tmpl: "setup", out: "setup/index.html", path: "/setup/" },
  { tmpl: "about", out: "about/index.html", path: "/about/" },
];

const langBase = (code) => (code === "en" ? "" : `/${code}`);
const pageUrl = (code, page) => `${langBase(code)}${page.path}`;

function hreflangBlock(page) {
  const tags = LANGS.map((l) => `<link rel="alternate" hreflang="${l.html}" href="${BASE_URL}${pageUrl(l.code, page)}">`);
  tags.push(`<link rel="alternate" hreflang="x-default" href="${BASE_URL}${pageUrl("en", page)}">`);
  return tags.join("\n");
}

function langSwitcherBlock(curCode, page) {
  const cur = LANGS.find((l) => l.code === curCode);
  const items = LANGS.map((l) => {
    const on = l.code === curCode ? ' class="on"' : "";
    return `<a href="${pageUrl(l.code, page)}"${on} onclick="localStorage.setItem('ld-lang','${l.code}')">${l.label}</a>`;
  }).join("");
  return `<details class="lang-dd"><summary>🌐 ${cur.label}</summary><div class="lang-menu">${items}</div></details>`;
}

function autoRedirectBlock(page) {
  const codes = LANGS.map((l) => l.code);
  return `<script>
(function(){try{
  var CODES=${JSON.stringify(codes)},PATH=${JSON.stringify(page.path)};
  var cur=document.documentElement.getAttribute("data-lang");
  function go(c){var b=c==="en"?"":"/"+c;location.replace(b+PATH);}
  var pref=localStorage.getItem("ld-lang");
  if(pref){ if(pref!==cur && CODES.indexOf(pref)>=0) go(pref); return; }
  var n=(navigator.language||"").toLowerCase(),pick="";
  if(n.indexOf("zh")===0){pick=/tw|hk|mo|hant/.test(n)?"zh-tw":"zh";}
  else{var two=n.slice(0,2); if(CODES.indexOf(two)>=0)pick=two;}
  if(pick&&pick!==cur) go(pick);
}catch(e){}})();
</script>`;
}

// 加载字典(当前语言覆盖英文兜底)
function loadDict(code) {
  const en = JSON.parse(readFileSync(join(WEB, "i18n", "en.json"), "utf8"));
  const p = join(WEB, "i18n", `${code}.json`);
  const d = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  return { ...en, ...d };
}

const missing = new Set();
function render(tmpl, lang, page, dict) {
  let html = tmpl
    .replaceAll("{{htmlLang}}", lang.html)
    .replaceAll("{{dir}}", lang.dir)
    .replaceAll("{{lang}}", lang.code)
    .replaceAll("{{base}}", langBase(lang.code))
    .replace("{{hreflang}}", hreflangBlock(page))
    .replace("{{langSwitcher}}", langSwitcherBlock(lang.code, page))
    .replace("{{autoRedirect}}", autoRedirectBlock(page));
  // 文案 key
  html = html.replace(/\{\{([\w.-]+)\}\}/g, (m, key) => {
    if (key in dict) return dict[key];
    missing.add(`${lang.code}:${key}`);
    return dict[key] ?? `«${key}»`;
  });
  return html;
}

function copyDir(src, dst) {
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src)) {
    const s = join(src, f);
    const d = join(dst, f);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

// ── 构建 ──
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const templates = {};
for (const p of PAGES) {
  const f = join(WEB, "templates", `${p.tmpl}.html`);
  if (existsSync(f)) templates[p.tmpl] = readFileSync(f, "utf8");
  else console.warn(`⏭️  跳过缺失模板:${p.tmpl}.html`);
}

let count = 0;
for (const lang of LANGS) {
  const dict = loadDict(lang.code);
  for (const page of PAGES) {
    if (!templates[page.tmpl]) continue;
    const outPath = join(OUT, langBase(lang.code).replace(/^\//, ""), page.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, render(templates[page.tmpl], lang, page, dict));
    count++;
  }
}

// 静态资源:style.css + web/assets/*
copyFileSync(join(WEB, "style.css"), join(OUT, "style.css"));
copyDir(join(WEB, "assets"), OUT);

console.log(`✅ 构建完成:${count} 个页面(${LANGS.length} 语言 × ${PAGES.length} 页)`);
if (missing.size) {
  console.warn(`⚠️ 缺失文案 ${missing.size} 条(已回退英文/占位):`);
  console.warn([...missing].slice(0, 40).join("\n"));
}
