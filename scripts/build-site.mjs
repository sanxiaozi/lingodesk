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

// 15 界面语言。label = 切换器里的自称;html = <html lang>;dir = 文字方向;og = og:locale(ll_CC)
const ALL_LANGS = [
  { code: "en", label: "English", html: "en", dir: "ltr", og: "en_US" },
  { code: "zh", label: "简体中文", html: "zh-CN", dir: "ltr", og: "zh_CN" },
  { code: "zh-tw", label: "繁體中文", html: "zh-Hant", dir: "ltr", og: "zh_TW" },
  { code: "es", label: "Español", html: "es", dir: "ltr", og: "es_ES" },
  { code: "pt", label: "Português", html: "pt", dir: "ltr", og: "pt_BR" },
  { code: "ru", label: "Русский", html: "ru", dir: "ltr", og: "ru_RU" },
  { code: "fr", label: "Français", html: "fr", dir: "ltr", og: "fr_FR" },
  { code: "id", label: "Bahasa Indonesia", html: "id", dir: "ltr", og: "id_ID" },
  { code: "vi", label: "Tiếng Việt", html: "vi", dir: "ltr", og: "vi_VN" },
  { code: "th", label: "ไทย", html: "th", dir: "ltr", og: "th_TH" },
  { code: "tr", label: "Türkçe", html: "tr", dir: "ltr", og: "tr_TR" },
  { code: "hi", label: "हिन्दी", html: "hi", dir: "ltr", og: "hi_IN" },
  { code: "bn", label: "বাংলা", html: "bn", dir: "ltr", og: "bn_BD" },
  { code: "ar", label: "العربية", html: "ar", dir: "rtl", og: "ar_AR" },
  { code: "ur", label: "اردو", html: "ur", dir: "rtl", og: "ur_PK" },
];

// 只生成有字典文件的语言(现成 en/zh/zh-tw;P2 加 web/i18n/es.json 等即自动纳入,下拉/hreflang 随之扩展)
const LANGS = ALL_LANGS.filter((l) => existsSync(join(WEB, "i18n", `${l.code}.json`)));

// 页面:模板名 → 输出路径(相对语言根)+ 逻辑 path(切换器/hreflang/跳转用)
const PAGES = [
  { tmpl: "index", out: "index.html", path: "/" },
  { tmpl: "setup", out: "setup/index.html", path: "/setup/" },
  { tmpl: "about", out: "about/index.html", path: "/about/" },
  { tmpl: "changelog", out: "changelog/index.html", path: "/changelog/" },
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

// ── SEO:canonical + OG/Twitter + JSON-LD 结构化数据(构建时按页/语言生成) ──
const stripHtml = (s) => (s ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
// JSON 内嵌 <script> 的安全序列化(防 </script> 提前闭合)
const jsonForScript = (o) => JSON.stringify(o).replaceAll("<", "\\u003c");

function jsonldBlocks(lang, page, dict) {
  const blocks = [];
  if (page.tmpl === "index") {
    blocks.push({
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "LingoDesk",
      url: BASE_URL,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Telegram",
      description: stripHtml(dict["index.desc"]),
      inLanguage: lang.html,
      offers: [
        { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD" },
        { "@type": "Offer", name: "Pro", price: "7", priceCurrency: "USD", description: "500 Telegram Stars / month, unlimited translations" },
      ],
    });
    blocks.push({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "LingoDesk",
      url: BASE_URL,
      logo: `${BASE_URL}/og.png`,
      email: "hello@lingodesk.org",
      sameAs: ["https://github.com/sanxiaozi/lingodesk", "https://t.me/LingoDeskbot"],
    });
  }
  if (page.tmpl === "setup") {
    // FAQ 结构化数据:直接取当前语言字典里的 faq_q/a 对(本地化的富摘要)
    const qa = [];
    for (let i = 1; i <= 30; i++) {
      const q = dict[`setup.faq_q${i}`];
      const a = dict[`setup.faq_a${i}`];
      if (q && a) qa.push({ "@type": "Question", name: stripHtml(q), acceptedAnswer: { "@type": "Answer", text: stripHtml(a) } });
    }
    if (qa.length) blocks.push({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: qa });
  }
  return blocks.map((b) => `<script type="application/ld+json">${jsonForScript(b)}</script>`).join("\n");
}

function seoHeadBlock(lang, page, dict) {
  const url = `${BASE_URL}${pageUrl(lang.code, page)}`;
  const title = dict[`${page.tmpl}.og_title`] ?? dict[`${page.tmpl}.title`] ?? "LingoDesk";
  const desc = dict[`${page.tmpl}.og_desc`] ?? dict[`${page.tmpl}.desc`] ?? "";
  const img = `${BASE_URL}/og.png`;
  const lines = [
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="LingoDesk">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${desc}">`,
    `<meta property="og:image" content="${img}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:locale" content="${lang.og}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:image" content="${img}">`,
  ];
  const ld = jsonldBlocks(lang, page, dict);
  if (ld) lines.push(ld);
  return lines.join("\n");
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
    .replace("{{seoHead}}", seoHeadBlock(lang, page, dict))
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

// sitemap.xml(每个 URL 带全语言 hreflang alternates,利于多语言 SEO)+ robots.txt
function altLinks(page) {
  const links = LANGS.map((l) => `    <xhtml:link rel="alternate" hreflang="${l.html}" href="${BASE_URL}${pageUrl(l.code, page)}"/>`);
  links.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${pageUrl("en", page)}"/>`);
  return links.join("\n");
}
const urlEntries = [];
for (const lang of LANGS)
  for (const page of PAGES) {
    if (!templates[page.tmpl]) continue;
    urlEntries.push(`  <url>\n    <loc>${BASE_URL}${pageUrl(lang.code, page)}</loc>\n${altLinks(page)}\n  </url>`);
  }
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urlEntries.join("\n")}\n</urlset>\n`;
writeFileSync(join(OUT, "sitemap.xml"), sitemap);
writeFileSync(join(OUT, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${BASE_URL}/sitemap.xml\n`);

// 404.html:Cloudflare Pages 有此文件才返回真 404(否则 SPA 回退首页 = 软 404,搜索引擎会索引垃圾 URL)
writeFileSync(
  join(OUT, "404.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>404 · LingoDesk</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div class="wrap" style="text-align:center;padding-top:18vh">
  <h1 style="font-size:64px;margin-bottom:8px">404</h1>
  <p style="color:#aab3c8;margin-bottom:28px">This page doesn't exist — but the conversation can still start.</p>
  <a class="btn" href="/">← LingoDesk home</a>
</div>
</body>
</html>
`,
);

// _redirects:www 收敛到裸域(否则 www 直接 200 = 全站重复内容)
writeFileSync(join(OUT, "_redirects"), `https://www.lingodesk.org/* ${BASE_URL}/:splat 301\n`);

console.log(`✅ 构建完成:${count} 个页面(${LANGS.length} 语言 × ${PAGES.length} 页)+ sitemap.xml(${urlEntries.length} URL)+ robots.txt`);
if (missing.size) {
  console.warn(`⚠️ 缺失文案 ${missing.size} 条(已回退英文/占位):`);
  console.warn([...missing].slice(0, 40).join("\n"));
}
