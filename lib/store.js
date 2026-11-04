// Storage for the hosted version.
// KV  : Upstash Redis REST (Vercel Marketplace sets KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN).
// Blob: Vercel Blob (BLOB_READ_WRITE_TOKEN). Without these env vars it falls back to local files (for `node dev.js`).
const fs = require("fs");
const path = require("path");

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || "";
const LOCAL_DIR = path.join(process.cwd(), ".local");
const LOCAL_DB = path.join(LOCAL_DIR, "db.json");
const LOCAL_BLOB = path.join(LOCAL_DIR, "blob");
const hasKV = !!(KV_URL && KV_TOKEN);

async function redis(cmd) {
  const r = await fetch(KV_URL, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error("存储（Redis）出错：" + (j.error || r.status));
  return j.result;
}
// local fallback: one JSON file
const localRead = () => { try { return JSON.parse(fs.readFileSync(LOCAL_DB, "utf8")); } catch { return {}; } };
const localWrite = (db) => { fs.mkdirSync(LOCAL_DIR, { recursive: true }); fs.writeFileSync(LOCAL_DB, JSON.stringify(db)); };

async function get(key) {
  if (hasKV) { const v = await redis(["GET", key]); return v == null ? null : JSON.parse(v); }
  const db = localRead(); return db[key] ?? null;
}
async function set(key, val) {
  if (hasKV) return redis(["SET", key, JSON.stringify(val)]);
  const db = localRead(); db[key] = val; localWrite(db);
}
async function hset(key, field, val) {
  if (hasKV) return redis(["HSET", key, field, JSON.stringify(val)]);
  const db = localRead(); db[key] = db[key] || {}; db[key][field] = val; localWrite(db);
}
async function hget(key, field) {
  if (hasKV) { const v = await redis(["HGET", key, field]); return v == null ? null : JSON.parse(v); }
  const db = localRead(); return (db[key] || {})[field] ?? null;
}
async function hgetall(key) {
  if (hasKV) { const arr = (await redis(["HGETALL", key])) || []; const o = {}; for (let i = 0; i < arr.length; i += 2) o[arr[i]] = JSON.parse(arr[i + 1]); return o; }
  const db = localRead(); return db[key] || {};
}
async function hdel(key, ...fields) {
  if (!fields.length) return;
  if (hasKV) return redis(["HDEL", key, ...fields]);
  const db = localRead(); for (const f of fields) if (db[key]) delete db[key][f]; localWrite(db);
}

// files
async function putFile(name, buf, contentType) {
  if (BLOB_TOKEN) {
    const { put } = require("@vercel/blob");
    const r = await put(`wao/${name}`, buf, { access: "public", contentType, addRandomSuffix: true, token: BLOB_TOKEN });
    return r.url;
  }
  fs.mkdirSync(LOCAL_BLOB, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_BLOB, name.replace(/[\\/]/g, "_")), buf);
  return "/blob/" + name.replace(/[\\/]/g, "_");
}
async function delFile(url) {
  if (!url || url.startsWith("data:")) return;
  try {
    if (url.startsWith("/blob/")) fs.unlinkSync(path.join(LOCAL_BLOB, path.basename(url)));
    else if (BLOB_TOKEN) { const { del } = require("@vercel/blob"); await del(url, { token: BLOB_TOKEN }); }
  } catch {}
}
async function getFile(url) {
  if (url.startsWith("data:")) { const m = url.match(/^data:([^;,]+)(;base64)?,(.*)$/s); return { buf: m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3])), type: m[1] }; }
  if (url.startsWith("/blob/")) { const f = path.join(LOCAL_BLOB, path.basename(url)); const ext = path.extname(f).slice(1).replace("jpg", "jpeg"); return { buf: fs.readFileSync(f), type: "image/" + (ext || "png") }; }
  const r = await fetch(url); if (!r.ok) throw new Error("读不到图片：" + r.status);
  return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") || "image/png" };
}

module.exports = { hasKV, hasBlob: !!BLOB_TOKEN, get, set, hset, hget, hgetall, hdel, putFile, delFile, getFile, LOCAL_BLOB };
