/* 마이웍스 서버 v4 — 회원가입 · 승인 · 멀티 워크스페이스 · 등급(베이직/프로) · 업종 모듈 · AI 접속
   Cloudflare Pages Functions + D1 (바인딩 변수 이름: DB)

   · 이 파일은 저장소의 functions/_middleware.js 위치에 둡니다.
   · 테이블은 첫 요청 때 자동으로 만들어지고, 이전 버전(v1~v3) 데이터는 그대로 이어서 씁니다.
   · 처음 설정한 계정이 운영자가 되어 새 워크스페이스 가입을 승인합니다.
     운영자도 각 워크스페이스의 업무 내용은 볼 수 없고, 가입·이용 상태와 등급만 관리합니다.
   · 등급: 베이직(나 혼자 + 구성원 2명, 브랜드 2개, 읽기 토큰 1개) / 프로(구성원 10명 포함, 업종 모듈, 쓰기 토큰).
     업종 모듈: space(스페이스) · outsourcing(아웃소싱) · commerce(커머스) — 프로 워크스페이스에서 켜고 끕니다.
   · AI 접속: 개인 API 토큰(Bearer)으로 외부 AI가 /api/ai/* 를 읽고, 쓰기 토큰은 "제안"을 올립니다. /mcp 는 같은 기능의 MCP 서버입니다.
   · 확인 링크: 계정 없는 고객·거래처가 /#/link/<token> 에서 견적 승인·납품 확인만 합니다.
   · 스페이스: 예약 → 청소 배정 → 체크리스트 → 확인 → 손익. HOSTDB(읽기)는 운영자 워크스페이스에서만, SPACEDB(1회 가져오기)는 운영자만.
   · 무료 요금제 한도(요청당 쿼리 50회)를 넘지 않도록 여러 건의 쓰기는 한 문장으로 묶어 처리합니다. */

const SCHEMA = "4";
const PLANS = ["basic", "pro"];
const MODULES = ["space", "outsourcing", "commerce"];
const PLAN_LIMITS = { basic: { brands: 2, members: 2, tokens: 1 }, pro: { brands: 1000, members: 10, tokens: 20 } };   // members = 관리자 외 구성원 수
const AI_HOUR_LIMIT = 60, AI_DAY_LIMIT = 1500;
const MARGIN = 15000;              // 동기화 누락 방지용 여유(ms)
const SESSION_MS = 30 * 864e5;     // 마지막 사용 후 세션 유지 기간
const TOUCH_MS = 12 * 3600e3;      // 세션 사용 시각 갱신 간격
const LOCK_FAILS = 10;             // 연속 실패 시 잠금
const LOCK_MS = 10 * 60e3;
const MAX_PENDING_WS = 50;
const MAX_PENDING_JOIN = 30;
const PW_ITER = 2000;
const ID_RE = /^[a-z0-9][a-z0-9._-]{3,19}$/;
const INVITE_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ARR = { member: "members", project: "projects", store: "stores", task: "tasks", comment: "comments", fin: "finance", routine: "routines", template: "templates", plan: "plans", act: "activity", contact: "contacts", prop: "proposals" };
const STRIP = { project: ["budget", "vendorNotes"], store: ["monthlyTarget"] };   // 협력사에게 보내지 않는 금액 항목
const MGR_ONLY = new Set(["contact", "prop"]);   // 연락처(고객·거래처)와 AI 제안은 관리자·직원만 받습니다

let READY = false;
const VIS = new Map();             // 협력사 열람 범위 캐시

const DDL = [
  "CREATE TABLE IF NOT EXISTS mw_meta(k TEXT PRIMARY KEY, v TEXT)",
  "CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, admin_login TEXT, contact TEXT, note TEXT, invite TEXT, created_at TEXT NOT NULL, approved_at TEXT, last_active TEXT)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_ws_invite ON workspaces(invite)",
  "CREATE TABLE IF NOT EXISTS accounts(login_id TEXT PRIMARY KEY, ws TEXT NOT NULL, member_id TEXT NOT NULL, pw TEXT, status TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff', is_owner INTEGER NOT NULL DEFAULT 0, name TEXT, contact TEXT, note TEXT, created_at TEXT NOT NULL, last_login TEXT, fails INTEGER NOT NULL DEFAULT 0, lock_until INTEGER NOT NULL DEFAULT 0)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_acc_member ON accounts(ws, member_id)",
  "CREATE TABLE IF NOT EXISTS ent(ws TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT, deleted INTEGER NOT NULL DEFAULT 0, ua TEXT NOT NULL, own TEXT, pid TEXT, sid TEXT, PRIMARY KEY(ws, kind, id))",
  "CREATE INDEX IF NOT EXISTS idx_ent_sync ON ent(ws, ua)",
  "CREATE INDEX IF NOT EXISTS idx_ent_own ON ent(ws, kind, own)",
  "CREATE TABLE IF NOT EXISTS sess(token TEXT PRIMARY KEY, ws TEXT NOT NULL, member_id TEXT NOT NULL, created_at TEXT NOT NULL, seen INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_sess_member ON sess(ws, member_id)",
  // v4 — 워크스페이스 설정, AI 토큰, 확인 링크
  "CREATE TABLE IF NOT EXISTS ws_set(ws TEXT NOT NULL, k TEXT NOT NULL, v TEXT, PRIMARY KEY(ws,k))",
  "CREATE TABLE IF NOT EXISTS api_tokens(ws TEXT NOT NULL, id TEXT NOT NULL, member_id TEXT NOT NULL, name TEXT, hash TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'read', modules TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, last_used TEXT, hour TEXT, hour_uses INTEGER NOT NULL DEFAULT 0, day TEXT, day_uses INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(ws,id))",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_tok_hash ON api_tokens(hash)",
  "CREATE TABLE IF NOT EXISTS links(token TEXT PRIMARY KEY, ws TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, result TEXT, note TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_links_target ON links(ws, kind, target)"
];
// 나중에 더해진 칸 — 이미 있으면 그대로 둡니다
const ADD_COLS = [
  ["workspaces", "sp_ver INTEGER NOT NULL DEFAULT 0"],
  ["workspaces", "plan TEXT NOT NULL DEFAULT 'basic'"],
  ["workspaces", "modules TEXT NOT NULL DEFAULT '[]'"],
  ["workspaces", "limits TEXT"],
  ["workspaces", "plan_until TEXT"],
  ["sp_res", "channel TEXT"]
];

/* ───────── 공통 ───────── */
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (code, s = 400, extra) => json(Object.assign({ error: code }, extra || {}), s);
const ts = (ms = Date.now()) => String(ms).padStart(14, "0");
const iso = () => new Date().toISOString();
const parse = s => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };
const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const normId = s => String(s ?? "").trim().toLowerCase();
const ROLE_LIST = ["admin", "staff", "partner", "worker", "facility"];
const roleOk = r => ROLE_LIST.includes(r) ? r : "staff";
const isField = me => me.role === "worker" || me.role === "facility";   // 현장 역할 — 스페이스 화면만 씁니다
const isUnique = e => /UNIQUE|constraint/i.test(String((e && e.message) || e));
const hex = bytes => [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
function rand(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); }
const uid = p => p + "_" + Date.now().toString(36) + rand(3);
function inviteCode() { const a = new Uint8Array(6); crypto.getRandomValues(a); return [...a].map(x => INVITE_ABC[x % INVITE_ABC.length]).join(""); }
const bearer = req => (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
const byCreated = (a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || ""));

/* ───────── 비밀번호 ───────── */
const enc = new TextEncoder();
async function pbkdf2(raw, salt, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(raw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: iter }, key, 256);
  return hex(new Uint8Array(bits));
}
async function makePw(raw) { const salt = rand(8); return "p2$" + PW_ITER + "$" + salt + "$" + await pbkdf2(raw, salt, PW_ITER); }
function same(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function checkPw(stored, raw) {
  if (!stored || typeof raw !== "string" || !raw) return false;
  if (stored.startsWith("p2$")) { const [, it, salt, h] = stored.split("$"); return same(await pbkdf2(raw, salt, Number(it) || PW_ITER), h); }
  if (stored.startsWith("L$")) return same(legacyHash(raw), stored.slice(2));
  return false;
}
// 이전 버전(브라우저 저장 방식)의 비밀번호 해시 — 옛 백업·옛 데이터 로그인 호환용
function cyrb53(str, seed = 0) { let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed; for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909); return 4294967296 * (2097151 & h2) + (h1 >>> 0); }
const legacyHash = pw => cyrb53("mw:" + pw, 7).toString(36) + "." + cyrb53(pw + ":mw", 13).toString(36);
const pwFromBackup = h => !h ? null : String(h).startsWith("p2$") ? String(h) : "L$" + String(h);
const pwValid = p => typeof p === "string" && p.length >= 6 && p.length <= 128;

/* ───────── 저장 (여러 건을 한 문장으로) ───────── */
function refs(kind, d) {
  d = d || {};
  const scoped = kind === "task" || kind === "comment" || kind === "fin" || kind === "routine";
  const own = kind === "task" ? d.assigneeId : (kind === "plan" || kind === "fin") ? d.memberId : null;
  return { own: own ? String(own) : null, pid: scoped && d.projectId ? String(d.projectId) : null, sid: scoped && d.storeId ? String(d.storeId) : null };
}
const UPSERT = "INSERT INTO ent(ws,kind,id,data,deleted,ua,own,pid,sid) " +
  "SELECT ?1, json_extract(value,'$.k'), json_extract(value,'$.i'), json_extract(value,'$.d'), json_extract(value,'$.x'), ?2, json_extract(value,'$.o'), json_extract(value,'$.p'), json_extract(value,'$.s') FROM json_each(?3) WHERE true " +
  "ON CONFLICT(ws,kind,id) DO UPDATE SET data=excluded.data, deleted=excluded.deleted, ua=excluded.ua, " +
  "own=CASE WHEN excluded.deleted=1 THEN ent.own ELSE excluded.own END, " +
  "pid=CASE WHEN excluded.deleted=1 THEN ent.pid ELSE excluded.pid END, " +
  "sid=CASE WHEN excluded.deleted=1 THEN ent.sid ELSE excluded.sid END";
function upserts(db, ws, items, ua) {
  const out = []; let chunk = [], size = 2;
  const flush = () => { if (chunk.length) out.push(db.prepare(UPSERT).bind(ws, ua, JSON.stringify(chunk))); chunk = []; size = 2; };
  for (const it of items) {
    const r = it.deleted ? { own: null, pid: null, sid: null } : refs(it.kind, it.data);
    const row = { k: it.kind, i: String(it.id), d: it.deleted ? null : JSON.stringify(it.data), x: it.deleted ? 1 : 0, o: it.own !== undefined ? it.own : r.own, p: r.pid, s: r.sid };
    const n = enc.encode(JSON.stringify(row)).length + 1;
    if (size + n > 1500000) flush();
    chunk.push(row); size += n;
  }
  flush();
  return out;
}
const ACC_UPSERT = "INSERT INTO accounts(login_id,ws,member_id,pw,status,role,is_owner,name,contact,note,created_at,fails,lock_until) " +
  "SELECT json_extract(value,'$.l'), ?1, json_extract(value,'$.m'), json_extract(value,'$.p'), json_extract(value,'$.s'), json_extract(value,'$.r'), json_extract(value,'$.o'), json_extract(value,'$.n'), '', '', ?2, 0, 0 FROM json_each(?3) WHERE true " +
  "ON CONFLICT(login_id) DO UPDATE SET ws=excluded.ws, member_id=excluded.member_id, pw=excluded.pw, status=excluded.status, role=excluded.role, name=excluded.name, fails=0, lock_until=0";

const ACC_INSERT_IGNORE = "INSERT INTO accounts(login_id,ws,member_id,pw,status,role,is_owner,name,contact,note,created_at,fails,lock_until) " +
  "SELECT json_extract(value,'$.l'), ?1, json_extract(value,'$.m'), json_extract(value,'$.p'), json_extract(value,'$.s'), json_extract(value,'$.r'), json_extract(value,'$.o'), json_extract(value,'$.n'), '', '', ?2, 0, 0 FROM json_each(?3) WHERE true ON CONFLICT DO NOTHING";
const memberData = (id, lid, name, role, org, createdAt) => ({ id, loginId: lid, name, role, org: org || "", active: true, createdAt: createdAt || iso() });
// 스페이스용 구성원 정보 — 청소 건당 단가, 담당 지점(비우면 전체)
function memberSpace(target, b) {
  if (b.spRate !== undefined) { const n = Math.round(Number(b.spRate)); if (b.spRate === "" || b.spRate === null || !Number.isFinite(n)) delete target.spRate; else target.spRate = Math.max(0, Math.min(10000000, n)); }
  if (b.spStores !== undefined) target.spStores = Array.isArray(b.spStores) ? [...new Set(b.spStores.map(x => clip(x, 60)).filter(Boolean))].slice(0, 100) : [];
  return target;
}
const defaultTemplate = () => ({ id: uid("tp"), name: "외주 발주 세트", items: [{ title: "브리프·요구사항 전달", off: 0 }, { title: "중간 결과 확인", off: 7 }, { title: "결과물 검수", off: 14 }, { title: "정산 처리", off: 16 }] });
function seedWorkspace(db, ws, name, brands, member) {
  const tpl = defaultTemplate();
  return upserts(db, ws, [
    { kind: "meta", id: "ws", data: { workspace: name, brands, finCats: null } },
    { kind: "member", id: member.id, data: member },
    { kind: "template", id: tpl.id, data: tpl }
  ], ts());
}
async function freshInvite(db) {
  for (let i = 0; i < 6; i++) { const c = inviteCode(); if (!await db.prepare("SELECT 1 AS x FROM workspaces WHERE invite=?1").bind(c).first()) return c; }
  return inviteCode() + rand(1).toUpperCase();
}
const loginTaken = async (db, lid) => !!(await db.prepare("SELECT 1 AS x FROM accounts WHERE login_id=?1").bind(lid).first());

/* ───────── 준비 · 이전 버전 데이터 옮기기 ───────── */
async function ensure(db) {
  if (READY) return;
  let v = null;
  try { const r = await db.prepare("SELECT v FROM mw_meta WHERE k='schema'").first(); v = r && r.v; } catch (e) { v = null; }
  if (v !== SCHEMA) {
    // 표 만들기는 묶음(exec)으로 — 무료 플랜의 요청당 쿼리 수 한도를 넘지 않도록
    for (const group of [DDL, SP_DDL, OS_DDL, CM_DDL]) await db.exec(group.join("\n"));
    const have = {};
    for (const t of [...new Set(ADD_COLS.map(x => x[0]))]) have[t] = new Set((((await db.prepare(`PRAGMA table_info(${t})`).all()).results) || []).map(c => c.name));
    for (const [t, col] of ADD_COLS) {
      if (have[t] && have[t].has(col.split(" ")[0])) continue;
      try { await db.prepare(`ALTER TABLE ${t} ADD COLUMN ${col}`).run(); }
      catch (e) { if (!/duplicate column/i.test(String((e && e.message) || e))) throw e; }
    }
    await migrateLegacy(db);
    // 운영자 워크스페이스는 프로 + 스페이스로 시작합니다 (처음 올릴 때 한 번)
    if (v !== "4") await db.prepare("UPDATE workspaces SET plan='pro', modules=CASE WHEN modules='[]' THEN '[\"space\"]' ELSE modules END WHERE id IN (SELECT ws FROM accounts WHERE is_owner=1)").run();
    await db.prepare("INSERT OR REPLACE INTO mw_meta(k,v) VALUES('schema',?1)").bind(SCHEMA).run();
  }
  READY = true;
}
/* ───────── 등급·모듈 ───────── */
const planOk = p => PLANS.includes(p) ? p : "basic";
const modulesOk = m => [...new Set((Array.isArray(m) ? m : parse(m) || []).filter(x => MODULES.includes(x)))];
function tierOf(w) {   // 워크스페이스 행 → 지금 적용되는 등급·모듈·한도
  let plan = planOk(w.plan);
  if (plan === "pro" && w.plan_until && String(w.plan_until) < kstToday()) plan = "basic";   // 기한이 지나면 베이직 규칙 (데이터는 그대로)
  const lim = Object.assign({}, PLAN_LIMITS[plan], parse(w.limits) || {});
  return { plan, modules: plan === "pro" ? modulesOk(w.modules) : [], limits: { brands: intOr(lim.brands, 2), members: intOr(lim.members, 2), tokens: intOr(lim.tokens, 1) }, planUntil: w.plan_until || "", planRaw: planOk(w.plan) };
}
const limitFail = (what, limit) => fail("plan-limit", 403, { what, limit });
async function memberCount(db, ws) {   // 본인(첫 관리자)을 뺀 구성원 수 (승인 대기 제외)
  const r = await db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE ws=?1 AND status IN ('active','disabled')").bind(ws).first();
  return Math.max(0, (r ? Number(r.n) : 0) - 1);
}
async function migrateLegacy(db) {
  let meta = null;
  try { meta = await db.prepare("SELECT data FROM rows WHERE ws='main' AND kind='meta' AND id='ws'").first(); } catch (e) { return; }
  if (!meta) return;
  if (await db.prepare("SELECT 1 AS x FROM workspaces WHERE id='main'").first()) return;
  const m = parse(meta.data) || {};
  const rs = (await db.prepare("SELECT id,data,pw FROM rows WHERE ws='main' AND kind='member' AND deleted=0").all()).results || [];
  const hasOwner = !!(await db.prepare("SELECT v FROM mw_meta WHERE k='owner'").first());
  const members = rs.map(r => ({ id: r.id, d: parse(r.data) || {}, pw: r.pw })).filter(x => x.d.loginId && x.pw).sort((a, b) => byCreated(a.d, b.d));
  const ownerM = hasOwner ? null : members.find(x => x.d.role === "admin");
  const seen = new Set(), accs = [];
  for (const x of members) {
    const lid = normId(x.d.loginId); if (!lid || seen.has(lid)) continue; seen.add(lid);
    accs.push({ l: lid, m: x.id, p: "L$" + x.pw, s: x.d.active === false ? "disabled" : "active", r: roleOk(x.d.role), o: ownerM && x === ownerM ? 1 : 0, n: clip(x.d.name, 20) });
  }
  const now = iso();
  const stmts = [
    db.prepare("INSERT OR IGNORE INTO workspaces(id,name,status,admin_login,contact,note,invite,created_at,approved_at,last_active) VALUES('main',?1,'active',?2,'','',?3,?4,?4,?4)")
      .bind(clip(m.workspace || "마이웍스", 40), ownerM ? normId(ownerM.d.loginId) : (accs[0] ? accs[0].l : null), await freshInvite(db), now),
    db.prepare("INSERT INTO ent(ws,kind,id,data,deleted,ua,own,pid,sid) SELECT ws,kind,id,data,deleted,updated_at," +
      "CASE WHEN json_valid(data) THEN (CASE kind WHEN 'task' THEN json_extract(data,'$.assigneeId') WHEN 'plan' THEN json_extract(data,'$.memberId') WHEN 'fin' THEN json_extract(data,'$.memberId') ELSE NULL END) END," +
      "CASE WHEN json_valid(data) AND kind IN ('task','comment','fin','routine') THEN json_extract(data,'$.projectId') END," +
      "CASE WHEN json_valid(data) AND kind IN ('task','comment','fin','routine') THEN json_extract(data,'$.storeId') END " +
      "FROM rows WHERE ws='main' AND true ON CONFLICT(ws,kind,id) DO NOTHING"),
    db.prepare("UPDATE rows SET pw=NULL WHERE ws='main'")
  ];
  if (accs.length) stmts.push(db.prepare(ACC_INSERT_IGNORE).bind("main", now, JSON.stringify(accs)));
  if (ownerM) stmts.push(db.prepare("INSERT OR IGNORE INTO mw_meta(k,v) VALUES('owner',?1)").bind(normId(ownerM.d.loginId)));
  await db.batch(stmts);
}

/* ───────── 인증 ───────── */
async function auth(db, req) {
  const t = bearer(req); if (!t) return null;
  const r = await db.prepare("SELECT s.ws, s.member_id, s.seen, a.login_id, a.status AS ast, a.role, a.is_owner, a.name, w.status AS wst, w.name AS wname, w.invite, w.sp_ver, w.plan, w.modules, w.limits, w.plan_until FROM sess s JOIN accounts a ON a.ws=s.ws AND a.member_id=s.member_id JOIN workspaces w ON w.id=s.ws WHERE s.token=?1").bind(t).first();
  if (!r) return null;
  const now = Date.now();
  if (now - Number(r.seen) > SESSION_MS) { await db.prepare("DELETE FROM sess WHERE token=?1").bind(t).run(); return null; }
  if (r.ast !== "active") return null;
  if (r.wst === "suspended") return { err: "suspended" };
  if (r.wst !== "active") return null;
  if (now - Number(r.seen) > TOUCH_MS) await db.prepare("UPDATE sess SET seen=?1 WHERE token=?2").bind(now, t).run();
  return meFrom(r, { token: t });
}
function meFrom(r, extra) {
  const tier = tierOf(r);
  return Object.assign({ ws: r.ws, id: r.member_id, lid: r.login_id, role: roleOk(r.role), owner: !!r.is_owner, name: r.name, wname: r.wname, invite: r.invite, spv: Number(r.sp_ver) || 0, plan: tier.plan, modules: tier.modules, limits: tier.limits, planUntil: tier.planUntil }, extra || {});
}
const hasMod = (me, m) => me.plan === "pro" && me.modules.includes(m);
const tierInfo = me => ({ plan: me.plan, modules: me.modules, limits: me.limits, planUntil: me.planUntil || "" });

/* ───────── 열람 범위 (협력사) ───────── */
function visFrom(me, projects, stores, myPids) {
  const P = new Set(), S = new Set();
  for (const [id, d] of projects) if (d && (d.ownerId === me.id || (Array.isArray(d.memberIds) && d.memberIds.includes(me.id)) || myPids.has(id))) P.add(id);
  for (const [id, d] of stores) if (d && (d.managerId === me.id || (Array.isArray(d.memberIds) && d.memberIds.includes(me.id)))) S.add(id);
  return { P, S, at: Date.now() };
}
async function loadVis(db, me, fresh) {
  const key = me.ws + "|" + me.id, c = VIS.get(key);
  if (!fresh && c && Date.now() - c.at < 120000) return c;
  const rs = (await db.prepare("SELECT kind,id,data FROM ent WHERE ws=?1 AND kind IN ('project','store') AND deleted=0").bind(me.ws).all()).results || [];
  const mine = (await db.prepare("SELECT DISTINCT pid FROM ent WHERE ws=?1 AND kind='task' AND own=?2 AND deleted=0 AND pid IS NOT NULL").bind(me.ws, me.id).all()).results || [];
  const projects = [], stores = [];
  for (const r of rs) (r.kind === "project" ? projects : stores).push([r.id, parse(r.data)]);
  const v = visFrom(me, projects, stores, new Set(mine.map(x => x.pid)));
  VIS.set(key, v);
  if (VIS.size > 500) VIS.delete(VIS.keys().next().value);
  return v;
}
const rawStrip = (raw, fields) => { const d = parse(raw); if (!d) return raw; for (const f of fields) delete d[f]; return JSON.stringify(d); };
const rawOk = raw => typeof raw === "string" && raw.charCodeAt(0) === 123 && raw.charCodeAt(raw.length - 1) === 125;   // { ... }
// 역할에 맞게 보낼 내용을 정합니다. null = 보내지 않음, deleted = 그 화면에서 지움 (data는 저장된 JSON 문자열)
function pick(me, r, vis) {
  const k = r.kind;
  if (k === "plan") return r.own === me.id ? r : null;                 // 플랜은 본인 것만 (모든 역할)
  if (me.role === "admin" || me.role === "staff") return r;
  if (MGR_ONLY.has(k)) return null;                                     // 연락처·AI 제안은 관리자·직원만
  if (k === "meta") return r;
  if (k === "act") return r.own === me.id ? r : null;
  if (k === "member") return r.deleted || r.id === me.id ? r : { ...r, data: rawStrip(r.data, ["loginId", "spRate"]) };
  if (isField(me)) {   // 청소 근무자·시설 담당은 본인에게 배정된 업무만 받습니다
    if (k === "task") return !r.deleted && r.own === me.id ? r : { ...r, data: null, deleted: 1 };
    return null;
  }
  if (k === "fin" || k === "routine" || k === "template") return null;   // 금액·운영 설정은 협력사에 보내지 않음
  if (r.deleted) return r;
  let ok = false;
  if (k === "project") ok = vis.P.has(r.id);
  else if (k === "store") ok = vis.S.has(r.id);
  else if (k === "task") ok = r.own === me.id || (!!r.pid && vis.P.has(r.pid)) || (!!r.sid && vis.S.has(r.sid));
  else if (k === "comment") ok = (!!r.pid && vis.P.has(r.pid)) || (!!r.sid && vis.S.has(r.sid));
  if (!ok) return { ...r, data: null, deleted: 1 };
  if (k === "project") return { ...r, data: rawStrip(r.data, STRIP.project) };
  if (k === "store") return { ...r, data: rawStrip(r.data, STRIP.store) };
  return r;
}
const rawJson = (head, extra) => new Response(JSON.stringify(head).slice(0, -1) + extra + "}", { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
async function badgesFor(db, me) {
  if (!me.owner && me.role !== "admin") return {};
  const r = await db.prepare("SELECT (SELECT COUNT(*) FROM workspaces WHERE status='pending') AS pw, (SELECT COUNT(*) FROM accounts WHERE ws=?1 AND status='pending') AS jr").bind(me.ws).first();
  const out = {};
  if (me.owner) out.pendingWs = r ? Number(r.pw) : 0;
  if (me.role === "admin") out.joinReq = r ? Number(r.jr) : 0;
  return out;
}

/* ───────── 백업 파일 ───────── */
const isBackup = d => !!(d && typeof d === "object" && d.meta && d.meta.app === "myworks" && Array.isArray(d.members));
function backupItems(data, extraMembers) {
  const items = [{ kind: "meta", id: "ws", data: { workspace: clip(data.meta.workspace, 40) || "마이웍스", brands: Array.isArray(data.brands) ? data.brands : [], finCats: data.finCats || null } }];
  for (const [kind, arr] of Object.entries(ARR)) {
    const list = (Array.isArray(data[arr]) ? data[arr] : []).concat(kind === "member" ? (extraMembers || []) : []);
    const seen = new Set();
    for (const it of list) {
      if (!it || typeof it !== "object" || it.id == null) continue;
      const id = String(it.id); if (!id || seen.has(id) || id.length > 120) continue; seen.add(id);
      const d = { ...it }; if (kind === "member") delete d.pwHash;
      items.push({ kind, id, data: d, own: kind === "act" ? (d.by ? String(d.by) : null) : undefined });
    }
  }
  return items;
}
async function planAccounts(db, ws, members, keep) {
  const lids = [...new Set(members.map(m => normId(m.loginId)).filter(Boolean))];
  const ex = lids.length ? ((await db.prepare("SELECT login_id, ws, member_id, pw, is_owner FROM accounts WHERE login_id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(lids)).all()).results || []) : [];
  const exMap = new Map(ex.map(a => [a.login_id, a]));
  const accs = [], conflicts = [], used = new Set(), usedIds = new Set();
  for (const m of members) {
    const lid = normId(m.loginId);
    if (!lid || used.has(lid) || usedIds.has(String(m.id))) continue;
    const e = exMap.get(lid);
    if (e && e.ws !== ws) { conflicts.push(lid); continue; }
    const pw = (keep && keep.has(lid) && e) ? e.pw : (m.pwHash ? pwFromBackup(m.pwHash) : (e ? e.pw : null));
    if (!pw) continue;
    used.add(lid); usedIds.add(String(m.id));
    accs.push({ l: lid, m: String(m.id), p: pw, s: m.active === false ? "disabled" : "active", r: roleOk(m.role), o: e ? Number(e.is_owner) || 0 : 0, n: clip(m.name, 20) });
  }
  return { accs, conflicts, used };
}

/* ───────── 공개 API ───────── */
const PUBLIC = {
  async status(db) {
    const o = await db.prepare("SELECT v FROM mw_meta WHERE k='owner'").first();
    return json({ ok: true, v: 2, initialized: !!o });
  },

  // 플랫폼 최초 설정 — 운영자 계정 + 운영자 워크스페이스
  async "owner-setup"(db, b) {
    const lid = normId(b.loginId), name = clip(b.name, 20), wsName = clip(b.workspace, 40) || "마이웍스";
    if (!name) return fail("bad-request");
    if (!ID_RE.test(lid)) return fail("bad-id");
    if (!pwValid(b.pw)) return fail("bad-pw");
    if (await db.prepare("SELECT v FROM mw_meta WHERE k='owner'").first()) return fail("initialized", 409);
    if (await loginTaken(db, lid)) return fail("taken", 409);
    const ws = "w_" + rand(6), mid = uid("m"), now = iso(), token = rand(24);
    const brands = Array.isArray(b.brands) ? b.brands.map(x => clip(x, 30)).filter(Boolean).slice(0, 40) : [];
    const member = memberData(mid, lid, name, "admin", wsName, now);
    try {
      await db.batch([
        db.prepare("INSERT INTO mw_meta(k,v) VALUES('owner',?1)").bind(lid),
        db.prepare("INSERT INTO workspaces(id,name,status,admin_login,contact,note,invite,created_at,approved_at,last_active,plan,modules) VALUES(?1,?2,'active',?3,?4,'',?5,?6,?6,?6,'pro','[\"space\"]')").bind(ws, wsName, lid, clip(b.contact, 60), await freshInvite(db), now),
        db.prepare("INSERT INTO accounts(login_id,ws,member_id,pw,status,role,is_owner,name,contact,note,created_at) VALUES(?1,?2,?3,?4,'active','admin',1,?5,?6,'',?7)").bind(lid, ws, mid, await makePw(b.pw), name, clip(b.contact, 60), now),
        ...seedWorkspace(db, ws, wsName, brands.length ? brands : [wsName, "기타"], member),
        db.prepare("INSERT INTO sess(token,ws,member_id,created_at,seen) VALUES(?1,?2,?3,?4,?5)").bind(token, ws, mid, now, Date.now())
      ]);
    } catch (e) { if (isUnique(e)) return fail("initialized", 409); throw e; }
    return json({ ok: true, token });
  },

  // 플랫폼 최초 설정 — 예전에 쓰던 백업 파일로 시작
  async "owner-restore"(db, b) {
    if (await db.prepare("SELECT v FROM mw_meta WHERE k='owner'").first()) return fail("initialized", 409);
    const data = b.data;
    if (!isBackup(data)) return fail("bad-backup");
    const members = data.members.filter(m => m && m.id != null && m.loginId).slice().sort(byCreated);
    const owner = members.find(m => m.role === "admin" && m.pwHash);
    if (!owner) return fail("bad-backup");
    const ws = "w_" + rand(6), now = iso(), wsName = clip(data.meta.workspace, 40) || "마이웍스";
    const ownerLid = normId(owner.loginId);
    const plan = await planAccounts(db, ws, members, null);
    const accs = plan.accs.map(a => a.l === ownerLid ? { ...a, o: 1, s: "active", r: "admin" } : a);
    if (!accs.some(a => a.l === ownerLid)) return fail("taken", 409);
    try {
      await db.batch([
        db.prepare("INSERT INTO mw_meta(k,v) VALUES('owner',?1)").bind(ownerLid),
        db.prepare("INSERT INTO workspaces(id,name,status,admin_login,contact,note,invite,created_at,approved_at,last_active,plan,modules) VALUES(?1,?2,'active',?3,'','',?4,?5,?5,?5,'pro','[\"space\"]')").bind(ws, wsName, ownerLid, await freshInvite(db), now),
        db.prepare(ACC_UPSERT).bind(ws, now, JSON.stringify(accs)),
        ...upserts(db, ws, backupItems(data), ts())
      ]);
    } catch (e) { if (isUnique(e)) return fail("initialized", 409); throw e; }
    return json({ ok: true, owner: ownerLid, conflicts: plan.conflicts });
  },

  // 회원가입 — 새 워크스페이스 개설 신청(운영자 승인) 또는 초대 코드로 합류 신청(관리자 승인)
  async signup(db, b) {
    if (!await db.prepare("SELECT v FROM mw_meta WHERE k='owner'").first()) return fail("not-initialized", 409);
    const mode = b.mode === "join" ? "join" : "new";
    const lid = normId(b.loginId), name = clip(b.name, 20), contact = clip(b.contact, 60), note = clip(b.note, 300);
    if (!name) return fail("bad-request");
    if (!ID_RE.test(lid)) return fail("bad-id");
    if (!pwValid(b.pw)) return fail("bad-pw");
    if (await loginTaken(db, lid)) return fail("taken", 409);
    const now = iso(), mid = uid("m"), pw = await makePw(b.pw);
    try {
      if (mode === "new") {
        const wsName = clip(b.workspace, 40);
        if (!wsName || !contact) return fail("bad-request");
        const c = await db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE status='pending'").first();
        if (c && Number(c.n) >= MAX_PENDING_WS) return fail("busy", 429);
        const ws = "w_" + rand(6);
        await db.batch([
          db.prepare("INSERT INTO workspaces(id,name,status,admin_login,contact,note,invite,created_at) VALUES(?1,?2,'pending',?3,?4,?5,NULL,?6)").bind(ws, wsName, lid, contact, note, now),
          db.prepare("INSERT INTO accounts(login_id,ws,member_id,pw,status,role,is_owner,name,contact,note,created_at) VALUES(?1,?2,?3,?4,'pending','admin',0,?5,?6,?7,?8)").bind(lid, ws, mid, pw, name, contact, note, now)
        ]);
        return json({ ok: true, status: "pending", mode, workspace: wsName });
      }
      const code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const w = code ? await db.prepare("SELECT id,name,status FROM workspaces WHERE invite=?1").bind(code).first() : null;
      if (!w || w.status !== "active") return fail("bad-code", 404);
      const c = await db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE ws=?1 AND status='pending'").bind(w.id).first();
      if (c && Number(c.n) >= MAX_PENDING_JOIN) return fail("busy", 429);
      await db.prepare("INSERT INTO accounts(login_id,ws,member_id,pw,status,role,is_owner,name,contact,note,created_at) VALUES(?1,?2,?3,?4,'pending','staff',0,?5,?6,?7,?8)").bind(lid, w.id, mid, pw, name, contact, note, now).run();
      return json({ ok: true, status: "pending", mode, workspace: w.name });
    } catch (e) { if (isUnique(e)) return fail("taken", 409); throw e; }
  },

  async login(db, b) {
    const lid = normId(b.loginId), now = Date.now();
    if (!lid || typeof b.pw !== "string") return fail("invalid", 401);
    const a = await db.prepare("SELECT * FROM accounts WHERE login_id=?1").bind(lid).first();
    if (!a) return fail("invalid", 401);
    if (Number(a.lock_until) > now) return fail("locked", 429, { minutes: Math.ceil((Number(a.lock_until) - now) / 60000) });
    if (!await checkPw(a.pw, b.pw)) {
      const fails = Number(a.fails) + 1;
      if (fails >= LOCK_FAILS) await db.prepare("UPDATE accounts SET fails=0, lock_until=?1 WHERE login_id=?2").bind(now + LOCK_MS, lid).run();
      else await db.prepare("UPDATE accounts SET fails=?1 WHERE login_id=?2").bind(fails, lid).run();
      return fail("invalid", 401);
    }
    const w = await db.prepare("SELECT status FROM workspaces WHERE id=?1").bind(a.ws).first();
    const wst = w ? w.status : "missing";
    if (a.status === "pending") return fail(wst === "pending" ? "ws-pending" : "join-pending", 403);
    if (a.status === "rejected" || wst === "rejected") return fail("ws-rejected", 403);
    if (a.status === "disabled") return fail("inactive", 403);
    if (wst === "suspended") return fail("suspended", 403);
    if (wst !== "active") return fail("ws-pending", 403);
    const token = rand(24), stmts = [
      db.prepare("INSERT INTO sess(token,ws,member_id,created_at,seen) VALUES(?1,?2,?3,?4,?5)").bind(token, a.ws, a.member_id, iso(), now),
      db.prepare("UPDATE accounts SET fails=0, lock_until=0, last_login=?1 WHERE login_id=?2").bind(iso(), lid)
    ];
    if (String(a.pw).startsWith("L$")) stmts.push(db.prepare("UPDATE accounts SET pw=?1 WHERE login_id=?2").bind(await makePw(b.pw), lid));   // 옛 방식 비밀번호를 새 방식으로 교체
    if (Math.random() < 0.05) stmts.push(db.prepare("DELETE FROM sess WHERE seen<?1").bind(now - SESSION_MS));
    await db.batch(stmts);
    return json({ ok: true, token });
  },

  async logout(db, b, req) {
    const t = bearer(req);
    if (t) await db.prepare("DELETE FROM sess WHERE token=?1").bind(t).run();
    return json({ ok: true });
  }
};

/* ───────── 로그인 후 API ───────── */
const PRIVATE = {
  async state(db, me) {
    const start = Date.now();
    const all = (await db.prepare("SELECT kind,id,data,own,pid,sid FROM ent WHERE ws=?1 AND deleted=0").bind(me.ws).all()).results || [];
    let vis = null, meta = {};
    if (me.role === "partner") {
      const projects = [], stores = [], myPids = new Set();
      for (const r of all) {
        if (r.kind === "project") projects.push([r.id, parse(r.data)]);
        else if (r.kind === "store") stores.push([r.id, parse(r.data)]);
        else if (r.kind === "task" && r.own === me.id && r.pid) myPids.add(r.pid);
      }
      vis = visFrom(me, projects, stores, myPids);
      VIS.set(me.ws + "|" + me.id, vis);
    }
    const parts = {};
    for (const r of all) {
      if (!rawOk(r.data)) continue;
      if (r.kind === "meta") { meta = parse(r.data) || {}; continue; }
      const v = pick(me, r, vis);
      if (!v || v.deleted) continue;
      (parts[r.kind] = parts[r.kind] || []).push(v.data);
    }
    const name = meta.workspace || me.wname;
    const entities = Object.entries(parts).map(([k, list]) => JSON.stringify(k) + ":[" + list.join(",") + "]").join(",");
    return rawJson({ ok: true, me: me.id, role: me.role, owner: me.owner, ws: { id: me.ws, name, invite: me.role === "admin" ? me.invite : undefined }, workspace: name, meta, badges: await badgesFor(db, me), spv: me.spv, tier: tierInfo(me), now: ts(start - MARGIN) }, ',"entities":{' + entities + "}");
  },

  async sync(db, me, b, req, url) {
    const start = Date.now();
    const since = ((url.searchParams.get("since") || "0").replace(/[^0-9]/g, "").slice(0, 14) || "0").padStart(14, "0");
    const rs = (await db.prepare("SELECT kind,id,data,deleted,own,pid,sid FROM ent WHERE ws=?1 AND ua>=?2").bind(me.ws, since).all()).results || [];
    let vis = null;
    if (me.role === "partner" && rs.some(r => !r.deleted && ["project", "store", "task", "comment"].includes(r.kind))) {
      const structural = rs.some(r => r.kind === "project" || r.kind === "store");
      vis = await loadVis(db, me, structural);
      if (!structural && rs.some(r => r.kind === "task" && !r.deleted && r.own === me.id && r.pid && !vis.P.has(r.pid))) vis = await loadVis(db, me, true);
    }
    const out = [];
    for (const r of rs) {
      if (!r.deleted && !rawOk(r.data)) continue;
      const v = pick(me, { ...r, deleted: r.deleted ? 1 : 0 }, vis);
      if (!v) continue;
      out.push('{"kind":' + JSON.stringify(v.kind) + ',"id":' + JSON.stringify(v.id) + (v.deleted ? ',"deleted":1,"data":null}' : ',"deleted":0,"data":' + v.data + "}"));
    }
    return rawJson({ ok: true, badges: await badgesFor(db, me), inv: me.role === "admin" ? me.invite : undefined, spv: me.spv, tier: tierInfo(me), now: ts(start - MARGIN) }, ',"rows":[' + out.join(",") + "]");
  },

  async push(db, me, b) {
    const ops = Array.isArray(b.ops) ? b.ops : [];
    if (ops.length > 5000) return fail("too-many-ops", 413);
    const list = []; let dropped = 0;
    for (const o of ops) {
      if (!o || typeof o !== "object") { dropped++; continue; }
      const kind = String(o.kind || ""), id = String(o.id ?? ""), del = !!o.deleted;
      const data = del ? null : (o.data && typeof o.data === "object" && !Array.isArray(o.data) ? o.data : null);
      const okKind = kind === "meta" ? (id === "ws" && !del) : (!!ARR[kind] && kind !== "member");
      if (!okKind || !id || id.length > 120 || (!del && !data) || (!del && kind !== "meta" && data.id != null && String(data.id) !== id)) { dropped++; continue; }
      list.push({ kind, id, data, deleted: del });
    }
    const partner = me.role === "partner";
    const lookup = async (kind, ids) => {
      if (!ids.length) return new Map();
      const rs = (await db.prepare("SELECT id,data,own,pid,sid FROM ent WHERE ws=?1 AND kind=?2 AND id IN (SELECT value FROM json_each(?3))").bind(me.ws, kind, JSON.stringify(ids)).all()).results || [];
      return new Map(rs.map(r => [r.id, r]));
    };
    const planEx = await lookup("plan", list.filter(x => x.kind === "plan").map(x => x.id));
    let vis = null, taskEx = new Map(), cmtEx = new Map(), storeEx = new Map();
    const field = isField(me);
    if (field) taskEx = await lookup("task", list.filter(x => x.kind === "task" && !x.deleted).map(x => x.id));
    if (partner && list.some(x => ["task", "comment", "store"].includes(x.kind))) {
      vis = await loadVis(db, me, false);
      taskEx = await lookup("task", list.filter(x => x.kind === "task").map(x => x.id));
      cmtEx = await lookup("comment", list.filter(x => x.kind === "comment" && x.deleted).map(x => x.id));
      storeEx = await lookup("store", list.filter(x => x.kind === "store").map(x => x.id));
    }
    const seeScope = (pid, sid) => (!!pid && vis.P.has(pid)) || (!!sid && vis.S.has(sid));
    const items = []; let metaName = null;
    for (const x of list) {
      let ok = true;
      if (x.kind === "plan") { const e = planEx.get(x.id); ok = (!e || !e.own || e.own === me.id) && (x.deleted || String(x.data.memberId || "") === me.id); }
      else if (x.kind === "meta") ok = me.role === "admin" || me.role === "staff";
      else if (field) {   // 현장 역할: 본인 업무의 진행 상태와 활동 기록만 반영됩니다
        if (x.kind === "task") {
          const e = taskEx.get(x.id);
          ok = !x.deleted && !!e && e.own === me.id;
          if (ok) { const cur = parse(e.data) || {}; x.data = { ...cur, status: clip(x.data.status, 20) || cur.status, updatedAt: x.data.updatedAt || cur.updatedAt }; }
        } else ok = x.kind === "act";
      }
      else if (partner) {
        if (x.kind === "task") {
          const e = taskEx.get(x.id);
          if (x.deleted) ok = !!e && seeScope(e.pid, e.sid);
          else { const r = refs("task", x.data); ok = seeScope(r.pid, r.sid) || (!!e && e.own === me.id); }
        } else if (x.kind === "comment") {
          if (x.deleted) { const e = cmtEx.get(x.id); ok = !!e && seeScope(e.pid, e.sid); }
          else { const r = refs("comment", x.data); ok = seeScope(r.pid, r.sid); }
        } else if (x.kind === "store") {
          const e = storeEx.get(x.id);
          ok = !x.deleted && !!e && vis.S.has(x.id);
          if (ok) {   // 협력사는 점검 기록만 반영됩니다
            const cur = parse(e.data) || {};
            x.data = { ...cur, checks: Array.isArray(x.data.checks) ? x.data.checks.slice(0, 30) : (cur.checks || []), updatedAt: x.data.updatedAt || cur.updatedAt };
          }
        } else ok = x.kind === "act" || x.kind === "plan";
      }
      else if (MGR_ONLY.has(x.kind)) ok = me.role === "admin" || me.role === "staff";
      if (!ok) { dropped++; continue; }
      if (x.kind === "meta" && x.data) {
        if (x.data.workspace) metaName = clip(x.data.workspace, 40);
        if (Array.isArray(x.data.brands) && x.data.brands.length > me.limits.brands) return limitFail("brands", me.limits.brands);   // 베이직은 브랜드 2개까지
      }
      items.push({ kind: x.kind, id: x.id, data: x.data, deleted: x.deleted, own: x.kind === "act" ? me.id : undefined });
    }
    if (items.length) {
      const now = ts();
      const stmts = upserts(db, me.ws, items, now);
      stmts.push(db.prepare("UPDATE workspaces SET last_active=?1" + (metaName ? ", name=?3" : "") + " WHERE id=?2").bind(...(metaName ? [iso(), me.ws, metaName] : [iso(), me.ws])));
      await db.batch(stmts);
      if (items.some(x => x.kind === "project" || x.kind === "store")) for (const k of VIS.keys()) if (k.startsWith(me.ws + "|")) VIS.delete(k);
    }
    return json({ ok: true, now: ts(), saved: items.length, dropped });
  },

  async password(db, me, b) {
    const a = await db.prepare("SELECT pw FROM accounts WHERE ws=?1 AND member_id=?2").bind(me.ws, me.id).first();
    if (!a || !await checkPw(a.pw, b.old)) return fail("bad-password");
    if (!pwValid(b.pw)) return fail("bad-pw");
    await db.batch([
      db.prepare("UPDATE accounts SET pw=?1, fails=0, lock_until=0 WHERE ws=?2 AND member_id=?3").bind(await makePw(b.pw), me.ws, me.id),
      db.prepare("DELETE FROM sess WHERE ws=?1 AND member_id=?2 AND token<>?3").bind(me.ws, me.id, me.token)
    ]);
    return json({ ok: true });
  },

  /* 구성원 — 관리자 전용 */
  async "member/create"(db, me, b) {
    if (me.role !== "admin") return fail("forbidden", 403);
    const lid = normId(b.loginId), name = clip(b.name, 20), role = roleOk(b.role), org = clip(b.org, 30);
    if (!name) return fail("bad-request");
    if (!ID_RE.test(lid)) return fail("bad-id");
    if (!pwValid(b.pw)) return fail("bad-pw");
    if (await loginTaken(db, lid)) return fail("taken", 409);
    if (await memberCount(db, me.ws) >= me.limits.members) return limitFail("members", me.limits.members);
    const member = memberSpace(memberData(uid("m"), lid, name, role, org), b);
    try {
      await db.batch([
        db.prepare("INSERT INTO accounts(login_id,ws,member_id,pw,status,role,is_owner,name,contact,note,created_at) VALUES(?1,?2,?3,?4,'active',?5,0,?6,'','',?7)").bind(lid, me.ws, member.id, await makePw(b.pw), role, name, iso()),
        ...upserts(db, me.ws, [{ kind: "member", id: member.id, data: member }], ts())
      ]);
    } catch (e) { if (isUnique(e)) return fail("taken", 409); throw e; }
    return json({ ok: true, member });
  },

  async "member/update"(db, me, b) {
    if (me.role !== "admin") return fail("forbidden", 403);
    const id = String(b.id || "");
    const row = await db.prepare("SELECT data FROM ent WHERE ws=?1 AND kind='member' AND id=?2 AND deleted=0").bind(me.ws, id).first();
    if (!row) return fail("not-found", 404);
    const cur = parse(row.data) || {};
    const acc = await db.prepare("SELECT login_id, is_owner FROM accounts WHERE ws=?1 AND member_id=?2").bind(me.ws, id).first();
    const next = { ...cur };
    if (b.name !== undefined) { const n = clip(b.name, 20); if (!n) return fail("bad-request"); next.name = n; }
    if (b.org !== undefined) next.org = clip(b.org, 30);
    if (b.role !== undefined) next.role = roleOk(b.role);
    if (b.active !== undefined) next.active = !!b.active;
    memberSpace(next, b);
    if ((id === me.id || (acc && Number(acc.is_owner))) && (next.role !== "admin" || next.active === false)) return fail("self");
    let lid = acc ? acc.login_id : normId(cur.loginId);
    if (b.loginId !== undefined && normId(b.loginId) !== lid) {
      const nl = normId(b.loginId);
      if (!ID_RE.test(nl)) return fail("bad-id");
      if (await loginTaken(db, nl)) return fail("taken", 409);
      lid = nl;
    }
    next.loginId = lid;
    let pwNew = null;
    if (b.pw) { if (!pwValid(b.pw)) return fail("bad-pw"); pwNew = await makePw(b.pw); }
    const status = next.active === false ? "disabled" : "active";
    const stmts = [];
    if (acc) {
      stmts.push(db.prepare("UPDATE accounts SET login_id=?1, role=?2, name=?3, status=CASE WHEN status IN ('active','disabled') THEN ?4 ELSE status END, pw=COALESCE(?5,pw), fails=CASE WHEN ?5 IS NULL THEN fails ELSE 0 END, lock_until=CASE WHEN ?5 IS NULL THEN lock_until ELSE 0 END WHERE ws=?6 AND member_id=?7")
        .bind(lid, next.role, next.name, status, pwNew, me.ws, id));
      if (acc.login_id !== lid) stmts.push(db.prepare("UPDATE workspaces SET admin_login=?1 WHERE id=?2 AND admin_login=?3").bind(lid, me.ws, acc.login_id));
    } else if (pwNew) {   // 비밀번호 없이 옮겨진 구성원에게 계정을 새로 만듭니다
      if (await loginTaken(db, lid)) return fail("taken", 409);
      stmts.push(db.prepare("INSERT INTO accounts(login_id,ws,member_id,pw,status,role,is_owner,name,contact,note,created_at) VALUES(?1,?2,?3,?4,?5,?6,0,?7,'','',?8)").bind(lid, me.ws, id, pwNew, status, next.role, next.name, iso()));
    }
    if (next.active === false || pwNew) stmts.push(db.prepare("DELETE FROM sess WHERE ws=?1 AND member_id=?2 AND token<>?3").bind(me.ws, id, me.token));
    if (next.active === false || (next.role !== "admin" && next.role !== "staff")) stmts.push(db.prepare("UPDATE api_tokens SET revoked=1, hash=hash||'~'||?3 WHERE ws=?1 AND member_id=?2 AND revoked=0").bind(me.ws, id, rand(4)));   // 관리자·직원이 아니게 되면 AI 토큰도 회수
    stmts.push(...upserts(db, me.ws, [{ kind: "member", id, data: next }], ts()));
    try { await db.batch(stmts); } catch (e) { if (isUnique(e)) return fail("taken", 409); throw e; }
    return json({ ok: true, member: next });
  },

  async "member/delete"(db, me, b) {
    if (me.role !== "admin") return fail("forbidden", 403);
    const id = String(b.id || "");
    if (id === me.id) return fail("self");
    const acc = await db.prepare("SELECT is_owner FROM accounts WHERE ws=?1 AND member_id=?2").bind(me.ws, id).first();
    if (acc && Number(acc.is_owner)) return fail("self");
    await db.batch([
      db.prepare("DELETE FROM accounts WHERE ws=?1 AND member_id=?2").bind(me.ws, id),
      db.prepare("DELETE FROM sess WHERE ws=?1 AND member_id=?2").bind(me.ws, id),
      db.prepare("UPDATE api_tokens SET revoked=1, hash=hash||'~'||?3 WHERE ws=?1 AND member_id=?2 AND revoked=0").bind(me.ws, id, rand(4)),
      ...upserts(db, me.ws, [{ kind: "member", id, deleted: 1 }], ts())
    ]);
    return json({ ok: true });
  },

  /* 합류 요청·초대 코드 — 관리자 전용 */
  async "ws/requests"(db, me) {
    if (me.role !== "admin") return fail("forbidden", 403);
    const rs = (await db.prepare("SELECT login_id, name, contact, note, created_at FROM accounts WHERE ws=?1 AND status='pending' ORDER BY created_at").bind(me.ws).all()).results || [];
    return json({ ok: true, requests: rs.map(r => ({ loginId: r.login_id, name: r.name, contact: r.contact || "", note: r.note || "", createdAt: r.created_at })) });
  },

  async "ws/decide"(db, me, b) {
    if (me.role !== "admin") return fail("forbidden", 403);
    const lid = normId(b.loginId);
    const a = await db.prepare("SELECT * FROM accounts WHERE login_id=?1 AND ws=?2 AND status='pending'").bind(lid, me.ws).first();
    if (!a) return fail("not-found", 404);
    if (!b.approve) { await db.prepare("DELETE FROM accounts WHERE login_id=?1").bind(lid).run(); return json({ ok: true }); }
    if (await memberCount(db, me.ws) >= me.limits.members) return limitFail("members", me.limits.members);
    const role = ["partner", "admin", "worker", "facility"].includes(b.role) ? b.role : "staff";
    const member = memberData(a.member_id, lid, a.name, role, "", iso());
    await db.batch([
      db.prepare("UPDATE accounts SET status='active', role=?1 WHERE login_id=?2").bind(role, lid),
      ...upserts(db, me.ws, [{ kind: "member", id: member.id, data: member }], ts())
    ]);
    return json({ ok: true, member });
  },

  async "ws/invite"(db, me) {
    if (me.role !== "admin") return fail("forbidden", 403);
    const invite = await freshInvite(db);
    await db.prepare("UPDATE workspaces SET invite=?1 WHERE id=?2").bind(invite, me.ws).run();
    return json({ ok: true, invite });
  },

  /* 등급·모듈 — 프로 워크스페이스의 관리자가 모듈을 켜고 끕니다 (데이터는 꺼도 남습니다) */
  async "ws/modules"(db, me, b) {
    if (me.role !== "admin") return fail("forbidden", 403);
    if (me.plan !== "pro") return fail("plan-limit", 403, { what: "modules", limit: 0 });
    const modules = modulesOk(b.modules);
    await db.prepare("UPDATE workspaces SET modules=?1 WHERE id=?2").bind(JSON.stringify(modules), me.ws).run();
    return json({ ok: true, modules });
  },
  /* 워크스페이스 설정 (AI 제안 자동 반영 등) — 관리자 */
  async "ws/settings"(db, me, b) {
    if (me.role !== "admin" && me.role !== "staff") return fail("forbidden", 403);
    if (b && b.set && typeof b.set === "object") {
      if (me.role !== "admin") return fail("forbidden", 403);
      const rows = [];
      if (b.set.ai_auto !== undefined) rows.push(["ai_auto", JSON.stringify([...new Set((Array.isArray(b.set.ai_auto) ? b.set.ai_auto : []).filter(k => AI_KINDS.includes(k)))])]);
      if (b.set.ai_note !== undefined) rows.push(["ai_note", JSON.stringify(clip(b.set.ai_note, 1000))]);
      if (rows.length) await db.batch(rows.map(([k, v]) => db.prepare("INSERT INTO ws_set(ws,k,v) VALUES(?1,?2,?3) ON CONFLICT(ws,k) DO UPDATE SET v=excluded.v").bind(me.ws, k, v)));
    }
    return json({ ok: true, settings: await wsSettings(db, me.ws) });
  },

  /* AI 접속 토큰 — 관리자·직원. 토큰 원문은 만들 때 한 번만 보여 주고 해시만 저장합니다 */
  async "token/create"(db, me, b) {
    if (me.role !== "admin" && me.role !== "staff") return fail("forbidden", 403);
    const scope = b.scope === "write" ? "write" : "read";
    if (scope === "write" && me.plan !== "pro") return fail("plan-limit", 403, { what: "write-token", limit: 0 });
    const c = await db.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE ws=?1 AND revoked=0").bind(me.ws).first();
    if (c && Number(c.n) >= me.limits.tokens) return limitFail("tokens", me.limits.tokens);
    const raw = "mw_" + rand(16), id = uid("k"), name = clip(b.name, 40) || "AI 접속";
    const mods = modulesOk(b.modules).filter(m => me.modules.includes(m));
    await db.prepare("INSERT INTO api_tokens(ws,id,member_id,name,hash,scope,modules,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)").bind(me.ws, id, me.id, name, await sha256(raw), scope, JSON.stringify(mods), iso()).run();
    return json({ ok: true, token: raw, item: { id, name, scope, modules: mods, memberId: me.id, createdAt: iso(), lastUsed: "", dayUses: 0 } });
  },
  async "token/list"(db, me) {
    if (me.role !== "admin" && me.role !== "staff") return fail("forbidden", 403);
    const rs = (await db.prepare("SELECT id, member_id, name, scope, modules, created_at, last_used, day, day_uses FROM api_tokens WHERE ws=?1 AND revoked=0" + (me.role === "admin" ? "" : " AND member_id=?2") + " ORDER BY created_at").bind(...(me.role === "admin" ? [me.ws] : [me.ws, me.id])).all()).results || [];
    return json({ ok: true, tokens: rs.map(r => ({ id: r.id, memberId: r.member_id, name: r.name, scope: r.scope, modules: parse(r.modules) || [], createdAt: r.created_at, lastUsed: r.last_used || "", dayUses: r.day === kstToday() ? Number(r.day_uses) : 0 })), limit: me.limits.tokens });
  },
  async "token/revoke"(db, me, b) {
    if (me.role !== "admin" && me.role !== "staff") return fail("forbidden", 403);
    const id = clip(b.id, 60);
    const r = await db.prepare("UPDATE api_tokens SET revoked=1, hash=hash||'~'||?3 WHERE ws=?1 AND id=?2 AND revoked=0" + (me.role === "admin" ? "" : " AND member_id=?4")).bind(...(me.role === "admin" ? [me.ws, id, rand(4)] : [me.ws, id, rand(4), me.id])).run();
    if (!r || !r.meta || !r.meta.changes) return fail("not-found", 404);
    return json({ ok: true });
  },

  /* 확인 링크 — 계정 없는 고객·거래처에게 보내는 승인·확인 페이지 */
  async "link/create"(db, me, b) {
    if (me.role === "partner" || isField(me)) return fail("forbidden", 403);
    const kind = String(b.kind || "");
    if (!LINK_KINDS[kind]) return fail("bad-request");
    const target = clip(b.target, 60);
    if (!target || !await LINK_KINDS[kind].exists(db, me, target)) return fail("not-found", 404);
    const days = clampInt(b.days, 1, 180, 30), token = rand(16), now = Date.now();
    await db.batch([
      db.prepare("UPDATE links SET expires_at=?3 WHERE ws=?1 AND kind=?2 AND target=?4 AND used_at IS NULL").bind(me.ws, kind, new Date(now - 1000).toISOString(), target),   // 같은 대상의 이전 링크는 닫습니다
      db.prepare("INSERT INTO links(token,ws,kind,target,created_by,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7)").bind(token, me.ws, kind, target, me.id, iso(), new Date(now + days * 864e5).toISOString())
    ]);
    return json({ ok: true, token, expiresAt: new Date(now + days * 864e5).toISOString() });
  },
  async "link/list"(db, me, b) {
    if (me.role === "partner" || isField(me)) return fail("forbidden", 403);
    const kind = String(b.kind || ""), target = clip(b.target, 60);
    const rs = (await db.prepare("SELECT token, created_at, expires_at, used_at, result, note FROM links WHERE ws=?1 AND kind=?2 AND target=?3 ORDER BY created_at DESC LIMIT 5").bind(me.ws, kind, target).all()).results || [];
    return json({ ok: true, links: rs.map(r => ({ token: r.token, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at || "", result: r.result || "", note: r.note || "" })) });
  },

  /* 백업·복원·초기화 — 관리자 전용 */
  async backup(db, me) {
    if (me.role !== "admin") return fail("forbidden", 403);
    const all = (await db.prepare("SELECT kind,id,data FROM ent WHERE ws=?1 AND deleted=0").bind(me.ws).all()).results || [];
    const accs = (await db.prepare("SELECT member_id, pw FROM accounts WHERE ws=?1 AND status IN ('active','disabled')").bind(me.ws).all()).results || [];
    const pw = new Map(accs.map(a => [a.member_id, a.pw]));
    const lists = {}; for (const arr of Object.values(ARR)) lists[arr] = [];
    let meta = {};
    for (const r of all) {
      if (!rawOk(r.data)) continue;
      if (r.kind === "meta") { meta = parse(r.data) || {}; continue; }
      if (!ARR[r.kind]) continue;
      let raw = r.data;
      if (r.kind === "member" && pw.get(r.id)) { const d = parse(raw); if (d) { d.pwHash = pw.get(r.id); raw = JSON.stringify(d); } }
      lists[ARR[r.kind]].push(raw);
    }
    const head = { meta: { app: "myworks", ver: 3, workspace: meta.workspace || me.wname, createdAt: iso(), updatedAt: iso(), exportedAt: iso() }, brands: meta.brands || [], finCats: meta.finCats || null };
    const space = await spBackupRaw(db, me.ws), mods = await modBackupRaw(db, me.ws);
    const backup = JSON.stringify(head).slice(0, -1) + "," + Object.entries(lists).map(([k, list]) => JSON.stringify(k) + ":[" + list.join(",") + "]").join(",") + ',"space":' + space + ',"mods":' + mods + "}";
    return new Response('{"ok":true,"backup":' + backup + "}", { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  },

  async restore(db, me, b) {
    if (me.role !== "admin") return fail("forbidden", 403);
    const data = b.data;
    if (!isBackup(data)) return fail("bad-backup");
    const members = data.members.filter(m => m && m.id != null && m.loginId).map(m => ({ ...m }));
    // 복원하는 관리자와 운영자 계정은 접속이 끊기지 않도록 지킵니다
    const prot = (await db.prepare("SELECT login_id, member_id, is_owner FROM accounts WHERE ws=?1 AND (member_id=?2 OR is_owner=1)").bind(me.ws, me.id).all()).results || [];
    const keep = new Set(prot.map(a => a.login_id));
    const extra = [];
    for (const a of prot) {
      const m = members.find(x => normId(x.loginId) === a.login_id);
      if (m) { m.role = "admin"; m.active = true; continue; }
      const row = await db.prepare("SELECT data FROM ent WHERE ws=?1 AND kind='member' AND id=?2").bind(me.ws, a.member_id).first();
      const cur = parse(row && row.data) || memberData(a.member_id, a.login_id, me.name || "관리자", "admin", "");
      const add = { ...cur, loginId: a.login_id, role: "admin", active: true };
      if (members.some(x => String(x.id) === String(add.id))) add.id = uid("m");
      members.push(add); extra.push(add);
    }
    const plan = await planAccounts(db, me.ws, members, keep);
    if (Array.isArray(data.brands) && data.brands.length > me.limits.brands) return limitFail("brands", me.limits.brands);   // 등급 한도는 복원에도 적용
    if (plan.accs.length - 1 > me.limits.members) return limitFail("members", me.limits.members);
    const myLid = me.lid, myAcc = plan.accs.find(a => a.l === myLid);
    const myNewId = myAcc ? myAcc.m : me.id;
    const byId = new Map(members.map(m => [String(m.id), m]));
    const items = backupItems(data, extra).map(it => {
      if (it.kind !== "member" || !byId.has(it.id)) return it;
      const d = { ...byId.get(it.id) }; delete d.pwHash;
      return { ...it, data: d };
    });
    const wsName = clip(data.meta.workspace, 40) || me.wname;
    const now = iso();
    const spR = spRestoreStmts(db, me.ws, data.space), modR = modRestoreStmts(db, me.ws, data.mods);
    const dels = spR.dels.concat(modR.dels);
    if (dels.length) await db.exec(dels.join("\n"));   // 모듈 표 비우기 (한 번에)
    await db.batch([
      db.prepare("DELETE FROM ent WHERE ws=?1").bind(me.ws),
      db.prepare("DELETE FROM accounts WHERE ws=?1 AND status IN ('active','disabled') AND is_owner=0 AND login_id NOT IN (SELECT value FROM json_each(?2))").bind(me.ws, JSON.stringify([...plan.used])),
      db.prepare("UPDATE accounts SET member_id='~'||login_id WHERE ws=?1 AND status IN ('active','disabled')").bind(me.ws),
      db.prepare(ACC_UPSERT).bind(me.ws, now, JSON.stringify(plan.accs)),
      ...upserts(db, me.ws, items, ts()),
      ...spR.stmts,    // 스페이스 데이터가 든 백업이면 함께 되돌립니다 (없으면 그대로 둠)
      ...modR.stmts,   // 아웃소싱·커머스 데이터도 같은 방식
      db.prepare("UPDATE workspaces SET name=?1, last_active=?2, sp_ver=sp_ver+1 WHERE id=?3").bind(wsName, now, me.ws),
      db.prepare("DELETE FROM sess WHERE ws=?1 AND token<>?2").bind(me.ws, me.token),
      db.prepare("UPDATE sess SET member_id=?1 WHERE token=?2").bind(myNewId, me.token)
    ]);
    for (const k of VIS.keys()) if (k.startsWith(me.ws + "|")) VIS.delete(k);
    return json({ ok: true, conflicts: plan.conflicts });
  },

  async wipe(db, me) {
    if (me.role !== "admin") return fail("forbidden", 403);
    const now = ts(), tpl = defaultTemplate();
    await db.exec(spWipeSql(me.ws).concat(OS_TABLES.concat(["cm_order", "cm_inquiry", "cm_cost"]).map(t => `DELETE FROM ${t} WHERE ws=${wsLit(me.ws)}`)).join("\n"));   // 스페이스·안건·주문 기록은 지우고, 운영 시간·공통 체크리스트·상품·채널·설정은 남깁니다
    await db.batch([
      db.prepare("UPDATE ent SET deleted=1, data=NULL, ua=?1 WHERE ws=?2 AND kind NOT IN ('member','meta') AND deleted=0").bind(now, me.ws),
      ...upserts(db, me.ws, [{ kind: "template", id: tpl.id, data: tpl }], ts(Date.now() + 1)),
      db.prepare("UPDATE workspaces SET sp_ver=sp_ver+1 WHERE id=?1").bind(me.ws)
    ]);
    return json({ ok: true });
  },

  /* 운영 콘솔 — 운영자 전용 (업무 내용은 다루지 않습니다) */
  async "admin/overview"(db, me) {
    if (!me.owner) return fail("forbidden", 403);
    const ws = (await db.prepare("SELECT w.*, a.name AS admin_name, a.contact AS admin_contact FROM workspaces w LEFT JOIN accounts a ON a.login_id=w.admin_login ORDER BY w.created_at DESC").all()).results || [];
    const cnt = (await db.prepare("SELECT ws, COUNT(*) AS n FROM accounts WHERE status IN ('active','disabled') GROUP BY ws").all()).results || [];
    const n = new Map(cnt.map(c => [c.ws, Number(c.n)]));
    return json({ ok: true, workspaces: ws.map(w => { const t = tierOf(w); return { id: w.id, name: w.name, status: w.status, adminLogin: w.admin_login || "", adminName: w.admin_name || "", contact: w.contact || w.admin_contact || "", note: w.note || "", createdAt: w.created_at, approvedAt: w.approved_at || "", lastActive: w.last_active || "", members: n.get(w.id) || 0, mine: w.id === me.ws, plan: t.planRaw, planNow: t.plan, modules: modulesOk(w.modules), planUntil: w.plan_until || "", limits: parse(w.limits) || {} }; }) });
  },

  async "admin/ws"(db, me, b) {
    if (!me.owner) return fail("forbidden", 403);
    const w = await db.prepare("SELECT * FROM workspaces WHERE id=?1").bind(String(b.id || "")).first();
    if (!w) return fail("not-found", 404);
    const act = String(b.action || "");
    if (act === "plan") {   // 등급·모듈·기한·한도 — 운영자 본인 워크스페이스도 바꿀 수 있습니다
      const plan = planOk(b.plan), modules = plan === "pro" ? modulesOk(b.modules) : [];
      const until = dOk(b.until) || null;
      const lim = {}; const L = b.limits && typeof b.limits === "object" ? b.limits : {};
      for (const k of ["brands", "members", "tokens"]) if (L[k] !== undefined && L[k] !== "" && L[k] !== null) { const n = clampInt(L[k], 0, 100000, null); if (n !== null) lim[k] = n; }
      await db.prepare("UPDATE workspaces SET plan=?1, modules=?2, plan_until=?3, limits=?4 WHERE id=?5").bind(plan, JSON.stringify(modules), until, Object.keys(lim).length ? JSON.stringify(lim) : null, w.id).run();
      return json({ ok: true, plan, modules, planUntil: until || "", limits: lim });
    }
    if (w.id === me.ws) return fail("self");
    const now = iso();
    if (act === "approve") {
      if (w.status !== "pending") return fail("bad-state");
      const a = await db.prepare("SELECT * FROM accounts WHERE login_id=?1 AND ws=?2").bind(w.admin_login || "", w.id).first();
      if (!a) return fail("not-found", 404);
      const member = memberData(a.member_id, a.login_id, a.name, "admin", w.name, a.created_at);
      await db.batch([
        db.prepare("UPDATE workspaces SET status='active', approved_at=?1, last_active=?1, invite=?2 WHERE id=?3").bind(now, await freshInvite(db), w.id),
        db.prepare("UPDATE accounts SET status='active', role='admin' WHERE login_id=?1").bind(a.login_id),
        ...seedWorkspace(db, w.id, w.name, [w.name, "기타"], member)
      ]);
      return json({ ok: true, loginId: a.login_id });
    }
    if (act === "reject") {
      if (w.status !== "pending") return fail("bad-state");
      await db.batch([
        db.prepare("UPDATE workspaces SET status='rejected' WHERE id=?1").bind(w.id),
        db.prepare("UPDATE accounts SET status='rejected' WHERE ws=?1").bind(w.id)
      ]);
      return json({ ok: true });
    }
    if (act === "suspend" || act === "activate") {
      if (act === "suspend" && w.status !== "active") return fail("bad-state");
      if (act === "activate" && w.status !== "suspended") return fail("bad-state");
      const stmts = [db.prepare("UPDATE workspaces SET status=?1 WHERE id=?2").bind(act === "suspend" ? "suspended" : "active", w.id)];
      if (act === "suspend") stmts.push(db.prepare("DELETE FROM sess WHERE ws=?1").bind(w.id));
      await db.batch(stmts);
      return json({ ok: true });
    }
    if (act === "delete") {
      await db.exec(SP_TABLES.concat(OS_TABLES, CM_TABLES, ["ws_set", "api_tokens", "links", "mod_set"]).map(t => `DELETE FROM ${t} WHERE ws=${wsLit(w.id)}`).join("\n"));
      await db.batch([
        db.prepare("DELETE FROM ent WHERE ws=?1").bind(w.id),
        db.prepare("DELETE FROM sess WHERE ws=?1").bind(w.id),
        db.prepare("DELETE FROM accounts WHERE ws=?1").bind(w.id),
        db.prepare("DELETE FROM workspaces WHERE id=?1").bind(w.id)
      ]);
      return json({ ok: true });
    }
    if (act === "resetpw") {
      if (!pwValid(b.pw)) return fail("bad-pw");
      let a = w.admin_login ? await db.prepare("SELECT login_id, member_id FROM accounts WHERE login_id=?1 AND ws=?2 AND role='admin'").bind(w.admin_login, w.id).first() : null;
      if (!a) a = await db.prepare("SELECT login_id, member_id FROM accounts WHERE ws=?1 AND role='admin' AND status='active' ORDER BY created_at LIMIT 1").bind(w.id).first();
      if (!a) return fail("not-found", 404);
      await db.batch([
        db.prepare("UPDATE accounts SET pw=?1, fails=0, lock_until=0 WHERE login_id=?2").bind(await makePw(b.pw), a.login_id),
        db.prepare("DELETE FROM sess WHERE ws=?1 AND member_id=?2").bind(w.id, a.member_id),
        db.prepare("UPDATE workspaces SET admin_login=?1 WHERE id=?2").bind(a.login_id, w.id)
      ]);
      return json({ ok: true, loginId: a.login_id });
    }
    return fail("bad-request");
  }
};

/* ═════════ 스페이스 — 공간 운영 (예약 → 청소 배정 → 체크리스트 → 확인 → 손익) ═════════
   · 지점 = 마이웍스 매장. 매장마다 스페이스 운영 여부와 운영 프로필(sp_prof)을 둡니다.
   · 담당자·제출자 칸에는 구성원 id를 저장합니다. (예전 스페이스에서 가져온 기록은 이름이 남아 있을 수 있습니다)
   · 청소 근무자·시설 담당에게는 예약자 이름·연락처·금액을 보내지 않습니다. */
const SP_DDL = [
  "CREATE TABLE IF NOT EXISTS sp_prof(ws TEXT NOT NULL, sid TEXT NOT NULL, d TEXT NOT NULL, ua TEXT, PRIMARY KEY(ws,sid))",
  "CREATE TABLE IF NOT EXISTS sp_set(ws TEXT NOT NULL, k TEXT NOT NULL, v TEXT, PRIMARY KEY(ws,k))",
  "CREATE TABLE IF NOT EXISTS sp_chk(ws TEXT NOT NULL, id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'common', branch_id TEXT, category TEXT, label TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(ws,id))",
  "CREATE TABLE IF NOT EXISTS sp_res(ws TEXT NOT NULL, id TEXT NOT NULL, branch_id TEXT, res_date TEXT NOT NULL, slot TEXT NOT NULL DEFAULT 'etc', resno TEXT, customer TEXT, phone TEXT, amount INTEGER NOT NULL DEFAULT 0, status TEXT, issue TEXT, memo TEXT, start_t TEXT, end_t TEXT, source TEXT NOT NULL DEFAULT 'manual', created_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_sp_res_date ON sp_res(ws,res_date)",
  "CREATE INDEX IF NOT EXISTS idx_sp_res_no ON sp_res(ws,resno)",
  "CREATE TABLE IF NOT EXISTS sp_cln(ws TEXT NOT NULL, id TEXT NOT NULL, task_key TEXT NOT NULL, branch_id TEXT, clean_date TEXT, kind TEXT, assignee TEXT, status TEXT NOT NULL DEFAULT 'todo', checks TEXT, note TEXT, submitted_by TEXT, submitted_name TEXT, submitted_at TEXT, review_by TEXT, review_name TEXT, review_at TEXT, feedback TEXT, manual INTEGER NOT NULL DEFAULT 0, window_label TEXT, created_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_sp_cln_key ON sp_cln(ws,task_key)",
  "CREATE INDEX IF NOT EXISTS idx_sp_cln_date ON sp_cln(ws,clean_date)",
  "CREATE TABLE IF NOT EXISTS sp_iss(ws TEXT NOT NULL, id TEXT NOT NULL, branch_id TEXT, category TEXT, equip TEXT, title TEXT NOT NULL, detail TEXT, priority TEXT, status TEXT NOT NULL DEFAULT '접수', reporter TEXT, reporter_name TEXT, assignee TEXT, cost INTEGER, comments TEXT NOT NULL DEFAULT '[]', created_at TEXT, resolved_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE TABLE IF NOT EXISTS sp_chn(ws TEXT NOT NULL, id TEXT NOT NULL, branch_id TEXT, channel TEXT NOT NULL, url TEXT, status TEXT, owner TEXT, last_check TEXT, memo TEXT, sort INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(ws,id))",
  "CREATE TABLE IF NOT EXISTS sp_cost(ws TEXT NOT NULL, ym TEXT NOT NULL, branch_id TEXT NOT NULL, rent INTEGER NOT NULL DEFAULT 0, mgmt INTEGER NOT NULL DEFAULT 0, supplies INTEGER NOT NULL DEFAULT 0, telecom INTEGER NOT NULL DEFAULT 0, misc INTEGER NOT NULL DEFAULT 0, fee_pct REAL NOT NULL DEFAULT 0, PRIMARY KEY(ws,ym,branch_id))",
  "CREATE TABLE IF NOT EXISTS sp_asg(ws TEXT NOT NULL, id TEXT NOT NULL, date TEXT NOT NULL, region TEXT NOT NULL DEFAULT '', branch_id TEXT NOT NULL DEFAULT '', worker TEXT, created_by TEXT, created_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_sp_asg_u ON sp_asg(ws,date,region,branch_id)",
  "CREATE TABLE IF NOT EXISTS sp_ntc(ws TEXT NOT NULL, id TEXT NOT NULL, date TEXT NOT NULL, body TEXT NOT NULL, created_by TEXT, created_name TEXT, created_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_sp_ntc_date ON sp_ntc(ws,date)",
  "CREATE TABLE IF NOT EXISTS sp_read(ws TEXT NOT NULL, notice_id TEXT NOT NULL, member_id TEXT NOT NULL, member_name TEXT, read_at TEXT, PRIMARY KEY(ws,notice_id,member_id))",
  "CREATE TABLE IF NOT EXISTS sp_log(ws TEXT NOT NULL, ran_at TEXT NOT NULL, by_name TEXT, ok INTEGER, added INTEGER, updated INTEGER, removed INTEGER, skipped INTEGER, message TEXT, PRIMARY KEY(ws,ran_at))"
];
const SP_TABLES = ["sp_prof", "sp_set", "sp_chk", "sp_res", "sp_cln", "sp_iss", "sp_chn", "sp_cost", "sp_asg", "sp_ntc", "sp_read", "sp_log"];
const SPC = {
  sp_prof: ["sid", "d", "ua"],
  sp_set: ["k", "v"],
  sp_chk: ["id", "scope", "branch_id", "category", "label", "sort", "active"],
  sp_res: ["id", "branch_id", "res_date", "slot", "resno", "customer", "phone", "amount", "status", "issue", "memo", "start_t", "end_t", "source", "created_at", "channel"],
  sp_cln: ["id", "task_key", "branch_id", "clean_date", "kind", "assignee", "status", "checks", "note", "submitted_by", "submitted_name", "submitted_at", "review_by", "review_name", "review_at", "feedback", "manual", "window_label", "created_at"],
  sp_iss: ["id", "branch_id", "category", "equip", "title", "detail", "priority", "status", "reporter", "reporter_name", "assignee", "cost", "comments", "created_at", "resolved_at"],
  sp_chn: ["id", "branch_id", "channel", "url", "status", "owner", "last_check", "memo", "sort"],
  sp_cost: ["ym", "branch_id", "rent", "mgmt", "supplies", "telecom", "misc", "fee_pct"],
  sp_asg: ["id", "date", "region", "branch_id", "worker", "created_by", "created_at"],
  sp_ntc: ["id", "date", "body", "created_by", "created_name", "created_at"],
  sp_read: ["notice_id", "member_id", "member_name", "read_at"],
  sp_log: ["ran_at", "by_name", "ok", "added", "updated", "removed", "skipped", "message"]
};
const SPJ = { sp_cln: { checks: "{}" }, sp_iss: { comments: "[]" }, sp_prof: { d: "{}" }, sp_set: { v: "null" } };   // JSON으로 저장하는 칸
const SP_SLOTS = ["day", "night", "allday", "etc"];
const SP_KINDS = ["day", "night", "allday", "mid", "etc"];
const SP_CLN_ST = ["todo", "done", "redo", "confirmed", "skip"];
const SP_ISS_ST = ["접수", "확인", "진행중", "완료", "보류"];
const SP_PRIO = ["보통", "긴급", "낮음"];
const SP_CH_ST = ["운영중", "등록필요", "점검필요", "중단"];
const SP_PRESETS = ["네이버 플레이스·예약", "네이버 지도·내비", "네이버 블로그", "스페이스클라우드", "여기어때", "프빗(Pvit)", "인스타그램", "유튜브", "당근마켓", "카카오톡 채널", "자체 홈페이지"];
const SP_DEF = {
  times: { day: ["12:00", "17:00"], night: ["19:00", "10:00"], allday: ["12:00", "22:00"] },
  clean_before_min: 30, mid_deadline: "18:30", std_minutes: 120, concurrent_warn: 3,
  quick_items: ["환기·탈취", "테이블·바닥 간단 정리", "쓰레기·음식물 정리", "화장실 점검(휴지·물내림)", "다음 예약 옵션·비품 준비 확인"]
};
const SP_SEED = [
  ["증빙·상태 확인", "퇴실 직후 전체 영상 촬영(30초~1분)"], ["증빙·상태 확인", "오염·파손·분실·흡연·구토 여부 확인"], ["증빙·상태 확인", "차감 가능성 있으면 정리 전 사진 확보"],
  ["쓰레기·분리수거", "쓰레기·음식물 수거 및 처리"], ["쓰레기·분리수거", "분리수거(일반·플라스틱·캔·유리) / 문밖 무단배출 확인"],
  ["주방·설거지", "설거지·식기 건조, 식기 수량 확인"], ["주방·설거지", "싱크대·인덕션·조리대 정리"], ["주방·설거지", "냉장고·전자레인지 내부 오염 확인"],
  ["실내 청소", "테이블·소파 얼룩 제거 및 정돈"], ["실내 청소", "바닥 청소기·밀대(머리카락·끈적임 확인)"], ["실내 청소", "포토존·창틀·소품 정돈"],
  ["화장실", "변기·세면대·거울 청소"], ["화장실", "휴지·물비누 보충, 배수·냄새 확인"],
  ["기기·비품", "전자기기·리모컨·마이크 원위치 및 작동 확인"], ["기기·비품", "TV·와이파이·냉난방 작동 확인"], ["기기·비품", "보드게임·소품 수량 확인"],
  ["마무리", "환기·탈취 후 냉난방·조명·전원 정리"], ["마무리", "소모품 재고 확인(휴지·물티슈·봉투·배터리)"], ["마무리", "도어락 작동·문 잠금 확인"], ["마무리", "청소 완료 사진 기록, 다음 예약 가능 상태 공유"]
];

const isMgr = me => me.role === "admin" || me.role === "staff";
const dOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? String(s) : "";
const ymOk = s => /^\d{4}-\d{2}$/.test(String(s || "")) ? String(s) : "";
const tOk = s => { const m = String(s ?? "").match(/^\s*(\d{1,2}):(\d{2})/); return m && +m[1] < 48 && +m[2] < 60 ? String(+m[1]).padStart(2, "0") + ":" + m[2] : ""; };
const intOr = (v, d = 0) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : d; };
const clampInt = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && v !== "" && v !== null ? Math.min(hi, Math.max(lo, n)) : d; };
function addDaysS(ds, n) { const d = new Date(ds + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);   // 한국 시간 기준 오늘
const bulkId = p => p + "_" + Date.now().toString(36) + rand(6);
function dhash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return "d" + h.toString(16); }
function spSettings(s) {
  s = s && typeof s === "object" ? s : {};
  const times = {};
  for (const k of ["day", "night", "allday"]) { const v = s.times && s.times[k]; times[k] = Array.isArray(v) && tOk(v[0]) && tOk(v[1]) ? [tOk(v[0]), tOk(v[1])] : SP_DEF.times[k].slice(); }
  return {
    times, clean_before_min: clampInt(s.clean_before_min, 0, 600, 30), mid_deadline: tOk(s.mid_deadline) || "18:30",
    std_minutes: clampInt(s.std_minutes, 10, 720, 120), concurrent_warn: clampInt(s.concurrent_warn, 1, 50, 3),
    quick_items: Array.isArray(s.quick_items) ? s.quick_items.map(x => clip(x, 80)).filter(Boolean).slice(0, 30) : SP_DEF.quick_items.slice(),
    fees: spFees(s.fees)
  };
}
// 예약 채널별 플랫폼 수수료율(%) — 손익에서 실수령액 계산에 씁니다. 비워 두면(모두 0) 월 비용의 수수료율을 씁니다
const SP_CHANNELS = ["naver", "spacecloud", "airbnb", "direct", "other"];
function spFees(f) {
  f = f && typeof f === "object" ? f : {};
  const o = {};
  for (const k of SP_CHANNELS) { const n = Number(f[k]); o[k] = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n * 100) / 100)) : 0; }
  return o;
}
// 외부 AI용 오늘 요약 (관리자·직원 토큰) — 예약자 연락처는 보내지 않습니다
async function spAiToday(db, me) {
  const today = kstToday(), tmr = addDaysS(today, 1), mgr = isMgr(me);
  const sc = await spScope(db, me);
  const [res, cln, iss] = await db.batch([
    db.prepare("SELECT id, branch_id, res_date, slot, start_t, end_t, customer, amount, status, issue, source FROM sp_res WHERE ws=?1 AND res_date>=?2 AND res_date<=?3 ORDER BY res_date, start_t").bind(me.ws, today, tmr),
    db.prepare("SELECT id, branch_id, clean_date, kind, status, assignee, submitted_name FROM sp_cln WHERE ws=?1 AND (clean_date=?2 OR status='done') LIMIT 200").bind(me.ws, today),
    db.prepare("SELECT id, branch_id, title, status, priority, created_at FROM sp_iss WHERE ws=?1 AND status NOT IN ('완료','보류') ORDER BY created_at DESC LIMIT 50").bind(me.ws)
  ]);
  const bn = id => { const b = sc.branches.find(x => x.id === id); return b ? b.name : ""; };
  const names = new Map(((await db.prepare("SELECT id, json_extract(data,'$.name') AS name FROM ent WHERE ws=?1 AND kind='member' AND deleted=0").bind(me.ws).all()).results || []).map(r => [r.id, r.name]));
  const R = ((res && res.results) || []).filter(r => sc.vis.has(r.branch_id) && !String(r.status || "").includes("취소")).map(r => ({ date: r.res_date, branch: bn(r.branch_id), slot: r.slot, start: r.start_t || "", end: r.end_t || "", customer: mgr ? (r.customer || "") : "", amount: mgr ? r.amount : undefined, issue: r.issue || "", source: r.source }));
  const C = (cln && cln.results) || [];
  return {
    today, reservations: { today: R.filter(r => r.date === today), tomorrow: R.filter(r => r.date === tmr) },
    cleaningToday: C.filter(c => c.clean_date === today).map(c => ({ branch: bn(c.branch_id), kind: c.kind, status: c.status, assignee: names.get(c.assignee) || c.assignee || "" })),
    pendingReview: C.filter(c => c.status === "done").map(c => ({ id: c.id, branch: bn(c.branch_id), date: c.clean_date, by: c.submitted_name || "" })),
    openIssues: ((iss && iss.results) || []).map(i => ({ id: i.id, branch: i.branch_id ? bn(i.branch_id) : "공통", title: i.title, status: i.status, priority: i.priority })),
    branches: sc.branches.filter(b => b.on).map(b => b.name)
  };
}

/* 한 행 = JSON 한 줄로 받아 그대로 이어 붙입니다 (서버 계산을 줄이기 위해) */
function spSel(t, where, tail) {
  const pairs = SPC[t].map(c => SPJ[t] && SPJ[t][c] !== undefined ? `'${c}',CASE WHEN json_valid(${c}) THEN json(${c}) ELSE json('${SPJ[t][c]}') END` : `'${c}',${c}`);
  return `SELECT json_object(${pairs.join(",")}) AS j FROM ${t} WHERE ${where}${tail ? " " + tail : ""}`;
}
const rawArr = r => "[" + ((r && r.results) || []).map(x => x.j).join(",") + "]";
const rowsOf = r => ((r && r.results) || []).map(x => parse(x.j)).filter(Boolean);
function spIns(t, conflict) {
  const cols = SPC[t];
  return `INSERT ${conflict === "ignore" ? "OR IGNORE " : ""}INTO ${t}(ws,${cols.join(",")}) SELECT ?1,${cols.map(c => `json_extract(value,'$.${c}')`).join(",")} FROM json_each(?2) WHERE true` + (conflict && conflict !== "ignore" ? " " + conflict : "");
}
function spBulk(db, t, ws, rows, conflict) {
  const out = [], sql = spIns(t, conflict); let chunk = [], size = 2;
  const flush = () => { if (chunk.length) out.push(db.prepare(sql).bind(ws, "[" + chunk.join(",") + "]")); chunk = []; size = 2; };
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = {};
    for (const c of SPC[t]) {
      let v = r[c];
      if (v === undefined) v = null;
      if (SPJ[t] && SPJ[t][c] !== undefined && typeof v === "string") v = parse(v);
      if (typeof v === "boolean") v = v ? 1 : 0;
      o[c] = v;
    }
    const s = JSON.stringify(o), n = enc.encode(s).length + 1;
    if (size + n > 1500000) flush();
    chunk.push(s); size += n;
  }
  flush();
  return out;
}
// 쓰기와 함께 워크스페이스의 스페이스 변경 번호를 올립니다 (다른 기기가 새로 받아야 하는지 판단용)
async function spRun(db, me, stmts) {
  const list = stmts.filter(Boolean);
  list.push(db.prepare("UPDATE workspaces SET sp_ver=sp_ver+1 WHERE id=?1 RETURNING sp_ver").bind(me.ws));
  const rs = await db.batch(list);
  const last = rs[rs.length - 1];
  return { rs, v: last && last.results && last.results[0] ? Number(last.results[0].sp_ver) : null };
}
async function spOne(db, t, ws, id) {
  const r = await db.prepare(spSel(t, "ws=?1 AND id=?2")).bind(ws, String(id)).first();
  return r ? parse(r.j) : null;
}
const storeOk = async (db, me, sid) => !!sid && !!(await db.prepare("SELECT 1 AS x FROM ent WHERE ws=?1 AND kind='store' AND id=?2 AND deleted=0").bind(me.ws, String(sid)).first());
// 스페이스 지점 목록과 이 사람이 볼 수 있는 범위
async function spScope(db, me) {
  const [st, pf, mm] = await db.batch([
    db.prepare("SELECT id, data FROM ent WHERE ws=?1 AND kind='store' AND deleted=0").bind(me.ws),
    db.prepare("SELECT sid, d FROM sp_prof WHERE ws=?1").bind(me.ws),
    db.prepare("SELECT data FROM ent WHERE ws=?1 AND kind='member' AND id=?2").bind(me.ws, me.id)
  ]);
  const prof = new Map(((pf && pf.results) || []).map(r => [r.sid, parse(r.d) || {}]));
  const mine = parse(mm && mm.results && mm.results[0] && mm.results[0].data) || {};
  const allow = !isMgr(me) && Array.isArray(mine.spStores) && mine.spStores.length ? new Set(mine.spStores.map(String)) : null;
  const branches = [];
  for (const r of (st && st.results) || []) {
    const d = parse(r.data); if (!d) continue;
    const p = prof.get(r.id) || {};
    const b = { id: r.id, name: clip(d.name, 60), region: clip(d.region, 30), status: d.status || "운영중", brand: clip(d.brand, 30), on: p.on ? 1 : 0, alias: p.alias || "", scode: p.scode || "", worker: p.worker || "", std: p.std ?? null, buf: p.buf ?? null, mid: p.mid || "", slots: p.slots || null, rules: p.rules || "", sort: Number(p.sort) || 0 };
    if (!isMgr(me) && (!b.on || (allow && !allow.has(b.id)))) continue;
    branches.push(b);
  }
  return { branches, vis: new Set(branches.filter(b => b.on).map(b => b.id)), mine };
}
// 개별 지정이 없을 때 실제 담당: 그날 지점 일괄 배정 → 권역 일괄 배정 → 지점 기본 담당
async function spEffAssignee(db, me, sc, bid, cd) {
  const br = sc.branches.find(x => x.id === bid) || {};
  const rs = (await db.prepare("SELECT branch_id, region, worker FROM sp_asg WHERE ws=?1 AND date=?2 AND (branch_id=?3 OR (branch_id='' AND region<>'' AND region=?4))").bind(me.ws, cd, bid, br.region || "").all()).results || [];
  const own = rs.find(r => r.branch_id === bid), reg = rs.find(r => !r.branch_id);
  return (own && own.worker) || (reg && reg.worker) || br.worker || "";
}
let OWNER_WS = "";
async function ownerWs(db) {
  if (OWNER_WS) return OWNER_WS;
  const r = await db.prepare("SELECT ws FROM accounts WHERE is_owner=1 LIMIT 1").first();
  OWNER_WS = r ? r.ws : "";
  return OWNER_WS;
}
// 호스트 예약 DB(HOSTDB)는 운영자 워크스페이스에서만 읽습니다 — 다른 워크스페이스가 남의 예약을 가져갈 수 없도록
async function hostInfo(db, me, env) {
  const bound = !!(env && env.HOSTDB);
  return { bound, allowed: bound && isMgr(me) && me.ws === await ownerWs(db) };
}
async function spSeed(db, me) {
  const r = await db.prepare("INSERT OR IGNORE INTO sp_set(ws,k,v) VALUES(?1,'seeded','1')").bind(me.ws).run();
  if (!r || !r.meta || !r.meta.changes) return false;
  const rows = SP_SEED.map((x, i) => ({ id: bulkId("ck"), scope: "common", branch_id: null, category: x[0], label: x[1], sort: i + 1, active: 1 }));
  await spRun(db, me, spBulk(db, "sp_chk", me.ws, rows));
  return true;
}
function spResIn(r) {
  const o = {};
  if ("branch_id" in r) o.branch_id = clip(r.branch_id, 60) || null;
  if ("res_date" in r) o.res_date = dOk(r.res_date);
  if ("slot" in r) o.slot = SP_SLOTS.includes(r.slot) ? r.slot : "etc";
  if ("resno" in r) o.resno = clip(r.resno, 60);
  if ("customer" in r) o.customer = clip(r.customer, 60);
  if ("phone" in r) o.phone = clip(r.phone, 40);
  if ("amount" in r) o.amount = Math.max(-100000000, Math.min(1000000000, intOr(String(r.amount ?? "").replace(/[^\d.-]/g, ""), 0)));
  if ("status" in r) o.status = clip(r.status, 20) || "확정";
  if ("issue" in r) o.issue = clip(r.issue, 500);
  if ("memo" in r) o.memo = clip(r.memo, 500);
  if ("start_t" in r) o.start_t = tOk(r.start_t) || null;
  if ("end_t" in r) o.end_t = tOk(r.end_t) || null;
  if ("channel" in r) o.channel = SP_CHANNELS.includes(r.channel) ? r.channel : null;
  return o;
}
function spChecks(c) {
  const out = {};
  if (c && typeof c === "object" && !Array.isArray(c)) for (const [k, v] of Object.entries(c).slice(0, 300)) if (v) out[clip(k, 60)] = 1;
  return out;
}
const setCols = (o, from) => Object.keys(o).map((k, i) => `${k}=?${i + from}`).join(",");

const SPACE = {
  /* 화면에 필요한 스페이스 데이터 한 번에 — 기간(from~to) 기준 */
  async data(db, me, b, req, url, env) {
    const today = kstToday();
    let from = dOk(url.searchParams.get("from")) || addDaysS(today, -7), to = dOk(url.searchParams.get("to")) || addDaysS(today, 27);
    if (to < from) [from, to] = [to, from];
    if (to > addDaysS(from, 400)) to = addDaysS(from, 400);
    const mgr = isMgr(me), f1 = addDaysS(from, -1), t1 = addDaysS(to, 1), t2 = addDaysS(to, 2);
    const sc = await spScope(db, me);
    const q = [
      db.prepare("SELECT k, v FROM sp_set WHERE ws=?1 AND k IN ('settings','seeded')").bind(me.ws),
      db.prepare(spSel("sp_chk", "ws=?1")).bind(me.ws),
      mgr ? db.prepare(spSel("sp_res", "ws=?1 AND res_date>=?2 AND res_date<=?3")).bind(me.ws, f1, t2)
        : db.prepare("SELECT id, branch_id, res_date, slot, start_t, end_t, source, status, customer, phone, issue FROM sp_res WHERE ws=?1 AND res_date>=?2 AND res_date<=?3").bind(me.ws, f1, t2),
      db.prepare(spSel("sp_cln", "ws=?1 AND clean_date>=?2 AND clean_date<=?3")).bind(me.ws, f1, t1),
      db.prepare(spSel("sp_asg", "ws=?1 AND date>=?2 AND date<=?3")).bind(me.ws, f1, t1),
      db.prepare(spSel("sp_ntc", "ws=?1 AND date>=?2 AND date<=?3", "ORDER BY date, created_at")).bind(me.ws, f1, t1),
      mgr ? db.prepare(spSel("sp_read", "ws=?1 AND notice_id IN (SELECT id FROM sp_ntc WHERE ws=?1 AND date>=?2 AND date<=?3)")).bind(me.ws, f1, t1)
        : db.prepare(spSel("sp_read", "ws=?1 AND member_id=?4 AND notice_id IN (SELECT id FROM sp_ntc WHERE ws=?1 AND date>=?2 AND date<=?3)")).bind(me.ws, f1, t1, me.id),
      db.prepare(spSel("sp_iss", "ws=?1 AND (status NOT IN ('완료','보류') OR created_at>=?2)", "ORDER BY created_at DESC")).bind(me.ws, new Date(Date.now() - 180 * 864e5).toISOString())
    ];
    if (mgr) q.push(
      db.prepare(spSel("sp_chn", "ws=?1")).bind(me.ws),
      db.prepare(spSel("sp_cost", "ws=?1 AND ym>=?2 AND ym<=?3")).bind(me.ws, addDaysS(from, -32).slice(0, 7), to.slice(0, 7)),
      db.prepare(spSel("sp_log", "ws=?1", "ORDER BY ran_at DESC LIMIT 1")).bind(me.ws)
    );
    const rs = await db.batch(q);
    const set = new Map(((rs[0] && rs[0].results) || []).map(r => [r.k, r.v]));
    let checks = rawArr(rs[1]);
    if (mgr && !set.has("seeded") && await spSeed(db, me)) checks = rawArr((await db.prepare(spSel("sp_chk", "ws=?1")).bind(me.ws).all()));
    let res, cln, iss, reads = rawArr(rs[6]);
    if (mgr) { res = rawArr(rs[2]); cln = rawArr(rs[3]); iss = rawArr(rs[7]); }
    else {
      const salt = rand(8);   // 같은 응답 안에서만 "같은 고객" 비교가 되도록 — 이름·연락처는 보내지 않습니다
      res = JSON.stringify(((rs[2] && rs[2].results) || []).filter(r => sc.vis.has(r.branch_id) && !String(r.status || "").includes("취소")).map(r => ({
        id: r.id, branch_id: r.branch_id, res_date: r.res_date, slot: r.slot, start_t: r.start_t, end_t: r.end_t, source: r.source,
        ckey: (r.customer || r.phone) ? dhash(salt + "|" + (r.customer || "") + "|" + (r.phone || "")) : "", issue: r.issue ? 1 : 0
      })));
      cln = JSON.stringify(rowsOf(rs[3]).filter(c => sc.vis.has(c.branch_id)));
      iss = JSON.stringify(rowsOf(rs[7]).filter(i => !i.branch_id || sc.vis.has(i.branch_id) || i.reporter === me.id));
    }
    const host = await hostInfo(db, me, env);
    const head = {
      ok: true, v: me.spv, from, to, today, role: mgr ? "mgr" : me.role, branches: sc.branches,
      settings: spSettings(parse(set.get("settings"))), host, legacy: !!(env && env.SPACEDB) && me.owner,
      log: mgr ? (rowsOf(rs[10])[0] || null) : null
    };
    return rawJson(head, ',"checks":' + checks + ',"res":' + res + ',"cln":' + cln + ',"asg":' + rawArr(rs[4]) + ',"ntc":' + rawArr(rs[5]) +
      ',"reads":' + reads + ',"iss":' + iss + ',"chn":' + (mgr ? rawArr(rs[8]) : "[]") + ',"cost":' + (mgr ? rawArr(rs[9]) : "[]"));
  },

  /* 지점(매장) 운영 프로필 */
  async prof(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const sid = clip(b.sid, 60);
    if (!await storeOk(db, me, sid)) return fail("not-found", 404);
    const num = v => v === "" || v == null ? null : clampInt(v, 0, 720, null);
    const slots = {};
    if (b.slots && typeof b.slots === "object") for (const k of ["day", "night", "allday"]) { const v = b.slots[k]; if (Array.isArray(v) && tOk(v[0]) && tOk(v[1])) slots[k] = [tOk(v[0]), tOk(v[1])]; }
    const d = { on: b.on ? 1 : 0, alias: clip(b.alias, 200), scode: clip(b.scode, 40), worker: clip(b.worker, 60), std: num(b.std), buf: num(b.buf), mid: tOk(b.mid), slots: Object.keys(slots).length ? slots : null, rules: clip(b.rules, 2000), sort: intOr(b.sort, 0) };
    const { v } = await spRun(db, me, [db.prepare("INSERT INTO sp_prof(ws,sid,d,ua) VALUES(?1,?2,?3,?4) ON CONFLICT(ws,sid) DO UPDATE SET d=excluded.d, ua=excluded.ua").bind(me.ws, sid, JSON.stringify(d), iso())]);
    return json({ ok: true, v, prof: d });
  },

  async settings(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const s = spSettings(b.settings);
    const { v } = await spRun(db, me, [db.prepare("INSERT INTO sp_set(ws,k,v) VALUES(?1,'settings',?2) ON CONFLICT(ws,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(s))]);
    return json({ ok: true, v, settings: s });
  },

  /* 체크리스트 항목 */
  async "chk/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), o = {};
    if ("scope" in b) o.scope = b.scope === "branch" ? "branch" : "common";
    if ("branch_id" in b) o.branch_id = clip(b.branch_id, 60) || null;
    if ("category" in b) o.category = clip(b.category, 40) || "기타";
    if ("label" in b) { o.label = clip(b.label, 200); if (!o.label) return fail("bad-request"); }
    if ("sort" in b) o.sort = intOr(b.sort, 0);
    if ("active" in b) o.active = b.active ? 1 : 0;
    if (id) {
      if (!Object.keys(o).length) return fail("bad-request");
      if (!await spOne(db, "sp_chk", me.ws, id)) return fail("not-found", 404);
      const { v } = await spRun(db, me, [db.prepare(`UPDATE sp_chk SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
      return json({ ok: true, v, item: await spOne(db, "sp_chk", me.ws, id) });
    }
    if (!o.label) return fail("bad-request");
    if (o.scope === "branch" && !await storeOk(db, me, o.branch_id)) return fail("bad-branch");
    const row = Object.assign({ id: uid("ck"), scope: "common", branch_id: null, category: "기타", label: "", sort: 99, active: 1 }, o);
    if (row.scope === "common") row.branch_id = null;
    const { v } = await spRun(db, me, spBulk(db, "sp_chk", me.ws, [row]));
    return json({ ok: true, v, item: row });
  },
  async "chk/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM sp_chk WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },

  /* 예약 */
  async "res/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const o = spResIn(b), id = clip(b.id, 60);
    if (id) {
      if ("res_date" in o && !o.res_date) return fail("bad-date");
      if (!Object.keys(o).length) return fail("bad-request");
      if (!await spOne(db, "sp_res", me.ws, id)) return fail("not-found", 404);
      if (o.branch_id && !await storeOk(db, me, o.branch_id)) return fail("bad-branch");
      const { v } = await spRun(db, me, [db.prepare(`UPDATE sp_res SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
      return json({ ok: true, v, reservation: await spOne(db, "sp_res", me.ws, id) });
    }
    if (!o.res_date) return fail("bad-date");
    if (!await storeOk(db, me, o.branch_id)) return fail("bad-branch");
    const row = Object.assign({ id: uid("r"), slot: "etc", resno: "", customer: "", phone: "", amount: 0, status: "확정", issue: "", memo: "", start_t: null, end_t: null }, o, { source: "manual", created_at: iso() });
    const { v } = await spRun(db, me, spBulk(db, "sp_res", me.ws, [row]));
    return json({ ok: true, v, reservation: row });
  },
  async "res/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM sp_res WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },
  // "확인 후 진행" 표시 — 엑셀·동기화 예약은 내용 대신 이 표시만 바꿉니다
  async "res/issue"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60);
    if (!await spOne(db, "sp_res", me.ws, id)) return fail("not-found", 404);
    const { v } = await spRun(db, me, [db.prepare("UPDATE sp_res SET issue=?3 WHERE ws=?1 AND id=?2").bind(me.ws, id, clip(b.issue, 500))]);
    return json({ ok: true, v, reservation: await spOne(db, "sp_res", me.ws, id) });
  },
  // 엑셀 업로드 — replace: 해당 월의 엑셀분만 교체 / merge: 같은 예약번호는 건너뜀
  async "res/import"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const rows = Array.isArray(b.rows) ? b.rows.slice(0, 5000) : [];
    if (!rows.length) return fail("empty");
    const mode = b.mode === "merge" || b.mode === "append" ? b.mode : "replace";   // append = 교체 업로드의 이어지는 묶음
    const stores = new Set(((await db.prepare("SELECT id FROM ent WHERE ws=?1 AND kind='store' AND deleted=0").bind(me.ws).all()).results || []).map(r => r.id));
    const clean = [];
    for (const r of rows) {
      if (!r || typeof r !== "object") continue;
      const o = spResIn(r);
      if (!o.res_date || !stores.has(o.branch_id)) continue;
      clean.push(Object.assign({ id: bulkId("r"), slot: "etc", resno: "", customer: "", phone: "", amount: 0, status: "확정", issue: "", memo: "", start_t: null, end_t: null }, o, { source: "excel", created_at: iso() }));
    }
    if (!clean.length) return fail("empty");
    const stmts = [];
    let list = clean;
    if (mode === "replace") {
      const months = new Set(clean.map(r => r.res_date.slice(0, 7)));
      if (Array.isArray(b.months)) b.months.slice(0, 60).forEach(m => { if (ymOk(m)) months.add(m); });
      stmts.push(db.prepare("DELETE FROM sp_res WHERE ws=?1 AND source='excel' AND substr(res_date,1,7) IN (SELECT value FROM json_each(?2))").bind(me.ws, JSON.stringify([...months])));
    } else if (mode === "merge") {
      const nos = [...new Set(clean.map(r => r.resno).filter(Boolean))];
      const have = nos.length ? new Set(((await db.prepare("SELECT resno FROM sp_res WHERE ws=?1 AND resno IN (SELECT value FROM json_each(?2))").bind(me.ws, JSON.stringify(nos)).all()).results || []).map(r => r.resno)) : new Set();
      const seen = new Set(); list = [];
      for (const r of clean) { if (r.resno) { if (have.has(r.resno) || seen.has(r.resno)) continue; seen.add(r.resno); } list.push(r); }
    }
    stmts.push(...spBulk(db, "sp_res", me.ws, list));
    const { v } = await spRun(db, me, stmts);
    return json({ ok: true, v, added: list.length, skipped: rows.length - list.length });
  },

  /* 청소 기록 — task_key(지점|날짜|종류) 기준으로 만들거나 고칩니다 */
  async "cln/save"(db, me, b) {
    const key = clip(b.task_key, 160), kp = key.split("|");
    if (kp.length !== 3 || !kp[0] || !dOk(kp[1])) return fail("bad-request");
    const manualKey = !SP_KINDS.includes(kp[2]) && /^m[0-9a-z]{1,24}$/.test(kp[2]);   // 수동 청소는 "m…" 키 (관리자만 만듭니다). "mid"는 중간 정리
    if (!manualKey && !SP_KINDS.includes(kp[2])) return fail("bad-request");
    const mgr = isMgr(me);
    const ex = await db.prepare(spSel("sp_cln", "ws=?1 AND task_key=?2")).bind(me.ws, key).first().then(r => r ? parse(r.j) : null);
    const bid = ex ? ex.branch_id : kp[0], cd = ex ? ex.clean_date : kp[1];
    const kind = ex ? (ex.kind || "etc") : manualKey ? (SP_KINDS.includes(b.kind) ? b.kind : "etc") : kp[2];
    const o = {}, st = b.status;
    if (mgr) {
      if ("assignee" in b) o.assignee = clip(b.assignee, 60) || null;
      if ("status" in b) { if (!["todo", "done", "skip"].includes(st)) return fail("bad-request"); o.status = st; }
    } else {
      if (!ex && manualKey) return fail("forbidden", 403);
      const sc = await spScope(db, me);
      if (!sc.vis.has(bid)) return fail("forbidden", 403);
      if (ex && ex.status === "confirmed") return fail("locked", 409);
      if (ex && ex.assignee) { if (ex.assignee !== me.id && ex.assignee !== me.name) return fail("not-mine", 403); }
      else { const eff = await spEffAssignee(db, me, sc, bid, cd); if (eff && eff !== me.id && eff !== me.name) return fail("not-mine", 403); }
      if ("assignee" in b && b.assignee && b.assignee !== me.id) return fail("forbidden", 403);
      if ("status" in b) {
        if (!["todo", "done", "skip"].includes(st)) return fail("forbidden", 403);
        if (st === "skip" && kind !== "mid") return fail("forbidden", 403);   // 생략은 같은 고객 연속 이용의 중간 정리만
        o.status = st;
      }
      if (!(ex && ex.assignee)) o.assignee = me.id;   // 손대는 순간 본인 담당으로
    }
    if ("checks" in b) o.checks = JSON.stringify(spChecks(b.checks));
    if ("note" in b) o.note = clip(b.note, 1000);
    if ("window_label" in b) o.window_label = clip(b.window_label, 120);
    if (o.status === "done") { o.submitted_by = me.id; o.submitted_name = me.name; o.submitted_at = iso(); if (!o.assignee && !(ex && ex.assignee)) o.assignee = me.id; }
    if (ex) {
      if (ex.status === "confirmed" && o.status) delete o.status;
      if (!Object.keys(o).length) return json({ ok: true, v: null, cleaning: ex });
      const { v } = await spRun(db, me, [db.prepare(`UPDATE sp_cln SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, ex.id, ...Object.values(o))]);
      return json({ ok: true, v, cleaning: await spOne(db, "sp_cln", me.ws, ex.id) });
    }
    if ((b.branch_id !== undefined && clip(b.branch_id, 60) !== bid) || (b.clean_date !== undefined && dOk(b.clean_date) !== cd)) return fail("bad-request");   // 키와 내용이 다르면 거절
    if (mgr && !await storeOk(db, me, bid)) return fail("bad-branch");
    const row = Object.assign({ id: uid("c"), task_key: key, branch_id: bid, clean_date: cd, kind, assignee: null, status: "todo", checks: "{}", note: "", submitted_by: null, submitted_name: null, submitted_at: null, review_by: null, review_name: null, review_at: null, feedback: null, manual: manualKey ? 1 : 0, window_label: "", created_at: iso() }, o);
    const upd = Object.keys(o);   // 거의 동시에 같은 청소를 만든 경우엔 보낸 항목만 덮어씁니다
    const conflict = "ON CONFLICT(ws,task_key) DO UPDATE SET " + (upd.length ? upd.map(k => `${k}=excluded.${k}`).join(",") : "task_key=excluded.task_key");
    const { v } = await spRun(db, me, spBulk(db, "sp_cln", me.ws, [row], conflict));
    return json({ ok: true, v, cleaning: await db.prepare(spSel("sp_cln", "ws=?1 AND task_key=?2")).bind(me.ws, key).first().then(r => r ? parse(r.j) : row) });
  },
  // 관리자 확인 — 확인 완료 또는 보완 요청(사유 필수)
  async "cln/review"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const status = b.status === "redo" ? "redo" : b.status === "confirmed" ? "confirmed" : "";
    const fb = clip(b.feedback, 1000);
    if (!status) return fail("bad-request");
    if (status === "redo" && !fb) return fail("feedback-required");
    const ex = await spOne(db, "sp_cln", me.ws, clip(b.id, 60));
    if (!ex) return fail("not-found", 404);
    if (!["done", "redo", "confirmed"].includes(ex.status)) return fail("bad-state");
    const { v } = await spRun(db, me, [db.prepare("UPDATE sp_cln SET status=?3, feedback=?4, review_by=?5, review_name=?6, review_at=?7 WHERE ws=?1 AND id=?2").bind(me.ws, ex.id, status, fb || null, me.id, me.name, iso())]);
    return json({ ok: true, v, cleaning: await spOne(db, "sp_cln", me.ws, ex.id) });
  },
  async "cln/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM sp_cln WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },

  /* 시설 이슈 — 신고는 누구나, 처리는 관리자·시설 담당 */
  async "iss/save"(db, me, b) {
    const id = clip(b.id, 60), mgr = isMgr(me), str = (k, n) => clip(b[k], n);
    if (!id) {
      const title = str("title", 120);
      if (!title) return fail("bad-request");
      const bid = str("branch_id", 60);
      if (mgr) { if (bid && !await storeOk(db, me, bid)) return fail("bad-branch"); }
      else { const sc = await spScope(db, me); if (!sc.vis.has(bid)) return fail("forbidden", 403); }
      const row = { id: uid("i"), branch_id: bid || null, category: str("category", 30), equip: str("equip", 30), title, detail: str("detail", 2000), priority: SP_PRIO.includes(b.priority) ? b.priority : "보통", status: "접수", reporter: me.id, reporter_name: me.name, assignee: null, cost: null, comments: [], created_at: iso(), resolved_at: null };
      const { v } = await spRun(db, me, spBulk(db, "sp_iss", me.ws, [row]));
      return json({ ok: true, v, issue: row });
    }
    if (!(mgr || me.role === "facility")) return fail("forbidden", 403);
    const ex = await spOne(db, "sp_iss", me.ws, id);
    if (!ex) return fail("not-found", 404);
    if (!mgr && ex.branch_id && ex.reporter !== me.id && !(await spScope(db, me)).vis.has(ex.branch_id)) return fail("forbidden", 403);
    const o = {};
    if ("status" in b && SP_ISS_ST.includes(b.status)) o.status = b.status;
    if ("assignee" in b) o.assignee = str("assignee", 60) || null;
    if ("cost" in b) o.cost = b.cost === "" || b.cost == null ? null : Math.max(0, intOr(b.cost, 0));
    if ("priority" in b && SP_PRIO.includes(b.priority)) o.priority = b.priority;
    for (const [k, n] of [["category", 30], ["equip", 30], ["detail", 2000]]) if (k in b) o[k] = str(k, n);
    if ("title" in b && str("title", 120)) o.title = str("title", 120);
    if (o.status === "완료" && !ex.resolved_at) o.resolved_at = iso();
    if (o.status && o.status !== "완료") o.resolved_at = null;
    if (!Object.keys(o).length) return json({ ok: true, v: null, issue: ex });
    const { v } = await spRun(db, me, [db.prepare(`UPDATE sp_iss SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, issue: await spOne(db, "sp_iss", me.ws, id) });
  },
  async "iss/comment"(db, me, b) {
    const id = clip(b.id, 60), text = clip(b.text, 1000);
    if (!text) return fail("bad-request");
    const ex = await spOne(db, "sp_iss", me.ws, id);
    if (!ex) return fail("not-found", 404);
    if (!isMgr(me) && ex.reporter !== me.id && ex.branch_id && !(await spScope(db, me)).vis.has(ex.branch_id)) return fail("forbidden", 403);
    const c = { id: uid("m"), by: me.id, name: me.name, text, at: iso() };
    const { v } = await spRun(db, me, [db.prepare("UPDATE sp_iss SET comments=json_insert(CASE WHEN json_valid(comments) THEN comments ELSE '[]' END,'$[#]',json(?3)) WHERE ws=?1 AND id=?2").bind(me.ws, id, JSON.stringify(c))]);
    return json({ ok: true, v, issue: await spOne(db, "sp_iss", me.ws, id) });
  },
  async "iss/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM sp_iss WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },

  /* 홍보 채널 */
  async "chn/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), o = {};
    if ("channel" in b) { o.channel = clip(b.channel, 60); if (!o.channel) return fail("bad-request"); }
    if ("status" in b) o.status = SP_CH_ST.includes(b.status) ? b.status : "등록필요";
    for (const [k, n] of [["url", 500], ["owner", 40], ["memo", 300]]) if (k in b) o[k] = clip(b[k], n);
    if ("last_check" in b) o.last_check = dOk(b.last_check) || null;
    if ("sort" in b) o.sort = intOr(b.sort, 0);
    if (id) {
      if (!Object.keys(o).length) return fail("bad-request");
      if (!await spOne(db, "sp_chn", me.ws, id)) return fail("not-found", 404);
      const { v } = await spRun(db, me, [db.prepare(`UPDATE sp_chn SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
      return json({ ok: true, v, channel: await spOne(db, "sp_chn", me.ws, id) });
    }
    if (!o.channel) return fail("bad-request");
    const bid = clip(b.branch_id, 60);
    if (!await storeOk(db, me, bid)) return fail("bad-branch");
    const row = Object.assign({ id: uid("ch"), branch_id: bid, url: "", status: "등록필요", owner: "", last_check: null, memo: "", sort: 99 }, o);
    const { v } = await spRun(db, me, spBulk(db, "sp_chn", me.ws, [row]));
    return json({ ok: true, v, channel: row });
  },
  async "chn/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM sp_chn WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },
  async "chn/ensure"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const bid = clip(b.branch_id, 60);
    if (!await storeOk(db, me, bid)) return fail("bad-branch");
    const have = new Set(((await db.prepare("SELECT channel FROM sp_chn WHERE ws=?1 AND branch_id=?2").bind(me.ws, bid).all()).results || []).map(r => r.channel));
    const rows = SP_PRESETS.map((ch, i) => ({ id: bulkId("ch"), branch_id: bid, channel: ch, url: "", status: "등록필요", owner: "", last_check: null, memo: "", sort: i })).filter(r => !have.has(r.channel));
    const { v } = rows.length ? await spRun(db, me, spBulk(db, "sp_chn", me.ws, rows)) : { v: null };
    return rawJson({ ok: true, v, added: rows.length }, ',"channels":' + rawArr(await db.prepare(spSel("sp_chn", "ws=?1")).bind(me.ws).all()));
  },
  async "chn/check"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60);
    if (!await spOne(db, "sp_chn", me.ws, id)) return fail("not-found", 404);
    const { v } = await spRun(db, me, [db.prepare("UPDATE sp_chn SET last_check=?3, status=CASE WHEN status='등록필요' THEN '운영중' ELSE status END WHERE ws=?1 AND id=?2").bind(me.ws, id, kstToday())]);
    return json({ ok: true, v, channel: await spOne(db, "sp_chn", me.ws, id) });
  },

  /* 월별 비용 */
  async "cost/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const ym = ymOk(b.ym);
    if (!ym) return fail("bad-request");
    const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 300).filter(r => r && r.branch_id).map(r => ({
      ym, branch_id: clip(r.branch_id, 60), rent: Math.max(0, intOr(r.rent)), mgmt: Math.max(0, intOr(r.mgmt)), supplies: Math.max(0, intOr(r.supplies)),
      telecom: Math.max(0, intOr(r.telecom)), misc: Math.max(0, intOr(r.misc)), fee_pct: Math.max(0, Math.min(100, Math.round((Number(r.fee_pct) || 0) * 100) / 100))
    }));
    if (!rows.length) return fail("bad-request");
    const { v } = await spRun(db, me, spBulk(db, "sp_cost", me.ws, rows, "ON CONFLICT(ws,ym,branch_id) DO UPDATE SET rent=excluded.rent, mgmt=excluded.mgmt, supplies=excluded.supplies, telecom=excluded.telecom, misc=excluded.misc, fee_pct=excluded.fee_pct"));
    return json({ ok: true, v, saved: rows.length });
  },

  /* 날짜 × 권역(또는 지점) 일괄 배정 — 담당을 비우면 해제 */
  async "asg/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const date = dOk(b.date);
    if (!date) return fail("bad-request");
    const region = clip(b.region, 30), bid = clip(b.branch_id, 60), worker = clip(b.worker, 60);
    if (!region && !bid) return fail("bad-request");
    if (!worker) {
      const { v } = await spRun(db, me, [db.prepare("DELETE FROM sp_asg WHERE ws=?1 AND date=?2 AND region=?3 AND branch_id=?4").bind(me.ws, date, region, bid)]);
      return json({ ok: true, v, assignment: null });
    }
    const row = { id: uid("a"), date, region, branch_id: bid, worker, created_by: me.id, created_at: iso() };
    const { v } = await spRun(db, me, spBulk(db, "sp_asg", me.ws, [row], "ON CONFLICT(ws,date,region,branch_id) DO UPDATE SET worker=excluded.worker, created_by=excluded.created_by, created_at=excluded.created_at"));
    const r = await db.prepare(spSel("sp_asg", "ws=?1 AND date=?2 AND region=?3 AND branch_id=?4")).bind(me.ws, date, region, bid).first();
    return json({ ok: true, v, assignment: r ? parse(r.j) : row });
  },

  /* 일일 브리핑(필수 확인사항) — 근무자는 "확인했습니다"로 읽음을 남깁니다 */
  async "ntc/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const date = dOk(b.date), body = clip(b.body, 1000);
    if (!date || !body) return fail("bad-request");
    const row = { id: uid("n"), date, body, created_by: me.id, created_name: me.name, created_at: iso() };
    const { v } = await spRun(db, me, spBulk(db, "sp_ntc", me.ws, [row]));
    return json({ ok: true, v, notice: row });
  },
  async "ntc/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM sp_ntc WHERE ws=?1 AND id=?2").bind(me.ws, id), db.prepare("DELETE FROM sp_read WHERE ws=?1 AND notice_id=?2").bind(me.ws, id)]);
    return json({ ok: true, v });
  },
  async "ntc/read"(db, me, b) {
    const id = clip(b.id, 60);
    if (!await spOne(db, "sp_ntc", me.ws, id)) return fail("not-found", 404);
    const st = b.undo ? db.prepare("DELETE FROM sp_read WHERE ws=?1 AND notice_id=?2 AND member_id=?3").bind(me.ws, id, me.id)
      : db.prepare("INSERT INTO sp_read(ws,notice_id,member_id,member_name,read_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(ws,notice_id,member_id) DO UPDATE SET read_at=excluded.read_at, member_name=excluded.member_name").bind(me.ws, id, me.id, me.name, iso());
    const { v } = await spRun(db, me, [st]);
    return json({ ok: true, v, read: !b.undo });
  },

  /* 호스트 예약 자동 동기화 (읽기 전용) */
  async sync(db, me, b, req, url, env) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const h = await hostInfo(db, me, env);
    if (!h.bound) return fail("host-not-bound");
    if (!h.allowed) return fail("host-not-allowed", 403);
    return await spHostSync(env.HOSTDB, db, me);
  },
  async hostmap(db, me, b, req, url, env) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const h = await hostInfo(db, me, env);
    if (!h.allowed) return fail("host-not-allowed", 403);
    const map = b.map && typeof b.map === "object" ? b.map : {}, text = JSON.stringify(map);
    if (text.length > 4000) return fail("too-large");
    const { v } = await spRun(db, me, [db.prepare("INSERT INTO sp_set(ws,k,v) VALUES(?1,'hostmap',?2) ON CONFLICT(ws,k) DO UPDATE SET v=excluded.v").bind(me.ws, text)]);
    return json({ ok: true, v });
  },

  /* 예전에 따로 쓰던 마이웍스 스페이스(D1: SPACEDB) 데이터를 한 번 옮겨 옵니다 — 운영자 전용, 여러 번 눌러도 중복되지 않습니다 */
  async legacy(db, me, b, req, url, env) {
    if (!me.owner) return fail("forbidden", 403);
    if (!env || !env.SPACEDB) return fail("legacy-not-bound");
    return await spLegacy(env.SPACEDB, db, me, b);
  }
};

/* ───────── 호스트 예약 동기화 — 같은 Cloudflare 계정의 예약 DB를 바인딩으로 읽기만 합니다 ───────── */
const SYNC_BACK = 35, SYNC_FWD = 90;
const qid = id => '"' + String(id).replace(/"/g, '""') + '"';
const normKey = s => String(s || "").toLowerCase().replace(/[\s_\-]/g, "");
const normNm = s => String(s || "").replace(/\s+/g, "").toLowerCase();
function normDate10(v) {
  if (v == null) return null;
  const m = String(v).trim().replace(/[./]/g, "-").match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}` : null;
}
function pickCol(cols, cands) {
  const ks = cols.map(c => ({ raw: c, k: normKey(c) }));
  for (const c of cands) { const t = normKey(c), hit = ks.find(x => x.k === t); if (hit) return hit.raw; }
  for (const c of cands) { const t = normKey(c), hit = ks.find(x => x.k.includes(t) && t.length >= 3); if (hit) return hit.raw; }
  return null;
}
function slotFromRaw(raw, startHM) {
  const s = String(raw || "");
  if (/밤|야간|night/i.test(s)) return "night";
  if (/올데이|종일|allday|all[\s_\-]?day|full/i.test(s)) return "allday";
  if (/낮|주간|day/i.test(s)) return "day";
  if (startHM) { const h = +startHM.slice(0, 2); if (h >= 18 || h < 6) return "night"; if (h >= 10 && h <= 14) return "day"; return "allday"; }
  return "etc";
}
async function spHostSync(H, db, me) {
  const mr = await db.prepare("SELECT v FROM sp_set WHERE ws=?1 AND k='hostmap'").bind(me.ws).first();
  const map = (mr && parse(mr.v)) || {};
  const tbls = ((await H.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results || []).map(r => r.name);
  let tbl = map.table && tbls.includes(map.table) ? map.table : null;
  if (!tbl) tbl = tbls.find(n => /^reservations?$/i.test(n)) || tbls.find(n => /reserv|booking|예약/i.test(n));
  if (!tbl) return fail("host-no-table", 400, { detail: tbls.join(", ") });
  const cols = ((await H.prepare(`PRAGMA table_info(${qid(tbl)})`).all()).results || []).map(r => r.name);
  const mc = map.cols || {};
  const col = {
    code: mc.code || pickCol(cols, ["branch_code", "scode", "space_code", "store_code", "shop_code", "spot_code"]),
    bname: mc.bname || pickCol(cols, ["branch_name", "space_name", "store_name", "shop_name", "room_name", "branch", "space"]),
    date: mc.date || pickCol(cols, ["use_date", "res_date", "reserve_date", "reservation_date", "checkin_date", "start_date", "use_day", "date", "ymd"]),
    slot: mc.slot || pickCol(cols, ["slot", "time_slot", "slot_type", "time_type", "session", "kind"]),
    start: mc.start || pickCol(cols, ["start_t", "start_time", "checkin_time", "from_time", "start"]),
    end: mc.end || pickCol(cols, ["end_t", "end_time", "checkout_time", "to_time", "end"]),
    cust: mc.cust || pickCol(cols, ["customer_name", "customer", "guest_name", "booker_name", "booker", "user_name", "name"]),
    phone: mc.phone || pickCol(cols, ["phone", "tel", "mobile", "contact", "hp"]),
    amount: mc.amount || pickCol(cols, ["total_amount", "pay_amount", "paid_amount", "amount", "price", "total"]),
    status: mc.status || pickCol(cols, ["status", "state", "pay_status", "res_status"]),
    resno: mc.resno || pickCol(cols, ["resno", "reservation_no", "res_no", "booking_no", "order_no", "order_id", "no", "id"]),
    memo: mc.memo || pickCol(cols, ["memo", "note", "request", "requests", "comment"])
  };
  if (!col.date || !col.resno || (!col.code && !col.bname)) return fail("host-no-col", 400, { detail: `${tbl}: ${cols.join(", ")}`, need: !col.date ? "날짜" : !col.resno ? "예약번호" : "지점" });
  const today = kstToday(), f = addDaysS(today, -SYNC_BACK), t = addDaysS(today, SYNC_FWD);
  const hostRows = (await H.prepare(`SELECT * FROM ${qid(tbl)} WHERE substr(${qid(col.date)},1,10)>=?1 AND substr(${qid(col.date)},1,10)<=?2`).bind(f, t).all()).results || [];
  // 지점 맞추기: 지점 코드(S코드) → 매장 이름·별칭 → 부분 일치. 모든 매장과 맞춰 보고, 스페이스를 끈 매장 예약은 건너뜁니다(지우지 않음)
  const sc = await spScope(db, { ...me, role: "admin" });
  const byScode = {}, byName = {}, onSet = new Set();
  for (const br of sc.branches) {
    if (br.on) onSet.add(br.id);
    if (br.scode) byScode[normNm(br.scode)] = br.id;
    byName[normNm(br.name)] = br.id;
    String(br.alias || "").split(",").map(a => a.trim()).filter(Boolean).forEach(a => { byName[normNm(a)] = br.id; });
  }
  const names = Object.keys(byName).sort((x, y) => y.length - x.length);   // 긴 이름부터 맞춰 엉뚱한 지점에 붙지 않게
  const unmatched = new Set(), act = new Map(), seen = new Set(), gone = new Set();
  let skipped = 0, offSkipped = 0;
  for (const hr of hostRows) {
    const rawNo = hr[col.resno], resno = "H" + String(rawNo == null ? "" : rawNo).trim();
    if (resno === "H") { skipped++; continue; }
    seen.add(resno);
    const rd = normDate10(hr[col.date]);
    if (!rd) { skipped++; continue; }
    if (/취소|cancel|refund|환불/i.test(col.status ? String(hr[col.status] ?? "") : "")) { gone.add(resno); continue; }   // 취소분은 아래에서 정리
    let bid = null, label = "";
    if (col.code) { label = String(hr[col.code] ?? "").trim(); if (label) bid = byScode[normNm(label)] || byName[normNm(label)] || null; }
    if (!bid && col.bname) {
      const nm = String(hr[col.bname] ?? "").trim();
      if (nm) {
        label = label || nm; bid = byName[normNm(nm)] || null;
        if (!bid) { const k = normNm(nm), hit = names.find(x => x && x.length >= 2 && (k.includes(x) || x.includes(k))); if (hit) bid = byName[hit]; }
      }
    }
    if (!bid) { if (label) unmatched.add(label); skipped++; continue; }
    if (!onSet.has(bid)) { offSkipped++; continue; }
    const start = tOk(col.start ? hr[col.start] : null) || (String(hr[col.date] || "").length > 10 ? tOk(String(hr[col.date]).slice(10).replace(/^[T\s]+/, "")) : "");
    act.set(resno, {
      resno, branch_id: bid, res_date: rd, slot: slotFromRaw(col.slot ? hr[col.slot] : null, start),
      customer: col.cust ? clip(hr[col.cust], 60) : "", phone: col.phone ? clip(hr[col.phone], 40) : "",
      amount: col.amount ? (parseInt(String(hr[col.amount] ?? "0").replace(/[^\d-]/g, ""), 10) || 0) : 0,
      status: "확정", start_t: start || null, end_t: tOk(col.end ? hr[col.end] : null) || null, memo: col.memo ? clip(hr[col.memo], 500) : ""
    });
  }
  const ex = (await db.prepare("SELECT id, resno, branch_id, res_date, slot, customer, phone, amount, start_t, end_t, memo, issue FROM sp_res WHERE ws=?1 AND source='sync' AND ((res_date>=?2 AND res_date<=?3) OR resno IN (SELECT value FROM json_each(?4)))").bind(me.ws, f, t, JSON.stringify([...act.keys()])).all()).results || [];
  // 같은 예약번호가 두 줄 이상이면 하나만 남깁니다 (확인 메모가 있는 줄 우선)
  const exBy = new Map(), dels = [];
  for (const e of ex.slice().sort((x, y) => (y.issue ? 1 : 0) - (x.issue ? 1 : 0))) { if (exBy.has(e.resno)) dels.push(e.id); else exBy.set(e.resno, e); }
  const ups = [], now = iso();
  let added = 0, updated = 0;
  for (const r of act.values()) {
    const e = exBy.get(r.resno);
    if (!e) { ups.push({ id: bulkId("r"), ...r, issue: "", source: "sync", created_at: now }); added++; continue; }
    if (["branch_id", "res_date", "slot", "customer", "phone", "amount", "start_t", "end_t", "memo"].some(k => String(e[k] ?? "") !== String(r[k] ?? ""))) { ups.push({ id: e.id, ...r, issue: "", source: "sync", created_at: now }); updated++; }
  }
  // 호스트에서 사라졌거나 취소된 예약만 지웁니다 (지점을 못 맞췄거나 스페이스를 끈 매장 예약은 그대로 둠)
  for (const e of exBy.values()) if (e.res_date >= f && e.res_date <= t && (!seen.has(e.resno) || gone.has(e.resno))) dels.push(e.id);
  const msg = `테이블 ${tbl} · ${f}~${t}` + (unmatched.size ? " · 미매칭: " + [...unmatched].slice(0, 8).join(", ") : " · 전 지점 매칭") + (offSkipped ? ` · 스페이스 꺼진 매장 ${offSkipped}건 건너뜀` : "");
  const stmts = spBulk(db, "sp_res", me.ws, ups, "ON CONFLICT(ws,id) DO UPDATE SET branch_id=excluded.branch_id, res_date=excluded.res_date, slot=excluded.slot, customer=excluded.customer, phone=excluded.phone, amount=excluded.amount, status=excluded.status, start_t=excluded.start_t, end_t=excluded.end_t, memo=excluded.memo");
  if (dels.length) stmts.push(db.prepare("DELETE FROM sp_res WHERE ws=?1 AND id IN (SELECT value FROM json_each(?2))").bind(me.ws, JSON.stringify(dels)));
  stmts.push(db.prepare("INSERT OR REPLACE INTO sp_log(ws,ran_at,by_name,ok,added,updated,removed,skipped,message) VALUES(?1,?2,?3,1,?4,?5,?6,?7,?8)").bind(me.ws, now, me.name, added, updated, dels.length, skipped, msg));
  const { v } = await spRun(db, me, stmts);
  return json({ ok: true, v, added, updated, removed: dels.length, skipped, offSkipped, table: tbl, unmatched: [...unmatched], window: [f, t], ran_at: now });
}

/* ───────── 기존 마이웍스 스페이스 데이터 가져오기 (SPACEDB → 운영자 워크스페이스) ─────────
   step: scan(개수 확인) → base(지점·계정·설정·체크리스트·채널·비용·배정·브리핑·이슈) → res(예약, 나눠서) → cln(청소 기록, 나눠서) */
const LEG_TABLES = ["branches", "branch_profiles", "users", "user_rates", "check_items", "reservations", "cleanings", "issues", "channels", "costs", "assignments", "notices", "notice_reads", "app_settings"];
async function legAll(L, sql, ...binds) { try { return ((await L.prepare(sql).bind(...binds).all()).results) || []; } catch (e) { return null; } }
async function spLegacy(L, db, me, b) {
  const step = String(b.step || "scan");
  const lr = await db.prepare("SELECT v FROM sp_set WHERE ws=?1 AND k='legacy'").bind(me.ws).first();
  const lmap = (lr && parse(lr.v)) || null;
  if (step === "scan") {
    const counts = {};
    for (const t of LEG_TABLES) { const r = await legAll(L, `SELECT COUNT(*) AS n FROM ${t}`); counts[t] = r && r[0] ? Number(r[0].n) : null; }
    return json({ ok: true, counts, imported: lmap ? { at: lmap.at, done: !!lmap.done, stores: Object.keys(lmap.b || {}).length } : null });
  }
  if (step === "base") {
    const branches = await legAll(L, "SELECT * FROM branches ORDER BY sort");
    if (!branches || !branches.length) return fail("legacy-empty");
    const profs = await legAll(L, "SELECT * FROM branch_profiles") || [];
    const users = await legAll(L, "SELECT id, username, name, role, branch_ids, active FROM users") || [];
    const rates = await legAll(L, "SELECT * FROM user_rates") || [];
    const sets = await legAll(L, "SELECT k, v FROM app_settings") || [];
    const chks = await legAll(L, "SELECT * FROM check_items") || [];
    const chns = await legAll(L, "SELECT * FROM channels") || [];
    const costs = await legAll(L, "SELECT * FROM costs") || [];
    const asgs = await legAll(L, "SELECT * FROM assignments") || [];
    const ntcs = await legAll(L, "SELECT * FROM notices") || [];
    const reads = await legAll(L, "SELECT * FROM notice_reads") || [];
    const isss = await legAll(L, "SELECT * FROM issues") || [];
    const [st, mm, mt, ck, ch] = await db.batch([
      db.prepare("SELECT id, data FROM ent WHERE ws=?1 AND kind='store' AND deleted=0").bind(me.ws),
      db.prepare("SELECT id, data FROM ent WHERE ws=?1 AND kind='member' AND deleted=0").bind(me.ws),
      db.prepare("SELECT data FROM ent WHERE ws=?1 AND kind='meta' AND id='ws'").bind(me.ws),
      db.prepare("SELECT id, scope, branch_id, label FROM sp_chk WHERE ws=?1").bind(me.ws),
      db.prepare("SELECT branch_id, channel FROM sp_chn WHERE ws=?1").bind(me.ws)
    ]);
    const now = iso(), meta = parse(mt.results && mt.results[0] && mt.results[0].data) || {};
    const brands = Array.isArray(meta.brands) ? meta.brands : [];
    const brand = brands.includes("쏘플파티룸") ? "쏘플파티룸" : (brands[0] || "기타");
    const storeBy = new Map(), liveStores = new Set();
    for (const r of st.results || []) { liveStores.add(r.id); const d = parse(r.data); if (d && d.name) storeBy.set(normNm(d.name), r.id); }
    const profBy = new Map(profs.map(p => [p.branch_id, p]));
    const bmap = Object.assign({}, lmap && lmap.b), ent = [];
    for (const [k, sid] of Object.entries(bmap)) if (!liveStores.has(sid)) delete bmap[k];   // 그 사이 지워진 매장은 다시 맞춥니다
    for (const br of branches) {
      if (bmap[br.id]) continue;
      const hit = storeBy.get(normNm(br.name));
      if (hit) { bmap[br.id] = hit; continue; }
      const id = uid("s"); bmap[br.id] = id;
      ent.push({ kind: "store", id, data: { id, name: clip(br.name, 60), brand, region: clip((profBy.get(br.id) || {}).region, 20), address: "", status: br.active === 0 ? "휴업" : "운영중", managerId: me.id, memberIds: [], openDate: "", checkCycleDays: 7, checks: [], notes: clip(br.memo, 2000), links: [], createdAt: now, updatedAt: now, source: "스페이스" } });
    }
    const memBy = new Map(), liveMem = new Set();
    for (const r of mm.results || []) { liveMem.add(r.id); const d = parse(r.data); if (d && d.name && !memBy.has(d.name)) memBy.set(d.name, { id: r.id, d }); }
    const rateBy = new Map(rates.map(r => [r.user_id, Number(r.rate)]));
    const umap = Object.assign({}, lmap && lmap.u), uidMap = Object.assign({}, lmap && lmap.i);
    for (const [k, mid] of Object.entries(umap)) if (!liveMem.has(mid)) delete umap[k];
    for (const [k, mid] of Object.entries(uidMap)) if (!liveMem.has(mid)) delete uidMap[k];
    const ROLE = { owner: "staff", manager: "staff", worker: "worker", facility: "facility" };
    let newMembers = 0;
    for (const u of users) {
      if (!u.name) continue;
      const stores = (parse(u.branch_ids) || []).map(x => bmap[x]).filter(Boolean);
      const m = memBy.get(u.name);
      if (m) {
        umap[u.name] = m.id; uidMap[u.id] = m.id;
        const d = { ...m.d }; let ch = false;
        if (d.spRate === undefined && rateBy.has(u.id)) { d.spRate = rateBy.get(u.id); ch = true; }
        if ((!Array.isArray(d.spStores) || !d.spStores.length) && stores.length && u.role === "worker") { d.spStores = stores; ch = true; }
        if (ch) { ent.push({ kind: "member", id: m.id, data: d }); m.d = d; }
        continue;
      }
      const id = uid("m");
      const d = { id, loginId: "", name: clip(u.name, 20), role: ROLE[u.role] || "worker", org: "스페이스에서 가져옴", active: u.active !== 0, createdAt: now };
      if (rateBy.has(u.id)) d.spRate = rateBy.get(u.id);
      if (stores.length) d.spStores = stores;
      umap[u.name] = id; uidMap[u.id] = id; memBy.set(u.name, { id, d });
      ent.push({ kind: "member", id, data: d }); newMembers++;
    }
    const who = n => n ? (umap[n] || String(n)) : null;
    const bm = x => x ? (bmap[x] || null) : null;
    const prow = branches.map(br => {
      const p = profBy.get(br.id) || {}, sl = parse(p.slots_json);
      return { sid: bmap[br.id], d: { on: br.active === 0 ? 0 : 1, alias: clip(br.alias, 200), scode: clip(p.scode, 40), worker: who(p.default_worker || br.default_worker) || "", std: p.std_minutes ?? null, buf: p.buffer_min ?? null, mid: tOk(p.midday_deadline), slots: sl && typeof sl === "object" ? sl : null, rules: clip(p.notes, 2000), sort: Number(br.sort) || 0 }, ua: now };
    });
    const setRows = [];
    const sv = sets.find(s => s.k === "settings"); if (sv) setRows.push({ k: "settings", v: spSettings(parse(sv.v)) });
    const hm = sets.find(s => s.k === "host_map"); if (hm && parse(hm.v)) setRows.push({ k: "hostmap", v: parse(hm.v) });
    // 같은 내용의 체크 항목이 이미 있으면 새로 넣지 않고, 예전 항목 id를 지금 항목 id로 이어 둡니다 (청소 기록의 체크 결과 보존)
    const haveChk = new Map(((ck && ck.results) || []).map(r => [r.scope + "|" + (r.branch_id || "") + "|" + normNm(r.label), r.id]));
    const kmap = Object.assign({}, lmap && lmap.k), chkRows = [];
    for (const c of chks) {
      const row = { id: c.id, scope: c.scope === "branch" ? "branch" : "common", branch_id: c.scope === "branch" ? bm(c.branch_id) : null, category: c.category, label: c.label, sort: c.sort, active: c.active === 0 ? 0 : 1 };
      if (!row.label || (row.scope === "branch" && !row.branch_id)) continue;
      const key = row.scope + "|" + (row.branch_id || "") + "|" + normNm(row.label);
      if (haveChk.has(key)) { if (haveChk.get(key) !== row.id) kmap[row.id] = haveChk.get(key); continue; }
      haveChk.set(key, row.id); chkRows.push(row);
    }
    const haveCh = new Set(((ch && ch.results) || []).map(r => r.branch_id + "|" + r.channel));
    const chnRows = chns.map(c => ({ ...c, branch_id: bm(c.branch_id) })).filter(c => c.branch_id && c.channel && !haveCh.has(c.branch_id + "|" + c.channel));
    const costRows = costs.map(c => ({ ...c, branch_id: bm(c.branch_id) })).filter(c => c.branch_id && ymOk(c.ym));
    const asgRows = asgs.map(a => ({ id: a.id, date: a.date, region: a.region || "", branch_id: a.branch_id ? (bm(a.branch_id) || "") : "", worker: who(a.worker), created_by: who(a.created_by), created_at: a.created_at })).filter(a => dOk(a.date) && a.worker);
    const ntcRows = ntcs.map(n => ({ id: n.id, date: n.date, body: n.body, created_by: who(n.created_by), created_name: n.created_by || "", created_at: n.created_at })).filter(n => dOk(n.date) && n.body);
    const readRows = reads.map(r => ({ notice_id: r.notice_id, member_id: uidMap[r.user_id] || who(r.user_name) || String(r.user_id), member_name: r.user_name || "", read_at: r.read_at }));
    const issRows = isss.map(i => ({ ...i, branch_id: bm(i.branch_id), reporter: who(i.reporter), reporter_name: i.reporter || "", assignee: who(i.assignee), comments: (parse(i.comments) || []).map(c => ({ id: c.id || uid("m"), by: who(c.by), name: c.by || "", text: c.text, at: c.at })) })).filter(i => i.title);
    const stmts = [];
    if (ent.length) stmts.push(...upserts(db, me.ws, ent, ts()));
    stmts.push(...spBulk(db, "sp_prof", me.ws, prow, "ignore"), ...spBulk(db, "sp_set", me.ws, setRows, "ignore"),
      ...spBulk(db, "sp_chk", me.ws, chkRows, "ignore"), ...spBulk(db, "sp_chn", me.ws, chnRows, "ignore"), ...spBulk(db, "sp_cost", me.ws, costRows, "ignore"),
      ...spBulk(db, "sp_asg", me.ws, asgRows, "ignore"), ...spBulk(db, "sp_ntc", me.ws, ntcRows, "ignore"), ...spBulk(db, "sp_read", me.ws, readRows, "ignore"),
      ...spBulk(db, "sp_iss", me.ws, issRows, "ignore"),
      db.prepare("INSERT OR IGNORE INTO sp_set(ws,k,v) VALUES(?1,'seeded','1')").bind(me.ws),
      db.prepare("INSERT INTO sp_set(ws,k,v) VALUES(?1,'legacy',?2) ON CONFLICT(ws,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify({ b: bmap, u: umap, i: uidMap, k: kmap, at: now, done: false })));
    const { v } = await spRun(db, me, stmts);
    if (ent.some(x => x.kind === "store")) for (const k of VIS.keys()) if (k.startsWith(me.ws + "|")) VIS.delete(k);
    return json({ ok: true, v, stores: Object.keys(bmap).length, newStores: ent.filter(x => x.kind === "store").length, newMembers, checks: chkRows.length, channels: chnRows.length, issues: issRows.length });
  }
  if (step === "res" || step === "cln") {
    if (!lmap) return fail("legacy-base-first");
    const after = Math.max(0, intOr(b.after, 0)), lim = step === "res" ? 1500 : 800;
    const rows = await legAll(L, `SELECT rowid AS _rid, * FROM ${step === "res" ? "reservations" : "cleanings"} WHERE rowid>?1 ORDER BY rowid LIMIT ${lim}`, after);
    if (!rows) return json({ ok: true, n: 0, next: null });
    const who = n => n ? (lmap.u[n] || String(n)) : null;
    let out;
    if (step === "res") out = rows.map(r => ({ id: r.id, branch_id: lmap.b[r.branch_id] || null, res_date: dOk(r.res_date), slot: SP_SLOTS.includes(r.slot) ? r.slot : "etc", resno: r.resno || "", customer: r.customer || "", phone: r.phone || "", amount: intOr(r.amount, 0), status: r.status || "확정", issue: r.issue || "", memo: r.memo || "", start_t: tOk(r.start_t) || null, end_t: tOk(r.end_t) || null, source: ["excel", "sync", "manual"].includes(r.source) ? r.source : "manual", created_at: r.created_at || iso() })).filter(r => r.res_date && r.branch_id);
    else out = rows.map(r => {
      const parts = String(r.task_key || "").split("|"); parts[0] = lmap.b[parts[0]] || parts[0];
      const km = lmap.k || {}, ch = {};
      for (const [k, v] of Object.entries(spChecks(parse(r.checks)))) ch[km[k] || k] = v;
      return { id: r.id, task_key: parts.join("|"), branch_id: lmap.b[r.branch_id] || null, clean_date: dOk(r.clean_date), kind: SP_KINDS.includes(r.kind) ? r.kind : "etc", assignee: who(r.assignee), status: SP_CLN_ST.includes(r.status) ? r.status : "todo", checks: ch, note: r.note || "", submitted_by: who(r.submitted_by), submitted_name: r.submitted_by || null, submitted_at: r.submitted_at || null, review_by: who(r.review_by), review_name: r.review_by || null, review_at: r.review_at || null, feedback: r.feedback || null, manual: r.manual ? 1 : 0, window_label: r.window_label || "", created_at: r.created_at || iso() };
    }).filter(r => r.clean_date && r.branch_id);
    const next = rows.length === lim ? rows[rows.length - 1]._rid : null;
    if (step === "res") {
      const nos = [...new Set(out.map(r => r.resno).filter(Boolean))];
      if (nos.length) {
        const have = new Set(((await db.prepare("SELECT resno FROM sp_res WHERE ws=?1 AND resno IN (SELECT value FROM json_each(?2)) AND id NOT IN (SELECT value FROM json_each(?3))").bind(me.ws, JSON.stringify(nos), JSON.stringify(out.map(r => r.id))).all()).results || []).map(r => r.resno));
        out = out.filter(r => !r.resno || !have.has(r.resno));
      }
    }
    const stmts = spBulk(db, step === "res" ? "sp_res" : "sp_cln", me.ws, out, "ignore");
    if (step === "cln" && next === null) stmts.push(db.prepare("UPDATE sp_set SET v=json_set(v,'$.done',json('true'),'$.at',?2) WHERE ws=?1 AND k='legacy'").bind(me.ws, iso()));
    const { v } = await spRun(db, me, stmts);
    return json({ ok: true, v, n: out.length, next });
  }
  return fail("bad-request");
}

/* 백업·복원·초기화용 */
async function spBackupRaw(db, ws) {
  const rs = await db.batch(SP_TABLES.map(t => db.prepare(spSel(t, "ws=?1")).bind(ws)));
  return '{"v":1,' + SP_TABLES.map((t, i) => JSON.stringify(t) + ":" + rawArr(rs[i])).join(",") + "}";
}
// 복원: 지울 표는 exec 한 번으로(쿼리 수 절약), 넣기는 batch 안에서
const wsLit = ws => "'" + String(ws).replace(/[^a-z0-9_]/gi, "") + "'";
function spRestoreStmts(db, ws, sp) {
  if (!sp || typeof sp !== "object" || sp.v !== 1) return { dels: [], stmts: [] };
  const dels = [], stmts = [];
  for (const t of SP_TABLES) {
    if (!Array.isArray(sp[t])) continue;
    dels.push(`DELETE FROM ${t} WHERE ws=${wsLit(ws)}`);
    stmts.push(...spBulk(db, t, ws, sp[t].slice(0, 200000), "ignore"));
  }
  return { dels, stmts };
}
const modTables = () => OS_TABLES.concat(CM_TABLES);
async function modBackupRaw(db, ws) {
  const MOD_TABLES = modTables();
  const rs = await db.batch(MOD_TABLES.map(t => db.prepare(spSel(t, "ws=?1")).bind(ws)).concat([db.prepare("SELECT json_object('mod',mod,'k',k,'v',CASE WHEN json_valid(v) THEN json(v) ELSE json('null') END) AS j FROM mod_set WHERE ws=?1").bind(ws)]));
  return '{"v":1,' + MOD_TABLES.map((t, i) => JSON.stringify(t) + ":" + rawArr(rs[i])).join(",") + ',"mod_set":' + rawArr(rs[MOD_TABLES.length]) + "}";
}
function modRestoreStmts(db, ws, m) {
  if (!m || typeof m !== "object" || m.v !== 1) return { dels: [], stmts: [] };
  const dels = [], stmts = [];
  for (const t of modTables()) {
    if (!Array.isArray(m[t])) continue;
    dels.push(`DELETE FROM ${t} WHERE ws=${wsLit(ws)}`);
    stmts.push(...spBulk(db, t, ws, m[t].slice(0, 200000), "ignore"));
  }
  if (Array.isArray(m.mod_set)) {
    dels.push(`DELETE FROM mod_set WHERE ws=${wsLit(ws)}`);
    stmts.push(db.prepare("INSERT OR IGNORE INTO mod_set(ws,mod,k,v) SELECT ?1, json_extract(value,'$.mod'), json_extract(value,'$.k'), json_extract(value,'$.v') FROM json_each(?2) WHERE true").bind(ws, JSON.stringify(m.mod_set.slice(0, 200).map(r => ({ mod: clip(r && r.mod, 10), k: clip(r && r.k, 40), v: JSON.stringify(r && r.v !== undefined ? r.v : null) })))));
  }
  return { dels, stmts };
}
const spWipeSql = ws => [
  ...["sp_res", "sp_cln", "sp_iss", "sp_chn", "sp_cost", "sp_asg", "sp_ntc", "sp_read", "sp_log", "sp_prof"].map(t => `DELETE FROM ${t} WHERE ws=${wsLit(ws)}`),
  `DELETE FROM sp_chk WHERE ws=${wsLit(ws)} AND scope<>'common'`,
  `DELETE FROM sp_set WHERE ws=${wsLit(ws)} AND k='legacy'`
];

/* ═════════ 아웃소싱 — 외주를 받는 프리랜서 (고객 → 안건 → 견적 → 납품 → 청구 → 입금) ═════════
   · 고객은 마이웍스 연락처(ent kind=contact)이고, 안건·견적·청구는 전용 표에 둡니다.
   · 견적·청구는 확인 링크로 상대방에게 보내고, 승인·확인이 돌아오면 활동 기록과 홈의 "오늘 결정할 것"에 보입니다. */
const OS_DDL = [
  "CREATE TABLE IF NOT EXISTS mod_set(ws TEXT NOT NULL, mod TEXT NOT NULL, k TEXT NOT NULL, v TEXT, PRIMARY KEY(ws,mod,k))",
  "CREATE TABLE IF NOT EXISTS os_job(ws TEXT NOT NULL, id TEXT NOT NULL, client_id TEXT, client_name TEXT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'inquiry', detail TEXT, due TEXT, amount INTEGER NOT NULL DEFAULT 0, terms TEXT, source TEXT, created_by TEXT, created_at TEXT, updated_at TEXT, closed_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_os_job_upd ON os_job(ws,updated_at)",
  "CREATE TABLE IF NOT EXISTS os_quote(ws TEXT NOT NULL, id TEXT NOT NULL, job_id TEXT NOT NULL, no TEXT, items TEXT NOT NULL DEFAULT '[]', vat INTEGER NOT NULL DEFAULT 1, supply INTEGER NOT NULL DEFAULT 0, tax INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, valid_until TEXT, status TEXT NOT NULL DEFAULT 'draft', note TEXT, reply_note TEXT, replied_at TEXT, replied_by TEXT, approved_at TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_os_quote_job ON os_quote(ws,job_id)",
  "CREATE TABLE IF NOT EXISTS os_invoice(ws TEXT NOT NULL, id TEXT NOT NULL, job_id TEXT NOT NULL, no TEXT, amount INTEGER NOT NULL DEFAULT 0, tax_mode TEXT NOT NULL DEFAULT 'vat', tax INTEGER NOT NULL DEFAULT 0, net INTEGER NOT NULL DEFAULT 0, due_date TEXT, status TEXT NOT NULL DEFAULT 'issued', paid_at TEXT, pay_link TEXT, memo TEXT, ack_at TEXT, ack_by TEXT, ack_note TEXT, fin_id TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_os_inv_job ON os_invoice(ws,job_id)"
];
const OS_TABLES = ["os_job", "os_quote", "os_invoice"];
Object.assign(SPC, {
  os_job: ["id", "client_id", "client_name", "title", "status", "detail", "due", "amount", "terms", "source", "created_by", "created_at", "updated_at", "closed_at"],
  os_quote: ["id", "job_id", "no", "items", "vat", "supply", "tax", "total", "valid_until", "status", "note", "reply_note", "replied_at", "replied_by", "approved_at", "created_at", "updated_at"],
  os_invoice: ["id", "job_id", "no", "amount", "tax_mode", "tax", "net", "due_date", "status", "paid_at", "pay_link", "memo", "ack_at", "ack_by", "ack_note", "fin_id", "created_at", "updated_at"]
});
Object.assign(SPJ, { os_job: { terms: "null" }, os_quote: { items: "[]" } });
const OS_JOB_ST = ["inquiry", "quote", "active", "delivered", "billing", "done", "hold"];
const OS_QUOTE_ST = ["draft", "sent", "approved", "changed", "void"];
const OS_INV_ST = ["issued", "paid", "void"];
const TAX_MODES = ["vat", "wh33", "none"];
const osNo = p => p + "-" + kstToday().replace(/-/g, "").slice(2) + "-" + rand(2).toUpperCase();
function osTax(amount, mode) {   // vat: 공급가에 10% 더해 청구 · wh33: 3.3% 떼고 받음 · none: 그대로
  amount = Math.max(0, intOr(amount, 0));
  if (mode === "vat") { const tax = Math.round(amount * 0.1); return { tax, net: amount + tax }; }
  if (mode === "wh33") { const tax = Math.round(amount * 0.033); return { tax, net: amount - tax }; }
  return { tax: 0, net: amount };
}
function osItems(items) {
  const out = []; let supply = 0;
  for (const it of (Array.isArray(items) ? items : []).slice(0, 60)) {
    if (!it || typeof it !== "object") continue;
    const title = clip(it.title, 120); if (!title) continue;
    const qty = Math.max(0, Math.round(Number(it.qty) * 100) / 100 || 0), unit = Math.max(0, intOr(it.unit, 0)), amt = Math.round(qty * unit);
    out.push({ title, qty, unit, amount: amt, note: clip(it.note, 200) }); supply += amt;
  }
  return { items: out, supply };
}
async function modSettings(db, ws, mod) {
  const rs = (await db.prepare("SELECT k, v FROM mod_set WHERE ws=?1 AND mod=?2").bind(ws, mod).all()).results || [];
  const o = {}; for (const r of rs) o[r.k] = parse(r.v); return o;
}
function osNorm(s) {
  s = s && typeof s === "object" ? s : {};
  const sender = s.sender && typeof s.sender === "object" ? s.sender : {};
  return {
    business: s.business === "biz" ? "biz" : "indiv",   // 사업자(세금계산서·VAT) / 미등록(3.3% 원천징수)
    sender: { name: clip(sender.name, 40), company: clip(sender.company, 60), phone: clip(sender.phone, 40), email: clip(sender.email, 80), bizno: clip(sender.bizno, 20) },
    bank: clip(s.bank, 120), contract_url: clip(s.contract_url, 300), quote_note: clip(s.quote_note, 1000),
    rates: (Array.isArray(s.rates) ? s.rates : []).slice(0, 40).map(r => ({ title: clip(r && r.title, 80), unit: Math.max(0, intOr(r && r.unit, 0)) })).filter(r => r.title),
    fees: { kmong: clampInt(s.fees && s.fees.kmong, 0, 100, 0), wishket: clampInt(s.fees && s.fees.wishket, 0, 100, 0), other: clampInt(s.fees && s.fees.other, 0, 100, 0) }
  };
}
async function osSettings(db, ws) { const m = await modSettings(db, ws, "os"); return osNorm(m.settings); }
async function osCreateJobItems(db, me, p) {   // AI 제안 → 안건 만들기 (고객 이름이 있으면 연락처를 찾거나 만듭니다)
  const items = [], now = iso(); let client = null;
  if (p.client) {
    client = await findEnt(db, me.ws, "contact", p.client);
    if (!client) { const c = { id: uid("ct"), name: p.client, company: "", phone: "", email: "", kind: "고객", memo: "", source: "ai", createdAt: now, updatedAt: now }; items.push({ kind: "contact", id: c.id, data: c }); client = { id: c.id, d: c }; }
  }
  const job = { id: uid("j"), client_id: client ? client.id : null, client_name: client ? client.d.name : "", title: p.title, status: "inquiry", detail: p.detail, due: p.due || null, amount: p.amount, terms: null, source: "ai", created_by: me.id, created_at: now, updated_at: now, closed_at: null };
  items.push(actRow(me, `AI 제안으로 안건 "${job.title}"을(를) 만들었습니다.`));
  return { items, stmts: spBulk(db, "os_job", me.ws, [job]).concat([db.prepare("UPDATE workspaces SET sp_ver=sp_ver+1 WHERE id=?1").bind(me.ws)]), applied: { jobId: job.id, title: job.title, client: job.client_name } };
}
async function osAiSummary(db, me) {
  const today = kstToday(), week = addDaysS(today, 7);
  const [jobs, quotes, inv] = await db.batch([
    db.prepare("SELECT id, title, client_name, status, due, amount FROM os_job WHERE ws=?1 AND status NOT IN ('done') ORDER BY updated_at DESC LIMIT 300").bind(me.ws),
    db.prepare("SELECT q.id, q.no, q.total, q.status, q.valid_until, q.reply_note, j.title FROM os_quote q JOIN os_job j ON j.ws=q.ws AND j.id=q.job_id WHERE q.ws=?1 AND q.status IN ('sent','changed','approved') AND q.updated_at>=?2 ORDER BY q.updated_at DESC LIMIT 100").bind(me.ws, new Date(Date.now() - 60 * 864e5).toISOString()),
    db.prepare("SELECT v.id, v.no, v.net, v.amount, v.due_date, v.status, j.title, j.client_name FROM os_invoice v JOIN os_job j ON j.ws=v.ws AND j.id=v.job_id WHERE v.ws=?1 AND v.status='issued' ORDER BY v.due_date LIMIT 100").bind(me.ws)
  ]);
  const J = (jobs && jobs.results) || [], Q = (quotes && quotes.results) || [], V = (inv && inv.results) || [];
  const byStatus = {}; for (const j of J) byStatus[j.status] = (byStatus[j.status] || 0) + 1;
  return {
    openJobs: J.length, jobsByStatus: byStatus,
    dueThisWeek: J.filter(j => j.due && j.due >= today && j.due <= week).map(j => ({ id: j.id, title: j.title, client: j.client_name || "", due: j.due, status: j.status })),
    overdue: J.filter(j => j.due && j.due < today && !["done", "hold"].includes(j.status)).map(j => ({ id: j.id, title: j.title, client: j.client_name || "", due: j.due })),
    quotesAwaiting: Q.filter(q => q.status === "sent").map(q => ({ id: q.id, no: q.no, title: q.title, total: q.total, validUntil: q.valid_until || "" })),
    quoteReplies: Q.filter(q => q.status !== "sent").map(q => ({ id: q.id, no: q.no, title: q.title, status: q.status, note: q.reply_note || "" })),
    unpaid: { count: V.length, sum: V.reduce((s, v) => s + Number(v.net || 0), 0), overdue: V.filter(v => v.due_date && v.due_date < today).map(v => ({ id: v.id, no: v.no, title: v.title, client: v.client_name || "", net: v.net, dueDate: v.due_date })) }
  };
}
// 견적 승인 → 안건 계약 조건에 승인 견적을 합칩니다 (직접 적어 둔 범위·대금 조건은 그대로 둡니다)
const osAccept = (j, q, now, by) => Object.assign({}, (j && j.terms && typeof j.terms === "object") ? j.terms : {}, { accepted_quote: q.id, total: q.total, vat: !!q.vat, at: now, by: clip(by, 40) });
const osJobOk = async (db, me, id) => !!(await db.prepare("SELECT 1 AS x FROM os_job WHERE ws=?1 AND id=?2").bind(me.ws, String(id || "")).first());
const OUTS = {
  async data(db, me) {
    const since = new Date(Date.now() - 400 * 864e5).toISOString();
    const rs = await db.batch([
      db.prepare(spSel("os_job", "ws=?1 AND (status NOT IN ('done') OR updated_at>=?2)", "ORDER BY updated_at DESC LIMIT 2000")).bind(me.ws, since),
      db.prepare(spSel("os_quote", "ws=?1 AND job_id IN (SELECT id FROM os_job WHERE ws=?1 AND (status NOT IN ('done') OR updated_at>=?2))")).bind(me.ws, since),
      db.prepare(spSel("os_invoice", "ws=?1 AND (status='issued' OR updated_at>=?2)")).bind(me.ws, since),
      db.prepare("SELECT k, v FROM mod_set WHERE ws=?1 AND mod='os'").bind(me.ws)
    ]);
    const set = {}; for (const r of (rs[3] && rs[3].results) || []) set[r.k] = parse(r.v);
    return rawJson({ ok: true, v: me.spv, settings: osNorm(set.settings) }, ',"jobs":' + rawArr(rs[0]) + ',"quotes":' + rawArr(rs[1]) + ',"invoices":' + rawArr(rs[2]));
  },
  async "job/save"(db, me, b) {
    const id = clip(b.id, 60), now = iso();
    const ex = id ? await spOne(db, "os_job", me.ws, id) : null;
    if (id && !ex) return fail("not-found", 404);
    const o = {};
    if ("title" in b || !ex) { o.title = clip(b.title, 120); if (!o.title) return fail("bad-request"); }
    if ("client_id" in b) { o.client_id = clip(b.client_id, 60) || null; if (o.client_id) { const c = await entData(db, me.ws, "contact", o.client_id); if (!c) return fail("not-found", 404); o.client_name = clip(c.name, 60); } }
    if ("client_name" in b && !o.client_id) o.client_name = clip(b.client_name, 60);
    if ("status" in b) { if (!OS_JOB_ST.includes(b.status)) return fail("bad-request"); o.status = b.status; o.closed_at = b.status === "done" ? now : null; }
    if ("detail" in b) o.detail = clip(b.detail, 4000);
    if ("due" in b) o.due = dOk(b.due) || null;
    if ("amount" in b) o.amount = Math.max(0, intOr(b.amount, 0));
    if ("terms" in b) o.terms = b.terms && typeof b.terms === "object" ? JSON.stringify({ scope: clip(b.terms.scope, 1000), deadline: clip(b.terms.deadline, 60), revisions: clampInt(b.terms.revisions, 0, 99, 0), payment: clip(b.terms.payment, 300), extra: clip(b.terms.extra, 1000), accepted_quote: clip(b.terms.accepted_quote, 60), total: intOr(b.terms.total, 0), at: clip(b.terms.at, 40), by: clip(b.terms.by, 40) }) : null;
    o.updated_at = now;
    if (ex) {
      const { v } = await spRun(db, me, [db.prepare(`UPDATE os_job SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, ex.id, ...Object.values(o))]);
      return json({ ok: true, v, job: await spOne(db, "os_job", me.ws, ex.id) });
    }
    const row = Object.assign({ id: uid("j"), client_id: null, client_name: "", title: "", status: "inquiry", detail: "", due: null, amount: 0, terms: null, source: "manual", created_by: me.id, created_at: now, updated_at: now, closed_at: null }, o);
    const { v } = await spRun(db, me, spBulk(db, "os_job", me.ws, [row]));
    return json({ ok: true, v, job: await spOne(db, "os_job", me.ws, row.id) });
  },
  async "job/del"(db, me, b) {
    const id = clip(b.id, 60);
    const paid = await db.prepare("SELECT 1 AS x FROM os_invoice WHERE ws=?1 AND job_id=?2 AND status='paid'").bind(me.ws, id).first();
    if (paid) return fail("has-paid");
    const { v } = await spRun(db, me, [
      db.prepare("DELETE FROM os_quote WHERE ws=?1 AND job_id=?2").bind(me.ws, id),
      db.prepare("DELETE FROM os_invoice WHERE ws=?1 AND job_id=?2").bind(me.ws, id),
      db.prepare("DELETE FROM os_job WHERE ws=?1 AND id=?2").bind(me.ws, id)
    ]);
    return json({ ok: true, v });
  },
  async "quote/save"(db, me, b) {
    const id = clip(b.id, 60), now = iso();
    const ex = id ? await spOne(db, "os_quote", me.ws, id) : null;
    if (id && !ex) return fail("not-found", 404);
    if (ex && ["approved", "void"].includes(ex.status) && !(ex.status === "approved" && b.status === "void" && Object.keys(b).every(k => k === "id" || k === "status"))) return fail("locked", 409);   // 승인된 견적은 무효 처리만, 무효는 그대로
    const o = {};
    if (!ex) { o.job_id = clip(b.job_id, 60); if (!await osJobOk(db, me, o.job_id)) return fail("not-found", 404); }
    if ("items" in b) { const r = osItems(b.items); o.items = JSON.stringify(r.items); o.supply = r.supply; }
    if ("vat" in b) o.vat = b.vat ? 1 : 0;
    if ("valid_until" in b) o.valid_until = dOk(b.valid_until) || null;
    if ("note" in b) o.note = clip(b.note, 2000);
    if ("no" in b) o.no = clip(b.no, 40);
    if ("status" in b) { if (!OS_QUOTE_ST.includes(b.status)) return fail("bad-request"); o.status = b.status; if (b.status === "approved") o.approved_at = now; }
    const vat = "vat" in o ? o.vat : ex ? ex.vat : 1, supply = "supply" in o ? o.supply : ex ? ex.supply : 0;
    o.tax = vat ? Math.round(supply * 0.1) : 0; o.total = supply + o.tax; o.updated_at = now;
    if (ex) {
      const stmts = [db.prepare(`UPDATE os_quote SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, ex.id, ...Object.values(o))];
      if (o.status === "approved") { const j = await spOne(db, "os_job", me.ws, ex.job_id); stmts.push(db.prepare("UPDATE os_job SET status=CASE WHEN status IN ('inquiry','quote') THEN 'active' ELSE status END, amount=CASE WHEN amount=0 THEN ?3 ELSE amount END, terms=?5, updated_at=?4 WHERE ws=?1 AND id=?2").bind(me.ws, ex.job_id, o.total, now, JSON.stringify(osAccept(j, Object.assign({}, ex, o), now, me.name)))); }
      else if (o.status === "sent") stmts.push(db.prepare("UPDATE os_job SET status=CASE WHEN status='inquiry' THEN 'quote' ELSE status END, updated_at=?3 WHERE ws=?1 AND id=?2").bind(me.ws, ex.job_id, now));
      const { v } = await spRun(db, me, stmts);
      return json({ ok: true, v, quote: await spOne(db, "os_quote", me.ws, ex.id) });
    }
    const row = Object.assign({ id: uid("q"), no: osNo("Q"), items: "[]", vat: 1, supply: 0, status: "draft", valid_until: null, note: "", reply_note: "", replied_at: null, replied_by: null, approved_at: null, created_at: now, updated_at: now }, o);
    const { v } = await spRun(db, me, spBulk(db, "os_quote", me.ws, [row]).concat([db.prepare("UPDATE os_job SET status=CASE WHEN status='inquiry' THEN 'quote' ELSE status END, updated_at=?3 WHERE ws=?1 AND id=?2").bind(me.ws, row.job_id, now)]));
    return json({ ok: true, v, quote: await spOne(db, "os_quote", me.ws, row.id) });
  },
  async "quote/del"(db, me, b) {
    const id = clip(b.id, 60), ex = await spOne(db, "os_quote", me.ws, id);
    if (!ex) return fail("not-found", 404);
    if (ex.status === "approved") return fail("locked", 409);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM os_quote WHERE ws=?1 AND id=?2").bind(me.ws, id), db.prepare("UPDATE links SET expires_at=?3 WHERE ws=?1 AND kind='quote' AND target=?2").bind(me.ws, id, iso())]);
    return json({ ok: true, v });
  },
  async "invoice/save"(db, me, b) {
    const id = clip(b.id, 60), now = iso();
    const ex = id ? await spOne(db, "os_invoice", me.ws, id) : null;
    if (id && !ex) return fail("not-found", 404);
    if (ex && ex.status === "paid" && (!("status" in b) || Object.keys(b).some(k => !["id", "status", "paid_at", "fin_id"].includes(k)))) return fail("locked", 409);   // 입금된 청구서는 상태·입금일·재무 연결만
    const o = {};
    if (!ex) { o.job_id = clip(b.job_id, 60); if (!await osJobOk(db, me, o.job_id)) return fail("not-found", 404); }
    if ("amount" in b) o.amount = Math.max(0, intOr(b.amount, 0));
    if ("tax_mode" in b) { if (!TAX_MODES.includes(b.tax_mode)) return fail("bad-request"); o.tax_mode = b.tax_mode; }
    if ("due_date" in b) o.due_date = dOk(b.due_date) || null;
    if ("pay_link" in b) o.pay_link = clip(b.pay_link, 300);
    if ("memo" in b) o.memo = clip(b.memo, 1000);
    if ("no" in b) o.no = clip(b.no, 40);
    if ("status" in b) { if (!OS_INV_ST.includes(b.status)) return fail("bad-request"); o.status = b.status; o.paid_at = b.status === "paid" ? (dOk(b.paid_at) || kstToday()) : null; }
    if ("fin_id" in b) o.fin_id = clip(b.fin_id, 60) || null;
    const amount = "amount" in o ? o.amount : ex ? ex.amount : 0, mode = "tax_mode" in o ? o.tax_mode : ex ? ex.tax_mode : "vat";
    Object.assign(o, osTax(amount, mode), { updated_at: now });
    if (ex) {
      const stmts = [db.prepare(`UPDATE os_invoice SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, ex.id, ...Object.values(o))];
      if (o.status === "paid") stmts.push(db.prepare("UPDATE os_job SET status=CASE WHEN status IN ('delivered','billing') THEN 'done' ELSE status END, closed_at=CASE WHEN status IN ('delivered','billing') THEN ?3 ELSE closed_at END, updated_at=?3 WHERE ws=?1 AND id=?2 AND NOT EXISTS (SELECT 1 FROM os_invoice WHERE ws=?1 AND job_id=?2 AND status='issued' AND id<>?4)").bind(me.ws, ex.job_id, now, ex.id));
      const { v } = await spRun(db, me, stmts);
      return json({ ok: true, v, invoice: await spOne(db, "os_invoice", me.ws, ex.id) });
    }
    const row = Object.assign({ id: uid("v"), no: osNo("I"), amount: 0, tax_mode: "vat", tax: 0, net: 0, due_date: null, status: "issued", paid_at: null, pay_link: "", memo: "", ack_at: null, ack_by: null, ack_note: null, fin_id: null, created_at: now, updated_at: now }, o);
    const { v } = await spRun(db, me, spBulk(db, "os_invoice", me.ws, [row]).concat([db.prepare("UPDATE os_job SET status=CASE WHEN status IN ('active','delivered') THEN 'billing' ELSE status END, updated_at=?3 WHERE ws=?1 AND id=?2").bind(me.ws, row.job_id, now)]));
    return json({ ok: true, v, invoice: await spOne(db, "os_invoice", me.ws, row.id) });
  },
  async "invoice/del"(db, me, b) {
    const id = clip(b.id, 60), ex = await spOne(db, "os_invoice", me.ws, id);
    if (!ex) return fail("not-found", 404);
    if (ex.status === "paid") return fail("locked", 409);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM os_invoice WHERE ws=?1 AND id=?2").bind(me.ws, id), db.prepare("UPDATE links SET expires_at=?3 WHERE ws=?1 AND kind='invoice' AND target=?2").bind(me.ws, id, iso())]);
    return json({ ok: true, v });
  },
  async settings(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    if (b.set !== undefined) {
      const s = osNorm(b.set);
      const { v } = await spRun(db, me, [db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'os','settings',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(s))]);
      return json({ ok: true, v, settings: s });
    }
    return json({ ok: true, settings: await osSettings(db, me.ws) });
  }
};

/* ═════════ 커머스 — 온라인·오프라인 상품 판매 (주문 → 발송 → 재고 → 정산 손익) ═════════
   · 주문은 엑셀 업로드·직접 입력으로 들어오고, 발송 담당(청소 근무자와 같은 worker 역할)은 오늘 발송할 주문만 봅니다.
   · 발송 담당에게는 금액·매입가·정산 정보가 가지 않고, 수령인 정보는 발송 전 주문에만 보냅니다. */
const CM_DDL = [
  "CREATE TABLE IF NOT EXISTS cm_channel(ws TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, fee_pct REAL NOT NULL DEFAULT 0, settle_days INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(ws,id))",
  "CREATE TABLE IF NOT EXISTS cm_product(ws TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, sku TEXT, price INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0, safety INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, memo TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE TABLE IF NOT EXISTS cm_order(ws TEXT NOT NULL, id TEXT NOT NULL, channel_id TEXT, order_no TEXT, order_date TEXT NOT NULL, product_id TEXT, product_name TEXT, option TEXT, qty INTEGER NOT NULL DEFAULT 1, amount INTEGER NOT NULL DEFAULT 0, ship_fee INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new', receiver TEXT, phone TEXT, address TEXT, tracking TEXT, carrier TEXT, memo TEXT, settle_date TEXT, settle_amt INTEGER, source TEXT NOT NULL DEFAULT 'manual', created_at TEXT, updated_at TEXT, shipped_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_cm_order_date ON cm_order(ws,order_date)",
  "CREATE INDEX IF NOT EXISTS idx_cm_order_no ON cm_order(ws,order_no)",
  "CREATE TABLE IF NOT EXISTS cm_inquiry(ws TEXT NOT NULL, id TEXT NOT NULL, channel_id TEXT, order_no TEXT, customer TEXT, text TEXT NOT NULL, due TEXT, status TEXT NOT NULL DEFAULT 'open', answer TEXT, answered_at TEXT, created_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE TABLE IF NOT EXISTS cm_cost(ws TEXT NOT NULL, ym TEXT NOT NULL, channel_id TEXT NOT NULL, ads INTEGER NOT NULL DEFAULT 0, misc INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(ws,ym,channel_id))"
];
const CM_TABLES = ["cm_channel", "cm_product", "cm_order", "cm_inquiry", "cm_cost"];
Object.assign(SPC, {
  cm_channel: ["id", "name", "fee_pct", "settle_days", "sort", "active"],
  cm_product: ["id", "name", "sku", "price", "cost", "stock", "safety", "active", "memo", "created_at", "updated_at"],
  cm_order: ["id", "channel_id", "order_no", "order_date", "product_id", "product_name", "option", "qty", "amount", "ship_fee", "status", "receiver", "phone", "address", "tracking", "carrier", "memo", "settle_date", "settle_amt", "source", "created_at", "updated_at", "shipped_at"],
  cm_inquiry: ["id", "channel_id", "order_no", "customer", "text", "due", "status", "answer", "answered_at", "created_at"],
  cm_cost: ["ym", "channel_id", "ads", "misc"]
});
const CM_ORDER_ST = ["new", "packed", "shipped", "done", "cancel", "return"];
const CM_SHIPPED = new Set(["shipped", "done"]);
const CM_SEED_CH = [["네이버 스마트스토어", 3.5, 7], ["쿠팡", 10.8, 14], ["자사몰", 3.4, 3], ["오프라인 · 직접 판매", 0, 0]];
function cmOrderIn(r, ex) {
  const o = {};
  if ("channel_id" in r) o.channel_id = clip(r.channel_id, 60) || null;
  if ("order_no" in r) o.order_no = clip(r.order_no, 60);
  if ("order_date" in r) { o.order_date = dOk(r.order_date); if (!o.order_date) delete o.order_date; }
  if ("product_id" in r) o.product_id = clip(r.product_id, 60) || null;
  if ("product_name" in r) o.product_name = clip(r.product_name, 120);
  if ("option" in r) o.option = clip(r.option, 120);
  if ("qty" in r) o.qty = clampInt(r.qty, 0, 100000, 1);
  if ("amount" in r) o.amount = Math.max(-100000000, Math.min(1000000000, intOr(String(r.amount ?? "").replace(/[^\d.-]/g, ""), 0)));
  if ("ship_fee" in r) o.ship_fee = Math.max(0, intOr(String(r.ship_fee ?? "").replace(/[^\d.-]/g, ""), 0));
  if ("status" in r && CM_ORDER_ST.includes(r.status)) o.status = r.status;
  if ("receiver" in r) o.receiver = clip(r.receiver, 40);
  if ("phone" in r) o.phone = clip(r.phone, 40);
  if ("address" in r) o.address = clip(r.address, 200);
  if ("tracking" in r) o.tracking = clip(r.tracking, 40);
  if ("carrier" in r) o.carrier = clip(r.carrier, 30);
  if ("memo" in r) o.memo = clip(r.memo, 500);
  if ("settle_date" in r) o.settle_date = dOk(r.settle_date) || null;
  if ("settle_amt" in r) o.settle_amt = r.settle_amt === "" || r.settle_amt == null ? null : intOr(r.settle_amt, 0);
  return o;
}
async function cmSeed(db, me) {
  const r = await db.prepare("INSERT OR IGNORE INTO mod_set(ws,mod,k,v) VALUES(?1,'cm','seeded','1')").bind(me.ws).run();
  if (!r || !r.meta || !r.meta.changes) return false;
  await spRun(db, me, spBulk(db, "cm_channel", me.ws, CM_SEED_CH.map((c, i) => ({ id: bulkId("ch"), name: c[0], fee_pct: c[1], settle_days: c[2], sort: i + 1, active: 1 }))));
  return true;
}
async function cmAiSummary(db, me) {
  const ym = kstToday().slice(0, 7);
  const [ship, inq, low, rev, ch] = await db.batch([
    db.prepare("SELECT status, COUNT(*) AS n FROM cm_order WHERE ws=?1 AND status IN ('new','packed') GROUP BY status").bind(me.ws),
    db.prepare("SELECT id, customer, text, due, order_no FROM cm_inquiry WHERE ws=?1 AND status='open' ORDER BY due LIMIT 50").bind(me.ws),
    db.prepare("SELECT id, name, stock, safety FROM cm_product WHERE ws=?1 AND active=1 AND stock<=safety ORDER BY stock LIMIT 50").bind(me.ws),
    db.prepare("SELECT channel_id, SUM(amount) AS rev, COUNT(*) AS n FROM cm_order WHERE ws=?1 AND order_date>=?2 AND status NOT IN ('cancel','return') GROUP BY channel_id").bind(me.ws, ym + "-01"),
    db.prepare("SELECT id, name FROM cm_channel WHERE ws=?1").bind(me.ws)
  ]);
  const C = new Map(((ch && ch.results) || []).map(c => [c.id, c.name]));
  const st = {}; for (const r of (ship && ship.results) || []) st[r.status] = Number(r.n);
  return {
    toShip: (st.new || 0) + (st.packed || 0), byStatus: st,
    inquiriesOpen: ((inq && inq.results) || []).map(i => ({ id: i.id, customer: i.customer || "", text: clip(i.text, 200), due: i.due || "", orderNo: i.order_no || "" })),
    lowStock: ((low && low.results) || []).map(p => ({ id: p.id, name: p.name, stock: p.stock, safety: p.safety })),
    monthRevenue: { ym, byChannel: ((rev && rev.results) || []).map(r => ({ channel: C.get(r.channel_id) || "미지정", revenue: Number(r.rev), orders: Number(r.n) })), total: ((rev && rev.results) || []).reduce((s, r) => s + Number(r.rev), 0) }
  };
}
const cmWorkerOrder = r => ({ id: r.id, channel_id: r.channel_id, order_no: r.order_no, order_date: r.order_date, product_id: r.product_id, product_name: r.product_name, option: r.option, qty: r.qty, status: r.status, receiver: r.receiver, phone: r.phone, address: r.address, tracking: r.tracking, carrier: r.carrier, memo: r.memo, shipped_at: r.shipped_at });
const COMM = {
  async data(db, me, b, req, url) {
    const today = kstToday(), mgr = isMgr(me);
    let from = dOk(url.searchParams.get("from")) || addDaysS(today, -30), to = dOk(url.searchParams.get("to")) || today;
    if (to < from) [from, to] = [to, from];
    if (to > addDaysS(from, 400)) to = addDaysS(from, 400);
    const seeded = mgr ? await cmSeed(db, me) : false;   // 처음 열 때 기본 채널을 넣으면 버전이 하나 올라갑니다
    const q = [
      db.prepare("SELECT k, v FROM mod_set WHERE ws=?1 AND mod='cm'").bind(me.ws),
      db.prepare(spSel("cm_channel", "ws=?1", "ORDER BY sort")).bind(me.ws),
      mgr ? db.prepare(spSel("cm_product", "ws=?1", "ORDER BY name")).bind(me.ws) : db.prepare("SELECT id, name, sku, stock, active FROM cm_product WHERE ws=?1 AND active=1 ORDER BY name").bind(me.ws),
      mgr ? db.prepare(spSel("cm_order", "ws=?1 AND ((order_date>=?2 AND order_date<=?3) OR status IN ('new','packed'))", "ORDER BY order_date DESC")).bind(me.ws, from, to)
        : db.prepare(spSel("cm_order", "ws=?1 AND (status IN ('new','packed') OR (status='shipped' AND shipped_at>=?2))")).bind(me.ws, addDaysS(today, -2))
    ];
    if (mgr) q.push(
      db.prepare(spSel("cm_inquiry", "ws=?1 AND (status='open' OR created_at>=?2)", "ORDER BY created_at DESC LIMIT 500")).bind(me.ws, new Date(Date.now() - 90 * 864e5).toISOString()),
      db.prepare(spSel("cm_cost", "ws=?1 AND ym>=?2 AND ym<=?3")).bind(me.ws, addDaysS(from, -32).slice(0, 7), to.slice(0, 7))
    );
    const rs = await db.batch(q);
    const set = {}; for (const r of (rs[0] && rs[0].results) || []) set[r.k] = parse(r.v);
    const head = { ok: true, v: me.spv + (seeded ? 1 : 0), from, to, today, role: mgr ? "mgr" : me.role, settings: cmNorm(set.settings) };
    if (mgr) return rawJson(head, ',"channels":' + rawArr(rs[1]) + ',"products":' + rawArr(rs[2]) + ',"orders":' + rawArr(rs[3]) + ',"inquiries":' + rawArr(rs[4]) + ',"costs":' + rawArr(rs[5]));
    return rawJson(head, ',"channels":' + JSON.stringify(rowsOf(rs[1]).map(c => ({ id: c.id, name: c.name }))) + ',"products":' + JSON.stringify((rs[2] && rs[2].results) || []) + ',"orders":' + JSON.stringify(rowsOf(rs[3]).map(cmWorkerOrder)) + ',"inquiries":[],"costs":[]');
  },
  async "order/save"(db, me, b) {
    const id = clip(b.id, 60), now = iso(), mgr = isMgr(me);
    const ex = id ? await spOne(db, "cm_order", me.ws, id) : null;
    if (id && !ex) return fail("not-found", 404);
    if (!mgr) {   // 발송 담당은 송장·발송 상태·메모만, 그것도 발송 전이거나 막 발송한 주문만 (앞으로만 진행)
      const recent = ex && ex.status === "shipped" && String(ex.shipped_at || "") >= addDaysS(kstToday(), -2);
      if (!ex || !(["new", "packed"].includes(ex.status) || recent)) return fail("forbidden", 403);
      const allow = {}; for (const k of ["tracking", "carrier", "memo"]) if (k in b) allow[k] = b[k];
      if ("status" in b && ex.status !== "shipped" && ["packed", "shipped"].includes(b.status) && !(ex.status === "packed" && b.status === "packed")) allow.status = b.status;
      b = allow;
    }
    const o = cmOrderIn(b);
    if (!ex && !o.order_date) return fail("bad-date");
    if ("product_id" in o && o.product_id && !(await db.prepare("SELECT 1 AS x FROM cm_product WHERE ws=?1 AND id=?2").bind(me.ws, o.product_id).first())) return fail("not-found", 404);
    o.updated_at = now;
    const stmts = [];
    const was = ex ? CM_SHIPPED.has(ex.status) : false, will = CM_SHIPPED.has(o.status || (ex ? ex.status : "new"));
    const pidOld = ex ? ex.product_id : null, pidNew = "product_id" in o ? o.product_id : pidOld, qOld = ex ? ex.qty : 0, qNew = "qty" in o ? o.qty : (ex ? ex.qty : 1);
    const stockAdj = (pid, n) => { if (pid && n) stmts.push(db.prepare("UPDATE cm_product SET stock=stock-?3, updated_at=?4 WHERE ws=?1 AND id=?2").bind(me.ws, pid, n, now)); };
    if (o.status && !was && will) o.shipped_at = now;
    if (!was && will) stockAdj(pidNew, qNew);                       // 발송하면 재고 차감
    else if (was && !will) stockAdj(pidOld, -qOld);                 // 발송을 되돌리거나 취소·반품이면 복구
    else if (was && will) { if (pidOld !== pidNew) { stockAdj(pidOld, -qOld); stockAdj(pidNew, qNew); } else stockAdj(pidOld, qNew - qOld); }   // 발송된 채 상품·수량이 바뀌면 그 차이만
    if (ex) {
      stmts.unshift(db.prepare(`UPDATE cm_order SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, ex.id, ...Object.values(o)));
      const { v } = await spRun(db, me, stmts);
      const row = await spOne(db, "cm_order", me.ws, ex.id);
      return json({ ok: true, v, order: mgr ? row : cmWorkerOrder(row) });
    }
    const row = Object.assign({ id: uid("o"), channel_id: null, order_no: "", product_id: null, product_name: "", option: "", qty: 1, amount: 0, ship_fee: 0, status: "new", receiver: "", phone: "", address: "", tracking: "", carrier: "", memo: "", settle_date: null, settle_amt: null, source: "manual", created_at: now, shipped_at: null }, o);
    const { v } = await spRun(db, me, spBulk(db, "cm_order", me.ws, [row]).concat(stmts));
    return json({ ok: true, v, order: await spOne(db, "cm_order", me.ws, row.id) });
  },
  async "order/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM cm_order WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },
  /* 엑셀 주문 가져오기 — replace: 해당 월의 엑셀분을 바꿈 · merge: 같은 주문번호 건너뜀 · append: 모두 추가 */
  async "order/import"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const mode = ["replace", "merge", "append"].includes(b.mode) ? b.mode : "merge", now = iso();
    const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 5000).map(r => Object.assign({ id: uid("o"), channel_id: null, order_no: "", product_id: null, product_name: "", option: "", qty: 1, amount: 0, ship_fee: 0, status: "new", receiver: "", phone: "", address: "", tracking: "", carrier: "", memo: "", settle_date: null, settle_amt: null, source: "excel", created_at: now, updated_at: now, shipped_at: null }, cmOrderIn(r || {}))).filter(r => r.order_date);
    if (!rows.length) return fail("empty");
    const months = [...new Set(rows.map(r => r.order_date.slice(0, 7)).concat(Array.isArray(b.months) ? b.months.map(ymOk).filter(Boolean) : []))];
    // 상품 이름이 같으면 상품에 연결합니다
    const prods = (await db.prepare("SELECT id, name FROM cm_product WHERE ws=?1").bind(me.ws).all()).results || [];
    const byName = new Map(prods.map(p => [normNm(p.name), p.id]));
    for (const r of rows) if (!r.product_id && r.product_name && byName.has(normNm(r.product_name))) r.product_id = byName.get(normNm(r.product_name));
    const stmts = [];
    let skipped = 0, out = rows;
    if (mode === "replace") stmts.push(db.prepare("DELETE FROM cm_order WHERE ws=?1 AND source='excel' AND status IN ('new','cancel','return','done') AND substr(order_date,1,7) IN (SELECT value FROM json_each(?2))").bind(me.ws, JSON.stringify(months)));   // 발송 작업 중인 주문은 남깁니다
    if (mode !== "append") {
      const nos = [...new Set(rows.map(r => r.order_no).filter(Boolean))];
      if (nos.length) {
        const have = new Set(((await db.prepare("SELECT order_no FROM cm_order WHERE ws=?1 AND order_no IN (SELECT value FROM json_each(?2))" + (mode === "replace" ? " AND NOT (source='excel' AND status IN ('new','cancel','return','done') AND substr(order_date,1,7) IN (SELECT value FROM json_each(?3)))" : "")).bind(...(mode === "replace" ? [me.ws, JSON.stringify(nos), JSON.stringify(months)] : [me.ws, JSON.stringify(nos)])).all()).results || []).map(r => r.order_no));
        const seen = new Set();
        out = rows.filter(r => { const k = r.order_no + "|" + r.product_name + "|" + r.option; if (r.order_no && have.has(r.order_no)) { skipped++; return false; } if (r.order_no && seen.has(k)) { skipped++; return false; } seen.add(k); return true; });
      }
    }
    stmts.push(...spBulk(db, "cm_order", me.ws, out));
    const { v } = await spRun(db, me, stmts);
    return json({ ok: true, v, added: out.length, skipped, months });
  },
  async "product/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), now = iso();
    const ex = id ? await spOne(db, "cm_product", me.ws, id) : null;
    if (id && !ex) return fail("not-found", 404);
    const o = {};
    if ("name" in b || !ex) { o.name = clip(b.name, 120); if (!o.name) return fail("bad-request"); }
    if ("sku" in b) o.sku = clip(b.sku, 60);
    for (const k of ["price", "cost", "stock", "safety"]) if (k in b) o[k] = Math.max(k === "stock" ? -100000 : 0, intOr(b[k], 0));
    if ("active" in b) o.active = b.active ? 1 : 0;
    if ("memo" in b) o.memo = clip(b.memo, 500);
    o.updated_at = now;
    if (ex) { const { v } = await spRun(db, me, [db.prepare(`UPDATE cm_product SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, ex.id, ...Object.values(o))]); return json({ ok: true, v, product: await spOne(db, "cm_product", me.ws, ex.id) }); }
    const row = Object.assign({ id: uid("p"), sku: "", price: 0, cost: 0, stock: 0, safety: 0, active: 1, memo: "", created_at: now }, o);
    const { v } = await spRun(db, me, spBulk(db, "cm_product", me.ws, [row]));
    return json({ ok: true, v, product: await spOne(db, "cm_product", me.ws, row.id) });
  },
  async "product/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM cm_product WHERE ws=?1 AND id=?2").bind(me.ws, id), db.prepare("UPDATE cm_order SET product_id=NULL WHERE ws=?1 AND product_id=?2").bind(me.ws, id)]);
    return json({ ok: true, v });
  },
  async "stock/adjust"(db, me, b) {   // 재고 실사: stock 을 적으면 그 값으로, delta 를 적으면 더하기
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), ex = await spOne(db, "cm_product", me.ws, id);
    if (!ex) return fail("not-found", 404);
    const stock = b.stock !== undefined && b.stock !== "" ? intOr(b.stock, ex.stock) : ex.stock + intOr(b.delta, 0);
    const { v } = await spRun(db, me, [db.prepare("UPDATE cm_product SET stock=?3, updated_at=?4 WHERE ws=?1 AND id=?2").bind(me.ws, id, stock, iso())]);
    return json({ ok: true, v, product: await spOne(db, "cm_product", me.ws, id) });
  },
  async "inquiry/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), now = iso();
    const ex = id ? await spOne(db, "cm_inquiry", me.ws, id) : null;
    if (id && !ex) return fail("not-found", 404);
    const o = {};
    if ("text" in b || !ex) { o.text = clip(b.text, 2000); if (!o.text) return fail("bad-request"); }
    if ("channel_id" in b) o.channel_id = clip(b.channel_id, 60) || null;
    if ("order_no" in b) o.order_no = clip(b.order_no, 60);
    if ("customer" in b) o.customer = clip(b.customer, 40);
    if ("due" in b) o.due = dOk(b.due) || null;
    if ("answer" in b) o.answer = clip(b.answer, 2000);
    if ("status" in b) { o.status = b.status === "done" ? "done" : "open"; o.answered_at = o.status === "done" ? now : null; }
    if (ex) { const { v } = await spRun(db, me, [db.prepare(`UPDATE cm_inquiry SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, ex.id, ...Object.values(o))]); return json({ ok: true, v, inquiry: await spOne(db, "cm_inquiry", me.ws, ex.id) }); }
    const row = Object.assign({ id: uid("iq"), channel_id: null, order_no: "", customer: "", due: addDaysS(kstToday(), 1), status: "open", answer: "", answered_at: null, created_at: now }, o);
    const { v } = await spRun(db, me, spBulk(db, "cm_inquiry", me.ws, [row]));
    return json({ ok: true, v, inquiry: await spOne(db, "cm_inquiry", me.ws, row.id) });
  },
  async "inquiry/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM cm_inquiry WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },
  async "channel/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), ex = id ? await spOne(db, "cm_channel", me.ws, id) : null;
    if (id && !ex) return fail("not-found", 404);
    const o = {};
    if ("name" in b || !ex) { o.name = clip(b.name, 60); if (!o.name) return fail("bad-request"); }
    if ("fee_pct" in b) o.fee_pct = Math.max(0, Math.min(100, Math.round((Number(b.fee_pct) || 0) * 100) / 100));
    if ("settle_days" in b) o.settle_days = clampInt(b.settle_days, 0, 120, 0);
    if ("sort" in b) o.sort = intOr(b.sort, 0);
    if ("active" in b) o.active = b.active ? 1 : 0;
    if (ex) { const { v } = await spRun(db, me, [db.prepare(`UPDATE cm_channel SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, ex.id, ...Object.values(o))]); return json({ ok: true, v, channel: await spOne(db, "cm_channel", me.ws, ex.id) }); }
    const row = Object.assign({ id: uid("ch"), fee_pct: 0, settle_days: 0, sort: 99, active: 1 }, o);
    const { v } = await spRun(db, me, spBulk(db, "cm_channel", me.ws, [row]));
    return json({ ok: true, v, channel: await spOne(db, "cm_channel", me.ws, row.id) });
  },
  async "channel/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60);
    const used = await db.prepare("SELECT 1 AS x FROM cm_order WHERE ws=?1 AND channel_id=?2 LIMIT 1").bind(me.ws, id).first();
    if (used) { const { v } = await spRun(db, me, [db.prepare("UPDATE cm_channel SET active=0 WHERE ws=?1 AND id=?2").bind(me.ws, id)]); return json({ ok: true, v, deactivated: true }); }
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM cm_channel WHERE ws=?1 AND id=?2").bind(me.ws, id)]);
    return json({ ok: true, v });
  },
  async "cost/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const ym = ymOk(b.ym); if (!ym) return fail("bad-request");
    const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 200).filter(r => r && r.channel_id).map(r => ({ ym, channel_id: clip(r.channel_id, 60), ads: Math.max(0, intOr(r.ads, 0)), misc: Math.max(0, intOr(r.misc, 0)) }));
    if (!rows.length) return fail("bad-request");
    const { v } = await spRun(db, me, spBulk(db, "cm_cost", me.ws, rows, "ON CONFLICT(ws,ym,channel_id) DO UPDATE SET ads=excluded.ads, misc=excluded.misc"));
    return json({ ok: true, v, saved: rows.length });
  },
  async settings(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    if (b.set !== undefined) {
      const s = cmNorm(b.set);
      const { v } = await spRun(db, me, [db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'cm','settings',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(s))]);
      return json({ ok: true, v, settings: s });
    }
    return json({ ok: true, settings: cmNorm((await modSettings(db, me.ws, "cm")).settings) });
  }
};
function cmNorm(s) {
  s = s && typeof s === "object" ? s : {};
  const maps = {};
  if (s.maps && typeof s.maps === "object") for (const [k, v] of Object.entries(s.maps).slice(0, 10)) if (v && typeof v === "object") maps[clip(k, 40)] = Object.fromEntries(Object.entries(v).slice(0, 30).map(([a, c]) => [clip(a, 30), clip(c, 60)]));
  return { ship_fee_default: Math.max(0, intOr(s.ship_fee_default, 0)), maps, memo: clip(s.memo, 1000) };
}

/* ═════════ AI 접속 · 제안 · 확인 링크 ═════════
   · 개인 API 토큰(Bearer mw_…)으로 외부 AI가 읽습니다. 토큰은 만든 사람의 역할·범위를 그대로 따릅니다.
   · 쓰기 토큰은 바로 고치지 않고 "제안"(ent kind=prop)을 올리며, 관리자·직원이 홈에서 승인하면 반영됩니다.
   · 확인 링크(/#/link/<token>)는 계정 없는 상대방이 견적 승인·납품 확인·청구 확인만 할 수 있는 공개 페이지입니다. */
const TASK_ST = ["대기", "진행중", "검토", "완료"];
const AI_KINDS = ["create-task", "update-status", "add-note", "create-contact", "create-job"];
async function sha256(s) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))); }
async function wsSettings(db, ws) {
  const rs = (await db.prepare("SELECT k, v FROM ws_set WHERE ws=?1 AND k IN ('ai_auto','ai_note')").bind(ws).all()).results || [];
  const m = new Map(rs.map(r => [r.k, parse(r.v)]));
  return { ai_auto: Array.isArray(m.get("ai_auto")) ? m.get("ai_auto") : [], ai_note: typeof m.get("ai_note") === "string" ? m.get("ai_note") : "" };
}
async function aiAuth(db, req) {
  const t = bearer(req);
  if (!/^mw_[0-9a-f]{32}$/.test(t)) return null;
  const r = await db.prepare("SELECT t.id AS tid, t.name AS tname, t.scope, t.modules AS tmods, t.hour, t.hour_uses, t.day, t.day_uses, t.ws, t.member_id, a.login_id, a.status AS ast, a.role, a.is_owner, a.name, w.status AS wst, w.name AS wname, w.invite, w.sp_ver, w.plan, w.modules, w.limits, w.plan_until FROM api_tokens t JOIN accounts a ON a.ws=t.ws AND a.member_id=t.member_id JOIN workspaces w ON w.id=t.ws WHERE t.hash=?1 AND t.revoked=0").bind(await sha256(t)).first();
  if (!r || r.ast !== "active" || r.wst !== "active") return null;
  const hour = iso().slice(0, 13), day = kstToday();
  if (r.hour === hour && Number(r.hour_uses) >= AI_HOUR_LIMIT) return { err: "rate-limit", retry: 3600 };
  if (r.day === day && Number(r.day_uses) >= AI_DAY_LIMIT) return { err: "rate-limit", retry: 86400 };
  await db.prepare("UPDATE api_tokens SET last_used=?1, hour_uses=CASE WHEN hour=?2 THEN hour_uses+1 ELSE 1 END, hour=?2, day_uses=CASE WHEN day=?3 THEN day_uses+1 ELSE 1 END, day=?3 WHERE ws=?4 AND id=?5").bind(iso(), hour, day, r.ws, r.tid).run();
  const me = meFrom(r, { token: "" });
  const tmods = modulesOk(r.tmods).filter(m => me.modules.includes(m));
  me.ai = { id: r.tid, name: r.tname || "AI", scope: me.plan === "pro" ? (r.scope === "write" ? "write" : "read") : "read", modules: tmods };
  return me;
}
const aiMod = (me, m) => !!me.ai && isMgr(me) && me.ai.modules.includes(m) && hasMod(me, m);   // 모듈 요약(금액·고객명 포함)은 관리자·직원 토큰만
const jx = (d, k) => { const v = d && d[k]; return v == null ? "" : v; };
const nmOf = (map, id) => (id && map.get(String(id))) || "";
async function aiNames(db, ws) {   // 프로젝트·매장·구성원 이름표
  const rs = (await db.prepare("SELECT kind, id, json_extract(data,'$.name') AS name FROM ent WHERE ws=?1 AND kind IN ('project','store','member') AND deleted=0").bind(ws).all()).results || [];
  const P = new Map(), S = new Map(), M = new Map();
  for (const r of rs) (r.kind === "project" ? P : r.kind === "store" ? S : M).set(r.id, r.name || "");
  return { P, S, M };
}
function taskOut(t, N) {
  return { id: t.id, title: t.title, status: t.status, due: t.due || "", priority: t.priority || "보통", assignee: nmOf(N.M, t.assigneeId) || t.assigneeName || "", project: nmOf(N.P, t.projectId), store: nmOf(N.S, t.storeId), review: t.review || "", detail: clip(t.detail, 300) };
}
async function openTasks(db, me, N, vis) {
  const rs = (await db.prepare("SELECT kind,id,data,own,pid,sid FROM ent WHERE ws=?1 AND kind='task' AND deleted=0 AND json_extract(data,'$.status')<>'완료' LIMIT 1500").bind(me.ws).all()).results || [];
  const out = [];
  for (const r of rs) { const v = pick(me, r, vis); if (!v || v.deleted) continue; const d = parse(v.data); if (d) out.push(d); }
  return out;
}
const AIFN = {
  async me(db, me) {
    return { workspace: me.wname, member: { id: me.id, name: me.name, role: me.role }, plan: me.plan, modules: me.modules, token: { name: me.ai.name, scope: me.ai.scope, modules: me.ai.modules }, today: kstToday(), hint: "오늘 할 일은 today, 프로젝트는 projects, 검색은 search?q= 로 읽습니다. 쓰기 토큰은 propose 로 제안을 올립니다." };
  },
  async today(db, me) {
    const today = kstToday(), N = await aiNames(db, me.ws), vis = me.role === "partner" ? await loadVis(db, me, false) : null;
    const tasks = await openTasks(db, me, N, vis);
    const mine = t => me.role === "admin" || me.role === "staff" ? true : t.assigneeId === me.id;
    const late = [], due = [], review = [], running = [];
    for (const t of tasks) {
      if (!mine(t)) continue;
      const o = taskOut(t, N);
      if (t.review === "requested") review.push(o);
      if (t.due && t.due < today) late.push(o); else if (t.due === today) due.push(o); else if (t.status === "진행중") running.push(o);
    }
    const dec = { reviewRequests: review.length };
    if (me.role === "admin") { const b = await badgesFor(db, me); dec.joinRequests = b.joinReq || 0; }
    if (me.role === "admin" || me.role === "staff") {
      const p = await db.prepare("SELECT COUNT(*) AS n FROM ent WHERE ws=?1 AND kind='prop' AND deleted=0 AND json_extract(data,'$.status')='pending'").bind(me.ws).first();
      dec.proposals = p ? Number(p.n) : 0;
    }
    const out = { date: today, late: late.slice(0, 50), dueToday: due.slice(0, 50), reviewRequested: review.slice(0, 50), inProgress: running.slice(0, 50), openTasks: tasks.filter(mine).length, decisions: dec, modules: {} };
    if (aiMod(me, "space")) out.modules.space = await spAiToday(db, me);
    if (aiMod(me, "outsourcing")) out.modules.outsourcing = await osAiSummary(db, me);
    if (aiMod(me, "commerce")) out.modules.commerce = await cmAiSummary(db, me);
    return out;
  },
  async projects(db, me, p) {
    const vis = me.role === "partner" ? await loadVis(db, me, false) : null, N = await aiNames(db, me.ws);
    const rs = (await db.prepare("SELECT kind,id,data,own,pid,sid FROM ent WHERE ws=?1 AND kind='project' AND deleted=0 LIMIT 500").bind(me.ws).all()).results || [];
    const cnt = (await db.prepare("SELECT pid, COUNT(*) AS n, SUM(CASE WHEN json_extract(data,'$.status')='완료' THEN 1 ELSE 0 END) AS d FROM ent WHERE ws=?1 AND kind='task' AND deleted=0 AND pid IS NOT NULL GROUP BY pid").bind(me.ws).all()).results || [];
    const C = new Map(cnt.map(c => [c.pid, c]));
    const q = normNm(p.q || ""), st = clip(p.status, 10);
    const out = [];
    for (const r of rs) {
      const v = pick(me, r, vis); if (!v || v.deleted) continue; const d = parse(v.data); if (!d) continue;
      if (st && d.status !== st) continue;
      if (q && !normNm(d.name + " " + (d.brand || "") + " " + (d.summary || "")).includes(q)) continue;
      const c = C.get(d.id) || { n: 0, d: 0 };
      out.push({ id: d.id, name: d.name, brand: d.brand || "", status: d.status, priority: d.priority || "보통", owner: nmOf(N.M, d.ownerId), startDate: d.startDate || "", dueDate: d.dueDate || "", tasks: Number(c.n), done: Number(c.d), summary: clip(d.summary, 300), updatedAt: d.updatedAt || "" });
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { count: out.length, projects: out.slice(0, 200) };
  },
  async project(db, me, p) {
    const id = clip(p.id, 60); if (!id) return { error: "bad-request" };
    const vis = me.role === "partner" ? await loadVis(db, me, false) : null, N = await aiNames(db, me.ws);
    const r = await db.prepare("SELECT kind,id,data,own,pid,sid FROM ent WHERE ws=?1 AND kind='project' AND id=?2 AND deleted=0").bind(me.ws, id).first();
    const v = r ? pick(me, r, vis) : null; const d = v && !v.deleted ? parse(v.data) : null;
    if (!d) return { error: "not-found" };
    const ts = (await db.prepare("SELECT kind,id,data,own,pid,sid FROM ent WHERE ws=?1 AND kind='task' AND pid=?2 AND deleted=0 LIMIT 500").bind(me.ws, id).all()).results || [];
    const tasks = []; for (const t of ts) { const w = pick(me, t, vis); if (!w || w.deleted) continue; const x = parse(w.data); if (x) tasks.push(taskOut(x, N)); }
    return { id: d.id, name: d.name, brand: d.brand || "", status: d.status, priority: d.priority || "보통", owner: nmOf(N.M, d.ownerId), members: (d.memberIds || []).map(x => nmOf(N.M, x)).filter(Boolean), startDate: d.startDate || "", dueDate: d.dueDate || "", summary: d.summary || "", goals: d.goals || [], notes: clip(d.notes, 2000), links: d.links || [], budget: v.data.includes('"budget"') ? d.budget : undefined, tasks };
  },
  async stores(db, me) {
    const vis = me.role === "partner" ? await loadVis(db, me, false) : null, N = await aiNames(db, me.ws), today = kstToday();
    const rs = (await db.prepare("SELECT kind,id,data,own,pid,sid FROM ent WHERE ws=?1 AND kind='store' AND deleted=0 LIMIT 500").bind(me.ws).all()).results || [];
    const cnt = (await db.prepare("SELECT sid, COUNT(*) AS n FROM ent WHERE ws=?1 AND kind='task' AND deleted=0 AND sid IS NOT NULL AND json_extract(data,'$.status')<>'완료' GROUP BY sid").bind(me.ws).all()).results || [];
    const C = new Map(cnt.map(c => [c.sid, Number(c.n)]));
    const out = [];
    for (const r of rs) {
      const v = pick(me, r, vis); if (!v || v.deleted) continue; const d = parse(v.data); if (!d) continue;
      const last = d.checks && d.checks[0] ? d.checks[0].date : "";
      const over = d.status === "운영중" && last ? Math.max(0, Math.round((Date.parse(today) - Date.parse(last)) / 864e5) - (Number(d.checkCycleDays) || 7)) : 0;
      out.push({ id: d.id, name: d.name, brand: d.brand || "", region: d.region || "", status: d.status, manager: nmOf(N.M, d.managerId), openTasks: C.get(d.id) || 0, lastCheck: last, checkOverdueDays: over, monthlyTarget: v.data.includes('"monthlyTarget"') ? d.monthlyTarget : undefined });
    }
    return { count: out.length, stores: out.slice(0, 200) };
  },
  async tasks(db, me, p) {
    const vis = me.role === "partner" ? await loadVis(db, me, false) : null, N = await aiNames(db, me.ws);
    const st = clip(p.status, 10), q = normNm(p.q || ""), who = normNm(p.assignee || ""), pid = clip(p.project, 60), sid = clip(p.store, 60);
    const where = st === "완료" ? "" : " AND json_extract(data,'$.status')<>'완료'";
    const rs = (await db.prepare("SELECT kind,id,data,own,pid,sid FROM ent WHERE ws=?1 AND kind='task' AND deleted=0" + where + " LIMIT 1500").bind(me.ws).all()).results || [];
    const out = [];
    for (const r of rs) {
      const v = pick(me, r, vis); if (!v || v.deleted) continue; const d = parse(v.data); if (!d) continue;
      if (st && d.status !== st) continue;
      if (pid && d.projectId !== pid) continue;
      if (sid && d.storeId !== sid) continue;
      const o = taskOut(d, N);
      if (who && !normNm(o.assignee).includes(who)) continue;
      if (q && !normNm(d.title + " " + (d.detail || "")).includes(q)) continue;
      out.push(o);
    }
    out.sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
    return { count: out.length, tasks: out.slice(0, 200) };
  },
  async search(db, me, p) {
    const q = normNm(p.q || ""); if (q.length < 1) return { error: "bad-request" };
    const vis = me.role === "partner" ? await loadVis(db, me, false) : null, N = await aiNames(db, me.ws);
    const rs = (await db.prepare("SELECT kind,id,data,own,pid,sid FROM ent WHERE ws=?1 AND kind IN ('project','store','task','contact') AND deleted=0 LIMIT 4000").bind(me.ws).all()).results || [];
    const out = { projects: [], stores: [], tasks: [], contacts: [] };
    for (const r of rs) {
      const v = pick(me, r, vis); if (!v || v.deleted) continue; const d = parse(v.data); if (!d) continue;
      const hay = normNm([d.name, d.title, d.brand, d.summary, d.detail, d.company, d.memo].filter(Boolean).join(" "));
      if (!hay.includes(q)) continue;
      if (r.kind === "project") out.projects.push({ id: d.id, name: d.name, status: d.status, brand: d.brand || "" });
      else if (r.kind === "store") out.stores.push({ id: d.id, name: d.name, status: d.status, region: d.region || "" });
      else if (r.kind === "task") out.tasks.push(taskOut(d, N));
      else out.contacts.push({ id: d.id, name: d.name, company: d.company || "", kind: d.kind || "", phone: d.phone || "", email: d.email || "" });
    }
    for (const k of Object.keys(out)) out[k] = out[k].slice(0, 30);
    return out;
  },
  async contacts(db, me, p) {
    if (me.role !== "admin" && me.role !== "staff") return { error: "forbidden" };
    const q = normNm(p.q || "");
    const rs = (await db.prepare("SELECT data FROM ent WHERE ws=?1 AND kind='contact' AND deleted=0 LIMIT 1000").bind(me.ws).all()).results || [];
    const out = [];
    for (const r of rs) { const d = parse(r.data); if (!d) continue; if (q && !normNm([d.name, d.company, d.kind, d.memo].filter(Boolean).join(" ")).includes(q)) continue; out.push({ id: d.id, name: d.name, company: d.company || "", kind: d.kind || "", phone: d.phone || "", email: d.email || "", memo: clip(d.memo, 300) }); }
    return { count: out.length, contacts: out.slice(0, 200) };
  },
  async space(db, me) { if (!aiMod(me, "space")) return { error: "module-off" }; return await spAiToday(db, me); },
  async outsourcing(db, me) { if (!aiMod(me, "outsourcing")) return { error: "module-off" }; return await osAiSummary(db, me); },
  async commerce(db, me) { if (!aiMod(me, "commerce")) return { error: "module-off" }; return await cmAiSummary(db, me); },
  async propose(db, me, p) {
    if (me.ai.scope !== "write") return { error: "forbidden", hint: "읽기 토큰입니다. 쓰기 토큰으로 제안할 수 있습니다." };
    if (me.role !== "admin" && me.role !== "staff") return { error: "forbidden" };
    const kind = String(p.kind || "");
    if (!AI_KINDS.includes(kind)) return { error: "bad-request", kinds: AI_KINDS };
    const payload = p.payload && typeof p.payload === "object" ? p.payload : {};
    if (kind === "create-job" && !hasMod(me, "outsourcing")) return { error: "module-off" };
    const chk = propCheck(kind, payload);
    if (chk.error) return chk;
    const set = await wsSettings(db, me.ws);
    const prop = { id: uid("pr"), kind, payload: chk.payload, status: "pending", by: "ai", tokenName: me.ai.name, memberId: me.id, reason: clip(p.reason, 300), createdAt: iso(), decidedAt: "", decidedBy: "", note: "", applied: null };
    if (set.ai_auto.includes(kind)) {   // 승인 없이 바로 반영하도록 설정된 종류
      const ap = await propApply(db, me, prop);
      if (ap.error) return ap;
      prop.status = "auto"; prop.decidedAt = iso(); prop.decidedBy = "auto"; prop.applied = ap.applied;
      await db.batch(upserts(db, me.ws, ap.items.concat([{ kind: "prop", id: prop.id, data: prop }]), ts()).concat(ap.stmts || []));
      return { ok: true, status: "auto", proposal: prop, applied: ap.applied };
    }
    await db.batch(upserts(db, me.ws, [{ kind: "prop", id: prop.id, data: prop }], ts()));
    return { ok: true, status: "pending", proposal: { id: prop.id, kind, status: "pending" }, hint: "관리자가 홈의 '오늘 결정할 것'에서 승인하면 반영됩니다." };
  }
};
function propCheck(kind, p) {
  const out = {};
  if (kind === "create-task") {
    out.title = clip(p.title, 120); if (!out.title) return { error: "bad-request", hint: "title이 필요합니다." };
    out.detail = clip(p.detail, 1000); out.project = clip(p.project, 80); out.store = clip(p.store, 80);
    if (!out.project && !out.store) return { error: "bad-request", hint: "project 또는 store(이름이나 id)가 필요합니다." };
    out.due = dOk(p.due); out.priority = ["높음", "보통", "낮음"].includes(p.priority) ? p.priority : "보통"; out.assignee = clip(p.assignee, 20); out.status = p.status === "진행중" ? "진행중" : "대기";
  } else if (kind === "update-status") {
    out.task = clip(p.task, 120); if (!out.task) return { error: "bad-request", hint: "task(id 또는 제목)가 필요합니다." };
    out.status = TASK_ST.includes(p.status) ? p.status : ""; out.due = dOk(p.due);
    if (!out.status && !out.due) return { error: "bad-request", hint: "status 또는 due가 필요합니다." };
  } else if (kind === "add-note") {
    out.text = clip(p.text, 1000); if (!out.text) return { error: "bad-request", hint: "text가 필요합니다." };
    out.project = clip(p.project, 80); out.store = clip(p.store, 80); out.task = clip(p.task, 120);
    if (!out.project && !out.store && !out.task) return { error: "bad-request", hint: "project, store, task 중 하나가 필요합니다." };
  } else if (kind === "create-contact") {
    out.name = clip(p.name, 40); if (!out.name) return { error: "bad-request", hint: "name이 필요합니다." };
    out.company = clip(p.company, 60); out.phone = clip(p.phone, 40); out.email = clip(p.email, 80); out.kind = ["고객", "거래처", "외주", "기타"].includes(p.kind) ? p.kind : "거래처"; out.memo = clip(p.memo, 500);
  } else if (kind === "create-job") {
    out.title = clip(p.title, 120); if (!out.title) return { error: "bad-request", hint: "title이 필요합니다." };
    out.client = clip(p.client, 60); out.detail = clip(p.detail, 2000); out.due = dOk(p.due); out.amount = Math.max(0, intOr(p.amount, 0));
  }
  return { payload: out };
}
async function findEnt(db, ws, kind, key) {   // id 또는 이름으로 찾기
  if (!key) return null;
  let r = await db.prepare("SELECT id, data FROM ent WHERE ws=?1 AND kind=?2 AND id=?3 AND deleted=0").bind(ws, kind, key).first();
  if (r) return { id: r.id, d: parse(r.data) || {} };
  const f = kind === "task" ? "title" : "name";
  const rs = (await db.prepare(`SELECT id, data FROM ent WHERE ws=?1 AND kind=?2 AND deleted=0 AND json_extract(data,'$.${f}') LIKE ?3 LIMIT 5`).bind(ws, kind, "%" + key + "%").all()).results || [];
  const nk = normNm(key);
  const hit = rs.map(x => ({ id: x.id, d: parse(x.data) || {} })).sort((a, b) => (normNm(a.d[f]) === nk ? 0 : 1) - (normNm(b.d[f]) === nk ? 0 : 1))[0];
  return hit || null;
}
const actRow = (me, text) => { const now = new Date(); return { kind: "act", id: uid("a"), own: me.id, data: { id: uid("a"), ts: (now.getMonth() + 1) + "/" + now.getDate() + " " + String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0"), who: "AI · " + me.name, by: me.id, createdAt: now.toISOString(), text } }; };
async function propApply(db, me, prop) {   // 제안을 실제 데이터로 — 승인 때와 자동 반영 때 같은 길
  const p = prop.payload, now = iso(), items = [];
  if (prop.kind === "create-task") {
    const pj = p.project ? await findEnt(db, me.ws, "project", p.project) : null, st = !pj && p.store ? await findEnt(db, me.ws, "store", p.store) : null;
    if (!pj && !st) return { error: "not-found", hint: "프로젝트나 매장을 찾지 못했습니다." };
    let asg = "";
    if (p.assignee) { const m = await findEnt(db, me.ws, "member", p.assignee); if (m) asg = m.id; }
    const t = { id: uid("t"), projectId: pj ? pj.id : "", storeId: st ? st.id : "", title: p.title, detail: p.detail, status: p.status, assigneeId: asg, assigneeName: asg ? "" : p.assignee, due: p.due, priority: p.priority, source: "ai", createdAt: now, updatedAt: now };
    items.push({ kind: "task", id: t.id, data: t }, actRow(me, `AI 제안으로 업무 "${t.title}"을(를) 만들었습니다.`));
    return { items, applied: { taskId: t.id, title: t.title, in: pj ? pj.d.name : st.d.name } };
  }
  if (prop.kind === "update-status") {
    const t = await findEnt(db, me.ws, "task", p.task);
    if (!t) return { error: "not-found", hint: "업무를 찾지 못했습니다." };
    const d = { ...t.d, updatedAt: now }; if (p.status) d.status = p.status; if (p.due) d.due = p.due;
    items.push({ kind: "task", id: t.id, data: d }, actRow(me, `AI 제안으로 "${d.title}"을(를) ${p.status ? p.status + "(으)로 바꿨습니다" : "마감 " + p.due + "로 옮겼습니다"}.`));
    return { items, applied: { taskId: t.id, title: d.title, status: d.status, due: d.due } };
  }
  if (prop.kind === "add-note") {
    if (p.task) {
      const t = await findEnt(db, me.ws, "task", p.task); if (!t) return { error: "not-found" };
      const d = { ...t.d, detail: (t.d.detail ? t.d.detail + "\n" : "") + "[AI] " + p.text, updatedAt: now };
      items.push({ kind: "task", id: t.id, data: d }); return { items, applied: { taskId: t.id, title: d.title } };
    }
    const pj = p.project ? await findEnt(db, me.ws, "project", p.project) : null, st = !pj && p.store ? await findEnt(db, me.ws, "store", p.store) : null;
    if (!pj && !st) return { error: "not-found" };
    const d = new Date(), c = { id: uid("c"), projectId: pj ? pj.id : "", storeId: st ? st.id : "", memberId: me.id, text: "[AI] " + p.text, ts: (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") };
    items.push({ kind: "comment", id: c.id, data: c }); return { items, applied: { commentId: c.id, in: pj ? pj.d.name : st.d.name } };
  }
  if (prop.kind === "create-contact") {
    const c = { id: uid("ct"), name: p.name, company: p.company, phone: p.phone, email: p.email, kind: p.kind, memo: p.memo, source: "ai", createdAt: now, updatedAt: now };
    items.push({ kind: "contact", id: c.id, data: c }, actRow(me, `AI 제안으로 연락처 "${c.name}"을(를) 추가했습니다.`));
    return { items, applied: { contactId: c.id, name: c.name } };
  }
  if (prop.kind === "create-job") {
    if (!hasMod(me, "outsourcing")) return { error: "module-off" };
    return await osCreateJobItems(db, me, p);
  }
  return { error: "bad-request" };
}
PRIVATE["proposal/decide"] = async function (db, me, b) {
  if (me.role !== "admin" && me.role !== "staff") return fail("forbidden", 403);
  const id = clip(b.id, 60);
  const r = await db.prepare("SELECT data FROM ent WHERE ws=?1 AND kind='prop' AND id=?2 AND deleted=0").bind(me.ws, id).first();
  const prop = r ? parse(r.data) : null;
  if (!prop) return fail("not-found", 404);
  if (prop.status !== "pending") return fail("bad-state");
  const next = { ...prop, decidedAt: iso(), decidedBy: me.id, note: clip(b.note, 300) };
  if (!b.approve) { next.status = "rejected"; await db.batch(upserts(db, me.ws, [{ kind: "prop", id, data: next }], ts())); return json({ ok: true, proposal: next, applied: [] }); }
  const ap = await propApply(db, me, next);
  if (ap.error) { next.status = "rejected"; next.note = (next.note ? next.note + " · " : "") + "반영 실패: " + ap.error; await db.batch(upserts(db, me.ws, [{ kind: "prop", id, data: next }], ts())); return fail(ap.error, 400, { proposal: next }); }
  next.status = "approved"; next.applied = ap.applied;
  await db.batch(upserts(db, me.ws, ap.items.concat([{ kind: "prop", id, data: next }]), ts()).concat(ap.stmts || []));   // 모듈 표(예: 안건)에 쓰는 문장도 함께
  return json({ ok: true, proposal: next, applied: ap.items.filter(x => x.kind !== "act").map(x => ({ kind: x.kind, id: x.id, data: x.data })) });
};

/* ───────── 확인 링크 (공개) ───────── */
const LINK_KINDS = {
  quote: {   // 견적 승인·수정 요청
    exists: async (db, me, id) => !!(await db.prepare("SELECT 1 AS x FROM os_quote WHERE ws=?1 AND id=?2").bind(me.ws, id).first()),
    view: async (db, l) => {
      const q = await spOneT(db, "os_quote", l.ws, l.target); if (!q) return null;
      const j = await spOneT(db, "os_job", l.ws, q.job_id); const c = j && j.client_id ? await entData(db, l.ws, "contact", j.client_id) : null;
      const set = await osSettings(db, l.ws);
      return { kind: "quote", title: j ? j.title : "견적", client: c ? c.name : (j ? j.client_name || "" : ""), company: c ? c.company || "" : "", sender: set.sender, quote: { no: q.no, items: q.items || [], vat: !!q.vat, supply: q.supply, tax: q.tax, total: q.total, valid_until: q.valid_until || "", note: q.note || "", status: q.status, reply_note: q.reply_note || "", approved_at: q.approved_at || "" }, terms: j && j.terms ? j.terms : null };
    },
    act: async (db, l, action, note, by) => {
      const q = await spOneT(db, "os_quote", l.ws, l.target); if (!q) return { error: "not-found" };
      if (q.status !== "sent" && !(q.status === "changed" && action === "approve")) return { error: "bad-state" };
      const st = action === "approve" ? "approved" : "changed", now = iso();
      const stmts = [db.prepare("UPDATE os_quote SET status=?3, reply_note=?4, approved_at=CASE WHEN ?3='approved' THEN ?5 ELSE approved_at END, replied_at=?5, replied_by=?6 WHERE ws=?1 AND id=?2").bind(l.ws, q.id, st, clip(note, 500), now, clip(by, 40))];
      const j = await spOneT(db, "os_job", l.ws, q.job_id);
      if (st === "approved") stmts.push(db.prepare("UPDATE os_job SET status=CASE WHEN status IN ('inquiry','quote') THEN 'active' ELSE status END, amount=CASE WHEN amount=0 THEN ?5 ELSE amount END, terms=?3, updated_at=?4 WHERE ws=?1 AND id=?2").bind(l.ws, q.job_id, JSON.stringify(osAccept(j, q, now, by)), now, q.total));
      stmts.push(...upserts(db, l.ws, [{ kind: "act", id: uid("a"), own: l.created_by, data: { id: uid("a"), ts: now.slice(5, 16).replace("T", " ").replace("-", "/"), who: clip(by, 40) || "고객", by: "", createdAt: now, text: `견적 "${q.no || (j ? j.title : "")}"을(를) ${st === "approved" ? "승인했습니다" : "수정 요청했습니다"}.${note ? " — " + clip(note, 120) : ""}` } }], ts()));
      stmts.push(db.prepare("UPDATE workspaces SET sp_ver=sp_ver+1 WHERE id=?1").bind(l.ws));
      await db.batch(stmts);
      return { ok: true, status: st };
    }
  },
  delivery: {   // 납품 확인 (업무의 납품물)
    exists: async (db, me, id) => !!(await db.prepare("SELECT 1 AS x FROM ent WHERE ws=?1 AND kind='task' AND id=?2 AND deleted=0").bind(me.ws, id).first()),
    view: async (db, l) => {
      const t = await entData(db, l.ws, "task", l.target); if (!t) return null;
      const w = await db.prepare("SELECT name FROM workspaces WHERE id=?1").bind(l.ws).first();
      const st = t.review === "approved" ? "approved" : t.review === "redo" ? "changed" : "pending";
      return { kind: "delivery", title: t.title, note: st === "pending" ? clip(t.reviewNote, 500) : "", deliverables: Array.isArray(t.deliverables) ? t.deliverables : [], status: st, reply_note: st === "pending" ? "" : (t.reviewNote || ""), sender: { workspace: w ? w.name : "" } };
    },
    act: async (db, l, action, note, by) => {
      const t = await entData(db, l.ws, "task", l.target); if (!t) return { error: "not-found" };
      if (t.review === "approved" || (l.used_at && t.review !== "requested")) return { error: "bad-state" };   // 보낸 쪽이 다시 검수 요청해야 같은 링크로 또 답할 수 있습니다
      const now = iso(), d = { ...t, review: action === "approve" ? "approved" : "redo", reviewNote: clip(note, 500), reviewBy: clip(by, 40) || "고객", status: action === "approve" ? "완료" : (t.status === "완료" ? "완료" : "진행중"), updatedAt: now };
      await db.batch([...upserts(db, l.ws, [{ kind: "task", id: t.id, data: d }, { kind: "act", id: uid("a"), own: l.created_by, data: { id: uid("a"), ts: now.slice(5, 16).replace("T", " ").replace("-", "/"), who: clip(by, 40) || "고객", by: "", createdAt: now, text: `납품 "${t.title}"을(를) ${action === "approve" ? "확인했습니다" : "수정 요청했습니다"}.${note ? " — " + clip(note, 120) : ""}` } }], ts())]);
      return { ok: true, status: action === "approve" ? "approved" : "changed" };
    }
  },
  invoice: {   // 청구서 확인
    exists: async (db, me, id) => !!(await db.prepare("SELECT 1 AS x FROM os_invoice WHERE ws=?1 AND id=?2").bind(me.ws, id).first()),
    view: async (db, l) => {
      const v = await spOneT(db, "os_invoice", l.ws, l.target); if (!v) return null;
      const j = await spOneT(db, "os_job", l.ws, v.job_id); const set = await osSettings(db, l.ws);
      return { kind: "invoice", title: j ? j.title : "청구서", client: j ? j.client_name || "" : "", sender: set.sender, invoice: { no: v.no, amount: v.amount, tax_mode: v.tax_mode, tax: v.tax, net: v.net, due_date: v.due_date || "", pay_link: v.pay_link || "", memo: v.memo || "", status: v.status, bank: set.bank || "" }, status: v.ack_at ? "approved" : "pending" };
    },
    act: async (db, l, action, note, by) => {
      const v = await spOneT(db, "os_invoice", l.ws, l.target); if (!v) return { error: "not-found" };
      if (v.status !== "issued" || v.ack_at) return { error: "bad-state" };
      if (action === "change") { await db.prepare("UPDATE os_invoice SET ack_note=?3 WHERE ws=?1 AND id=?2").bind(l.ws, v.id, clip(note, 300)).run(); return { ok: true, status: "changed" }; }
      await db.prepare("UPDATE os_invoice SET ack_at=?3, ack_by=?4, ack_note=?5 WHERE ws=?1 AND id=?2").bind(l.ws, v.id, iso(), clip(by, 40), clip(note, 300)).run();
      return { ok: true, status: "approved" };
    }
  }
};
async function entData(db, ws, kind, id) { const r = await db.prepare("SELECT data FROM ent WHERE ws=?1 AND kind=?2 AND id=?3 AND deleted=0").bind(ws, kind, String(id)).first(); return r ? parse(r.data) : null; }
async function linkRow(db, t) {
  if (!/^[0-9a-f]{32}$/.test(String(t || ""))) return null;
  const l = await db.prepare("SELECT l.*, w.status AS wst FROM links l JOIN workspaces w ON w.id=l.ws WHERE l.token=?1").bind(t).first();
  if (!l || l.wst !== "active") return null;
  return l;
}
PUBLIC["link/get"] = async function (db, b, req, url) {
  const l = await linkRow(db, url.searchParams.get("t"));
  if (!l) return fail("not-found", 404);
  const expired = l.expires_at < iso();
  if (expired && !l.used_at) return fail("expired", 410);   // 쓰지 않은 채 기한이 지난(또는 새 링크로 대체된) 링크는 내용도 보여 주지 않습니다
  const v = await LINK_KINDS[l.kind].view(db, l);
  if (!v) return fail("not-found", 404);
  return json({ ok: true, expired, usedAt: l.used_at || "", result: l.result || "", expiresAt: l.expires_at, view: v });
};
PUBLIC["link/act"] = async function (db, b) {
  const l = await linkRow(db, b.t);
  if (!l) return fail("not-found", 404);
  if (l.expires_at < iso()) return fail("expired", 410);
  const action = b.action === "approve" ? "approve" : b.action === "change" ? "change" : "";
  if (!action) return fail("bad-request");
  if (action === "change" && !clip(b.note, 500)) return fail("note-required");
  const r = await LINK_KINDS[l.kind].act(db, l, action, b.note, b.by);
  if (r.error) return fail(r.error, r.error === "bad-state" ? 409 : 404);
  await db.prepare("UPDATE links SET used_at=?2, result=?3, note=?4 WHERE token=?1").bind(l.token, iso(), r.status, clip(b.note, 500)).run();
  return json({ ok: true, status: r.status });
};

/* ───────── MCP 서버 (/mcp) — 같은 토큰, 같은 함수 ───────── */
const MCP_TOOLS = [
  { name: "myworks_me", description: "이 토큰이 속한 워크스페이스·사용자·등급·모듈 정보", input: {} },
  { name: "myworks_today", description: "오늘 기준 지연·오늘 마감·검수 요청·진행 중 업무와 결정할 것, 켜진 모듈의 오늘 요약", input: {} },
  { name: "myworks_projects", description: "프로젝트 목록(진행률 포함). q로 이름 검색, status로 상태 필터", input: { q: "string", status: "string" } },
  { name: "myworks_project", description: "프로젝트 하나의 상세와 업무 목록. id 필요", input: { id: "string" }, required: ["id"] },
  { name: "myworks_stores", description: "매장(지점) 목록과 점검·미완료 업무 현황", input: {} },
  { name: "myworks_tasks", description: "업무 목록. q·status·assignee·project·store로 거름", input: { q: "string", status: "string", assignee: "string", project: "string", store: "string" } },
  { name: "myworks_search", description: "프로젝트·매장·업무·연락처를 한 번에 검색", input: { q: "string" }, required: ["q"] },
  { name: "myworks_contacts", description: "연락처(고객·거래처·외주) 목록", input: { q: "string" } },
  { name: "myworks_space", description: "스페이스 모듈: 오늘·내일 예약, 청소 확인 대기, 시설 이슈", input: {} },
  { name: "myworks_outsourcing", description: "아웃소싱 모듈: 진행 안건, 견적 회신 대기, 미수금, 이번 주 납기", input: {} },
  { name: "myworks_commerce", description: "커머스 모듈: 발송할 주문, 답할 문의, 재고 부족, 이달 매출", input: {} },
  { name: "myworks_propose", description: "변경 제안 올리기(쓰기 토큰). kind: create-task(title, project|store, detail, due, priority, assignee) · update-status(task, status|due) · add-note(text, project|store|task) · create-contact(name, company, phone, email, kind) · create-job(title, client, detail, due, amount). 관리자가 승인하면 반영됩니다", input: { kind: "string", payload: "object", reason: "string" }, required: ["kind", "payload"] }
];
const mcpSchema = t => ({ type: "object", properties: Object.fromEntries(Object.entries(t.input).map(([k, v]) => [k, v === "object" ? { type: "object" } : { type: "string" }])), required: t.required || [] });
const mcpFn = { myworks_me: "me", myworks_today: "today", myworks_projects: "projects", myworks_project: "project", myworks_stores: "stores", myworks_tasks: "tasks", myworks_search: "search", myworks_contacts: "contacts", myworks_space: "space", myworks_outsourcing: "outsourcing", myworks_commerce: "commerce", myworks_propose: "propose" };
const rpc = (id, result, error) => json(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result });
async function mcp(db, request) {
  if (request.method === "GET") return fail("method-not-allowed", 405, { hint: "POST JSON-RPC only (Streamable HTTP, no SSE)" });
  if (request.method !== "POST") return fail("method-not-allowed", 405);
  let body = null; try { body = await request.json(); } catch (e) { return rpc(null, null, { code: -32700, message: "parse error" }); }
  const one = async m => {
    const id = m && m.id !== undefined ? m.id : null, method = m && m.method;
    if (method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "myworks", version: "4" }, instructions: "마이웍스 업무 데이터를 읽고(myworks_today, myworks_projects…), 쓰기 토큰이면 myworks_propose로 변경을 제안합니다. 제안은 관리자가 승인해야 반영됩니다." } };
    if (method === "notifications/initialized" || (typeof method === "string" && method.startsWith("notifications/"))) return null;
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: mcpSchema(t) })) } };
    if (method === "tools/call") {
      const me = await aiAuth(db, request);
      if (!me) return { jsonrpc: "2.0", id, error: { code: -32001, message: "unauthorized: Bearer mw_… 토큰이 필요합니다" } };
      if (me.err) return { jsonrpc: "2.0", id, error: { code: -32002, message: "rate-limit" } };
      const name = m.params && m.params.name, fn = mcpFn[name];
      if (!fn) return { jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } };
      const r = await AIFN[fn](db, me, (m.params && m.params.arguments) || {});
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(r).slice(0, 120000) }], isError: !!(r && r.error) } };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
  };
  if (Array.isArray(body)) {   // 한 묶음에 도구 호출은 3개까지 (무료 플랜 쿼리 한도 안에서)
    if (body.filter(m => m && m.method === "tools/call").length > 3) return rpc(null, null, { code: -32005, message: "too many tools/call in one batch (max 3)" });
    const out = []; for (const m of body.slice(0, 20)) { const r = await one(m); if (r) out.push(r); } return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const r = await one(body);
  return r ? json(r) : new Response(null, { status: 202 });
}

const spOneT = spOne;

/* ───────── 진입점 ───────── */
export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const isMcp = url.pathname === "/mcp" || url.pathname === "/mcp/";
  if (!url.pathname.startsWith("/api/") && !isMcp) return next();
  if (!env.DB) return fail("db-not-bound", 503, { hint: "Pages 설정 → Bindings에서 D1 데이터베이스를 변수 이름 DB로 연결하세요." });
  const db = env.DB;
  if (isMcp) { try { await ensure(db); return await mcp(db, request); } catch (e) { return fail("server-error", 500, { detail: String((e && e.message) || e).slice(0, 300) }); } }
  const path = url.pathname.slice(5).replace(/\/+$/, "");
  let body = {};
  if (request.method === "POST") { try { body = await request.json(); } catch (e) { body = {}; } if (!body || typeof body !== "object") body = {}; }
  try {
    await ensure(db);
    if (Object.prototype.hasOwnProperty.call(PUBLIC, path)) return await PUBLIC[path](db, body, request, url);
    if (path.startsWith("ai/")) {   // 외부 AI — 개인 토큰으로 읽기, 쓰기 토큰은 제안
      const fn = path.slice(3);
      if (!Object.prototype.hasOwnProperty.call(AIFN, fn)) return fail("not-found", 404);
      const me = await aiAuth(db, request);
      if (!me) return fail("unauthorized", 401, { hint: "Authorization: Bearer mw_… (연동·데이터 → AI 접속에서 발급)" });
      if (me.err) return fail(me.err, 429, { retry: me.retry });
      const p = Object.assign({}, Object.fromEntries(url.searchParams), body);
      const r = await AIFN[fn](db, me, p);
      return json(r, r && r.error ? ({ "not-found": 404, forbidden: 403, "module-off": 403 }[r.error] || 400) : 200);
    }
    const MODS = { "sp/": ["space", SPACE], "os/": ["outsourcing", OUTS], "cm/": ["commerce", COMM] };
    const mk = Object.keys(MODS).find(k => path.startsWith(k));
    if (mk) {   // 업종 모듈 — 프로 워크스페이스에서 켠 모듈만, 협력사 역할은 쓰지 않습니다
      const [mod, H] = MODS[mk], fn = path.slice(3);
      if (!Object.prototype.hasOwnProperty.call(H, fn)) return fail("not-found", 404);
      const me = await auth(db, request);
      if (!me) return fail("unauthorized", 401);
      if (me.err) return fail(me.err, 403);
      if (me.role === "partner") return fail("forbidden", 403);
      if (!hasMod(me, mod)) return fail("module-off", 403, { module: mod });
      if (isField(me) && !(mod === "space" || (mod === "commerce" && me.role === "worker"))) return fail("forbidden", 403);   // 현장 근무자는 스페이스·커머스 발송, 시설 담당은 스페이스만
      return await H[fn](db, me, body, request, url, env);
    }
    if (!Object.prototype.hasOwnProperty.call(PRIVATE, path)) return fail("not-found", 404);
    const me = await auth(db, request);
    if (!me) return fail("unauthorized", 401);
    if (me.err) return fail(me.err, 403);
    return await PRIVATE[path](db, me, body, request, url);
  } catch (e) {
    return fail("server-error", 500, { detail: String((e && e.message) || e).slice(0, 300) });
  }
}
