// Local preview of the hosted version: node dev.js → http://localhost:3000
// Without Redis/Blob env vars it stores everything in ./.local (same behaviour, no cloud needed).
const http = require("http");
const fs = require("fs");
const path = require("path");
const { handle } = require("./lib/app");
const { LOCAL_BLOB } = require("./lib/store");
const PORT = Number(process.env.PORT) || 3000;
const MIME = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname.startsWith("/api/")) return handle(req, res);
  const base = u.pathname.startsWith("/blob/") ? LOCAL_BLOB : path.join(__dirname, "public");
  const rel = u.pathname.startsWith("/blob/") ? path.basename(u.pathname) : u.pathname === "/" ? "index.html" : u.pathname;
  const f = path.normalize(path.join(base, rel));
  if (f.startsWith(base) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" }); return res.end(fs.readFileSync(f)); }
  res.writeHead(404); res.end("not found");
}).listen(PORT, () => console.log(`Winning Ads OS (hosted build) → http://localhost:${PORT}`));
