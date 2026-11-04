// Winning Ads OS · Content — hosted (Vercel) backend.
// Same content + image logic as the local app; storage is Upstash Redis + Vercel Blob, the API key lives in env vars,
// and long jobs run inside the request that starts them (the page polls /api/jobs for progress).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./store");
const ROOT = process.cwd();
let state = null, settings = null;

const TEMPLATE_VERSION = 6;
const DEFAULT_TEMPLATE = `任务：一张 {{aspect}} 的 Facebook / Instagram 静态广告。
这张的创意点子：{{twist}}
风格方向（参考，不是模板）：{{family}}
主视觉：{{visual}}
图片角色：{{image_roles}}
不要模板感：先想一个出人意料、但 1 秒看懂的视觉点子，让画面自己把 Hook 讲出来；版面、配色、字体、质感都跟着这个点子走，不要每张都是「上面大字、中间一张图、下面一条色带」。
重点词：「{{highlight}}」要全图最醒目。
手机可读：约 360px 宽的手机上，Hook、Body、Offer 都要能直接读；图上最多 5 组文字。
不要：icon 排、科技光效、机器人、渐层堆叠、小字说明书、假的客户截图或成绩。
图上只放以下文字，逐字照印，只可以改分行；「Tag:」「Hook:」「Body:」「Offer:」「CTA:」这类标签不要印出来：
"""
{{on_image}}
"""
虚构的界面或对话，标「流程示意」或「对话示意」。
交付：一张完整广告，不加上面以外的任何文字。`;

// one creative device per draft, rotated, so a batch is not 8 copies of the same layout
const CREATIVE_TWISTS = [
  "视觉比喻：用一个日常物件比喻 Hook 的意思（例如把询问画成排队的号码牌）",
  "夸张比例：把关键物件放得超大，人或场景变得很小",
  "前后对比：画面一分为二，左边乱、右边顺",
  "意外视角：俯拍桌面或微距特写，像真实拍到的一刻",
  "极简大字：几乎只有文字，用字体大小和留白制造张力，主视觉很小但很准",
  "真实场景＋道具：真实工作现场，一个道具把重点说出来",
  "拟物化：把抽象的流程做成实体物件（卡片、贴纸、标签、收据）",
  "手作拼贴：剪纸、胶带、便利贴的拼贴质感",
  "对话截图感：像手机聊天画面，但排版大胆、重点放大",
  "海报感插画：一张有态度的插画，色块大胆，像街头海报",
];

// Style families from the DESIGN ZONE (skill v2, section 4)
const FAMILIES = {
  auto: "",
  f1: "行业物件插画海报：单色深底（深紫或深咖啡），一个行业物件用手绘蚀刻插画风格，强调色亮绿或橙，最简单、冲击最大，不用真人",
  f2: "物件特写＋撕纸揭开：浅色纸面或图纸底，一只戴手套的手撕开纸面，露出橙色块写着 AI，不用真人",
  f3: "真实场景＋界面示意卡：写实照片场景，旁边一张白色圆角界面卡列 3 个短步骤，卡上标「流程示意」",
  f4: "大数字目标：明亮的浅色室内照片，中间一个超大立体数字当主视觉，旁边小标签写目标，不用真人",
  f5: "聊天对话流程：上方客户的一句问价对话气泡 → AI 回复的确认清单卡 → 整理成 Project Brief 卡，Hook 放在下方，背景是柔和室内照",
  f6: "双人对话（RAP DUO）：两位马来西亚男士在纯色背景前对峙，各一个对话框：老板的疑问 vs Adtomatic AI 的回答，中间一条黄色大结论条",
  f7: "通用多行业：浅色底＋一个象征物件（例如预约／报价／申请卡片架），「适合行业」区块清楚，不用真人",
};


const DEFAULT_SETTINGS = {
  mock: false,
  apiBase: process.env.AI_API_BASE || "https://api.openai.com/v1",
  textModel: process.env.AI_TEXT_MODEL || "gpt-6-astra",
  textEffort: "medium",
  draftModel: process.env.AI_IMAGE_MODEL || "gpt-image-2.5-flare",
  draftQuality: "low",
  finalModel: process.env.AI_IMAGE_MODEL || "gpt-image-2.5-flare",
  finalQuality: "high",
};
const DEFAULT_BRAND = { locked: false, logoUrl: "", logoPos: "右上角", aspect: "3:4" };
const apiKey = () => process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
const apiBase = () => String(settings.apiBase || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
const nextId = (p) => `${p}${(++state.seq).toString(36)}${crypto.randomBytes(2).toString("hex")}`;
const randId = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
const hasLogo = () => !!state.brand.logoUrl;

/* ---------------- prompts ---------------- */
function imageRoles(kind) {
  const logo = hasLogo() ? `品牌 Logo（brand_asset）：原样使用，不重画、不变形、不改颜色、不加字，放在${state.brand.logoPos}，适度大小、清楚可辨` : "";
  if (kind === "draft") return logo ? `附图 1 = ${logo}。` : "";
  const first = kind === "upscale" ? "附图 1 = 要升级成正式图的草稿（edit_target）" : "附图 1 = 参考广告（style_reference，不是 Master）";
  return logo ? `${first}；附图 2 = ${logo}。` : `${first}。`;
}

// Split content into labelled blocks; only on-image blocks go to the image (skill v2, section 2).
// Accepts "Hook: text" and a label alone on its own line ("主Hook" then the text below).
const LABEL_ALIASES = {
  tag: ["tag", "受众", "受众标签", "audience"],
  hook: ["hook", "主hook", "大hook", "主标题", "标题", "headline"],
  highlight: ["highlight", "重点词", "强调", "强调词"],
  body: ["body", "sub", "副标题", "业务价值", "机制", "机制说明", "说明", "value"],
  适合: ["适合", "适合行业", "industries"],
  offer: ["offer", "优惠"],
  cta: ["cta", "行动", "call to action"],
  限定: ["限定", "限定条件", "eligibility"],
  off: ["caption", "primary text", "文案", "广告文案", "note", "notes", "备注", "concept", "概念", "动机"],
};
const ON_IMAGE_KEYS = ["tag", "hook", "body", "适合", "offer", "cta", "限定"];
function labelKey(raw) {
  const k = String(raw || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (/^meat\s*\d*$/.test(k)) return "off";
  for (const [key, list] of Object.entries(LABEL_ALIASES)) if (list.includes(k)) return key;
  return "";
}
function contentBlocks(text) {
  const blocks = []; let cur = null;
  for (const raw of String(text || "").split("\n")) {
    const alone = raw.match(/^\s*([^:：\n]{1,16}?)\s*[:：]?\s*$/);
    const inline = raw.match(/^\s*([^:：\n]{1,16}?)\s*[:：]\s*(.+)$/);
    const keyAlone = alone ? labelKey(alone[1]) : "";
    const keyInline = inline ? labelKey(inline[1]) : "";
    if (keyAlone) { cur = { key: keyAlone, label: alone[1].trim(), text: "" }; blocks.push(cur); }
    else if (keyInline) { cur = { key: keyInline, label: inline[1].trim(), text: inline[2] }; blocks.push(cur); }
    else if (cur) cur.text += (cur.text ? "\n" : "") + raw;
    else { cur = { key: "", label: "", text: raw }; blocks.push(cur); }
  }
  return blocks.map((b) => ({ ...b, text: b.text.trim() })).filter((b) => b.text);
}
const LABEL_OUT = { tag: "Tag", hook: "Hook", body: "Body", 适合: "适合", offer: "Offer", cta: "CTA", 限定: "限定" };
function onImageText(row) {
  const blocks = contentBlocks(row.content);
  if (!blocks.some((b) => b.key)) return String(row.content || "").trim();
  // labelled content: only on-image blocks; unlabelled lines before the first label are concept notes, not printed
  return blocks.filter((b) => ON_IMAGE_KEYS.includes(b.key)).map((b) => `${LABEL_OUT[b.key]}: ${b.text}`).join("\n");
}
const highlightOf = (row) => (contentBlocks(row.content).find((b) => b.key === "highlight") || {}).text || "";

function buildPrompt(row, template = state.template, kind = "draft", extra = {}) {
  const B = state.brand;
  const vars = { aspect: B.aspect, logo_position: B.logoPos, image_roles: imageRoles(kind), twist: "", ...row, family: FAMILIES[row.family] || "", on_image: onImageText(row), highlight: highlightOf(row), ...extra };
  return template
    .split("\n")
    .filter((line) => {
      const keys = [...line.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]);
      return keys.every((k) => String(vars[k] ?? "").trim() !== "");
    })
    .map((line) => line.replace(/{{\s*(\w+)\s*}}/g, (_, k) => String(vars[k] ?? "")))
    .join("\n")
    .trim();
}

const VARIATION_HINTS = {
  concept: "New Creative Concept：重选表达、主视觉与构图，建立新的创意假设。参考图只当质量参考，不继承它的构图或主视觉。",
  visual: "换主视觉：同一个动机，换一个更能说明服务机制的场景、物件或界面；保留阅读层级与品牌。",
  layout: "换构图：保留主视觉元素与配色，只重新安排构图、比例与留白。",
  color: "只换配色与背景：构图、主视觉、字体排版都保持不变。",
  type: "只调字体排版：放大 Hook 的关键词、行业名称与 MEAT，修正断行、对齐与间距；其他保持不变。",
  free: "Variant：沿用参考图的概念方向，做一个明显不同、但同样清楚的版本。",
};

function variantPrompt(row, kind, note) {
  return `${buildPrompt(row, state.template, "variant")}

本次修改范围：${VARIATION_HINTS[kind] || VARIATION_HINTS.free}${note ? `\n额外方向：${note}` : ""}
所有原文必须逐字保留；Logo 原样使用。`;
}

function upscalePrompt(row) {
  return `${buildPrompt(row, state.template, "upscale")}

本次是升级成正式图：保留附图 1 的构图、主视觉、配色与阅读层级，只提升清晰度、质感与完成度。
逐字核对原文，修正错字、漏字和走样的字形；${hasLogo() ? "Logo 用附图 2 原样替换，不走样；" : ""}不新增任何元素。`;
}

const stripLabel = (l) => l.replace(/^\s*[-•*]?\s*(tag|hook|sub|subheadline|headline|body|meat\s*\d*|cta|offer|note|highlight|适合|限定|eligibility|副标题|主标题|标题)\s*[:：]\s*/i, "").trim();
const contentLines = (row) => onImageText(row).split(/\n+/).filter((l) => !/^\s*tag\s*[:：]/i.test(l)).map(stripLabel).filter(Boolean);
const hookOf = (row) => { const h = contentBlocks(row.content).find((b) => b.key === "hook"); return (h ? h.text.replace(/\n/g, "") : contentLines(row)[0] || "").trim(); };


/* ---------------- sizes + image API ---------------- */
const SIZES = { "3:4": ["1056x1408", "1024x1536"], "4:5": ["1088x1360", "1024x1536"], "1:1": ["1024x1024", "1024x1024"], "9:16": ["1008x1792", "1024x1536"] };
const sizeFor = (model) => (SIZES[state.brand.aspect] || SIZES["3:4"])[/^gpt-image-2/.test(model) ? 0 : 1];

async function openaiGenerate({ prompt, model, quality, n, format }) {
  const body = { model, prompt, n, size: sizeFor(model), quality, output_format: format };
  if (format === "jpeg") body.output_compression = 75;
  const res = await fetch(`${apiBase()}/images/generations`, { method: "POST", headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return parseImages(res);
}
async function openaiEdit({ prompt, model, quality, n, format, images }) {
  const fd = new FormData();
  fd.append("model", model); fd.append("prompt", prompt); fd.append("n", String(n)); fd.append("size", sizeFor(model));
  fd.append("quality", quality); fd.append("output_format", format);
  if (format === "jpeg") fd.append("output_compression", "75");
  images.forEach((im, i) => { const ext = (im.type.split("/")[1] || "png").replace("jpg", "jpeg"); fd.append("image[]", new Blob([im.buf], { type: `image/${ext}` }), `ref${i}.${ext === "jpeg" ? "jpg" : ext}`); });
  const res = await fetch(`${apiBase()}/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${apiKey()}` }, body: fd });
  return parseImages(res);
}
async function parseImages(res) {
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) { const err = new Error(`API ${res.status}: ${json?.error?.message || text.slice(0, 300) || res.statusText}`); err.status = res.status; throw err; }
  return (json?.data || []).map((d) => Buffer.from(d.b64_json, "base64"));
}
async function withRetry(fn) {
  try { return await fn(); }
  catch (e) { if (e.status === 429 || e.status >= 500) { await new Promise((r) => setTimeout(r, 6000)); return fn(); } throw e; }
}
// placeholder image for Mock mode (no API cost) — returned as a data URL, nothing uploaded
function mockImage(row, label, i, final) {
  const hue = (crypto.createHash("md5").update(row.id + label + i + Date.now()).digest()[0] * 1.4) | 0;
  const dark = i % 2 === 0;
  const bg = dark ? `hsl(${hue % 40 + 190},45%,18%)` : `hsl(${hue % 60 + 80},18%,94%)`, ink = dark ? "#fff" : "#13201b";
  const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const wrap = (s, n) => { const out = []; let cur = ""; for (const ch of String(s || "")) { cur += ch; if (cur.length >= n) { out.push(cur); cur = ""; } } if (cur) out.push(cur); return out; };
  const hookText = hookOf(row), rest = contentLines(row).filter((l) => l !== hookText);
  const hl = wrap(hookText, 11);
  const hook = hl.map((l, k) => `<text x="64" y="${220 + k * 74}" font-size="60" font-weight="800" fill="${ink}">${esc(l)}</text>`).join("");
  const tail = rest.slice(-2), body = rest.slice(0, Math.max(0, rest.length - 2)).slice(0, 5);
  const y0 = 260 + hl.length * 74;
  const steps = body.map((m, k) => `<rect x="64" y="${y0 + k * 88}" width="960" height="70" rx="14" fill="${dark ? "rgba(255,255,255,.1)" : "#fff"}"/><text x="96" y="${y0 + 46 + k * 88}" font-size="28" fill="${ink}">${esc(m.slice(0, 34))}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1088 1360" font-family="PingFang SC, Microsoft YaHei, sans-serif"><rect width="1088" height="1360" fill="${bg}"/><text x="64" y="96" font-size="24" font-weight="700" fill="${ink}">LOGO</text><text x="1024" y="96" text-anchor="end" font-size="20" letter-spacing="3" fill="${ink}" opacity=".55">MOCK ${esc(label)}</text>${hook}<circle cx="${860 + (i * 37) % 120}" cy="${260 + (i * 53) % 60}" r="${40 + (i * 13) % 30}" fill="#1d5b78" opacity=".35"/>${steps}<rect x="0" y="1150" width="1088" height="210" fill="#1d5b78"/><text x="64" y="1228" font-size="32" font-weight="700" fill="#fff">${esc((tail[0] || "").slice(0, 30))}</text><text x="64" y="1290" font-size="28" fill="#fff">${esc((tail[1] || "").slice(0, 34))} →</text>${final ? "" : `<text x="1024" y="1335" text-anchor="end" font-size="18" fill="#fff" opacity=".6">low-res draft</text>`}</svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

const CONTENT_SKILL_FILE = path.join(ROOT, "docs", "CONTENT-SKILL.md");
const BRIEF_KEYS = ["client", "product", "language", "objective", "vp", "mechanism", "offer", "cta"];
const BRIEF_LABEL = { client: "公司名", product: "做什么（产品／服务）", language: "语言", objective: "目标", vp: "Master Value Proposition", mechanism: "机制与证据", offer: "Offer（逐字）", cta: "Call to Action（逐字）" };
const RUBRIC = ["audience", "motivation", "curiosity", "outcome", "specificity", "visual"];
const cleanStr = (v, n = 4000) => String(v ?? "").slice(0, n);
const nl = (s) => cleanStr(s).replace(/\\n/g, "\n").trim();
const campaignOf = (id) => state.content.campaigns.find((c) => c.id === id);

function cleanBrief(src = {}, old = {}) { const o = { ...old }; for (const k of BRIEF_KEYS) if (k in src) o[k] = cleanStr(src[k], 6000); for (const k of BRIEF_KEYS) o[k] = o[k] || ""; return o; }
function cleanDir(d = {}, old = {}) {
  const o = { auto: true, feedbackOn: false, feedback: "", manualOn: false, manual: "", per: 3, ...old };
  for (const k of ["auto", "feedbackOn", "manualOn"]) if (k in d) o[k] = !!d[k];
  for (const k of ["feedback", "manual"]) if (k in d) o[k] = cleanStr(d[k], 8000);
  if ("per" in d) o.per = Math.max(1, Math.min(10, Math.round(Number(d.per) || 3)));
  if (!o.auto && !o.feedbackOn && !o.manualOn) o.auto = true;
  return o;
}
function cleanPersona(p = {}, old = {}) { const o = { ...old }; for (const k of ["name", "desc"]) if (k in p) o[k] = cleanStr(p[k], 6000); if ("selected" in p) o.selected = !!p.selected; return o; }
function cleanItem(it, old = {}) {
  const o = { ...old };
  for (const k of ["content", "visual", "diagnosis"]) if (k in it) o[k] = cleanStr(it[k], 6000);
  if ("family" in it) o.family = it.family in FAMILIES ? it.family : "auto";
  if ("verdict" in it) o.verdict = it.verdict === "ok" ? "ok" : "fix";
  if ("picked" in it) o.picked = !!it.picked;
  return o;
}
function onImageGroups(text) { const b = contentBlocks(text); return b.some((x) => x.key) ? b.filter((x) => ON_IMAGE_KEYS.includes(x.key)).length : 0; }
// rule checks on top of the model's own diagnosis (Design Skill v2: ≤5 groups, short hook; Content Skill §6: no unbacked numbers / guarantees)
function ruleChecks(text, b) {
  const w = [], blocks = contentBlocks(text), get = (k) => (blocks.find((x) => x.key === k) || {}).text || "";
  const hook = get("hook").replace(/\s/g, "");
  if (!hook) w.push("没有 Hook");
  if (hook.length > 30) w.push(`Hook 太长（${hook.length} 字）`);
  if (onImageGroups(text) > 5) w.push(`图上 ${onImageGroups(text)} 组文字，超过 5 组`);
  if (get("body").replace(/\s/g, "").length > 60) w.push("Body 太长");
  if (/保证|必批|包成交|一定成交|稳赚|100%/.test(text)) w.push("有保证式承诺");
  if ((get("hook") + get("body")).match(/\d+/g)?.some((n) => !String(b.offer + b.cta).includes(n))) w.push("有数字，Offer／CTA 里没有这个数字（确认有依据）");
  if (b.offer && !text.includes(b.offer.trim())) w.push("Offer 跟基础资料不一样");
  if (b.cta && !text.includes(b.cta.trim())) w.push("CTA 跟基础资料不一样");
  return w;
}
function migrateCampaign(c) {
  if (c.v === 3) return c;
  c.brief = cleanBrief({ ...(c.brief || {}), mechanism: [c.brief?.mechanism, c.brief?.evidence].filter((s) => String(s || "").trim()).join("\n") });
  c.personas = (c.personas || []).map((p) => ({ id: p.id, name: p.name, desc: p.desc || p.situation || "", selected: !!p.selected }));
  c.dir = cleanDir({});
  c.items = (c.items || []).map((i) => {
    const lines = [];
    if (i.hook) lines.push("Hook:", i.hook);
    if (i.highlight) lines.push("Highlight: " + i.highlight);
    if (i.meat) lines.push("Body: " + i.meat);
    const cta = i.cta || [i.offer, i.cta].filter(Boolean).join("\n");
    if (cta) { const [o, ...r] = String(cta).split("\n"); lines.push("Offer: " + o); if (r.length) lines.push("CTA: " + r.join(" ")); }
    return { id: i.id, personaId: i.personaId || "", personaName: i.personaName || i.persona || "", content: lines.join("\n"), visual: i.visual || "", family: i.family || "auto", verdict: (i.score || 0) >= 24 ? "ok" : "fix", diagnosis: "", score: i.score || 0, picked: false, imported: !!i.imported, createdAt: i.createdAt || Date.now() };
  });
  delete c.gen; c.v = 3; return c;
}
function newCampaign(name, brief = {}) { return { v: 3, id: nextId("C"), name: cleanStr(name || "新 Campaign", 80), createdAt: Date.now(), brief: cleanBrief(brief), personas: [], dir: cleanDir({}), items: [] }; }
const codeOf = (c) => { const m = String(c.brief.client || c.name).toUpperCase().match(/[A-Z0-9]/g); return m ? m.slice(0, 3).join("") : "CT"; };
function nextContentId(c) { const pre = codeOf(c) + "-"; const used = new Set([...c.items.map((i) => i.id), ...state.rows.map((r) => r.id)]); let n = 1; while (used.has(pre + String(n).padStart(2, "0"))) n++; return pre + String(n).padStart(2, "0"); }

function briefText(b) { return BRIEF_KEYS.filter((k) => k !== "mechanism" && k !== "objective" && String(b[k] || "").trim()).map((k) => `【${BRIEF_LABEL[k]}】\n${String(b[k]).trim()}`).join("\n\n") || "（基础资料是空的）"; }
function dirText(d) {
  const out = [];
  if (d.auto) out.push("【自动】你根据 Content Skill 自己找最强的角度（Desire／Pain／Outcome），每张一个不同的主张。");
  if (d.feedbackOn && d.feedback.trim()) out.push(`【Data feedback：过去的内容与成绩】\n${d.feedback.trim()}\n→ 沿用跑得好的角度和写法，避开跑得差的；不要照抄原句。`);
  if (d.manualOn && d.manual.trim()) out.push(`【人工 Creative direction（优先照这个做）】\n${d.manual.trim()}`);
  return out.join("\n\n");
}
function contentInstructions() {
  let skill = ""; try { skill = fs.readFileSync(CONTENT_SKILL_FILE, "utf8"); } catch { skill = "（找不到 docs/CONTENT-SKILL.md）"; }
  const fam = Object.entries(FAMILIES).filter(([k]) => k !== "auto").map(([k, v]) => `- ${k}：${v}`).join("\n");
  return `${skill}

---
# 本 App（Winning Ads OS · Content）的执行契约
输出给设计用的静态广告内容，只输出符合 JSON schema 的结果。一张内容 = 图上文字＋一个主视觉（Design Skill v2：一张图只讲一件事）。
- tag：给谁看的一句短标签（例如「给装修公司老板」），≤12 字；没必要可以空。
- hook：一个主要欲望、痛点或结果，目标一眼认出自己。用 \\n 分行，每行 ≤14 个中文字，整句 ≤30 字。
- highlight：hook 原文里最该放大的 2–6 个字。
- body：一句 ≤45 字，讲机制怎样带来结果和下一步；不写保证成交、必批、全自动。
- Offer 与 CTA 由系统逐字加上，你不用写。
- 数字：只用 Offer／CTA 或人工 research 里写明的数字；没有就不用数字。不得编造案例、访谈或成绩。
- visual：一个出人意料、但一眼看懂的画面点子（视觉比喻、夸张比例、真实道具、意外视角…），一个主物件或一个场景，具体、可画；不要每张都是同一种界面卡或对话框。family 随便填一个即可（系统不使用）。
- 诊断：scores 按 rubric v1 六项各 0–5；verdict = ok（可以直接做图）或 fix（要改）；diagnosis 一句话说为什么，要改的话说改哪里。诚实打分，不要每张都给 ok。
- 语言照基础资料，自然的马来西亚用语。`;
}
const PERSONA_SCHEMA = { type: "object", additionalProperties: false, required: ["personas"], properties: { personas: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "desc"], properties: { name: { type: "string" }, desc: { type: "string" } } } } } };
const cardProps = { tag: { type: "string" }, hook: { type: "string" }, highlight: { type: "string" }, body: { type: "string" }, family: { type: "string", enum: Object.keys(FAMILIES).filter((k) => k !== "auto") }, visual: { type: "string" }, scores: { type: "object", additionalProperties: false, required: RUBRIC, properties: Object.fromEntries(RUBRIC.map((k) => [k, { type: "integer" }])) }, verdict: { type: "string", enum: ["ok", "fix"] }, diagnosis: { type: "string" } };
const CARDS_SCHEMA = { type: "object", additionalProperties: false, required: ["cards"], properties: { cards: { type: "array", items: { type: "object", additionalProperties: false, required: Object.keys(cardProps), properties: cardProps } } } };

async function openaiText({ instructions, input, schema, name }) {
  const call = async (format, withReasoning = true) => {
    const body = { model: settings.textModel, instructions, input, text: { format } };
    if (withReasoning && settings.textEffort) body.reasoning = { effort: settings.textEffort };
    const r = await fetch(`${apiBase()}/responses`, { method: "POST", headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(`OpenAI ${r.status}: ${j.error?.message || r.statusText}`); e.status = r.status; e.msg = j.error?.message || ""; throw e; }
    return j;
  };
  let data;
  try { data = await call({ type: "json_schema", name, schema, strict: true }); }
  catch (e) {
    if (e.status !== 400) throw e;
    const noReason = /reasoning/i.test(e.msg);
    data = await call({ type: "json_object" }, !noReason).catch(async (e2) => { if (e2.status === 400 && /reasoning/i.test(e2.msg)) return call({ type: "json_object" }, false); throw e2; });
  }
  const text = data.output_text || (data.output || []).flatMap((o) => o.content || []).filter((c) => c.type === "output_text").map((c) => c.text).join("");
  try { return JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error("模型没有回传 JSON：" + text.slice(0, 200)); }
}

const MOCK_PERSONAS = [
  { name: "刚开始投广告的装修老板", desc: "每月投 RM2–5k，询问自己回 WhatsApp，问价的多真的要装的少" },
  { name: "有 Sales 团队的 Property Agency 老板", desc: "团队 5–15 人，Lead 分给 Sales，质量参差" },
  { name: "想做大的 Cleaning 公司老板", desc: "团队有空档，靠熟客和介绍，想累积定期客户" },
  { name: "Loan Agency 顾问", desc: "每天很多人问能不能贷，资料不齐来回问" },
  { name: "开课导师", desc: "靠广告招生，私信多但报名少" },
];
function mockCards(p, k) {
  const H = [["询问很多，\n真正能谈的很少？", "能谈的"], ["老板专心谈生意，\nAI 持续筛选、跟进。", "专心谈生意"], ["让 Sales 下次接手，\n手上已有清楚需求。", "清楚需求"], ["问价的很多，\n真的要做的很少？", "真的要做"]];
  return Array.from({ length: k }, (_, i) => { const [hook, hl] = H[i % H.length]; const s = RUBRIC.map((_, x) => 3 + ((i + x) % 3)); return { tag: `给${p.name.slice(0, 10)}`, hook, highlight: hl, body: "AI 先确认需求、收集资料，再把有意向的客户交给团队推进。", family: ["f1", "f5", "f3", "f7"][i % 4], visual: ["一张整理好的客户需求卡", "手机上的客户询问对话", "老板看平板上的预约表", "预约卡片架"][i % 4], scores: Object.fromEntries(RUBRIC.map((r, x) => [r, s[x]])), verdict: i % 3 === 2 ? "fix" : "ok", diagnosis: i % 3 === 2 ? "Mock：Hook 偏泛，可以加行业词" : "Mock：受众清楚、主张明确" }; });
}
function composeContent(card, b) {
  const lines = [];
  if (nl(card.tag)) lines.push("Tag: " + nl(card.tag));
  lines.push("Hook:", nl(card.hook));
  if (nl(card.highlight)) lines.push("Highlight: " + nl(card.highlight));
  if (nl(card.body)) lines.push("Body: " + nl(card.body));
  if (b.offer.trim()) lines.push("Offer: " + b.offer.trim());
  if (b.cta.trim()) lines.push("CTA: " + b.cta.trim());
  return lines.join("\n");
}


/* ---------------- state (one JSON doc in Redis; every write re-reads first) ---------------- */
async function load() {
  const s = (await store.get("wao:state")) || {};
  state = { seq: 0, ...s };
  state.brand = { ...DEFAULT_BRAND, ...(state.brand || {}) };
  state.content = state.content && Array.isArray(state.content.campaigns) ? state.content : { campaigns: [], current: "" };
  state.content.campaigns = state.content.campaigns.map(migrateCampaign);
  state.assets = state.assets || [];
  state.rows = []; state.template = DEFAULT_TEMPLATE;
  settings = { ...DEFAULT_SETTINGS, ...((await store.get("wao:settings")) || {}) };
  return state;
}
async function save() { const { rows, template, ...rest } = state; await store.set("wao:state", rest); }
async function mutate(fn) { await load(); const r = await fn(state); await save(); return r; }

/* ---------------- jobs: run inside the request; status kept in Redis for the page to poll ---------------- */
const JOBS = "wao:jobs";
const saveJob = (j) => store.hset(JOBS, j.id, (({ prompt, ...rest }) => rest)(j));
async function runJobs(list, concurrency = 3) {
  for (const j of list) Object.assign(j, { id: randId("J"), status: "queued", createdAt: Date.now() });
  await Promise.all(list.map(saveJob));
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const j = list[i++];
      j.status = "running"; j.startedAt = Date.now(); await saveJob(j);
      try { await runJob(j); j.status = "done"; } catch (e) { j.status = "error"; j.error = e.message; console.error(j.id, e.message); }
      j.endedAt = Date.now(); await saveJob(j);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  const failed = list.filter((j) => j.status === "error");
  if (failed.length && failed.length === list.length) throw new Error(failed[0].error); // nothing worked → tell the page why
  return list;
}

async function runJob(job) {
  await load();
  if (job.type === "content") return runContentJob(job);
  const camp = campaignOf(job.campaignId); if (!camp) throw new Error("找不到这个 Campaign");
  const it = camp.items.find((i) => i.id === job.rowId); if (!it) throw new Error("这张内容已被删除：" + job.rowId);
  const row = { id: it.id, family: it.family || "auto", content: it.content, visual: it.visual };
  const final = job.type === "upscale";
  const model = final ? settings.finalModel : settings.draftModel;
  const quality = final ? settings.finalQuality : settings.draftQuality;
  const parent = job.parentId ? state.assets.find((a) => a.id === job.parentId) : null;
  if (job.parentId && !parent) throw new Error("参考图已被删除");
  if (!state.brand.locked) throw new Error("Logo 还没锁定：先在第 1 步上传 Logo");
  let prompt;
  if (job.type === "draft") prompt = buildPrompt(row, DEFAULT_TEMPLATE, "draft", { twist: job.twist || "" });
  else if (job.type === "variant") prompt = variantPrompt(row, job.variation, job.note);
  else prompt = upscalePrompt(row);

  const files = []; // [{url, ext}]
  if (settings.mock) {
    await new Promise((r) => setTimeout(r, 700 + Math.random() * 900));
    for (let i = 0; i < job.n; i++) files.push({ url: mockImage(row, job.type, i, final) });
  } else {
    if (!apiKey()) throw new Error("还没有设定 API key：在 Vercel 的 Environment Variables 加 AI_API_KEY");
    if (parent && parent.file.startsWith("data:")) throw new Error("这张是 Mock 假图，不能当参考图");
    const format = final ? "png" : "jpeg", ext = final ? "png" : "jpg";
    const refs = [...(parent ? [await store.getFile(parent.file)] : []), ...(hasLogo() ? [await store.getFile(state.brand.logoUrl)] : [])];
    const args = { prompt, model, quality, n: job.n, format };
    const bufs = await withRetry(() => (refs.length ? openaiEdit({ ...args, images: refs }) : openaiGenerate(args)));
    for (const buf of bufs) files.push({ url: await store.putFile(`${row.id}-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}.${ext}`, buf, final ? "image/png" : "image/jpeg") });
  }
  const added = await mutate((st) => {
    const out = [];
    for (const f of files) {
      const asset = { id: nextId("A"), rowId: row.id, kind: final ? "final" : job.type, parentId: job.parentId || "", variation: job.variation || "", scope: "content", campaignId: camp.id,
        model: settings.mock ? "mock" : model, quality, aspect: st.brand.aspect, createdAt: Date.now(), batch: job.batch || "", picked: false, creativeId: "", file: f.url };
      if (final) { const used = st.assets.filter((a) => a.kind === "final" && a.rowId === row.id).length; asset.creativeId = `${row.id}-${String.fromCharCode(65 + (used % 26))}${used >= 26 ? Math.floor(used / 26) : ""}`; }
      else { const n = st.assets.filter((a) => a.rowId === row.id && a.kind !== "final").length + 1; asset.label = `${row.id}-${job.type === "variant" ? "V" : "D"}${String(n).padStart(3, "0")}`; }
      st.assets.push(asset); out.push(asset);
    }
    return out;
  });
  await Promise.all(added.map((a) => store.hset("wao:prompts", a.id, prompt)));
  job.produced = added.length;
}

async function runContentJob(job) {
  const c = campaignOf(job.campaignId); if (!c) throw new Error("找不到这个 Campaign");
  const b = c.brief;
  if (!settings.mock && !apiKey()) throw new Error("还没有设定 API key：在 Vercel 的 Environment Variables 加 AI_API_KEY");
  const p = c.personas.find((x) => x.id === job.personaId); if (!p) throw new Error("这个行业已被删除");
  const d = c.dir;
  let cards;
  if (settings.mock) { await new Promise((r) => setTimeout(r, 900 + Math.random() * 900)); cards = mockCards(p, job.k); }
  else {
    const existing = c.items.filter((i) => i.personaId === p.id).map((i) => "- " + hookOf({ content: i.content }));
    const out = await withRetry(() => openaiText({ name: "content_cards", schema: CARDS_SCHEMA, instructions: contentInstructions(),
      input: `为这个目标行业做 ${job.k} 张静态广告内容，每张一个不同的主张。先在心里想清楚这个行业老板的 Desire、Pain、Outcome，再写；有人工 research 就以 research 为准。
【目标行业】${p.name}${p.desc ? `\n【人工 research】\n${p.desc}` : ""}

## Creative direction
${dirText(d)}
${existing.length ? `\n这个行业已经有的 Hook（不要重复）：\n${existing.join("\n")}` : ""}

## 基础资料
${briefText(b)}` }));
    cards = (out.cards || []).slice(0, job.k);
    if (!cards.length) throw new Error("模型没有回传内容");
  }
  await mutate(() => {
    const cc = campaignOf(job.campaignId); if (!cc) return;
    for (const card of cards) {
      const content = composeContent(card, cc.brief);
      const score = RUBRIC.reduce((s, r) => s + Math.max(0, Math.min(5, Math.round(Number(card.scores?.[r]) || 0))), 0);
      const rules = ruleChecks(content, cc.brief);
      const verdict = card.verdict === "ok" && score >= 20 && !rules.length ? "ok" : "fix";
      cc.items.push({ id: nextContentId(cc), personaId: p.id, personaName: p.name, content, visual: cleanStr(card.visual, 1000), family: "auto", verdict, diagnosis: [cleanStr(card.diagnosis, 600), ...rules].filter(Boolean).join("；"), score, picked: false, imported: false, createdAt: Date.now(), source: [d.auto && "自动", d.feedbackOn && "Data", d.manualOn && "人工"].filter(Boolean).join("＋"), model: settings.mock ? "mock" : settings.textModel });
    }
  });
  job.produced = cards.length;
}

/* ---------------- auth: one shared team password (APP_PASSWORD) ---------------- */
const PASSWORD = process.env.APP_PASSWORD || "";
const authToken = () => crypto.createHmac("sha256", PASSWORD).update("winning-ads-os").digest("hex");
const authed = (req) => !PASSWORD || (String(req.headers.cookie || "").match(/(?:^|;\s*)wao_auth=([a-f0-9]+)/) || [])[1] === authToken();

/* ---------------- routes ---------------- */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || lo)));
const publicBrand = () => ({ ...state.brand, hasLogo: hasLogo() });
const publicSettings = () => ({ ...settings, apiKey: apiKey() ? "…" + apiKey().slice(-4) : "", hasKey: !!apiKey(), keyFromEnv: true });
const routes = {
  "GET /api/state": async () => { await load(); return { families: FAMILIES, rows: [], template: "", assets: state.assets, settings: publicSettings(), brand: publicBrand(), defaults: { template: "" }, content: state.content, hosted: true }; },
  "POST /api/brand": (b) => mutate(() => { for (const k of ["logoPos", "aspect"]) if (k in b) state.brand[k] = String(b[k] || "").slice(0, 40); if (!SIZES[state.brand.aspect]) state.brand.aspect = "3:4"; return { brand: publicBrand() }; }),
  "POST /api/brand/logo": async (b) => {
    const m = String(b.dataUrl || "").match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
    if (!m) throw new Error("Logo 请用 PNG、JPG 或 WEBP（建议透明底 PNG）。");
    const buf = Buffer.from(m[2], "base64"); if (buf.length > 3.5e6) throw new Error("Logo 档案太大（上限 3.5MB）");
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    const url = await store.putFile(`logo-${Date.now()}.${ext}`, buf, `image/${m[1] === "jpg" ? "jpeg" : m[1]}`);
    let old = "";
    const r = await mutate(() => { old = state.brand.logoUrl; state.brand.logoUrl = url; return { brand: publicBrand() }; });
    if (old) await store.delFile(old);
    return r;
  },
  "POST /api/brand/lock": (b) => mutate(() => { if (b.locked) { if (!hasLogo()) throw new Error("先上传 Logo"); state.brand.locked = true; } else state.brand.locked = false; return { brand: publicBrand() }; }),
  "POST /api/settings": async (b) => {
    await load();
    for (const k of ["mock", "apiBase", "draftModel", "draftQuality", "finalModel", "finalQuality", "textModel", "textEffort"]) if (k in b) settings[k] = b[k];
    if ("apiBase" in b && !/^https?:\/\//.test(String(b.apiBase).trim())) settings.apiBase = DEFAULT_SETTINGS.apiBase;
    await store.set("wao:settings", settings); return { settings: publicSettings() };
  },
  "POST /api/asset": (b) => mutate(() => { const a = state.assets.find((x) => x.id === b.id); if (a && "picked" in b) a.picked = !!b.picked; return { ok: true }; }),
  "POST /api/pick-many": (b) => mutate(() => { const s = new Set(b.ids || []); for (const a of state.assets) if (s.has(a.id)) a.picked = !!b.picked; return { ok: true }; }),
  "POST /api/delete-asset": (b) => routes["POST /api/delete-assets"]({ ids: [b.id] }),
  "POST /api/delete-assets": async (b) => {
    const ids = new Set(b.ids || []); let gone = [];
    await mutate(() => { gone = state.assets.filter((a) => ids.has(a.id)); state.assets = state.assets.filter((a) => !ids.has(a.id)); });
    await Promise.all(gone.map((a) => store.delFile(a.file))); if (gone.length) await store.hdel("wao:prompts", ...gone.map((a) => a.id));
    return { ok: true };
  },
  "POST /api/variants": async (b) => {
    await load(); if (!state.brand.locked) throw new Error("先锁定 Logo");
    const parent = state.assets.find((a) => a.id === b.assetId); if (!parent) throw new Error("找不到这张图");
    const n = clamp(b.n, 1, 4), batch = randId("B");
    await runJobs([{ type: "variant", rowId: parent.rowId, campaignId: parent.campaignId, parentId: parent.id, n, variation: b.variation || "free", note: String(b.note || "").slice(0, 400), batch }]);
    return { ok: true };
  },
  "POST /api/upscale": async (b) => {
    await load(); const list = [];
    for (const id of b.assetIds || []) { const a = state.assets.find((x) => x.id === id); if (a) list.push({ type: "upscale", rowId: a.rowId, campaignId: a.campaignId, parentId: a.id, n: 1 }); }
    await runJobs(list, 2); return { queued: list.length };
  },
  "GET /api/jobs": async () => {
    const all = Object.values(await store.hgetall(JOBS)), now = Date.now(), stale = [];
    for (const j of all) {
      if ((j.status === "running" || j.status === "queued") && now - (j.startedAt || j.createdAt) > 6 * 60e3) { j.status = "error"; j.error = "超时（可能超过 Vercel 的执行时间上限），请再试一次"; await saveJob(j); }
      if ((j.status === "done" || j.status === "error") && now - (j.endedAt || j.createdAt) > 3 * 3600e3) stale.push(j.id);
    }
    if (stale.length) await store.hdel(JOBS, ...stale);
    const jobs = all.filter((j) => !stale.includes(j.id)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 80);
    return { running: jobs.filter((j) => j.status === "running").length, jobs };
  },
  "POST /api/clear-jobs": async () => { const all = Object.values(await store.hgetall(JOBS)); const ids = all.filter((j) => j.status === "done" || j.status === "error").map((j) => j.id); if (ids.length) await store.hdel(JOBS, ...ids); return { ok: true }; },
  "GET /api/prompt": async (b, q) => ({ prompt: (await store.hget("wao:prompts", q.get("id"))) || "" }),

  /* content */
  "POST /api/content/new": (b) => mutate(() => { const c = newCampaign(b.name, b.brief || {}); state.content.campaigns.push(c); state.content.current = c.id; return { content: state.content }; }),
  "POST /api/content/select": (b) => mutate(() => { if (campaignOf(b.id)) state.content.current = b.id; return { ok: true }; }),
  "POST /api/content/rename": (b) => mutate(() => { const c = campaignOf(b.id); if (c) c.name = cleanStr(b.name, 80) || c.name; return { ok: true }; }),
  "POST /api/content/delete-campaign": async (b) => {
    let gone = [];
    const r = await mutate(() => { state.content.campaigns = state.content.campaigns.filter((c) => c.id !== b.id); if (state.content.current === b.id) state.content.current = state.content.campaigns[0]?.id || ""; gone = state.assets.filter((a) => a.campaignId === b.id); state.assets = state.assets.filter((a) => a.campaignId !== b.id); return { content: state.content }; });
    await Promise.all(gone.map((a) => store.delFile(a.file))); return r;
  },
  "POST /api/content/save": (b) => mutate(() => {
    const c = campaignOf(b.id); if (!c) throw new Error("找不到这个 Campaign");
    if (b.brief) c.brief = cleanBrief(b.brief, c.brief);
    if (b.dir) c.dir = cleanDir(b.dir, c.dir);
    for (const p of b.personas || []) { const i = c.personas.findIndex((x) => x.id === p.id); if (i >= 0) c.personas[i] = cleanPersona(p, c.personas[i]); }
    for (const it of b.items || []) {
      const i = c.items.findIndex((x) => x.id === it.id); if (i < 0) continue;
      const edited = "content" in it && it.content !== c.items[i].content;
      c.items[i] = cleanItem(it, c.items[i]);
      if (edited) { const rules = ruleChecks(c.items[i].content, c.brief); c.items[i].verdict = rules.length ? "fix" : c.items[i].verdict; c.items[i].diagnosis = rules.length ? rules.join("；") : c.items[i].diagnosis; }
    }
    return { ok: true, items: c.items.filter((i) => (b.items || []).some((x) => x.id === i.id)) };
  }),
  "POST /api/content/persona-add": (b) => mutate(() => { const c = campaignOf(b.id); if (!c) throw new Error("找不到这个 Campaign"); if (c.personas.some((x) => x.name === String(b.name || "").trim())) throw new Error("这个行业已经在了"); const p = { id: nextId("P"), name: cleanStr(String(b.name || "").trim() || "新行业", 200), desc: "", selected: true }; c.personas.push(p); return { persona: p }; }),
  "POST /api/content/persona-delete": (b) => mutate(() => { const c = campaignOf(b.id); if (c) c.personas = c.personas.filter((p) => p.id !== b.personaId); return { ok: true }; }),
  "POST /api/content/generate": async (b) => {
    const c0 = await mutate(() => {
      const c = campaignOf(b.id); if (!c) throw new Error("先建一个 Campaign");
      if (b.dir) c.dir = cleanDir(b.dir, c.dir);
      if (!c.personas.some((p) => p.selected)) throw new Error("先在第 2 步选至少一个行业");
      if (c.dir.feedbackOn && !c.dir.feedback.trim()) throw new Error("勾了 Data feedback，但还没贴内容");
      if (c.dir.manualOn && !c.dir.manual.trim()) throw new Error("勾了人工 Creative direction，但还没写方向");
      return JSON.parse(JSON.stringify(c));
    });
    const list = c0.personas.filter((p) => p.selected).map((p) => ({ type: "content", campaignId: c0.id, personaId: p.id, k: c0.dir.per, n: c0.dir.per, rowId: `${c0.name} · ${p.name.slice(0, 14)}` }));
    await runJobs(list, 3);
    return { cards: list.length * c0.dir.per };
  },
  "POST /api/content/delete-items": async (b) => {
    let gone = [];
    await mutate(() => { const c = campaignOf(b.id); if (!c) return; const ids = new Set(b.ids || []); c.items = c.items.filter((i) => !ids.has(i.id)); gone = state.assets.filter((a) => a.campaignId === c.id && ids.has(a.rowId)); state.assets = state.assets.filter((a) => !gone.includes(a)); });
    await Promise.all(gone.map((a) => store.delFile(a.file))); return { ok: true };
  },
  "POST /api/content/mockup": async (b) => {
    await load();
    if (!state.brand.locked) throw new Error("先在第 1 步上传并锁定 Logo，Mockup 才会带上 Logo");
    const c = campaignOf(b.id); if (!c) throw new Error("找不到这个 Campaign");
    const ids = new Set(b.ids || []), batch = randId("B");
    const list = c.items.filter((i) => ids.has(i.id)).map((it) => ({ type: "draft", rowId: it.id, campaignId: c.id, n: 1, batch, mockup: true, twist: CREATIVE_TWISTS[Math.floor(Math.random() * CREATIVE_TWISTS.length)] }));
    if (!list.length) throw new Error("先选内容");
    await runJobs(list, 3); return { queued: list.length };
  },
};

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const send = (code, obj, headers = {}) => { res.statusCode = code; res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); res.end(JSON.stringify(obj)); };
  try {
    let body = req.body;
    if (req.method === "POST" && (body == null || typeof body === "string")) { if (typeof body === "string") body = body ? JSON.parse(body) : {}; else { let d = ""; for await (const ch of req) d += ch; body = d ? JSON.parse(d) : {}; } }
    body = body || {};
    const secure = (req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
    if (url.pathname === "/api/login") {
      if (PASSWORD && String(body.password || "") !== PASSWORD) return send(401, { error: "密码不对" });
      return send(200, { ok: true }, { "Set-Cookie": `wao_auth=${PASSWORD ? authToken() : ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}` });
    }
    if (url.pathname === "/api/logout") return send(200, { ok: true }, { "Set-Cookie": `wao_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}` });
    if (!authed(req)) return send(401, { error: "需要登入", login: true });
    const h = routes[`${req.method} ${url.pathname}`];
    if (!h) return send(404, { error: "找不到：" + url.pathname });
    return send(200, await h(body, url.searchParams));
  } catch (e) {
    console.error(e);
    return send(400, { error: e.message });
  }
}
module.exports = { handle };
