// Local preview of the hosted version: node dev.js → http://localhost:3000
// Without Redis/Blob env vars it stores everything in ./.local (same behaviour, no cloud needed).
// optional local.env (KEY=VALUE per line) so start.bat works without setting env vars by hand
try { for (const line of require("fs").readFileSync(require("path").join(__dirname, "local.env"), "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
const http = require("http");
const fs = require("fs");
const path = require("path");
const { handle } = require("./lib/app");
const { localPath, LOCAL_DB } = require("./lib/store");

// earlier local app in this same folder: reuse its API key and bring its Logo, Campaigns and images over once
try {
  const old = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "settings.json"), "utf8"));
  if (!process.env.AI_API_KEY && old.apiKey) process.env.AI_API_KEY = old.apiKey;
  if (!process.env.AI_API_BASE && old.apiBase) process.env.AI_API_BASE = old.apiBase;
} catch {}
if (!fs.existsSync(LOCAL_DB) && fs.existsSync(path.join(__dirname, "data", "project.json"))) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "project.json"), "utf8"));
    const enc = (f) => String(f).split("/").map(encodeURIComponent).join("/");
    const state = {
      seq: Number(p.seq) || 0,
      brand: { locked: !!(p.brand && p.brand.locked && p.brand.logoFile), logoUrl: p.brand && p.brand.logoFile ? "/old-data/brand/" + enc(p.brand.logoFile) : "", logoPos: (p.brand && p.brand.logoPos) || "右上角", aspect: (p.brand && p.brand.aspect) || "3:4" },
      content: p.content && Array.isArray(p.content.campaigns) ? p.content : { campaigns: [], current: "" },
      assets: (p.assets || []).filter((a) => a.scope === "content" && a.file && !/\.svg$/i.test(a.file)).map((a) => ({ ...a, file: "/old-out/" + enc(a.file) })),
    };
    fs.mkdirSync(path.dirname(LOCAL_DB), { recursive: true });
    fs.writeFileSync(LOCAL_DB, JSON.stringify({ "wao:state": state }));
    console.log(`已导入旧资料：${state.content.campaigns.length} 个 Campaign、${state.assets.length} 张图`);
  } catch (e) { console.log("旧资料导入失败（不影响使用）：" + e.message); }
}
const PORT = Number(process.env.PORT) || 3000;
const MIME = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname.startsWith("/api/")) return handle(req, res);
  const pub = path.join(__dirname, "public");
  let f = localPath(u.pathname);
  if (!f) { f = path.normalize(path.join(pub, u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname))); if (!f.startsWith(pub)) f = null; }
  if (f && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" }); return res.end(fs.readFileSync(f)); }
  res.writeHead(404); res.end("not found");
}).listen(PORT, () => console.log(`Winning Ads OS (hosted build) → http://localhost:${PORT}`));
