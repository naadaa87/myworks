// 사용: node tests/dev-server.mjs <저장소 경로> [포트] [DB 파일]
// 로컬 시험 서버 — 정적 파일(Pages 방식) + /api·/mcp는 functions/_middleware.js
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { pathToFileURL } from "node:url";
import { makeD1 } from "./d1-local.mjs";
if (process.env.MW_MOCK) await import("./mock-upstream.mjs");   // 바깥 서비스(솔라피·팝빌·푸시 서버)를 흉내 냅니다 — 브라우저 시험용
const ROOT = process.argv[2], PORT = Number(process.argv[3] || 8787), DBFILE = process.argv[4] || ":memory:";
const src = fs.readFileSync(path.join(ROOT, "functions/_middleware.js"), "utf8");
const modFile = path.join(path.dirname(new URL(import.meta.url).pathname), "mw_" + Date.now() + ".mjs");
fs.writeFileSync(modFile, src);
const { onRequest } = await import(pathToFileURL(modFile).href);
fs.unlinkSync(modFile);
const DB = makeD1(DBFILE);
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "application/javascript", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".xml": "application/xml", ".webmanifest": "application/manifest+json", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".json": "application/json" };
const redirects = fs.existsSync(path.join(ROOT, "_redirects")) ? fs.readFileSync(path.join(ROOT, "_redirects"), "utf8").split("\n").map(l => l.trim().split(/\s+/)).filter(a => a.length >= 3 && !a[0].startsWith("#")) : [];
function serveStatic(u, res) {
  for (const [from, to, code] of redirects) { const re = new RegExp("^" + from.replace(/\*/g, ".*") + "$"); if (re.test(u) && code === "200") u = to; }
  const cands = u.endsWith("/") ? [u + "index.html"] : [u, u + ".html", u + "/index.html"];
  for (const c of cands) { const f = path.join(ROOT, c); if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); return fs.createReadStream(f).pipe(res); } }
  res.writeHead(404, { "content-type": MIME[".html"] }); fs.createReadStream(path.join(ROOT, "404.html")).pipe(res);
}
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = "http://localhost:" + PORT + req.url;
  const request = new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body });
  const next = async () => null;
  const r = await onRequest({ request, env: Object.assign({ DB }, Object.fromEntries(["MW_ADMIN_KEY", "MW_VAULT_KEY", "POPBILL_LINK_ID", "POPBILL_SECRET_KEY", "POPBILL_TEST"].filter(k => process.env[k]).map(k => [k, process.env[k]]))), next });   // 보안 키 시험: MW_ADMIN_KEY=... node tests/dev-server.mjs
  if (!r) return serveStatic(decodeURIComponent(req.url.split("?")[0]), res);
  const h = {}; r.headers.forEach((v, k) => h[k] = v);
  res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, () => console.log("dev", PORT));
