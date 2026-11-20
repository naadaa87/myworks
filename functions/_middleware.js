/* 마이웍스 서버 v4 — 회원가입 · 승인 · 멀티 워크스페이스 · 등급(베이직/프로) · 업종 모듈 · AI 접속
   Cloudflare Pages Functions + D1 (바인딩 변수 이름: DB)

   · 이 파일은 저장소의 functions/_middleware.js 위치에 둡니다.
   · 테이블은 첫 요청 때 자동으로 만들어지고, 이전 버전(v1~v3) 데이터는 그대로 이어서 씁니다.
   · 처음 설정한 계정이 운영자가 되어 새 워크스페이스 가입을 승인합니다.
     운영자도 각 워크스페이스의 업무 내용은 볼 수 없고, 가입·이용 상태와 등급만 관리합니다.
   · 등급: 베이직(나 혼자 + 구성원 2명, 브랜드 2개, 읽기 토큰 1개) / 프로(구성원 10명 포함, 업종 모듈, 쓰기 토큰).
     업종 모듈: space(마이스토어) · outsourcing(거래) · commerce(마이셀러) · tax(마이택스) · people(마이피플) · marketing(마이마케팅) · creator(마이크리에이터) · edu(마이에듀) — 프로 워크스페이스에서 켜고 끕니다.
   · AI 접속: 개인 API 토큰(Bearer)으로 외부 AI가 /api/ai/* 를 읽고, 쓰기 토큰은 "제안"을 올립니다. /mcp 는 같은 기능의 MCP 서버입니다.
   · 확인 링크: 계정 없는 고객·거래처가 /#/link/<token> 에서 견적 승인·납품 확인만 합니다.
   · 스페이스: 예약 → 청소 배정 → 체크리스트 → 확인 → 손익. HOSTDB(읽기)는 운영자 워크스페이스에서만, SPACEDB(1회 가져오기)는 운영자만.
   · 무료 요금제 한도(요청당 쿼리 50회)를 넘지 않도록 여러 건의 쓰기는 한 문장으로 묶어 처리합니다. */

const SCHEMA = "15";
const PLANS = ["basic", "pro"];
const MODULES = ["space", "outsourcing", "commerce", "tax", "people", "marketing", "creator", "edu"];
const BASE_MODULES = ["outsourcing"];          // 거래 — 기본 기능이라 등급과 관계없이 늘 켜져 있습니다
const EXT_MODULES = ["space", "commerce", "tax", "people", "marketing", "creator", "edu"];     // 확장판 — 마이스토어 · 마이셀러 · 마이택스 · 마이피플 · 마이마케팅 · 마이크리에이터 · 마이에듀 (워크스페이스 관리자가 켜고 끕니다)
const PLAN_LIMITS = { basic: { brands: 2, members: 2, tokens: 1 }, pro: { brands: 1000, members: 10, tokens: 20 }, beta: { brands: 1000, members: 30, tokens: 20 } };   // members = 관리자 외 구성원 수
/* 무료 공개 기간 — 결제를 붙이기 전까지 모든 워크스페이스가 프로 기능과 확장판을 무료로 씁니다.
   유료로 바꿀 때 false로 바꾸면 워크스페이스마다 저장된 등급(베이직·프로·기한)이 다시 적용됩니다. 데이터는 그대로입니다. */
const FREE_BETA = true;
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
  ["accounts", "agreed_at TEXT"],
  ["workspaces", "sp_ver INTEGER NOT NULL DEFAULT 0"],
  ["workspaces", "plan TEXT NOT NULL DEFAULT 'basic'"],
  ["workspaces", "modules TEXT NOT NULL DEFAULT '[]'"],
  ["workspaces", "limits TEXT"],
  ["workspaces", "plan_until TEXT"],
  ["workspaces", "op_note TEXT"],
  ["workspaces", "comp INTEGER NOT NULL DEFAULT 0"],
  ["sp_res", "channel TEXT"],
  // v7 — 추천(소개) 코드, 공유 링크 열람 수·보기 설정
  ["workspaces", "ref_code TEXT"],
  ["workspaces", "ref_ws TEXT"],
  ["workspaces", "ref_paid INTEGER NOT NULL DEFAULT 0"],
  ["links", "views INTEGER NOT NULL DEFAULT 0"],
  ["links", "last_view TEXT"],
  ["links", "opts TEXT"],
  // v8 — 본사 운영팀 역할, 운영자 보안 키 확인, 운영 기록의 처리자
  ["accounts", "op_role TEXT"],
  ["sess", "adm_ok INTEGER NOT NULL DEFAULT 0"],
  ["sess", "adm_fail INTEGER NOT NULL DEFAULT 0"],
  ["adm_log", "actor TEXT"],
  // v9 — 마이스토어: 점검 목록 구분(청소·오픈·마감), 예약형 매장의 담당자·서비스
  ["sp_chk", "list TEXT"],
  ["sp_res", "staff TEXT"],
  ["sp_res", "service TEXT"],
  // v10 — 마이셀러: 반품·교환, 옵션 단위 상품, 기본 공급처
  ["cm_order", "claim TEXT"],
  ["cm_product", "option TEXT"],
  ["cm_product", "supplier_id TEXT"]
];
// 칸을 더한 뒤에 만드는 색인
const POST_DDL = ["CREATE UNIQUE INDEX IF NOT EXISTS idx_ws_ref ON workspaces(ref_code)"];

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
    for (const group of [DDL, SP_DDL, OS_DDL, CM_DDL, TX_DDL, PP_DDL, MK_DDL, CR_DDL, ED_DDL, ADM_DDL, INV_DDL, NT_DDL, MSG_DDL, HT_DDL]) await db.exec(group.join("\n"));
    const have = {};
    for (const t of [...new Set(ADD_COLS.map(x => x[0]))]) have[t] = new Set((((await db.prepare(`PRAGMA table_info(${t})`).all()).results) || []).map(c => c.name));
    for (const [t, col] of ADD_COLS) {
      if (have[t] && have[t].has(col.split(" ")[0])) continue;
      try { await db.prepare(`ALTER TABLE ${t} ADD COLUMN ${col}`).run(); }
      catch (e) { if (!/duplicate column/i.test(String((e && e.message) || e))) throw e; }
    }
    await db.exec(POST_DDL.join("\n"));
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
function tierOf(w, raw) {   // 워크스페이스 행 → 지금 적용되는 등급·모듈·한도 (raw: 무료 공개 기간을 빼고 저장된 등급 그대로)
  let plan = planOk(w.plan);
  if (plan === "pro" && w.plan_until && String(w.plan_until) < kstToday()) plan = "basic";   // 기한이 지나면 베이직 규칙 (데이터는 그대로)
  const beta = FREE_BETA && !raw, eff = beta ? "pro" : plan;
  const lim = Object.assign({}, PLAN_LIMITS[beta ? "beta" : plan], parse(w.limits) || {});
  const ext = eff === "pro" ? modulesOk(w.modules).filter(m => EXT_MODULES.includes(m)) : [];
  return { plan: eff, beta, modules: [...BASE_MODULES, ...ext], limits: { brands: intOr(lim.brands, 2), members: intOr(lim.members, 2), tokens: intOr(lim.tokens, 1) }, planUntil: beta ? "" : (w.plan_until || ""), planRaw: planOk(w.plan) };
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
  const r = await db.prepare("SELECT s.ws, s.member_id, s.seen, s.adm_ok, s.adm_fail, a.login_id, a.status AS ast, a.role, a.is_owner, a.op_role, a.name, w.status AS wst, w.name AS wname, w.invite, w.sp_ver, w.plan, w.modules, w.limits, w.plan_until FROM sess s JOIN accounts a ON a.ws=s.ws AND a.member_id=s.member_id JOIN workspaces w ON w.id=s.ws WHERE s.token=?1").bind(t).first();
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
  return Object.assign({ ws: r.ws, id: r.member_id, lid: r.login_id, role: roleOk(r.role), owner: !!r.is_owner, op: opOf(r), admOk: !!Number(r.adm_ok), admFail: Number(r.adm_fail) || 0, name: r.name, wname: r.wname, invite: r.invite, spv: Number(r.sp_ver) || 0, plan: tier.plan, beta: tier.beta, modules: tier.modules, limits: tier.limits, planUntil: tier.planUntil }, extra || {});
}
const hasMod = (me, m) => me.modules.includes(m) && (BASE_MODULES.includes(m) || me.plan === "pro");
const tierInfo = me => ({ plan: me.plan, beta: !!me.beta, modules: me.modules, limits: me.limits, planUntil: me.planUntil || "" });

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
async function badgesFor(db, me) {   // 화면 배지 + 공지 + 문의 답변 — 질의 한 번
  const r = await db.prepare("SELECT (SELECT v FROM mw_meta WHERE k='ann') AS ann, (SELECT COUNT(*) FROM nt_item WHERE ws=?1 AND member_id=?2 AND read_at IS NULL) AS nt, (SELECT COUNT(*) FROM fb WHERE ws=?1 AND member_id=?2 AND reply_at IS NOT NULL AND (seen_at IS NULL OR seen_at<reply_at)) AS fr"
    + (me.op ? ", (SELECT COUNT(*) FROM workspaces WHERE status='pending') AS pw, (SELECT COUNT(*) FROM fb WHERE status='new') AS fn" : "")
    + (me.role === "admin" ? ", (SELECT COUNT(*) FROM accounts WHERE ws=?1 AND status='pending') AS jr" : "")).bind(me.ws, me.id).first() || {};
  const out = {};
  if (me.op) { if (can(me, "ws") || can(me, "signup")) out.pendingWs = Number(r.pw) || 0; if (can(me, "fb")) out.fbNew = Number(r.fn) || 0; }
  if (me.role === "admin") out.joinReq = Number(r.jr) || 0;
  if (Number(r.fr)) out.fbReply = Number(r.fr);
  if (Number(r.nt)) out.nt = Number(r.nt);   // 읽지 않은 알림
  const ann = annFor(r.ann, me); if (ann.length) out.ann = ann;
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
    const r = await db.prepare("SELECT (SELECT v FROM mw_meta WHERE k='owner') AS o, (SELECT v FROM mw_meta WHERE k='platform') AS plat").first();
    const pl = platformOf(r && r.plat);
    return json({ ok: true, v: 2, initialized: !!(r && r.o), signup: pl.signup, contact: pl.contact });
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
    const now = iso(), mid = uid("m"), pw = await makePw(b.pw), agreed = b.agree ? now : null;   // 약관 동의 일시
    try {
      if (mode === "new") {
        const wsName = clip(b.workspace, 40);
        const refWs = await refLookup(db, b.ref);   // 소개받은 워크스페이스 (없으면 null)
        if (!wsName || !contact) return fail("bad-request");
        const pl = await platform(db);
        if (pl.signup === "closed") return fail("closed", 403);
        const betaIn = codeNorm(b.beta);
        let code = null;
        if (betaIn) { code = await db.prepare("SELECT * FROM adm_code WHERE code=?1").bind(betaIn).first(); if (!codeUsable(code)) return fail("bad-beta", 404); }
        else if (pl.signup === "code") return fail("need-beta", 403);
        const ws = "w_" + rand(6);
        if (code || pl.signup === "open") {   // 베타 코드 또는 자동 개설 — 승인 없이 바로 엽니다
          const c = await db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE created_at>=?1").bind(new Date(Date.now() - 3600e3).toISOString()).first();
          if (c && Number(c.n) >= 30) return fail("busy", 429);
          const st = startTier(code ? { plan: code.plan, modules: parse(code.modules) || [], days: code.days } : pl.newPlan);
          const member = memberData(mid, lid, name, "admin", wsName, now);
          await db.batch([
            db.prepare("INSERT INTO workspaces(id,name,status,admin_login,contact,note,invite,created_at,approved_at,last_active,plan,modules,plan_until,ref_ws) VALUES(?1,?2,'active',?3,?4,?5,?6,?7,?7,?7,?8,?9,?10,?11)").bind(ws, wsName, lid, contact, note, await freshInvite(db), now, st.plan, JSON.stringify(st.modules), st.until, refWs),
            db.prepare("INSERT INTO accounts(login_id,ws,member_id,pw,status,role,is_owner,name,contact,note,created_at,agreed_at) VALUES(?1,?2,?3,?4,'active','admin',0,?5,?6,?7,?8,?9)").bind(lid, ws, mid, pw, name, contact, note, now, agreed),
            ...seedWorkspace(db, ws, wsName, [wsName, "기타"], member),
            ...(code ? [db.prepare("UPDATE adm_code SET uses=uses+1 WHERE code=?1").bind(code.code)] : []),
            admLog(db, "auto-open", { id: ws, name: wsName }, code ? `베타 코드 ${code.code}로 바로 개설` : "자동 개설")
          ]);
          const rw = await refReward(db, ws);
          return json({ ok: true, status: "active", mode, workspace: wsName, plan: rw.plan || st.plan, planUntil: rw.until || st.until || "", refDays: rw.days || 0, free: FREE_BETA });
        }
        const c = await db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE status='pending'").first();
        if (c && Number(c.n) >= MAX_PENDING_WS) return fail("busy", 429);
        await db.batch([
          db.prepare("INSERT INTO workspaces(id,name,status,admin_login,contact,note,invite,created_at,ref_ws) VALUES(?1,?2,'pending',?3,?4,?5,NULL,?6,?7)").bind(ws, wsName, lid, contact, note, now, refWs),
          db.prepare("INSERT INTO accounts(login_id,ws,member_id,pw,status,role,is_owner,name,contact,note,created_at,agreed_at) VALUES(?1,?2,?3,?4,'pending','admin',0,?5,?6,?7,?8,?9)").bind(lid, ws, mid, pw, name, contact, note, now, agreed)
        ]);
        await notifyOps(db, "ws", { type: "sys", title: "새 워크스페이스 개설 신청이 들어왔습니다", body: `${wsName} · ${name}`, url: "#/admin", tag: "ws-pending" });
        return json({ ok: true, status: "pending", mode, workspace: wsName });
      }
      const code = String(b.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const w = code ? await db.prepare("SELECT id,name,status FROM workspaces WHERE invite=?1").bind(code).first() : null;
      if (!w || w.status !== "active") return fail("bad-code", 404);
      const c = await db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE ws=?1 AND status='pending'").bind(w.id).first();
      if (c && Number(c.n) >= MAX_PENDING_JOIN) return fail("busy", 429);
      await db.prepare("INSERT INTO accounts(login_id,ws,member_id,pw,status,role,is_owner,name,contact,note,created_at,agreed_at) VALUES(?1,?2,?3,?4,'pending','staff',0,?5,?6,?7,?8,?9)").bind(lid, w.id, mid, pw, name, contact, note, now, agreed).run();
      await notify(db, w.id, await whoIs(db, w.id, ["admin"]), { type: "team", title: "참여 요청이 들어왔습니다", body: `${name} 님이 초대 코드로 참여를 요청했습니다.`, url: "#/members", tag: "join-req" });
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
    return rawJson({ ok: true, me: me.id, role: me.role, owner: me.owner, op: me.op || "", perms: me.op ? OP_ROLES[me.op].perms : [], ws: { id: me.ws, name, invite: me.role === "admin" ? me.invite : undefined }, workspace: name, meta, badges: await badgesFor(db, me), spv: me.spv, tier: tierInfo(me), now: ts(start - MARGIN) }, ',"entities":{' + entities + "}");
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
      // 알림에 쓸 저장 전 상태 — 새로 맡긴 업무·검토 요청·새 의견을 가려냅니다
      const ntTasks = items.filter(x => x.kind === "task" && !x.deleted && x.data && ((x.data.assigneeId && String(x.data.assigneeId) !== me.id) || x.data.status === "검토"));
      const ntCmts = items.filter(x => x.kind === "comment" && !x.deleted && x.data && String(x.data.memberId || "") === me.id);
      const ntPrev = ntTasks.length ? (partner || field ? taskEx : await lookup("task", ntTasks.map(x => x.id))) : new Map();
      const ntCmtEx = ntCmts.length ? await lookup("comment", ntCmts.map(x => x.id)) : new Map();
      const now = ts();
      const stmts = upserts(db, me.ws, items, now);
      stmts.push(db.prepare("UPDATE workspaces SET last_active=?1" + (metaName ? ", name=?3" : "") + " WHERE id=?2").bind(...(metaName ? [iso(), me.ws, metaName] : [iso(), me.ws])));
      await db.batch(stmts);
      if (items.some(x => x.kind === "project" || x.kind === "store")) for (const k of VIS.keys()) if (k.startsWith(me.ws + "|")) VIS.delete(k);
      if (ntTasks.length || ntCmts.length) await pushNotes(db, me, ntTasks, ntPrev, ntCmts.filter(c => !ntCmtEx.has(c.id)), lookup);
    }
    return json({ ok: true, now: ts(), saved: items.length, dropped });
  },

  async password(db, me, b) {
    const a = await db.prepare("SELECT pw FROM accounts WHERE ws=?1 AND member_id=?2").bind(me.ws, me.id).first();
    if (!a || !await checkPw(a.pw, b.old)) return fail("bad-password");
    if (!pwValid(b.pw)) return fail("bad-pw");
    await db.batch([
      db.prepare("UPDATE accounts SET pw=?1, fails=0, lock_until=0 WHERE ws=?2 AND member_id=?3").bind(await makePw(b.pw), me.ws, me.id),
      db.prepare("DELETE FROM sess WHERE ws=?1 AND member_id=?2 AND token<>?3").bind(me.ws, me.id, me.token),
      ntDrop(db, me.ws, me.id)   // 다른 기기는 로그아웃되므로 푸시 등록도 지웁니다. 지금 기기는 앱이 곧 다시 등록합니다
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
    if (next.active === false || pwNew) stmts.push(db.prepare("DELETE FROM sess WHERE ws=?1 AND member_id=?2 AND token<>?3").bind(me.ws, id, me.token), ntDrop(db, me.ws, id));
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
      ...NT_TABLES.map(t => db.prepare(`DELETE FROM ${t} WHERE ws=?1 AND member_id=?2`).bind(me.ws, id)),   // 알림함·푸시 기기·예약 알림
      db.prepare("DELETE FROM ws_set WHERE ws=?1 AND k=?2").bind(me.ws, "nt:" + id),
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
    const ext = modulesOk(b.modules).filter(m => EXT_MODULES.includes(m));
    await db.prepare("UPDATE workspaces SET modules=?1 WHERE id=?2").bind(JSON.stringify(ext), me.ws).run();
    return json({ ok: true, modules: [...BASE_MODULES, ...ext] });
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
    const days = clampInt(b.days, 1, kind === "cr-kit" || kind === "ed-guard" ? 365 : 180, 30), token = rand(16), now = Date.now();   // 미디어킷·보호자 페이지는 오래 걸어 두는 주소라 1년까지
    await db.batch([
      db.prepare("UPDATE links SET expires_at=?3 WHERE ws=?1 AND kind=?2 AND target=?4 AND used_at IS NULL").bind(me.ws, kind, new Date(now - 1000).toISOString(), target),   // 같은 대상의 이전 링크는 닫습니다
      db.prepare("INSERT INTO links(token,ws,kind,target,created_by,created_at,expires_at,opts) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)").bind(token, me.ws, kind, target, me.id, iso(), new Date(now + days * 864e5).toISOString(), kind === "project" ? JSON.stringify({ tasks: b.tasks !== false }) : null)
    ]);
    return json({ ok: true, token, expiresAt: new Date(now + days * 864e5).toISOString() });
  },
  async "link/revoke"(db, me, b) {   // 공유 중지 — 링크를 바로 닫습니다 (만든 사람 또는 관리자)
    if (me.role === "partner" || isField(me)) return fail("forbidden", 403);
    const t = String(b.token || "");
    const past = new Date(Date.now() - 1000).toISOString();
    const r = await db.prepare("UPDATE links SET expires_at=?3 WHERE ws=?1 AND token=?2 AND expires_at>?3" + (me.role === "admin" ? "" : " AND created_by=?4")).bind(...(me.role === "admin" ? [me.ws, t, past] : [me.ws, t, past, me.id])).run();
    if (!r || !r.meta || !r.meta.changes) return fail("not-found", 404);
    return json({ ok: true });
  },
  async "link/list"(db, me, b) {
    if (me.role === "partner" || isField(me)) return fail("forbidden", 403);
    const kind = String(b.kind || ""), target = clip(b.target, 60);
    const rs = (await db.prepare("SELECT token, created_at, expires_at, used_at, result, note, views, last_view, opts FROM links WHERE ws=?1 AND kind=?2 AND target=?3 ORDER BY created_at DESC LIMIT 5").bind(me.ws, kind, target).all()).results || [];
    return json({ ok: true, links: rs.map(r => ({ token: r.token, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at || "", result: r.result || "", note: r.note || "", views: Number(r.views) || 0, lastView: r.last_view || "", opts: parse(r.opts) || {} })) });
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
    await db.exec(spWipeSql(me.ws).concat(OS_TABLES.concat(["cm_order", "cm_inquiry", "cm_cost", "tx_doc", "tx_kval", "pp_shift", "pp_att", "pp_job", "pp_pay"]).map(t => `DELETE FROM ${t} WHERE ws=${wsLit(me.ws)}`)).join("\n"));   // 스페이스·안건·주문 기록은 지우고, 운영 시간·공통 체크리스트·상품·채널·설정은 남깁니다
    await db.batch([
      db.prepare("UPDATE ent SET deleted=1, data=NULL, ua=?1 WHERE ws=?2 AND kind NOT IN ('member','meta') AND deleted=0").bind(now, me.ws),
      ...upserts(db, me.ws, [{ kind: "template", id: tpl.id, data: tpl }], ts(Date.now() + 1)),
      db.prepare("UPDATE workspaces SET sp_ver=sp_ver+1 WHERE id=?1").bind(me.ws)
    ]);
    return json({ ok: true });
  },

  /* 운영 콘솔 — 운영자 전용 (업무 내용은 다루지 않습니다) */
  async "admin/ws"(db, me, b) {
    const act = String(b.action || "");
    const need = { plan: "ws", note: "ws", extend: "extend", approve: "ws", reject: "ws", suspend: "ws", activate: "ws", delete: "danger", resetpw: "acct" }[act] || "danger";
    const no = opNeed(me, need); if (no) return no;
    const w = await db.prepare("SELECT * FROM workspaces WHERE id=?1").bind(String(b.id || "")).first();
    if (!w) return fail("not-found", 404);
    if (act === "plan") {   // 등급·모듈·기한·한도 — 운영자 본인 워크스페이스도 바꿀 수 있습니다
      const plan = planOk(b.plan), modules = modulesOk(b.modules).filter(m => EXT_MODULES.includes(m));   // 확장판 선택은 등급과 따로 저장합니다 (베이직이면 적용만 안 됨)
      const until = dOk(b.until) || null;
      const lim = {}; const L = b.limits && typeof b.limits === "object" ? b.limits : {};
      for (const k of ["brands", "members", "tokens"]) if (L[k] !== undefined && L[k] !== "" && L[k] !== null) { const n = clampInt(L[k], 0, 100000, null); if (n !== null) lim[k] = n; }
      await db.batch([
        db.prepare("UPDATE workspaces SET plan=?1, modules=?2, plan_until=?3, limits=?4 WHERE id=?5").bind(plan, JSON.stringify(modules), until, Object.keys(lim).length ? JSON.stringify(lim) : null, w.id),
        admLog(db, "plan", w, `${plan === "pro" ? "프로" : "베이직"}${modules.length ? " · " + modules.map(m => ({ space: "마이스토어", outsourcing: "거래", commerce: "마이셀러" })[m] || m).join(", ") : ""}${until ? " · ~" + until : ""}`)
      ]);
      return json({ ok: true, plan, modules, planUntil: until || "", limits: lim });
    }
    if (act === "note") {   // 운영 메모·무료 제공 표시 — 운영자에게만 보입니다
      await db.batch([db.prepare("UPDATE workspaces SET op_note=?1, comp=?2 WHERE id=?3").bind(clip(b.note, 1000), b.comp ? 1 : 0, w.id), admLog(db, "note", w, `운영 메모 저장${b.comp ? " · 무료 제공" : ""}`)]);
      return json({ ok: true });
    }
    if (act === "extend") {   // 프로 기한 연장 — 남은 기한 뒤에 이어 붙입니다
      if (w.plan === "pro" && !w.plan_until) return fail("unlimited");
      const days = clampInt(b.days, 1, 3650, 30), today = kstToday();
      const base = w.plan === "pro" && w.plan_until && w.plan_until > today ? w.plan_until : today;
      const until = addDaysS(base, days);
      await db.batch([db.prepare("UPDATE workspaces SET plan='pro', plan_until=?1 WHERE id=?2").bind(until, w.id), admLog(db, "extend", w, `프로 기한 ${until}까지 (+${days}일)`)]);
      return json({ ok: true, planUntil: until });
    }
    if (w.id === me.ws) return fail("self");
    const now = iso();
    if (act === "approve") {
      if (w.status !== "pending") return fail("bad-state");
      const a = await db.prepare("SELECT * FROM accounts WHERE login_id=?1 AND ws=?2").bind(w.admin_login || "", w.id).first();
      if (!a) return fail("not-found", 404);
      const member = memberData(a.member_id, a.login_id, a.name, "admin", w.name, a.created_at);
      const st = startTier((await platform(db)).newPlan);
      await db.batch([
        db.prepare("UPDATE workspaces SET status='active', approved_at=?1, last_active=?1, invite=?2, plan=?4, modules=?5, plan_until=?6 WHERE id=?3").bind(now, await freshInvite(db), w.id, st.plan, JSON.stringify(st.modules), st.until),
        db.prepare("UPDATE accounts SET status='active', role='admin' WHERE login_id=?1").bind(a.login_id),
        ...seedWorkspace(db, w.id, w.name, [w.name, "기타"], member),
        admLog(db, "approve", w, `개설 승인 · ${st.plan === "pro" ? "프로" + (st.until ? " ~" + st.until : "") : "베이직"}으로 시작`)
      ]);
      const rw = await refReward(db, w.id);
      return json({ ok: true, loginId: a.login_id, refDays: rw.days || 0 });
    }
    if (act === "reject") {
      if (w.status !== "pending") return fail("bad-state");
      await db.batch([
        db.prepare("UPDATE workspaces SET status='rejected' WHERE id=?1").bind(w.id),
        db.prepare("UPDATE accounts SET status='rejected' WHERE ws=?1").bind(w.id),
        admLog(db, "reject", w, "개설 신청 반려")
      ]);
      return json({ ok: true });
    }
    if (act === "suspend" || act === "activate") {
      if (act === "suspend" && w.status !== "active") return fail("bad-state");
      if (act === "activate" && w.status !== "suspended") return fail("bad-state");
      const stmts = [db.prepare("UPDATE workspaces SET status=?1 WHERE id=?2").bind(act === "suspend" ? "suspended" : "active", w.id), admLog(db, act, w, act === "suspend" ? "이용 중지" : "이용 재개")];
      if (act === "suspend") stmts.push(db.prepare("DELETE FROM sess WHERE ws=?1").bind(w.id), db.prepare("DELETE FROM nt_sub WHERE ws=?1").bind(w.id));
      await db.batch(stmts);
      return json({ ok: true });
    }
    if (act === "delete") {
      await htForget(db, w.id);   // 수집 서비스에 등록해 둔 홈택스 조회 아이디부터 지웁니다
      await db.batch(SP_TABLES.concat(OS_TABLES, CM_TABLES, TX_TABLES, PP_TABLES, MK_TABLES, CR_TABLES, ED_TABLES, NT_TABLES, MSG_TABLES, HT_TABLES, ["ws_set", "api_tokens", "links", "mod_set", "invites"]).map(t => db.prepare(`DELETE FROM ${t} WHERE ws=?1`).bind(w.id)));   // 한 묶음으로 — 중간에 끊겨 반만 지워지는 일이 없습니다
      await db.batch([
        db.prepare("DELETE FROM ent WHERE ws=?1").bind(w.id),
        db.prepare("DELETE FROM sess WHERE ws=?1").bind(w.id),
        db.prepare("DELETE FROM accounts WHERE ws=?1").bind(w.id),
        db.prepare("DELETE FROM workspaces WHERE id=?1").bind(w.id),
        admLog(db, "delete", w, "워크스페이스와 모든 데이터 삭제")
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
        db.prepare("DELETE FROM sess WHERE ws=?1 AND member_id=?2").bind(w.id, a.member_id), ntDrop(db, w.id, a.member_id),
        db.prepare("UPDATE workspaces SET admin_login=?1 WHERE id=?2").bind(a.login_id, w.id),
        admLog(db, "resetpw", w, `관리자 ${a.login_id} 비밀번호 초기화`)
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
  "CREATE TABLE IF NOT EXISTS sp_log(ws TEXT NOT NULL, ran_at TEXT NOT NULL, by_name TEXT, ok INTEGER, added INTEGER, updated INTEGER, removed INTEGER, skipped INTEGER, message TEXT, PRIMARY KEY(ws,ran_at))",
  // 마이스토어 — 일 마감(매출·시재), 소모품, 리뷰·문의
  "CREATE TABLE IF NOT EXISTS sp_day(ws TEXT NOT NULL, branch_id TEXT NOT NULL, date TEXT NOT NULL, sales TEXT NOT NULL DEFAULT '{}', guests INTEGER, cash_open INTEGER, cash_out INTEGER, cash_close INTEGER, note TEXT, status TEXT NOT NULL DEFAULT 'closed', closed_by TEXT, closed_name TEXT, closed_at TEXT, check_by TEXT, check_name TEXT, check_at TEXT, PRIMARY KEY(ws,branch_id,date))",
  "CREATE INDEX IF NOT EXISTS idx_sp_day_date ON sp_day(ws,date)",
  "CREATE TABLE IF NOT EXISTS sp_sup(ws TEXT NOT NULL, id TEXT NOT NULL, branch_id TEXT, name TEXT NOT NULL, unit TEXT, qty INTEGER NOT NULL DEFAULT 0, min_qty INTEGER NOT NULL DEFAULT 0, vendor TEXT, memo TEXT, sort INTEGER NOT NULL DEFAULT 0, updated_at TEXT, updated_name TEXT, PRIMARY KEY(ws,id))",
  "CREATE TABLE IF NOT EXISTS sp_rev(ws TEXT NOT NULL, id TEXT NOT NULL, branch_id TEXT, channel TEXT, kind TEXT NOT NULL DEFAULT 'review', rating INTEGER, author TEXT, body TEXT NOT NULL, date TEXT, status TEXT NOT NULL DEFAULT 'todo', reply TEXT, replied_at TEXT, replied_name TEXT, created_at TEXT, PRIMARY KEY(ws,id))"
];
const SP_TABLES = ["sp_prof", "sp_set", "sp_chk", "sp_res", "sp_cln", "sp_iss", "sp_chn", "sp_cost", "sp_asg", "sp_ntc", "sp_read", "sp_log", "sp_day", "sp_sup", "sp_rev"];
const SPC = {
  sp_prof: ["sid", "d", "ua"],
  sp_set: ["k", "v"],
  sp_chk: ["id", "scope", "branch_id", "category", "label", "sort", "active", "list"],
  sp_res: ["id", "branch_id", "res_date", "slot", "resno", "customer", "phone", "amount", "status", "issue", "memo", "start_t", "end_t", "source", "created_at", "channel", "staff", "service"],
  sp_cln: ["id", "task_key", "branch_id", "clean_date", "kind", "assignee", "status", "checks", "note", "submitted_by", "submitted_name", "submitted_at", "review_by", "review_name", "review_at", "feedback", "manual", "window_label", "created_at"],
  sp_iss: ["id", "branch_id", "category", "equip", "title", "detail", "priority", "status", "reporter", "reporter_name", "assignee", "cost", "comments", "created_at", "resolved_at"],
  sp_chn: ["id", "branch_id", "channel", "url", "status", "owner", "last_check", "memo", "sort"],
  sp_cost: ["ym", "branch_id", "rent", "mgmt", "supplies", "telecom", "misc", "fee_pct"],
  sp_asg: ["id", "date", "region", "branch_id", "worker", "created_by", "created_at"],
  sp_ntc: ["id", "date", "body", "created_by", "created_name", "created_at"],
  sp_read: ["notice_id", "member_id", "member_name", "read_at"],
  sp_log: ["ran_at", "by_name", "ok", "added", "updated", "removed", "skipped", "message"],
  sp_day: ["branch_id", "date", "sales", "guests", "cash_open", "cash_out", "cash_close", "note", "status", "closed_by", "closed_name", "closed_at", "check_by", "check_name", "check_at"],
  sp_sup: ["id", "branch_id", "name", "unit", "qty", "min_qty", "vendor", "memo", "sort", "updated_at", "updated_name"],
  sp_rev: ["id", "branch_id", "channel", "kind", "rating", "author", "body", "date", "status", "reply", "replied_at", "replied_name", "created_at"]
};
const SPJ = { sp_cln: { checks: "{}" }, sp_iss: { comments: "[]" }, sp_prof: { d: "{}" }, sp_set: { v: "null" }, sp_day: { sales: "{}" } };   // JSON으로 저장하는 칸
const SP_SLOTS = ["day", "night", "allday", "etc"];
const SP_KINDS = ["day", "night", "allday", "mid", "etc", "open", "close"];   // open·close = 마이스토어 오픈·마감 점검
const SP_TYPES = ["space", "food", "retail", "appt"];   // 공간대여·숙박 · 음식·카페 · 소매·무인매장 · 예약형 매장
const SP_LISTS = ["clean", "open", "close"];
// 업종별 오픈·마감 점검 기본 항목 [목록, 분류, 항목]
const SP_DAILY_SEED = {
  food: [
    ["open", "위생", "냉장·냉동고 온도 확인(냉장 5℃·냉동 -18℃ 이하)"], ["open", "위생", "식자재 유통기한·상태 확인"], ["open", "위생", "손 세정제·위생장갑·앞치마 준비"],
    ["open", "매장", "홀·테이블·화장실 청결 확인"], ["open", "기기", "POS·카드 단말기·배달앱 접수 켜기"], ["open", "시재", "시작 시재 확인"],
    ["close", "위생", "남은 식자재 밀봉·날짜 표시 후 보관"], ["close", "청소", "조리 기구·그릴·튀김기 청소"], ["close", "청소", "음식물·일반 쓰레기 배출"], ["close", "청소", "바닥·테이블 청소"],
    ["close", "안전", "가스 밸브 잠금·전기 기구 끄기"], ["close", "안전", "냉장·냉동고 문 닫힘 확인"], ["close", "시재", "마감 시재 세기·매출 정리"], ["close", "안전", "출입문·창문 잠금, 보안 설정"]
  ],
  retail: [
    ["open", "진열", "진열대 결품·유통기한 확인"], ["open", "기기", "키오스크·결제기 작동 확인"], ["open", "보안", "CCTV 녹화 확인"], ["open", "매장", "매장 청결·조명 확인"], ["open", "기기", "냉장·냉동 진열장 온도 확인"],
    ["close", "진열", "진열 정리·결품 채우기"], ["close", "청소", "쓰레기·분리수거 정리"], ["close", "기기", "키오스크 매출·오류 확인"], ["close", "보안", "도난·파손 흔적 확인(CCTV)"], ["close", "보안", "출입문 잠금·조명 타이머 확인"]
  ],
  appt: [
    ["open", "예약", "오늘 예약과 담당자 확인"], ["open", "위생", "시술·수업 공간 정리와 소독"], ["open", "준비", "수건·소모품 준비"], ["open", "매장", "음악·조명·냉난방 켜기"], ["open", "기기", "결제 단말기 확인"],
    ["close", "위생", "사용한 도구 세척·소독"], ["close", "준비", "수건 세탁·건조"], ["close", "청소", "바닥·거울·대기석 청소"], ["close", "예약", "내일 예약 확인·노쇼 기록"], ["close", "시재", "마감 시재 세기·매출 정리"], ["close", "안전", "전기·온수기 끄기, 출입문 잠금"]
  ],
  space: [
    ["open", "매장", "출입 비밀번호·도어락 작동 확인"], ["open", "기기", "와이파이·TV·음향 작동 확인"], ["open", "매장", "냉난방·조명 상태 확인"],
    ["close", "안전", "전기·냉난방 끄기 확인"], ["close", "매장", "분리수거·쓰레기 배출 확인"], ["close", "안전", "출입문 잠금 확인"]
  ]
};
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
    fees: spFees(s.fees),
    biz: SP_TYPES.includes(s.biz) ? s.biz : "",
    reply_tpl: Array.isArray(s.reply_tpl) ? s.reply_tpl.map(x => clip(x, 400)).filter(Boolean).slice(0, 20) : []
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
  const [res, cln, iss, day, sup, rev] = await db.batch([
    db.prepare("SELECT id, branch_id, res_date, slot, start_t, end_t, customer, amount, status, issue, source, staff, service FROM sp_res WHERE ws=?1 AND res_date>=?2 AND res_date<=?3 ORDER BY res_date, start_t").bind(me.ws, today, tmr),
    db.prepare("SELECT id, branch_id, clean_date, kind, status, assignee, submitted_name FROM sp_cln WHERE ws=?1 AND (clean_date=?2 OR status='done') LIMIT 200").bind(me.ws, today),
    db.prepare("SELECT id, branch_id, title, status, priority, created_at FROM sp_iss WHERE ws=?1 AND status NOT IN ('완료','보류') ORDER BY created_at DESC LIMIT 50").bind(me.ws),
    db.prepare("SELECT branch_id, date, sales, guests, status, closed_name FROM sp_day WHERE ws=?1 AND date>=?2 ORDER BY date DESC LIMIT 200").bind(me.ws, addDaysS(today, -7)),
    db.prepare("SELECT branch_id, name, unit, qty, min_qty FROM sp_sup WHERE ws=?1 AND qty<=min_qty LIMIT 50").bind(me.ws),
    db.prepare("SELECT id, branch_id, channel, kind, rating, body, date FROM sp_rev WHERE ws=?1 AND status='todo' ORDER BY date DESC LIMIT 20").bind(me.ws)
  ]);
  const bn = id => { const b = sc.branches.find(x => x.id === id); return b ? b.name : ""; };
  const names = new Map(((await db.prepare("SELECT id, json_extract(data,'$.name') AS name FROM ent WHERE ws=?1 AND kind='member' AND deleted=0").bind(me.ws).all()).results || []).map(r => [r.id, r.name]));
  const R = ((res && res.results) || []).filter(r => sc.vis.has(r.branch_id) && !String(r.status || "").includes("취소")).map(r => ({ date: r.res_date, branch: bn(r.branch_id), slot: r.slot, start: r.start_t || "", end: r.end_t || "", customer: mgr ? (r.customer || "") : "", amount: mgr ? r.amount : undefined, issue: r.issue || "", source: r.source, staff: r.staff || "", service: r.service || "", status: r.status || "" }));
  const C = (cln && cln.results) || [];
  return {
    today, reservations: { today: R.filter(r => r.date === today), tomorrow: R.filter(r => r.date === tmr) },
    cleaningToday: C.filter(c => c.clean_date === today).map(c => ({ branch: bn(c.branch_id), kind: c.kind, status: c.status, assignee: names.get(c.assignee) || c.assignee || "" })),
    pendingReview: C.filter(c => c.status === "done").map(c => ({ id: c.id, branch: bn(c.branch_id), date: c.clean_date, by: c.submitted_name || "" })),
    openIssues: ((iss && iss.results) || []).map(i => ({ id: i.id, branch: i.branch_id ? bn(i.branch_id) : "공통", title: i.title, status: i.status, priority: i.priority })),
    branches: sc.branches.filter(b => b.on).map(b => ({ name: b.name, type: b.type || "" })),
    dayClose: ((day && day.results) || []).filter(d => sc.vis.has(d.branch_id)).map(d => { const sl = parse(d.sales) || {}; return { branch: bn(d.branch_id), date: d.date, total: mgr ? Object.values(sl).reduce((a, v) => a + (+v || 0), 0) : undefined, guests: d.guests, status: d.status, by: d.closed_name || "" }; }),
    lowSupplies: ((sup && sup.results) || []).filter(x => !x.branch_id || sc.vis.has(x.branch_id)).map(x => ({ branch: x.branch_id ? bn(x.branch_id) : "공통", name: x.name, qty: x.qty, min: x.min_qty, unit: x.unit || "" })),
    reviewsToAnswer: mgr ? ((rev && rev.results) || []).map(r => ({ id: r.id, branch: r.branch_id ? bn(r.branch_id) : "", channel: r.channel || "", kind: r.kind, rating: r.rating, body: r.body, date: r.date })) : []
  };
}

/* 한 행 = JSON 한 줄로 받아 그대로 이어 붙입니다 (서버 계산을 줄이기 위해) */
/* 한 줄을 JSON으로 — D1은 SQL 함수 하나에 인수를 32개까지만 받습니다(developers.cloudflare.com/d1/platform/limits).
   그래서 칸이 16개를 넘는 표는 json_object(앞 16칸)에 json_insert로 15칸씩 덧붙입니다. 결과는 한 번에 만든 것과 같습니다 */
function spObj(pairs) {
  let sql = `json_object(${pairs.slice(0, 16).map(x => `'${x[0]}',${x[1]}`).join(",")})`;
  for (let i = 16; i < pairs.length; i += 15) sql = `json_insert(${sql},${pairs.slice(i, i + 15).map(x => `'$.${x[0]}',${x[1]}`).join(",")})`;
  return sql;
}
function spSel(t, where, tail) {
  const pairs = SPC[t].map(c => [c, SPJ[t] && SPJ[t][c] !== undefined ? `CASE WHEN json_valid(${c}) THEN json(${c}) ELSE json('${SPJ[t][c]}') END` : c]);
  return `SELECT ${spObj(pairs)} AS j FROM ${t} WHERE ${where}${tail ? " " + tail : ""}`;
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
    const b = { id: r.id, name: clip(d.name, 60), region: clip(d.region, 30), status: d.status || "운영중", brand: clip(d.brand, 30), on: p.on ? 1 : 0, alias: p.alias || "", scode: p.scode || "", worker: p.worker || "", std: p.std ?? null, buf: p.buf ?? null, mid: p.mid || "", slots: p.slots || null, rules: p.rules || "", sort: Number(p.sort) || 0, type: SP_TYPES.includes(p.type) ? p.type : "", staff: p.staff || "", hours: p.hours || null, float: p.float ?? null, daily: p.daily ? 1 : 0 };
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
  if ("staff" in r) o.staff = clip(r.staff, 40) || null;
  if ("service" in r) o.service = clip(r.service, 80) || null;
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
    q.push(
      mgr ? db.prepare(spSel("sp_day", "ws=?1 AND date>=?2 AND date<=?3")).bind(me.ws, f1, t1)
        : db.prepare(spSel("sp_day", "ws=?1 AND date>=?2 AND date<=?3")).bind(me.ws, addDaysS(today, -1), today),
      db.prepare(spSel("sp_sup", "ws=?1", "ORDER BY sort, name")).bind(me.ws)
    );
    if (mgr) q.push(
      db.prepare(spSel("sp_chn", "ws=?1")).bind(me.ws),
      db.prepare(spSel("sp_cost", "ws=?1 AND ym>=?2 AND ym<=?3")).bind(me.ws, addDaysS(from, -32).slice(0, 7), to.slice(0, 7)),
      db.prepare(spSel("sp_log", "ws=?1", "ORDER BY ran_at DESC LIMIT 1")).bind(me.ws),
      db.prepare(spSel("sp_rev", "ws=?1 AND (status='todo' OR date>=?2)", "ORDER BY date DESC, created_at DESC LIMIT 500")).bind(me.ws, addDaysS(from, -60))
    );
    const rs = await db.batch(q);
    const set = new Map(((rs[0] && rs[0].results) || []).map(r => [r.k, r.v]));
    let checks = rawArr(rs[1]);
    if (mgr && !set.has("seeded") && await spSeed(db, me)) checks = rawArr((await db.prepare(spSel("sp_chk", "ws=?1")).bind(me.ws).all()));
    let res, cln, iss, reads = rawArr(rs[6]), days = rawArr(rs[8]), sup = rawArr(rs[9]);
    if (mgr) { res = rawArr(rs[2]); cln = rawArr(rs[3]); iss = rawArr(rs[7]); }
    else {
      const salt = rand(8);   // 같은 응답 안에서만 "같은 고객" 비교가 되도록 — 이름·연락처는 보내지 않습니다
      res = JSON.stringify(((rs[2] && rs[2].results) || []).filter(r => sc.vis.has(r.branch_id) && !String(r.status || "").includes("취소")).map(r => ({
        id: r.id, branch_id: r.branch_id, res_date: r.res_date, slot: r.slot, start_t: r.start_t, end_t: r.end_t, source: r.source,
        ckey: (r.customer || r.phone) ? dhash(salt + "|" + (r.customer || "") + "|" + (r.phone || "")) : "", issue: r.issue ? 1 : 0
      })));
      cln = JSON.stringify(rowsOf(rs[3]).filter(c => sc.vis.has(c.branch_id)));
      iss = JSON.stringify(rowsOf(rs[7]).filter(i => !i.branch_id || sc.vis.has(i.branch_id) || i.reporter === me.id));
      days = JSON.stringify(rowsOf(rs[8]).filter(d => sc.vis.has(d.branch_id)));
      sup = JSON.stringify(rowsOf(rs[9]).filter(x => !x.branch_id || sc.vis.has(x.branch_id)).map(x => ({ id: x.id, branch_id: x.branch_id, name: x.name, unit: x.unit, qty: x.qty, min_qty: x.min_qty, sort: x.sort, updated_at: x.updated_at, updated_name: x.updated_name })));
    }
    const host = await hostInfo(db, me, env);
    const head = {
      ok: true, v: me.spv, from, to, today, role: mgr ? "mgr" : me.role, branches: sc.branches,
      settings: spSettings(parse(set.get("settings"))), host, legacy: !!(env && env.SPACEDB) && me.owner,
      log: mgr ? (rowsOf(rs[12])[0] || null) : null
    };
    return rawJson(head, ',"checks":' + checks + ',"res":' + res + ',"cln":' + cln + ',"asg":' + rawArr(rs[4]) + ',"ntc":' + rawArr(rs[5]) +
      ',"reads":' + reads + ',"iss":' + iss + ',"chn":' + (mgr ? rawArr(rs[10]) : "[]") + ',"cost":' + (mgr ? rawArr(rs[11]) : "[]") +
      ',"days":' + days + ',"sup":' + sup + ',"rev":' + (mgr ? rawArr(rs[13]) : "[]"));
  },

  /* 지점(매장) 운영 프로필 */
  async prof(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const sid = clip(b.sid, 60);
    if (!await storeOk(db, me, sid)) return fail("not-found", 404);
    const num = v => v === "" || v == null ? null : clampInt(v, 0, 720, null);
    const slots = {};
    if (b.slots && typeof b.slots === "object") for (const k of ["day", "night", "allday"]) { const v = b.slots[k]; if (Array.isArray(v) && tOk(v[0]) && tOk(v[1])) slots[k] = [tOk(v[0]), tOk(v[1])]; }
    const hours = Array.isArray(b.hours) && tOk(b.hours[0]) && tOk(b.hours[1]) ? [tOk(b.hours[0]), tOk(b.hours[1])] : null;
    const d = { on: b.on ? 1 : 0, alias: clip(b.alias, 200), scode: clip(b.scode, 40), worker: clip(b.worker, 60), std: num(b.std), buf: num(b.buf), mid: tOk(b.mid), slots: Object.keys(slots).length ? slots : null, rules: clip(b.rules, 2000), sort: intOr(b.sort, 0),
      type: SP_TYPES.includes(b.type) ? b.type : "", staff: clip(b.staff, 300), hours, float: b.float === "" || b.float == null ? null : clampInt(b.float, 0, 100000000, null), daily: b.daily ? 1 : 0 };
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
    if ("list" in b) o.list = SP_LISTS.includes(b.list) && b.list !== "clean" ? b.list : null;
    if (id) {
      if (!Object.keys(o).length) return fail("bad-request");
      if (!await spOne(db, "sp_chk", me.ws, id)) return fail("not-found", 404);
      const { v } = await spRun(db, me, [db.prepare(`UPDATE sp_chk SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
      return json({ ok: true, v, item: await spOne(db, "sp_chk", me.ws, id) });
    }
    if (!o.label) return fail("bad-request");
    if (o.scope === "branch" && !await storeOk(db, me, o.branch_id)) return fail("bad-branch");
    const row = Object.assign({ id: uid("ck"), scope: "common", branch_id: null, category: "기타", label: "", sort: 99, active: 1, list: null }, o);
    if (row.scope === "common") row.branch_id = null;
    const { v } = await spRun(db, me, spBulk(db, "sp_chk", me.ws, [row]));
    return json({ ok: true, v, item: row });
  },
  // 업종을 고르면 오픈·마감 점검 기본 항목을 넣습니다 (같은 목록에 공통 항목이 이미 있으면 그 목록은 건너뜀)
  async "chk/seed"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const type = SP_TYPES.includes(b.type) ? b.type : "";
    if (!type) return fail("bad-request");
    const have = new Set(((await db.prepare("SELECT DISTINCT list FROM sp_chk WHERE ws=?1 AND scope='common' AND list IN ('open','close')").bind(me.ws).all()).results || []).map(r => r.list));
    const rows = SP_DAILY_SEED[type].filter(x => !have.has(x[0])).map((x, i) => ({ id: bulkId("ck"), scope: "common", branch_id: null, category: x[1], label: x[2], sort: i + 1, active: 1, list: x[0] }));
    const stmts = [db.prepare("INSERT INTO sp_set(ws,k,v) VALUES(?1,'settings',json_set(COALESCE((SELECT v FROM sp_set WHERE ws=?1 AND k='settings'),'{}'),'$.biz',?2)) ON CONFLICT(ws,k) DO UPDATE SET v=json_set(COALESCE(sp_set.v,'{}'),'$.biz',?2)").bind(me.ws, type)];
    stmts.push(...(rows.length ? spBulk(db, "sp_chk", me.ws, rows) : []));
    const { v } = await spRun(db, me, stmts);
    const set = await db.prepare("SELECT v FROM sp_set WHERE ws=?1 AND k='settings'").bind(me.ws).first();
    return json({ ok: true, v, added: rows.length, items: rows, settings: spSettings(parse(set && set.v)) });
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
    if (status === "redo") await notify(db, me.ws, [ex.submitted_by || ex.assignee].filter(x => x && x !== me.id), { type: "store", title: "청소를 다시 확인해 주세요", body: clip(fb, 120), url: "#/space", tag: "cln-redo" });
    return json({ ok: true, v, cleaning: await spOne(db, "sp_cln", me.ws, ex.id) });
  },
  async "cln/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM sp_cln WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },

  /* 일 마감 — 그날 매출(결제수단별)·객수·시재. 근무자는 담당 지점의 오늘·어제만, 관리자가 확인하면 잠깁니다 */
  async "day/save"(db, me, b) {
    const bid = clip(b.branch_id, 60), date = dOk(b.date), mgr = isMgr(me);
    if (!bid || !date) return fail("bad-request");
    if (mgr) { if (!await storeOk(db, me, bid)) return fail("bad-branch"); }
    else {
      if (me.role !== "worker" && me.role !== "facility") return fail("forbidden", 403);
      const sc = await spScope(db, me); if (!sc.vis.has(bid)) return fail("forbidden", 403);
      const today = kstToday(); if (date > today || date < addDaysS(today, -1)) return fail("bad-date");
    }
    const ex = await db.prepare(spSel("sp_day", "ws=?1 AND branch_id=?2 AND date=?3")).bind(me.ws, bid, date).first().then(r => r ? parse(r.j) : null);
    if (ex && ex.status === "checked" && !mgr) return fail("locked", 409);
    const money = v => v === "" || v == null ? null : Math.max(0, Math.min(10000000000, intOr(String(v).replace(/[^\d-]/g, ""), 0)));
    const sales = {};
    if (b.sales && typeof b.sales === "object" && !Array.isArray(b.sales)) for (const [k, v] of Object.entries(b.sales).slice(0, 20)) { const key = clip(k, 20), n = money(v); if (key && n) sales[key] = n; }
    const row = { branch_id: bid, date, sales: JSON.stringify(sales), guests: b.guests === "" || b.guests == null ? null : clampInt(b.guests, 0, 1000000, null), cash_open: money(b.cash_open), cash_out: money(b.cash_out), cash_close: money(b.cash_close), note: clip(b.note, 1000),
      status: mgr && b.check ? "checked" : "closed", closed_by: me.id, closed_name: me.name, closed_at: iso(), check_by: null, check_name: null, check_at: null };
    if (row.status === "checked") { row.check_by = me.id; row.check_name = me.name; row.check_at = iso(); }
    if (ex && mgr && ex.closed_by && ex.closed_by !== me.id) { row.closed_by = ex.closed_by; row.closed_name = ex.closed_name; row.closed_at = ex.closed_at; }   // 관리자가 고쳐도 마감한 사람은 그대로
    const cols = SPC.sp_day.filter(c => c !== "branch_id" && c !== "date");
    const { v } = await spRun(db, me, spBulk(db, "sp_day", me.ws, [row], "ON CONFLICT(ws,branch_id,date) DO UPDATE SET " + cols.map(c => `${c}=excluded.${c}`).join(",")));
    return json({ ok: true, v, day: Object.assign({}, row, { sales }) });
  },
  async "day/check"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const bid = clip(b.branch_id, 60), date = dOk(b.date);
    const ex = await db.prepare(spSel("sp_day", "ws=?1 AND branch_id=?2 AND date=?3")).bind(me.ws, bid, date).first().then(r => r ? parse(r.j) : null);
    if (!ex) return fail("not-found", 404);
    const on = b.undo ? 0 : 1;
    const { v } = await spRun(db, me, [db.prepare("UPDATE sp_day SET status=?4, check_by=?5, check_name=?6, check_at=?7 WHERE ws=?1 AND branch_id=?2 AND date=?3").bind(me.ws, bid, date, on ? "checked" : "closed", on ? me.id : null, on ? me.name : null, on ? iso() : null)]);
    return json({ ok: true, v, day: await db.prepare(spSel("sp_day", "ws=?1 AND branch_id=?2 AND date=?3")).bind(me.ws, bid, date).first().then(r => r ? parse(r.j) : null) });
  },
  async "day/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM sp_day WHERE ws=?1 AND branch_id=?2 AND date=?3").bind(me.ws, clip(b.branch_id, 60), dOk(b.date) || "")]);
    return json({ ok: true, v });
  },

  /* 소모품 — 관리자는 항목을 만들고, 근무자는 담당 지점의 남은 수량만 고칩니다 */
  async "sup/save"(db, me, b) {
    const id = clip(b.id, 60), mgr = isMgr(me);
    const ex = id ? await spOne(db, "sp_sup", me.ws, id) : null;
    if (id && !ex) return fail("not-found", 404);
    const q = v => clampInt(v, 0, 1000000, 0);
    if (!mgr) {
      if (!ex || !("qty" in b)) return fail("forbidden", 403);
      if (ex.branch_id) { const sc = await spScope(db, me); if (!sc.vis.has(ex.branch_id)) return fail("forbidden", 403); }
      const { v } = await spRun(db, me, [db.prepare("UPDATE sp_sup SET qty=?3, updated_at=?4, updated_name=?5 WHERE ws=?1 AND id=?2").bind(me.ws, id, q(b.qty), iso(), me.name)]);
      return json({ ok: true, v, supply: await spOne(db, "sp_sup", me.ws, id) });
    }
    const o = {};
    if ("branch_id" in b) { o.branch_id = clip(b.branch_id, 60) || null; if (o.branch_id && !await storeOk(db, me, o.branch_id)) return fail("bad-branch"); }
    if ("name" in b) { o.name = clip(b.name, 80); if (!o.name) return fail("bad-request"); }
    if ("unit" in b) o.unit = clip(b.unit, 20);
    if ("qty" in b) o.qty = q(b.qty);
    if ("min_qty" in b) o.min_qty = q(b.min_qty);
    if ("vendor" in b) o.vendor = clip(b.vendor, 300);
    if ("memo" in b) o.memo = clip(b.memo, 300);
    if ("sort" in b) o.sort = intOr(b.sort, 0);
    o.updated_at = iso(); o.updated_name = me.name;
    if (ex) {
      const { v } = await spRun(db, me, [db.prepare(`UPDATE sp_sup SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
      return json({ ok: true, v, supply: await spOne(db, "sp_sup", me.ws, id) });
    }
    if (!o.name) return fail("bad-request");
    const row = Object.assign({ id: uid("su"), branch_id: null, name: "", unit: "개", qty: 0, min_qty: 0, vendor: "", memo: "", sort: 99 }, o);
    const { v } = await spRun(db, me, spBulk(db, "sp_sup", me.ws, [row]));
    return json({ ok: true, v, supply: row });
  },
  async "sup/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM sp_sup WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },

  /* 리뷰·문의 — 플랫폼에 달린 리뷰와 문의를 모아 답글을 관리합니다 (관리자·직원) */
  async "rev/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), o = {};
    if ("branch_id" in b) { o.branch_id = clip(b.branch_id, 60) || null; if (o.branch_id && !await storeOk(db, me, o.branch_id)) return fail("bad-branch"); }
    if ("channel" in b) o.channel = clip(b.channel, 40);
    if ("kind" in b) o.kind = b.kind === "question" ? "question" : "review";
    if ("rating" in b) o.rating = b.rating === "" || b.rating == null ? null : clampInt(b.rating, 1, 5, null);
    if ("author" in b) o.author = clip(b.author, 40);
    if ("body" in b) { o.body = clip(b.body, 2000); if (!o.body) return fail("bad-request"); }
    if ("date" in b) o.date = dOk(b.date) || kstToday();
    if ("reply" in b) o.reply = clip(b.reply, 2000);
    if ("status" in b) { o.status = ["todo", "done", "skip"].includes(b.status) ? b.status : "todo"; if (o.status === "done") { o.replied_at = iso(); o.replied_name = me.name; } }
    if (id) {
      if (!await spOne(db, "sp_rev", me.ws, id)) return fail("not-found", 404);
      if (!Object.keys(o).length) return fail("bad-request");
      const { v } = await spRun(db, me, [db.prepare(`UPDATE sp_rev SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
      return json({ ok: true, v, review: await spOne(db, "sp_rev", me.ws, id) });
    }
    if (!o.body) return fail("bad-request");
    const row = Object.assign({ id: uid("rv"), branch_id: null, channel: "", kind: "review", rating: null, author: "", body: "", date: kstToday(), status: "todo", reply: "", replied_at: null, replied_name: null }, o, { created_at: iso() });
    const { v } = await spRun(db, me, spBulk(db, "sp_rev", me.ws, [row]));
    return json({ ok: true, v, review: row });
  },
  async "rev/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM sp_rev WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
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
      await notify(db, me.ws, (await whoIs(db, me.ws, ["admin", "facility"])).filter(x => x !== me.id), { type: "store", title: (row.priority === "긴급" ? "[긴급] " : "") + "시설 문제가 접수되었습니다", body: `${title} — ${me.name || ""}`, url: "#/space/fac", tag: "iss" });
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
    if (worker !== me.id && date >= kstToday()) await notify(db, me.ws, [worker], { type: "store", title: "청소가 배정되었습니다", body: `${date.slice(5).replace("-", "/")}${region ? " · " + region : ""}`, url: "#/space", tag: "asg:" + date, once: 30 });
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
const modTables = () => OS_TABLES.concat(CM_TABLES, TX_TABLES, PP_TABLES, MK_TABLES, CR_TABLES, ED_TABLES);
// 표를 둘씩 묶어 한 문장(UNION ALL)으로 읽습니다 — 확장판이 늘어도 요청당 쿼리 수 한도(무료 플랜 50)를 넘지 않게
async function modBackupRaw(db, ws) {
  const MOD_TABLES = modTables(), pairs = [];
  for (let i = 0; i < MOD_TABLES.length; i += 2) pairs.push(MOD_TABLES.slice(i, i + 2));
  const tagged = t => spSel(t, "ws=?1").replace("SELECT ", `SELECT '${t}' AS t, `);
  const rs = await db.batch(pairs.map(p => db.prepare(p.map(tagged).join(" UNION ALL ")).bind(ws)).concat([db.prepare("SELECT json_object('mod',mod,'k',k,'v',CASE WHEN json_valid(v) THEN json(v) ELSE json('null') END) AS j FROM mod_set WHERE ws=?1 AND NOT (mod='mk' AND k='conn') AND NOT (mod='cr' AND k='quota') AND NOT (mod='msg' AND k='conn') AND NOT (mod='tx' AND k='ht')").bind(ws)]));
  const by = {}; for (const t of MOD_TABLES) by[t] = [];
  pairs.forEach((p, i) => { for (const r of (rs[i] && rs[i].results) || []) if (by[r.t]) by[r.t].push(r.j); });
  return '{"v":1,' + MOD_TABLES.map(t => JSON.stringify(t) + ":[" + by[t].join(",") + "]").join(",") + ',"mod_set":' + rawArr(rs[pairs.length]) + "}";
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
    dels.push(`DELETE FROM mod_set WHERE ws=${wsLit(ws)} AND NOT (mod='mk' AND k='conn') AND NOT (mod='msg' AND k='conn') AND NOT (mod='tx' AND k='ht')`);   // 연결 정보는 백업에 없으므로 복원해도 그대로 둡니다
    stmts.push(db.prepare("INSERT OR IGNORE INTO mod_set(ws,mod,k,v) SELECT ?1, json_extract(value,'$.mod'), json_extract(value,'$.k'), json_extract(value,'$.v') FROM json_each(?2) WHERE true").bind(ws, JSON.stringify(m.mod_set.filter(r => !(r && ((r.mod === "mk" && r.k === "conn") || (r.mod === "msg" && r.k === "conn") || (r.mod === "tx" && r.k === "ht")))).slice(0, 200).map(r => ({ mod: clip(r && r.mod, 10), k: clip(r && r.k, 40), v: JSON.stringify(r && r.v !== undefined ? r.v : null) })))));
  }
  return { dels, stmts };
}
const spWipeSql = ws => [
  ...["sp_res", "sp_cln", "sp_iss", "sp_chn", "sp_cost", "sp_asg", "sp_ntc", "sp_read", "sp_log", "sp_prof", "sp_day", "sp_sup", "sp_rev"].map(t => `DELETE FROM ${t} WHERE ws=${wsLit(ws)}`),
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
  "CREATE TABLE IF NOT EXISTS cm_cost(ws TEXT NOT NULL, ym TEXT NOT NULL, channel_id TEXT NOT NULL, ads INTEGER NOT NULL DEFAULT 0, misc INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(ws,ym,channel_id))",
  // 마이셀러 — 공급처·발주·재고 기록·정산 대사
  "CREATE TABLE IF NOT EXISTS cm_supplier(ws TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, contact TEXT, phone TEXT, email TEXT, memo TEXT, created_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE TABLE IF NOT EXISTS cm_po(ws TEXT NOT NULL, id TEXT NOT NULL, no TEXT, supplier_id TEXT, status TEXT NOT NULL DEFAULT 'draft', items TEXT NOT NULL DEFAULT '[]', total INTEGER NOT NULL DEFAULT 0, ordered_at TEXT, expected TEXT, received_at TEXT, memo TEXT, reply_note TEXT, replied_by TEXT, replied_at TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE TABLE IF NOT EXISTS cm_stock(ws TEXT NOT NULL, id TEXT NOT NULL, product_id TEXT NOT NULL, delta INTEGER NOT NULL, reason TEXT, ref TEXT, at TEXT NOT NULL, by_name TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_cm_stock_p ON cm_stock(ws,product_id,at)",
  "CREATE TABLE IF NOT EXISTS cm_settle(ws TEXT NOT NULL, ym TEXT NOT NULL, channel_id TEXT NOT NULL, expected INTEGER, received INTEGER, received_at TEXT, memo TEXT, PRIMARY KEY(ws,ym,channel_id))"
];
const CM_TABLES = ["cm_channel", "cm_product", "cm_order", "cm_inquiry", "cm_cost", "cm_supplier", "cm_po", "cm_stock", "cm_settle"];
Object.assign(SPC, {
  cm_channel: ["id", "name", "fee_pct", "settle_days", "sort", "active"],
  cm_product: ["id", "name", "sku", "price", "cost", "stock", "safety", "active", "memo", "created_at", "updated_at", "option", "supplier_id"],
  cm_order: ["id", "channel_id", "order_no", "order_date", "product_id", "product_name", "option", "qty", "amount", "ship_fee", "status", "receiver", "phone", "address", "tracking", "carrier", "memo", "settle_date", "settle_amt", "source", "created_at", "updated_at", "shipped_at", "claim"],
  cm_inquiry: ["id", "channel_id", "order_no", "customer", "text", "due", "status", "answer", "answered_at", "created_at"],
  cm_cost: ["ym", "channel_id", "ads", "misc"],
  cm_supplier: ["id", "name", "contact", "phone", "email", "memo", "created_at"],
  cm_po: ["id", "no", "supplier_id", "status", "items", "total", "ordered_at", "expected", "received_at", "memo", "reply_note", "replied_by", "replied_at", "created_at", "updated_at"],
  cm_stock: ["id", "product_id", "delta", "reason", "ref", "at", "by_name"],
  cm_settle: ["ym", "channel_id", "expected", "received", "received_at", "memo"]
});
Object.assign(SPJ, { cm_order: { claim: "null" }, cm_po: { items: "[]" } });
const CM_PO_ST = ["draft", "sent", "confirmed", "changed", "received", "cancel"];
// 재고가 움직일 때마다 남기는 기록 (여러 건은 한 문장으로)
const cmLogRows = (rows, by) => rows.filter(r => r.product_id && r.delta).map(r => ({ id: bulkId("sk"), product_id: r.product_id, delta: r.delta, reason: clip(r.reason, 40), ref: clip(r.ref, 60), at: iso(), by_name: clip(by, 40) }));
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
  const [ship, inq, low, rev, ch, po, cl] = await db.batch([
    db.prepare("SELECT status, COUNT(*) AS n FROM cm_order WHERE ws=?1 AND status IN ('new','packed') GROUP BY status").bind(me.ws),
    db.prepare("SELECT id, customer, text, due, order_no FROM cm_inquiry WHERE ws=?1 AND status='open' ORDER BY due LIMIT 50").bind(me.ws),
    db.prepare("SELECT id, name, stock, safety FROM cm_product WHERE ws=?1 AND active=1 AND stock<=safety ORDER BY stock LIMIT 50").bind(me.ws),
    db.prepare("SELECT channel_id, SUM(amount) AS rev, COUNT(*) AS n FROM cm_order WHERE ws=?1 AND order_date>=?2 AND status NOT IN ('cancel','return') GROUP BY channel_id").bind(me.ws, ym + "-01"),
    db.prepare("SELECT id, name FROM cm_channel WHERE ws=?1").bind(me.ws),
    db.prepare("SELECT no, status, expected, total FROM cm_po WHERE ws=?1 AND status IN ('sent','confirmed','changed') ORDER BY created_at DESC LIMIT 30").bind(me.ws),
    db.prepare("SELECT order_no, product_name, json_extract(claim,'$.type') AS t, json_extract(claim,'$.status') AS s FROM cm_order WHERE ws=?1 AND claim IS NOT NULL AND json_extract(claim,'$.status')<>'done' LIMIT 30").bind(me.ws)
  ]);
  const C = new Map(((ch && ch.results) || []).map(c => [c.id, c.name]));
  const st = {}; for (const r of (ship && ship.results) || []) st[r.status] = Number(r.n);
  return {
    toShip: (st.new || 0) + (st.packed || 0), byStatus: st,
    inquiriesOpen: ((inq && inq.results) || []).map(i => ({ id: i.id, customer: i.customer || "", text: clip(i.text, 200), due: i.due || "", orderNo: i.order_no || "" })),
    lowStock: ((low && low.results) || []).map(p => ({ id: p.id, name: p.name, stock: p.stock, safety: p.safety })),
    purchaseOrdersOpen: ((po && po.results) || []).map(x => ({ no: x.no, status: x.status, expected: x.expected || "", total: x.total })),
    claimsOpen: ((cl && cl.results) || []).map(x => ({ orderNo: x.order_no, product: x.product_name, type: x.t, status: x.s })),
    monthRevenue: { ym, byChannel: ((rev && rev.results) || []).map(r => ({ channel: C.get(r.channel_id) || "미지정", revenue: Number(r.rev), orders: Number(r.n) })), total: ((rev && rev.results) || []).reduce((s, r) => s + Number(r.rev), 0) }
  };
}
const cmWorkerOrder = r => {   // 발송이 끝난 주문은 수령인 이름을 가리고 연락처·주소를 보내지 않습니다
  const open = r.status === "new" || r.status === "packed", nm = String(r.receiver || "");
  return { id: r.id, channel_id: r.channel_id, order_no: r.order_no, order_date: r.order_date, product_id: r.product_id, product_name: r.product_name, option: r.option, qty: r.qty, status: r.status, receiver: open ? nm : (nm ? nm.slice(0, 1) + "*".repeat(Math.min(2, Math.max(1, nm.length - 1))) : ""), phone: open ? r.phone : "", address: open ? r.address : "", tracking: r.tracking, carrier: r.carrier, memo: r.memo, shipped_at: r.shipped_at };
};
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
      db.prepare(spSel("cm_cost", "ws=?1 AND ym>=?2 AND ym<=?3")).bind(me.ws, addDaysS(from, -32).slice(0, 7), to.slice(0, 7)),
      db.prepare(spSel("cm_supplier", "ws=?1", "ORDER BY name")).bind(me.ws),
      db.prepare(spSel("cm_po", "ws=?1 AND (status NOT IN ('received','cancel') OR created_at>=?2)", "ORDER BY created_at DESC LIMIT 300")).bind(me.ws, new Date(Date.now() - 180 * 864e5).toISOString()),
      db.prepare(spSel("cm_settle", "ws=?1 AND ym>=?2 AND ym<=?3")).bind(me.ws, addDaysS(from, -62).slice(0, 7), to.slice(0, 7)),
      db.prepare(spSel("cm_order", "ws=?1 AND claim IS NOT NULL AND status NOT IN ('new','packed') AND (json_extract(claim,'$.status')<>'done' OR updated_at>=?2) AND NOT (order_date>=?3 AND order_date<=?4)", "LIMIT 300")).bind(me.ws, new Date(Date.now() - 60 * 864e5).toISOString(), from, to)
    );
    const rs = await db.batch(q);
    const set = {}; for (const r of (rs[0] && rs[0].results) || []) set[r.k] = parse(r.v);
    const head = { ok: true, v: me.spv + (seeded ? 1 : 0), from, to, today, role: mgr ? "mgr" : me.role, settings: cmNorm(set.settings) };
    if (mgr) { const extra = rawArr(rs[9]), ord = rawArr(rs[3]); return rawJson(head, ',"channels":' + rawArr(rs[1]) + ',"products":' + rawArr(rs[2]) + ',"orders":' + (extra === "[]" ? ord : ord.slice(0, -1) + (ord === "[]" ? "" : ",") + extra.slice(1)) + ',"inquiries":' + rawArr(rs[4]) + ',"costs":' + rawArr(rs[5]) + ',"suppliers":' + rawArr(rs[6]) + ',"pos":' + rawArr(rs[7]) + ',"settles":' + rawArr(rs[8])); }
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
    const ref = ("order_no" in o ? o.order_no : ex && ex.order_no) || "", logs = [];
    const stockAdj = (pid, n, why) => { if (pid && n) { stmts.push(db.prepare("UPDATE cm_product SET stock=stock-?3, updated_at=?4 WHERE ws=?1 AND id=?2").bind(me.ws, pid, n, now)); logs.push({ product_id: pid, delta: -n, reason: why, ref }); } };
    if (o.status && !was && will) o.shipped_at = now;
    if (!was && will) stockAdj(pidNew, qNew, "발송");                       // 발송하면 재고 차감
    else if (was && !will) stockAdj(pidOld, -qOld, "발송 취소·반품");       // 발송을 되돌리거나 취소·반품이면 복구
    else if (was && will) { if (pidOld !== pidNew) { stockAdj(pidOld, -qOld, "상품 변경"); stockAdj(pidNew, qNew, "상품 변경"); } else stockAdj(pidOld, qNew - qOld, "수량 변경"); }   // 발송된 채 상품·수량이 바뀌면 그 차이만
    stmts.push(...spBulk(db, "cm_stock", me.ws, cmLogRows(logs, me.name)));
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
    const prods = (await db.prepare("SELECT id, name, option FROM cm_product WHERE ws=?1").bind(me.ws).all()).results || [];
    const byFull = new Map(prods.filter(p => p.option).map(p => [normNm(p.name) + "|" + normNm(p.option), p.id]));
    const byName = new Map(prods.filter(p => !p.option).map(p => [normNm(p.name), p.id]));
    for (const r of rows) if (!r.product_id && r.product_name) { const k = normNm(r.product_name); r.product_id = byFull.get(k + "|" + normNm(r.option)) || byName.get(k) || null; }
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
    if ("option" in b) o.option = clip(b.option, 120);
    if ("supplier_id" in b) o.supplier_id = clip(b.supplier_id, 60) || null;
    for (const k of ["price", "cost", "stock", "safety"]) if (k in b && !(k === "stock" && ex)) o[k] = Math.max(k === "stock" ? -100000 : 0, intOr(b[k], 0));
    if ("active" in b) o.active = b.active ? 1 : 0;
    if ("memo" in b) o.memo = clip(b.memo, 500);
    o.updated_at = now;
    if (ex) { const { v } = await spRun(db, me, [db.prepare(`UPDATE cm_product SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, ex.id, ...Object.values(o))]); return json({ ok: true, v, product: await spOne(db, "cm_product", me.ws, ex.id) }); }
    const row = Object.assign({ id: uid("p"), sku: "", price: 0, cost: 0, stock: 0, safety: 0, active: 1, memo: "", created_at: now, option: "", supplier_id: null }, o);
    const { v } = await spRun(db, me, spBulk(db, "cm_product", me.ws, [row]).concat(spBulk(db, "cm_stock", me.ws, cmLogRows([{ product_id: row.id, delta: row.stock, reason: "처음 재고" }], me.name))));
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
    const { v } = await spRun(db, me, [db.prepare("UPDATE cm_product SET stock=?3, updated_at=?4 WHERE ws=?1 AND id=?2").bind(me.ws, id, stock, iso())].concat(spBulk(db, "cm_stock", me.ws, cmLogRows([{ product_id: id, delta: stock - ex.stock, reason: clip(b.reason, 40) || "실사 조정", ref: "" }], me.name))));
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
  /* 송장 일괄 처리 — 주문번호(또는 id)와 송장번호 목록으로 한 번에 발송 처리 */
  async "ship/bulk"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 3000).map(r => ({ id: clip(r && r.id, 60), no: clip(r && r.order_no, 60), carrier: clip(r && r.carrier, 30), tracking: clip(r && r.tracking, 40) })).filter(r => (r.id || r.no) && r.tracking);
    if (!rows.length) return fail("empty");
    const open = rowsOf(await db.prepare(spSel("cm_order", "ws=?1 AND status IN ('new','packed')")).bind(me.ws).all());
    const byId = new Map(open.map(o => [o.id, o])), byNo = new Map();
    for (const o of open) if (o.order_no) { if (!byNo.has(o.order_no)) byNo.set(o.order_no, []); byNo.get(o.order_no).push(o); }
    const now = iso(), upd = [], seen = new Set(), unmatched = [], stock = new Map(), logs = [];
    for (const r of rows) {
      const list = r.id && byId.has(r.id) ? [byId.get(r.id)] : (byNo.get(r.no) || []);
      if (!list.length) { unmatched.push(r.no || r.id); continue; }
      for (const o of list) {
        if (seen.has(o.id)) continue; seen.add(o.id);
        upd.push({ id: o.id, t: r.tracking, c: r.carrier || o.carrier || clip(b.carrier, 30) || "" });
        if (o.product_id && o.qty) { stock.set(o.product_id, (stock.get(o.product_id) || 0) + o.qty); logs.push({ product_id: o.product_id, delta: -o.qty, reason: "발송", ref: o.order_no }); }
      }
    }
    if (!upd.length) return json({ ok: true, v: null, shipped: 0, unmatched: unmatched.slice(0, 50) });
    const stmts = [db.prepare("UPDATE cm_order SET status='shipped', tracking=(SELECT json_extract(value,'$.t') FROM json_each(?2) WHERE json_extract(value,'$.id')=cm_order.id), carrier=(SELECT json_extract(value,'$.c') FROM json_each(?2) WHERE json_extract(value,'$.id')=cm_order.id), shipped_at=?3, updated_at=?3 WHERE ws=?1 AND status IN ('new','packed') AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?2))").bind(me.ws, JSON.stringify(upd), now)];
    if (stock.size) {
      const arr = JSON.stringify([...stock.entries()].map(([p, q]) => ({ p, q })));
      stmts.push(db.prepare("UPDATE cm_product SET stock=stock-(SELECT json_extract(value,'$.q') FROM json_each(?2) WHERE json_extract(value,'$.p')=cm_product.id), updated_at=?3 WHERE ws=?1 AND id IN (SELECT json_extract(value,'$.p') FROM json_each(?2))").bind(me.ws, arr, now));
      stmts.push(...spBulk(db, "cm_stock", me.ws, cmLogRows(logs, me.name)));
    }
    const { v } = await spRun(db, me, stmts);
    return json({ ok: true, v, shipped: upd.length, unmatched: unmatched.slice(0, 50) });
  },
  /* 반품·교환 — 접수 → 회수 → 완료. 완료할 때 재입고 여부에 따라 재고를 되돌리고, 교환은 재발송 주문을 만듭니다 */
  async "order/claim"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const ex = await spOne(db, "cm_order", me.ws, clip(b.id, 60));
    if (!ex) return fail("not-found", 404);
    const prev = ex.claim && typeof ex.claim === "object" ? ex.claim : null, now = iso();
    if (b.clear) {
      if (prev && prev.status === "done") return fail("bad-state", 409);
      const { v } = await spRun(db, me, [db.prepare("UPDATE cm_order SET claim=NULL, updated_at=?3 WHERE ws=?1 AND id=?2").bind(me.ws, ex.id, now)]);
      return json({ ok: true, v, order: await spOne(db, "cm_order", me.ws, ex.id) });
    }
    if (prev && prev.status === "done") return fail("bad-state", 409);
    const type = b.type === "exchange" ? "exchange" : "return", st = ["requested", "collected", "done"].includes(b.status) ? b.status : "requested";
    const claim = { type, status: st, reason: clip(b.reason, 300), refund: type === "return" ? Math.max(0, intOr(b.refund, 0)) : 0, restock: !!b.restock, pickup: clip(b.pickup, 40), at: (prev && prev.at) || now, done_at: st === "done" ? now : null, by: me.name, new_id: null };
    const stmts = [], logs = [];
    if (st === "done") {
      const shipped = CM_SHIPPED.has(ex.status);
      if (claim.restock && ex.product_id && ex.qty && shipped) { stmts.push(db.prepare("UPDATE cm_product SET stock=stock+?3, updated_at=?4 WHERE ws=?1 AND id=?2").bind(me.ws, ex.product_id, ex.qty, now)); logs.push({ product_id: ex.product_id, delta: ex.qty, reason: type === "return" ? "반품 입고" : "교환 회수 입고", ref: ex.order_no }); }
      if (type === "return") stmts.push(db.prepare("UPDATE cm_order SET status='return' WHERE ws=?1 AND id=?2").bind(me.ws, ex.id));
      else {
        const nid = uid("o"); claim.new_id = nid;
        stmts.push(...spBulk(db, "cm_order", me.ws, [Object.assign({}, ex, { id: nid, amount: 0, ship_fee: 0, status: "new", tracking: "", carrier: "", memo: clip(`교환 재발송 · 원주문 ${ex.order_no || ""}${claim.reason ? " · " + claim.reason : ""}`, 500), settle_date: null, settle_amt: null, source: "exchange", created_at: now, updated_at: now, shipped_at: null, claim: null })]));
      }
    }
    stmts.unshift(db.prepare("UPDATE cm_order SET claim=?3, updated_at=?4 WHERE ws=?1 AND id=?2").bind(me.ws, ex.id, JSON.stringify(claim), now));
    stmts.push(...spBulk(db, "cm_stock", me.ws, cmLogRows(logs, me.name)));
    const { v } = await spRun(db, me, stmts);
    return json({ ok: true, v, order: await spOne(db, "cm_order", me.ws, ex.id), created: claim.new_id ? await spOne(db, "cm_order", me.ws, claim.new_id) : null });
  },
  async "stock/log"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const rs = rowsOf(await db.prepare(spSel("cm_stock", "ws=?1 AND product_id=?2", "ORDER BY at DESC LIMIT 100")).bind(me.ws, clip(b.id, 60)).all());
    return json({ ok: true, items: rs });
  },
  /* 공급처 · 발주 · 입고 */
  async "supplier/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), ex = id ? await spOne(db, "cm_supplier", me.ws, id) : null;
    if (id && !ex) return fail("not-found", 404);
    const o = {};
    if ("name" in b || !ex) { o.name = clip(b.name, 80); if (!o.name) return fail("bad-request"); }
    for (const [k, n] of [["contact", 40], ["phone", 40], ["email", 80], ["memo", 500]]) if (k in b) o[k] = clip(b[k], n);
    if (ex) { const { v } = await spRun(db, me, [db.prepare(`UPDATE cm_supplier SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]); return json({ ok: true, v, supplier: await spOne(db, "cm_supplier", me.ws, id) }); }
    const row = Object.assign({ id: uid("sp"), contact: "", phone: "", email: "", memo: "", created_at: iso() }, o);
    const { v } = await spRun(db, me, spBulk(db, "cm_supplier", me.ws, [row]));
    return json({ ok: true, v, supplier: row });
  },
  async "supplier/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60);
    if (await db.prepare("SELECT 1 AS x FROM cm_po WHERE ws=?1 AND supplier_id=?2 AND status NOT IN ('received','cancel') LIMIT 1").bind(me.ws, id).first()) return fail("in-use", 409);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM cm_supplier WHERE ws=?1 AND id=?2").bind(me.ws, id), db.prepare("UPDATE cm_product SET supplier_id=NULL WHERE ws=?1 AND supplier_id=?2").bind(me.ws, id)]);
    return json({ ok: true, v });
  },
  async "po/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), ex = id ? await spOne(db, "cm_po", me.ws, id) : null, now = iso();
    if (id && !ex) return fail("not-found", 404);
    if (ex && !["draft", "changed"].includes(ex.status)) return fail("locked", 409);   // 보낸 발주서는 변경 요청을 받았을 때만 고칩니다
    const o = { updated_at: now };
    if ("supplier_id" in b) { o.supplier_id = clip(b.supplier_id, 60) || null; if (o.supplier_id && !await spOne(db, "cm_supplier", me.ws, o.supplier_id)) return fail("not-found", 404); }
    if ("items" in b) {
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 100).map(x => ({ product_id: clip(x && x.product_id, 60) || null, name: clip(x && x.name, 120), option: clip(x && x.option, 120), qty: clampInt(x && x.qty, 0, 1000000, 0), cost: Math.max(0, intOr(x && x.cost, 0)) })).filter(x => x.name && x.qty > 0);
      if (!items.length) return fail("empty");
      o.items = JSON.stringify(items); o.total = items.reduce((a, x) => a + x.qty * x.cost, 0);
    }
    if ("expected" in b) o.expected = dOk(b.expected) || null;
    if ("memo" in b) o.memo = clip(b.memo, 1000);
    if (ex) { const { v } = await spRun(db, me, [db.prepare(`UPDATE cm_po SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]); return json({ ok: true, v, po: await spOne(db, "cm_po", me.ws, id) }); }
    if (!o.items) return fail("empty");
    const n = Number((await db.prepare("SELECT COUNT(*) AS n FROM cm_po WHERE ws=?1 AND substr(created_at,1,10)=?2").bind(me.ws, now.slice(0, 10)).first() || {}).n) || 0;
    const row = Object.assign({ id: uid("po"), no: `PO-${kstToday().slice(2).replace(/-/g, "")}-${String(n + 1).padStart(2, "0")}`, supplier_id: null, status: "draft", ordered_at: null, expected: null, received_at: null, memo: "", reply_note: "", replied_by: "", replied_at: null, created_at: now }, o);
    const { v } = await spRun(db, me, spBulk(db, "cm_po", me.ws, [row]));
    return json({ ok: true, v, po: await spOne(db, "cm_po", me.ws, row.id) });
  },
  async "po/status"(db, me, b) {   // 보냄 표시 · 취소 · 다시 작성
    if (!isMgr(me)) return fail("forbidden", 403);
    const ex = await spOne(db, "cm_po", me.ws, clip(b.id, 60)); if (!ex) return fail("not-found", 404);
    const st = ["sent", "cancel", "draft", "confirmed"].includes(b.status) ? b.status : "";
    if (!st || ex.status === "received") return fail("bad-state", 409);
    const now = iso();
    const { v } = await spRun(db, me, [db.prepare("UPDATE cm_po SET status=?3, ordered_at=CASE WHEN ?3='sent' AND ordered_at IS NULL THEN ?4 ELSE ordered_at END, updated_at=?4 WHERE ws=?1 AND id=?2").bind(me.ws, ex.id, st, now)]);
    return json({ ok: true, v, po: await spOne(db, "cm_po", me.ws, ex.id) });
  },
  async "po/receive"(db, me, b) {   // 입고 — 연결된 상품의 재고를 늘립니다 (받은 수량을 따로 적으면 그 수량으로)
    if (!isMgr(me)) return fail("forbidden", 403);
    const ex = await spOne(db, "cm_po", me.ws, clip(b.id, 60)); if (!ex) return fail("not-found", 404);
    if (ex.status === "received" || ex.status === "cancel") return fail("bad-state", 409);
    const got = new Map((Array.isArray(b.qty) ? b.qty : []).map((q, i) => [i, clampInt(q, 0, 1000000, 0)]));
    const items = (ex.items || []).map((x, i) => Object.assign({}, x, { got: got.has(i) ? got.get(i) : x.qty }));
    const now = iso(), stock = new Map(), logs = [];
    for (const x of items) if (x.product_id && x.got) { stock.set(x.product_id, (stock.get(x.product_id) || 0) + x.got); logs.push({ product_id: x.product_id, delta: x.got, reason: "입고", ref: ex.no }); }
    const stmts = [db.prepare("UPDATE cm_po SET status='received', received_at=?3, items=?4, updated_at=?3 WHERE ws=?1 AND id=?2").bind(me.ws, ex.id, now, JSON.stringify(items))];
    if (stock.size) {
      stmts.push(db.prepare("UPDATE cm_product SET stock=stock+(SELECT json_extract(value,'$.q') FROM json_each(?2) WHERE json_extract(value,'$.p')=cm_product.id), updated_at=?3 WHERE ws=?1 AND id IN (SELECT json_extract(value,'$.p') FROM json_each(?2))").bind(me.ws, JSON.stringify([...stock.entries()].map(([p, q]) => ({ p, q }))), now));
      stmts.push(...spBulk(db, "cm_stock", me.ws, cmLogRows(logs, me.name)));
    }
    const { v } = await spRun(db, me, stmts);
    return json({ ok: true, v, po: await spOne(db, "cm_po", me.ws, ex.id), added: [...stock.values()].reduce((a, q) => a + q, 0) });
  },
  async "po/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const ex = await spOne(db, "cm_po", me.ws, clip(b.id, 60)); if (!ex) return fail("not-found", 404);
    if (!["draft", "cancel"].includes(ex.status)) return fail("bad-state", 409);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM cm_po WHERE ws=?1 AND id=?2").bind(me.ws, ex.id), db.prepare("UPDATE links SET expires_at=?3 WHERE ws=?1 AND kind='po' AND target=?2").bind(me.ws, ex.id, new Date(Date.now() - 1000).toISOString())]);
    return json({ ok: true, v });
  },
  /* 정산 대사 — 채널별 정산 예정액과 실제 입금액 */
  async "settle/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const ym = ymOk(b.ym), ch = clip(b.channel_id, 60);
    if (!ym || !ch) return fail("bad-request");
    const num = v => v === "" || v == null ? null : intOr(String(v).replace(/[^\d-]/g, ""), 0);
    const row = { ym, channel_id: ch, expected: num(b.expected), received: num(b.received), received_at: num(b.received) == null ? null : iso(), memo: clip(b.memo, 300) };
    const { v } = await spRun(db, me, spBulk(db, "cm_settle", me.ws, [row], "ON CONFLICT(ws,ym,channel_id) DO UPDATE SET expected=excluded.expected, received=excluded.received, received_at=excluded.received_at, memo=excluded.memo"));
    return json({ ok: true, v, settle: row });
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
  const SELLER = ["market", "own", "b2b", "group"];
  return { ship_fee_default: Math.max(0, intOr(s.ship_fee_default, 0)), maps, memo: clip(s.memo, 1000), seller: SELLER.includes(s.seller) ? s.seller : "", carrier: clip(s.carrier, 30),
    ans_tpl: Array.isArray(s.ans_tpl) ? s.ans_tpl.map(x => clip(x, 400)).filter(Boolean).slice(0, 20) : [] };
}

/* ═════════ AI 접속 · 제안 · 확인 링크 ═════════
   · 개인 API 토큰(Bearer mw_…)으로 외부 AI가 읽습니다. 토큰은 만든 사람의 역할·범위를 그대로 따릅니다.
   · 쓰기 토큰은 바로 고치지 않고 "제안"(ent kind=prop)을 올리며, 관리자·직원이 홈에서 승인하면 반영됩니다.
   · 확인 링크(/#/link/<token>)는 계정 없는 상대방이 견적 승인·납품 확인·청구 확인만 할 수 있는 공개 페이지입니다. */
const TASK_ST = ["대기", "진행중", "검토", "완료"];
const AI_KINDS = ["create-task", "update-status", "add-note", "create-contact", "create-job", "mk-action", "mk-post", "cr-idea", "cr-deal"];
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
  async marketing(db, me) { if (!aiMod(me, "marketing")) return { error: "module-off" }; return await mkAiSummary(db, me); },
  async creator(db, me) { if (!aiMod(me, "creator")) return { error: "module-off" }; return await crAiSummary(db, me); },
  async propose(db, me, p) {
    if (me.ai.scope !== "write") return { error: "forbidden", hint: "읽기 토큰입니다. 쓰기 토큰으로 제안할 수 있습니다." };
    if (me.role !== "admin" && me.role !== "staff") return { error: "forbidden" };
    const kind = String(p.kind || "");
    if (!AI_KINDS.includes(kind)) return { error: "bad-request", kinds: AI_KINDS };
    const payload = p.payload && typeof p.payload === "object" ? p.payload : {};
    if (kind === "create-job" && !hasMod(me, "outsourcing")) return { error: "module-off" };
    if (kind.startsWith("mk-") && !hasMod(me, "marketing")) return { error: "module-off" };
    if (kind.startsWith("cr-") && !hasMod(me, "creator")) return { error: "module-off" };
    if (kind.startsWith("ed-") && !hasMod(me, "edu")) return { error: "module-off" };
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
    await notify(db, me.ws, [me.id], { type: "ai", title: "클로드가 제안을 올렸습니다", body: "홈의 '오늘 결정할 것'에서 확인하고 승인하세요.", url: "#/dashboard", tag: "ai-prop", once: 15 });   // 여러 건을 잇달아 올려도 15분에 한 번만 알립니다
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
  } else if (kind === "mk-action") {   // 마이마케팅 실행안 — 예산·입찰·소재·타겟을 어떻게 바꿀지
    out.title = clip(p.title, 120); if (!out.title) return { error: "bad-request", hint: "title이 필요합니다." };
    out.detail = clip(p.detail, 2000); out.campaign = clip(p.campaign, 80); out.kind = clip(p.kind, 20) || "etc"; out.from = clip(p.from, 40); out.to = clip(p.to, 40);
  } else if (kind === "mk-post") {   // 마이마케팅 콘텐츠 초안
    out.title = clip(p.title, 120); if (!out.title) return { error: "bad-request", hint: "title이 필요합니다." };
    out.body = clip(p.body, 6000); out.channel = clip(p.channel, 60); out.date = dOk(p.date); out.format = clip(p.format, 20); out.tags = clip(p.tags, 300);
  } else if (kind === "cr-idea") {   // 마이크리에이터 콘텐츠 아이디어
    out.title = clip(p.title, 120); if (!out.title) return { error: "bad-request", hint: "title이 필요합니다." };
    out.channel = clip(p.channel, 60); out.format = clip(p.format, 20); out.date = dOk(p.date); out.memo = clip(p.memo, 3000);
  } else if (kind === "cr-deal") {   // 마이크리에이터 협찬 건
    out.brand = clip(p.brand, 60); if (!out.brand) return { error: "bad-request", hint: "brand가 필요합니다." };
    out.title = clip(p.title, 100); out.type = clip(p.type, 20); out.channel = clip(p.channel, 60); out.amount = Math.max(0, intOr(p.amount, 0)); out.due = dOk(p.due); out.memo = clip(p.memo, 2000);
  } else if (kind === "ed-report") {   // 마이에듀 월간 학습 리포트 초안
    out.student = clip(p.student, 60); out.body = clip(p.body, 4000); if (!out.student || !out.body) return { error: "bad-request", hint: "student와 body가 필요합니다." };
    out.month = ymOk(p.month); out.title = clip(p.title, 80);
  } else if (kind === "ed-lead") {   // 마이에듀 상담 문의
    out.name = clip(p.name, 30); if (!out.name) return { error: "bad-request", hint: "name이 필요합니다." };
    out.phone = clip(p.phone, 20); out.grade = clip(p.grade, 20); out.subject = clip(p.subject, 40); out.src = clip(p.src, 20); out.next = dOk(p.next); out.memo = clip(p.memo, 2000);
  }
  return { payload: out };
}
/* D1은 LIKE 패턴을 50바이트까지만 받습니다(한글은 한 글자에 3바이트, developers.cloudflare.com/d1/platform/limits).
   넘으면 앞부분으로 찾고, 찾은 줄은 likeHas로 전체 이름이 들어 있는지 다시 확인합니다 */
function likeArg(s) {
  let b = 2, out = "";
  for (const ch of String(s == null ? "" : s)) { const c = ch.codePointAt(0), n = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; if (b + n > 50) break; b += n; out += ch; }
  return "%" + out + "%";
}
const likeHas = (name, key) => String(name == null ? "" : name).toLowerCase().includes(String(key == null ? "" : key).toLowerCase());
async function findEnt(db, ws, kind, key) {   // id 또는 이름으로 찾기
  if (!key) return null;
  let r = await db.prepare("SELECT id, data FROM ent WHERE ws=?1 AND kind=?2 AND id=?3 AND deleted=0").bind(ws, kind, key).first();
  if (r) return { id: r.id, d: parse(r.data) || {} };
  const f = kind === "task" ? "title" : "name";
  const rs = (await db.prepare(`SELECT id, data FROM ent WHERE ws=?1 AND kind=?2 AND deleted=0 AND json_extract(data,'$.${f}') LIKE ?3 LIMIT 20`).bind(ws, kind, likeArg(key)).all()).results || [];
  const nk = normNm(key);
  const hit = rs.map(x => ({ id: x.id, d: parse(x.data) || {} })).filter(x => likeHas(x.d[f], key)).sort((a, b) => (normNm(a.d[f]) === nk ? 0 : 1) - (normNm(b.d[f]) === nk ? 0 : 1))[0];
  return hit || null;
}
/* 조사 고르기 — "모노가구을(를)" → "모노가구를", "‘프로’(으)로" → "‘프로’로". 바로 앞 글자의 받침을 보고 고릅니다 */
const JOSA = { "을(를)": ["을", "를"], "를(을)": ["을", "를"], "이(가)": ["이", "가"], "가(이)": ["이", "가"], "은(는)": ["은", "는"], "는(은)": ["은", "는"], "와(과)": ["과", "와"], "과(와)": ["과", "와"], "(으)로": ["으로", "로"], "(이)라": ["이라", "라"], "(이)나": ["이나", "나"] };
const JOSA_RE = /([가-힣A-Za-z0-9])([^가-힣A-Za-z0-9\s]{0,3}|\s+)(을\(를\)|를\(을\)|이\(가\)|가\(이\)|은\(는\)|는\(은\)|와\(과\)|과\(와\)|\(으\)로|\(이\)라|\(이\)나)/g;
function josa(text) {
  return String(text == null ? "" : text).replace(JOSA_RE, (m, ch, mid, j) => {
    const c = ch.charCodeAt(0);
    let bat;   // 받침: 0 없음 · 8 ㄹ · 그 밖은 있음
    if (c >= 0xAC00 && c <= 0xD7A3) bat = (c - 0xAC00) % 28;
    else if (c >= 48 && c <= 57) bat = [21, 8, 0, 16, 0, 0, 1, 8, 8, 0][c - 48];   // 영 일 이 삼 사 오 육 칠 팔 구
    else bat = "LMNRlmnr".includes(ch) ? ("LlRr".includes(ch) ? 8 : 4) : 0;           // 엘 엠 엔 알
    const pair = JOSA[j], pick = j === "(으)로" ? (bat === 0 || bat === 8 ? pair[1] : pair[0]) : (bat ? pair[0] : pair[1]);
    return ch + (/^\s+$/.test(mid) ? "" : mid) + pick;
  });
}
const actRow = (me, text) => { const now = new Date(); return { kind: "act", id: uid("a"), own: me.id, data: { id: uid("a"), ts: (now.getMonth() + 1) + "/" + now.getDate() + " " + String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0"), who: "AI · " + me.name, by: me.id, createdAt: now.toISOString(), text: josa(text) } }; };
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
  if (prop.kind === "mk-action" || prop.kind === "mk-post") {
    if (!hasMod(me, "marketing")) return { error: "module-off" };
    return await mkPropItems(db, me, prop);
  }
  if (prop.kind === "cr-idea" || prop.kind === "cr-deal") {
    if (!hasMod(me, "creator")) return { error: "module-off" };
    return await crPropItems(db, me, prop);
  }
  if (prop.kind === "ed-report" || prop.kind === "ed-lead") {
    if (!hasMod(me, "edu")) return { error: "module-off" };
    return await edPropItems(db, me, prop);
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
/* ═══════════ 마이택스 — 사업자별 손익·신고 자료·증빙·KPI·세금 달력·지원사업 ═══════════
   수입·지출 기록 자체는 기본 기능의 '돈'(동기화 데이터)에 있고, 여기에는 사업자·증빙(세금계산서·현금영수증·카드)·KPI·지원사업만 둡니다.
   세금 계산은 참고용 추정이며 화면에서 그렇게 안내합니다. 신고 자체는 홈택스나 세무사를 통해 합니다. */
const TX_DDL = [
  "CREATE TABLE IF NOT EXISTS tx_biz(ws TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'indiv', vat TEXT NOT NULL DEFAULT 'general', biz_no TEXT, industry TEXT, open_date TEXT, region TEXT, young INTEGER NOT NULL DEFAULT 0, links TEXT, incl_vat INTEGER NOT NULL DEFAULT 1, card_credit INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, memo TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE TABLE IF NOT EXISTS tx_doc(ws TEXT NOT NULL, id TEXT NOT NULL, biz_id TEXT, dir TEXT NOT NULL, kind TEXT NOT NULL, date TEXT NOT NULL, partner TEXT, partner_no TEXT, supply INTEGER NOT NULL DEFAULT 0, vat INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, item TEXT, approve_no TEXT, status TEXT NOT NULL DEFAULT 'done', fin_id TEXT, ref TEXT, source TEXT, memo TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_tx_doc_date ON tx_doc(ws,date)",
  "CREATE INDEX IF NOT EXISTS idx_tx_doc_appr ON tx_doc(ws,approve_no)",
  "CREATE TABLE IF NOT EXISTS tx_kpi(ws TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, metric TEXT NOT NULL, ref TEXT, period TEXT NOT NULL DEFAULT 'month', target REAL, dir TEXT NOT NULL DEFAULT 'up', unit TEXT, biz_id TEXT, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE TABLE IF NOT EXISTS tx_kval(ws TEXT NOT NULL, kpi_id TEXT NOT NULL, period TEXT NOT NULL, value REAL, target REAL, memo TEXT, PRIMARY KEY(ws,kpi_id,period))",
  "CREATE TABLE IF NOT EXISTS tx_grant(ws TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, org TEXT, url TEXT, deadline TEXT, status TEXT NOT NULL DEFAULT 'watch', amount INTEGER, memo TEXT, ext_id TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))"
];
const TX_TABLES = ["tx_biz", "tx_doc", "tx_kpi", "tx_kval", "tx_grant"];
Object.assign(SPC, {
  tx_biz: ["id", "name", "kind", "vat", "biz_no", "industry", "open_date", "region", "young", "links", "incl_vat", "card_credit", "sort", "active", "memo", "created_at", "updated_at"],
  tx_doc: ["id", "biz_id", "dir", "kind", "date", "partner", "partner_no", "supply", "vat", "total", "item", "approve_no", "status", "fin_id", "ref", "source", "memo", "created_at", "updated_at"],
  tx_kpi: ["id", "name", "metric", "ref", "period", "target", "dir", "unit", "biz_id", "sort", "active", "created_at"],
  tx_kval: ["kpi_id", "period", "value", "target", "memo"],
  tx_grant: ["id", "title", "org", "url", "deadline", "status", "amount", "memo", "ext_id", "created_at", "updated_at"]
});
Object.assign(SPJ, { tx_biz: { links: "{}" } });
const TX_DOC_KIND = ["세금계산서", "계산서", "현금영수증", "카드"];
const TX_DOC_ST = ["plan", "done", "cancel"];   // 발행 예정 · 발행·수취 완료 · 취소
const TX_GRANT_ST = ["watch", "prep", "applied", "won", "lost"];
const TX_KPI_METRIC = ["rev", "profit", "margin", "gpm", "exp", "group", "cat", "manual"];
const numOrNull = v => v === "" || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
const bizNo = s => String(s || "").replace(/[^0-9]/g, "").slice(0, 13);
function txBizIn(b) {
  const o = {};
  if ("name" in b) o.name = clip(b.name, 60);
  if ("kind" in b) o.kind = b.kind === "corp" ? "corp" : "indiv";
  if ("vat" in b) o.vat = ["general", "simple", "exempt"].includes(b.vat) ? b.vat : "general";
  if ("biz_no" in b) o.biz_no = bizNo(b.biz_no);
  if ("industry" in b) o.industry = clip(b.industry, 30);
  if ("open_date" in b) o.open_date = dOk(b.open_date) || null;
  if ("region" in b) o.region = b.region === "metro" ? "metro" : "other";   // 수도권과밀억제권역 안 / 밖
  if ("young" in b) o.young = b.young ? 1 : 0;
  if ("incl_vat" in b) o.incl_vat = b.incl_vat ? 1 : 0;
  if ("card_credit" in b) o.card_credit = b.card_credit ? 1 : 0;
  if ("active" in b) o.active = b.active === false || b.active === 0 ? 0 : 1;
  if ("memo" in b) o.memo = clip(b.memo, 500);
  if ("links" in b) {
    const l = b.links && typeof b.links === "object" ? b.links : {};
    const arr = (a, n) => (Array.isArray(a) ? a : []).map(x => clip(x, 60)).filter(Boolean).slice(0, n);
    o.links = JSON.stringify({ brands: arr(l.brands, 40), stores: arr(l.stores, 200), mods: arr(l.mods, 8).filter(x => ["space", "commerce", "outsourcing", "people", "marketing", "creator", "edu"].includes(x)), main: !!l.main });
  }
  return o;
}
function txDocIn(r) {
  const o = {};
  if ("biz_id" in r) o.biz_id = clip(r.biz_id, 60) || null;
  if ("dir" in r) o.dir = r.dir === "buy" ? "buy" : "sale";
  if ("kind" in r) o.kind = TX_DOC_KIND.includes(r.kind) ? r.kind : "세금계산서";
  if ("date" in r) { o.date = dOk(r.date); if (!o.date) delete o.date; }
  if ("partner" in r) o.partner = clip(r.partner, 80);
  if ("partner_no" in r) o.partner_no = bizNo(r.partner_no);
  const money = v => Math.max(-10000000000, Math.min(10000000000, intOr(String(v ?? "").replace(/[^\d.-]/g, ""), 0)));
  if ("supply" in r) o.supply = money(r.supply);
  if ("vat" in r) o.vat = money(r.vat);
  if ("total" in r) o.total = money(r.total);
  if ("item" in r) o.item = clip(r.item, 120);
  if ("approve_no" in r) o.approve_no = clip(String(r.approve_no ?? "").replace(/\s/g, ""), 40) || null;
  if ("status" in r && TX_DOC_ST.includes(r.status)) o.status = r.status;
  if ("fin_id" in r) o.fin_id = clip(r.fin_id, 60) || null;
  if ("ref" in r) o.ref = clip(r.ref, 60) || null;
  if ("memo" in r) o.memo = clip(r.memo, 300);
  if (o.supply !== undefined && o.vat !== undefined && (o.total === undefined || !o.total)) o.total = o.supply + o.vat;
  return o;
}
function txNorm(s) {   // 손익 구조·현금·공제 정보·달력 체크 — 크기만 제한하고 그대로 둡니다
  s = s && typeof s === "object" ? s : {};
  const st = s.struct && typeof s.struct === "object" ? s.struct : {};
  const groups = (Array.isArray(st.groups) ? st.groups : []).slice(0, 30).map(g => ({ id: clip(g && g.id, 30), name: clip(g && g.name, 30), type: ["rev", "cogs", "fee", "opex", "oin", "oout"].includes(g && g.type) ? g.type : "opex" })).filter(g => g.id && g.name);
  const map = {}; if (st.map && typeof st.map === "object") for (const [k, v] of Object.entries(st.map).slice(0, 200)) map[clip(k, 40)] = clip(v, 30);
  const cash = s.cash && typeof s.cash === "object" ? s.cash : {};
  const fixed = (Array.isArray(cash.fixed) ? cash.fixed : []).slice(0, 40).map(f => ({ name: clip(f && f.name, 40), amount: Math.max(0, intOr(f && f.amount, 0)), day: clampInt(f && f.day, 1, 31, 25), dir: f && f.dir === "in" ? "in" : "out" })).filter(f => f.name && f.amount);
  const me = s.me && typeof s.me === "object" ? s.me : {};
  const done = (Array.isArray(s.done) ? s.done : []).map(x => clip(x, 40)).filter(Boolean).slice(-400);
  const nodeduct = (Array.isArray(s.nodeduct) ? s.nodeduct : []).map(x => clip(x, 40)).filter(Boolean).slice(0, 40);
  return {
    struct: { groups, map },
    cash: { open: intOr(cash.open, 0), asof: dOk(cash.asof) || "", fixed },
    me: { deps: clampInt(me.deps, 1, 20, 1), yellow: Math.max(0, intOr(me.yellow, 0)), pension: Math.max(0, intOr(me.pension, 0)), prepaid: Math.max(0, intOr(me.prepaid, 0)), extra: Math.max(0, intOr(me.extra, 0)), book: me.book === "double" ? "double" : me.book === "simple" ? "simple" : "", bizcard: !!me.bizcard, bizacct: !!me.bizacct, cut: clampInt(me.cut, 0, 100, 0), age: clampInt(me.age, 0, 120, 0), half: !!me.half },
    nodeduct, done, set: !!s.set
  };
}
async function txSettings(db, ws) { const m = await modSettings(db, ws, "tx"); return txNorm(m.settings); }
const TAX = {
  async data(db, me, b, req, url, env) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const today = kstToday(), from = dOk(url.searchParams.get("from")) || addDaysS(today, -800);
    const rs = await db.batch([
      db.prepare("SELECT v FROM mod_set WHERE ws=?1 AND mod='tx' AND k='settings'").bind(me.ws),
      db.prepare(spSel("tx_biz", "ws=?1", "ORDER BY sort, created_at")).bind(me.ws),
      db.prepare(spSel("tx_doc", "ws=?1 AND date>=?2", "ORDER BY date DESC LIMIT 20000")).bind(me.ws, from),
      db.prepare(spSel("tx_kpi", "ws=?1", "ORDER BY sort, created_at")).bind(me.ws),
      db.prepare(spSel("tx_kval", "ws=?1")).bind(me.ws),
      db.prepare(spSel("tx_grant", "ws=?1", "ORDER BY COALESCE(deadline,'9999'), created_at")).bind(me.ws),
      // 받을 돈 — 거래의 미입금 청구서
      db.prepare("SELECT json_object('id',v.id,'no',v.no,'net',v.net,'amount',v.amount,'tax',v.tax,'tax_mode',v.tax_mode,'due',v.due_date,'title',j.title,'client',j.client_name,'client_id',j.client_id,'created_at',v.created_at) AS j FROM os_invoice v JOIN os_job j ON j.ws=v.ws AND j.id=v.job_id WHERE v.ws=?1 AND v.status='issued' ORDER BY v.due_date LIMIT 500").bind(me.ws),
      // 세금계산서를 발행해야 하는 청구서 — 부가세 별도 청구 중 아직 증빙 대장에 없는 것
      db.prepare("SELECT json_object('id',v.id,'no',v.no,'amount',v.amount,'tax',v.tax,'net',v.net,'status',v.status,'created_at',v.created_at,'paid_at',v.paid_at,'title',j.title,'client',j.client_name,'client_id',j.client_id) AS j FROM os_invoice v JOIN os_job j ON j.ws=v.ws AND j.id=v.job_id WHERE v.ws=?1 AND v.tax_mode='vat' AND v.status<>'void' AND v.created_at>=?2 AND NOT EXISTS (SELECT 1 FROM tx_doc d WHERE d.ws=v.ws AND d.ref=v.id) ORDER BY v.created_at DESC LIMIT 200").bind(me.ws, addDaysS(today, -200)),
      // 급여에서 나가는 돈 — 마이피플 급여 기록 월별 합계 (원천세·4대보험 납부 예상에 씁니다)
      db.prepare("SELECT substr(period,1,7) AS ym, SUM(gross) AS gross, SUM(net) AS net, SUM(employer) AS employer, SUM(COALESCE((SELECT SUM(json_extract(value,'$.amount')) FROM json_each(deds) WHERE json_extract(value,'$.k') IN ('it','lt','bt','bl','dt','dl')),0)) AS wh, SUM(COALESCE((SELECT SUM(json_extract(value,'$.amount')) FROM json_each(deds) WHERE json_extract(value,'$.k') IN ('np','hi','lc','ei')),0)) AS ins, COUNT(*) AS n FROM pp_pay WHERE ws=?1 AND status<>'draft' AND period>=?2 GROUP BY substr(period,1,7)").bind(me.ws, addDaysS(today, -400).slice(0, 7)),
      db.prepare("SELECT COUNT(*) AS n FROM pp_staff WHERE ws=?1 AND status<>'end'").bind(me.ws)
    ]);
    const s0 = rs[0] && rs[0].results && rs[0].results[0];
    const pay = ((rs[8] && rs[8].results) || []).map(r => ({ ym: r.ym, gross: Number(r.gross) || 0, net: Number(r.net) || 0, employer: Number(r.employer) || 0, wh: Number(r.wh) || 0, ins: Number(r.ins) || 0, n: Number(r.n) || 0 }));
    const staffN = Number(((rs[9] && rs[9].results) || [])[0] && rs[9].results[0].n) || 0;
    return rawJson({ ok: true, v: me.spv, today, from, settings: txNorm(s0 ? parse(s0.v) : null), pay, staffN, keys: { nts: !!(env && env.NTS_API_KEY), bizinfo: !!(env && env.BIZINFO_API_KEY), ht: pbOn(env) } }, ',"biz":' + rawArr(rs[1]) + ',"docs":' + rawArr(rs[2]) + ',"kpis":' + rawArr(rs[3]) + ',"kvals":' + rawArr(rs[4]) + ',"grants":' + rawArr(rs[5]) + ',"recv":' + rawArr(rs[6]) + ',"invNeed":' + rawArr(rs[7]));
  },
  async settings(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const cur = await txSettings(db, me.ws);
    const s = txNorm(Object.assign({}, cur, b && b.set && typeof b.set === "object" ? b.set : {}));
    if (JSON.stringify(s).length > 60000) return fail("too-large", 413);
    const { v } = await spRun(db, me, [db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'tx','settings',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(s))]);
    return json({ ok: true, v, settings: s });
  },
  async "biz/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), o = txBizIn(b || {}), now = iso();
    if (!id) {
      if (!o.name) return fail("bad-request");
      const n = await db.prepare("SELECT COUNT(*) AS n FROM tx_biz WHERE ws=?1").bind(me.ws).first();
      if (Number(n && n.n) >= 30) return fail("limit", 409);
      const row = Object.assign({ id: bulkId("bz"), kind: "indiv", vat: "general", biz_no: "", industry: "", open_date: null, region: "other", young: 0, links: '{"brands":[],"stores":[],"mods":[],"main":false}', incl_vat: 1, card_credit: 0, sort: Number(n && n.n) + 1, active: 1, memo: "", created_at: now, updated_at: now }, o);
      const { v } = await spRun(db, me, spBulk(db, "tx_biz", me.ws, [row]));
      return json({ ok: true, v, biz: await spOne(db, "tx_biz", me.ws, row.id) });
    }
    if (!await spOne(db, "tx_biz", me.ws, id)) return fail("not-found", 404);
    if ("name" in o && !o.name) return fail("bad-request");
    o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE tx_biz SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, biz: await spOne(db, "tx_biz", me.ws, id) });
  },
  async "biz/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM tx_biz WHERE ws=?1 AND id=?2").bind(me.ws, id), db.prepare("UPDATE tx_doc SET biz_id=NULL WHERE ws=?1 AND biz_id=?2").bind(me.ws, id), db.prepare("UPDATE tx_kpi SET biz_id=NULL WHERE ws=?1 AND biz_id=?2").bind(me.ws, id)]);
    return json({ ok: true, v });
  },
  async "doc/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), o = txDocIn(b || {}), now = iso();
    if (!id) {
      if (!o.date) return fail("bad-date");
      const row = Object.assign({ id: bulkId("dc"), biz_id: null, dir: "sale", kind: "세금계산서", partner: "", partner_no: "", supply: 0, vat: 0, total: 0, item: "", approve_no: null, status: "done", fin_id: null, ref: null, source: "direct", memo: "", created_at: now, updated_at: now }, o);
      if (!row.total) row.total = row.supply + row.vat;
      if (row.ref && await db.prepare("SELECT 1 AS x FROM tx_doc WHERE ws=?1 AND ref=?2").bind(me.ws, row.ref).first()) return fail("dup", 409);
      const { v } = await spRun(db, me, spBulk(db, "tx_doc", me.ws, [row]));
      return json({ ok: true, v, doc: await spOne(db, "tx_doc", me.ws, row.id) });
    }
    if (!await spOne(db, "tx_doc", me.ws, id)) return fail("not-found", 404);
    o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE tx_doc SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, doc: await spOne(db, "tx_doc", me.ws, id) });
  },
  async "doc/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(x => clip(x, 60)).filter(Boolean).slice(0, 5000);
    if (!ids.length) return fail("bad-request");
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM tx_doc WHERE ws=?1 AND id IN (SELECT value FROM json_each(?2))").bind(me.ws, JSON.stringify(ids))]);
    return json({ ok: true, v, deleted: ids.length });
  },
  // 홈택스에서 내려받은 목록(세금계산서·현금영수증·카드) — 승인번호가 같으면 건너뜁니다
  async "doc/import"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const r = await txDocAdd(db, me, Array.isArray(b.rows) ? b.rows : [], b.biz_id, "hometax");
    if (r.empty) return fail("empty");
    return json({ ok: true, v: r.v, added: r.added, skipped: r.skipped });
  },
  async "doc/link"(db, me, b) {   // 증빙 ↔ 돈 기록 연결 (여러 건을 한 번에)
    if (!isMgr(me)) return fail("forbidden", 403);
    const pairs = (Array.isArray(b.pairs) ? b.pairs : []).slice(0, 5000).map(p => ({ id: clip(p && p.id, 60), fin: clip(p && p.fin_id, 60) || null })).filter(p => p.id);
    if (!pairs.length) return fail("bad-request");
    const { v } = await spRun(db, me, [db.prepare("UPDATE tx_doc SET fin_id=(SELECT json_extract(value,'$.fin') FROM json_each(?2) WHERE json_extract(value,'$.id')=tx_doc.id), updated_at=?3 WHERE ws=?1 AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?2))").bind(me.ws, JSON.stringify(pairs), iso())]);
    return json({ ok: true, v, linked: pairs.length });
  },
  async "kpi/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), o = {};
    if ("name" in b) o.name = clip(b.name, 40);
    if ("metric" in b) o.metric = TX_KPI_METRIC.includes(b.metric) ? b.metric : "rev";
    if ("ref" in b) o.ref = clip(b.ref, 40) || null;
    if ("period" in b) o.period = ["month", "quarter", "year"].includes(b.period) ? b.period : "month";
    if ("target" in b) o.target = numOrNull(b.target);
    if ("dir" in b) o.dir = b.dir === "down" ? "down" : "up";
    if ("unit" in b) o.unit = clip(b.unit, 10);
    if ("biz_id" in b) o.biz_id = clip(b.biz_id, 60) || null;
    if ("active" in b) o.active = b.active === false || b.active === 0 ? 0 : 1;
    if (!id) {
      if (!o.name) return fail("bad-request");
      const n = await db.prepare("SELECT COUNT(*) AS n FROM tx_kpi WHERE ws=?1").bind(me.ws).first();
      if (Number(n && n.n) >= 40) return fail("limit", 409);
      const row = Object.assign({ id: bulkId("kp"), metric: "rev", ref: null, period: "month", target: null, dir: "up", unit: "", biz_id: null, sort: Number(n && n.n) + 1, active: 1, created_at: iso() }, o);
      const { v } = await spRun(db, me, spBulk(db, "tx_kpi", me.ws, [row]));
      return json({ ok: true, v, kpi: await spOne(db, "tx_kpi", me.ws, row.id) });
    }
    if (!await spOne(db, "tx_kpi", me.ws, id)) return fail("not-found", 404);
    if (!Object.keys(o).length) return fail("bad-request");
    const { v } = await spRun(db, me, [db.prepare(`UPDATE tx_kpi SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, kpi: await spOne(db, "tx_kpi", me.ws, id) });
  },
  async "kpi/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM tx_kpi WHERE ws=?1 AND id=?2").bind(me.ws, id), db.prepare("DELETE FROM tx_kval WHERE ws=?1 AND kpi_id=?2").bind(me.ws, id)]);
    return json({ ok: true, v });
  },
  async "kval/save"(db, me, b) {   // 기간별 실적(직접 입력 KPI)과 기간별 목표
    if (!isMgr(me)) return fail("forbidden", 403);
    const kid = clip(b.kpi_id, 60), per = String(b.period || "");
    if (!/^\d{4}(-\d{2}|-Q[1-4])?$/.test(per)) return fail("bad-request");
    if (!await spOne(db, "tx_kpi", me.ws, kid)) return fail("not-found", 404);
    const row = { kpi_id: kid, period: per, value: numOrNull(b.value), target: numOrNull(b.target), memo: clip(b.memo, 200) };
    const stmts = row.value === null && row.target === null && !row.memo ? [db.prepare("DELETE FROM tx_kval WHERE ws=?1 AND kpi_id=?2 AND period=?3").bind(me.ws, kid, per)] : spBulk(db, "tx_kval", me.ws, [row], "ON CONFLICT(ws,kpi_id,period) DO UPDATE SET value=excluded.value, target=excluded.target, memo=excluded.memo");
    const { v } = await spRun(db, me, stmts);
    return json({ ok: true, v, kval: row });
  },
  async "grant/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), o = {}, now = iso();
    if ("title" in b) o.title = clip(b.title, 200);
    if ("org" in b) o.org = clip(b.org, 80);
    if ("url" in b) { const u = clip(b.url, 400); o.url = /^https?:\/\//i.test(u) ? u : ""; }
    if ("deadline" in b) o.deadline = dOk(b.deadline) || null;
    if ("status" in b) o.status = TX_GRANT_ST.includes(b.status) ? b.status : "watch";
    if ("amount" in b) o.amount = numOrNull(b.amount) === null ? null : Math.max(0, intOr(b.amount, 0));
    if ("memo" in b) o.memo = clip(b.memo, 1000);
    if ("ext_id" in b) o.ext_id = clip(b.ext_id, 60) || null;
    if (!id) {
      if (!o.title) return fail("bad-request");
      if (o.ext_id && await db.prepare("SELECT 1 AS x FROM tx_grant WHERE ws=?1 AND ext_id=?2").bind(me.ws, o.ext_id).first()) return fail("dup", 409);
      const row = Object.assign({ id: bulkId("gr"), org: "", url: "", deadline: null, status: "watch", amount: null, memo: "", ext_id: null, created_at: now, updated_at: now }, o);
      const { v } = await spRun(db, me, spBulk(db, "tx_grant", me.ws, [row]));
      return json({ ok: true, v, grant: await spOne(db, "tx_grant", me.ws, row.id) });
    }
    if (!await spOne(db, "tx_grant", me.ws, id)) return fail("not-found", 404);
    o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE tx_grant SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, grant: await spOne(db, "tx_grant", me.ws, id) });
  },
  async "grant/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM tx_grant WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },
  // 거래처 사업자 상태 — 국세청 사업자등록 상태조회(공공데이터포털). Cloudflare에 NTS_API_KEY가 있어야 합니다
  async bizcheck(db, me, b, req, url, env) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const nos = [...new Set((Array.isArray(b.nos) ? b.nos : []).map(bizNo).filter(x => x.length === 10))].slice(0, 100);
    if (!nos.length) return fail("bad-request");
    const key = env && env.NTS_API_KEY;
    if (!key) return fail("no-key", 400, { hint: "Cloudflare Pages → Settings → Variables and Secrets에 NTS_API_KEY를 넣어 주세요." });
    let r;
    try {
      r = await fetch("https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=" + encodeURIComponent(key), { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ b_no: nos }) });
    } catch (e) { return fail("upstream", 502); }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !Array.isArray(j.data)) return fail("upstream", 502, { status: r.status });
    return json({ ok: true, items: j.data.map(x => ({ no: String(x.b_no || ""), status: String(x.b_stt || ""), code: String(x.b_stt_cd || ""), taxType: String(x.tax_type || ""), endDate: String(x.end_dt || "") })) });
  },
  // 지원사업 공고 — 기업마당 지원사업정보 API. Cloudflare에 BIZINFO_API_KEY가 있어야 합니다
  async feed(db, me, b, req, url, env) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const key = env && env.BIZINFO_API_KEY;
    if (!key) return fail("no-key", 400);
    const tags = (Array.isArray(b.tags) ? b.tags : []).map(x => clip(x, 20)).filter(Boolean).slice(0, 5).join(",");
    const q = new URLSearchParams({ crtfcKey: key, dataType: "json", searchCnt: String(clampInt(b.n, 10, 100, 60)) });
    if (tags) q.set("hashtags", tags);
    let r;
    try { r = await fetch("https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do?" + q.toString(), { headers: { accept: "application/json" } }); } catch (e) { return fail("upstream", 502); }
    const j = await r.json().catch(() => null);
    const arr = j && (Array.isArray(j.jsonArray) ? j.jsonArray : Array.isArray(j.items) ? j.items : Array.isArray(j) ? j : Array.isArray(j.data) ? j.data : null);
    if (!r.ok || !arr) return fail("upstream", 502, { status: r.status });
    const abs = u => { u = String(u || ""); return /^https?:\/\//.test(u) ? u : u ? "https://www.bizinfo.go.kr" + (u.startsWith("/") ? "" : "/") + u : ""; };
    const items = arr.slice(0, 100).map(x => ({
      id: clip(x.pblancId || x.seq || x.id || x.pblancUrl || x.title, 60),
      title: clip(x.pblancNm || x.title, 200), org: clip(x.jrsdInsttNm || x.author || x.excInsttNm, 80), exec: clip(x.excInsttNm, 80),
      period: clip(x.reqstBeginEndDe || x.reqstDt || "", 60), field: clip(x.pldirSportRealmLclasCodeNm || x.lcategory || "", 40),
      target: clip(x.trgetNm || "", 120), summary: clip(String(x.bsnsSumryCn || x.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), 300),
      tags: clip(x.hashtags || x.hashTags || "", 200), url: abs(x.pblancUrl || x.link), at: clip(x.creatPnttm || x.pubDate || "", 30)
    })).filter(x => x.title);
    return json({ ok: true, items });
  }
};

/* ═══════════ 마이피플 — 함께 일하는 사람(파트너)과 고용한 사람(근무·급여) ═══════════
   · 관리자는 전부, 직원(관리자 아닌 내부 팀원)은 근무표·출퇴근까지, 급여와 임금 정보는 워크스페이스 관리자만 봅니다.
   · 근무자는 자기 근무표·출퇴근·명세서만 받고, 다른 사람의 근무·임금은 받지 않습니다. */
const PP_DDL = [
  "CREATE TABLE IF NOT EXISTS pp_staff(ws TEXT NOT NULL, id TEXT NOT NULL, member_id TEXT, contact_id TEXT, name TEXT NOT NULL, phone TEXT, kind TEXT NOT NULL DEFAULT 'part', pay_type TEXT NOT NULL DEFAULT 'hour', rate INTEGER NOT NULL DEFAULT 0, ins TEXT NOT NULL DEFAULT 'none', tax_m INTEGER NOT NULL DEFAULT 0, meal INTEGER NOT NULL DEFAULT 0, week_hours REAL, days TEXT, store_id TEXT, start_date TEXT, end_date TEXT, status TEXT NOT NULL DEFAULT 'active', docs TEXT, contract TEXT, bank TEXT, birth TEXT, memo TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_pp_staff_mem ON pp_staff(ws,member_id)",
  "CREATE TABLE IF NOT EXISTS pp_shift(ws TEXT NOT NULL, id TEXT NOT NULL, staff_id TEXT NOT NULL, date TEXT NOT NULL, t_start TEXT NOT NULL, t_end TEXT NOT NULL, brk INTEGER NOT NULL DEFAULT 0, store_id TEXT, note TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_pp_shift_d ON pp_shift(ws,date)",
  "CREATE TABLE IF NOT EXISTS pp_att(ws TEXT NOT NULL, id TEXT NOT NULL, staff_id TEXT NOT NULL, date TEXT NOT NULL, in_at TEXT, out_at TEXT, brk INTEGER NOT NULL DEFAULT 0, src TEXT, lat REAL, lng REAL, dist INTEGER, note TEXT, edited_by TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_pp_att_d ON pp_att(ws,date)",
  "CREATE INDEX IF NOT EXISTS idx_pp_att_s ON pp_att(ws,staff_id,date)",
  "CREATE TABLE IF NOT EXISTS pp_job(ws TEXT NOT NULL, id TEXT NOT NULL, staff_id TEXT NOT NULL, date TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 1, rate INTEGER, note TEXT, created_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_pp_job_d ON pp_job(ws,date)",
  "CREATE TABLE IF NOT EXISTS pp_pay(ws TEXT NOT NULL, id TEXT NOT NULL, staff_id TEXT NOT NULL, period TEXT NOT NULL, pfrom TEXT, pto TEXT, items TEXT NOT NULL DEFAULT '[]', deds TEXT NOT NULL DEFAULT '[]', gross INTEGER NOT NULL DEFAULT 0, ded INTEGER NOT NULL DEFAULT 0, net INTEGER NOT NULL DEFAULT 0, employer INTEGER NOT NULL DEFAULT 0, pay_date TEXT, status TEXT NOT NULL DEFAULT 'draft', paid_at TEXT, fin_id TEXT, memo TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_pp_pay_sp ON pp_pay(ws,staff_id,period)",
  "CREATE TABLE IF NOT EXISTS pp_card(ws TEXT NOT NULL, contact_id TEXT NOT NULL, img TEXT, at TEXT, PRIMARY KEY(ws,contact_id))"
];
const PP_TABLES = ["pp_staff", "pp_shift", "pp_att", "pp_job", "pp_pay", "pp_card"];
Object.assign(SPC, {
  pp_staff: ["id", "member_id", "contact_id", "name", "phone", "kind", "pay_type", "rate", "ins", "tax_m", "meal", "week_hours", "days", "store_id", "start_date", "end_date", "status", "docs", "contract", "bank", "birth", "memo", "created_at", "updated_at"],
  pp_shift: ["id", "staff_id", "date", "t_start", "t_end", "brk", "store_id", "note"],
  pp_att: ["id", "staff_id", "date", "in_at", "out_at", "brk", "src", "lat", "lng", "dist", "note", "edited_by", "created_at", "updated_at"],
  pp_job: ["id", "staff_id", "date", "qty", "rate", "note", "created_at"],
  pp_pay: ["id", "staff_id", "period", "pfrom", "pto", "items", "deds", "gross", "ded", "net", "employer", "pay_date", "status", "paid_at", "fin_id", "memo", "created_at", "updated_at"],
  pp_card: ["contact_id", "img", "at"]
});
Object.assign(SPJ, { pp_staff: { days: "[]", docs: "{}", contract: "{}" }, pp_pay: { items: "[]", deds: "[]" } });
const PP_KIND = ["part", "full", "job", "day", "free"];          // 아르바이트 · 직원 · 건당 · 일용 · 프리랜서(3.3%)
const PP_PAYT = ["hour", "day", "week", "month", "job"];
const PP_INS = ["four", "biz33", "daily", "none"];               // 4대보험 · 3.3% · 일용 · 없음
const PP_PAY_ST = ["draft", "confirmed", "paid"];
const PP_SELF = new Set(["me", "clock"]);                        // 현장 근무자도 쓰는 것 — 내 근무표·출퇴근·명세서
const ppAdmin = me => me.role === "admin";
const PP_PAY_COLS = ["rate", "tax_m", "meal", "bank", "birth"];  // 관리자만 받는 임금 정보
function ppStaffIn(b, admin) {
  const o = {};
  if ("member_id" in b) o.member_id = clip(b.member_id, 60) || null;
  if ("contact_id" in b) o.contact_id = clip(b.contact_id, 60) || null;
  if ("name" in b) o.name = clip(b.name, 40);
  if ("phone" in b) o.phone = clip(b.phone, 40);
  if ("kind" in b) o.kind = PP_KIND.includes(b.kind) ? b.kind : "part";
  if ("pay_type" in b) o.pay_type = PP_PAYT.includes(b.pay_type) ? b.pay_type : "hour";
  if ("ins" in b) o.ins = PP_INS.includes(b.ins) ? b.ins : "none";
  if ("week_hours" in b) o.week_hours = numOrNull(b.week_hours) === null ? null : Math.max(0, Math.min(80, Number(b.week_hours)));
  if ("days" in b) o.days = JSON.stringify((Array.isArray(b.days) ? b.days : []).map(Number).filter(d => d >= 0 && d <= 6).slice(0, 7));
  if ("store_id" in b) o.store_id = clip(b.store_id, 60) || null;
  if ("start_date" in b) o.start_date = dOk(b.start_date) || null;
  if ("end_date" in b) o.end_date = dOk(b.end_date) || null;
  if ("status" in b) o.status = ["active", "leave", "end"].includes(b.status) ? b.status : "active";
  if ("memo" in b) o.memo = clip(b.memo, 1000);
  if ("docs" in b) { const d = b.docs && typeof b.docs === "object" ? b.docs : {}; o.docs = JSON.stringify({ contract: dOk(d.contract) || "", health: dOk(d.health) || "", bank: !!d.bank, idchk: !!d.idchk, ins: dOk(d.ins) || "" }); }
  if ("contract" in b) { const c = b.contract && typeof b.contract === "object" ? b.contract : {}; o.contract = JSON.stringify({ place: clip(c.place, 100), job: clip(c.job, 100), holiday: clip(c.holiday, 60), payday: clip(c.payday, 40), method: clip(c.method, 40), extra: clip(c.extra, 500) }); }
  if (admin) {
    if ("rate" in b) o.rate = Math.max(0, Math.min(100000000, intOr(b.rate, 0)));
    if ("tax_m" in b) o.tax_m = Math.max(0, Math.min(10000000, intOr(b.tax_m, 0)));
    if ("meal" in b) o.meal = Math.max(0, Math.min(1000000, intOr(b.meal, 0)));
    if ("bank" in b) o.bank = clip(b.bank, 100);
    if ("birth" in b) o.birth = dOk(b.birth) || null;
  }
  return o;
}
const ppStrip = (s, admin) => { if (!s || admin) return s; const o = Object.assign({}, s); for (const k of PP_PAY_COLS) delete o[k]; return o; };
function ppNorm(s) {
  s = s && typeof s === "object" ? s : {};
  const r = s.rates && typeof s.rates === "object" ? s.rates : {};
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) && v !== "" && v !== null ? Math.min(hi, Math.max(lo, n)) : d; };
  const locs = {}; if (s.locs && typeof s.locs === "object") for (const [k, v] of Object.entries(s.locs).slice(0, 200)) if (v && Number.isFinite(Number(v.lat)) && Number.isFinite(Number(v.lng))) locs[clip(k, 60)] = { lat: Number(v.lat), lng: Number(v.lng), radius: clampInt(v.radius, 30, 2000, 150) };
  return {
    five: !!s.five,                                   // 상시 5인 이상 — 연장·야간 가산수당 적용
    payday: clampInt(s.payday, 1, 31, 10),
    rates: { np: num(r.np, 4.75, 0, 20), hi: num(r.hi, 3.595, 0, 20), lc: num(r.lc, 13.14, 0, 50), ei: num(r.ei, 0.9, 0, 5), eiEr: num(r.eiEr, 1.15, 0, 5), ia: num(r.ia, 0, 0, 20), npMin: num(r.npMin, 410000, 0, 10000000), npMax: num(r.npMax, 6590000, 0, 50000000) },
    locs, gps: s.gps !== false
  };
}
async function ppSettings(db, ws) { const m = await modSettings(db, ws, "pp"); return ppNorm(m.settings); }
function distM(a, b) { const R = 6371000, t = x => x * Math.PI / 180, dLa = t(b.lat - a.lat), dLo = t(b.lng - a.lng); const h = Math.sin(dLa / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dLo / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(h))); }
const kstDateOf = isoS => new Date(Date.parse(isoS) + 9 * 3600e3).toISOString().slice(0, 10);
const PEOP = {
  async data(db, me, b, req, url) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const admin = ppAdmin(me), today = kstToday();
    let from = dOk(url.searchParams.get("from")) || addDaysS(today, -35), to = dOk(url.searchParams.get("to")) || addDaysS(today, 14);
    if (to < from) [from, to] = [to, from];
    if (to > addDaysS(from, 120)) to = addDaysS(from, 120);
    const q = [
      db.prepare("SELECT v FROM mod_set WHERE ws=?1 AND mod='pp' AND k='settings'").bind(me.ws),
      db.prepare(spSel("pp_staff", "ws=?1", "ORDER BY status, name")).bind(me.ws),
      db.prepare(spSel("pp_shift", "ws=?1 AND date>=?2 AND date<=?3", "ORDER BY date, t_start")).bind(me.ws, addDaysS(from, -7), addDaysS(to, 7)),
      db.prepare(spSel("pp_att", "ws=?1 AND ((date>=?2 AND date<=?3) OR (out_at IS NULL AND date>=?4))", "ORDER BY date, in_at")).bind(me.ws, addDaysS(from, -7), to, addDaysS(today, -2)),
      db.prepare(spSel("pp_job", "ws=?1 AND date>=?2 AND date<=?3", "ORDER BY date")).bind(me.ws, addDaysS(from, -7), to)
    ];
    if (admin) q.push(
      db.prepare(spSel("pp_pay", "ws=?1 AND period>=?2", "ORDER BY period DESC")).bind(me.ws, addDaysS(today, -400).slice(0, 7)),
      // 마이스토어 청소 — 건당 근무자의 건수 (제출·확인 완료)
      db.prepare("SELECT COALESCE(submitted_by, assignee) AS mid, clean_date AS d, COUNT(*) AS n FROM sp_cln WHERE ws=?1 AND status IN ('done','confirmed') AND clean_date>=?2 AND clean_date<=?3 GROUP BY mid, clean_date").bind(me.ws, addDaysS(from, -7), to),
      db.prepare("SELECT target, MAX(used_at) AS at, MAX(result) AS result, MAX(note) AS note FROM links WHERE ws=?1 AND kind='payslip' AND used_at IS NOT NULL GROUP BY target").bind(me.ws)
    );
    const rs = await db.batch(q);
    const s0 = rs[0] && rs[0].results && rs[0].results[0];
    const staff = rowsOf(rs[1]).map(s => ppStrip(s, admin));
    const out = { ok: true, v: me.spv, today, from, to, admin, settings: ppNorm(s0 ? parse(s0.v) : null), staff, shifts: rowsOf(rs[2]), att: rowsOf(rs[3]), jobs: rowsOf(rs[4]) };
    if (admin) {
      out.pays = rowsOf(rs[5]);
      out.cleans = ((rs[6] && rs[6].results) || []).map(r => ({ mid: r.mid, date: r.d, n: Number(r.n) || 0 }));
      out.acks = ((rs[7] && rs[7].results) || []).map(r => ({ id: r.target, at: r.at, result: r.result, note: r.note || "" }));
    }
    return json(out);
  },
  async me(db, me) {   // 나의 근무 — 근무자·직원·관리자 누구나 자기 것만
    const today = kstToday(), mon = addDaysS(today, -((new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7));
    const st = rowsOf(await db.prepare(spSel("pp_staff", "ws=?1 AND member_id=?2 AND status<>'end'")).bind(me.ws, me.id).all());
    if (!st.length) return json({ ok: true, today, staff: [], shifts: [], att: [], pays: [], settings: { gps: true } });
    const ids = JSON.stringify(st.map(s => s.id));
    const [sh, at, py, set] = await db.batch([
      db.prepare(spSel("pp_shift", "ws=?1 AND staff_id IN (SELECT value FROM json_each(?2)) AND date>=?3 AND date<=?4", "ORDER BY date, t_start")).bind(me.ws, ids, addDaysS(mon, -7), addDaysS(mon, 13)),
      db.prepare(spSel("pp_att", "ws=?1 AND staff_id IN (SELECT value FROM json_each(?2)) AND date>=?3", "ORDER BY date DESC, in_at DESC")).bind(me.ws, ids, addDaysS(today, -40)),
      db.prepare(spSel("pp_pay", "ws=?1 AND staff_id IN (SELECT value FROM json_each(?2)) AND status<>'draft'", "ORDER BY period DESC LIMIT 24")).bind(me.ws, ids),
      db.prepare("SELECT v FROM mod_set WHERE ws=?1 AND mod='pp' AND k='settings'").bind(me.ws)
    ]);
    const s1 = set && set.results && set.results[0], ps = ppNorm(s1 ? parse(s1.v) : null);
    const pays = rowsOf(py).map(p => ({ id: p.id, staff_id: p.staff_id, period: p.period, pfrom: p.pfrom, pto: p.pto, items: p.items, deds: p.deds, gross: p.gross, ded: p.ded, net: p.net, pay_date: p.pay_date, status: p.status, paid_at: p.paid_at }));
    return json({ ok: true, today, staff: st.map(s => ({ id: s.id, name: s.name, kind: s.kind, pay_type: s.pay_type, rate: s.rate, ins: s.ins, store_id: s.store_id, week_hours: s.week_hours, start_date: s.start_date })), shifts: rowsOf(sh), att: rowsOf(at), pays, settings: { gps: ps.gps, locs: Object.keys(ps.locs) } });
  },
  async clock(db, me, b) {   // 출근·퇴근 — 위치는 브라우저가 알려 준 경우에만 남깁니다
    const act = b.act === "out" ? "out" : "in";
    const st = rowsOf(await db.prepare(spSel("pp_staff", "ws=?1 AND member_id=?2 AND status='active'")).bind(me.ws, me.id).all());
    const s = st.find(x => x.id === b.staff_id) || st[0];
    if (!s) return fail("no-staff", 404);
    const now = iso(), today = kstToday();
    const lat = Number(b.lat), lng = Number(b.lng), hasLoc = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    let dist = null;
    if (hasLoc && s.store_id) { const ps = await ppSettings(db, me.ws), L = ps.locs[s.store_id]; if (L) dist = distM({ lat, lng }, L); }
    const open = await db.prepare(spSel("pp_att", "ws=?1 AND staff_id=?2 AND out_at IS NULL AND in_at>=?3", "ORDER BY in_at DESC LIMIT 1")).bind(me.ws, s.id, new Date(Date.now() - 30 * 3600e3).toISOString()).first();
    const cur = open ? parse(open.j) : null;
    if (act === "in") {
      if (cur) return fail("already-in", 409, { att: cur });
      const row = { id: bulkId("at"), staff_id: s.id, date: today, in_at: now, out_at: null, brk: 0, src: "self", lat: hasLoc ? Math.round(lat * 1e5) / 1e5 : null, lng: hasLoc ? Math.round(lng * 1e5) / 1e5 : null, dist, note: "", edited_by: null, created_at: now, updated_at: now };
      const { v } = await spRun(db, me, spBulk(db, "pp_att", me.ws, [row]));
      return json({ ok: true, v, att: row });
    }
    if (!cur) return fail("not-in", 409);
    const brk = clampInt(b.brk, 0, 600, cur.brk || 0);
    const note = dist !== null && cur.dist !== null && cur.dist !== undefined ? cur.note : cur.note;
    const { v } = await spRun(db, me, [db.prepare("UPDATE pp_att SET out_at=?3, brk=?4, updated_at=?3, note=?5, dist=COALESCE(dist,?6) WHERE ws=?1 AND id=?2").bind(me.ws, cur.id, now, brk, note || "", dist)]);
    return json({ ok: true, v, att: await spOne(db, "pp_att", me.ws, cur.id) });
  },
  async settings(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    if (b && b.set && typeof b.set === "object") {
      if (!ppAdmin(me)) return fail("forbidden", 403);
      const s = ppNorm(Object.assign({}, await ppSettings(db, me.ws), b.set));
      const { v } = await spRun(db, me, [db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'pp','settings',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(s))]);
      return json({ ok: true, v, settings: s });
    }
    return json({ ok: true, settings: await ppSettings(db, me.ws) });
  },
  async "loc/save"(db, me, b) {   // 매장 출근 위치 — 관리자가 매장에서 한 번 눌러 둡니다
    if (!isMgr(me)) return fail("forbidden", 403);
    const sid = clip(b.store_id, 60);
    if (!sid || !await storeOk(db, me, sid)) return fail("not-found", 404);
    const s = await ppSettings(db, me.ws);
    if (b.clear) delete s.locs[sid];
    else { const lat = Number(b.lat), lng = Number(b.lng); if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail("bad-request"); s.locs[sid] = { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5, radius: clampInt(b.radius, 30, 2000, 150) }; }
    const { v } = await spRun(db, me, [db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'pp','settings',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(s))]);
    return json({ ok: true, v, settings: s });
  },
  async "staff/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const admin = ppAdmin(me), id = clip(b.id, 60), o = ppStaffIn(b || {}, admin), now = iso();
    if (o.member_id) {
      const m = await entData(db, me.ws, "member", o.member_id);
      if (!m) return fail("not-found", 404);
    }
    if (!id) {
      if (!o.name) return fail("bad-request");
      const n = await db.prepare("SELECT COUNT(*) AS n FROM pp_staff WHERE ws=?1").bind(me.ws).first();
      if (Number(n && n.n) >= 500) return fail("limit", 409);
      const row = Object.assign({ id: bulkId("sf"), member_id: null, contact_id: null, phone: "", kind: "part", pay_type: "hour", rate: 0, ins: "none", tax_m: 0, meal: 0, week_hours: null, days: "[]", store_id: null, start_date: kstToday(), end_date: null, status: "active", docs: "{}", contract: "{}", bank: "", birth: null, memo: "", created_at: now, updated_at: now }, o);
      const { v } = await spRun(db, me, spBulk(db, "pp_staff", me.ws, [row]));
      return json({ ok: true, v, staff: ppStrip(await spOne(db, "pp_staff", me.ws, row.id), admin) });
    }
    if (!await spOne(db, "pp_staff", me.ws, id)) return fail("not-found", 404);
    if ("name" in o && !o.name) return fail("bad-request");
    o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE pp_staff SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, staff: ppStrip(await spOne(db, "pp_staff", me.ws, id), admin) });
  },
  async "staff/del"(db, me, b) {
    if (!ppAdmin(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60);
    const used = await db.prepare("SELECT (SELECT COUNT(*) FROM pp_att WHERE ws=?1 AND staff_id=?2) + (SELECT COUNT(*) FROM pp_pay WHERE ws=?1 AND staff_id=?2) AS n").bind(me.ws, id).first();
    if (Number(used && used.n)) return fail("in-use", 409);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM pp_staff WHERE ws=?1 AND id=?2").bind(me.ws, id), db.prepare("DELETE FROM pp_shift WHERE ws=?1 AND staff_id=?2").bind(me.ws, id), db.prepare("DELETE FROM pp_job WHERE ws=?1 AND staff_id=?2").bind(me.ws, id)]);
    return json({ ok: true, v });
  },
  async "shift/save"(db, me, b) {   // 근무표 — 여러 칸을 한 번에 저장
    if (!isMgr(me)) return fail("forbidden", 403);
    const rows = (Array.isArray(b.rows) ? b.rows : [b]).slice(0, 500).map(r => ({ id: clip(r && r.id, 60) || bulkId("sh"), staff_id: clip(r && r.staff_id, 60), date: dOk(r && r.date), t_start: tOk(r && r.t_start), t_end: tOk(r && r.t_end), brk: clampInt(r && r.brk, 0, 600, 0), store_id: clip(r && r.store_id, 60) || null, note: clip(r && r.note, 200) })).filter(r => r.staff_id && r.date && r.t_start && r.t_end);
    if (!rows.length) return fail("bad-request");
    const { v } = await spRun(db, me, spBulk(db, "pp_shift", me.ws, rows, "ON CONFLICT(ws,id) DO UPDATE SET staff_id=excluded.staff_id, date=excluded.date, t_start=excluded.t_start, t_end=excluded.t_end, brk=excluded.brk, store_id=excluded.store_id, note=excluded.note"));
    return json({ ok: true, v, shifts: rows });
  },
  async "shift/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(x => clip(x, 60)).filter(Boolean).slice(0, 1000);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM pp_shift WHERE ws=?1 AND id IN (SELECT value FROM json_each(?2))").bind(me.ws, JSON.stringify(ids))]);
    return json({ ok: true, v });
  },
  async "shift/copy"(db, me, b) {   // 지난주 근무표를 이번 주로 — 같은 사람·날짜·시작 시각이 이미 있으면 건너뜁니다
    if (!isMgr(me)) return fail("forbidden", 403);
    const from = dOk(b.from), to = dOk(b.to);
    if (!from || !to) return fail("bad-request");
    const src = rowsOf(await db.prepare(spSel("pp_shift", "ws=?1 AND date>=?2 AND date<=?3")).bind(me.ws, from, addDaysS(from, 6)).all());
    const ex = rowsOf(await db.prepare(spSel("pp_shift", "ws=?1 AND date>=?2 AND date<=?3")).bind(me.ws, to, addDaysS(to, 6)).all());
    const have = new Set(ex.map(x => [x.staff_id, x.date, x.t_start].join("|")));
    const off = Math.round((Date.parse(to) - Date.parse(from)) / 864e5);
    const add = src.map(x => Object.assign({}, x, { id: bulkId("sh"), date: addDaysS(x.date, off) })).filter(x => !have.has([x.staff_id, x.date, x.t_start].join("|")));
    const { v } = add.length ? await spRun(db, me, spBulk(db, "pp_shift", me.ws, add)) : { v: null };
    return json({ ok: true, v, added: add.length, shifts: add });
  },
  async "att/save"(db, me, b) {   // 관리자가 넣거나 고치는 출퇴근
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), now = iso();
    const isoOk = s => { const t = Date.parse(String(s || "")); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
    const o = {};
    if ("staff_id" in b) o.staff_id = clip(b.staff_id, 60);
    if ("in_at" in b) o.in_at = isoOk(b.in_at);
    if ("out_at" in b) o.out_at = isoOk(b.out_at);
    if ("brk" in b) o.brk = clampInt(b.brk, 0, 600, 0);
    if ("note" in b) o.note = clip(b.note, 300);
    if (o.in_at) o.date = kstDateOf(o.in_at);
    if (o.in_at && o.out_at && o.out_at <= o.in_at) return fail("bad-time");
    o.edited_by = me.name || me.id; o.updated_at = now;
    if (!id) {
      if (!o.staff_id || !o.in_at) return fail("bad-request");
      if (!await spOne(db, "pp_staff", me.ws, o.staff_id)) return fail("not-found", 404);
      const row = Object.assign({ id: bulkId("at"), out_at: null, brk: 0, src: "mgr", lat: null, lng: null, dist: null, note: "", created_at: now }, o);
      const { v } = await spRun(db, me, spBulk(db, "pp_att", me.ws, [row]));
      return json({ ok: true, v, att: await spOne(db, "pp_att", me.ws, row.id) });
    }
    const ex = await spOne(db, "pp_att", me.ws, id);
    if (!ex) return fail("not-found", 404);
    if (o.out_at && !o.in_at && o.out_at <= ex.in_at) return fail("bad-time");
    const { v } = await spRun(db, me, [db.prepare(`UPDATE pp_att SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, att: await spOne(db, "pp_att", me.ws, id) });
  },
  async "att/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM pp_att WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },
  async "job/save"(db, me, b) {   // 건당 근무 기록 (마이스토어 청소 외의 일)
    if (!isMgr(me)) return fail("forbidden", 403);
    const row = { id: clip(b.id, 60) || bulkId("jb"), staff_id: clip(b.staff_id, 60), date: dOk(b.date), qty: clampInt(b.qty, 1, 10000, 1), rate: ppAdmin(me) ? numOrNull(b.rate) : null, note: clip(b.note, 200), created_at: iso() };
    if (!row.staff_id || !row.date) return fail("bad-request");
    if (!await spOne(db, "pp_staff", me.ws, row.staff_id)) return fail("not-found", 404);
    const { v } = await spRun(db, me, spBulk(db, "pp_job", me.ws, [row], "ON CONFLICT(ws,id) DO UPDATE SET staff_id=excluded.staff_id, date=excluded.date, qty=excluded.qty, rate=COALESCE(excluded.rate, pp_job.rate), note=excluded.note"));
    return json({ ok: true, v, job: await spOne(db, "pp_job", me.ws, row.id) });
  },
  async "job/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM pp_job WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },
  async "pay/save"(db, me, b) {   // 급여 계산 결과 저장 — 계산은 화면에서, 서버는 숫자를 검산해 보관합니다
    if (!ppAdmin(me)) return fail("forbidden", 403);
    const sid = clip(b.staff_id, 60), per = String(b.period || "");
    if (!/^\d{4}-\d{2}(-W\d)?$/.test(per)) return fail("bad-request");
    if (!await spOne(db, "pp_staff", me.ws, sid)) return fail("not-found", 404);
    const line = (x, keys) => ({ k: clip(x && x.k, 10), label: clip(x && x.label, 40), basis: clip(x && x.basis, 120), amount: Math.max(-100000000, Math.min(1000000000, intOr(x && x.amount, 0))) });
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 30).map(line).filter(x => x.label);
    const deds = (Array.isArray(b.deds) ? b.deds : []).slice(0, 30).map(line).filter(x => x.label);
    const gross = items.reduce((s, x) => s + x.amount, 0), ded = deds.reduce((s, x) => s + x.amount, 0);
    const ex = await db.prepare(spSel("pp_pay", "ws=?1 AND staff_id=?2 AND period=?3")).bind(me.ws, sid, per).first();
    const cur = ex ? parse(ex.j) : null;
    if (cur && cur.status === "paid") return fail("locked", 409);
    const now = iso();
    const row = { id: cur ? cur.id : bulkId("py"), staff_id: sid, period: per, pfrom: dOk(b.pfrom) || null, pto: dOk(b.pto) || null, items, deds, gross, ded, net: gross - ded, employer: Math.max(0, intOr(b.employer, 0)), pay_date: dOk(b.pay_date) || null, status: cur ? cur.status : "draft", paid_at: cur ? cur.paid_at : null, fin_id: cur ? cur.fin_id : null, memo: clip(b.memo, 500), created_at: cur ? cur.created_at : now, updated_at: now };
    const { v } = await spRun(db, me, spBulk(db, "pp_pay", me.ws, [row], "ON CONFLICT(ws,id) DO UPDATE SET pfrom=excluded.pfrom, pto=excluded.pto, items=excluded.items, deds=excluded.deds, gross=excluded.gross, ded=excluded.ded, net=excluded.net, employer=excluded.employer, pay_date=excluded.pay_date, memo=excluded.memo, updated_at=excluded.updated_at"));
    return json({ ok: true, v, pay: await spOne(db, "pp_pay", me.ws, row.id) });
  },
  async "pay/status"(db, me, b) {
    if (!ppAdmin(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), st = String(b.status || "");
    if (!PP_PAY_ST.includes(st)) return fail("bad-request");
    const ex = await spOne(db, "pp_pay", me.ws, id);
    if (!ex) return fail("not-found", 404);
    if (ex.status === "paid" && st !== "paid" && !b.force) return fail("locked", 409);
    const paidAt = st === "paid" ? (dOk(b.paid_at) || kstToday()) : null;
    const fin = "fin_id" in b ? (clip(b.fin_id, 60) || null) : ex.fin_id;
    const { v } = await spRun(db, me, [db.prepare("UPDATE pp_pay SET status=?3, paid_at=?4, fin_id=?5, updated_at=?6 WHERE ws=?1 AND id=?2").bind(me.ws, id, st, paidAt, fin, iso())]);
    return json({ ok: true, v, pay: await spOne(db, "pp_pay", me.ws, id) });
  },
  async "pay/del"(db, me, b) {
    if (!ppAdmin(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), ex = await spOne(db, "pp_pay", me.ws, id);
    if (!ex) return fail("not-found", 404);
    if (ex.status === "paid") return fail("locked", 409);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM pp_pay WHERE ws=?1 AND id=?2").bind(me.ws, id), db.prepare("UPDATE links SET expires_at=?3 WHERE ws=?1 AND kind='payslip' AND target=?2").bind(me.ws, id, iso())]);
    return json({ ok: true, v });
  },
  async "card/get"(db, me, b) {   // 명함 사진 — 연락처 동기화가 무거워지지 않게 따로 둡니다
    if (!isMgr(me)) return fail("forbidden", 403);
    const r = await db.prepare("SELECT img, at FROM pp_card WHERE ws=?1 AND contact_id=?2").bind(me.ws, clip(b.contact_id, 60)).first();
    return json({ ok: true, img: r ? r.img : "", at: r ? r.at : "" });
  },
  async "card/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const cid = clip(b.contact_id, 60), img = String(b.img || "");
    if (!cid) return fail("bad-request");
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > 400000) return fail("bad-image", 400);
    if (!await entData(db, me.ws, "contact", cid)) return fail("not-found", 404);
    await db.prepare("INSERT INTO pp_card(ws,contact_id,img,at) VALUES(?1,?2,?3,?4) ON CONFLICT(ws,contact_id) DO UPDATE SET img=excluded.img, at=excluded.at").bind(me.ws, cid, img, iso()).run();
    return json({ ok: true });
  },
  async "card/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    await db.prepare("DELETE FROM pp_card WHERE ws=?1 AND contact_id=?2").bind(me.ws, clip(b.contact_id, 60)).run();
    return json({ ok: true });
  },
  async partner(db, me, b) {   // 파트너 카드 — 이 연락처와의 거래 이력, 근무 기록 여부
    if (!isMgr(me)) return fail("forbidden", 403);
    const cid = clip(b.id, 60);
    const [jobs, card, st] = await db.batch([
      db.prepare("SELECT json_object('id',id,'title',title,'status',status,'amount',amount,'created_at',created_at,'closed_at',closed_at) AS j FROM os_job WHERE ws=?1 AND client_id=?2 ORDER BY created_at DESC LIMIT 50").bind(me.ws, cid),
      db.prepare("SELECT img, at FROM pp_card WHERE ws=?1 AND contact_id=?2").bind(me.ws, cid),
      db.prepare("SELECT id, name, kind, status, start_date FROM pp_staff WHERE ws=?1 AND contact_id=?2").bind(me.ws, cid)
    ]);
    const c = ((card && card.results) || [])[0];
    return json({ ok: true, jobs: rowsOf(jobs), img: c ? c.img : "", staff: (st && st.results) || [] });
  }
};

/* ═══════════ 마이마케팅 — 광고·홍보 채널, 캠페인, 성과, 콘텐츠, 키워드, 최적화·부스터 실행안 ═══════════
   · 성과는 날짜 × 채널 × 캠페인 × 라벨(소재·광고그룹·키워드) 한 줄입니다. 같은 날짜·채널·캠페인을 다시 올리면 그 칸을 통째로 바꿔서 두 번 세지 않습니다.
   · 진단(최적화)과 실행안(부스터) 계산은 화면에서 하고, 서버는 기록과 실행안 대기열을 맡습니다.
   · 광고 계정 연결(네이버 검색광고·메타)은 선택입니다. 연결 정보는 MW_VAULT_KEY로 암호화해 두고 화면으로 다시 보내지 않습니다.
     성과를 읽기만 하며, 광고 계정의 예산·입찰·소재는 바꾸지 않습니다. */
const MK_DDL = [
  "CREATE TABLE IF NOT EXISTS mk_chan(ws TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'etc', cat TEXT NOT NULL DEFAULT 'etc', url TEXT, handle TEXT, ext TEXT, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, memo TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE TABLE IF NOT EXISTS mk_camp(ws TEXT NOT NULL, id TEXT NOT NULL, chan_id TEXT NOT NULL, name TEXT NOT NULL, cat TEXT NOT NULL DEFAULT 'etc', goal TEXT NOT NULL DEFAULT 'lead', status TEXT NOT NULL DEFAULT 'live', mode TEXT NOT NULL DEFAULT '', budget INTEGER NOT NULL DEFAULT 0, budget_type TEXT NOT NULL DEFAULT 'month', start_date TEXT, end_date TEXT, target_cpa INTEGER, target_roas INTEGER, landing TEXT, audience TEXT, brand TEXT, store_id TEXT, project_id TEXT, ext_id TEXT, memo TEXT, created_by TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_mk_camp_ext ON mk_camp(ws,ext_id)",
  "CREATE TABLE IF NOT EXISTS mk_stat(ws TEXT NOT NULL, id TEXT NOT NULL, date TEXT NOT NULL, chan_id TEXT NOT NULL, camp_id TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '', cost INTEGER NOT NULL DEFAULT 0, imp INTEGER NOT NULL DEFAULT 0, clk INTEGER NOT NULL DEFAULT 0, conv REAL NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 0, view INTEGER NOT NULL DEFAULT 0, eng INTEGER NOT NULL DEFAULT 0, fol INTEGER, src TEXT, memo TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_mk_stat_key ON mk_stat(ws,date,chan_id,camp_id,label)",
  "CREATE TABLE IF NOT EXISTS mk_post(ws TEXT NOT NULL, id TEXT NOT NULL, chan_id TEXT NOT NULL DEFAULT '', camp_id TEXT NOT NULL DEFAULT '', date TEXT, time TEXT, title TEXT NOT NULL, body TEXT, format TEXT, status TEXT NOT NULL DEFAULT 'idea', url TEXT, tags TEXT, view INTEGER NOT NULL DEFAULT 0, eng INTEGER NOT NULL DEFAULT 0, clk INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0, memo TEXT, created_by TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_mk_post_date ON mk_post(ws,date)",
  "CREATE TABLE IF NOT EXISTS mk_kw(ws TEXT NOT NULL, id TEXT NOT NULL, word TEXT NOT NULL, grp TEXT, chan_id TEXT, vol_pc INTEGER, vol_mo INTEGER, comp TEXT, bid INTEGER, rank TEXT, state TEXT NOT NULL DEFAULT 'watch', memo TEXT, checked_at TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_mk_kw_word ON mk_kw(ws,word)",
  "CREATE TABLE IF NOT EXISTS mk_act(ws TEXT NOT NULL, id TEXT NOT NULL, key TEXT, kind TEXT NOT NULL DEFAULT 'etc', mode TEXT NOT NULL DEFAULT 'opt', camp_id TEXT NOT NULL DEFAULT '', chan_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, detail TEXT, from_v TEXT, to_v TEXT, status TEXT NOT NULL DEFAULT 'todo', base TEXT, task_id TEXT, by TEXT, created_at TEXT, done_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_mk_act_key ON mk_act(ws,key) WHERE key IS NOT NULL"
];
const MK_TABLES = ["mk_chan", "mk_camp", "mk_stat", "mk_post", "mk_kw", "mk_act"];
Object.assign(SPC, {
  mk_chan: ["id", "name", "kind", "cat", "url", "handle", "ext", "active", "sort", "memo", "created_at", "updated_at"],
  mk_camp: ["id", "chan_id", "name", "cat", "goal", "status", "mode", "budget", "budget_type", "start_date", "end_date", "target_cpa", "target_roas", "landing", "audience", "brand", "store_id", "project_id", "ext_id", "memo", "created_by", "created_at", "updated_at"],
  mk_stat: ["id", "date", "chan_id", "camp_id", "label", "cost", "imp", "clk", "conv", "rev", "view", "eng", "fol", "src", "memo", "updated_at"],
  mk_post: ["id", "chan_id", "camp_id", "date", "time", "title", "body", "format", "status", "url", "tags", "view", "eng", "clk", "paid", "memo", "created_by", "created_at", "updated_at"],
  mk_kw: ["id", "word", "grp", "chan_id", "vol_pc", "vol_mo", "comp", "bid", "rank", "state", "memo", "checked_at", "created_at", "updated_at"],
  mk_act: ["id", "key", "kind", "mode", "camp_id", "chan_id", "title", "detail", "from_v", "to_v", "status", "base", "task_id", "by", "created_at", "done_at", "updated_at"]
});
Object.assign(SPJ, { mk_chan: { ext: "{}" }, mk_act: { base: "null" } });
const MK_CAT = ["search", "target", "content", "video", "influ", "message", "local", "etc"];   // 검색광고 · 타겟(디스플레이)광고 · 콘텐츠 · 영상 · 체험단·인플루언서 · 메시지 · 지역·오프라인 · 기타
const MK_KIND = ["naver_sa", "naver_shop", "naver_place", "naver_gfa", "naver_blog", "google_ads", "youtube_ads", "youtube", "meta_ads", "instagram", "facebook", "threads", "tiktok", "kakao_ads", "kakao_ch", "daangn", "influencer", "message", "offline", "site", "etc"];
const MK_GOAL = ["aware", "traffic", "lead", "sale", "visit", "retain"];   // 알리기 · 방문 늘리기 · 문의·예약 · 구매 · 매장 방문 · 다시 오게
const MK_CAMP_ST = ["plan", "live", "pause", "done"];
const MK_MODES = ["basic", "opt", "boost"];
const MK_POST_ST = ["idea", "draft", "ready", "posted", "skip"];
const MK_KW_ST = ["use", "watch", "neg"];
const MK_ACT_ST = ["todo", "done", "skip"];
const MK_SRC = ["manual", "file", "naver", "meta", "yt", "ai"];
const MK_LIMIT = { chans: 40, camps: 500, kws: 2000, acts: 300, posts: 3000 };
const META_VER = "v26.0";   // 메타 그래프 API 버전 — 종료된 버전으로 부르면 메타가 가장 오래된 지원 버전으로 돌려 응답합니다
const mkUrl = u => { u = clip(u, 400); return /^https?:\/\//i.test(u) ? u : ""; };
const mkInt = (v, max) => Math.max(0, Math.min(max, intOr(String(v ?? "").replace(/[^\d.-]/g, ""), 0)));
const mkDec = v => { const n = Number(String(v ?? "").replace(/[^\d.-]/g, "")); return Number.isFinite(n) ? Math.max(0, Math.min(1e9, Math.round(n * 100) / 100)) : 0; };
const mkWord = s => clip(String(s ?? "").replace(/\s+/g, " "), 40);
const mkNm = s => String(s ?? "").replace(/\s+/g, "").toLowerCase();
function mkNorm(s) {   // 설정 — 사업 정보, 모드, 목표, 지키는 선, 점검 기준, 점검표 체크
  s = s && typeof s === "object" ? s : {};
  const obj = k => (s[k] && typeof s[k] === "object" ? s[k] : {});
  const b = obj("biz"), t = obj("target"), g = obj("guard"), r = obj("ref"), sy = obj("synced"), p = obj("plan");
  const ref = {};
  for (const c of MK_CAT) {
    const x = r[c] && typeof r[c] === "object" ? r[c] : null; if (!x) continue;
    const ctr = numOrNull(x.ctr), cvr = numOrNull(x.cvr);
    if (ctr !== null || cvr !== null) ref[c] = { ctr: ctr === null ? null : Math.max(0, Math.min(100, ctr)), cvr: cvr === null ? null : Math.max(0, Math.min(100, cvr)) };
  }
  return {
    set: !!s.set,
    mode: MK_MODES.includes(s.mode) ? s.mode : "basic",
    biz: { type: clip(b.type, 20), name: clip(b.name, 60), offer: clip(b.offer, 300), aud: clip(b.aud, 300), region: clip(b.region, 60), goal: MK_GOAL.includes(b.goal) ? b.goal : "lead", aov: mkInt(b.aov, 1e10), margin: clampInt(b.margin, 0, 100, 0), assets: (Array.isArray(b.assets) ? b.assets : []).map(x => clip(x, 20)).filter(Boolean).slice(0, 20) },
    budget: mkInt(s.budget, 1e11),
    target: { cpa: mkInt(t.cpa, 1e10), roas: clampInt(t.roas, 0, 100000, 0) },
    guard: { step: clampInt(g.step, 5, 50, 20), minClk: clampInt(g.minClk, 5, 1000, 30), minImp: clampInt(g.minImp, 100, 100000, 1000), minConv: clampInt(g.minConv, 1, 100, 3), days: clampInt(g.days, 3, 30, 7) },
    ref,
    checks: (Array.isArray(s.checks) ? s.checks : []).map(x => clip(x, 40)).filter(Boolean).slice(-400),
    metaConv: ["purchase", "lead", "message"].includes(s.metaConv) ? s.metaConv : "purchase",
    plan: p.at ? { at: clip(p.at, 30), type: clip(p.type, 20), goal: clip(p.goal, 20), budget: mkInt(p.budget, 1e11) } : null,
    synced: { naver: clip(sy.naver, 30), meta: clip(sy.meta, 30), yt: clip(sy.yt, 30) }
  };
}
async function mkSettings(db, ws) { const m = await modSettings(db, ws, "mk"); return mkNorm(m.settings); }
function mkChanIn(b) {
  const o = {};
  if ("name" in b) o.name = clip(b.name, 40);
  if ("kind" in b) o.kind = MK_KIND.includes(b.kind) ? b.kind : "etc";
  if ("cat" in b) o.cat = MK_CAT.includes(b.cat) ? b.cat : "etc";
  if ("url" in b) o.url = mkUrl(b.url);
  if ("handle" in b) o.handle = clip(b.handle, 80);
  if ("active" in b) o.active = b.active === false || b.active === 0 ? 0 : 1;
  if ("memo" in b) o.memo = clip(b.memo, 500);
  return o;
}
function mkCampIn(b) {
  const o = {};
  if ("name" in b) o.name = clip(b.name, 80);
  if ("chan_id" in b) o.chan_id = clip(b.chan_id, 60);
  if ("cat" in b) o.cat = MK_CAT.includes(b.cat) ? b.cat : "etc";
  if ("goal" in b) o.goal = MK_GOAL.includes(b.goal) ? b.goal : "lead";
  if ("status" in b) o.status = MK_CAMP_ST.includes(b.status) ? b.status : "live";
  if ("mode" in b) o.mode = MK_MODES.includes(b.mode) ? b.mode : "";
  if ("budget" in b) o.budget = mkInt(b.budget, 1e11);
  if ("budget_type" in b) o.budget_type = ["day", "month", "total"].includes(b.budget_type) ? b.budget_type : "month";
  if ("start_date" in b) o.start_date = dOk(b.start_date) || null;
  if ("end_date" in b) o.end_date = dOk(b.end_date) || null;
  if ("target_cpa" in b) o.target_cpa = numOrNull(b.target_cpa) === null ? null : mkInt(b.target_cpa, 1e10);
  if ("target_roas" in b) o.target_roas = numOrNull(b.target_roas) === null ? null : clampInt(b.target_roas, 0, 100000, 0);
  if ("landing" in b) o.landing = mkUrl(b.landing);
  if ("audience" in b) o.audience = clip(b.audience, 300);
  if ("brand" in b) o.brand = clip(b.brand, 40);
  if ("store_id" in b) o.store_id = clip(b.store_id, 60) || null;
  if ("project_id" in b) o.project_id = clip(b.project_id, 60) || null;
  if ("ext_id" in b) o.ext_id = clip(b.ext_id, 80) || null;
  if ("memo" in b) o.memo = clip(b.memo, 1000);
  return o;
}
function mkStatIn(r) {
  return { date: dOk(r.date), label: clip(r.label, 80), cost: mkInt(r.cost, 1e11), imp: mkInt(r.imp, 1e12), clk: mkInt(r.clk, 1e11), conv: mkDec(r.conv), rev: mkInt(r.rev, 1e12), view: mkInt(r.view, 1e12), eng: mkInt(r.eng, 1e11), fol: r.fol === "" || r.fol === null || r.fol === undefined ? null : mkInt(r.fol, 1e10), memo: clip(r.memo, 200) };
}
const mkCampRow = (me, o, now) => Object.assign({ id: bulkId("mc"), chan_id: "", name: "", cat: "etc", goal: "lead", status: "live", mode: "", budget: 0, budget_type: "month", start_date: null, end_date: null, target_cpa: null, target_roas: null, landing: "", audience: "", brand: "", store_id: null, project_id: null, ext_id: null, memo: "", created_by: me.id, created_at: now, updated_at: now }, o);
const mkChanRow = (o, now, sort) => Object.assign({ id: bulkId("mh"), name: "", kind: "etc", cat: "etc", url: "", handle: "", ext: {}, active: 1, sort: sort || 0, memo: "", created_at: now, updated_at: now }, o);
/* 성과 줄 정리 — 캠페인은 id · 광고 계정의 캠페인 번호(ext_id) · 이름 순으로 찾고, 없으면 만들어 붙입니다.
   같은 칸(날짜·채널·캠페인)에 합계 줄과 라벨 줄이 섞여 들어오면 라벨 줄만 남깁니다. */
function mkBuildStats(me, raw, opt) {
  const now = iso(), chans = opt.chans, camps = opt.camps.slice(), newCamps = [], extFix = [], cells = new Map();
  const byId = new Map(camps.map(c => [c.id, c])), byExt = new Map(camps.filter(c => c.ext_id).map(c => [c.chan_id + "|" + c.ext_id, c])), byName = new Map(camps.map(c => [c.chan_id + "|" + mkNm(c.name), c]));
  let skipped = 0;
  for (const r0 of raw) {
    if (!r0 || typeof r0 !== "object") { skipped++; continue; }
    const s = mkStatIn(r0);
    if (!s.date) { skipped++; continue; }
    let camp = r0.camp_id ? byId.get(String(r0.camp_id)) : null;
    const chanId = camp ? camp.chan_id : (clip(r0.chan_id, 60) || opt.defChan);
    if (!chans.has(chanId)) { skipped++; continue; }
    const ext = clip(r0.ext_id, 80), nm = clip(r0.camp, 80);
    if (!camp && ext) camp = byExt.get(chanId + "|" + ext) || null;
    if (!camp && nm) camp = byName.get(chanId + "|" + mkNm(nm)) || null;
    if (camp && ext && !camp.ext_id) { camp.ext_id = ext; if (!newCamps.includes(camp)) extFix.push({ id: camp.id, ext }); }
    if (!camp && nm && opt.mkcamp && camps.length < MK_LIMIT.camps) {
      camp = mkCampRow(me, { chan_id: chanId, name: nm, cat: chans.get(chanId) || "etc", ext_id: ext || null, budget: mkInt(r0.camp_budget, 1e11), budget_type: r0.camp_budget ? "day" : "month" }, now);
      camps.push(camp); newCamps.push(camp); byId.set(camp.id, camp); byName.set(chanId + "|" + mkNm(nm), camp); if (ext) byExt.set(chanId + "|" + ext, camp);
    }
    const cellKey = [s.date, chanId, camp ? camp.id : ""].join("|");
    if (!cells.has(cellKey)) cells.set(cellKey, new Map());
    const cell = cells.get(cellKey), ex = cell.get(s.label);
    if (ex) { for (const k of ["cost", "imp", "clk", "rev", "view", "eng"]) ex[k] += s[k]; ex.conv = Math.round((ex.conv + s.conv) * 100) / 100; if (s.fol !== null) ex.fol = s.fol; }
    else cell.set(s.label, Object.assign({ id: bulkId("ms"), chan_id: chanId, camp_id: camp ? camp.id : "", src: opt.src, updated_at: now }, s));
  }
  const rows = [];
  for (const cell of cells.values()) { const labeled = [...cell.keys()].some(k => k !== ""); for (const [k, v] of cell) { if (labeled && k === "") continue; rows.push(v); } }
  const dates = rows.map(r => r.date).sort();
  return { rows, newCamps, extFix, keys: [...cells.keys()], skipped, from: dates[0] || "", to: dates[dates.length - 1] || "" };
}
function mkStatStmts(db, ws, r) {
  const out = [];
  if (r.newCamps.length) out.push(...spBulk(db, "mk_camp", ws, r.newCamps));
  if (r.extFix && r.extFix.length) out.push(db.prepare("UPDATE mk_camp SET ext_id=(SELECT json_extract(value,'$.ext') FROM json_each(?2) WHERE json_extract(value,'$.id')=mk_camp.id) WHERE ws=?1 AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?2))").bind(ws, JSON.stringify(r.extFix)));
  if (r.keys.length) out.push(db.prepare("DELETE FROM mk_stat WHERE ws=?1 AND date>=?3 AND date<=?4 AND (date||'|'||chan_id||'|'||camp_id) IN (SELECT value FROM json_each(?2))").bind(ws, JSON.stringify(r.keys), r.from, r.to));
  out.push(...spBulk(db, "mk_stat", ws, r.rows));
  return out;
}
async function mkRefs(db, ws) {
  const [a, b] = await db.batch([db.prepare("SELECT id, kind, cat, name, handle, ext FROM mk_chan WHERE ws=?1").bind(ws), db.prepare("SELECT id, chan_id, name, ext_id FROM mk_camp WHERE ws=?1").bind(ws)]);
  const chanRows = (a && a.results) || [];
  return { chanRows, chans: new Map(chanRows.map(c => [c.id, c.cat])), camps: ((b && b.results) || []).map(c => ({ id: c.id, chan_id: c.chan_id, name: c.name, ext_id: c.ext_id })) };
}
/* ── 연결 정보 금고 — AES-GCM. 키는 Cloudflare 비밀값 MW_VAULT_KEY(16자 이상)에서 만듭니다 ── */
const vaultKey = env => { const k = env && typeof env.MW_VAULT_KEY === "string" ? env.MW_VAULT_KEY.trim() : ""; return k.length >= 16 ? k : ""; };
const unhex = s => new Uint8Array((String(s || "").match(/../g) || []).map(h => parseInt(h, 16)));
async function vaultCrypto(env) { return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode("mw-vault:" + vaultKey(env))), "AES-GCM", false, ["encrypt", "decrypt"]); }
async function seal(env, text) { const iv = crypto.getRandomValues(new Uint8Array(12)); return "v1." + hex(iv) + "." + hex(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await vaultCrypto(env), enc.encode(text)))); }
async function unseal(env, s) {
  const m = String(s || "").split("."); if (m.length !== 3 || m[0] !== "v1" || !vaultKey(env)) return "";
  try { return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unhex(m[1]) }, await vaultCrypto(env), unhex(m[2]))); } catch (e) { return ""; }
}
const mkTail = s => { s = String(s || ""); return s.length > 8 ? "…" + s.slice(-4) : "…"; };
async function mkConnRaw(db, ws) { const r = await db.prepare("SELECT v FROM mod_set WHERE ws=?1 AND mod='mk' AND k='conn'").bind(ws).first(); const o = r ? parse(r.v) : null; return o && typeof o === "object" ? o : {}; }
const mkConnPublic = c => ({ naver: c.naver ? { on: true, cid: c.naver.cid, tail: c.naver.tail, at: c.naver.at } : { on: false }, meta: c.meta ? { on: true, acct: c.meta.acct, tail: c.meta.tail, at: c.meta.at } : { on: false } });
async function mkSecret(env, c) { const t = c && c.sealed ? await unseal(env, c.sealed) : ""; return t ? parse(t) : null; }
/* 네이버 검색광고 API — 서명: HMAC-SHA256(시크릿, "시각.메서드.경로")를 base64로 */
async function naverSa(c, method, uri, query) {
  const t = String(Date.now());
  const key = await crypto.subtle.importKey("raw", enc.encode(c.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(t + "." + method + "." + uri)))));
  let r;
  try { r = await fetch("https://api.searchad.naver.com" + uri + (query ? "?" + new URLSearchParams(query).toString() : ""), { method, headers: { "X-Timestamp": t, "X-API-KEY": c.key, "X-Customer": String(c.cid), "X-Signature": sig, accept: "application/json" } }); }
  catch (e) { return { ok: false, status: 0, j: null }; }
  return { ok: r.ok, status: r.status, j: await r.json().catch(() => null) };
}
async function metaGet(pathOrUrl, query) {
  const u = /^https:\/\/graph\.facebook\.com\//.test(pathOrUrl) ? pathOrUrl : "https://graph.facebook.com/" + META_VER + pathOrUrl + "?" + new URLSearchParams(query).toString();
  let r;
  try { r = await fetch(u, { headers: { accept: "application/json" } }); } catch (e) { return { ok: false, status: 0, j: null }; }
  return { ok: r.ok, status: r.status, j: await r.json().catch(() => null) };
}
const META_CONV = { purchase: ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"], lead: ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"], message: ["onsite_conversion.messaging_conversation_started_7d", "onsite_conversion.total_messaging_connection"] };
function metaPick(list, types) {   // 같은 전환이 이름만 달리 여러 번 나오므로 앞선 이름 하나만 씁니다
  const m = new Map((Array.isArray(list) ? list : []).map(a => [String(a && a.action_type), Number(a && a.value) || 0]));
  for (const t of types) if (m.has(t)) return m.get(t);
  return 0;
}
const upErr = (x, extra) => fail(x.status === 401 || x.status === 403 ? "conn-denied" : x.status === 429 ? "conn-busy" : "upstream", 502, Object.assign({ status: x.status, msg: clip(x.j && (x.j.title || x.j.message || (x.j.error && (x.j.error.message || x.j.error)) || x.j.detail), 200) }, extra || {}));
async function mkAiSummary(db, me) {
  const today = kstToday(), d30 = addDaysS(today, -29), d7 = addDaysS(today, -6);
  const agg = "SELECT chan_id, camp_id, SUM(cost) AS cost, SUM(imp) AS imp, SUM(clk) AS clk, SUM(conv) AS conv, SUM(rev) AS rev, SUM(view) AS view, SUM(eng) AS eng FROM mk_stat WHERE ws=?1 AND date>=?2 GROUP BY chan_id, camp_id";
  const rs = await db.batch([
    db.prepare("SELECT v FROM mod_set WHERE ws=?1 AND mod='mk' AND k='settings'").bind(me.ws),
    db.prepare("SELECT id, name, kind, cat, active FROM mk_chan WHERE ws=?1 ORDER BY sort, created_at").bind(me.ws),
    db.prepare("SELECT id, chan_id, name, cat, goal, status, mode, budget, budget_type, target_cpa, target_roas FROM mk_camp WHERE ws=?1 AND status<>'done' ORDER BY updated_at DESC LIMIT 200").bind(me.ws),
    db.prepare(agg).bind(me.ws, d30), db.prepare(agg).bind(me.ws, d7),
    db.prepare("SELECT id, kind, mode, camp_id, title, detail, from_v, to_v, created_at FROM mk_act WHERE ws=?1 AND status='todo' ORDER BY created_at DESC LIMIT 40").bind(me.ws),
    db.prepare("SELECT id, chan_id, date, title, format, status FROM mk_post WHERE ws=?1 AND status NOT IN ('posted','skip') AND (date IS NULL OR date<=?2) ORDER BY COALESCE(date,'9999') LIMIT 40").bind(me.ws, addDaysS(today, 14))
  ]);
  const R = i => (rs[i] && rs[i].results) || [], s0 = R(0)[0], set = mkNorm(s0 ? parse(s0.v) : null);
  const chN = new Map(R(1).map(c => [c.id, c.name])), cpN = new Map(R(2).map(c => [c.id, c.name]));
  const m = x => { const cost = Number(x.cost) || 0, imp = Number(x.imp) || 0, clk = Number(x.clk) || 0, conv = Number(x.conv) || 0, rev = Number(x.rev) || 0; return { cost, impressions: imp, clicks: clk, conversions: conv, revenue: rev, ctr: imp ? Math.round(clk / imp * 10000) / 100 : null, cpc: clk ? Math.round(cost / clk) : null, cvr: clk ? Math.round(conv / clk * 10000) / 100 : null, cpa: conv ? Math.round(cost / conv) : null, roas: cost ? Math.round(rev / cost * 100) : null }; };
  // 여러 캠페인을 묶은 ROAS는 매출을 기록한 캠페인의 광고비만 분모로 씁니다
  const sum = (list, f) => { const t = { cost: 0, imp: 0, clk: 0, conv: 0, rev: 0 }; let rc = 0; for (const x of list) if (!f || f(x)) { for (const k of Object.keys(t)) t[k] += Number(x[k]) || 0; if (Number(x.rev) > 0) rc += Number(x.cost) || 0; } const o = m(t); o.roas = rc ? Math.round(t.rev / rc * 100) : null; return o; };
  const A30 = R(3), A7 = R(4);
  return {
    today, mode: set.mode, monthlyBudget: set.budget, target: set.target, business: { type: set.biz.type, goal: set.biz.goal, averageOrder: set.biz.aov, marginPct: set.biz.margin },
    last30: sum(A30), last7: sum(A7),
    channels: R(1).map(c => Object.assign({ id: c.id, name: c.name, kind: c.kind, category: c.cat, active: !!c.active }, { last30: sum(A30, x => x.chan_id === c.id) })),
    campaigns: R(2).map(c => ({ id: c.id, name: c.name, channel: chN.get(c.chan_id) || "", category: c.cat, goal: c.goal, status: c.status, mode: c.mode || set.mode, budget: c.budget, budgetType: c.budget_type, targetCpa: c.target_cpa, targetRoas: c.target_roas, last30: sum(A30, x => x.camp_id === c.id), last7: sum(A7, x => x.camp_id === c.id) })),
    openActions: R(5).map(a => ({ id: a.id, kind: a.kind, mode: a.mode, campaign: cpN.get(a.camp_id) || "", title: a.title, detail: clip(a.detail, 300), from: a.from_v || "", to: a.to_v || "", createdAt: a.created_at })),
    upcomingContent: R(6).map(p => ({ id: p.id, channel: chN.get(p.chan_id) || "", date: p.date || "", title: p.title, format: p.format || "", status: p.status })),
    hint: "비용은 원, ctr·cvr은 %, roas는 %(매출÷광고비×100)입니다. 쓰기 토큰은 propose의 mk-action(실행안)·mk-post(콘텐츠 초안)로 제안할 수 있습니다."
  };
}
async function mkPropItems(db, me, prop) {   // AI 제안 → 실행안·콘텐츠 초안
  const p = prop.payload, now = iso(), bump = db.prepare("UPDATE workspaces SET sp_ver=sp_ver+1 WHERE id=?1").bind(me.ws);
  const findRow = async (t, key) => { if (!key) return null; const r = await db.prepare(`SELECT id, name${t === "mk_camp" ? ", chan_id" : ""} FROM ${t} WHERE ws=?1 AND (id=?2 OR name=?2 OR name LIKE ?3) ORDER BY (id=?2) DESC, (name=?2) DESC, LENGTH(name) LIMIT 1`).bind(me.ws, key, likeArg(key)).first(); return r && (r.id === key || likeHas(r.name, key)) ? r : null; };
  if (prop.kind === "mk-action") {
    const cp = await findRow("mk_camp", p.campaign);
    const row = { id: bulkId("ma"), key: null, kind: p.kind, mode: "boost", camp_id: cp ? cp.id : "", chan_id: cp ? cp.chan_id : "", title: p.title, detail: p.detail, from_v: p.from, to_v: p.to, status: "todo", base: null, task_id: null, by: "ai", created_at: now, done_at: null, updated_at: now };
    return { items: [actRow(me, `AI 제안으로 마케팅 실행안 "${row.title}"을(를) 더했습니다.`)], stmts: spBulk(db, "mk_act", me.ws, [row]).concat([bump]), applied: { actionId: row.id, title: row.title, campaign: cp ? cp.name : "" } };
  }
  const ch = await findRow("mk_chan", p.channel);
  const row = { id: bulkId("mp"), chan_id: ch ? ch.id : "", camp_id: "", date: p.date || null, time: "", title: p.title, body: p.body, format: p.format, status: "draft", url: "", tags: p.tags, view: 0, eng: 0, clk: 0, paid: 0, memo: "", created_by: me.id, created_at: now, updated_at: now };
  return { items: [actRow(me, `AI 제안으로 콘텐츠 초안 "${row.title}"을(를) 더했습니다.`)], stmts: spBulk(db, "mk_post", me.ws, [row]).concat([bump]), applied: { postId: row.id, title: row.title, channel: ch ? ch.name : "" } };
}
const MKT = {
  async data(db, me, b, req, url, env) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const today = kstToday(), from = dOk(url.searchParams.get("from")) || addDaysS(today, -150);
    const rs = await db.batch([
      db.prepare("SELECT k, v FROM mod_set WHERE ws=?1 AND mod='mk'").bind(me.ws),
      db.prepare(spSel("mk_chan", "ws=?1", "ORDER BY sort, created_at")).bind(me.ws),
      db.prepare(spSel("mk_camp", "ws=?1", "ORDER BY created_at")).bind(me.ws),
      db.prepare(spSel("mk_stat", "ws=?1 AND date>=?2", "ORDER BY date LIMIT 60000")).bind(me.ws, from),
      db.prepare(spSel("mk_post", "ws=?1", "ORDER BY COALESCE(date,'9999') DESC, created_at DESC LIMIT 1500")).bind(me.ws),
      db.prepare(spSel("mk_kw", "ws=?1", "ORDER BY created_at LIMIT 2000")).bind(me.ws),
      db.prepare(spSel("mk_act", "ws=?1 AND (status='todo' OR updated_at>=?2)", "ORDER BY created_at DESC LIMIT 600")).bind(me.ws, new Date(Date.now() - 120 * 864e5).toISOString())
    ]);
    const kv = new Map(((rs[0] && rs[0].results) || []).map(r => [r.k, parse(r.v)]));
    const conn = kv.get("conn") && typeof kv.get("conn") === "object" ? kv.get("conn") : {};
    return rawJson({ ok: true, v: me.spv, today, from, settings: mkNorm(kv.get("settings")), conn: mkConnPublic(conn), keys: { vault: !!vaultKey(env), yt: !!(env && env.YT_API_KEY), datalab: !!(env && env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET) } },
      ',"chans":' + rawArr(rs[1]) + ',"camps":' + rawArr(rs[2]) + ',"stats":' + rawArr(rs[3]) + ',"posts":' + rawArr(rs[4]) + ',"kws":' + rawArr(rs[5]) + ',"acts":' + rawArr(rs[6]));
  },
  async settings(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const cur = await mkSettings(db, me.ws);
    const s = mkNorm(Object.assign({}, cur, b && b.set && typeof b.set === "object" ? b.set : {}));
    if (JSON.stringify(s).length > 40000) return fail("too-large", 413);
    const { v } = await spRun(db, me, [db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'mk','settings',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(s))]);
    return json({ ok: true, v, settings: s });
  },
  async "chan/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), o = mkChanIn(b || {}), now = iso();
    if (!id) {
      if (!o.name) return fail("bad-request");
      const n = await db.prepare("SELECT COUNT(*) AS n FROM mk_chan WHERE ws=?1").bind(me.ws).first();
      if (Number(n && n.n) >= MK_LIMIT.chans) return fail("limit", 409);
      const row = mkChanRow(o, now, Number(n && n.n) + 1);
      const { v } = await spRun(db, me, spBulk(db, "mk_chan", me.ws, [row]));
      return json({ ok: true, v, chan: await spOne(db, "mk_chan", me.ws, row.id) });
    }
    if (!await spOne(db, "mk_chan", me.ws, id)) return fail("not-found", 404);
    if ("name" in o && !o.name) return fail("bad-request");
    o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE mk_chan SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, chan: await spOne(db, "mk_chan", me.ws, id) });
  },
  async "chan/del"(db, me, b) {   // 캠페인·성과·콘텐츠가 붙어 있으면 지우지 않습니다 (대신 '쓰지 않음'으로)
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60);
    const u = await db.prepare("SELECT (SELECT COUNT(*) FROM mk_camp WHERE ws=?1 AND chan_id=?2) + (SELECT COUNT(*) FROM mk_stat WHERE ws=?1 AND chan_id=?2) + (SELECT COUNT(*) FROM mk_post WHERE ws=?1 AND chan_id=?2) AS n").bind(me.ws, id).first();
    if (Number(u && u.n) > 0) return fail("in-use", 409, { n: Number(u.n) });
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM mk_chan WHERE ws=?1 AND id=?2").bind(me.ws, id), db.prepare("UPDATE mk_kw SET chan_id=NULL WHERE ws=?1 AND chan_id=?2").bind(me.ws, id)]);
    return json({ ok: true, v });
  },
  async "camp/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), o = mkCampIn(b || {}), now = iso();
    if ("chan_id" in o && !await db.prepare("SELECT 1 AS x FROM mk_chan WHERE ws=?1 AND id=?2").bind(me.ws, o.chan_id).first()) return fail("bad-channel");
    if (!id) {
      if (!o.name || !o.chan_id) return fail("bad-request");
      const n = await db.prepare("SELECT COUNT(*) AS n FROM mk_camp WHERE ws=?1").bind(me.ws).first();
      if (Number(n && n.n) >= MK_LIMIT.camps) return fail("limit", 409);
      const row = mkCampRow(me, o, now);
      const { v } = await spRun(db, me, spBulk(db, "mk_camp", me.ws, [row]));
      return json({ ok: true, v, camp: await spOne(db, "mk_camp", me.ws, row.id) });
    }
    const cur = await spOne(db, "mk_camp", me.ws, id);
    if (!cur) return fail("not-found", 404);
    if ("name" in o && !o.name) return fail("bad-request");
    o.updated_at = now;
    const stmts = [db.prepare(`UPDATE mk_camp SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))];
    if (o.chan_id && o.chan_id !== cur.chan_id) stmts.push(db.prepare("UPDATE mk_stat SET chan_id=?3 WHERE ws=?1 AND camp_id=?2").bind(me.ws, id, o.chan_id));   // 채널을 옮기면 성과도 따라갑니다
    const { v } = await spRun(db, me, stmts);
    return json({ ok: true, v, camp: await spOne(db, "mk_camp", me.ws, id) });
  },
  async "camp/del"(db, me, b) {   // 캠페인과 그 성과 기록을 함께 지웁니다. 실행안·콘텐츠는 남기고 연결만 뗍니다
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60);
    if (!id) return fail("bad-request");
    const { v, rs } = await spRun(db, me, [
      db.prepare("DELETE FROM mk_stat WHERE ws=?1 AND camp_id=?2").bind(me.ws, id),
      db.prepare("DELETE FROM mk_camp WHERE ws=?1 AND id=?2").bind(me.ws, id),
      db.prepare("UPDATE mk_act SET camp_id='' WHERE ws=?1 AND camp_id=?2").bind(me.ws, id),
      db.prepare("UPDATE mk_post SET camp_id='' WHERE ws=?1 AND camp_id=?2").bind(me.ws, id)
    ]);
    return json({ ok: true, v, stats: Number(rs[0] && rs[0].meta && rs[0].meta.changes) || 0 });
  },
  // 성과 한 줄 — 직접 적을 때. 합계 줄을 적으려는 칸에 파일로 올린 상세 줄이 있으면 replace로 확인받고 바꿉니다
  async "stat/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const s = mkStatIn(b || {});
    if (!s.date) return fail("bad-date");
    const refs = await mkRefs(db, me.ws), campId = clip(b.camp_id, 60), camp = campId ? refs.camps.find(c => c.id === campId) : null;
    if (campId && !camp) return fail("not-found", 404);
    const chanId = camp ? camp.chan_id : clip(b.chan_id, 60);
    if (!refs.chans.has(chanId)) return fail("bad-channel");
    const ex = (await db.prepare("SELECT id, label FROM mk_stat WHERE ws=?1 AND date=?2 AND chan_id=?3 AND camp_id=?4").bind(me.ws, s.date, chanId, campId).all()).results || [];
    if (!s.label && ex.some(x => x.label) && !b.replace) return fail("has-detail", 409, { n: ex.filter(x => x.label).length });
    const row = Object.assign({ id: bulkId("ms"), chan_id: chanId, camp_id: campId, src: MK_SRC.includes(b.src) ? b.src : "manual", updated_at: iso() }, s);
    const del = s.label ? "AND label IN ('',?5)" : "";   // 라벨 줄을 적으면 그 칸의 합계 줄은 지웁니다
    const { v } = await spRun(db, me, [db.prepare(`DELETE FROM mk_stat WHERE ws=?1 AND date=?2 AND chan_id=?3 AND camp_id=?4 ${del}`).bind(...[me.ws, s.date, chanId, campId].concat(s.label ? [s.label] : [])), ...spBulk(db, "mk_stat", me.ws, [row])]);
    return json({ ok: true, v, stat: await spOne(db, "mk_stat", me.ws, row.id), replaced: ex.length });
  },
  async "stat/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(x => clip(x, 60)).filter(Boolean).slice(0, 5000);
    if (!ids.length) return fail("bad-request");
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM mk_stat WHERE ws=?1 AND id IN (SELECT value FROM json_each(?2))").bind(me.ws, JSON.stringify(ids))]);
    return json({ ok: true, v, deleted: ids.length });
  },
  // 광고 관리자에서 내려받은 보고서(엑셀·CSV)를 화면에서 읽어 보냅니다 — 날짜·채널·캠페인 칸 단위로 바꿔 넣습니다
  async "stat/import"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const raw = (Array.isArray(b.rows) ? b.rows : []).slice(0, 5000);
    if (!raw.length) return fail("empty");
    const refs = await mkRefs(db, me.ws), defChan = clip(b.chan_id, 60);
    if (defChan && !refs.chans.has(defChan)) return fail("bad-channel");
    const r = mkBuildStats(me, raw, { defChan, src: MK_SRC.includes(b.src) ? b.src : "file", chans: refs.chans, camps: refs.camps, mkcamp: b.mkcamp !== false });
    if (!r.rows.length) return fail("empty", 400, { skipped: r.skipped });
    const { v } = await spRun(db, me, mkStatStmts(db, me.ws, r));
    return json({ ok: true, v, added: r.rows.length, camps: r.newCamps.length, skipped: r.skipped, from: r.from, to: r.to });
  },
  async "post/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), o = {}, now = iso();
    if ("chan_id" in b) o.chan_id = clip(b.chan_id, 60);
    if ("camp_id" in b) o.camp_id = clip(b.camp_id, 60);
    if ("date" in b) o.date = dOk(b.date) || null;
    if ("time" in b) o.time = tOk(b.time);
    if ("title" in b) o.title = clip(b.title, 120);
    if ("body" in b) o.body = clip(b.body, 6000);
    if ("format" in b) o.format = clip(b.format, 20);
    if ("status" in b) o.status = MK_POST_ST.includes(b.status) ? b.status : "idea";
    if ("url" in b) o.url = mkUrl(b.url);
    if ("tags" in b) o.tags = clip(b.tags, 300);
    if ("view" in b) o.view = mkInt(b.view, 1e12);
    if ("eng" in b) o.eng = mkInt(b.eng, 1e11);
    if ("clk" in b) o.clk = mkInt(b.clk, 1e11);
    if ("paid" in b) o.paid = b.paid ? 1 : 0;
    if ("memo" in b) o.memo = clip(b.memo, 1000);
    if (!id) {
      if (!o.title) return fail("bad-request");
      const n = await db.prepare("SELECT COUNT(*) AS n FROM mk_post WHERE ws=?1").bind(me.ws).first();
      if (Number(n && n.n) >= MK_LIMIT.posts) return fail("limit", 409);
      const row = Object.assign({ id: bulkId("mp"), chan_id: "", camp_id: "", date: null, time: "", body: "", format: "", status: "idea", url: "", tags: "", view: 0, eng: 0, clk: 0, paid: 0, memo: "", created_by: me.id, created_at: now, updated_at: now }, o);
      const { v } = await spRun(db, me, spBulk(db, "mk_post", me.ws, [row]));
      return json({ ok: true, v, post: await spOne(db, "mk_post", me.ws, row.id) });
    }
    if (!await spOne(db, "mk_post", me.ws, id)) return fail("not-found", 404);
    if ("title" in o && !o.title) return fail("bad-request");
    o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE mk_post SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, post: await spOne(db, "mk_post", me.ws, id) });
  },
  async "post/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM mk_post WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },
  async "kw/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), o = {}, now = iso();
    if ("word" in b) o.word = mkWord(b.word);
    if ("grp" in b) o.grp = clip(b.grp, 30);
    if ("chan_id" in b) o.chan_id = clip(b.chan_id, 60) || null;
    if ("vol_pc" in b) o.vol_pc = numOrNull(b.vol_pc) === null ? null : mkInt(b.vol_pc, 1e10);
    if ("vol_mo" in b) o.vol_mo = numOrNull(b.vol_mo) === null ? null : mkInt(b.vol_mo, 1e10);
    if ("comp" in b) o.comp = clip(b.comp, 10);
    if ("bid" in b) o.bid = numOrNull(b.bid) === null ? null : mkInt(b.bid, 1e8);
    if ("rank" in b) o.rank = clip(b.rank, 20);
    if ("state" in b) o.state = MK_KW_ST.includes(b.state) ? b.state : "watch";
    if ("memo" in b) o.memo = clip(b.memo, 300);
    if (!id) {
      if (!o.word) return fail("bad-request");
      if (await db.prepare("SELECT 1 AS x FROM mk_kw WHERE ws=?1 AND word=?2").bind(me.ws, o.word).first()) return fail("dup", 409);
      const n = await db.prepare("SELECT COUNT(*) AS n FROM mk_kw WHERE ws=?1").bind(me.ws).first();
      if (Number(n && n.n) >= MK_LIMIT.kws) return fail("limit", 409);
      const row = Object.assign({ id: bulkId("mw"), grp: "", chan_id: null, vol_pc: null, vol_mo: null, comp: "", bid: null, rank: "", state: "watch", memo: "", checked_at: null, created_at: now, updated_at: now }, o);
      const { v } = await spRun(db, me, spBulk(db, "mk_kw", me.ws, [row]));
      return json({ ok: true, v, kw: await spOne(db, "mk_kw", me.ws, row.id) });
    }
    if (!await spOne(db, "mk_kw", me.ws, id)) return fail("not-found", 404);
    if ("word" in o) { if (!o.word) return fail("bad-request"); if (await db.prepare("SELECT 1 AS x FROM mk_kw WHERE ws=?1 AND word=?2 AND id<>?3").bind(me.ws, o.word, id).first()) return fail("dup", 409); }
    o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE mk_kw SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, kw: await spOne(db, "mk_kw", me.ws, id) });
  },
  // 키워드 여러 개 — 같은 낱말이 있으면 검색량·경쟁 정도만 새로 고칩니다 (묶음·상태·메모는 그대로)
  async "kw/import"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const now = iso(), seen = new Set(), rows = [];
    for (const r of (Array.isArray(b.rows) ? b.rows : []).slice(0, 500)) {
      const word = mkWord(r && r.word); if (!word || seen.has(word)) continue; seen.add(word);
      const has = r.vol_pc != null || r.vol_mo != null;
      rows.push({ id: bulkId("mw"), word, grp: clip(r.grp, 30), chan_id: null, vol_pc: numOrNull(r.vol_pc) === null ? null : mkInt(r.vol_pc, 1e10), vol_mo: numOrNull(r.vol_mo) === null ? null : mkInt(r.vol_mo, 1e10), comp: clip(r.comp, 10), bid: null, rank: "", state: MK_KW_ST.includes(r.state) ? r.state : "watch", memo: clip(r.memo, 300), checked_at: has ? now : null, created_at: now, updated_at: now });
    }
    if (!rows.length) return fail("empty");
    const n = await db.prepare("SELECT COUNT(*) AS n FROM mk_kw WHERE ws=?1").bind(me.ws).first();
    if (Number(n && n.n) + rows.length > MK_LIMIT.kws + 500) return fail("limit", 409);
    const { v } = await spRun(db, me, spBulk(db, "mk_kw", me.ws, rows, "ON CONFLICT(ws,word) DO UPDATE SET vol_pc=COALESCE(excluded.vol_pc,vol_pc), vol_mo=COALESCE(excluded.vol_mo,vol_mo), comp=CASE WHEN excluded.comp<>'' THEN excluded.comp ELSE comp END, checked_at=COALESCE(excluded.checked_at,checked_at), updated_at=excluded.updated_at"));
    const out = await db.prepare(spSel("mk_kw", "ws=?1", "ORDER BY created_at LIMIT 2000")).bind(me.ws).all();
    return rawJson({ ok: true, v, n: rows.length }, ',"kws":' + rawArr(out));
  },
  async "kw/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(x => clip(x, 60)).filter(Boolean).slice(0, 2000);
    if (!ids.length) return fail("bad-request");
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM mk_kw WHERE ws=?1 AND id IN (SELECT value FROM json_each(?2))").bind(me.ws, JSON.stringify(ids))]);
    return json({ ok: true, v, deleted: ids.length });
  },
  async "act/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), o = {}, now = iso();
    if ("title" in b) o.title = clip(b.title, 120);
    if ("detail" in b) o.detail = clip(b.detail, 2000);
    if ("kind" in b) o.kind = clip(b.kind, 20) || "etc";
    if ("mode" in b) o.mode = b.mode === "boost" ? "boost" : "opt";
    if ("camp_id" in b) o.camp_id = clip(b.camp_id, 60);
    if ("chan_id" in b) o.chan_id = clip(b.chan_id, 60);
    if ("from_v" in b) o.from_v = clip(b.from_v, 40);
    if ("to_v" in b) o.to_v = clip(b.to_v, 40);
    if ("task_id" in b) o.task_id = clip(b.task_id, 60) || null;
    if ("status" in b && MK_ACT_ST.includes(b.status)) { o.status = b.status; o.done_at = b.status === "todo" ? null : now; }
    if ("base" in b) { const s = JSON.stringify(b.base && typeof b.base === "object" ? b.base : null); o.base = s.length > 2000 ? "null" : s; }
    if (!id) {
      if (!o.title) return fail("bad-request");
      const n = await db.prepare("SELECT COUNT(*) AS n FROM mk_act WHERE ws=?1 AND status='todo'").bind(me.ws).first();
      if (Number(n && n.n) >= MK_LIMIT.acts) return fail("limit", 409);
      const row = Object.assign({ id: bulkId("ma"), key: null, kind: "etc", mode: "opt", camp_id: "", chan_id: "", detail: "", from_v: "", to_v: "", status: "todo", base: null, task_id: null, by: me.id, created_at: now, done_at: null, updated_at: now }, o);
      const { v } = await spRun(db, me, spBulk(db, "mk_act", me.ws, [row]));
      return json({ ok: true, v, act: await spOne(db, "mk_act", me.ws, row.id) });
    }
    if (!await spOne(db, "mk_act", me.ws, id)) return fail("not-found", 404);
    if ("title" in o && !o.title) return fail("bad-request");
    o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE mk_act SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, act: await spOne(db, "mk_act", me.ws, id) });
  },
  // 진단·부스터가 만든 실행안을 대기열에 넣습니다 — 같은 열쇠(key)는 한 번만 들어갑니다
  async "act/bulk"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const now = iso(), seen = new Set(), rows = [];
    for (const r of (Array.isArray(b.rows) ? b.rows : []).slice(0, 60)) {
      const key = clip(r && r.key, 120), title = clip(r && r.title, 120);
      if (!key || !title || seen.has(key)) continue; seen.add(key);
      const base = JSON.stringify(r.base && typeof r.base === "object" ? r.base : null);
      rows.push({ id: bulkId("ma"), key, kind: clip(r.kind, 20) || "etc", mode: r.mode === "boost" ? "boost" : "opt", camp_id: clip(r.camp_id, 60), chan_id: clip(r.chan_id, 60), title, detail: clip(r.detail, 2000), from_v: clip(r.from_v, 40), to_v: clip(r.to_v, 40), status: "todo", base: base.length > 2000 ? null : parse(base), task_id: null, by: "auto", created_at: now, done_at: null, updated_at: now });
    }
    if (!rows.length) return fail("empty");
    const n = await db.prepare("SELECT COUNT(*) AS n FROM mk_act WHERE ws=?1 AND status='todo'").bind(me.ws).first();
    if (Number(n && n.n) + rows.length > MK_LIMIT.acts) return fail("limit", 409);
    const { v } = await spRun(db, me, spBulk(db, "mk_act", me.ws, rows, "ignore"));
    const out = await db.prepare(spSel("mk_act", "ws=?1 AND key IN (SELECT value FROM json_each(?2))")).bind(me.ws, JSON.stringify(rows.map(r => r.key))).all();
    return rawJson({ ok: true, v }, ',"acts":' + rawArr(out));
  },
  async "act/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM mk_act WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },
  // 기획안 한 번에 만들기 — 기획 마법사와 클로드가 정리해 준 기획 파일(myworks-marketing/v1)이 같은 길을 씁니다
  async "plan/apply"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const now = iso(), refs = await mkRefs(db, me.ws), stmts = [], made = { chans: 0, camps: 0, posts: 0, acts: 0, kws: 0 };
    const chanBy = new Map();   // 이름·종류 → id
    for (const c of refs.chanRows) { chanBy.set("n:" + mkNm(c.name), c.id); if (!chanBy.has("k:" + c.kind)) chanBy.set("k:" + c.kind, c.id); }
    const chanCat = new Map(refs.chans), newCh = [];
    for (const c of (Array.isArray(b.chans) ? b.chans : []).slice(0, 20)) {
      const o = mkChanIn(c || {}); if (!o.name) continue;
      if (chanBy.has("n:" + mkNm(o.name)) || (o.kind && o.kind !== "etc" && chanBy.has("k:" + o.kind))) continue;
      if (refs.chanRows.length + newCh.length >= MK_LIMIT.chans) break;
      const row = mkChanRow(o, now, refs.chanRows.length + newCh.length + 1);
      newCh.push(row); chanBy.set("n:" + mkNm(row.name), row.id); if (!chanBy.has("k:" + row.kind)) chanBy.set("k:" + row.kind, row.id); chanCat.set(row.id, row.cat);
    }
    const chanOf = x => { const s = clip(x, 60); return !s ? "" : chanCat.has(s) ? s : chanBy.get("k:" + s) || chanBy.get("n:" + mkNm(s)) || ""; };
    if (newCh.length) { stmts.push(...spBulk(db, "mk_chan", me.ws, newCh)); made.chans = newCh.length; }
    const campNames = new Set(refs.camps.map(c => c.chan_id + "|" + mkNm(c.name))), newCp = [], campBy = new Map(refs.camps.map(c => [mkNm(c.name), c.id]));
    for (const c of (Array.isArray(b.camps) ? b.camps : []).slice(0, 40)) {
      const o = mkCampIn(c || {}), ch = chanOf(c && (c.chan_id || c.chan || c.channel));
      if (!o.name || !ch || campNames.has(ch + "|" + mkNm(o.name)) || refs.camps.length + newCp.length >= MK_LIMIT.camps) continue;
      const row = mkCampRow(me, Object.assign({ status: "plan" }, o, { chan_id: ch, cat: o.cat || chanCat.get(ch) || "etc" }), now);
      if (!("cat" in o)) row.cat = chanCat.get(ch) || "etc";
      newCp.push(row); campNames.add(ch + "|" + mkNm(o.name)); campBy.set(mkNm(o.name), row.id);
    }
    if (newCp.length) { stmts.push(...spBulk(db, "mk_camp", me.ws, newCp)); made.camps = newCp.length; }
    const posts = [];
    for (const p of (Array.isArray(b.posts) ? b.posts : []).slice(0, 60)) {
      const title = clip(p && p.title, 120); if (!title) continue;
      posts.push({ id: bulkId("mp"), chan_id: chanOf(p.chan_id || p.chan || p.channel), camp_id: campBy.get(mkNm(p.camp || p.campaign)) || "", date: dOk(p.date) || null, time: tOk(p.time), title, body: clip(p.body, 6000), format: clip(p.format, 20), status: MK_POST_ST.includes(p.status) ? p.status : "idea", url: "", tags: clip(p.tags, 300), view: 0, eng: 0, clk: 0, paid: p.paid ? 1 : 0, memo: clip(p.memo, 1000), created_by: me.id, created_at: now, updated_at: now });
    }
    if (posts.length) { stmts.push(...spBulk(db, "mk_post", me.ws, posts)); made.posts = posts.length; }
    const acts = [];
    for (const a of (Array.isArray(b.acts) ? b.acts : []).slice(0, 40)) {
      const title = clip(a && a.title, 120); if (!title) continue;
      acts.push({ id: bulkId("ma"), key: clip(a.key, 120) || null, kind: clip(a.kind, 20) || "setup", mode: a.mode === "boost" ? "boost" : "opt", camp_id: campBy.get(mkNm(a.camp || a.campaign)) || "", chan_id: chanOf(a.chan_id || a.chan || a.channel), title, detail: clip(a.detail, 2000), from_v: "", to_v: "", status: "todo", base: null, task_id: null, by: b.by === "ai" ? "ai" : me.id, created_at: now, done_at: null, updated_at: now });
    }
    if (acts.length) { stmts.push(...spBulk(db, "mk_act", me.ws, acts, "ignore")); made.acts = acts.length; }
    const seen = new Set(), kws = [];
    for (const k of (Array.isArray(b.kws) ? b.kws : []).slice(0, 200)) {
      const word = mkWord(typeof k === "string" ? k : k && k.word); if (!word || seen.has(word)) continue; seen.add(word);
      kws.push({ id: bulkId("mw"), word, grp: clip(k && k.grp, 30), chan_id: null, vol_pc: null, vol_mo: null, comp: "", bid: null, rank: "", state: k && k.state === "neg" ? "neg" : "watch", memo: "", checked_at: null, created_at: now, updated_at: now });
    }
    if (kws.length) { stmts.push(...spBulk(db, "mk_kw", me.ws, kws, "ON CONFLICT(ws,word) DO NOTHING")); made.kws = kws.length; }
    if (b.set && typeof b.set === "object") {
      const s = mkNorm(Object.assign({}, await mkSettings(db, me.ws), b.set));
      stmts.push(db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'mk','settings',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(s)));
    }
    if (!stmts.length) return fail("empty");
    const { v } = await spRun(db, me, stmts);
    return json({ ok: true, v, made });
  },
  /* ── 광고 계정 연결 (선택) — 워크스페이스 관리자만 넣고 지웁니다 ── */
  async "conn/save"(db, me, b, req, url, env) {
    if (me.role !== "admin") return fail("forbidden", 403);
    if (!vaultKey(env)) return fail("no-vault", 400, { hint: "Cloudflare Pages → Settings → Variables and Secrets에 MW_VAULT_KEY(16자 이상)를 넣어 주세요." });
    const conn = await mkConnRaw(db, me.ws), now = iso();
    if (b.src === "naver") {
      const key = clip(b.key, 200), secret = clip(b.secret, 200), cid = String(b.cid || "").replace(/[^0-9]/g, "").slice(0, 20);
      if (!key || !secret || !cid) return fail("bad-request");
      conn.naver = { cid, tail: mkTail(key), sealed: await seal(env, JSON.stringify({ key, secret, cid })), at: now, by: me.id };
    } else if (b.src === "meta") {
      const token = clip(b.token, 600), acct = String(b.acct || "").replace(/[^0-9]/g, "").slice(0, 30);
      if (!token || !acct) return fail("bad-request");
      conn.meta = { acct, tail: mkTail(token), sealed: await seal(env, JSON.stringify({ token, acct })), at: now, by: me.id };
    } else return fail("bad-request");
    await db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'mk','conn',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(conn)).run();
    return json({ ok: true, conn: mkConnPublic(conn) });
  },
  async "conn/del"(db, me, b) {
    if (me.role !== "admin") return fail("forbidden", 403);
    const conn = await mkConnRaw(db, me.ws);
    if (b.src !== "naver" && b.src !== "meta") return fail("bad-request");
    delete conn[b.src];
    await db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'mk','conn',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(conn)).run();
    return json({ ok: true, conn: mkConnPublic(conn) });
  },
  async "conn/test"(db, me, b, req, url, env) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const conn = await mkConnRaw(db, me.ws);
    if (b.src === "naver") {
      const c = await mkSecret(env, conn.naver); if (!c) return fail("no-conn");
      const x = await naverSa(c, "GET", "/ncc/campaigns");
      if (!x.ok || !Array.isArray(x.j)) return upErr(x);
      return json({ ok: true, campaigns: x.j.length });
    }
    if (b.src === "meta") {
      const c = await mkSecret(env, conn.meta); if (!c) return fail("no-conn");
      const x = await metaGet("/act_" + c.acct, { fields: "name,currency,account_status", access_token: c.token });
      if (!x.ok || !x.j || x.j.error) return upErr(x);
      return json({ ok: true, name: clip(x.j.name, 80), currency: clip(x.j.currency, 8) });
    }
    return fail("bad-request");
  },
  /* 성과 가져오기 — 네이버 검색광고·메타 광고·유튜브 채널. 화면을 열 때 몇 시간에 한 번 부릅니다 */
  async sync(db, me, b, req, url, env) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const src = b.src, today = kstToday(), days = clampInt(b.days, 1, 90, 14), since = addDaysS(today, -(days - 1)), now = iso();
    const set = await mkSettings(db, me.ws), refs = await mkRefs(db, me.ws), raw = [], extra = [];
    if (["naver", "meta", "yt"].includes(src) && set.synced[src] && Date.now() - Date.parse(set.synced[src]) < (src === "yt" ? 30 : 1) * 60000) return fail("too-soon", 429);   // 유튜브는 운영자 키를 함께 쓰므로 30분에 한 번
    const ensureChan = (kind, name, cat) => {
      const ex = refs.chanRows.find(c => c.kind === kind); if (ex) return ex.id;
      const row = mkChanRow({ name, kind, cat }, now, refs.chanRows.length + 1);
      extra.push(...spBulk(db, "mk_chan", me.ws, [row])); refs.chanRows.push(row); refs.chans.set(row.id, cat); return row.id;
    };
    if (src === "naver") {
      const c = await mkSecret(env, (await mkConnRaw(db, me.ws)).naver); if (!c) return fail("no-conn");
      const cs = await naverSa(c, "GET", "/ncc/campaigns");
      if (!cs.ok || !Array.isArray(cs.j)) return upErr(cs);
      const list = cs.j.filter(x => x && x.nccCampaignId).slice(0, 30), chan = ensureChan("naver_sa", "네이버 검색광고", "search");
      const q = { fields: JSON.stringify(["impCnt", "clkCnt", "salesAmt", "ccnt", "convAmt"]), timeRange: JSON.stringify({ since, until: today }), timeIncrement: "1" };
      let bad = 0;
      for (let i = 0; i < list.length; i += 5) {
        const got = await Promise.all(list.slice(i, i + 5).map(x => naverSa(c, "GET", "/stats", Object.assign({ id: x.nccCampaignId }, q))));
        got.forEach((g, k) => {
          const cp = list[i + k], data = g.ok && g.j ? (Array.isArray(g.j.data) ? g.j.data : Array.isArray(g.j) ? g.j : []) : null;
          if (!data) { bad++; return; }
          for (const d of data) {
            const date = dOk(String(d.dateStart || d.date || d.statDt || "").slice(0, 10)); if (!date) continue;
            const row = { date, chan_id: chan, ext_id: cp.nccCampaignId, camp: clip(cp.name, 80), camp_budget: cp.useDailyBudget ? cp.dailyBudget : 0, cost: d.salesAmt, imp: d.impCnt, clk: d.clkCnt, conv: d.ccnt, rev: d.convAmt };
            if (Number(row.cost) || Number(row.imp) || Number(row.clk) || Number(row.conv)) raw.push(row);
          }
        });
      }
      if (bad === list.length && list.length) return fail("upstream", 502, { status: 0, msg: "성과 조회가 모두 실패했습니다." });
      set.synced.naver = now;
    } else if (src === "meta") {
      const c = await mkSecret(env, (await mkConnRaw(db, me.ws)).meta); if (!c) return fail("no-conn");
      const chan = ensureChan("meta_ads", "메타 광고 (인스타그램·페이스북)", "target"), types = META_CONV[set.metaConv] || META_CONV.purchase;
      let x = await metaGet("/act_" + c.acct + "/insights", { level: "campaign", time_increment: "1", time_range: JSON.stringify({ since, until: today }), fields: "campaign_id,campaign_name,spend,impressions,inline_link_clicks,clicks,actions,action_values", limit: "500", access_token: c.token });
      for (let page = 0; page < 6; page++) {
        if (!x.ok || !x.j || x.j.error || !Array.isArray(x.j.data)) { if (!page) return upErr(x); break; }
        for (const d of x.j.data) {
          const date = dOk(d.date_start); if (!date || !d.campaign_id) continue;
          raw.push({ date, chan_id: chan, ext_id: String(d.campaign_id), camp: clip(d.campaign_name, 80), cost: Math.round(Number(d.spend) || 0), imp: d.impressions, clk: d.inline_link_clicks != null ? d.inline_link_clicks : d.clicks, conv: metaPick(d.actions, types), rev: Math.round(metaPick(d.action_values, META_CONV.purchase)) });
        }
        const next = x.j.paging && x.j.paging.next;
        if (!next) break;
        x = await metaGet(next);
      }
      set.synced.meta = now;
    } else if (src === "yt") {
      const key = env && env.YT_API_KEY; if (!key) return fail("no-key");
      const list = refs.chanRows.filter(c => c.kind === "youtube" && String(c.handle || "").trim()).slice(0, 5);
      if (!list.length) return fail("no-channel");
      const out = [];
      for (const c of list) {
        const h = String(c.handle).trim(), q = new URLSearchParams({ part: "statistics", key });
        if (/^UC[\w-]{20,}$/.test(h)) q.set("id", h); else q.set("forHandle", h.startsWith("@") ? h : "@" + h);
        let r, j = null;
        try { r = await fetch("https://www.googleapis.com/youtube/v3/channels?" + q.toString(), { headers: { accept: "application/json" } }); j = await r.json().catch(() => null); } catch (e) { r = null; }
        const st = r && r.ok && j && Array.isArray(j.items) && j.items[0] && j.items[0].statistics;
        if (!st) { out.push({ id: c.id, ok: false }); continue; }
        const ext = parse(c.ext) || {}, subs = mkInt(st.subscriberCount, 1e10), views = mkInt(st.viewCount, 1e13), delta = ext.views != null && views >= ext.views ? views - ext.views : 0;
        extra.push(db.prepare("UPDATE mk_chan SET ext=?3, updated_at=?4 WHERE ws=?1 AND id=?2").bind(me.ws, c.id, JSON.stringify(Object.assign({}, ext, { subs, views, videos: mkInt(st.videoCount, 1e9), at: now })), now));
        extra.push(db.prepare("INSERT INTO mk_stat(ws,id,date,chan_id,camp_id,label,cost,imp,clk,conv,rev,view,eng,fol,src,memo,updated_at) VALUES(?1,?2,?3,?4,'','',0,0,0,0,0,?5,0,?6,'yt','',?7) ON CONFLICT(ws,date,chan_id,camp_id,label) DO UPDATE SET view=mk_stat.view+excluded.view, fol=excluded.fol, updated_at=excluded.updated_at").bind(me.ws, bulkId("ms"), today, c.id, delta, subs, now));
        out.push({ id: c.id, ok: true, subs, views });
      }
      if (!out.some(x => x.ok)) return fail("upstream", 502, { status: 0 });
      set.synced.yt = now;
      extra.push(db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'mk','settings',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(set)));
      const { v } = await spRun(db, me, extra);
      return json({ ok: true, v, channels: out, synced: set.synced });
    } else return fail("bad-request");
    const r = raw.length ? mkBuildStats(me, raw, { defChan: "", src, chans: refs.chans, camps: refs.camps, mkcamp: true }) : { rows: [], newCamps: [], extFix: [], keys: [], skipped: 0, from: "", to: "" };
    const stmts = extra.concat(r.rows.length ? mkStatStmts(db, me.ws, r) : []);
    stmts.push(db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'mk','settings',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(set)));
    const { v } = await spRun(db, me, stmts);
    return json({ ok: true, v, rows: r.rows.length, camps: r.newCamps.length, since, until: today, synced: set.synced });
  },
  // 네이버 키워드 도구 — 연관 키워드와 월간 검색 수 (네이버 검색광고 연결이 있어야 합니다)
  async kwtool(db, me, b, req, url, env) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const words = [...new Set((Array.isArray(b.words) ? b.words : []).map(w => String(w || "").replace(/\s+/g, "").slice(0, 40)).filter(Boolean))].slice(0, 5);
    if (!words.length) return fail("bad-request");
    const c = await mkSecret(env, (await mkConnRaw(db, me.ws)).naver); if (!c) return fail("no-conn");
    const x = await naverSa(c, "GET", "/keywordstool", { hintKeywords: words.join(","), showDetail: "1" });
    if (!x.ok || !x.j || !Array.isArray(x.j.keywordList)) return upErr(x);
    const num = v => { const n = Number(String(v ?? "").replace(/[^\d.]/g, "")); return Number.isFinite(n) ? Math.round(n) : 0; };   // 10 미만은 "< 10"으로 옵니다
    return json({ ok: true, items: x.j.keywordList.slice(0, 120).map(k => ({ word: clip(k.relKeyword, 40), vol_pc: num(k.monthlyPcQcCnt), vol_mo: num(k.monthlyMobileQcCnt), low: /</.test(String(k.monthlyPcQcCnt) + String(k.monthlyMobileQcCnt)), comp: clip(k.compIdx, 10), depth: num(k.plAvgDepth) })).filter(k => k.word) });
  },
  // 검색 관심도 추이 — 네이버 데이터랩 통합검색어 트렌드 (운영자가 NAVER_CLIENT_ID·NAVER_CLIENT_SECRET을 넣어 두었을 때)
  async trend(db, me, b, req, url, env) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = env && env.NAVER_CLIENT_ID, sec = env && env.NAVER_CLIENT_SECRET;
    if (!id || !sec) return fail("no-key");
    const groups = (Array.isArray(b.groups) ? b.groups : []).slice(0, 5).map(g => ({ groupName: clip(g && g.name, 30), keywords: (Array.isArray(g && g.words) ? g.words : []).map(w => clip(w, 40)).filter(Boolean).slice(0, 20) })).filter(g => g.groupName && g.keywords.length);
    if (!groups.length) return fail("bad-request");
    const today = kstToday(), months = clampInt(b.months, 1, 36, 12);
    // 운영자 키 하나를 모든 워크스페이스가 함께 쓰므로 워크스페이스마다 하루 40번까지만
    const q0 = await db.prepare("SELECT v FROM mod_set WHERE ws=?1 AND mod='mk' AND k='quota'").bind(me.ws).first(), Q = (q0 && parse(q0.v)) || {}, used = Q.d === today ? Number(Q.trend) || 0 : 0;
    if (used >= 40) return fail("quota", 429);
    let r;
    try { r = await fetch("https://openapi.naver.com/v1/datalab/search", { method: "POST", headers: { "X-Naver-Client-Id": id, "X-Naver-Client-Secret": sec, "content-type": "application/json" }, body: JSON.stringify({ startDate: addDaysS(today, -months * 30), endDate: addDaysS(today, -1), timeUnit: months > 6 ? "week" : "date", keywordGroups: groups }) }); } catch (e) { return fail("upstream", 502); }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !Array.isArray(j.results)) return fail("upstream", 502, { status: r.status });
    await db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'mk','quota',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify({ d: today, trend: used + 1 })).run();
    return json({ ok: true, unit: months > 6 ? "week" : "date", results: j.results.slice(0, 5).map(x => ({ name: clip(x.title, 30), data: (Array.isArray(x.data) ? x.data : []).slice(0, 400).map(d => ({ d: clip(d.period, 10), v: Math.round((Number(d.ratio) || 0) * 100) / 100 })) })) });
  }
};

/* ═══════════ 마이크리에이터 — 채널, 협찬·광고, 콘텐츠 제작, 수익, 단가표, 미디어킷 ═══════════
   · 협찬·광고 한 건(cr_deal)이 문의 → 협의 → 계약 → 제작 → 검수 → 게시 → 정산 → 완료로 흐릅니다.
   · 입금을 확인하면 수익 기록(cr_inc)이 한 줄 생기고, 화면에서 그 줄을 돈 메뉴로 보냅니다.
   · 공개 링크는 세 가지입니다. 미디어킷(cr-kit · 협찬 문의 접수), 협찬 조건 확인서(cr-deal · 브랜드가 확인·수정 요청), 결과 보고서(cr-report · 보기 전용).
     미디어킷에는 금액이 나가지 않습니다(단가표는 켰을 때만). 메모(memo)는 어느 링크에도 넣지 않습니다.
   · 세금 계산은 참고용입니다. 원천징수율은 설정에서 바꿀 수 있게 두었습니다. */
const CR_DDL = [
  "CREATE TABLE IF NOT EXISTS cr_chan(ws TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'etc', handle TEXT, url TEXT, topic TEXT, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, memo TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE TABLE IF NOT EXISTS cr_snap(ws TEXT NOT NULL, id TEXT NOT NULL, chan_id TEXT NOT NULL, ym TEXT NOT NULL, subs INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0, posts INTEGER NOT NULL DEFAULT 0, memo TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_cr_snap_key ON cr_snap(ws,chan_id,ym)",
  "CREATE TABLE IF NOT EXISTS cr_deal(ws TEXT NOT NULL, id TEXT NOT NULL, brand TEXT NOT NULL, title TEXT, type TEXT NOT NULL DEFAULT 'paid', stage TEXT NOT NULL DEFAULT 'nego', chan_id TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL DEFAULT 0, tax_mode TEXT NOT NULL DEFAULT 'none', draft_due TEXT, post_due TEXT, pay_due TEXT, reply TEXT NOT NULL DEFAULT '', seen INTEGER NOT NULL DEFAULT 1, paid_at TEXT, inc_id TEXT, d TEXT, result TEXT, terms TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_cr_deal_stage ON cr_deal(ws,stage)",
  "CREATE TABLE IF NOT EXISTS cr_cont(ws TEXT NOT NULL, id TEXT NOT NULL, chan_id TEXT NOT NULL DEFAULT '', deal_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'etc', stage TEXT NOT NULL DEFAULT 'idea', shoot_date TEXT, post_date TEXT, url TEXT, view INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0, cmts INTEGER NOT NULL DEFAULT 0, d TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_cr_cont_date ON cr_cont(ws,post_date)",
  "CREATE TABLE IF NOT EXISTS cr_inc(ws TEXT NOT NULL, id TEXT NOT NULL, date TEXT NOT NULL, ym TEXT NOT NULL, src TEXT NOT NULL DEFAULT 'etc', chan_id TEXT NOT NULL DEFAULT '', deal_id TEXT NOT NULL DEFAULT '', title TEXT, gross INTEGER NOT NULL DEFAULT 0, vat INTEGER NOT NULL DEFAULT 0, wht INTEGER NOT NULL DEFAULT 0, net INTEGER NOT NULL DEFAULT 0, cur TEXT NOT NULL DEFAULT 'KRW', fx_amount REAL, fx_rate REAL, memo TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_cr_inc_ym ON cr_inc(ws,ym)",
  "CREATE TABLE IF NOT EXISTS cr_rate(ws TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, chan_id TEXT NOT NULL DEFAULT '', format TEXT NOT NULL DEFAULT 'etc', price INTEGER NOT NULL DEFAULT 0, note TEXT, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))"
];
const CR_TABLES = ["cr_chan", "cr_snap", "cr_deal", "cr_cont", "cr_inc", "cr_rate"];
Object.assign(SPC, {
  cr_chan: ["id", "name", "platform", "handle", "url", "topic", "active", "sort", "memo", "created_at", "updated_at"],
  cr_snap: ["id", "chan_id", "ym", "subs", "views", "posts", "memo", "updated_at"],
  cr_deal: ["id", "brand", "title", "type", "stage", "chan_id", "amount", "tax_mode", "draft_due", "post_due", "pay_due", "reply", "seen", "paid_at", "inc_id", "d", "result", "terms", "created_at", "updated_at"],
  cr_cont: ["id", "chan_id", "deal_id", "title", "format", "stage", "shoot_date", "post_date", "url", "view", "likes", "cmts", "d", "created_at", "updated_at"],
  cr_inc: ["id", "date", "ym", "src", "chan_id", "deal_id", "title", "gross", "vat", "wht", "net", "cur", "fx_amount", "fx_rate", "memo", "created_at", "updated_at"],
  cr_rate: ["id", "name", "chan_id", "format", "price", "note", "active", "sort", "created_at", "updated_at"]
});
Object.assign(SPJ, { cr_deal: { d: "{}", result: "{}", terms: "null" }, cr_cont: { d: "{}" } });   // 자주 찾지 않는 칸은 d(JSON) 하나에 모읍니다 — 한 줄을 읽는 SQL이 길어지지 않게
const CR_PLAT = ["youtube", "instagram", "tiktok", "naver_blog", "naver_clip", "chzzk", "soop", "threads", "x", "facebook", "newsletter", "brunch", "podcast", "webtoon", "etc"];
const CR_TYPE = ["paid", "gift", "affil", "group", "appear", "license", "etc"];   // 유료 광고 · 제품 협찬 · 제휴(수수료) · 공동구매 · 출연·행사·강연 · 2차 활용(라이선스) · 기타
const CR_STAGE = ["inquiry", "nego", "contract", "making", "review", "posted", "settle", "done", "lost"];   // 문의 · 협의 · 계약 · 제작 · 검수 · 게시 · 정산 대기 · 완료 · 무산
const CR_TAX = ["vat", "wht", "none"];   // 세금계산서(부가세 10% 별도) · 원천징수 · 세금 계산 없음
const CR_FMT = ["long", "short", "live", "post", "story", "blog", "news", "audio", "etc"];   // 긴 영상 · 숏폼 · 라이브 · 피드 게시물 · 스토리 · 블로그 글 · 뉴스레터 · 오디오 · 기타
const CR_CSTAGE = ["idea", "plan", "shoot", "edit", "review", "sched", "posted", "drop"];   // 아이디어 · 기획 · 촬영 · 편집 · 검수 · 예약 · 게시 · 보류
const CR_SRC = ["ads", "sponsor", "affil", "fan", "sales", "lecture", "license", "etc"];   // 플랫폼 광고수익 · 협찬·광고 · 제휴 수수료 · 후원·멤버십 · 상품 판매 · 강의·출연 · 저작권·2차 활용 · 기타
const CR_CUR = ["KRW", "USD", "JPY", "EUR", "etc"];
const CR_LIMIT = { chans: 30, deals: 3000, conts: 5000, incs: 6000, rates: 60, snaps: 2400 };
const CR_TERM_KEYS = ["title", "type", "chan_id", "amount", "tax_mode", "draft_due", "post_due", "pay_due"], CR_TERM_D = ["gift_value", "items", "keep_until", "usage", "usage_until", "excl", "excl_until", "revisions", "guide", "cond"];   // 조건 확인서에 나가는 칸
const crNum = v => numOrNull(typeof v === "string" ? v.replace(/[,\s]/g, "") : v);   // "1,385.5"처럼 쉼표가 든 숫자도 받습니다
const crPct = (v, d) => { const n = Number(v); return Number.isFinite(n) && v !== "" && v !== null ? Math.max(0, Math.min(300, Math.round(n))) : d; };
function crNorm(s) {   // 설정 — 사업 형태·원천징수율, 견적 옵션, 미디어킷
  s = s && typeof s === "object" ? s : {};
  const obj = k => (s[k] && typeof s[k] === "object" ? s[k] : {});
  const b = obj("biz"), o = obj("opts"), k = obj("kit"), a = k.aud && typeof k.aud === "object" ? k.aud : {};
  const wht = Number(b.wht);
  const pct = v => { const n = Number(v); return Number.isFinite(n) && v !== "" && v !== null ? Math.max(0, Math.min(100, Math.round(n))) : null; };
  return {
    set: !!s.set,
    biz: { type: ["none", "exempt", "taxable"].includes(b.type) ? b.type : "none", wht: Number.isFinite(wht) && b.wht !== "" && b.wht !== null ? Math.max(0, Math.min(30, Math.round(wht * 10) / 10)) : 3.3, name: clip(b.name, 40), person: clip(b.person, 30), email: clip(b.email, 80), phone: clip(b.phone, 30) },
    opts: { usage: crPct(o.usage, 30), excl: crPct(o.excl, 20), rush: crPct(o.rush, 30) },
    cpv: mkDec(s.cpv),
    kit: {
      on: !!k.on, name: clip(k.name, 40), tagline: clip(k.tagline, 80), bio: clip(k.bio, 1200),
      topics: (Array.isArray(k.topics) ? k.topics : String(k.topics || "").split(/[,\n]/)).map(x => clip(x, 20)).filter(Boolean).slice(0, 10),
      email: clip(k.email, 80),
      aud: { f: pct(a.f), m: pct(a.m), ages: clip(a.ages, 80), regions: clip(a.regions, 80), note: clip(a.note, 200) },
      picks: (Array.isArray(k.picks) ? k.picks : []).map(x => clip(x, 60)).filter(Boolean).slice(0, 8),
      cases: k.cases !== false, rates: !!k.rates, inquiry: k.inquiry !== false
    },
    checks: (Array.isArray(s.checks) ? s.checks : []).map(x => clip(x, 40)).filter(Boolean).slice(-200)
  };
}
async function crSettings(db, ws) { const m = await modSettings(db, ws, "cr"); return crNorm(m.settings); }
function crTax(gross, mode, rate) {   // 공급가 기준 — vat: 10% 더해 받음 · wht: 원천징수율만큼 떼고 받음
  gross = Math.max(0, intOr(gross, 0));
  const vat = mode === "vat" ? Math.round(gross * 0.1) : 0, wht = mode === "wht" ? Math.round(gross * (Number(rate) || 0) / 100) : 0;
  return { vat, wht, net: gross + vat - wht };
}
function crChanIn(b) {
  const o = {};
  if ("name" in b) o.name = clip(b.name, 40);
  if ("platform" in b) o.platform = CR_PLAT.includes(b.platform) ? b.platform : "etc";
  if ("handle" in b) o.handle = clip(b.handle, 80);
  if ("url" in b) o.url = mkUrl(b.url);
  if ("topic" in b) o.topic = clip(b.topic, 60);
  if ("active" in b) o.active = b.active === false || b.active === 0 ? 0 : 1;
  if ("memo" in b) o.memo = clip(b.memo, 500);
  return o;
}
const crUrls = v => (Array.isArray(v) ? v : String(v || "").split(/\s+/)).map(mkUrl).filter(Boolean).slice(0, 6);
function crResultIn(r) {   // 협찬 결과 — 게시 주소와 성과 숫자
  r = r && typeof r === "object" ? r : {};
  return { urls: crUrls(r.urls), posted_at: dOk(r.posted_at), view: mkInt(r.view, 1e12), likes: mkInt(r.likes, 1e11), cmts: mkInt(r.cmts, 1e11), shares: mkInt(r.shares, 1e11), saves: mkInt(r.saves, 1e11), clk: mkInt(r.clk, 1e11), note: clip(r.note, 1000), at: dOk(r.at) };
}
function crDiscIn(d) {   // 광고 표기 — 어떻게 표시했는지와 점검 항목
  d = d && typeof d === "object" ? d : {};
  return { how: clip(d.how, 120), ok: (Array.isArray(d.ok) ? d.ok : []).map(x => clip(x, 30)).filter(Boolean).slice(0, 20) };
}
/* 협찬 건 — 위 칸(col)과 d(JSON)에 나눠 담습니다. d는 고친 칸만 덮어씁니다 */
function crDealIn(b) {
  const o = {}, d = {};
  if ("brand" in b) o.brand = clip(b.brand, 60);
  if ("title" in b) o.title = clip(b.title, 100);
  if ("type" in b) o.type = CR_TYPE.includes(b.type) ? b.type : "paid";
  if ("stage" in b) o.stage = CR_STAGE.includes(b.stage) ? b.stage : "nego";
  if ("chan_id" in b) o.chan_id = clip(b.chan_id, 60);
  if ("amount" in b) o.amount = mkInt(b.amount, 1e11);
  if ("tax_mode" in b) o.tax_mode = CR_TAX.includes(b.tax_mode) ? b.tax_mode : "none";
  for (const k of ["draft_due", "post_due", "pay_due"]) if (k in b) o[k] = dOk(b[k]) || null;
  if ("result" in b) o.result = JSON.stringify(crResultIn(b.result));
  if ("agency" in b) d.agency = clip(b.agency, 60);
  if ("person" in b) d.person = clip(b.person, 40);
  if ("contact" in b) d.contact = clip(b.contact, 120);
  if ("contact_id" in b) d.contact_id = clip(b.contact_id, 60);
  if ("gift_value" in b) d.gift_value = mkInt(b.gift_value, 1e10);
  if ("items" in b) d.items = clip(b.items, 400);
  for (const k of ["keep_until", "usage_until", "excl_until"]) if (k in b) d[k] = dOk(b[k]);
  if ("usage" in b) d.usage = clip(b.usage, 200);
  if ("excl" in b) d.excl = clip(b.excl, 200);
  if ("revisions" in b) d.revisions = crNum(b.revisions) === null ? null : clampInt(b.revisions, 0, 20, 0);
  if ("guide" in b) d.guide = clip(b.guide, 2000);
  if ("cond" in b) d.cond = clip(b.cond, 1500);
  if ("disc" in b) d.disc = crDiscIn(b.disc);
  if ("lost_reason" in b) d.lost_reason = clip(b.lost_reason, 200);
  if ("show_case" in b) d.show_case = !!b.show_case;
  if ("memo" in b) d.memo = clip(b.memo, 2000);
  return { o, d };
}
const CR_DEAL_D0 = () => ({ agency: "", person: "", contact: "", contact_id: "", gift_value: 0, items: "", keep_until: "", usage: "", usage_until: "", excl: "", excl_until: "", revisions: null, guide: "", cond: "", disc: { how: "", ok: [] }, lost_reason: "", show_case: false, memo: "", reply_note: "", reply_at: "", src: "manual", inq: null, paid_amount: 0, by: "" });
const crDealRow = (o, d, now) => Object.assign({ id: bulkId("cd"), brand: "", title: "", type: "paid", stage: "nego", chan_id: "", amount: 0, tax_mode: "none", draft_due: null, post_due: null, pay_due: null, reply: "", seen: 1, paid_at: null, inc_id: null, result: "{}", terms: null, created_at: now, updated_at: now }, o, { d: Object.assign(CR_DEAL_D0(), d) });
const crD = x => (x && x.d && typeof x.d === "object" ? x.d : {});
function crContIn(b) {
  const o = {}, d = {};
  if ("title" in b) o.title = clip(b.title, 120);
  if ("chan_id" in b) o.chan_id = clip(b.chan_id, 60);
  if ("deal_id" in b) o.deal_id = clip(b.deal_id, 60);
  if ("format" in b) o.format = CR_FMT.includes(b.format) ? b.format : "etc";
  if ("stage" in b) o.stage = CR_CSTAGE.includes(b.stage) ? b.stage : "idea";
  if ("shoot_date" in b) o.shoot_date = dOk(b.shoot_date) || null;
  if ("post_date" in b) o.post_date = dOk(b.post_date) || null;
  if ("url" in b) o.url = mkUrl(b.url);
  for (const k of ["view", "likes", "cmts"]) if (k in b) o[k] = mkInt(b[k], 1e12);
  if ("post_time" in b) d.post_time = tOk(b.post_time);
  if ("checks" in b) d.checks = (Array.isArray(b.checks) ? b.checks : []).map(x => clip(x, 30)).filter(Boolean).slice(0, 30);
  if ("editor" in b) d.editor = clip(b.editor, 40);
  if ("editor_id" in b) d.editor_id = clip(b.editor_id, 60);
  if ("cost" in b) d.cost = mkInt(b.cost, 1e10);
  for (const k of ["shares", "saves"]) if (k in b) d[k] = mkInt(b[k], 1e12);
  if ("stat_at" in b) d.stat_at = dOk(b.stat_at);
  if ("memo" in b) d.memo = clip(b.memo, 4000);
  return { o, d };
}
const CR_CONT_D0 = () => ({ post_time: "", checks: [], editor: "", editor_id: "", cost: 0, shares: 0, saves: 0, stat_at: "", memo: "", by: "" });
const crContRow = (o, d, now) => Object.assign({ id: bulkId("cc"), chan_id: "", deal_id: "", title: "", format: "etc", stage: "idea", shoot_date: null, post_date: null, url: "", view: 0, likes: 0, cmts: 0, created_at: now, updated_at: now }, o, { d: Object.assign(CR_CONT_D0(), d) });
function crIncIn(b) {
  const o = {};
  if ("date" in b) o.date = dOk(b.date);
  if ("ym" in b) o.ym = ymOk(b.ym);
  if ("src" in b) o.src = CR_SRC.includes(b.src) ? b.src : "etc";
  if ("chan_id" in b) o.chan_id = clip(b.chan_id, 60);
  if ("title" in b) o.title = clip(b.title, 100);
  for (const k of ["gross", "vat", "wht"]) if (k in b) o[k] = mkInt(b[k], 1e11);
  if ("cur" in b) o.cur = CR_CUR.includes(b.cur) ? b.cur : "KRW";
  if ("fx_amount" in b) o.fx_amount = crNum(b.fx_amount) === null ? null : mkDec(b.fx_amount);
  if ("fx_rate" in b) o.fx_rate = crNum(b.fx_rate) === null ? null : mkDec(b.fx_rate);
  if ("memo" in b) o.memo = clip(b.memo, 500);
  return o;
}
function crRateIn(b) {
  const o = {};
  if ("name" in b) o.name = clip(b.name, 60);
  if ("chan_id" in b) o.chan_id = clip(b.chan_id, 60);
  if ("format" in b) o.format = CR_FMT.includes(b.format) ? b.format : "etc";
  if ("price" in b) o.price = mkInt(b.price, 1e10);
  if ("note" in b) o.note = clip(b.note, 200);
  if ("active" in b) o.active = b.active === false || b.active === 0 ? 0 : 1;
  return o;
}
const crHas = async (db, ws, t, id) => !!(id && await db.prepare(`SELECT 1 AS x FROM ${t} WHERE ws=?1 AND id=?2`).bind(ws, id).first());
const crCount = async (db, ws, t) => Number(((await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ws=?1`).bind(ws).first()) || {}).n) || 0;
const crIncSrc = type => type === "affil" || type === "group" ? "affil" : type === "license" ? "license" : type === "appear" ? "lecture" : "sponsor";
const crModOn = async (db, ws) => { const w = await db.prepare("SELECT modules FROM workspaces WHERE id=?1").bind(ws).first(); return !!w && (parse(w.modules) || []).includes("creator"); };
const crDealName = d => d.brand + (d.title ? " — " + d.title : "");
async function crAiSummary(db, me) {
  const today = kstToday(), ym = today.slice(0, 7), pm = addDaysS(ym + "-01", -1).slice(0, 7), soon = addDaysS(today, 14);
  const rs = await db.batch([
    db.prepare("SELECT v FROM mod_set WHERE ws=?1 AND mod='cr' AND k='settings'").bind(me.ws),
    db.prepare("SELECT c.id, c.name, c.platform, c.active, (SELECT json_object('ym',s.ym,'subs',s.subs,'views',s.views,'posts',s.posts) FROM cr_snap s WHERE s.ws=c.ws AND s.chan_id=c.id ORDER BY s.ym DESC LIMIT 1) AS snap FROM cr_chan c WHERE c.ws=?1 ORDER BY c.sort, c.created_at").bind(me.ws),
    db.prepare("SELECT id, brand, title, type, stage, chan_id, amount, tax_mode, draft_due, post_due, pay_due, reply, seen, paid_at, d FROM cr_deal WHERE ws=?1 AND stage NOT IN ('done','lost') ORDER BY created_at DESC LIMIT 100").bind(me.ws),
    db.prepare("SELECT id, chan_id, deal_id, title, format, stage, shoot_date, post_date FROM cr_cont WHERE ws=?1 AND stage NOT IN ('posted','drop') AND (post_date IS NULL OR post_date<=?2 OR shoot_date<=?2) ORDER BY COALESCE(shoot_date,post_date,'9999') LIMIT 60").bind(me.ws, soon),
    db.prepare("SELECT ym, src, SUM(gross) AS gross, SUM(net) AS net, COUNT(*) AS n FROM cr_inc WHERE ws=?1 AND ym>=?2 GROUP BY ym, src").bind(me.ws, pm),
    db.prepare("SELECT title, chan_id, format, post_date, view, likes, cmts FROM cr_cont WHERE ws=?1 AND stage='posted' AND post_date>=?2 ORDER BY post_date DESC LIMIT 20").bind(me.ws, addDaysS(today, -30)),
    db.prepare("SELECT brand, d FROM cr_deal WHERE ws=?1 AND stage NOT IN ('inquiry','nego','lost') AND d LIKE '%\"excl_until\":\"2%' ORDER BY created_at DESC LIMIT 200").bind(me.ws)
  ]);
  const R = i => (rs[i] && rs[i].results) || [], s0 = R(0)[0], set = crNorm(s0 ? parse(s0.v) : null), chN = new Map(R(1).map(c => [c.id, c.name]));
  const inc = m => { const rows = R(4).filter(x => x.ym === m), by = {}; let gross = 0, net = 0; for (const x of rows) { by[x.src] = Number(x.gross) || 0; gross += Number(x.gross) || 0; net += Number(x.net) || 0; } return { month: m, gross, received: net, bySource: by }; };
  const deals = R(2).map(x => Object.assign(x, { d: parse(x.d) || {} })), late = d => d && d < today;
  return {
    today, business: { type: set.biz.type, withholdingPct: set.biz.wht },
    channels: R(1).map(c => { const s = parse(c.snap) || {}; return { id: c.id, name: c.name, platform: c.platform, active: !!c.active, subscribers: s.subs ?? null, monthlyViews: s.views ?? null, asOf: s.ym || "" }; }),
    openDeals: deals.map(d => ({ id: d.id, brand: d.brand, title: d.title || "", type: d.type, stage: d.stage, channel: chN.get(d.chan_id) || "", amount: d.amount, taxMode: d.tax_mode, deliverables: d.d.items || "", draftDue: d.draft_due || "", postDue: d.post_due || "", payDue: d.pay_due || "", brandReply: d.reply || "", fromMediaKit: d.d.src === "kit", unread: !Number(d.seen), paid: !!d.paid_at })),
    attention: {
      newInquiries: deals.filter(d => d.stage === "inquiry" && !Number(d.seen)).length,
      draftOverdue: deals.filter(d => ["contract", "making"].includes(d.stage) && late(d.draft_due)).length,
      postOverdue: deals.filter(d => ["contract", "making", "review"].includes(d.stage) && late(d.post_due)).length,
      paymentOverdue: deals.filter(d => ["posted", "settle"].includes(d.stage) && !d.paid_at && late(d.pay_due)).length,
      changeRequested: deals.filter(d => d.reply === "changed").length
    },
    exclusivity: R(6).map(x => ({ brand: x.brand, d: parse(x.d) || {} })).filter(x => x.d.excl && x.d.excl_until >= today).map(x => ({ brand: x.brand, scope: x.d.excl, until: x.d.excl_until })),
    upcomingContent: R(3).map(c => ({ id: c.id, title: c.title, channel: chN.get(c.chan_id) || "", format: c.format, stage: c.stage, shootDate: c.shoot_date || "", postDate: c.post_date || "", sponsored: !!c.deal_id })),
    recentPosts: R(5).map(c => ({ title: c.title, channel: chN.get(c.chan_id) || "", format: c.format, postDate: c.post_date || "", views: c.view, likes: c.likes, comments: c.cmts })),
    income: { thisMonth: inc(ym), lastMonth: inc(pm) },
    hint: "금액은 원입니다. gross는 세금 전(공급가), received는 실제 입금액입니다. 쓰기 토큰은 propose의 cr-idea(콘텐츠 아이디어)·cr-deal(협찬 건)로 제안할 수 있습니다."
  };
}
async function crPropItems(db, me, prop) {   // AI 제안 → 콘텐츠 아이디어 · 협찬 건
  const p = prop.payload, now = iso(), bump = db.prepare("UPDATE workspaces SET sp_ver=sp_ver+1 WHERE id=?1").bind(me.ws);
  const ch0 = p.channel ? await db.prepare("SELECT id, name FROM cr_chan WHERE ws=?1 AND (id=?2 OR name=?2 OR name LIKE ?3) ORDER BY (id=?2) DESC, (name=?2) DESC, LENGTH(name) LIMIT 1").bind(me.ws, p.channel, likeArg(p.channel)).first() : null, ch = ch0 && (ch0.id === p.channel || likeHas(ch0.name, p.channel)) ? ch0 : null;
  if (prop.kind === "cr-idea") {
    const row = crContRow({ chan_id: ch ? ch.id : "", title: p.title, format: CR_FMT.includes(p.format) ? p.format : "etc", stage: "idea", post_date: p.date || null }, { memo: p.memo || "", by: me.id }, now);
    return { items: [actRow(me, `AI 제안으로 콘텐츠 아이디어 "${row.title}"을(를) 더했습니다.`)], stmts: spBulk(db, "cr_cont", me.ws, [row]).concat([bump]), applied: { contentId: row.id, title: row.title, channel: ch ? ch.name : "" } };
  }
  const row = crDealRow({ brand: p.brand, title: p.title, type: CR_TYPE.includes(p.type) ? p.type : "paid", stage: "nego", chan_id: ch ? ch.id : "", amount: p.amount, post_due: p.due || null }, { memo: p.memo || "", src: "ai", by: me.id }, now);
  return { items: [actRow(me, `AI 제안으로 협찬 건 "${crDealName(row)}"을(를) 더했습니다.`)], stmts: spBulk(db, "cr_deal", me.ws, [row]).concat([bump]), applied: { dealId: row.id, brand: row.brand, title: row.title } };
}
const CREA = {
  async data(db, me) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const now = iso();
    const rs = await db.batch([
      db.prepare("SELECT v FROM mod_set WHERE ws=?1 AND mod='cr' AND k='settings'").bind(me.ws),
      db.prepare(spSel("cr_chan", "ws=?1", "ORDER BY sort, created_at")).bind(me.ws),
      db.prepare(spSel("cr_snap", "ws=?1", "ORDER BY ym LIMIT 2400")).bind(me.ws),
      db.prepare(spSel("cr_deal", "ws=?1", "ORDER BY created_at DESC LIMIT 3000")).bind(me.ws),
      db.prepare(spSel("cr_cont", "ws=?1", "ORDER BY COALESCE(post_date,'9999') DESC, created_at DESC LIMIT 5000")).bind(me.ws),
      db.prepare(spSel("cr_inc", "ws=?1", "ORDER BY date DESC, created_at DESC LIMIT 6000")).bind(me.ws),
      db.prepare(spSel("cr_rate", "ws=?1", "ORDER BY sort, created_at")).bind(me.ws),
      db.prepare("SELECT token, created_at, expires_at, views, last_view FROM links WHERE ws=?1 AND kind='cr-kit' AND target='kit' AND expires_at>?2 ORDER BY created_at DESC LIMIT 1").bind(me.ws, now)
    ]);
    const s0 = ((rs[0] && rs[0].results) || [])[0], k = ((rs[7] && rs[7].results) || [])[0];
    return rawJson({ ok: true, v: me.spv, today: kstToday(), settings: crNorm(s0 ? parse(s0.v) : null), kitLink: k ? { token: k.token, createdAt: k.created_at, expiresAt: k.expires_at, views: Number(k.views) || 0, lastView: k.last_view || "" } : null },
      ',"chans":' + rawArr(rs[1]) + ',"snaps":' + rawArr(rs[2]) + ',"deals":' + rawArr(rs[3]) + ',"conts":' + rawArr(rs[4]) + ',"incs":' + rawArr(rs[5]) + ',"rates":' + rawArr(rs[6]));
  },
  async settings(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const cur = await crSettings(db, me.ws), p = b && b.set && typeof b.set === "object" ? b.set : {};
    const merged = Object.assign({}, cur, p);
    for (const k of ["biz", "opts", "kit"]) if (p[k] && typeof p[k] === "object") merged[k] = Object.assign({}, cur[k], p[k]);
    if (p.kit && p.kit.aud && typeof p.kit.aud === "object") merged.kit.aud = Object.assign({}, cur.kit.aud, p.kit.aud);
    const s = crNorm(merged);
    if (JSON.stringify(s).length > 20000) return fail("too-large", 413);
    const { v } = await spRun(db, me, [db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'cr','settings',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(s))]);
    return json({ ok: true, v, settings: s });
  },
  async "chan/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), o = crChanIn(b || {}), now = iso();
    if (!id) {
      if (!o.name) return fail("bad-request");
      const n = await crCount(db, me.ws, "cr_chan");
      if (n >= CR_LIMIT.chans) return fail("limit", 409);
      const row = Object.assign({ id: bulkId("ch"), name: "", platform: "etc", handle: "", url: "", topic: "", active: 1, sort: n + 1, memo: "", created_at: now, updated_at: now }, o);
      const { v } = await spRun(db, me, spBulk(db, "cr_chan", me.ws, [row]));
      return json({ ok: true, v, chan: await spOne(db, "cr_chan", me.ws, row.id) });
    }
    if (!await crHas(db, me.ws, "cr_chan", id)) return fail("not-found", 404);
    if ("name" in o && !o.name) return fail("bad-request");
    o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE cr_chan SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, chan: await spOne(db, "cr_chan", me.ws, id) });
  },
  async "chan/del"(db, me, b) {   // 협찬·콘텐츠·수익이 붙어 있으면 지우지 않습니다 (대신 '쓰지 않음'으로). 월별 숫자는 함께 지웁니다
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60);
    if (!id) return fail("bad-request");
    const u = await db.prepare("SELECT (SELECT COUNT(*) FROM cr_deal WHERE ws=?1 AND chan_id=?2) + (SELECT COUNT(*) FROM cr_cont WHERE ws=?1 AND chan_id=?2) + (SELECT COUNT(*) FROM cr_inc WHERE ws=?1 AND chan_id=?2) AS n").bind(me.ws, id).first();
    if (Number(u && u.n) > 0) return fail("in-use", 409, { n: Number(u.n) });
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM cr_chan WHERE ws=?1 AND id=?2").bind(me.ws, id), db.prepare("DELETE FROM cr_snap WHERE ws=?1 AND chan_id=?2").bind(me.ws, id), db.prepare("UPDATE cr_rate SET chan_id='' WHERE ws=?1 AND chan_id=?2").bind(me.ws, id)]);
    return json({ ok: true, v });
  },
  // 채널의 월별 숫자 — 같은 채널·같은 달은 한 줄만 둡니다 (다시 적으면 고칩니다)
  async "snap/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const chan = clip(b.chan_id, 60), ym = ymOk(b.ym);
    if (!ym) return fail("bad-date");
    if (!await crHas(db, me.ws, "cr_chan", chan)) return fail("bad-channel");
    if (await crCount(db, me.ws, "cr_snap") >= CR_LIMIT.snaps) return fail("limit", 409);
    const row = { id: bulkId("cs"), chan_id: chan, ym, subs: mkInt(b.subs, 1e10), views: mkInt(b.views, 1e12), posts: mkInt(b.posts, 1e5), memo: clip(b.memo, 200), updated_at: iso() };
    const { v } = await spRun(db, me, spBulk(db, "cr_snap", me.ws, [row], "ON CONFLICT(ws,chan_id,ym) DO UPDATE SET subs=excluded.subs, views=excluded.views, posts=excluded.posts, memo=excluded.memo, updated_at=excluded.updated_at"));
    const r = await db.prepare(spSel("cr_snap", "ws=?1 AND chan_id=?2 AND ym=?3")).bind(me.ws, chan, ym).first();
    return json({ ok: true, v, snap: r ? parse(r.j) : null });
  },
  async "snap/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM cr_snap WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },
  async "deal/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), { o, d } = crDealIn(b || {}), now = iso();
    if (o.chan_id && !await crHas(db, me.ws, "cr_chan", o.chan_id)) return fail("bad-channel");
    if (!id) {
      if (!o.brand) return fail("bad-request");
      if (await crCount(db, me.ws, "cr_deal") >= CR_LIMIT.deals) return fail("limit", 409);
      const row = crDealRow(o, Object.assign(d, { by: me.id }), now);
      const { v } = await spRun(db, me, spBulk(db, "cr_deal", me.ws, [row]));
      return json({ ok: true, v, deal: await spOne(db, "cr_deal", me.ws, row.id) });
    }
    const cur = await spOne(db, "cr_deal", me.ws, id);
    if (!cur) return fail("not-found", 404);
    if ("brand" in o && !o.brand) return fail("bad-request");
    const cd = Object.assign(CR_DEAL_D0(), crD(cur));
    // 브랜드가 수정을 요청한 뒤 조건을 고치면 다시 '확인 대기'로 돌립니다. 다시 확인받기(reply:"")로도 돌릴 수 있습니다
    const touched = CR_TERM_KEYS.some(k => k in o && String(o[k] ?? "") !== String(cur[k] ?? "")) || CR_TERM_D.some(k => k in d && String(d[k] ?? "") !== String(cd[k] ?? ""));
    if ((cur.reply === "changed" && touched) || (b.reply === "" && cur.reply)) { o.reply = ""; d.reply_note = ""; d.reply_at = ""; }
    o.d = JSON.stringify(Object.assign(cd, d));
    o.seen = 1; o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE cr_deal SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, deal: await spOne(db, "cr_deal", me.ws, id) });
  },
  async "deal/seen"(db, me, b) {   // 미디어킷으로 들어온 문의나 브랜드의 답을 열어 봤다는 표시
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("UPDATE cr_deal SET seen=1 WHERE ws=?1 AND id=?2 AND seen=0").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },
  // 입금 확인 — 수익 기록 한 줄을 만들고(이미 있으면 고치고), 게시가 끝난 건은 '완료'로 넘깁니다
  async "deal/paid"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), d = await spOne(db, "cr_deal", me.ws, id);
    if (!d) return fail("not-found", 404);
    const date = dOk(b.date) || kstToday(), set = await crSettings(db, me.ws), now = iso();
    const gross = crNum(b.amount) !== null ? mkInt(b.amount, 1e11) : d.amount;
    if (!gross) return fail("no-amount");
    const t = crTax(gross, d.tax_mode, set.biz.wht), has = await crHas(db, me.ws, "cr_inc", d.inc_id);
    if (!has && await crCount(db, me.ws, "cr_inc") >= CR_LIMIT.incs) return fail("limit", 409);
    const inc = { id: has ? d.inc_id : bulkId("ci"), date, ym: date.slice(0, 7), src: crIncSrc(d.type), chan_id: d.chan_id || "", deal_id: d.id, title: clip(crDealName(d), 100), gross, vat: t.vat, wht: t.wht, net: t.net, cur: "KRW", fx_amount: null, fx_rate: null, memo: "", created_at: now, updated_at: now };
    const stmts = has
      ? [db.prepare("UPDATE cr_inc SET date=?3, ym=?4, gross=?5, vat=?6, wht=?7, net=?8, updated_at=?9 WHERE ws=?1 AND id=?2").bind(me.ws, inc.id, date, inc.ym, gross, t.vat, t.wht, t.net, now)]
      : spBulk(db, "cr_inc", me.ws, [inc]);
    stmts.push(db.prepare("UPDATE cr_deal SET paid_at=?3, inc_id=?4, d=?5, stage=CASE WHEN stage IN ('posted','settle') THEN 'done' ELSE stage END, seen=1, updated_at=?6 WHERE ws=?1 AND id=?2").bind(me.ws, id, date, inc.id, JSON.stringify(Object.assign(CR_DEAL_D0(), crD(d), { paid_amount: t.net })), now));
    const { v } = await spRun(db, me, stmts);
    return json({ ok: true, v, deal: await spOne(db, "cr_deal", me.ws, id), inc: await spOne(db, "cr_inc", me.ws, inc.id) });
  },
  async "deal/unpaid"(db, me, b) {   // 입금 확인 취소 — 수익 기록도 함께 지웁니다
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), d = await spOne(db, "cr_deal", me.ws, id);
    if (!d) return fail("not-found", 404);
    const { v } = await spRun(db, me, [
      db.prepare("DELETE FROM cr_inc WHERE ws=?1 AND id=?2").bind(me.ws, d.inc_id || ""),
      db.prepare("UPDATE cr_deal SET paid_at=NULL, inc_id=NULL, d=?3, stage=CASE WHEN stage='done' THEN 'settle' ELSE stage END, updated_at=?4 WHERE ws=?1 AND id=?2").bind(me.ws, id, JSON.stringify(Object.assign(CR_DEAL_D0(), crD(d), { paid_amount: 0 })), iso())
    ]);
    return json({ ok: true, v, deal: await spOne(db, "cr_deal", me.ws, id), incId: d.inc_id || "" });
  },
  async "deal/del"(db, me, b) {   // 협찬 건을 지웁니다. 콘텐츠와 수익 기록은 남기고 연결만 떼며, 보낸 확인서·보고서 링크는 닫습니다
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60);
    if (!id) return fail("bad-request");
    const { v } = await spRun(db, me, [
      db.prepare("DELETE FROM cr_deal WHERE ws=?1 AND id=?2").bind(me.ws, id),
      db.prepare("UPDATE cr_cont SET deal_id='' WHERE ws=?1 AND deal_id=?2").bind(me.ws, id),
      db.prepare("UPDATE cr_inc SET deal_id='' WHERE ws=?1 AND deal_id=?2").bind(me.ws, id),
      db.prepare("UPDATE links SET expires_at=?3 WHERE ws=?1 AND kind IN ('cr-deal','cr-report') AND target=?2 AND expires_at>?3").bind(me.ws, id, new Date(Date.now() - 1000).toISOString())
    ]);
    return json({ ok: true, v });
  },
  async "cont/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), { o, d } = crContIn(b || {}), now = iso();
    if (o.chan_id && !await crHas(db, me.ws, "cr_chan", o.chan_id)) return fail("bad-channel");
    if (o.deal_id && !await crHas(db, me.ws, "cr_deal", o.deal_id)) return fail("bad-deal");
    if (!id) {
      if (!o.title) return fail("bad-request");
      if (await crCount(db, me.ws, "cr_cont") >= CR_LIMIT.conts) return fail("limit", 409);
      if (o.stage === "posted" && !o.post_date) o.post_date = kstToday();
      const row = crContRow(o, Object.assign(d, { by: me.id }), now);
      const { v } = await spRun(db, me, spBulk(db, "cr_cont", me.ws, [row]));
      return json({ ok: true, v, cont: await spOne(db, "cr_cont", me.ws, row.id) });
    }
    const cur = await spOne(db, "cr_cont", me.ws, id);
    if (!cur) return fail("not-found", 404);
    if ("title" in o && !o.title) return fail("bad-request");
    if (o.stage === "posted" && !("post_date" in o ? o.post_date : cur.post_date)) o.post_date = kstToday();   // 게시로 옮기면 날짜가 비어 있을 때 오늘로 적습니다
    o.d = JSON.stringify(Object.assign(CR_CONT_D0(), crD(cur), d));
    o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE cr_cont SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, cont: await spOne(db, "cr_cont", me.ws, id) });
  },
  async "cont/bulk"(db, me, b) {   // 아이디어 여러 개 한 번에
    if (!isMgr(me)) return fail("forbidden", 403);
    const now = iso(), have = await crCount(db, me.ws, "cr_cont");
    const chans = new Set(((await db.prepare("SELECT id FROM cr_chan WHERE ws=?1").bind(me.ws).all()).results || []).map(r => r.id));
    const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 100).map(r => crContIn(r && typeof r === "object" ? r : {})).filter(x => x.o.title).map(({ o, d }) => { if (o.chan_id && !chans.has(o.chan_id)) o.chan_id = ""; o.deal_id = ""; return crContRow(o, Object.assign(d, { by: me.id }), now); });
    if (!rows.length) return fail("empty");
    if (have + rows.length > CR_LIMIT.conts) return fail("limit", 409);
    const { v } = await spRun(db, me, spBulk(db, "cr_cont", me.ws, rows));
    return json({ ok: true, v, made: rows.length });
  },
  async "cont/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM cr_cont WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },
  // 수익 한 줄 — 외화는 금액과 환율을 함께 적으면 원화로 바꿔 둡니다. 받은 돈(net) = 세금 전 금액 + 부가세 − 원천징수
  async "inc/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), o = crIncIn(b || {}), now = iso();
    if (o.chan_id && !await crHas(db, me.ws, "cr_chan", o.chan_id)) return fail("bad-channel");
    const cur = id ? await spOne(db, "cr_inc", me.ws, id) : null;
    if (id && !cur) return fail("not-found", 404);
    const m = Object.assign({ date: "", ym: "", src: "etc", chan_id: "", deal_id: "", title: "", gross: 0, vat: 0, wht: 0, net: 0, cur: "KRW", fx_amount: null, fx_rate: null, memo: "" }, cur || {}, o);
    if (!m.date) return fail("bad-date");
    if (!o.ym) m.ym = cur && !("date" in o) ? cur.ym : m.date.slice(0, 7);
    if (m.cur === "KRW") { m.fx_amount = null; m.fx_rate = null; }
    else if (m.fx_amount && m.fx_rate && !o.gross) m.gross = Math.round(m.fx_amount * m.fx_rate);
    if (!m.gross) return fail("no-amount");
    m.net = Math.max(0, m.gross + m.vat - m.wht);
    if (!cur) {
      if (await crCount(db, me.ws, "cr_inc") >= CR_LIMIT.incs) return fail("limit", 409);
      const row = Object.assign(m, { id: bulkId("ci"), created_at: now, updated_at: now });
      const { v } = await spRun(db, me, spBulk(db, "cr_inc", me.ws, [row]));
      return json({ ok: true, v, inc: await spOne(db, "cr_inc", me.ws, row.id) });
    }
    const u = { date: m.date, ym: m.ym, src: m.src, chan_id: m.chan_id, title: m.title, gross: m.gross, vat: m.vat, wht: m.wht, net: m.net, cur: m.cur, fx_amount: m.fx_amount, fx_rate: m.fx_rate, memo: m.memo, updated_at: now };
    const stmts = [db.prepare(`UPDATE cr_inc SET ${setCols(u, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(u))];
    if (cur.deal_id) stmts.push(db.prepare("UPDATE cr_deal SET paid_at=?3, d=json_set(CASE WHEN json_valid(d) THEN d ELSE '{}' END,'$.paid_amount',?4) WHERE ws=?1 AND id=?2 AND inc_id=?5").bind(me.ws, cur.deal_id, m.date, m.net, id));   // 협찬 입금으로 생긴 줄을 고치면 협찬 건의 입금 기록도 맞춥니다
    const { v } = await spRun(db, me, stmts);
    return json({ ok: true, v, inc: await spOne(db, "cr_inc", me.ws, id) });
  },
  async "inc/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60);
    const { v } = await spRun(db, me, [
      db.prepare("UPDATE cr_deal SET paid_at=NULL, inc_id=NULL, d=json_set(CASE WHEN json_valid(d) THEN d ELSE '{}' END,'$.paid_amount',0), stage=CASE WHEN stage='done' THEN 'settle' ELSE stage END WHERE ws=?1 AND inc_id=?2").bind(me.ws, id),
      db.prepare("DELETE FROM cr_inc WHERE ws=?1 AND id=?2").bind(me.ws, id)
    ]);
    return json({ ok: true, v });
  },
  async "rate/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), o = crRateIn(b || {}), now = iso();
    if (o.chan_id && !await crHas(db, me.ws, "cr_chan", o.chan_id)) return fail("bad-channel");
    if (!id) {
      if (!o.name) return fail("bad-request");
      const n = await crCount(db, me.ws, "cr_rate");
      if (n >= CR_LIMIT.rates) return fail("limit", 409);
      const row = Object.assign({ id: bulkId("cr"), name: "", chan_id: "", format: "etc", price: 0, note: "", active: 1, sort: n + 1, created_at: now, updated_at: now }, o);
      const { v } = await spRun(db, me, spBulk(db, "cr_rate", me.ws, [row]));
      return json({ ok: true, v, rate: await spOne(db, "cr_rate", me.ws, row.id) });
    }
    if (!await crHas(db, me.ws, "cr_rate", id)) return fail("not-found", 404);
    if ("name" in o && !o.name) return fail("bad-request");
    o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE cr_rate SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, rate: await spOne(db, "cr_rate", me.ws, id) });
  },
  async "rate/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM cr_rate WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  }
};

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
      stmts.push(...upserts(db, l.ws, [{ kind: "act", id: uid("a"), own: l.created_by, data: { id: uid("a"), ts: now.slice(5, 16).replace("T", " ").replace("-", "/"), who: clip(by, 40) || "고객", by: "", createdAt: now, text: josa(`견적 "${q.no || (j ? j.title : "")}"을(를) ${st === "approved" ? "승인했습니다" : "수정 요청했습니다"}.${note ? " — " + clip(note, 120) : ""}`) } }], ts()));
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
      await db.batch([...upserts(db, l.ws, [{ kind: "task", id: t.id, data: d }, { kind: "act", id: uid("a"), own: l.created_by, data: { id: uid("a"), ts: now.slice(5, 16).replace("T", " ").replace("-", "/"), who: clip(by, 40) || "고객", by: "", createdAt: now, text: josa(`납품 "${t.title}"을(를) ${action === "approve" ? "확인했습니다" : "수정 요청했습니다"}.${note ? " — " + clip(note, 120) : ""}`) } }], ts())]);
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
  },
  po: {   // 발주서 확인 — 공급처가 계정 없이 발주 내용을 보고 확인·변경 요청
    exists: async (db, me, id) => isMgr(me) && !!(await db.prepare("SELECT 1 AS x FROM cm_po WHERE ws=?1 AND id=?2 AND status<>'cancel'").bind(me.ws, id).first()),
    view: async (db, l) => {
      const p = await spOneT(db, "cm_po", l.ws, l.target); if (!p) return null;
      const [w, sp] = await db.batch([db.prepare("SELECT name FROM workspaces WHERE id=?1").bind(l.ws), db.prepare("SELECT name, contact FROM cm_supplier WHERE ws=?1 AND id=?2").bind(l.ws, p.supplier_id || "")]);
      const one = r => ((r && r.results) || [])[0] || {};
      const st = p.status === "confirmed" || p.status === "received" ? "approved" : p.status === "changed" ? "changed" : p.status === "sent" ? "pending" : p.status === "cancel" ? "cancel" : "draft";
      return { kind: "po", title: `발주서 ${p.no || ""}`, client: one(sp).name || "", company: one(sp).contact || "", sender: { workspace: one(w).name || "" }, po: { no: p.no, items: (p.items || []).map(x => ({ name: x.name, option: x.option || "", qty: x.qty, cost: x.cost })), total: p.total, expected: p.expected || "", memo: p.memo || "", ordered_at: p.ordered_at || "" }, status: st, reply_note: p.reply_note || "" };
    },
    act: async (db, l, action, note, by) => {
      const p = await spOneT(db, "cm_po", l.ws, l.target); if (!p) return { error: "not-found" };
      if (!["sent", "changed"].includes(p.status) || (p.status === "changed" && action === "change")) return { error: "bad-state" };
      const st = action === "approve" ? "confirmed" : "changed", now = iso();
      await db.batch([db.prepare("UPDATE cm_po SET status=?3, reply_note=?4, replied_by=?5, replied_at=?6, updated_at=?6 WHERE ws=?1 AND id=?2").bind(l.ws, p.id, st, clip(note, 500), clip(by, 40), now), db.prepare("UPDATE workspaces SET sp_ver=sp_ver+1 WHERE id=?1").bind(l.ws)]);
      return { ok: true, status: st === "confirmed" ? "approved" : "changed" };
    }
  },
  payslip: {   // 임금명세서 — 근무자가 계정 없이 받아 보고 '받았습니다' 또는 '문의합니다'
    exists: async (db, me, id) => me.role === "admin" && !!(await db.prepare("SELECT 1 AS x FROM pp_pay WHERE ws=?1 AND id=?2 AND status<>'draft'").bind(me.ws, id).first()),
    view: async (db, l) => {
      const p = await spOneT(db, "pp_pay", l.ws, l.target); if (!p || p.status === "draft") return null;
      const [w, s] = await db.batch([db.prepare("SELECT name FROM workspaces WHERE id=?1").bind(l.ws), db.prepare("SELECT name, birth FROM pp_staff WHERE ws=?1 AND id=?2").bind(l.ws, p.staff_id)]);
      const one = r => ((r && r.results) || [])[0] || {};
      const st = one(s);
      return { kind: "payslip", title: `${p.period.replace(/^(\d{4})-(\d{2})(-W(\d))?$/, (m, y, mo, w2, wk) => `${y}년 ${+mo}월${wk ? ` ${wk}주` : ""}`)} 임금명세서`, client: st.name || "", company: "", sender: { workspace: one(w).name || "" }, pay: { period: p.period, pfrom: p.pfrom || "", pto: p.pto || "", pay_date: p.pay_date || p.paid_at || "", items: p.items || [], deds: p.deds || [], gross: p.gross, ded: p.ded, net: p.net, birth: st.birth || "", paid: p.status === "paid" }, status: l.used_at ? (l.result === "changed" ? "changed" : "approved") : "pending" };
    },
    act: async (db, l, action) => {
      const p = await spOneT(db, "pp_pay", l.ws, l.target); if (!p || p.status === "draft") return { error: "not-found" };
      await db.prepare("UPDATE workspaces SET sp_ver=sp_ver+1 WHERE id=?1").bind(l.ws).run();
      return { ok: true, status: action === "approve" ? "approved" : "changed" };
    }
  },
  project: {   // 진행 상황 공유 — 계정 없이 보는 읽기 전용 페이지 (금액·메모·의견은 보내지 않습니다)
    exists: async (db, me, id) => {
      const d = await entData(db, me.ws, "project", id); if (!d) return false;
      return me.role === "admin" || d.ownerId === me.id || (Array.isArray(d.memberIds) && d.memberIds.includes(me.id));
    },
    view: async (db, l) => {
      const p = await entData(db, l.ws, "project", l.target); if (!p) return null;
      const opts = parse(l.opts) || {};
      const [w, by, tr] = await db.batch([
        db.prepare("SELECT name FROM workspaces WHERE id=?1").bind(l.ws),
        db.prepare("SELECT name FROM accounts WHERE ws=?1 AND member_id=?2").bind(l.ws, l.created_by || ""),
        db.prepare("SELECT data FROM ent WHERE ws=?1 AND kind='task' AND pid=?2 AND deleted=0").bind(l.ws, p.id)
      ]);
      const one = r => ((r && r.results) || [])[0] || {};
      const ORD = { "진행중": 0, "검토": 1, "대기": 2, "완료": 3 };
      const tasks = (((tr && tr.results) || []).map(r => parse(r.data)).filter(Boolean))
        .map(t => ({ title: clip(t.title, 120), status: TASK_ST.includes(t.status) ? t.status : "대기", due: dOk(t.due), done: t.status === "완료", at: String(t.updatedAt || t.createdAt || "") }));
      const done = tasks.filter(t => t.done).length;
      const last = [p.updatedAt || "", ...tasks.map(t => t.at)].filter(Boolean).sort().pop() || "";
      const list = opts.tasks === false ? [] : tasks.slice().sort((a, b) => (ORD[a.status] ?? 9) - (ORD[b.status] ?? 9) || (a.due || "9999").localeCompare(b.due || "9999")).slice(0, 200).map(({ title, status, due }) => ({ title, status, due }));
      return {
        kind: "project", title: clip(p.name, 80), summary: clip(p.summary, 500), status: clip(p.status, 20), start: dOk(p.startDate), due: dOk(p.dueDate),
        goals: (Array.isArray(p.goals) ? p.goals : []).map(g => clip(g, 200)).filter(Boolean).slice(0, 10),
        progress: { done, total: tasks.length, pct: tasks.length ? Math.round(done / tasks.length * 100) : 0 },
        tasks: list, showTasks: opts.tasks !== false, updatedAt: last,
        sender: { workspace: one(w).name || "", name: one(by).name || "" }
      };
    },
    act: async () => ({ error: "bad-state" })
  }
};
async function entData(db, ws, kind, id) { const r = await db.prepare("SELECT data FROM ent WHERE ws=?1 AND kind=?2 AND id=?3 AND deleted=0").bind(ws, kind, String(id)).first(); return r ? parse(r.data) : null; }
const LINK_NT = {   // [확인했을 때, 수정·문의를 남겼을 때, 눌렀을 때 열 화면]
  quote: ["견적이 승인되었습니다", "견적 수정 요청이 왔습니다", "#/outsourcing/quotes"],
  delivery: ["납품을 확인했습니다", "납품 수정 요청이 왔습니다", "#/board"],
  invoice: ["청구서를 확인했습니다", "청구서에 문의가 왔습니다", "#/outsourcing/bills"],
  po: ["공급처가 발주서를 확인했습니다", "발주서 변경 요청이 왔습니다", "#/commerce/po"],
  payslip: ["임금명세서를 받았다고 확인했습니다", "임금명세서에 문의가 왔습니다", "#/people/pay"],
  "cr-deal": ["협찬 조건을 확인했습니다", "협찬 조건 수정 요청이 왔습니다", "#/creator/deal"]
};
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
  if (!expired) await db.prepare("UPDATE links SET views=views+1, last_view=?2 WHERE token=?1").bind(l.token, iso()).run();
  return json({ ok: true, expired, usedAt: l.used_at || "", result: l.result || "", expiresAt: l.expires_at, view: v, ref: await wsRef(db, l.ws) });
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
  const NT = LINK_NT[l.kind];   // 보낸 사람에게 알림 — 누가 무엇에 어떻게 답했는지
  if (NT) await notify(db, l.ws, l.created_by ? [l.created_by] : await whoIs(db, l.ws, ["admin"]), { type: "reply", title: NT[r.status === "approved" ? 0 : 1], body: [clip(b.by, 40), clip(b.note, 120)].filter(Boolean).join(" — "), url: NT[2], tag: "link:" + l.token.slice(0, 12) });
  return json({ ok: true, status: r.status });
};

/* ───────── 마이크리에이터 공개 링크 — 미디어킷 · 협찬 조건 확인서 · 결과 보고서 ─────────
   · 미디어킷(cr-kit)은 워크스페이스에 하나입니다. 채널 숫자·대표 콘텐츠·협업 사례를 보여 주고 협찬 문의를 받습니다.
   · 조건 확인서(cr-deal)는 브랜드 담당자가 가입 없이 조건을 확인하거나 수정을 요청합니다. 확인하면 그때의 조건을 그대로 남겨 둡니다.
   · 결과 보고서(cr-report)는 보기 전용입니다. */
const crSender = async (db, ws, set) => { const w = await db.prepare("SELECT name FROM workspaces WHERE id=?1").bind(ws).first(); return { workspace: set.biz.name || (w && w.name) || "", name: set.biz.person, email: set.biz.email, phone: set.biz.phone }; };   // 활동명(없으면 워크스페이스 이름)과 담당자 이름
const crTermsOf = (d, chName, set) => { const t = crTax(d.amount, d.tax_mode, set.biz.wht), x = crD(d); return { type: d.type, channel: chName || "", items: x.items || "", amount: d.amount, tax_mode: d.tax_mode, vat: t.vat, wht: t.wht, wht_pct: set.biz.wht, total: d.amount + t.vat, net: t.net, gift_value: x.gift_value || 0, draft_due: d.draft_due || "", post_due: d.post_due || "", pay_due: d.pay_due || "", keep_until: x.keep_until || "", usage: x.usage || "", usage_until: x.usage_until || "", excl: x.excl || "", excl_until: x.excl_until || "", revisions: x.revisions ?? null, guide: x.guide || "", cond: x.cond || "", disclosure: (x.disc && x.disc.how) || "" }; };
Object.assign(LINK_KINDS, {
  "cr-kit": {
    exists: async (db, me, id) => isMgr(me) && id === "kit" && hasMod(me, "creator"),
    view: async (db, l) => {
      if (!await crModOn(db, l.ws)) return null;
      const set = await crSettings(db, l.ws), k = set.kit;
      if (!k.on) return null;
      const rs = await db.batch([
        db.prepare("SELECT id, name, platform, handle, url, topic FROM cr_chan WHERE ws=?1 AND active=1 ORDER BY sort, created_at LIMIT 12").bind(l.ws),
        db.prepare("SELECT chan_id, ym, subs, views, posts FROM cr_snap WHERE ws=?1 ORDER BY ym DESC LIMIT 400").bind(l.ws),
        db.prepare("SELECT id, chan_id, title, format, url, view, likes, cmts, post_date FROM cr_cont WHERE ws=?1 AND stage='posted' ORDER BY post_date DESC LIMIT 400").bind(l.ws),
        db.prepare("SELECT brand, title, type, result, d FROM cr_deal WHERE ws=?1 AND stage IN ('posted','settle','done') ORDER BY updated_at DESC LIMIT 300").bind(l.ws),
        db.prepare("SELECT name, chan_id, format, price, note FROM cr_rate WHERE ws=?1 AND active=1 ORDER BY sort, created_at LIMIT 30").bind(l.ws)
      ]);
      const R = i => (rs[i] && rs[i].results) || [], chN = new Map(R(0).map(c => [c.id, c.name])), posted = R(2), since = addDaysS(kstToday(), -90);
      let asOf = "";
      const channels = R(0).map(c => {   // 숫자를 하나도 적지 않은 채널은 빼고 보여 줍니다
        const sn = R(1).filter(s => s.chan_id === c.id), last = sn[0] || null, m3 = sn.slice(0, 3).filter(s => Number(s.views) > 0);
        const rec = posted.filter(p => p.chan_id === c.id && Number(p.view) > 0 && (p.post_date || "") >= since).slice(0, 10);
        if (last && last.ym > asOf) asOf = last.ym;
        return { name: c.name, platform: c.platform, handle: c.handle || "", url: c.url || "", topic: c.topic || "", subs: last ? Number(last.subs) || 0 : null, monthViews: m3.length ? Math.round(m3.reduce((s, x) => s + Number(x.views), 0) / m3.length) : null, avgView: rec.length ? Math.round(rec.reduce((s, x) => s + Number(x.view), 0) / rec.length) : null, avgN: rec.length };
      }).filter(c => c.subs != null || c.avgView != null);
      const picks = k.picks.map(id => posted.find(p => p.id === id)).filter(p => p && p.url).map(p => ({ title: p.title, url: p.url, format: p.format, channel: chN.get(p.chan_id) || "", view: Number(p.view) || 0, date: p.post_date || "" }));
      const cases = k.cases ? R(3).filter(d => (parse(d.d) || {}).show_case).slice(0, 12).map(d => { const r = parse(d.result) || {}; return { brand: d.brand, title: d.title || "", type: d.type, url: (Array.isArray(r.urls) && r.urls[0]) || "" }; }) : [];   // '사례로 보여 주기'를 켠 건만
      const rates = k.rates ? R(4).map(r => ({ name: r.name, channel: chN.get(r.chan_id) || "", format: r.format, price: Number(r.price) || 0, note: r.note || "" })) : [];
      const sender = await crSender(db, l.ws, set);
      return { kind: "cr-kit", title: k.name || sender.workspace, tagline: k.tagline, bio: k.bio, topics: k.topics, email: k.email, aud: k.aud, channels, picks, cases, rates, inquiry: !!k.inquiry, asOf, sender: { workspace: sender.workspace, name: sender.name } };
    },
    act: async () => ({ error: "bad-state" })
  },
  "cr-deal": {
    exists: async (db, me, id) => isMgr(me) && hasMod(me, "creator") && !!(await db.prepare("SELECT 1 AS x FROM cr_deal WHERE ws=?1 AND id=?2 AND stage<>'lost'").bind(me.ws, id).first()),
    view: async (db, l) => {
      const d = await spOneT(db, "cr_deal", l.ws, l.target); if (!d) return null;
      const set = await crSettings(db, l.ws), ch = d.chan_id ? await db.prepare("SELECT name FROM cr_chan WHERE ws=?1 AND id=?2").bind(l.ws, d.chan_id).first() : null;
      const agreed = d.reply === "approved" && d.terms && typeof d.terms === "object" ? d.terms : null;   // 확인을 마친 뒤에는 그때 확인한 조건을 보여 줍니다
      return { kind: "cr-deal", title: d.title || "협찬 조건", client: d.brand, company: crD(d).agency || "", sender: await crSender(db, l.ws, set), deal: agreed || crTermsOf(d, ch && ch.name, set), agreedAt: agreed ? agreed.at || "" : "", agreedBy: agreed ? agreed.by || "" : "", status: d.stage === "lost" ? "cancel" : d.reply === "approved" ? "approved" : d.reply === "changed" ? "changed" : "pending", reply_note: crD(d).reply_note || "" };
    },
    act: async (db, l, action, note, by) => {
      const d = await spOneT(db, "cr_deal", l.ws, l.target); if (!d) return { error: "not-found" };
      if (d.stage === "lost" || d.reply === "approved") return { error: "bad-state" };
      const now = iso(), who = clip(by, 40), set = await crSettings(db, l.ws);
      const ch = d.chan_id ? await db.prepare("SELECT name FROM cr_chan WHERE ws=?1 AND id=?2").bind(l.ws, d.chan_id).first() : null;
      const ok = action === "approve";
      const nd = JSON.stringify(Object.assign(CR_DEAL_D0(), crD(d), { reply_note: clip(note, 500), reply_at: now }));
      const stmts = [ok
        ? db.prepare("UPDATE cr_deal SET reply='approved', d=?3, terms=?5, stage=CASE WHEN stage IN ('inquiry','nego') THEN 'contract' ELSE stage END, seen=0, updated_at=?4 WHERE ws=?1 AND id=?2").bind(l.ws, d.id, nd, now, JSON.stringify(Object.assign(crTermsOf(d, ch && ch.name, set), { at: now, by: who })))
        : db.prepare("UPDATE cr_deal SET reply='changed', d=?3, stage=CASE WHEN stage='inquiry' THEN 'nego' ELSE stage END, seen=0, updated_at=?4 WHERE ws=?1 AND id=?2").bind(l.ws, d.id, nd, now)];
      stmts.push(...upserts(db, l.ws, [{ kind: "act", id: uid("a"), own: l.created_by, data: { id: uid("a"), ts: now.slice(5, 16).replace("T", " ").replace("-", "/"), who: who || d.brand || "브랜드", by: "", createdAt: now, text: `협찬 "${crDealName(d)}" 조건을 ${ok ? "확인했습니다" : "수정 요청했습니다"}.${note ? " — " + clip(note, 120) : ""}` } }], ts()));
      stmts.push(db.prepare("UPDATE workspaces SET sp_ver=sp_ver+1 WHERE id=?1").bind(l.ws));
      await db.batch(stmts);
      return { ok: true, status: ok ? "approved" : "changed" };
    }
  },
  "cr-report": {
    exists: async (db, me, id) => isMgr(me) && hasMod(me, "creator") && !!(await db.prepare("SELECT 1 AS x FROM cr_deal WHERE ws=?1 AND id=?2 AND stage IN ('posted','settle','done')").bind(me.ws, id).first()),
    view: async (db, l) => {
      const d = await spOneT(db, "cr_deal", l.ws, l.target); if (!d) return null;
      const set = await crSettings(db, l.ws), r = d.result && typeof d.result === "object" ? d.result : {};
      const rs = await db.batch([
        db.prepare("SELECT name FROM cr_chan WHERE ws=?1 AND id=?2").bind(l.ws, d.chan_id || ""),
        db.prepare("SELECT c.title, c.format, c.url, c.post_date, c.view, c.likes, c.cmts, c.d, h.name AS chan FROM cr_cont c LEFT JOIN cr_chan h ON h.ws=c.ws AND h.id=c.chan_id WHERE c.ws=?1 AND c.deal_id=?2 AND c.stage='posted' ORDER BY c.post_date LIMIT 20").bind(l.ws, d.id)
      ]);
      const ch = ((rs[0] && rs[0].results) || [])[0], conts = ((rs[1] && rs[1].results) || []).map(c => { const x = parse(c.d) || {}; return { title: c.title, format: c.format, channel: c.chan || "", url: c.url || "", date: c.post_date || "", view: Number(c.view) || 0, likes: Number(c.likes) || 0, cmts: Number(c.cmts) || 0, shares: Number(x.shares) || 0, saves: Number(x.saves) || 0, at: x.stat_at || "" }; });
      return { kind: "cr-report", title: d.title || "협찬 결과", client: d.brand, company: crD(d).agency || "", sender: await crSender(db, l.ws, set), report: { channel: (ch && ch.name) || "", items: crD(d).items || "", urls: Array.isArray(r.urls) ? r.urls : [], posted_at: r.posted_at || "", view: Number(r.view) || 0, likes: Number(r.likes) || 0, cmts: Number(r.cmts) || 0, shares: Number(r.shares) || 0, saves: Number(r.saves) || 0, clk: Number(r.clk) || 0, note: r.note || "", at: r.at || "", contents: conts, disclosure: (crD(d).disc && crD(d).disc.how) || "" } };
    },
    act: async () => ({ error: "bad-state" })
  }
});
// 미디어킷의 협찬 문의 — 가입 없이 적어 보내면 협찬의 '문의' 칸에 들어갑니다. 워크스페이스마다 하루 40건까지 받습니다
PUBLIC["link/inquiry"] = async function (db, b) {
  const l = await linkRow(db, b.t);
  if (!l || l.kind !== "cr-kit") return fail("not-found", 404);
  if (l.expires_at < iso()) return fail("expired", 410);
  if (clip(b.hp, 10)) return json({ ok: true });   // 사람 눈에 보이지 않는 칸이 채워져 있으면 조용히 버립니다
  const set = await crSettings(db, l.ws);
  if (!set.kit.on || !set.kit.inquiry || !await crModOn(db, l.ws)) return fail("closed", 403);
  const name = clip(b.name, 40), company = clip(b.company, 60), email = clip(b.email, 80), phone = clip(b.phone, 30), message = clip(b.message, 2000), budget = clip(b.budget, 60);
  if (!(name || company) || !message) return fail("bad-request");
  if (!email && !phone) return fail("need-contact");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail("bad-email");
  const today = kstToday(), q0 = await db.prepare("SELECT v FROM mod_set WHERE ws=?1 AND mod='cr' AND k='quota'").bind(l.ws).first(), Q = (q0 && parse(q0.v)) || {}, used = Q.d === today ? Number(Q.inq) || 0 : 0;
  if (used >= 40 || await crCount(db, l.ws, "cr_deal") >= CR_LIMIT.deals) return fail("busy", 429);
  const now = iso(), type = CR_TYPE.includes(b.type) ? b.type : "paid";
  const row = crDealRow({ brand: company || name, title: clip(message.split("\n")[0], 60), type, stage: "inquiry", seen: 0 }, { person: company ? name : "", contact: [email, phone].filter(Boolean).join(" · "), src: "kit", by: l.created_by || "", inq: { name, company, email, phone, budget, type, message, at: now } }, now);
  await db.batch([
    ...spBulk(db, "cr_deal", l.ws, [row]),
    db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'cr','quota',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(l.ws, JSON.stringify({ d: today, inq: used + 1 })),
    ...upserts(db, l.ws, [{ kind: "act", id: uid("a"), own: l.created_by, data: { id: uid("a"), ts: now.slice(5, 16).replace("T", " ").replace("-", "/"), who: name || company, by: "", createdAt: now, text: `미디어킷으로 협찬 문의가 들어왔습니다 — ${company || name}` } }], ts()),
    db.prepare("UPDATE workspaces SET sp_ver=sp_ver+1 WHERE id=?1").bind(l.ws)
  ]);
  await notify(db, l.ws, [...new Set([l.created_by].concat(await whoIs(db, l.ws, ["admin"])))], { type: "reply", title: "미디어킷으로 협찬 문의가 들어왔습니다", body: company || name, url: "#/creator/deal", tag: "cr-inq" });
  return json({ ok: true });
};


/* ───────── 초대 링크 — 사람마다 하나, 한 번만 쓰는 주소 (myworks.ai.kr/join/<토큰>) ─────────
   · 관리자는 모든 역할로, 직원은 자기가 참여한 프로젝트에 협력사로만 초대합니다.
   · 받은 사람이 아이디를 만들면 승인 없이 바로 로그인되고, 지정한 프로젝트의 참여자가 됩니다.
   · 메시지는 서버가 보내지 않습니다. 보내는 사람이 자기 문자·메일·메신저로 링크를 보냅니다. */
const INV_DDL = [
  "CREATE TABLE IF NOT EXISTS invites(token TEXT PRIMARY KEY, ws TEXT NOT NULL, created_by TEXT, role TEXT NOT NULL, projects TEXT NOT NULL DEFAULT '[]', contact_id TEXT, name TEXT, email TEXT, phone TEXT, msg TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, opened_at TEXT, used_at TEXT, member_id TEXT, login_id TEXT, revoked INTEGER NOT NULL DEFAULT 0)",
  "CREATE INDEX IF NOT EXISTS idx_inv_ws ON invites(ws, created_at)"
];
const INV_ROLES = ["partner", "staff", "worker", "facility", "admin"];
const INV_OPEN_MAX = 300;   // 워크스페이스당 아직 쓰지 않은 초대 수
const invState = (r, now) => Number(r.revoked) ? "revoked" : r.used_at ? "joined" : r.expires_at < now ? "expired" : r.opened_at ? "opened" : "sent";
const invOut = (r, now) => ({ token: r.token, role: roleOk(r.role), projects: parse(r.projects) || [], contactId: r.contact_id || "", name: r.name || "", email: r.email || "", phone: r.phone || "", createdBy: r.created_by || "", createdAt: r.created_at, expiresAt: r.expires_at, openedAt: r.opened_at || "", usedAt: r.used_at || "", memberId: r.member_id || "", loginId: r.login_id || "", status: invState(r, now) });
async function projectsOf(db, ws, ids) {
  if (!ids.length) return [];
  const rs = (await db.prepare("SELECT id, data FROM ent WHERE ws=?1 AND kind='project' AND deleted=0 AND id IN (SELECT value FROM json_each(?2))").bind(ws, JSON.stringify(ids)).all()).results || [];
  return rs.map(r => ({ id: r.id, d: parse(r.data) || {} }));
}
async function invRow(db, t) {
  if (!/^[0-9a-f]{32}$/.test(String(t || ""))) return null;
  return await db.prepare("SELECT i.*, w.name AS wname, w.status AS wst FROM invites i JOIN workspaces w ON w.id=i.ws WHERE i.token=?1").bind(t).first();
}
Object.assign(PRIVATE, {
  async "invite/create"(db, me, b) {
    if (me.role !== "admin" && me.role !== "staff") return fail("forbidden", 403);
    const role = INV_ROLES.includes(b.role) ? b.role : "partner";
    if (me.role === "staff" && role !== "partner") return fail("forbidden", 403);
    const people = (Array.isArray(b.people) ? b.people : []).slice(0, 50).map(x => ({
      name: clip(x && x.name, 40), email: clip(x && x.email, 120).toLowerCase(), phone: clip(x && x.phone, 40), contactId: clip(x && x.contactId, 120)
    })).filter(x => x.name || x.email || x.phone);
    if (!people.length) return fail("bad-request");
    const pids = [...new Set((Array.isArray(b.projects) ? b.projects : []).map(x => clip(x, 120)).filter(Boolean))].slice(0, 20);
    if (me.role === "staff" && !pids.length) return fail("bad-request");
    const ps = await projectsOf(db, me.ws, pids);
    if (ps.length !== pids.length) return fail("not-found", 404);
    if (me.role === "staff" && ps.some(x => x.d.ownerId !== me.id && !(Array.isArray(x.d.memberIds) && x.d.memberIds.includes(me.id)))) return fail("forbidden", 403);
    const now = iso(), days = clampInt(b.days, 1, 60, 14), exp = new Date(Date.now() + days * 864e5).toISOString();
    const c = await db.prepare("SELECT COUNT(*) AS n FROM invites WHERE ws=?1 AND revoked=0 AND used_at IS NULL AND expires_at>?2").bind(me.ws, now).first();
    if (c && Number(c.n) + people.length > INV_OPEN_MAX) return fail("too-many", 429, { limit: INV_OPEN_MAX });
    const msg = clip(b.msg, 600), rows = [];
    for (const x of people) rows.push({ token: rand(16), ws: me.ws, created_by: me.id, role, projects: JSON.stringify(pids), contact_id: x.contactId || null, name: x.name, email: x.email, phone: x.phone, created_at: now, expires_at: exp, revoked: 0 });
    await db.batch(rows.map(r => db.prepare("INSERT INTO invites(token,ws,created_by,role,projects,contact_id,name,email,phone,msg,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)").bind(r.token, r.ws, r.created_by, r.role, r.projects, r.contact_id, r.name, r.email, r.phone, msg, r.created_at, r.expires_at)));
    return json({ ok: true, invites: rows.map(r => invOut(r, now)), seats: { used: await memberCount(db, me.ws), limit: me.limits.members } });
  },
  async "invite/list"(db, me) {
    if (me.role !== "admin" && me.role !== "staff") return fail("forbidden", 403);
    const rs = (await db.prepare("SELECT * FROM invites WHERE ws=?1" + (me.role === "admin" ? "" : " AND created_by=?2") + " ORDER BY created_at DESC LIMIT 300").bind(...(me.role === "admin" ? [me.ws] : [me.ws, me.id])).all()).results || [];
    const now = iso();
    return json({ ok: true, invites: rs.map(r => invOut(r, now)), seats: { used: await memberCount(db, me.ws), limit: me.limits.members } });
  },
  async "invite/update"(db, me, b) {   // revoke = 취소, renew = 기한을 오늘부터 다시
    if (me.role !== "admin" && me.role !== "staff") return fail("forbidden", 403);
    const t = String(b.token || ""), op = b.op === "renew" ? "renew" : "revoke";
    const own = me.role === "admin" ? "" : " AND created_by=?3";
    const exp = new Date(Date.now() + clampInt(b.days, 1, 60, 14) * 864e5).toISOString();
    const args = me.role === "admin" ? [me.ws, t] : [me.ws, t, me.id];
    const r = op === "renew"
      ? await db.prepare("UPDATE invites SET expires_at=?" + (args.length + 1) + ", revoked=0 WHERE ws=?1 AND token=?2 AND used_at IS NULL" + own).bind(...args, exp).run()
      : await db.prepare("UPDATE invites SET revoked=1 WHERE ws=?1 AND token=?2 AND used_at IS NULL" + own).bind(...args).run();
    if (!r || !r.meta || !r.meta.changes) return fail("not-found", 404);
    return json({ ok: true, expiresAt: op === "renew" ? exp : "" });
  },
  /* 소개 링크 — 워크스페이스마다 코드 하나. 이 코드로 열린 워크스페이스 수를 보여 줍니다 */
  async "ref/info"(db, me) {
    const code = await wsRef(db, me.ws), pl = await platform(db);
    const out = { ok: true, code, days: pl.refDays };
    if (me.role === "admin" || me.role === "staff") {
      const c = await db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS a FROM workspaces WHERE ref_ws=?1").bind(me.ws).first() || {};
      out.signups = Number(c.n) || 0; out.opened = Number(c.a) || 0;
    }
    return json(out);
  }
});
PUBLIC["invite/get"] = async function (db, b, req, url) {
  const r = await invRow(db, url.searchParams.get("t"));
  if (!r || r.wst !== "active") return fail("not-found", 404);
  if (Number(r.revoked)) return fail("revoked", 410);
  const now = iso(), ref = await wsRef(db, r.ws);
  if (r.used_at) return json({ ok: true, status: "joined", workspace: r.wname, loginId: r.login_id || "", ref });
  if (r.expires_at < now) return fail("expired", 410, { workspace: r.wname });
  const pids = parse(r.projects) || [];
  const [by, ps] = await Promise.all([
    db.prepare("SELECT name FROM accounts WHERE ws=?1 AND member_id=?2").bind(r.ws, r.created_by || "").first(),
    projectsOf(db, r.ws, pids)
  ]);
  if (!r.opened_at) await db.prepare("UPDATE invites SET opened_at=?2 WHERE token=?1 AND opened_at IS NULL").bind(r.token, now).run();
  return json({ ok: true, status: "open", workspace: r.wname, inviter: (by && by.name) || "", role: roleOk(r.role), projects: ps.map(x => clip(x.d.name, 80)), name: r.name || "", email: r.email || "", msg: r.msg || "", expiresAt: r.expires_at, ref });
};
PUBLIC["invite/accept"] = async function (db, b) {
  const r = await invRow(db, b.t);
  if (!r || r.wst !== "active") return fail("not-found", 404);
  if (Number(r.revoked)) return fail("revoked", 410);
  if (r.used_at) return fail("used", 409);
  if (r.expires_at < iso()) return fail("expired", 410);
  const lid = normId(b.loginId), name = clip(b.name, 20), contact = clip(b.contact, 60);
  if (!name) return fail("bad-request");
  if (!ID_RE.test(lid)) return fail("bad-id");
  if (!pwValid(b.pw)) return fail("bad-pw");
  if (!b.agree) return fail("need-agree");
  if (await loginTaken(db, lid)) return fail("taken", 409);
  const w = await db.prepare("SELECT * FROM workspaces WHERE id=?1").bind(r.ws).first();
  if (await memberCount(db, r.ws) >= tierOf(w).limits.members) return fail("ws-full", 403);
  const now = iso(), mid = uid("m"), role = roleOk(r.role), token = rand(24);
  const member = memberData(mid, lid, name, role, "", now);
  const pids = parse(r.projects) || [];
  const ps = await projectsOf(db, r.ws, pids);
  const items = [{ kind: "member", id: mid, data: member }];
  for (const x of ps) { const ids = Array.isArray(x.d.memberIds) ? x.d.memberIds : []; if (!ids.includes(mid)) items.push({ kind: "project", id: x.id, data: { ...x.d, memberIds: [...ids, mid], updatedAt: now } }); }
  if (r.contact_id) { const c = await entData(db, r.ws, "contact", r.contact_id); if (c) items.push({ kind: "contact", id: r.contact_id, data: { ...c, memberId: mid, joinedAt: now, updatedAt: now } }); }
  const pn = ps.map(x => `"${clip(x.d.name, 40)}"`).join(", ");
  const aid = uid("a");
  items.push({ kind: "act", id: aid, own: r.created_by || null, data: { id: aid, ts: now.slice(5, 16).replace("T", " ").replace("-", "/"), who: name, by: mid, createdAt: now, text: `${name}님이 초대를 받아 합류했습니다${pn ? ` — ${pn} 참여` : ""}.` } });
  try {
    await db.batch([
      db.prepare("INSERT INTO accounts(login_id,ws,member_id,pw,status,role,is_owner,name,contact,note,created_at,agreed_at) VALUES(?1,?2,?3,?4,'active',?5,0,?6,?7,?8,?9,?9)").bind(lid, r.ws, mid, await makePw(b.pw), role, name, contact, "초대 링크로 합류", now),
      ...upserts(db, r.ws, items, ts()),
      db.prepare("UPDATE invites SET used_at=?2, member_id=?3, login_id=?4 WHERE token=?1").bind(r.token, now, mid, lid),
      db.prepare("INSERT INTO sess(token,ws,member_id,created_at,seen) VALUES(?1,?2,?3,?4,?5)").bind(token, r.ws, mid, now, Date.now()),
      db.prepare("UPDATE workspaces SET last_active=?1 WHERE id=?2").bind(now, r.ws)
    ]);
  } catch (e) { if (isUnique(e)) return fail("taken", 409); throw e; }
  for (const k of VIS.keys()) if (k.startsWith(r.ws + "|")) VIS.delete(k);
  await notify(db, r.ws, r.created_by ? [r.created_by] : await whoIs(db, r.ws, ["admin"]), { type: "team", title: `${name} 님이 초대를 받아 합류했습니다`, body: pn ? pn + " 참여" : "", url: "#/members", tag: "inv-join" });
  return json({ ok: true, token, workspace: r.wname, projects: ps.map(x => x.id) });
};

/* ───────── 소개(추천) 코드 ───────── */
function refCode() { const a = new Uint8Array(7); crypto.getRandomValues(a); return [...a].map(x => INVITE_ABC[x % INVITE_ABC.length]).join(""); }
async function wsRef(db, wsId) {   // 없으면 만들어 둡니다
  const r = await db.prepare("SELECT ref_code FROM workspaces WHERE id=?1").bind(wsId).first();
  if (!r) return "";
  if (r.ref_code) return r.ref_code;
  for (let i = 0; i < 6; i++) {
    try { await db.prepare("UPDATE workspaces SET ref_code=?1 WHERE id=?2 AND ref_code IS NULL").bind(refCode(), wsId).run(); }
    catch (e) { if (!isUnique(e)) throw e; continue; }
    const x = await db.prepare("SELECT ref_code FROM workspaces WHERE id=?1").bind(wsId).first();
    if (x && x.ref_code) return x.ref_code;
  }
  return "";
}
async function refLookup(db, raw) {
  const code = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length < 6 || code.length > 10) return null;
  const r = await db.prepare("SELECT id FROM workspaces WHERE ref_code=?1 AND status='active'").bind(code).first();
  return r ? r.id : null;
}
// 소개로 열린 워크스페이스가 생기면 두 곳 모두 프로 기한을 늘립니다 (운영자가 정한 일수, 0이면 없음). 한 번만.
async function refReward(db, wsId) {
  const pl = await platform(db), days = pl.refDays;
  if (!days) return {};
  const w = await db.prepare("SELECT id, name, plan, plan_until, ref_ws, ref_paid, status FROM workspaces WHERE id=?1").bind(wsId).first();
  if (!w || !w.ref_ws || Number(w.ref_paid) || w.status !== "active") return {};
  const r = await db.prepare("SELECT id, name, plan, plan_until, status FROM workspaces WHERE id=?1").bind(w.ref_ws).first();
  const today = kstToday(), out = { days };
  const ext = x => (x.plan === "pro" && !x.plan_until) ? null : addDaysS(x.plan === "pro" && x.plan_until && x.plan_until > today ? x.plan_until : today, days);
  const stmts = [], guard = "AND (SELECT ref_paid FROM workspaces WHERE id=?3)=0";
  const nu = ext(w);
  if (nu) { stmts.push(db.prepare(`UPDATE workspaces SET plan='pro', plan_until=?1 WHERE id=?2 ${guard}`).bind(nu, w.id, w.id)); out.plan = "pro"; out.until = nu; }
  if (r && r.status === "active") { const ru = ext(r); if (ru) stmts.push(db.prepare(`UPDATE workspaces SET plan='pro', plan_until=?1 WHERE id=?2 ${guard}`).bind(ru, r.id, w.id)); }
  stmts.push(db.prepare("UPDATE workspaces SET ref_paid=1 WHERE id=?1").bind(w.id));
  stmts.push(admLog(db, "ref", w, `소개 보상 프로 ${days}일 — ${r ? r.name : "소개한 곳 없음"} → ${w.name}`));
  await db.batch(stmts);
  return out;
}

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
  { name: "myworks_space", description: "마이스토어: 오늘·내일 예약, 청소·점검 확인 대기, 최근 일 마감, 시설 이슈, 소모품 부족, 답할 리뷰·문의", input: {} },
  { name: "myworks_outsourcing", description: "거래: 진행 안건, 견적 회신 대기, 미수금, 이번 주 납기", input: {} },
  { name: "myworks_commerce", description: "마이셀러: 발송할 주문, 답할 문의, 재고 부족, 발주·입고, 이달 매출", input: {} },
  { name: "myworks_marketing", description: "마이마케팅: 최근 30일·7일 광고비·노출·클릭·전환·매출과 채널·캠페인별 성과, 목표(CPA·ROAS), 남은 실행안, 예정된 콘텐츠", input: {} },
  { name: "myworks_creator", description: "마이크리에이터: 채널별 구독자·월 조회수, 진행 중인 협찬(단계·금액·마감·입금 예정), 챙길 것(새 문의·마감 지남·입금 지연·수정 요청), 독점 조건, 예정 콘텐츠, 최근 게시물 성과, 이달·지난달 수익", input: {} },
  { name: "myworks_propose", description: "변경 제안 올리기(쓰기 토큰). kind: create-task(title, project|store, detail, due, priority, assignee) · update-status(task, status|due) · add-note(text, project|store|task) · create-contact(name, company, phone, email, kind) · create-job(title, client, detail, due, amount) · mk-action(title, detail, campaign, kind, from, to — 마케팅 실행안) · mk-post(title, body, channel, date, format, tags — 콘텐츠 초안) · cr-idea(title, channel, format, date, memo — 크리에이터 콘텐츠 아이디어) · cr-deal(brand, title, type, channel, amount, due, memo — 협찬 건) · ed-report(student, month, title, body — 마이에듀 월간 학습 리포트 초안) · ed-lead(name, phone, grade, subject, src, next, memo — 마이에듀 상담 문의). 관리자가 승인하면 반영됩니다", input: { kind: "string", payload: "object", reason: "string" }, required: ["kind", "payload"] }
];
const mcpSchema = t => ({ type: "object", properties: Object.fromEntries(Object.entries(t.input).map(([k, v]) => [k, v === "object" ? { type: "object" } : { type: "string" }])), required: t.required || [] });
const mcpFn = { myworks_me: "me", myworks_today: "today", myworks_projects: "projects", myworks_project: "project", myworks_stores: "stores", myworks_tasks: "tasks", myworks_search: "search", myworks_contacts: "contacts", myworks_space: "space", myworks_outsourcing: "outsourcing", myworks_commerce: "commerce", myworks_marketing: "marketing", myworks_creator: "creator", myworks_propose: "propose" };
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


/* ═════════ 알림 — 알림함 · 휴대폰 푸시(웹 푸시) · 예약 알림 ═════════
   · 일이 생기면 notify()가 받는 사람의 알림함(nt_item)에 한 줄을 넣고, 푸시를 켠 기기가 있으면 함께 보냅니다.
   · 푸시는 표준 웹 푸시(VAPID · aes128gcm)입니다. 서버 열쇠는 처음 쓸 때 만들어 mw_meta('vapid')에 둡니다.
   · 운영자가 총괄관리에서 푸시를 열어야(feat.push) 기기를 등록할 수 있습니다. 알림함은 그와 관계없이 씁니다.
   · 예약 알림(nt_sched): 앱이 앞으로 챙길 것(마감·입금 기한·세금 일정·아침 요약)을 맡겨 두면 tick이 때가 된 것을 보냅니다.
   · tick은 누군가 앱을 쓰고 있으면 5분에 한 번 돌고, 바깥에서 /api/tick 을 불러도 됩니다(같은 5분 안에는 한 번만 일합니다). */
const NT_DDL = [
  "CREATE TABLE IF NOT EXISTS nt_item(ws TEXT NOT NULL, id TEXT NOT NULL, member_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT, url TEXT, at TEXT NOT NULL, read_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_nt_item_m ON nt_item(ws, member_id, at)",
  "CREATE TABLE IF NOT EXISTS nt_sub(id TEXT PRIMARY KEY, ws TEXT NOT NULL, member_id TEXT NOT NULL, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, ua TEXT, created_at TEXT NOT NULL, ok_at TEXT, fails INTEGER NOT NULL DEFAULT 0, seen_at TEXT)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_nt_sub_ep ON nt_sub(endpoint)",
  "CREATE INDEX IF NOT EXISTS idx_nt_sub_m ON nt_sub(ws, member_id)",
  "CREATE TABLE IF NOT EXISTS nt_sched(ws TEXT NOT NULL, member_id TEXT NOT NULL, k TEXT NOT NULL, due TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT, url TEXT, PRIMARY KEY(ws, member_id, k))",
  "CREATE INDEX IF NOT EXISTS idx_nt_sched_due ON nt_sched(due)"
];
const NT_TABLES = ["nt_item", "nt_sub", "nt_sched"];
const ntDrop = (db, ws, memberId) => db.prepare("DELETE FROM nt_sub WHERE ws=?1 AND member_id=?2").bind(ws, memberId);   // 그 사람의 푸시 기기 등록을 모두 지웁니다
const NT_TYPES = ["reply", "task", "due", "money", "team", "ai", "store", "sys", "digest"];   // 회신·문의 · 업무 · 마감·일정 · 돈·세금 · 사람 · AI 제안 · 매장·현장 · 운영·공지 · 아침 요약
const NT_PUSH_HOSTS = [".googleapis.com", ".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com"];   // 브라우저 회사의 푸시 서버만 받습니다
const NT_MAX_DEVICES = 8, NT_MAX_PLAN = 80, NT_PUSH_BATCH = 40;
const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => { s = String(s || "").replace(/-/g, "+").replace(/_/g, "/"); try { return Uint8Array.from(atob(s + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0)); } catch (e) { return new Uint8Array(0); } };
const catBytes = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const hmOk = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ""));
function ntPrefs(p) {   // 사람마다: 끈 종류, 방해 금지 시간(시), 아침 요약 시각
  p = p && typeof p === "object" ? p : {};
  const quiet = p.quiet === null || p.quiet === false ? null : (Array.isArray(p.quiet) && p.quiet.length === 2 ? [clampInt(p.quiet[0], 0, 23, 22), clampInt(p.quiet[1], 0, 23, 8)] : [22, 8]);
  return { off: [...new Set((Array.isArray(p.off) ? p.off : []).filter(t => NT_TYPES.includes(t)))], quiet, digest: hmOk(p.digest) ? p.digest : (p.digest === "" ? "" : "08:30") };
}
const ntQuiet = (p, h) => !!p.quiet && p.quiet[0] !== p.quiet[1] && (p.quiet[0] < p.quiet[1] ? h >= p.quiet[0] && h < p.quiet[1] : h >= p.quiet[0] || h < p.quiet[1]);
const kstHour = (ms = Date.now()) => new Date(ms + 9 * 3600e3).getUTCHours();
const pushHostOk = u => { try { const x = new URL(u); return x.protocol === "https:" && NT_PUSH_HOSTS.some(h => x.hostname.endsWith(h)); } catch (e) { return false; } };

let VAPID = null;
const VJWT = new Map();
async function vapid(db) {   // 서버 열쇠 — 없으면 한 번 만들어 보관합니다
  if (VAPID) return VAPID;
  let r = await db.prepare("SELECT v FROM mw_meta WHERE k='vapid'").first(), o = r ? parse(r.v) : null;
  if (!o || !o.d || !o.x || !o.y) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const j = await crypto.subtle.exportKey("jwk", kp.privateKey);
    await db.prepare("INSERT OR IGNORE INTO mw_meta(k,v) VALUES('vapid',?1)").bind(JSON.stringify({ d: j.d, x: j.x, y: j.y })).run();
    r = await db.prepare("SELECT v FROM mw_meta WHERE k='vapid'").first(); o = r ? parse(r.v) : null;   // 동시에 만들어졌으면 먼저 저장된 것을 씁니다
    if (!o) throw new Error("vapid");
  }
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d: o.d, x: o.x, y: o.y, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return (VAPID = { key, pub: b64u(catBytes(new Uint8Array([4]), unb64u(o.x), unb64u(o.y))) });
}
async function vapidAuth(db, endpoint) {   // 푸시 서버마다 12시간짜리 서명 하나를 돌려 씁니다
  const v = await vapid(db), aud = new URL(endpoint).origin, now = Math.floor(Date.now() / 1000), c = VJWT.get(aud);
  if (c && c.exp - now > 900) return `vapid t=${c.t}, k=${v.pub}`;
  const exp = now + 12 * 3600, head = b64u(enc.encode('{"typ":"JWT","alg":"ES256"}')), body = b64u(enc.encode(JSON.stringify({ aud, exp, sub: "https://" + CANON_HOST })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.key, enc.encode(head + "." + body)));
  const t = head + "." + body + "." + b64u(sig);
  VJWT.set(aud, { t, exp }); if (VJWT.size > 20) VJWT.delete(VJWT.keys().next().value);
  return `vapid t=${t}, k=${v.pub}`;
}
async function pushBody(sub, data) {   // 내용 암호화 — RFC 8291 (aes128gcm). 푸시 서버는 내용을 읽지 못합니다
  const ua = unb64u(sub.p256dh), auth = unb64u(sub.auth);
  if (ua.length !== 65 || auth.length < 16) throw new Error("bad-sub");
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const as = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, kp.privateKey, 256));
  const hk = async (salt, ikm, info, len) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), len * 8));
  const ikm = await hk(auth, ecdh, catBytes(enc.encode("WebPush: info\0"), ua, as), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hk(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16), nonce = await hk(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]), catBytes(data, new Uint8Array([2]))));
  return catBytes(salt, new Uint8Array([0, 0, 16, 0, 65]), as, ct);
}
async function pushSend(db, sub, n) {   // 한 기기로 보내기 → HTTP 상태(0 = 닿지 못함)
  try {
    const payload = enc.encode(JSON.stringify({ t: clip(n.title, 80), b: clip(n.body, 200), u: clip(n.url, 200), g: clip(n.tag || n.type || "", 60) }));
    const r = await fetch(sub.endpoint, { method: "POST", headers: { authorization: await vapidAuth(db, sub.endpoint), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: n.type === "digest" ? "low" : "normal" }, body: await pushBody(sub, payload) });
    return r.status;
  } catch (e) { return 0; }
}
/* jobs: [{w, m, n}] — 받는 사람마다 보낼 내용. 푸시가 열려 있고, 기기를 등록했고, 그 종류를 끄지 않았고, 방해 금지 시간이 아닐 때만 보냅니다 */
async function pushMany(db, jobs, force) {
  if (!jobs.length) return { sent: 0, failed: 0, devices: 0 };
  const plat = await db.prepare("SELECT v FROM mw_meta WHERE k='platform'").first();
  if (!platformOf(plat && plat.v).feat.push) return { sent: 0, failed: 0, devices: 0, closed: true };
  const pairs = [...new Map(jobs.map(j => [j.w + "|" + j.m, { w: j.w, m: j.m }])).values()];
  const subs = (await db.prepare("SELECT s.id, s.ws, s.member_id, s.endpoint, s.p256dh, s.auth, (SELECT v FROM ws_set WHERE ws=s.ws AND k='nt:'||s.member_id) AS pref FROM nt_sub s JOIN json_each(?1) j ON s.ws=json_extract(j.value,'$.w') AND s.member_id=json_extract(j.value,'$.m') JOIN accounts a ON a.ws=s.ws AND a.member_id=s.member_id AND a.status='active' JOIN workspaces w ON w.id=s.ws AND w.status='active' WHERE s.seen_at>=?2").bind(JSON.stringify(pairs), new Date(Date.now() - SESSION_MS).toISOString()).all()).results || [];   // 꺼진 계정·멈춘 워크스페이스, 로그인한 앱이 30일 넘게 다녀가지 않은 기기로는 보내지 않습니다
  const by = new Map(); for (const s of subs) { const k = s.ws + "|" + s.member_id; if (!by.has(k)) by.set(k, []); by.get(k).push(s); }
  const hour = kstHour(), todo = [];
  for (const j of jobs) for (const s of by.get(j.w + "|" + j.m) || []) {
    const p = ntPrefs(parse(s.pref));
    if (!force && (p.off.includes(j.n.type) || ntQuiet(p, hour))) continue;
    if (todo.length < NT_PUSH_BATCH) todo.push([s, j.n]);
  }
  const dead = [], bad = [];
  let sent = 0;
  await Promise.all(todo.map(async ([s, n]) => { const st = await pushSend(db, s, n); if (st >= 200 && st < 300) sent++; else if (st === 404 || st === 410) dead.push(s.id); else bad.push(s.id); }));
  if (dead.length || bad.length) await db.batch([
    db.prepare("UPDATE nt_sub SET fails=fails+1 WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify([...new Set(bad)])),
    db.prepare("DELETE FROM nt_sub WHERE id IN (SELECT value FROM json_each(?1)) OR fails>=10").bind(JSON.stringify([...new Set(dead)]))   // 지워진 구독(404·410)과 열 번 연속 실패한 기기는 정리합니다
  ]);
  return { sent, failed: dead.length + bad.length, devices: subs.length };
}
/* 알림 한 건 — to: 받는 사람(구성원 id) 여럿. 본 흐름을 막지 않도록 실패해도 조용히 넘어갑니다 */
async function notify(db, ws, to, n) {
  try {
    to = [...new Set((Array.isArray(to) ? to : [to]).filter(Boolean).map(String))].slice(0, 60);
    if (!ws || !to.length || !n || !n.title) return;
    const type = NT_TYPES.includes(n.type) ? n.type : "sys", one = Object.assign({}, n, { type });
    if (n.once && await db.prepare("SELECT 1 AS x FROM nt_item WHERE ws=?1 AND type=?2 AND title=?3 AND read_at IS NULL AND at>?4 AND member_id IN (SELECT value FROM json_each(?5)) LIMIT 1").bind(ws, type, clip(n.title, 80), new Date(Date.now() - n.once * 60e3).toISOString(), JSON.stringify(to)).first()) return;   // 같은 알림이 읽히지 않은 채 있으면 또 보내지 않습니다
    await db.prepare("INSERT INTO nt_item(ws,id,member_id,type,title,body,url,at) SELECT ?1, ?2||'_'||j.key, j.value, ?3, ?4, ?5, ?6, ?7 FROM json_each(?8) j").bind(ws, uid("n"), type, clip(n.title, 80), clip(n.body, 240), clip(n.url, 200), iso(), JSON.stringify(to)).run();
    const p = pushMany(db, to.map(m => ({ w: ws, m, n: one }))).catch(() => {});
    if (db.wait) db.wait(p); else await p;
  } catch (e) {}
}
const whoIs = async (db, ws, roles) => ((await db.prepare("SELECT member_id FROM accounts WHERE ws=?1 AND status='active' AND role IN (SELECT value FROM json_each(?2))").bind(ws, JSON.stringify(roles)).all()).results || []).map(r => r.member_id);
const opsWho = async (db, perm) => ((await db.prepare("SELECT ws, member_id, is_owner, op_role FROM accounts WHERE status='active' AND (is_owner=1 OR op_role IS NOT NULL)").all()).results || []).filter(r => (OP_ROLES[opOf(r)] || { perms: [] }).perms.includes(perm));   // 운영팀 가운데 그 일을 맡은 사람
async function notifyOps(db, perm, n) { try { const L = await opsWho(db, perm); if (L.length) await notify(db, L[0].ws, L.map(x => x.member_id), n); } catch (e) {} }
/* 동기화(push)로 들어온 변경에서 알릴 것 — 다른 사람에게 새로 맡긴 업무, 검토로 넘어온 업무, 프로젝트·매장에 남긴 의견 */
async function pushNotes(db, me, tasks, prev, cmts, lookup) {
  try {
    const give = new Map(), review = [];
    for (const x of tasks) {
      const p = prev.get(x.id), pd = p ? parse(p.data) || {} : null, to = String(x.data.assigneeId || "");
      if (to && to !== me.id && x.data.status !== "완료" && (!p || p.own !== to)) { if (!give.has(to)) give.set(to, []); give.get(to).push(x.data); }
      if (x.data.status === "검토" && (!pd || pd.status !== "검토")) review.push(x.data);
    }
    const pids = [...new Set(review.map(t => t.projectId).concat(cmts.map(c => c.data.projectId)).filter(Boolean).map(String))], sids = [...new Set(cmts.map(c => c.data.storeId).filter(Boolean).map(String))];
    const P = pids.length ? await lookup("project", pids) : new Map(), S = sids.length ? await lookup("store", sids) : new Map();
    const dataOf = (m, id) => { const r = m.get(String(id || "")); return r ? parse(r.data) || {} : null; };
    const names = list => list.slice(0, 3).map(t => clip(t.title, 40)).join(" · ") + (list.length > 3 ? " 외" : "");
    let n = 0;
    for (const [to, list] of give) { if (n++ >= 6) break; await notify(db, me.ws, [to], { type: "task", title: list.length > 1 ? `업무 ${list.length}건이 배정되었습니다` : "새 업무가 배정되었습니다", body: names(list), url: "#/board", tag: "task-give" }); }
    const byOwner = new Map();
    for (const t of review) { const pj = dataOf(P, t.projectId), owner = String((pj && pj.ownerId) || ""); if (owner && owner !== me.id) { if (!byOwner.has(owner)) byOwner.set(owner, []); byOwner.get(owner).push(t); } }
    for (const [to, list] of byOwner) { if (n++ >= 9) break; await notify(db, me.ws, [to], { type: "task", title: list.length > 1 ? `검토를 기다리는 업무가 ${list.length}건 있습니다` : "검토를 기다리는 업무가 있습니다", body: names(list), url: "#/dashboard", tag: "task-review" }); }
    for (const c of cmts.slice(0, 4)) {
      const pj = c.data.projectId ? dataOf(P, c.data.projectId) : null, st = !pj && c.data.storeId ? dataOf(S, c.data.storeId) : null, d = pj || st; if (!d) continue;
      const to = [...new Set([pj ? d.ownerId : d.managerId].concat(Array.isArray(d.memberIds) ? d.memberIds : []).filter(x => x && x !== me.id).map(String))];
      if (to.length) await notify(db, me.ws, to, { type: "task", title: `${me.name || "구성원"} 님이 의견을 남겼습니다`, body: `${clip(d.name, 30)} — ${clip(c.data.text, 80)}`, url: pj ? "#/project/" + c.data.projectId : "#/store/" + c.data.storeId, tag: "cmt" });
    }
  } catch (e) {}
}

Object.assign(PRIVATE, {
  async "nt/list"(db, me) {
    const [a, b] = await db.batch([
      db.prepare("SELECT id,type,title,body,url,at,read_at FROM nt_item WHERE ws=?1 AND member_id=?2 ORDER BY at DESC, id DESC LIMIT 80").bind(me.ws, me.id),
      db.prepare("SELECT (SELECT v FROM ws_set WHERE ws=?1 AND k=?3) AS pref, (SELECT v FROM mw_meta WHERE k='platform') AS plat, (SELECT COUNT(*) FROM nt_sub WHERE ws=?1 AND member_id=?2) AS subs, (SELECT COUNT(*) FROM nt_item WHERE ws=?1 AND member_id=?2 AND read_at IS NULL) AS unread").bind(me.ws, me.id, "nt:" + me.id)
    ]);
    const x = ((b && b.results) || [])[0] || {}, open = platformOf(x.plat).feat.push;
    return json({ ok: true, items: (a && a.results) || [], unread: Number(x.unread) || 0, prefs: ntPrefs(parse(x.pref)), push: { open, key: open ? (await vapid(db)).pub : "", devices: Number(x.subs) || 0 } });
  },
  async "nt/read"(db, me, b) {
    const ids = (Array.isArray(b.ids) ? b.ids : []).map(x => clip(x, 60)).filter(Boolean).slice(0, 200);
    if (!b.all && !ids.length) return fail("bad-request");
    await db.prepare("UPDATE nt_item SET read_at=?3 WHERE ws=?1 AND member_id=?2 AND read_at IS NULL" + (b.all ? "" : " AND id IN (SELECT value FROM json_each(?4))")).bind(...[me.ws, me.id, iso()].concat(b.all ? [] : [JSON.stringify(ids)])).run();
    const r = await db.prepare("SELECT COUNT(*) AS n FROM nt_item WHERE ws=?1 AND member_id=?2 AND read_at IS NULL").bind(me.ws, me.id).first();
    return json({ ok: true, unread: r ? Number(r.n) : 0 });
  },
  async "nt/prefs"(db, me, b) {
    const p = ntPrefs(b.prefs);
    await db.prepare("INSERT INTO ws_set(ws,k,v) VALUES(?1,?2,?3) ON CONFLICT(ws,k) DO UPDATE SET v=excluded.v").bind(me.ws, "nt:" + me.id, JSON.stringify(p)).run();
    return json({ ok: true, prefs: p });
  },
  async "nt/sub"(db, me, b) {   // 이 기기에서 푸시 받기
    const plat = await platform(db);
    if (!plat.feat.push) return fail("push-closed", 403);
    const ep = clip(b.endpoint, 600), k = b.keys && typeof b.keys === "object" ? b.keys : {}, p256dh = clip(k.p256dh, 120), auth = clip(k.auth, 60);
    if (!pushHostOk(ep) || unb64u(p256dh).length !== 65 || unb64u(auth).length < 16) return fail("bad-sub");
    const now = iso();
    await db.batch([
      db.prepare("INSERT INTO nt_sub(id,ws,member_id,endpoint,p256dh,auth,ua,created_at,fails,seen_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0,?8) ON CONFLICT(endpoint) DO UPDATE SET ws=excluded.ws, member_id=excluded.member_id, p256dh=excluded.p256dh, auth=excluded.auth, ua=excluded.ua, fails=0, seen_at=excluded.seen_at").bind(uid("ps"), me.ws, me.id, ep, p256dh, auth, clip(b.ua, 80), now),
      db.prepare("DELETE FROM nt_sub WHERE ws=?1 AND member_id=?2 AND id NOT IN (SELECT id FROM nt_sub WHERE ws=?1 AND member_id=?2 ORDER BY created_at DESC LIMIT ?3)").bind(me.ws, me.id, NT_MAX_DEVICES)   // 한 사람에 기기 8대까지
    ]);
    const r = await db.prepare("SELECT COUNT(*) AS n FROM nt_sub WHERE ws=?1 AND member_id=?2").bind(me.ws, me.id).first();
    return json({ ok: true, devices: r ? Number(r.n) : 1 });
  },
  async "nt/unsub"(db, me, b) {
    if (b.all) await db.prepare("DELETE FROM nt_sub WHERE ws=?1 AND member_id=?2").bind(me.ws, me.id).run();
    else await db.prepare("DELETE FROM nt_sub WHERE ws=?1 AND member_id=?2 AND endpoint=?3").bind(me.ws, me.id, clip(b.endpoint, 600)).run();
    const r = await db.prepare("SELECT COUNT(*) AS n FROM nt_sub WHERE ws=?1 AND member_id=?2").bind(me.ws, me.id).first();
    return json({ ok: true, devices: r ? Number(r.n) : 0 });
  },
  async "nt/test"(db, me) {   // 내 기기로 시험 알림 — 방해 금지 시간이어도 보냅니다
    const r = await pushMany(db, [{ w: me.ws, m: me.id, n: { type: "sys", title: "마이웍스 알림이 켜졌습니다", body: "일이 생기면 이렇게 알려 드립니다.", url: "#/dashboard", tag: "test" } }], true);
    if (r.closed) return fail("push-closed", 403);
    if (!r.devices) return fail("no-device", 400);
    return json(Object.assign({ ok: true }, r));
  },
  async "nt/plan"(db, me, b) {   // 앞으로 챙길 것 맡기기 — 묶음(ns)마다 보낼 때 통째로 바꿉니다
    const ns = /^[a-z]{2,8}$/.test(b.ns) ? b.ns : "app";
    const now = Date.now(), seen = new Set(), rows = [];
    for (const x of (Array.isArray(b.items) ? b.items : []).slice(0, 300)) {
      if (!x || typeof x !== "object") continue;
      const k = clip(x.k, 50), title = clip(x.title, 80), t = Date.parse(x.due);
      if (!k || !title || seen.has(k) || !Number.isFinite(t) || t < now - 3600e3 || t > now + 31 * 864e5) continue;
      seen.add(k);
      rows.push({ k: ns + ":" + k, due: new Date(t).toISOString(), type: NT_TYPES.includes(x.type) ? x.type : "due", title, body: clip(x.body, 240), url: clip(x.url, 200) });
      if (rows.length >= NT_MAX_PLAN) break;
    }
    const stmts = [db.prepare("DELETE FROM nt_sched WHERE ws=?1 AND member_id=?2 AND k LIKE ?3").bind(me.ws, me.id, ns + ":%")];
    if (rows.length) stmts.push(db.prepare("INSERT INTO nt_sched(ws,member_id,k,due,type,title,body,url) SELECT ?1, ?2, json_extract(value,'$.k'), json_extract(value,'$.due'), json_extract(value,'$.type'), json_extract(value,'$.title'), json_extract(value,'$.body'), json_extract(value,'$.url') FROM json_each(?3)").bind(me.ws, me.id, JSON.stringify(rows)));
    await db.batch(stmts);
    return json({ ok: true, planned: rows.length });
  },
  async "nt/upcoming"(db, me) {   // 앞으로 2주 안에 날짜가 걸린 일(받을 돈·견적 유효기간·협찬 마감) — 앱이 아침 요약과 전날 알림을 짤 때 씁니다
    if (!isMgr(me)) return json({ ok: true, items: [], late: [] });
    const today = kstToday(), to = addDaysS(today, 14);
    const qs = [
      db.prepare("SELECT v.id, v.no, v.due_date, j.title, j.client_name FROM os_invoice v LEFT JOIN os_job j ON j.ws=v.ws AND j.id=v.job_id WHERE v.ws=?1 AND v.status='issued' AND v.due_date IS NOT NULL AND v.due_date<>'' AND v.due_date<=?2 ORDER BY v.due_date LIMIT 60").bind(me.ws, to),
      db.prepare("SELECT q.id, q.no, q.valid_until, j.title, j.client_name FROM os_quote q LEFT JOIN os_job j ON j.ws=q.ws AND j.id=q.job_id WHERE q.ws=?1 AND q.status='sent' AND q.valid_until>=?2 AND q.valid_until<=?3 ORDER BY q.valid_until LIMIT 40").bind(me.ws, today, to)
    ];
    if (hasMod(me, "creator")) qs.push(db.prepare("SELECT id, brand, title, stage, draft_due, post_due, pay_due FROM cr_deal WHERE ws=?1 AND stage IN ('contract','making','review','posted','settle') LIMIT 300").bind(me.ws));
    const rs = await db.batch(qs), rows = i => (rs[i] && rs[i].results) || [], items = [], late = [];
    const label = (a, b, c) => [a, b].filter(Boolean).join(" · ") || c;
    for (const v of rows(0)) (v.due_date < today ? late : items).push({ k: "inv:" + v.id, date: v.due_date, type: "money", title: "입금 기한 — " + label(v.client_name, v.title, v.no || "청구서"), url: "#/outsourcing/bills" });
    for (const q of rows(1)) items.push({ k: "qt:" + q.id, date: q.valid_until, type: "money", title: "견적 유효기간 — " + label(q.client_name, q.title, q.no || "견적"), url: "#/outsourcing/quotes" });
    for (const d of rows(2)) {
      const name = label(d.brand, d.title, "협찬");
      const add = (key, date, t) => { if (!dOk(date) || date > to) return; (date < today ? late : items).push({ k: "cr:" + key + ":" + d.id, date, type: key === "pay" ? "money" : "due", title: t + " — " + name, url: "#/creator/deal" }); };
      if (["contract", "making"].includes(d.stage)) add("draft", d.draft_due, "초안 마감");
      if (["contract", "making", "review"].includes(d.stage)) add("post", d.post_due, "게시 마감");
      if (["posted", "settle"].includes(d.stage)) add("pay", d.pay_due, "입금 예정");
    }
    if (hasMod(me, "edu")) { const ex = await edUpcoming(db, me, today, to); items.push(...ex.items); late.push(...ex.late); }
    return json({ ok: true, today, items, late });
  }
});

/* ── tick — 때가 된 예약 알림을 보내고, 묵은 알림을 정리합니다. 5분 안에 여러 번 불려도 한 번만 일합니다 ── */
const TICK_GAP = 240e3;
let TICK_MEM = 0;
function maybeTick(db) { const now = Date.now(); if (now - TICK_MEM < 300e3) return; TICK_MEM = now; const p = tick(db, true).catch(() => {}); if (db.wait) db.wait(p); }
/* light: 다른 요청에 얹혀 돌 때 — 그 요청이 쓴 쿼리와 한도를 나눠 쓰므로 자동 작업은 한 번에 하나씩만 번갈아 돌립니다. /api/tick 으로 따로 불릴 때는 모두 돌립니다 */
async function tick(db, light) {
  const now = Date.now(), nowIso = new Date(now).toISOString();
  const got = await db.prepare("UPDATE mw_meta SET v=?1 WHERE k='tick' AND v<?2").bind(ts(now), ts(now - TICK_GAP)).run();
  if (!(got.meta && got.meta.changes)) {
    const ins = await db.prepare("INSERT OR IGNORE INTO mw_meta(k,v) VALUES('tick',?1)").bind(ts(now)).run();
    if (!(ins.meta && ins.meta.changes)) return { ok: true, ran: false };
  }
  const out = { ok: true, ran: true, due: 0, sent: 0 };
  const due = (await db.prepare("SELECT s.rowid AS rid, s.ws, s.member_id, s.due, s.type, s.title, s.body, s.url, a.status AS ast, w.status AS wst FROM nt_sched s LEFT JOIN accounts a ON a.ws=s.ws AND a.member_id=s.member_id LEFT JOIN workspaces w ON w.id=s.ws WHERE s.due<=?1 ORDER BY s.due LIMIT 60").bind(nowIso).all()).results || [];
  if (due.length) {
    const live = due.filter(d => d.ast === "active" && d.wst === "active" && Date.parse(d.due) > now - 36 * 3600e3);   // 하루 반 넘게 늦은 것은 보내지 않고 지웁니다
    const stmts = [db.prepare("DELETE FROM nt_sched WHERE rowid IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(due.map(d => d.rid)))];
    if (live.length) stmts.unshift(db.prepare("INSERT INTO nt_item(ws,id,member_id,type,title,body,url,at) SELECT json_extract(value,'$.ws'), ?2||'_'||key, json_extract(value,'$.member_id'), json_extract(value,'$.type'), json_extract(value,'$.title'), json_extract(value,'$.body'), json_extract(value,'$.url'), ?3 FROM json_each(?1)").bind(JSON.stringify(live), uid("n"), nowIso));
    await db.batch(stmts);
    out.due = live.length;
    if (live.length) out.sent = (await pushMany(db, live.map(d => ({ w: d.ws, m: d.member_id, n: { type: d.type, title: d.title, body: d.body, url: d.url, tag: d.type } })))).sent;
  }
  const jobs = light && TICK_JOBS.length > 1 ? [TICK_JOBS[Math.floor(now / TICK_GAP) % TICK_JOBS.length]] : TICK_JOBS;
  for (const job of jobs) { try { Object.assign(out, await job(db, now)); } catch (e) { out.err = String((e && e.message) || e).slice(0, 120); } }
  if (new Date(now).getUTCMinutes() < 5) await db.batch([   // 한 시간에 한 번쯤 — 45일 지난 알림, 때를 놓친 예약, 1년 지난 문자 기록, 90일 지난 수집 기록을 치웁니다
    db.prepare("DELETE FROM nt_item WHERE at<?1").bind(new Date(now - 45 * 864e5).toISOString()),
    db.prepare("DELETE FROM nt_sched WHERE due<?1").bind(new Date(now - 2 * 864e5).toISOString()),
    db.prepare("DELETE FROM msg_log WHERE at<?1").bind(new Date(now - MSG_KEEP_DAYS * 864e5).toISOString()),
    db.prepare("DELETE FROM ht_job WHERE at<?1").bind(new Date(now - 90 * 864e5).toISOString())
  ]);
  return out;
}
const TICK_JOBS = [];   // 문자 자동 안내 · 홈택스 자동 수집이 여기에 일을 겁니다
PUBLIC.tick = async function (db) { return json(await tick(db)); };

/* ═════════ 문자·알림톡 — 내 발송 계정(솔라피)으로 고객·거래처에게 거래 안내를 보냅니다 ═════════
   · 워크스페이스마다 자기 솔라피 계정의 API 키를 연결합니다. 키는 금고(MW_VAULT_KEY)로 암호화해 두고 화면으로 다시 보내지 않습니다.
   · 보내는 것은 거래와 관련된 안내(견적·청구·납품·발주·명세서·예약 안내)뿐입니다. 광고 문자는 받지 않습니다.
   · 알림톡은 솔라피에서 심사받은 템플릿을 용도에 이어 두면 그 템플릿으로 나가고, 실패하면 문자로 대신 갑니다(솔라피의 대체 발송).
   · 자동 안내(입금 기한·견적 회신·예약 전날)는 켠 워크스페이스만, 오전 9시~오후 8시 사이에, 보내기 직전에 상태를 다시 확인하고 보냅니다. */
const MSG_DDL = [
  "CREATE TABLE IF NOT EXISTS msg_log(ws TEXT NOT NULL, id TEXT NOT NULL, at TEXT NOT NULL, by_id TEXT, by_name TEXT, kind TEXT NOT NULL, to_no TEXT NOT NULL, to_name TEXT, text TEXT, tpl TEXT, ref_kind TEXT, ref_id TEXT, status TEXT NOT NULL, pid TEXT, err TEXT, auto INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_msg_log_at ON msg_log(ws, at)",
  "CREATE INDEX IF NOT EXISTS idx_msg_log_ref ON msg_log(ws, ref_kind, ref_id, tpl)",
  "CREATE TABLE IF NOT EXISTS msg_auto(ws TEXT PRIMARY KEY, next_at TEXT NOT NULL)"
];
const MSG_TABLES = ["msg_log", "msg_auto"];
const MSG_AUTO_TRIES = 2;   // 같은 자동 안내는 실패해도 두 번까지만 시도합니다
const MSG_KEEP_DAYS = 365;   // 보낸 기록은 1년 뒤에 지웁니다
const MSG_FIELDS = ["상호", "이름", "제목", "금액", "기한", "링크", "코드", "날짜", "시간", "지점", "안내"];
/* 용도마다 기본 문구 — {이름}처럼 적은 자리는 보낼 때 채웁니다 */
const MSG_TPL = {
  "link.quote": ["견적서 보내기", "[{상호}] {이름}님, 요청하신 견적서를 보내드립니다.\n{제목}\n{링크}"],
  "link.invoice": ["청구서 보내기", "[{상호}] {이름}님, 청구서를 보내드립니다.\n{제목} {금액}\n입금 기한 {기한}\n{링크}"],
  "link.delivery": ["납품 확인 요청", "[{상호}] {이름}님, 납품물을 확인해 주세요.\n{제목}\n{링크}"],
  "link.po": ["발주서 보내기", "[{상호}] 발주서를 보내드립니다. 확인 부탁드립니다.\n{제목}\n{링크}"],
  "link.payslip": ["임금명세서 보내기", "[{상호}] {이름}님, {제목}입니다.\n{링크}"],
  "link.project": ["진행 상황 공유", "[{상호}] {제목} 진행 상황을 공유드립니다.\n{링크}"],
  "link.cr-deal": ["협찬 조건 확인 요청", "[{상호}] {이름}님, 협의한 조건을 정리해 보내드립니다. 확인 부탁드립니다.\n{링크}"],
  "invite": ["초대 링크 보내기", "[{상호}] {이름}님을 마이웍스에 초대합니다. 아래 주소에서 바로 참여할 수 있습니다.\n{링크}"],
  "auto.invDue": ["입금 기한 전 안내", "[{상호}] {이름}님, {제목} 청구서의 입금 기한이 {기한}입니다.\n{링크}"],
  "auto.invLate": ["입금 기한 지남 안내", "[{상호}] {이름}님, {제목} 청구서의 입금 기한({기한})이 지났습니다. 확인 부탁드립니다.\n{링크}"],
  "auto.quoteNudge": ["견적 회신 요청", "[{상호}] {이름}님, 보내드린 견적서를 확인해 주세요.\n{제목}\n{링크}"],
  "auto.resEve": ["예약 전날 안내", "[{상호}] {이름}님, 내일({날짜}) {시간} {지점} 예약 안내드립니다.\n{안내}"],
  "link.ed-guard": ["보호자 페이지 보내기", "[{상호}] {이름} 학생의 시간표·출결·수강료를 한곳에서 보실 수 있는 페이지입니다.\n{링크}"],
  "ed.bill": ["수강료 안내", "[{상호}] {이름} 학생 {제목} 안내드립니다.\n{금액} · 납부 기한 {기한}\n{안내}\n{링크}"],
  "ed.att": ["출결 안내", "[{상호}] {이름} 학생이 {날짜} {제목} 수업에 {안내}"],
  "ed.report": ["학습 리포트 안내", "[{상호}] {이름} 학생의 {제목}를 보내드립니다.\n{링크}"],
  "auto.edDue": ["수강료 납부 기한 전 안내", "[{상호}] {이름} 학생 {제목} 납부 기한이 {기한}입니다. ({금액})\n{링크}"],
  "auto.edLate": ["수강료 미납 안내", "[{상호}] {이름} 학생 {제목} 납부 기한({기한})이 지났습니다. 이미 보내셨다면 이 문자는 넘겨 주세요.\n{링크}"],
  "free": ["직접 쓰기", ""]
};
const MSG_AUTO = { invDue: { on: false, days: 1 }, invLate: { on: false, days: 3 }, quoteNudge: { on: false, days: 3 }, resEve: { on: false, hour: 18, note: "" }, edDue: { on: false, days: 1 }, edLate: { on: false, days: 3 } };
const MSG_AUTO_HOOKS = [];   // 확장판이 자동 안내 후보를 더합니다 — async (db, w, set, A, today, sign) => [후보]
const MSG_DAY_MAX = 2000, MSG_SEND_MAX = 50, MSG_AUTO_RUN = 30;
const phoneKR = s => { let d = String(s || "").replace(/[^0-9]/g, ""); if (d.startsWith("82") && d.length >= 11) d = "0" + d.slice(2); return /^01[016789]\d{7,8}$/.test(d) ? d : ""; };   // 휴대폰 번호만
const smsBytes = t => { let n = 0; for (const ch of String(t || "")) n += ch.codePointAt(0) <= 0x7f ? 1 : 2; return n; };
const msgFill = (tpl, f) => String(tpl || "").replace(/\{([^{}\n]{1,10})\}/g, (m, k) => MSG_FIELDS.includes(k) ? String((f && f[k]) ?? "") : m).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
function msgNorm(s) {
  s = s && typeof s === "object" ? s : {};
  const k = s.kakao && typeof s.kakao === "object" ? s.kakao : {}, a = s.auto && typeof s.auto === "object" ? s.auto : {}, t = s.tpl && typeof s.tpl === "object" ? s.tpl : {};
  const map = {};
  for (const key of Object.keys(MSG_TPL)) {
    const m = k.map && k.map[key];
    if (!m || typeof m !== "object" || !clip(m.templateId, 60)) continue;
    const vars = {};
    for (const [vn, fv] of Object.entries(m.vars && typeof m.vars === "object" ? m.vars : {}).slice(0, 20)) { const name = clip(vn, 30), val = clip(fv, 80); if (name) vars[name] = val; }
    map[key] = { templateId: clip(m.templateId, 60), name: clip(m.name, 60), vars };
  }
  const tpl = {};
  for (const key of Object.keys(MSG_TPL)) { const v = typeof t[key] === "string" ? t[key].replace(/\r/g, "").trim().slice(0, 600) : ""; if (v && v !== MSG_TPL[key][1]) tpl[key] = v; }
  const on = x => !!(x && x.on);
  return {
    sign: clip(s.sign, 20), from: String(s.from || "").replace(/[^0-9]/g, "").slice(0, 12),
    kakao: { on: !!k.on, pfId: clip(k.pfId, 60), map },
    tpl,
    auto: {
      invDue: { on: on(a.invDue), days: clampInt(a.invDue && a.invDue.days, 0, 14, 1) },
      invLate: { on: on(a.invLate), days: clampInt(a.invLate && a.invLate.days, 1, 30, 3) },
      quoteNudge: { on: on(a.quoteNudge), days: clampInt(a.quoteNudge && a.quoteNudge.days, 1, 30, 3) },
      resEve: { on: on(a.resEve), hour: clampInt(a.resEve && a.resEve.hour, 9, 19, 18), note: clip(a.resEve && a.resEve.note, 300) },
      edDue: { on: on(a.edDue), days: clampInt(a.edDue && a.edDue.days, 0, 14, 1) },
      edLate: { on: on(a.edLate), days: clampInt(a.edLate && a.edLate.days, 1, 30, 3) }
    },
    dayMax: clampInt(s.dayMax, 1, MSG_DAY_MAX, 300)
  };
}
const msgAutoOn = set => Object.values(set.auto).some(x => x.on);
const msgTextOf = (set, key) => set.tpl[key] || (MSG_TPL[key] ? MSG_TPL[key][1] : "");
async function msgState(db, ws) {   // 연결 정보(봉인) + 설정 — 질의 한 번
  const m = await modSettings(db, ws, "msg");
  const c = m.conn && typeof m.conn === "object" ? m.conn : null;
  return { conn: c, set: msgNorm(m.settings) };
}
const msgConnPublic = c => c ? { on: true, tail: c.tail || "…", at: c.at || "", balance: c.balance ?? null, point: c.point ?? null, checkedAt: c.checkedAt || "", senders: c.senders || [], channels: c.channels || [], templates: c.templates || [] } : { on: false };
/* 솔라피 API — 서명: HMAC-SHA256(API Secret, 날짜+소금)을 16진수로 */
async function solapi(sec, method, path, body) {
  const date = new Date().toISOString(), salt = rand(16);
  const key = await crypto.subtle.importKey("raw", enc.encode(sec.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(date + salt))));
  let r;
  try { r = await fetch("https://api.solapi.com" + path, { method, headers: { authorization: `HMAC-SHA256 apiKey=${sec.key}, date=${date}, salt=${salt}, signature=${sig}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { return { ok: false, status: 0, j: null }; }
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, j };
}
const solErr = x => x.status === 0 ? "upstream" : (x.status === 401 || x.status === 403) ? "bad-key" : "upstream";
async function msgSecret(env, c) { const t = c && c.sealed ? await unseal(env, c.sealed) : ""; const o = t ? parse(t) : null; return o && o.key && o.secret ? o : null; }
/* 한 번에 여러 건 보내기 — items: [{to, name, text, tpl, ref_kind, ref_id, fields}] → 건마다 결과. 기록(msg_log)에 남길 줄도 함께 돌려줍니다 */
async function msgDispatch(sec, set, items, opt) {
  const useK = !!opt.kakao && set.kakao.on && !!set.kakao.pfId;
  const out = [], messages = [], idx = [];
  for (const it of items) {
    const row = { to: it.to, name: it.name || "", text: it.text, tpl: it.tpl || "free", ref_kind: it.ref_kind || null, ref_id: it.ref_id || null, kind: "", status: "failed", pid: "", err: "" };
    out.push(row);
    const km = useK ? set.kakao.map[row.tpl] : null;
    let vars = null;
    if (km) { vars = {}; for (const [vn, fv] of Object.entries(km.vars)) { const val = fv.startsWith("=") ? fv.slice(1) : String((it.fields && it.fields[fv]) ?? ""); if (!val) { vars = null; break; } vars["#{" + vn + "}"] = val; } }   // 빈 칸이 하나라도 있으면 알림톡 대신 문자로 보냅니다
    if (vars) { row.kind = "ata"; messages.push({ to: it.to, from: set.from, kakaoOptions: { pfId: set.kakao.pfId, templateId: km.templateId, variables: vars } }); }
    else { const b = smsBytes(it.text); if (b > 2000) { row.err = "too-long"; continue; } row.kind = b <= 90 ? "sms" : "lms"; const m = { to: it.to, from: set.from, text: it.text, type: b <= 90 ? "SMS" : "LMS" }; if (b > 90 && set.sign) m.subject = set.sign.slice(0, 20); messages.push(m); }
    idx.push(out.length - 1);
  }
  if (!messages.length) return { rows: out, balance: null };
  const x = await solapi(sec, "POST", "/messages/v4/send-many/detail", { messages, showMessageList: true });
  if (!x.j || (!x.ok && !Array.isArray(x.j.failedMessageList) && !x.j.groupInfo)) { const e = x.j && (x.j.errorMessage || x.j.errorCode) ? clip(x.j.errorMessage || x.j.errorCode, 120) : solErr(x); for (const i of idx) out[i].err = e; return { rows: out, balance: null, fatal: solErr(x), detail: e, unknown: x.status === 0 || x.status >= 500 }; }   // unknown: 응답을 받지 못해 접수됐는지 알 수 없는 경우
  // 접수에 실패한 건은 failedMessageList에 받는 번호와 함께 옵니다. 나머지는 접수된 것으로 봅니다
  const digits = v => String(v || "").replace(/[^0-9]/g, ""), g = x.j.groupInfo || {};
  const failed = new Map(); for (const f of x.j.failedMessageList || []) { const k = digits(f && f.to); if (!failed.has(k)) failed.set(k, []); failed.get(k).push(f); }
  const ml = new Map(); for (const m of (Array.isArray(x.j.messageList) ? x.j.messageList : Object.values(x.j.messageList || {}))) { const k = digits(m && m.to); if (k) { if (!ml.has(k)) ml.set(k, []); ml.get(k).push(m); } }
  for (const i of idx) {
    const row = out[i], f = (failed.get(row.to) || []).shift();
    if (f) { row.err = clip(f.statusMessage || f.statusCode || "failed", 120); continue; }
    const m = (ml.get(row.to) || []).shift();
    row.status = "sent"; row.pid = clip((m && m.messageId) || g.groupId || g._id || "", 60);
  }
  return { rows: out, balance: g.balance != null ? Number(g.balance) : null, point: g.point != null ? Number(g.point) : null };
}
const msgLogStmt = (db, ws, rows, by, auto) => db.prepare("INSERT INTO msg_log(ws,id,at,by_id,by_name,kind,to_no,to_name,text,tpl,ref_kind,ref_id,status,pid,err,auto) SELECT ?1, ?2||'_'||key, ?3, ?4, ?5, json_extract(value,'$.kind'), json_extract(value,'$.to'), json_extract(value,'$.name'), json_extract(value,'$.text'), json_extract(value,'$.tpl'), json_extract(value,'$.ref_kind'), json_extract(value,'$.ref_id'), json_extract(value,'$.status'), json_extract(value,'$.pid'), json_extract(value,'$.err'), ?6 FROM json_each(?7)").bind(ws, uid("mg"), iso(), by ? by.id : null, by ? by.name : "자동", auto ? 1 : 0, JSON.stringify(rows.map(r => Object.assign({}, r, { kind: r.kind || "sms", text: clip(r.text, 1000) }))));
const msgCountSql = "SELECT COUNT(*) AS n FROM msg_log WHERE ws=?1 AND status='sent' AND at>=?2";
const kstDayStart = () => new Date(Date.parse(kstToday() + "T00:00:00Z") - 9 * 3600e3).toISOString();

Object.assign(PRIVATE, {
  async "msg/data"(db, me, b, req, url, env) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const st = await msgState(db, me.ws);
    const [a, c, l] = await db.batch([
      db.prepare(msgCountSql).bind(me.ws, kstDayStart()),
      db.prepare(msgCountSql).bind(me.ws, kstToday().slice(0, 7) + "-01T00:00:00.000Z"),
      db.prepare("SELECT id,at,by_name,kind,to_no,to_name,text,tpl,ref_kind,ref_id,status,err,auto FROM msg_log WHERE ws=?1 ORDER BY at DESC, id DESC LIMIT 100").bind(me.ws)
    ]);
    const n = r => Number((((r && r.results) || [])[0] || {}).n) || 0;
    return json({ ok: true, open: !!vaultKey(env), conn: msgConnPublic(st.conn), settings: st.set, today: n(a), month: n(c), log: (l && l.results) || [], tpl: Object.fromEntries(Object.entries(MSG_TPL).map(([k, v]) => [k, { name: v[0], text: v[1] }])), fields: MSG_FIELDS });
  },
  async "msg/connect"(db, me, b, req, url, env) {   // 내 솔라피 API 키 연결 — 잔액과 발신번호를 읽어 키가 맞는지 확인합니다
    if (me.role !== "admin") return fail("forbidden", 403);
    if (!vaultKey(env)) return fail("no-vault", 400, { hint: "운영자가 Cloudflare에 MW_VAULT_KEY(16자 이상)를 넣어야 연결할 수 있습니다." });
    const key = clip(b.key, 100), secret = clip(b.secret, 100);
    if (key.length < 8 || secret.length < 8) return fail("bad-request");
    const sec = { key, secret };
    const bal = await solapi(sec, "GET", "/cash/v1/balance");
    if (!bal.ok || !bal.j) return fail(solErr(bal), 400, { detail: bal.j && (bal.j.errorMessage || bal.j.errorCode) ? clip(bal.j.errorMessage || bal.j.errorCode, 160) : "" });
    const snd = await solapi(sec, "GET", "/senderid/v1/numbers/active");
    const senders = (Array.isArray(snd.j) ? snd.j : []).map(x => String((x && x.phoneNumber) || "").replace(/[^0-9]/g, "")).filter(Boolean).slice(0, 30);
    const now = iso(), conn = { sealed: await seal(env, JSON.stringify(sec)), tail: mkTail(key), at: now, by: me.id, balance: Number(bal.j.balance) || 0, point: Number(bal.j.point) || 0, checkedAt: now, senders, channels: [], templates: [] };
    const st = await msgState(db, me.ws), set = st.set;
    if (!senders.includes(set.from)) set.from = senders[0] || "";
    if (!set.sign) set.sign = clip(me.wname, 20);
    await db.batch([
      db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'msg','conn',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(conn)),
      db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'msg','settings',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(set))
    ]);
    return json({ ok: true, conn: msgConnPublic(conn), settings: set });
  },
  async "msg/disconnect"(db, me) {
    if (me.role !== "admin") return fail("forbidden", 403);
    await db.batch([db.prepare("DELETE FROM mod_set WHERE ws=?1 AND mod='msg' AND k='conn'").bind(me.ws), db.prepare("DELETE FROM msg_auto WHERE ws=?1").bind(me.ws)]);
    return json({ ok: true, conn: { on: false } });
  },
  async "msg/refresh"(db, me, b, req, url, env) {   // 잔액 · 발신번호 · 카카오 채널 · 알림톡 템플릿 다시 읽기
    if (!isMgr(me)) return fail("forbidden", 403);
    const st = await msgState(db, me.ws), sec = await msgSecret(env, st.conn);
    if (!sec) return fail("not-connected", 400);
    const [bal, snd, ch, tp] = await Promise.all([solapi(sec, "GET", "/cash/v1/balance"), solapi(sec, "GET", "/senderid/v1/numbers/active"), solapi(sec, "GET", "/kakao/v2/channels?limit=50"), solapi(sec, "GET", "/kakao/v2/templates/sendable")]);
    if (!bal.ok) return fail(solErr(bal), 400);
    const conn = Object.assign({}, st.conn, {
      balance: Number(bal.j && bal.j.balance) || 0, point: Number(bal.j && bal.j.point) || 0, checkedAt: iso(),
      senders: (Array.isArray(snd.j) ? snd.j : []).map(x => String((x && x.phoneNumber) || "").replace(/[^0-9]/g, "")).filter(Boolean).slice(0, 30),
      channels: ((ch.j && Array.isArray(ch.j.channelList)) ? ch.j.channelList : []).map(x => ({ id: clip(x.channelId, 60), name: clip(x.channelName || x.searchId, 40) })).filter(x => x.id).slice(0, 20),
      templates: (Array.isArray(tp.j) ? tp.j : []).map(x => ({ id: clip(x.templateId, 60), name: clip(x.name, 60), channelId: clip(x.channelId, 60), content: clip(x.content, 1000), vars: (Array.isArray(x.variables) ? x.variables : []).map(v => clip(v && v.name, 30)).filter(Boolean).slice(0, 20) })).filter(x => x.id).slice(0, 60)
    });
    await db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'msg','conn',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(conn)).run();
    return json({ ok: true, conn: msgConnPublic(conn) });
  },
  async "msg/settings"(db, me, b) {
    if (me.role !== "admin") return fail("forbidden", 403);
    const st = await msgState(db, me.ws), cur = st.set, inp = b.set && typeof b.set === "object" ? b.set : {};
    const next = msgNorm(Object.assign({}, cur, inp, { kakao: Object.assign({}, cur.kakao, inp.kakao || {}), auto: Object.assign({}, cur.auto, inp.auto || {}), tpl: Object.assign({}, cur.tpl, inp.tpl || {}) }));
    if (next.from && st.conn && !(st.conn.senders || []).includes(next.from)) return fail("bad-sender", 400);
    if (msgAutoOn(next) && !st.conn) return fail("not-connected", 400);
    await db.batch([
      db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'msg','settings',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(next)),
      msgAutoOn(next) ? db.prepare("INSERT INTO msg_auto(ws,next_at) VALUES(?1,?2) ON CONFLICT(ws) DO NOTHING").bind(me.ws, iso()) : db.prepare("DELETE FROM msg_auto WHERE ws=?1").bind(me.ws)
    ]);
    return json({ ok: true, settings: next });
  },
  async "msg/send"(db, me, b, req, url, env) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const st = await msgState(db, me.ws), set = st.set, sec = await msgSecret(env, st.conn);
    if (!sec) return fail("not-connected", 400);
    if (!set.from) return fail("no-sender", 400);
    const seen = new Set(), items = [];
    for (const x of (Array.isArray(b.items) ? b.items : []).slice(0, MSG_SEND_MAX * 2)) {
      if (!x || typeof x !== "object") continue;
      const to = phoneKR(x.to), text = String(x.text || "").replace(/\r/g, "").trim();
      if (!to) return fail("bad-phone", 400, { to: clip(x.to, 20) });
      if (!text) return fail("empty", 400);
      if (/^\s*[\(\[（]\s*광고\s*[\)\]）]/.test(text)) return fail("ad-not-allowed", 400);   // 광고 문자는 수신 동의·수신거부 안내·야간 제한이 따로 있어 여기서는 보내지 않습니다
      if (smsBytes(text) > 2000) return fail("too-long", 400);
      const tpl = MSG_TPL[x.tpl] ? x.tpl : "free", k = to + "|" + tpl + "|" + clip(x.ref_id, 60);
      if (seen.has(k)) continue; seen.add(k);
      const f = {}; if (x.fields && typeof x.fields === "object") for (const key of MSG_FIELDS) if (x.fields[key] != null) f[key] = clip(x.fields[key], 200);
      items.push({ to, name: clip(x.name, 40), text, tpl, ref_kind: clip(x.ref_kind, 20) || null, ref_id: clip(x.ref_id, 60) || null, fields: f });
    }
    if (!items.length) return fail("empty", 400);
    if (items.length > MSG_SEND_MAX) return fail("too-many", 400, { limit: MSG_SEND_MAX });
    const c = await db.prepare(msgCountSql).bind(me.ws, kstDayStart()).first(), used = c ? Number(c.n) : 0;
    if (used + items.length > set.dayMax) return fail("day-limit", 429, { limit: set.dayMax, used });
    const r = await msgDispatch(sec, set, items, { kakao: b.kakao !== false });
    const stmts = [msgLogStmt(db, me.ws, r.rows, me, false)];
    if (r.balance != null) stmts.push(db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'msg','conn',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(Object.assign({}, st.conn, { balance: r.balance, point: r.point ?? st.conn.point, checkedAt: iso() }))));
    await db.batch(stmts);
    const sent = r.rows.filter(x => x.status === "sent").length;
    if (!sent && r.fatal) return fail(r.fatal, 502, { detail: r.detail || "" });
    return json({ ok: true, sent, failed: r.rows.length - sent, results: r.rows.map(x => ({ to: x.to, kind: x.kind, status: x.status, err: x.err })), balance: r.balance, today: used + sent });
  },
  async "msg/log"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const before = clip(b.before, 30) || "9999", ref = clip(b.ref_id, 60);
    const rs = (await (ref ? db.prepare("SELECT id,at,by_name,kind,to_no,to_name,text,tpl,ref_kind,ref_id,status,err,auto FROM msg_log WHERE ws=?1 AND ref_id=?2 ORDER BY at DESC LIMIT 30").bind(me.ws, ref) : db.prepare("SELECT id,at,by_name,kind,to_no,to_name,text,tpl,ref_kind,ref_id,status,err,auto FROM msg_log WHERE ws=?1 AND at<?2 ORDER BY at DESC, id DESC LIMIT 100").bind(me.ws, before)).all()).results || [];
    return json({ ok: true, log: rs });
  }
});

/* ── 자동 안내 — tick에서 한 번에 워크스페이스 둘까지. 보내기 직전에 상태를 다시 읽습니다 ── */
async function msgAutoRun(db, now) {
  const env = db.env, nowIso = new Date(now).toISOString();
  if (!vaultKey(env)) return {};
  const todo = (await db.prepare("SELECT a.ws, w.status AS wst, w.name AS wname, w.plan, w.modules, w.limits, w.plan_until FROM msg_auto a JOIN workspaces w ON w.id=a.ws WHERE a.next_at<=?1 ORDER BY a.next_at LIMIT 2").bind(nowIso).all()).results || [];
  let autoSent = 0;
  for (const w of todo) {
    const hour = kstHour(now), open = hour >= 9 && hour < 20;
    const next = open ? new Date(now + 3600e3).toISOString() : new Date(Date.parse(addDaysS(kstToday(), hour >= 20 ? 1 : 0) + "T00:00:00Z")).toISOString();   // 밤에는 쉬고 다음 날 오전 9시(한국 시간)에
    await db.prepare("UPDATE msg_auto SET next_at=?2 WHERE ws=?1").bind(w.ws, next).run();
    if (!open || w.wst !== "active") continue;
    try { autoSent += await msgAutoWs(db, env, w, now); } catch (e) {}
  }
  return todo.length ? { autoSent } : {};
}
async function msgAutoWs(db, env, w, now) {
  const st = await msgState(db, w.ws), set = st.set, sec = await msgSecret(env, st.conn);
  if (!sec || !set.from || !msgAutoOn(set)) { await db.prepare("DELETE FROM msg_auto WHERE ws=?1").bind(w.ws).run(); return 0; }
  const today = kstToday(), A = set.auto, sign = set.sign || w.wname || "", base = "https://" + CANON_HOST + "/link/", hour = kstHour(now);
  const cand = [];   // {tpl, ref_kind, ref_id, to, name, fields, link?: {kind, target}}
  const qs = [], tags = [];
  if (A.invDue.on || A.invLate.on) {
    const dates = [A.invDue.on ? addDaysS(today, A.invDue.days) : "", A.invLate.on ? addDaysS(today, -A.invLate.days) : ""];
    qs.push(db.prepare("SELECT v.id, v.no, v.due_date, v.net, j.title, j.client_name, json_extract(e.data,'$.phone') AS phone, json_extract(e.data,'$.name') AS cname FROM os_invoice v JOIN os_job j ON j.ws=v.ws AND j.id=v.job_id LEFT JOIN ent e ON e.ws=v.ws AND e.kind='contact' AND e.id=j.client_id AND e.deleted=0 WHERE v.ws=?1 AND v.status='issued' AND v.due_date IN (?2,?3) LIMIT 60").bind(w.ws, dates[0], dates[1])); tags.push(["inv", dates]);
  }
  if (A.quoteNudge.on) {
    const d = addDaysS(today, -A.quoteNudge.days);
    qs.push(db.prepare("SELECT q.id, q.no, j.title, j.client_name, json_extract(e.data,'$.phone') AS phone, json_extract(e.data,'$.name') AS cname, l.token FROM links l JOIN os_quote q ON q.ws=l.ws AND q.id=l.target JOIN os_job j ON j.ws=q.ws AND j.id=q.job_id LEFT JOIN ent e ON e.ws=q.ws AND e.kind='contact' AND e.id=j.client_id AND e.deleted=0 WHERE l.ws=?1 AND l.kind='quote' AND l.used_at IS NULL AND l.expires_at>?2 AND q.status='sent' AND l.created_at>=?3 AND l.created_at<?4 LIMIT 60").bind(w.ws, new Date(now).toISOString(), new Date(Date.parse(d + "T00:00:00Z") - 9 * 3600e3).toISOString(), new Date(Date.parse(d + "T00:00:00Z") + 15 * 3600e3).toISOString())); tags.push(["quote"]);
  }
  if (A.resEve.on && hour >= A.resEve.hour && tierOf(w).modules.includes("space")) {
    qs.push(db.prepare("SELECT r.id, r.customer, r.phone, r.res_date, r.start_t, r.slot, json_extract(e.data,'$.name') AS bname FROM sp_res r LEFT JOIN ent e ON e.ws=r.ws AND e.kind='store' AND e.id=r.branch_id WHERE r.ws=?1 AND r.res_date=?2 AND r.phone IS NOT NULL AND r.phone<>'' AND (r.status IS NULL OR r.status NOT LIKE '%취소%') LIMIT 80").bind(w.ws, addDaysS(today, 1))); tags.push(["res"]);
  }
  const hk = [];
  for (const h of MSG_AUTO_HOOKS) { try { hk.push(...await h(db, w, set, A, today, sign)); } catch (e) {} }
  if (!qs.length && !hk.length) return 0;
  const rs = qs.length ? await db.batch(qs) : [];
  const won = n => (Number(n) || 0).toLocaleString("ko-KR") + "원", md = d => String(d || "").slice(5).replace("-", "/");
  rs.forEach((r, i) => {
    const rows = (r && r.results) || [], tag = tags[i];
    if (tag[0] === "inv") for (const v of rows) { const to = phoneKR(v.phone); if (!to) continue; const due = v.due_date === tag[1][0] && A.invDue.on; cand.push({ tpl: due ? "auto.invDue" : "auto.invLate", ref_kind: "invoice", ref_id: v.id, to, name: v.cname || v.client_name || "", fields: { 상호: sign, 이름: v.cname || v.client_name || "고객", 제목: v.title || v.no || "", 금액: won(v.net), 기한: md(v.due_date) }, link: { kind: "invoice", target: v.id } }); }
    else if (tag[0] === "quote") for (const q of rows) { const to = phoneKR(q.phone); if (!to) continue; cand.push({ tpl: "auto.quoteNudge", ref_kind: "quote", ref_id: q.id, to, name: q.cname || q.client_name || "", fields: { 상호: sign, 이름: q.cname || q.client_name || "고객", 제목: q.title || q.no || "", 링크: base + q.token, 코드: q.token } }); }
    else for (const x of rows) { const to = phoneKR(x.phone); if (!to) continue; cand.push({ tpl: "auto.resEve", ref_kind: "res", ref_id: x.id, to, name: x.customer || "", fields: { 상호: sign, 이름: x.customer || "고객", 날짜: md(x.res_date), 시간: x.start_t || ({ day: "낮", night: "밤", allday: "종일" })[x.slot] || "", 지점: x.bname || "", 안내: A.resEve.note || "" } }); }
  });
  cand.push(...hk);
  if (!cand.length) return 0;
  // 이미 보낸 것은 빼고, 오늘 한도 안에서. 보냈거나, 보냈는지 모르거나, 두 번 실패한 안내는 다시 보내지 않습니다
  const [done, cnt, lk] = await db.batch([
    db.prepare("SELECT ref_id, tpl, SUM(CASE WHEN status IN ('sent','pending') THEN 1 ELSE 0 END) AS done, COUNT(*) AS n FROM msg_log WHERE ws=?1 AND auto=1 AND ref_id IN (SELECT value FROM json_each(?2)) GROUP BY ref_id, tpl").bind(w.ws, JSON.stringify([...new Set(cand.map(c => c.ref_id))])),
    db.prepare(msgCountSql).bind(w.ws, kstDayStart()),
    db.prepare("SELECT kind, target, token FROM links WHERE ws=?1 AND kind IN ('invoice','ed-guard') AND used_at IS NULL AND expires_at>?2 AND target IN (SELECT value FROM json_each(?3))").bind(w.ws, new Date(now + 864e5).toISOString(), JSON.stringify(cand.filter(c => c.link).map(c => c.link.target)))
  ]);
  const sentKey = new Set(((done && done.results) || []).filter(x => Number(x.done) > 0 || Number(x.n) >= MSG_AUTO_TRIES).map(x => x.ref_id + "|" + x.tpl)), used = Number(((((cnt && cnt.results) || [])[0]) || {}).n) || 0;
  const tokens = new Map(((lk && lk.results) || []).map(x => [x.target, x.token]));
  const room = Math.max(0, Math.min(MSG_AUTO_RUN, set.dayMax - used));
  const list = cand.filter(c => !sentKey.has(c.ref_id + "|" + c.tpl)).slice(0, room);
  if (!list.length) return 0;
  const newLinks = [];
  for (const c of list) if (c.link) { let t = tokens.get(c.link.target); if (!t) { t = rand(16); tokens.set(c.link.target, t); newLinks.push(db.prepare("INSERT INTO links(token,ws,kind,target,created_by,created_at,expires_at) VALUES(?1,?2,?3,?4,NULL,?5,?6)").bind(t, w.ws, c.link.kind, c.link.target, iso(), new Date(now + (c.link.kind === "ed-guard" ? 365 : 30) * 864e5).toISOString())); } c.fields.링크 = base + t; c.fields.코드 = t; }
  if (newLinks.length) await db.batch(newLinks);
  const items = list.map(c => ({ to: c.to, name: c.name, text: msgFill(msgTextOf(set, c.tpl), c.fields), tpl: c.tpl, ref_kind: c.ref_kind, ref_id: c.ref_id, fields: c.fields })).filter(x => x.text);
  if (!items.length) return 0;
  /* 보내기 전에 먼저 적어 둡니다. 보낸 뒤 기록을 남기기 전에 끊기면 다음 차례에 같은 안내가 한 번 더 나가기 때문입니다.
     먼저 적어 두면 끊겨도 ‘확인 필요’로 남을 뿐 고객에게 두 번 가지 않습니다. */
  const hold = uid("mg"), at = iso();
  await db.prepare("INSERT INTO msg_log(ws,id,at,by_id,by_name,kind,to_no,to_name,text,tpl,ref_kind,ref_id,status,pid,err,auto) SELECT ?1, ?2||'_'||key, ?3, NULL, '자동', 'sms', json_extract(value,'$.to'), json_extract(value,'$.name'), json_extract(value,'$.text'), json_extract(value,'$.tpl'), json_extract(value,'$.ref_kind'), json_extract(value,'$.ref_id'), 'pending', '', '', 1 FROM json_each(?4)")
    .bind(w.ws, hold, at, JSON.stringify(items.map(x => ({ to: x.to, name: x.name || "", text: clip(x.text, 1000), tpl: x.tpl, ref_kind: x.ref_kind, ref_id: x.ref_id })))).run();
  const r = await msgDispatch(sec, set, items, { kakao: true });
  if (r.unknown) {   // 접수됐는지 알 수 없으면 ‘확인 필요’로 둡니다 — 다시 보내지 않습니다
    await notify(db, w.ws, await whoIs(db, w.ws, ["admin"]), { type: "money", title: "자동 안내를 보내다 연결이 끊겼습니다", body: `${items.length}건 — 보낸 기록에서 확인해 주세요`, url: "#/msg/log", tag: "msg-auto" });
    return 0;
  }
  await db.prepare("UPDATE msg_log SET kind=json_extract(j.value,'$.kind'), status=json_extract(j.value,'$.status'), pid=json_extract(j.value,'$.pid'), err=json_extract(j.value,'$.err') FROM json_each(?3) AS j WHERE msg_log.ws=?1 AND msg_log.id=?2||'_'||j.key")
    .bind(w.ws, hold, JSON.stringify(r.rows.map(x => ({ kind: x.kind || "sms", status: x.status, pid: x.pid || "", err: x.err || "" })))).run();
  const sent = r.rows.filter(x => x.status === "sent").length, failed = r.rows.length - sent;
  if (sent || failed) await notify(db, w.ws, await whoIs(db, w.ws, ["admin"]), { type: "money", title: `자동 안내 ${sent}건을 보냈습니다${failed ? ` · 실패 ${failed}건` : ""}`, body: [...new Set(r.rows.map(x => MSG_TPL[x.tpl] ? MSG_TPL[x.tpl][0] : ""))].filter(Boolean).join(" · "), url: "#/msg/log", tag: "msg-auto" });
  return sent;
}
TICK_JOBS.push(msgAutoRun);

/* ═════════ 홈택스 자료 자동 수집 — 세금계산서·현금영수증 매출·매입을 증빙 대장으로 ═════════
   · 홈택스에는 공개 API가 없어, 홈택스 수집 서비스(팝빌)를 거칩니다. 운영자가 팝빌과 연동 계약을 맺고
     Cloudflare에 POPBILL_LINK_ID · POPBILL_SECRET_KEY 를 넣어야 열립니다. (POPBILL_TEST=1 이면 시험 환경)
   · 사업자마다: ① 수집 서비스 가입(사업자 정보 전달) → ② 홈택스 ‘부서사용자’(조회 전용) 아이디·비밀번호 등록 → ③ 가져오기.
     부서사용자 비밀번호는 팝빌에 등록만 하고 마이웍스에는 저장하지 않습니다.
   · 가져온 자료는 승인번호로 겹치지 않게 증빙 대장(tx_doc)에 넣습니다. 지우거나 고친 것은 건드리지 않습니다.
   · 수집은 요청 → 잠시 뒤 결과 확인의 두 걸음입니다. 화면이 몇 초마다 확인하고, 자동 수집은 tick이 이어 갑니다. */
const HT_DDL = [
  "CREATE TABLE IF NOT EXISTS ht_job(ws TEXT NOT NULL, id TEXT NOT NULL, biz_id TEXT NOT NULL, svc TEXT NOT NULL, qtype TEXT NOT NULL, job_id TEXT NOT NULL, sdate TEXT NOT NULL, edate TEXT NOT NULL, state TEXT NOT NULL, added INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, err TEXT, auto INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL, done_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_ht_job_state ON ht_job(ws, state, at)",
  "CREATE TABLE IF NOT EXISTS ht_auto(ws TEXT NOT NULL, biz_id TEXT NOT NULL, next_at TEXT NOT NULL, PRIMARY KEY(ws,biz_id))",
  "CREATE INDEX IF NOT EXISTS idx_ht_auto_next ON ht_auto(next_at)"
];
const HT_TABLES = ["ht_job", "ht_auto"];
const HT_SVC = { ti: ["Taxinvoice", "111", "세금계산서"], cb: ["Cashbill", "141", "현금영수증"] };
const HT_MAX_DAYS = 92, HT_JOB_TTL = 55 * 60e3, HT_GAP = 10 * 60e3;
const pbOn = env => !!(env && typeof env.POPBILL_LINK_ID === "string" && env.POPBILL_LINK_ID.trim() && typeof env.POPBILL_SECRET_KEY === "string" && env.POPBILL_SECRET_KEY.trim().length >= 16);
const pbTest = env => !!(env && env.POPBILL_TEST && String(env.POPBILL_TEST) !== "0");
const PB_TOK = new Map();
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const pbFail = (j, status) => Object.assign(new Error("popbill"), { pb: true, code: j && j.code != null ? Number(j.code) : 0, msg: clip((j && j.message) || (status ? "HTTP " + status : "연결하지 못했습니다"), 200) });
/* 링크허브 토큰 — 사업자번호·서비스마다 하나. 서명: base64(HMAC-SHA256(비밀키, "POST\n본문해시\n시각\n*\n2.0\n/POPBILL/Token")) */
async function pbToken(env, corp, scope) {
  const key = (pbTest(env) ? "T" : "P") + corp + ":" + scope, c = PB_TOK.get(key);
  if (c && c.exp - Date.now() > 120e3) return c.t;
  const uri = "/" + (pbTest(env) ? "POPBILL_TEST" : "POPBILL") + "/Token", body = JSON.stringify({ access_id: corp, scope: ["member", scope] }), xDate = new Date().toISOString();
  const digest = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(body))));
  let raw; try { raw = Uint8Array.from(atob(env.POPBILL_SECRET_KEY.trim()), ch => ch.charCodeAt(0)); } catch (e) { throw pbFail({ message: "POPBILL_SECRET_KEY 값이 올바르지 않습니다." }); }
  const hk = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = b64(new Uint8Array(await crypto.subtle.sign("HMAC", hk, enc.encode("POST\n" + digest + "\n" + xDate + "\n*\n2.0\n" + uri))));
  let r; try { r = await fetch("https://auth.linkhub.co.kr" + uri, { method: "POST", headers: { "x-lh-date": xDate, "x-lh-version": "2.0", "x-lh-forwarded": "*", "Content-Type": "Application/json", Authorization: "LINKHUB " + env.POPBILL_LINK_ID.trim() + " " + sig }, body }); } catch (e) { throw pbFail(null, 0); }
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.session_token) throw pbFail(j, r.status);
  const exp = Date.parse(j.expiration);
  PB_TOK.set(key, { t: j.session_token, exp: Number.isFinite(exp) ? exp : Date.now() + 600e3 }); if (PB_TOK.size > 200) PB_TOK.delete(PB_TOK.keys().next().value);
  return j.session_token;
}
/* 팝빌 요청 — scope 가 없으면 토큰 없이(가입 확인·가입). 실패하면 { pb, code, msg } 를 던집니다 */
async function pb(env, corp, scope, method, path, body) {
  const h = { "Content-Type": "application/json;charset=utf-8" };
  if (scope) h.Authorization = "Bearer " + await pbToken(env, corp, scope);
  let m = method; if (method === "DELETE") { h["X-HTTP-Method-Override"] = "DELETE"; m = "POST"; }
  let r; try { r = await fetch("https://" + (pbTest(env) ? "popbill-test.linkhub.co.kr" : "popbill.linkhub.co.kr") + path, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined }); } catch (e) { throw pbFail(null, 0); }
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw pbFail(j, r.status);
  return j;
}
const pbOut = e => e && e.pb ? fail("provider", 502, { detail: e.msg, code: e.code }) : null;
function htNorm(s) {   // 사업자마다의 연결 상태 — 비밀번호는 들어 있지 않습니다
  s = s && typeof s === "object" ? s : {}; const out = {};
  for (const [id, x] of Object.entries(s.biz && typeof s.biz === "object" ? s.biz : {}).slice(0, 30)) {
    if (!x || typeof x !== "object") continue;
    out[clip(id, 60)] = { corp: bizNo(x.corp).slice(0, 10), joined: !!x.joined, pbId: clip(x.pbId, 50), dept: { ti: !!(x.dept && x.dept.ti), cb: !!(x.dept && x.dept.cb), id: clip(x.dept && x.dept.id, 40), at: clip(x.dept && x.dept.at, 30) }, auto: !!x.auto, last: dOk(x.last), lastAt: clip(x.lastAt, 30), lastAdded: intOr(x.lastAdded, 0), err: clip(x.err, 200) };
  }
  return { biz: out };
}
/* 워크스페이스를 지울 때 — 팝빌에 남아 있는 부서사용자 등록을 지웁니다. 실패해도 삭제는 계속합니다 */
async function htForget(db, ws) {
  const env = db.env; if (!pbOn(env)) return;
  let st; try { st = await htState(db, ws); } catch (e) { return; }
  const jobs = [];
  for (const x of Object.values(st.biz).filter(x => x.corp.length === 10 && (x.dept.ti || x.dept.cb)).slice(0, 5))
    for (const svc of ["ti", "cb"]) if (x.dept[svc]) jobs.push(pb(env, x.corp, HT_SVC[svc][1], "DELETE", `/HomeTax/${HT_SVC[svc][0]}/DeptUser`).catch(() => {}));
  if (jobs.length) db.wait(Promise.allSettled(jobs));
}
async function htState(db, ws) { const r = await db.prepare("SELECT v FROM mod_set WHERE ws=?1 AND mod='tx' AND k='ht'").bind(ws).first(); return htNorm(r ? parse(r.v) : null); }
const htSave = (db, ws, st) => db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'tx','ht',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(ws, JSON.stringify(st));
const ymd8 = d => String(d || "").replace(/-/g, ""), d10 = s => /^\d{8}$/.test(String(s || "")) ? s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8) : "";
const htTi = (x, sale) => ({ dir: sale ? "sale" : "buy", kind: x.taxType === "면세" ? "계산서" : "세금계산서", date: d10(x.writeDate), partner: sale ? x.invoiceeCorpName : x.invoicerCorpName, partner_no: sale ? x.invoiceeCorpNum : x.invoicerCorpNum, supply: x.supplyCostTotal, vat: x.taxTotal, total: x.totalAmount, item: x.itemName || "", approve_no: x.ntsconfirmNum, memo: x.modifyYN === true || x.modifyYN === "true" ? "수정세금계산서" : "" });
const htCb = (x, sale) => { const neg = x.tradeType === "취소거래" ? -1 : 1, n = v => neg * intOr(String(v ?? "").replace(/[^\d.-]/g, ""), 0); return { dir: sale ? "sale" : "buy", kind: "현금영수증", date: d10(x.tradeDate), partner: sale ? (x.customerName || "") : (x.franchiseCorpName || ""), partner_no: sale ? "" : (x.franchiseCorpNum || ""), supply: n(x.supplyCost), vat: n(x.tax), total: n(x.totalAmount), item: x.tradeUsage || "", approve_no: x.ntsconfirmNum, memo: neg < 0 ? "취소거래" : "" }; };
/* 증빙 대장에 넣기 — 승인번호(없으면 방향·날짜·상대·금액)가 같은 것은 건너뜁니다. 파일 올리기와 자동 수집이 같은 길을 씁니다 */
async function txDocAdd(db, me, rowsIn, bizId, source) {
  const rows = rowsIn.slice(0, 5000).map(r => txDocIn(r || {})).filter(r => r.date && (r.total || r.supply));
  if (!rows.length) return { added: 0, skipped: 0, v: null, empty: true };
  const dates = rows.map(r => r.date).sort(), now = iso();
  const ex = (await db.prepare("SELECT approve_no, dir, date, partner_no, total FROM tx_doc WHERE ws=?1 AND date>=?2 AND date<=?3").bind(me.ws, dates[0], dates[dates.length - 1]).all()).results || [];
  const seenA = new Set(ex.map(x => x.approve_no).filter(Boolean)), seenK = new Set(ex.map(x => [x.dir, x.date, x.partner_no || "", x.total].join("|")));
  const add = []; let skipped = 0;
  for (const r of rows) {
    const k = [r.dir || "sale", r.date, r.partner_no || "", r.total || (r.supply || 0) + (r.vat || 0)].join("|");
    if ((r.approve_no && seenA.has(r.approve_no)) || (!r.approve_no && seenK.has(k))) { skipped++; continue; }
    if (r.approve_no) seenA.add(r.approve_no); seenK.add(k);
    add.push(Object.assign({ id: bulkId("dc"), biz_id: clip(bizId, 60) || null, dir: "sale", kind: "세금계산서", partner: "", partner_no: "", supply: 0, vat: 0, total: 0, item: "", approve_no: null, status: "done", fin_id: null, ref: null, source: source || "hometax", memo: "", created_at: now, updated_at: now }, r, { total: r.total || (r.supply || 0) + (r.vat || 0) }));
  }
  const { v } = add.length ? await spRun(db, me, spBulk(db, "tx_doc", me.ws, add)) : { v: null };
  return { added: add.length, skipped, v };
}
async function htBiz(db, me, id) {   // 사업자번호가 있는 사업자 + 연결 상태
  const b = await spOne(db, "tx_biz", me.ws, clip(id, 60)), corp = b ? bizNo(b.biz_no) : "";
  if (!b) return { err: fail("not-found", 404) };
  if (corp.length !== 10) return { err: fail("no-bizno", 400) };
  const st = await htState(db, me.ws);
  if (!st.biz[b.id]) st.biz[b.id] = htNorm({ biz: { x: { corp } } }).biz.x;
  if (st.biz[b.id].corp !== corp) st.biz[b.id] = htNorm({ biz: { x: { corp } } }).biz.x;   // 사업자번호가 바뀌었으면 처음부터
  return { b, corp, st, s: st.biz[b.id] };
}
/* 수집 요청 — 세금계산서·현금영수증 × 매출·매입 네 건 */
async function htRequest(db, env, me, x, from, to, auto) {
  const jobs = [], now = iso(), errs = [];
  for (const svc of ["ti", "cb"]) {
    if (!x.s.dept[svc]) continue;
    for (const q of ["SELL", "BUY"]) {
      try {
        const j = await pb(env, x.corp, HT_SVC[svc][1], "POST", `/HomeTax/${HT_SVC[svc][0]}/${q}?${svc === "ti" ? "DType=W&" : ""}SDate=${ymd8(from)}&EDate=${ymd8(to)}`);
        if (j.jobID) jobs.push({ id: bulkId("hj"), biz_id: x.b.id, svc, qtype: q, job_id: clip(j.jobID, 40), sdate: from, edate: to, state: "req", auto: auto ? 1 : 0, at: now });
      } catch (e) { if (!e.pb) throw e; errs.push(`${HT_SVC[svc][2]} ${q === "SELL" ? "매출" : "매입"}: ${e.msg}`); }
    }
  }
  x.s.err = errs.join(" / "); if (jobs.length) x.s.lastAt = now;
  const stmts = [htSave(db, me.ws, x.st)];
  if (jobs.length) stmts.push(db.prepare("INSERT INTO ht_job(ws,id,biz_id,svc,qtype,job_id,sdate,edate,state,auto,at) SELECT ?1, json_extract(value,'$.id'), json_extract(value,'$.biz_id'), json_extract(value,'$.svc'), json_extract(value,'$.qtype'), json_extract(value,'$.job_id'), json_extract(value,'$.sdate'), json_extract(value,'$.edate'), 'req', json_extract(value,'$.auto'), json_extract(value,'$.at') FROM json_each(?2)").bind(me.ws, JSON.stringify(jobs)));
  await db.batch(stmts);
  return { jobs, errs };
}
/* 결과 확인 — 끝난 작업의 자료를 증빙 대장에 넣습니다 */
async function htPoll(db, env, me, x) {
  const pend = (await db.prepare("SELECT id, svc, qtype, job_id, sdate, edate, at, auto FROM ht_job WHERE ws=?1 AND biz_id=?2 AND state='req' ORDER BY at LIMIT 8").bind(me.ws, x.b.id).all()).results || [];
  let added = 0, skipped = 0, left = 0, v = null; const upd = [], errs = [];
  for (const j of pend) {
    const S = HT_SVC[j.svc], sale = j.qtype === "SELL", now = iso();
    if (Date.now() - Date.parse(j.at) > HT_JOB_TTL) { upd.push({ id: j.id, state: "fail", err: "시간이 지나 다시 요청해야 합니다", added: 0, skipped: 0, at: now }); continue; }
    try {
      const st = await pb(env, x.corp, S[1], "GET", `/HomeTax/${S[0]}/${j.job_id}/State`);
      if (Number(st.jobState) !== 3) { left++; continue; }
      if (Number(st.errorCode) !== 1) { const m = clip(st.errorReason || "수집하지 못했습니다", 160); upd.push({ id: j.id, state: "fail", err: m, added: 0, skipped: 0, at: now }); errs.push(`${S[2]} ${sale ? "매출" : "매입"}: ${m}`); continue; }
      const rows = [];
      for (let page = 1; page <= 5; page++) {
        const r = await pb(env, x.corp, S[1], "GET", `/HomeTax/${S[0]}/${j.job_id}?${j.svc === "ti" ? "Type=N,M&TaxType=T,N,Z&PurposeType=R,C,N" : "TradeType=N,C&TradeUsage=P,C"}&Page=${page}&PerPage=1000&Order=A`);
        for (const it of Array.isArray(r.list) ? r.list : []) rows.push(j.svc === "ti" ? htTi(it, sale) : htCb(it, sale));
        if (!(Number(r.pageCount) > page)) break;
      }
      const res = rows.length ? await txDocAdd(db, me, rows, x.b.id, "hometax-auto") : { added: 0, skipped: 0, v: null };
      added += res.added; skipped += res.skipped; if (res.v != null) v = res.v;
      upd.push({ id: j.id, state: "done", err: "", added: res.added, skipped: res.skipped, at: now });
    } catch (e) { if (!e.pb) throw e; upd.push({ id: j.id, state: "fail", err: e.msg, added: 0, skipped: 0, at: iso() }); errs.push(`${S[2]} ${sale ? "매출" : "매입"}: ${e.msg}`); }
  }
  if (upd.length) {
    const doneAll = !left, ok = upd.some(u => u.state === "done");
    if (doneAll && ok) { x.s.last = pend.map(p => p.edate).sort().pop() || x.s.last; x.s.lastAdded = added; }
    if (doneAll) x.s.err = errs.join(" / ");
    await db.batch(upd.map(u => db.prepare("UPDATE ht_job SET state=?3, err=?4, added=?5, skipped=?6, done_at=?7 WHERE ws=?1 AND id=?2").bind(me.ws, u.id, u.state, u.err, u.added, u.skipped, u.at)).concat([htSave(db, me.ws, x.st)]));
  }
  return { pending: left, added, skipped, v, errs, finished: upd.length, auto: pend.some(p => Number(p.auto)) };
}
const htPublic = (st, jobs) => ({ biz: st.biz, jobs });
const htJobs = async (db, ws) => ((await db.prepare("SELECT id, biz_id, svc, qtype, sdate, edate, state, added, skipped, err, auto, at, done_at FROM ht_job WHERE ws=?1 ORDER BY at DESC LIMIT 24").bind(ws).all()).results || []);

Object.assign(TAX, {
  async "ht/state"(db, me, b, req, url, env) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const st = await htState(db, me.ws);
    return json(Object.assign({ ok: true, open: pbOn(env), test: pbTest(env) }, htPublic(st, await htJobs(db, me.ws))));
  },
  async "ht/join"(db, me, b, req, url, env) {   // 수집 서비스(팝빌) 가입 — 이미 가입돼 있으면 확인만
    if (me.role !== "admin") return fail("forbidden", 403);
    if (!pbOn(env)) return fail("ht-closed", 400);
    const x = await htBiz(db, me, b.biz_id); if (x.err) return x.err;
    try {
      const chk = await pb(env, x.corp, "", "GET", `/Join?CorpNum=${x.corp}&LID=${encodeURIComponent(env.POPBILL_LINK_ID.trim())}`);
      let account = null;
      if (Number(chk.code) !== 1) {
        const f = b.form && typeof b.form === "object" ? b.form : {}, v = (k, n) => clip(f[k], n);
        const form = { CEOName: v("ceo", 100), CorpName: v("name", 200) || clip(x.b.name, 200), Addr: v("addr", 300), BizType: v("bizType", 100), BizClass: v("bizClass", 100), ContactName: v("contactName", 100), ContactEmail: v("contactEmail", 100), ContactTEL: v("contactTel", 20) };
        if (!b.agree) return fail("need-agree", 400);
        if (Object.values(form).some(s => !s) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.ContactEmail)) return fail("bad-request", 400);
        const id = "mw" + x.corp + rand(2), pw = "Mw" + rand(5) + "!7";
        const j = await pb(env, x.corp, "", "POST", "/Join", Object.assign({ ID: id, Password: pw, LinkID: env.POPBILL_LINK_ID.trim(), CorpNum: x.corp }, form));
        if (Number(j.code) !== 1) throw pbFail(j, 400);
        account = { id, pw }; x.s.pbId = id;   // 비밀번호는 지금 한 번만 보여 주고 저장하지 않습니다
      }
      x.s.joined = true; x.s.err = "";
      await htSave(db, me.ws, x.st).run();
      return json({ ok: true, biz: x.st.biz, account, already: !account });
    } catch (e) { return pbOut(e) || (() => { throw e; })(); }
  },
  async "ht/dept"(db, me, b, req, url, env) {   // 홈택스 부서사용자(조회 전용) 등록 — 비밀번호는 팝빌에만 전달합니다
    if (me.role !== "admin") return fail("forbidden", 403);
    if (!pbOn(env)) return fail("ht-closed", 400);
    const x = await htBiz(db, me, b.biz_id); if (x.err) return x.err;
    if (!x.s.joined) return fail("not-joined", 400);
    const id = clip(b.id, 40), pwd = String(b.pwd || "").slice(0, 60);
    if (!id || !pwd) return fail("bad-request", 400);
    const out = {}, errs = [];
    for (const svc of ["ti", "cb"]) {
      const S = HT_SVC[svc];
      try { await pb(env, x.corp, S[1], "POST", `/HomeTax/${S[0]}/DeptUser`, { id, pwd }); const c = await pb(env, x.corp, S[1], "GET", `/HomeTax/${S[0]}/DeptUser/Check`); out[svc] = Number(c.code) === 1; if (!out[svc]) errs.push(`${S[2]}: ${clip(c.message, 120)}`); }
      catch (e) { if (!e.pb) throw e; out[svc] = false; errs.push(`${S[2]}: ${e.msg}`); }
    }
    x.s.dept = { ti: !!out.ti, cb: !!out.cb, id: out.ti || out.cb ? id : "", at: iso() }; x.s.err = errs.join(" / ");
    await htSave(db, me.ws, x.st).run();
    if (!out.ti && !out.cb) return fail("provider", 502, { detail: errs.join(" / "), biz: x.st.biz });
    return json({ ok: true, biz: x.st.biz, warn: errs.join(" / ") });
  },
  async "ht/disconnect"(db, me, b, req, url, env) {   // 부서사용자 등록을 지우고 자동 수집을 끕니다 (팝빌 가입은 남습니다)
    if (me.role !== "admin") return fail("forbidden", 403);
    const x = await htBiz(db, me, b.biz_id); if (x.err) return x.err;
    if (pbOn(env)) for (const svc of ["ti", "cb"]) { if (!x.s.dept[svc]) continue; try { await pb(env, x.corp, HT_SVC[svc][1], "DELETE", `/HomeTax/${HT_SVC[svc][0]}/DeptUser`); } catch (e) { if (!e.pb) throw e; } }
    x.s.dept = { ti: false, cb: false, id: "", at: iso() }; x.s.auto = false;
    await db.batch([htSave(db, me.ws, x.st), db.prepare("DELETE FROM ht_auto WHERE ws=?1 AND biz_id=?2").bind(me.ws, x.b.id)]);
    return json({ ok: true, biz: x.st.biz });
  },
  async "ht/auto"(db, me, b, req, url, env) {   // 날마다 자동으로 가져오기
    if (me.role !== "admin") return fail("forbidden", 403);
    const x = await htBiz(db, me, b.biz_id); if (x.err) return x.err;
    const on = !!b.on;
    if (on && (!pbOn(env) || !(x.s.dept.ti || x.s.dept.cb))) return fail("not-ready", 400);
    x.s.auto = on;
    await db.batch([htSave(db, me.ws, x.st), on ? db.prepare("INSERT INTO ht_auto(ws,biz_id,next_at) VALUES(?1,?2,?3) ON CONFLICT(ws,biz_id) DO NOTHING").bind(me.ws, x.b.id, iso()) : db.prepare("DELETE FROM ht_auto WHERE ws=?1 AND biz_id=?2").bind(me.ws, x.b.id)]);
    return json({ ok: true, biz: x.st.biz });
  },
  async "ht/collect"(db, me, b, req, url, env) {   // 지금 가져오기 — 기간은 한 번에 석 달까지
    if (!isMgr(me)) return fail("forbidden", 403);
    if (!pbOn(env)) return fail("ht-closed", 400);
    const x = await htBiz(db, me, b.biz_id); if (x.err) return x.err;
    if (!(x.s.dept.ti || x.s.dept.cb)) return fail("not-ready", 400);
    const today = kstToday();
    let to = dOk(b.to) || today; if (to > today) to = today;
    let from = dOk(b.from) || (x.s.last ? addDaysS(x.s.last, -7) : addDaysS(today, -90));   // 다시 가져올 때는 지난번보다 이레 앞에서부터 — 늦게 올라온 것을 놓치지 않게
    if (from > to) from = to;
    if (from < addDaysS(to, -HT_MAX_DAYS)) from = addDaysS(to, -HT_MAX_DAYS);
    const busy = await db.prepare("SELECT COUNT(*) AS n FROM ht_job WHERE ws=?1 AND biz_id=?2 AND state='req' AND at>?3").bind(me.ws, x.b.id, new Date(Date.now() - HT_JOB_TTL).toISOString()).first();
    if (busy && Number(busy.n)) return fail("busy", 409);
    try {
      const r = await htRequest(db, env, me, x, from, to, false);
      if (!r.jobs.length) return fail("provider", 502, { detail: r.errs.join(" / ") });
      return json(Object.assign({ ok: true, from, to, requested: r.jobs.length, warn: r.errs.join(" / ") }, htPublic(x.st, await htJobs(db, me.ws))));
    } catch (e) { return pbOut(e) || (() => { throw e; })(); }
  },
  async "ht/poll"(db, me, b, req, url, env) {
    if (!isMgr(me)) return fail("forbidden", 403);
    if (!pbOn(env)) return fail("ht-closed", 400);
    const x = await htBiz(db, me, b.biz_id); if (x.err) return x.err;
    const r = await htPoll(db, env, me, x);
    return json(Object.assign({ ok: true, pending: r.pending, added: r.added, skipped: r.skipped, v: r.v, warn: r.errs.join(" / ") }, htPublic(x.st, await htJobs(db, me.ws))));
  }
});

/* ── 자동 수집 — tick 한 번에 사업자 하나씩(요청당 쿼리 한도 안에서). 요청해 둔 것이 있으면 결과부터 확인합니다 ── */
async function htAutoRun(db, now) {
  const env = db.env; if (!pbOn(env)) return {};
  const todo = (await db.prepare("SELECT a.ws, a.biz_id, w.status AS wst, w.plan, w.modules, w.limits, w.plan_until FROM ht_auto a JOIN workspaces w ON w.id=a.ws WHERE a.next_at<=?1 ORDER BY a.next_at LIMIT 1").bind(new Date(now).toISOString()).all()).results || [];
  let htAdded = 0;
  for (const w of todo) {
    const me = { ws: w.ws, id: null, name: "자동", role: "admin" };
    let next = new Date(now + 6 * 60e3).toISOString();
    try {
      if (w.wst !== "active" || !tierOf(w).modules.includes("tax")) { next = new Date(now + 864e5).toISOString(); }
      else {
        const x = await htBiz(db, me, w.biz_id);
        if (x.err || !x.s.auto || !(x.s.dept.ti || x.s.dept.cb)) { await db.prepare("DELETE FROM ht_auto WHERE ws=?1 AND biz_id=?2").bind(w.ws, w.biz_id).run(); continue; }
        const r = await htPoll(db, env, me, x);
        if (r.finished && !r.pending) {
          htAdded += r.added;
          if (r.added) await notify(db, w.ws, await whoIs(db, w.ws, ["admin"]), { type: "money", title: `홈택스에서 새 증빙 ${r.added}건을 가져왔습니다`, body: clip(x.b.name, 40) + " · 세금계산서·현금영수증", url: "#/tax/docs", tag: "ht:" + w.biz_id });
          next = htNextDay(now);
        } else if (!r.pending && !r.finished) {
          const today = kstToday();
          if (x.s.last === today && x.s.lastAt && now - Date.parse(x.s.lastAt) < 20 * 3600e3) next = htNextDay(now);   // 오늘 이미 가져왔으면 내일
          else { const q = await htRequest(db, env, me, x, x.s.last ? addDaysS(x.s.last, -7) : addDaysS(today, -90), today, true); if (!q.jobs.length) next = htNextDay(now); }
        }
      }
    } catch (e) { next = new Date(now + 3600e3).toISOString(); }
    await db.prepare("UPDATE ht_auto SET next_at=?3 WHERE ws=?1 AND biz_id=?2").bind(w.ws, w.biz_id, next).run();
  }
  return todo.length ? { htAdded } : {};
}
const htNextDay = now => new Date(Date.parse(addDaysS(kstToday(), 1) + "T00:00:00Z") - 9 * 3600e3 + 6.5 * 3600e3 + Math.floor(Math.random() * 40) * 60e3).toISOString();   // 다음 날 아침 6시 반~7시 10분(한국 시간) 사이
TICK_JOBS.push(htAutoRun);

/* ═════════ 총괄관리 — 운영자 전용 ═════════
   플랫폼 설정(가입 방식·시작 등급·가격표), 결제 기록, 베타 코드, 문의, 공지, 운영 기록·오류, 오픈 준비, 전체 백업.
   · 워크스페이스의 업무 내용은 다루지 않습니다. 계정 목록과 기록 '개수'까지만 봅니다.
   · 모든 운영 작업은 adm_log에 남깁니다. */
const ADM_DDL = [
  "CREATE TABLE IF NOT EXISTS adm_pay(id TEXT PRIMARY KEY, ws TEXT, ws_name TEXT, paid_at TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, method TEXT, item TEXT, period_from TEXT, period_to TEXT, invoice INTEGER NOT NULL DEFAULT 0, memo TEXT, created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_pay_ws ON adm_pay(ws, paid_at)",
  "CREATE TABLE IF NOT EXISTS adm_code(code TEXT PRIMARY KEY, label TEXT, plan TEXT NOT NULL DEFAULT 'basic', modules TEXT NOT NULL DEFAULT '[]', days INTEGER NOT NULL DEFAULT 0, max_uses INTEGER NOT NULL DEFAULT 0, uses INTEGER NOT NULL DEFAULT 0, expires TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS fb(id TEXT PRIMARY KEY, ws TEXT NOT NULL, ws_name TEXT, member_id TEXT NOT NULL, login_id TEXT, name TEXT, role TEXT, kind TEXT, body TEXT NOT NULL, page TEXT, ua TEXT, contact TEXT, status TEXT NOT NULL DEFAULT 'new', reply TEXT, reply_at TEXT, seen_at TEXT, memo TEXT, created_at TEXT NOT NULL, updated_at TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_fb_member ON fb(ws, member_id)",
  "CREATE INDEX IF NOT EXISTS idx_fb_status ON fb(status, created_at)",
  "CREATE TABLE IF NOT EXISTS adm_log(id TEXT PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, ws TEXT, ws_name TEXT, detail TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_admlog_at ON adm_log(at)",
  "CREATE TABLE IF NOT EXISTS err_log(id TEXT PRIMARY KEY, at TEXT NOT NULL, path TEXT, msg TEXT, ws TEXT)",
  "CREATE INDEX IF NOT EXISTS idx_errlog_at ON err_log(at)"
];
const SIGNUP_POL = ["approve", "code", "open", "closed"];
const PRICE_KEYS = ["pro", "space", "outsourcing", "commerce", "seat"];
const FB_KINDS = ["error", "inconvenient", "idea", "billing", "etc"];
const FB_ST = ["new", "doing", "done"];
const ANN_LV = ["info", "important", "maint"];
const PAY_METHODS = ["계좌이체", "카드", "현금", "기타"];
const PLAT_DEF = () => ({ signup: "approve", newPlan: { plan: "basic", days: 0, modules: [] }, contact: "", prices: { pro: 12000, space: 19000, outsourcing: 0, commerce: 19000, seat: 4900 }, refDays: 0, feat: { push: false }, saved: false });
function platNorm(p) {
  const d = PLAT_DEF(); p = p && typeof p === "object" ? p : {};
  const np = p.newPlan && typeof p.newPlan === "object" ? p.newPlan : {};
  const pr = p.prices && typeof p.prices === "object" ? p.prices : {};
  const plan = planOk(np.plan);
  return {
    signup: SIGNUP_POL.includes(p.signup) ? p.signup : d.signup,
    newPlan: { plan, days: clampInt(np.days, 0, 3650, 0), modules: plan === "pro" ? modulesOk(np.modules) : [] },
    contact: clip(p.contact, 80),
    prices: Object.fromEntries(PRICE_KEYS.map(k => [k, clampInt(pr[k], 0, 10000000, d.prices[k])])),
    refDays: clampInt(p.refDays, 0, 365, 0),   // 소개로 열린 워크스페이스와 소개한 워크스페이스에 더해 주는 프로 일수 (0 = 보상 없음)
    feat: { push: !!(p.feat && typeof p.feat === "object" && p.feat.push) },   // 운영자가 여는 기능 — 휴대폰 푸시 알림(기기 등록). 꺼 두면 알림함만 씁니다
    saved: !!p.saved
  };
}
const platformOf = v => platNorm(parse(v));
async function platform(db) { const r = await db.prepare("SELECT v FROM mw_meta WHERE k='platform'").first(); return platformOf(r && r.v); }
function startTier(src) {   // 새 워크스페이스의 시작 등급 — 베타 코드 또는 플랫폼 설정
  src = src || {};
  const plan = planOk(src.plan), days = clampInt(src.days, 0, 3650, 0);
  return { plan, modules: plan === "pro" ? modulesOk(src.modules) : [], until: plan === "pro" && days > 0 ? addDaysS(kstToday(), days) : null };
}
const admLog = (db, action, w, detail) => db.prepare("INSERT INTO adm_log(id,at,action,ws,ws_name,detail,actor) VALUES(?1,?2,?3,?4,?5,?6,?7)").bind(uid("l"), iso(), action, w ? w.id : "", w ? w.name : "", clip(detail, 300), db.actor || null);   // actor: 총괄관리 요청이면 처리한 운영자
const annList = v => { const a = parse(v); return Array.isArray(a) ? a.filter(x => x && x.id) : []; };
function annNorm(a, prev) {
  return { id: (prev && prev.id) || uid("an"), title: clip(a.title, 80), body: clip(a.body, 600), level: ANN_LV.includes(a.level) ? a.level : "info", aud: a.aud === "admin" ? "admin" : "all", from: dOk(a.from) || kstToday(), to: dOk(a.to) || "", on: a.on !== false && a.on !== 0, created_at: (prev && prev.created_at) || iso(), updated_at: iso() };
}
function annFor(v, me) {   // 지금 보여 줄 공지 — 기간 안, 대상에 맞는 것 3개까지
  const t = kstToday();
  return annList(v).filter(a => a.on && a.from <= t && (!a.to || a.to >= t) && (a.aud === "all" || me.role === "admin" || me.owner)).slice(0, 3).map(a => ({ id: a.id, t: a.title, b: a.body, lv: a.level }));
}
const codeNorm = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
function betaCode() { const a = new Uint8Array(6); crypto.getRandomValues(a); return "MW" + [...a].map(x => INVITE_ABC[x % INVITE_ABC.length]).join(""); }
const codeUsable = c => !!(c && Number(c.active) && (!c.expires || c.expires >= kstToday()) && (!Number(c.max_uses) || Number(c.uses) < Number(c.max_uses)));
const codeOut = c => ({ code: c.code, label: c.label || "", plan: planOk(c.plan), modules: modulesOk(c.modules), days: Number(c.days) || 0, maxUses: Number(c.max_uses) || 0, uses: Number(c.uses) || 0, expires: c.expires || "", active: !!Number(c.active), usable: codeUsable(c), createdAt: c.created_at });
const payOut = p => ({ id: p.id, ws: p.ws || "", wsName: p.ws_name || "", paidAt: p.paid_at, amount: Number(p.amount) || 0, method: p.method || "", item: p.item || "", from: p.period_from || "", to: p.period_to || "", invoice: !!Number(p.invoice), memo: p.memo || "", createdAt: p.created_at });
const fbOut = f => ({ id: f.id, ws: f.ws, wsName: f.ws_name || "", loginId: f.login_id || "", name: f.name || "", role: f.role || "", kind: f.kind, body: f.body, page: f.page || "", ua: f.ua || "", contact: f.contact || "", status: f.status, reply: f.reply || "", replyAt: f.reply_at || "", memo: f.memo || "", createdAt: f.created_at, updatedAt: f.updated_at || "" });
// 전체 백업에 넣는 표 — 로그인 세션(sess)과 오류 기록은 빼고, AI 토큰은 해시를 지웁니다
const EXPORT_TABLES = () => ["mw_meta", "workspaces", "accounts", "ent", "ws_set", "api_tokens", "links", "invites", "mod_set", ...SP_TABLES, ...OS_TABLES, ...CM_TABLES, ...TX_TABLES, ...PP_TABLES, ...MK_TABLES, ...CR_TABLES, ...ED_TABLES, "nt_sub", "msg_log", "msg_auto", "ht_job", "ht_auto", "adm_pay", "adm_code", "fb", "adm_log"];
const EXPORT_PAGE = 800;
/* ───────── 본사 운영팀 — 역할별 권한 ─────────
   총괄(운영자 계정)이 운영자 워크스페이스의 구성원에게 역할을 줍니다. 모든 역할은 워크스페이스의 업무 내용은 보지 못합니다. */
const OP_ROLES = {
  owner: { name: "총괄", perms: ["see", "ws", "extend", "danger", "signup", "pay", "fb", "ann", "acct", "launch", "team"] },
  manager: { name: "운영 매니저", perms: ["see", "ws", "extend", "signup", "fb", "ann", "acct", "launch"] },
  support: { name: "고객지원", perms: ["see", "fb", "ann", "acct"] },
  finance: { name: "재무", perms: ["see", "pay", "extend"] },
  viewer: { name: "보기 전용", perms: ["see"] }
};
const OP_ASSIGN = ["manager", "support", "finance", "viewer"];
function opOf(r) { if (r && Number(r.is_owner)) return "owner"; const x = r && r.op_role; return OP_ASSIGN.includes(x) ? x : ""; }
const can = (me, p) => !!(me && me.op && OP_ROLES[me.op] && OP_ROLES[me.op].perms.includes(p));
const opNeed = (me, p) => can(me, p) ? null : fail("forbidden", 403, { need: p });
const ownerOnly = me => opNeed(me, "danger");
// 운영자 보안 키 — Cloudflare Pages 환경 변수 MW_ADMIN_KEY (8자 이상일 때만 켜집니다)
const adminKeyRaw = env => (env && typeof env.MW_ADMIN_KEY === "string") ? env.MW_ADMIN_KEY.trim() : "";
const adminKey = env => { const k = adminKeyRaw(env); return k.length >= 8 ? k : ""; };
async function keyMatch(env, input) { const k = adminKey(env); if (!k || typeof input !== "string" || !input) return false; return same(await sha256("mwk:" + k), await sha256("mwk:" + input.trim())); }

const ADMIN_API = {
  /* 현황 + 워크스페이스 목록 */
  async "admin/overview"(db, me, b, req, url) {
    const no = opNeed(me, "see"); if (no) return no;
    const now = Date.now(), ym = kstToday().slice(0, 7), prevYm = addDaysS(ym + "-01", -1).slice(0, 7);
    // 보관 기간이 지난 기록 정리 — 반려된 가입 신청(신청 후 30일), 처리 끝난 문의(3년)
    const cut30 = new Date(now - 30 * 864e5).toISOString(), cut3y = new Date(now - 3 * 365 * 864e5).toISOString();
    await db.batch([
      db.prepare("DELETE FROM accounts WHERE ws IN (SELECT id FROM workspaces WHERE status='rejected' AND created_at<?1)").bind(cut30),
      db.prepare("DELETE FROM workspaces WHERE status='rejected' AND created_at<?1").bind(cut30),
      db.prepare("DELETE FROM fb WHERE status='done' AND COALESCE(updated_at,created_at)<?1").bind(cut3y)
    ]);
    const [wsR, cntR, seenR, entR, resR, jobR, ordR, sumR, logR] = await db.batch([
      db.prepare("SELECT w.*, a.name AS admin_name, a.contact AS admin_contact FROM workspaces w LEFT JOIN accounts a ON a.login_id=w.admin_login ORDER BY w.created_at DESC"),
      db.prepare("SELECT ws, role, COUNT(*) AS n FROM accounts WHERE status IN ('active','disabled') GROUP BY ws, role"),
      db.prepare("SELECT ws, MAX(seen) AS s FROM sess GROUP BY ws"),
      db.prepare("SELECT ws, kind, COUNT(*) AS n FROM ent WHERE deleted=0 AND kind IN ('project','task','store','contact','fin') GROUP BY ws, kind"),
      db.prepare("SELECT ws, COUNT(*) AS n FROM sp_res GROUP BY ws"),
      db.prepare("SELECT ws, COUNT(*) AS n FROM os_job GROUP BY ws"),
      db.prepare("SELECT ws, COUNT(*) AS n FROM cm_order GROUP BY ws"),
      db.prepare("SELECT (SELECT COUNT(*) FROM fb WHERE status='new') AS fb_new, (SELECT COUNT(*) FROM fb WHERE status='doing') AS fb_doing, (SELECT COUNT(*) FROM err_log WHERE at>=?1) AS err24, (SELECT COALESCE(SUM(amount),0) FROM adm_pay WHERE substr(paid_at,1,7)=?2) AS pay_m, (SELECT COALESCE(SUM(amount),0) FROM adm_pay WHERE substr(paid_at,1,7)=?3) AS pay_p, (SELECT COALESCE(SUM(amount),0) FROM adm_pay WHERE substr(paid_at,1,4)=?4) AS pay_y, (SELECT COUNT(*) FROM accounts WHERE status='active') AS acc, (SELECT v FROM mw_meta WHERE k='platform') AS plat, (SELECT v FROM mw_meta WHERE k='launch') AS launch, (SELECT v FROM mw_meta WHERE k='last_export') AS last_export, (SELECT v FROM mw_meta WHERE k='ann') AS ann, (SELECT COUNT(*) FROM adm_code WHERE active=1) AS codes").bind(new Date(now - 864e5).toISOString(), ym, prevYm, ym.slice(0, 4)),
      db.prepare("SELECT * FROM adm_log WHERE action<>'key-ok' ORDER BY at DESC LIMIT 8")
    ]);
    const rows = r => (r && r.results) || [];
    const roles = new Map(); for (const c of rows(cntR)) { const m = roles.get(c.ws) || {}; m[c.role] = Number(c.n); roles.set(c.ws, m); }
    const seen = new Map(rows(seenR).map(r => [r.ws, Number(r.s) || 0]));
    const usage = new Map(); const U = (ws) => { let u = usage.get(ws); if (!u) { u = { project: 0, task: 0, store: 0, contact: 0, fin: 0, res: 0, job: 0, order: 0 }; usage.set(ws, u); } return u; };
    for (const r of rows(entR)) U(r.ws)[r.kind] = Number(r.n);
    for (const r of rows(resR)) U(r.ws).res = Number(r.n);
    for (const r of rows(jobR)) U(r.ws).job = Number(r.n);
    for (const r of rows(ordR)) U(r.ws).order = Number(r.n);
    const s = rows(sumR)[0] || {};
    const refCnt = new Map(); for (const w of rows(wsR)) if (w.ref_ws) refCnt.set(w.ref_ws, (refCnt.get(w.ref_ws) || 0) + 1);
    const workspaces = rows(wsR).map(w => {
      const t = tierOf(w, true), rl = roles.get(w.id) || {};
      const sMs = seen.get(w.id) || 0, la = w.last_active ? Date.parse(w.last_active) || 0 : 0;
      return { id: w.id, name: w.name, status: w.status, adminLogin: w.admin_login || "", adminName: w.admin_name || "", contact: w.contact || w.admin_contact || "", note: w.note || "", createdAt: w.created_at, approvedAt: w.approved_at || "", lastActive: w.last_active || "", lastSeen: Math.max(sMs, la) ? new Date(Math.max(sMs, la)).toISOString() : "", members: Object.values(rl).reduce((a, n) => a + n, 0), roles: rl, mine: w.id === me.ws, plan: t.planRaw, planNow: t.plan, modules: modulesOk(w.modules).filter(m => EXT_MODULES.includes(m)), planUntil: w.plan_until || "", limits: parse(w.limits) || {}, opNote: w.op_note || "", comp: !!Number(w.comp), usage: usage.get(w.id) || U(w.id), refBy: w.ref_ws || "", refs: refCnt.get(w.id) || 0, refPaid: !!Number(w.ref_paid) };
    });
    return json({ ok: true, workspaces, host: url.hostname, summary: { fbNew: Number(s.fb_new) || 0, fbDoing: Number(s.fb_doing) || 0, err24: Number(s.err24) || 0, payMonth: can(me, "pay") ? Number(s.pay_m) || 0 : null, payPrev: can(me, "pay") ? Number(s.pay_p) || 0 : null, payYear: can(me, "pay") ? Number(s.pay_y) || 0 : null, accounts: Number(s.acc) || 0, freeBeta: FREE_BETA, codes: Number(s.codes) || 0, ann: annList(s.ann).filter(a => a.on).length, lastExport: s.last_export || "" }, platform: platformOf(s.plat), launch: parse(s.launch) || {}, log: rows(logR) });
  },

  /* 워크스페이스 상세 — 계정·사용량·토큰·확인 링크·결제 (업무 내용은 없음) */
  async "admin/ws-detail"(db, me, b) {
    const no = opNeed(me, "see"); if (no) return no;
    const id = String(b.id || "");
    const w = await db.prepare("SELECT id FROM workspaces WHERE id=?1").bind(id).first();
    if (!w) return fail("not-found", 404);
    const [acc, tok, lnk, pay, act] = await db.batch([
      db.prepare("SELECT login_id, name, role, status, is_owner, created_at, last_login, CASE WHEN role='admin' THEN contact ELSE '' END AS contact FROM accounts WHERE ws=?1 ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, created_at"),
      db.prepare("SELECT name, scope, created_at, last_used, revoked FROM api_tokens WHERE ws=?1 ORDER BY created_at DESC"),
      db.prepare("SELECT kind, COUNT(*) AS n, SUM(CASE WHEN used_at IS NOT NULL THEN 1 ELSE 0 END) AS used FROM links WHERE ws=?1 GROUP BY kind UNION ALL SELECT 'invite' AS kind, COUNT(*) AS n, SUM(CASE WHEN used_at IS NOT NULL THEN 1 ELSE 0 END) AS used FROM invites WHERE ws=?1"),
      db.prepare("SELECT * FROM adm_pay WHERE ws=?1 ORDER BY paid_at DESC, created_at DESC LIMIT 50"),
      db.prepare("SELECT COUNT(DISTINCT member_id) AS n FROM sess WHERE ws=?1 AND seen>=?2").bind(id, Date.now() - 7 * 864e5)
    ].map((s, i) => i < 4 ? s.bind(id) : s));
    const rows = r => (r && r.results) || [];
    return json({ ok: true, accounts: rows(acc).map(a => ({ loginId: a.login_id, name: a.name || "", role: roleOk(a.role), status: a.status, owner: !!Number(a.is_owner), createdAt: a.created_at, lastLogin: a.last_login || "", contact: a.contact || "" })), tokens: rows(tok).map(t => ({ name: t.name || "", scope: t.scope, createdAt: t.created_at, lastUsed: t.last_used || "", revoked: !!Number(t.revoked) })), links: rows(lnk).map(l => ({ kind: l.kind, n: Number(l.n), used: Number(l.used) || 0 })), payments: can(me, "pay") ? rows(pay).map(payOut) : [], active7: Number((rows(act)[0] || {}).n) || 0 });
  },

  /* 결제 기록 — 결제 연동 전까지 운영자가 직접 적습니다 */
  async "admin/pay"(db, me, b) {
    const no = opNeed(me, "pay"); if (no) return no;
    const op = String(b.op || "list");
    if (op === "list") {
      const ym = /^\d{4}-\d{2}$/.test(String(b.ym || "")) ? String(b.ym) : "";
      const ws = String(b.ws || "");
      let sql = "SELECT * FROM adm_pay", w = [], bind = [];
      if (ym) { w.push("substr(paid_at,1,7)=?" + (bind.length + 1)); bind.push(ym); }
      if (ws) { w.push("ws=?" + (bind.length + 1)); bind.push(ws); }
      if (w.length) sql += " WHERE " + w.join(" AND ");
      sql += " ORDER BY paid_at DESC, created_at DESC LIMIT 500";
      const r = await db.prepare(sql).bind(...bind).all();
      return json({ ok: true, payments: ((r && r.results) || []).map(payOut) });
    }
    if (op === "delete") {
      const p = await db.prepare("SELECT * FROM adm_pay WHERE id=?1").bind(String(b.id || "")).first();
      if (!p) return fail("not-found", 404);
      await db.batch([db.prepare("DELETE FROM adm_pay WHERE id=?1").bind(p.id), admLog(db, "pay-delete", { id: p.ws, name: p.ws_name }, `${p.paid_at} ${Number(p.amount).toLocaleString("ko-KR")}원 기록 삭제`)]);
      return json({ ok: true });
    }
    if (op !== "save") return fail("bad-request");
    const w = await db.prepare("SELECT id, name, plan, plan_until FROM workspaces WHERE id=?1").bind(String(b.ws || "")).first();
    if (!w) return fail("not-found", 404);
    const paidAt = dOk(b.paidAt), amount = clampInt(b.amount, 0, 1000000000, null);
    if (!paidAt || amount === null) return fail("bad-request");
    const from = dOk(b.from) || "", to = dOk(b.to) || "";
    if (from && to && to < from) return fail("bad-period");
    const prev = b.id ? await db.prepare("SELECT id, created_at FROM adm_pay WHERE id=?1").bind(String(b.id)).first() : null;
    const id = prev ? prev.id : uid("pay");
    const stmts = [db.prepare("INSERT OR REPLACE INTO adm_pay(id,ws,ws_name,paid_at,amount,method,item,period_from,period_to,invoice,memo,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)").bind(id, w.id, w.name, paidAt, amount, PAY_METHODS.includes(b.method) ? b.method : "기타", clip(b.item, 60), from || null, to || null, b.invoice ? 1 : 0, clip(b.memo, 300), prev ? prev.created_at : iso())];
    let planUntil = w.plan_until || "";
    if (b.apply && to) {   // 프로 기한을 결제 기간 끝으로 맞춥니다 (더 늦은 날짜가 있으면 그대로)
      const unlimited = w.plan === "pro" && !w.plan_until;
      if (!unlimited) { planUntil = w.plan === "pro" && w.plan_until && w.plan_until > to ? w.plan_until : to; stmts.push(db.prepare("UPDATE workspaces SET plan='pro', plan_until=?1 WHERE id=?2").bind(planUntil, w.id)); }
    }
    stmts.push(admLog(db, prev ? "pay-edit" : "pay-add", w, `${paidAt} ${amount.toLocaleString("ko-KR")}원${clip(b.item, 60) ? " · " + clip(b.item, 60) : ""}${b.apply && to ? ` · 프로 기한 ${planUntil}` : ""}`));
    await db.batch(stmts);
    const row = await db.prepare("SELECT * FROM adm_pay WHERE id=?1").bind(id).first();
    return json({ ok: true, payment: payOut(row), planUntil });
  },

  /* 베타 코드 — 코드가 있으면 승인 없이 바로 개설되고, 코드에 정한 등급으로 시작합니다 */
  async "admin/codes"(db, me, b) {
    const no = opNeed(me, "signup"); if (no) return no;
    const op = String(b.op || "list");
    if (op === "save") {
      let code = codeNorm(b.code);
      if (code && code.length < 4) return fail("bad-code");
      const isNew = !b.edit;
      if (!code) code = betaCode();
      const t = startTier({ plan: b.plan, modules: b.modules, days: 0 });
      const vals = [code, clip(b.label, 60), t.plan, JSON.stringify(t.modules), clampInt(b.days, 0, 3650, 0), clampInt(b.maxUses, 0, 100000, 0), dOk(b.expires) || null];
      try {
        if (isNew) await db.batch([db.prepare("INSERT INTO adm_code(code,label,plan,modules,days,max_uses,expires,uses,active,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,0,1,?8)").bind(...vals, iso()), admLog(db, "code-add", null, `베타 코드 ${code}${vals[1] ? " · " + vals[1] : ""}`)]);
        else { const r = await db.prepare("UPDATE adm_code SET label=?2, plan=?3, modules=?4, days=?5, max_uses=?6, expires=?7 WHERE code=?1").bind(...vals).run(); if (!r.meta || !r.meta.changes) return fail("not-found", 404); }
      } catch (e) { if (isUnique(e)) return fail("taken", 409); throw e; }
      const row = await db.prepare("SELECT * FROM adm_code WHERE code=?1").bind(code).first();
      return json({ ok: true, code: codeOut(row) });
    }
    if (op === "toggle" || op === "delete") {
      const c = await db.prepare("SELECT * FROM adm_code WHERE code=?1").bind(codeNorm(b.code)).first();
      if (!c) return fail("not-found", 404);
      if (op === "toggle") await db.batch([db.prepare("UPDATE adm_code SET active=?1 WHERE code=?2").bind(b.active ? 1 : 0, c.code), admLog(db, "code-toggle", null, `베타 코드 ${c.code} ${b.active ? "사용" : "중지"}`)]);
      else await db.batch([db.prepare("DELETE FROM adm_code WHERE code=?1").bind(c.code), admLog(db, "code-delete", null, `베타 코드 ${c.code} 삭제`)]);
      return json({ ok: true });
    }
    const r = await db.prepare("SELECT * FROM adm_code ORDER BY created_at DESC LIMIT 200").all();
    return json({ ok: true, codes: ((r && r.results) || []).map(codeOut) });
  },

  /* 문의·의견 — 목록, 답변(사용자에게 보임), 내부 메모, 상태 */
  async "admin/fb"(db, me, b) {
    const no = opNeed(me, "fb"); if (no) return no;
    if (b.op === "save") {
      const f = await db.prepare("SELECT * FROM fb WHERE id=?1").bind(String(b.id || "")).first();
      if (!f) return fail("not-found", 404);
      const reply = b.reply !== undefined ? clip(b.reply, 2000) : (f.reply || "");
      const replyAt = reply && reply !== (f.reply || "") ? iso() : (reply ? f.reply_at : null);
      const status = FB_ST.includes(b.status) ? b.status : f.status;
      await db.batch([
        db.prepare("UPDATE fb SET status=?1, reply=?2, reply_at=?3, memo=?4, updated_at=?5 WHERE id=?6").bind(status, reply || null, replyAt, b.memo !== undefined ? clip(b.memo, 1000) : (f.memo || ""), iso(), f.id),
        admLog(db, "fb", { id: f.ws, name: f.ws_name }, `문의 ${{ new: "새 문의", doing: "처리 중", done: "완료" }[status]}${reply !== (f.reply || "") ? " · 답변 등록" : ""}`)
      ]);
      const row = await db.prepare("SELECT * FROM fb WHERE id=?1").bind(f.id).first();
      if (reply && reply !== (f.reply || "")) await notify(db, f.ws, [f.member_id], { type: "sys", title: "문의에 답변이 달렸습니다", body: clip(reply, 120), url: "#/dashboard", tag: "fb-reply" });
      return json({ ok: true, item: fbOut(row) });
    }
    const st = FB_ST.includes(b.status) ? b.status : "";
    const r = await (st ? db.prepare("SELECT * FROM fb WHERE status=?1 ORDER BY created_at DESC LIMIT 300").bind(st) : db.prepare("SELECT * FROM fb ORDER BY created_at DESC LIMIT 300")).all();
    return json({ ok: true, items: ((r && r.results) || []).map(fbOut) });
  },

  /* 앱 안 공지 — 기간·대상을 정해 모든 워크스페이스 화면 위에 띄웁니다 */
  async "admin/ann"(db, me, b) {
    const no = opNeed(me, "ann"); if (no) return no;
    const r = await db.prepare("SELECT v FROM mw_meta WHERE k='ann'").first();
    let list = annList(r && r.v);
    const op = String(b.op || "list");
    if (op === "save" || op === "delete") {
      const prev = b.id ? list.find(a => a.id === b.id) : null;
      if (b.id && !prev) return fail("not-found", 404);
      let detail;
      if (op === "delete") { list = list.filter(a => a.id !== prev.id); detail = `공지 삭제 · ${prev.title}`; }
      else {
        const a = annNorm(b, prev);
        if (!a.title) return fail("bad-request");
        if (a.to && a.to < a.from) return fail("bad-period");
        list = prev ? list.map(x => x.id === prev.id ? a : x) : [a, ...list].slice(0, 30);
        detail = `공지 ${prev ? "수정" : "등록"} · ${a.title}`;
      }
      await db.batch([db.prepare("INSERT OR REPLACE INTO mw_meta(k,v) VALUES('ann',?1)").bind(JSON.stringify(list)), admLog(db, "ann", null, detail)]);
    }
    return json({ ok: true, items: list });
  },

  /* 플랫폼 설정 — 가입 방식, 새 워크스페이스 시작 등급, 문의 연락처, 매출 계산용 가격표 */
  async "admin/settings"(db, me, b) {
    const no = opNeed(me, "see"); if (no) return no;
    if (b.op === "save") {
      const keys = Object.keys(b.settings && typeof b.settings === "object" ? b.settings : {});
      const no2 = keys.length && keys.every(k => k === "prices") && can(me, "pay") ? null : opNeed(me, "signup"); if (no2) return no2;   // 가격표만 바꿀 때는 재무 권한으로도 됩니다
      const cur = await platform(db);
      const next = platNorm(Object.assign({}, cur, b.settings && typeof b.settings === "object" ? b.settings : {}, { saved: true }));
      const changes = [];
      if (next.signup !== cur.signup) changes.push("가입 방식 " + ({ approve: "승인제", code: "베타 코드 전용", open: "자동 개설", closed: "신청 마감" })[next.signup]);
      if (JSON.stringify(next.newPlan) !== JSON.stringify(cur.newPlan)) changes.push("시작 등급 " + (next.newPlan.plan === "pro" ? "프로 체험" + (next.newPlan.days ? ` ${next.newPlan.days}일` : "") : "베이직"));
      if (JSON.stringify(next.prices) !== JSON.stringify(cur.prices)) changes.push("가격표");
      if (next.contact !== cur.contact) changes.push("문의 연락처");
      if (next.refDays !== cur.refDays) changes.push("소개 보상 " + (next.refDays ? `프로 ${next.refDays}일` : "없음"));
      if (next.feat.push !== cur.feat.push) changes.push("휴대폰 푸시 알림 " + (next.feat.push ? "열기" : "닫기"));
      await db.batch([db.prepare("INSERT OR REPLACE INTO mw_meta(k,v) VALUES('platform',?1)").bind(JSON.stringify(next)), admLog(db, "settings", null, changes.join(" · ") || "변경 없음")]);
      return json({ ok: true, platform: next });
    }
    return json({ ok: true, platform: await platform(db) });
  },

  /* 운영 기록·서버 오류 */
  async "admin/logs"(db, me, b) {
    const no = opNeed(me, b.op === "clear-err" ? "launch" : "see"); if (no) return no;
    if (b.op === "clear-err") { await db.batch([db.prepare("DELETE FROM err_log"), admLog(db, "err-clear", null, "서버 오류 기록 비움")]); }
    const [a, e] = await db.batch([
      db.prepare("SELECT * FROM adm_log ORDER BY at DESC LIMIT 200"),
      db.prepare("SELECT * FROM err_log ORDER BY at DESC LIMIT 200"),
      db.prepare("DELETE FROM adm_log WHERE id NOT IN (SELECT id FROM adm_log ORDER BY at DESC LIMIT 3000)"),
      db.prepare("DELETE FROM err_log WHERE id NOT IN (SELECT id FROM err_log ORDER BY at DESC LIMIT 1000)")
    ]);
    return json({ ok: true, admin: (a && a.results) || [], errors: (e && e.results) || [] });
  },

  /* 오픈 준비 체크리스트 — 운영자가 체크한 상태 + 서버가 확인할 수 있는 항목 */
  async "admin/launch"(db, me, b, req, url, env) {
    const no = opNeed(me, b.op === "save" ? "launch" : "see"); if (no) return no;
    const r = await db.prepare("SELECT (SELECT v FROM mw_meta WHERE k='launch') AS launch, (SELECT v FROM mw_meta WHERE k='platform') AS plat, (SELECT v FROM mw_meta WHERE k='last_export') AS last_export, (SELECT v FROM mw_meta WHERE k='ann') AS ann, (SELECT COUNT(*) FROM adm_code) AS codes, (SELECT COUNT(*) FROM fb) AS fbs").first();
    let state = parse(r && r.launch) || {};
    if (b.op === "save") {
      const key = String(b.key || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 40);
      if (!key) return fail("bad-request");
      state[key] = { done: !!b.done, note: clip(b.note, 500), at: iso() };
      await db.prepare("INSERT OR REPLACE INTO mw_meta(k,v) VALUES('launch',?1)").bind(JSON.stringify(state)).run();
    }
    const host = url.hostname, le = (r && r.last_export) || "";
    const auto = {
      domain: !/\.pages\.dev$|^localhost$|^127\.|^\[?::1/.test(host),
      backup: !!le && Date.now() - (Date.parse(le) || 0) < 30 * 864e5,
      signup: platformOf(r && r.plat).saved,
      codes: Number(r && r.codes) > 0,
      ann: annList(r && r.ann).length > 0,
      adminkey: !!adminKey(env)
    };
    return json({ ok: true, state, auto, host, lastExport: le });
  },

  /* 전체 백업 — 표를 나눠 내려받아 브라우저에서 한 파일로 묶습니다 */
  async "admin/export"(db, me, b) {
    const no = opNeed(me, "danger"); if (no) return no;
    if (b.op === "done") {
      const at = iso();
      await db.batch([db.prepare("INSERT OR REPLACE INTO mw_meta(k,v) VALUES('last_export',?1)").bind(at), admLog(db, "export", null, `전체 백업 내려받기 · ${clampInt(b.rows, 0, 1e9, 0)}행`)]);
      return json({ ok: true, at });
    }
    const tables = EXPORT_TABLES();
    if (b.op === "tables") return json({ ok: true, tables });
    const t = String(b.table || "");
    if (!tables.includes(t)) return fail("bad-request");
    const off = clampInt(b.offset, 0, 1e9, 0);
    let rows = [];
    try { rows = ((await db.prepare(`SELECT * FROM ${t} ORDER BY rowid LIMIT ${EXPORT_PAGE} OFFSET ?1`).bind(off).all()).results) || []; }
    catch (e) { if (/no such table/i.test(String((e && e.message) || e))) return json({ ok: true, rows: [], done: true }); throw e; }
    if (t === "api_tokens") rows = rows.map(x => Object.assign({}, x, { hash: undefined }));
    return json({ ok: true, rows, done: rows.length < EXPORT_PAGE });
  },

  /* ── 모든 구성원: 운영자에게 문의 보내기 / 내 문의와 답변 보기 ── */
  async "fb/send"(db, me, b) {
    const body = clip(b.body, 2000);
    if (body.length < 2) return fail("bad-request");
    const c = await db.prepare("SELECT COUNT(*) AS n FROM fb WHERE ws=?1 AND member_id=?2 AND created_at>=?3").bind(me.ws, me.id, new Date(Date.now() - 864e5).toISOString()).first();
    if (c && Number(c.n) >= 20) return fail("busy", 429);
    const id = uid("fb"), now = iso();
    await db.prepare("INSERT INTO fb(id,ws,ws_name,member_id,login_id,name,role,kind,body,page,ua,contact,status,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'new',?13,?13)").bind(id, me.ws, me.wname || "", me.id, me.lid || "", me.name || "", me.role, FB_KINDS.includes(b.kind) ? b.kind : "etc", body, clip(b.page, 120), clip(b.ua, 200), clip(b.contact, 80), now).run();
    await notifyOps(db, "fb", { type: "sys", title: "새 문의가 들어왔습니다", body: `${me.wname || ""} · ${clip(body, 80)}`, url: "#/admin/fb", tag: "fb-new", once: 5 });
    return json({ ok: true, id });
  },
  async "fb/mine"(db, me) {
    const [r] = await db.batch([
      db.prepare("SELECT id, kind, body, status, reply, reply_at, created_at FROM fb WHERE ws=?1 AND member_id=?2 ORDER BY created_at DESC LIMIT 30").bind(me.ws, me.id),
      db.prepare("UPDATE fb SET seen_at=?3 WHERE ws=?1 AND member_id=?2 AND reply_at IS NOT NULL AND (seen_at IS NULL OR seen_at<reply_at)").bind(me.ws, me.id, iso())
    ]);
    return json({ ok: true, items: ((r && r.results) || []).map(f => ({ id: f.id, kind: f.kind, body: f.body, status: f.status, reply: f.reply || "", replyAt: f.reply_at || "", createdAt: f.created_at })) });
  }
};

Object.assign(PRIVATE, ADMIN_API);


/* ───────── 본사 운영 — 보안 키 확인 · 운영팀 · 계정 지원 · 성장 지표 · 시스템 ───────── */
const tmpPw = () => { const A = "abcdefghjkmnpqrstuvwxyz23456789"; const a = new Uint8Array(10); crypto.getRandomValues(a); return [...a].map(x => A[x % A.length]).join(""); };
Object.assign(PRIVATE, {
  async "admin/gate"(db, me, b, req, url, env) {   // 이 로그인에서 총괄관리를 열 수 있는지
    const raw = adminKeyRaw(env);
    return json({ ok: true, op: me.op, role: OP_ROLES[me.op].name, perms: OP_ROLES[me.op].perms, keySet: !!adminKey(env), keyShort: !!raw && raw.length < 8, admOk: me.admOk || !adminKey(env) });
  },
  async "admin/unlock"(db, me, b, req, url, env) {
    if (!adminKey(env)) return json({ ok: true, admOk: true });
    if (await keyMatch(env, b.key)) {
      await db.batch([db.prepare("UPDATE sess SET adm_ok=1, adm_fail=0 WHERE token=?1").bind(me.token), admLog(db, "key-ok", null, "보안 키 확인")]);
      return json({ ok: true, admOk: true });
    }
    const n = me.admFail + 1;
    if (n >= 5) {   // 다섯 번 틀리면 이 로그인을 끝냅니다
      await db.batch([db.prepare("DELETE FROM sess WHERE token=?1").bind(me.token), ntDrop(db, me.ws, me.id), admLog(db, "key-fail", null, "보안 키 5회 틀림 — 로그아웃")]);
      return fail("locked", 429);
    }
    await db.prepare("UPDATE sess SET adm_fail=?2 WHERE token=?1").bind(me.token, n).run();
    return fail("bad-key", 403, { left: 5 - n });
  },
  /* 운영팀 — 운영자 워크스페이스 구성원에게 총괄관리 역할을 줍니다 */
  async "admin/team"(db, me, b) {
    const no = opNeed(me, "see"); if (no) return no;
    if (b.op === "set") {
      const no2 = opNeed(me, "team"); if (no2) return no2;
      const lid = normId(b.loginId), role = OP_ASSIGN.includes(b.role) ? b.role : "";
      const a = await db.prepare("SELECT login_id, member_id, name, is_owner, op_role, status FROM accounts WHERE login_id=?1 AND ws=?2").bind(lid, me.ws).first();
      if (!a) return fail("not-found", 404);
      if (Number(a.is_owner)) return fail("self");
      if (role && a.status !== "active") return fail("inactive");
      await db.batch([
        db.prepare("UPDATE accounts SET op_role=?1 WHERE login_id=?2").bind(role || null, lid),
        db.prepare("UPDATE sess SET adm_ok=0 WHERE ws=?1 AND member_id=?2").bind(me.ws, a.member_id),   // 역할이 바뀌면 보안 키를 다시 확인합니다
        admLog(db, "team", null, `${a.name || lid}(${lid}) — ${role ? OP_ROLES[role].name : "운영팀에서 뺌"}`)
      ]);
    }
    const rs = (await db.prepare("SELECT login_id, name, role, status, is_owner, op_role, last_login FROM accounts WHERE ws=?1 AND status IN ('active','disabled') ORDER BY is_owner DESC, CASE WHEN op_role IS NULL THEN 1 ELSE 0 END, name").bind(me.ws).all()).results || [];
    return json({ ok: true, roles: Object.fromEntries(Object.entries(OP_ROLES).map(([k, v]) => [k, { name: v.name, perms: v.perms }])), members: rs.map(a => ({ loginId: a.login_id, name: a.name || "", role: roleOk(a.role), status: a.status, op: opOf(a), lastLogin: a.last_login || "" })) });
  },
  /* 계정 지원 — 모든 워크스페이스의 계정 찾기 · 잠금 풀기 · 로그아웃 · 임시 비밀번호 */
  async "admin/accounts"(db, me, b) {
    const no = opNeed(me, "acct"); if (no) return no;
    const op = String(b.op || "search");
    if (op === "search") {
      const q = clip(b.q, 60).toLowerCase(), f = String(b.f || "all"), now = Date.now();
      const where = ["1=1"], args = [];
      if (q) { args.push(likeArg(q.replace(/[%_]/g, ""))); where.push(`(lower(a.login_id) LIKE ?${args.length} OR lower(a.name) LIKE ?${args.length} OR lower(a.contact) LIKE ?${args.length} OR lower(w.name) LIKE ?${args.length})`); }
      if (f === "locked") { args.push(now); where.push(`(a.lock_until>?${args.length} OR a.fails>=5)`); }
      else if (f === "pending") where.push("a.status='pending'");
      else if (f === "disabled") where.push("a.status IN ('disabled','rejected')");
      else if (f === "ops") where.push("(a.is_owner=1 OR a.op_role IS NOT NULL)");
      if (!q && f === "all") where.push("a.last_login IS NOT NULL");
      const rs = (await db.prepare(`SELECT a.login_id, a.ws, a.name, a.role, a.status, a.is_owner, a.op_role, a.created_at, a.last_login, a.fails, a.lock_until, a.agreed_at, CASE WHEN a.role='admin' THEN a.contact ELSE '' END AS contact, w.name AS wname, w.status AS wst, (SELECT COUNT(*) FROM sess s WHERE s.ws=a.ws AND s.member_id=a.member_id) AS sessions FROM accounts a LEFT JOIN workspaces w ON w.id=a.ws WHERE ${where.join(" AND ")} ORDER BY COALESCE(a.last_login, a.created_at) DESC LIMIT 100`).bind(...args).all()).results || [];
      return json({ ok: true, items: rs.map(a => ({ loginId: a.login_id, ws: a.ws, wsName: a.wname || "", wsStatus: a.wst || "", name: a.name || "", role: roleOk(a.role), status: a.status, op: opOf(a), owner: !!Number(a.is_owner), contact: a.contact || "", createdAt: a.created_at, lastLogin: a.last_login || "", fails: Number(a.fails) || 0, locked: Number(a.lock_until) > now, sessions: Number(a.sessions) || 0, agreedAt: a.agreed_at || "" })) });
    }
    const lid = normId(b.loginId);
    const a = await db.prepare("SELECT a.*, w.name AS wname FROM accounts a LEFT JOIN workspaces w ON w.id=a.ws WHERE a.login_id=?1").bind(lid).first();
    if (!a) return fail("not-found", 404);
    if (lid === me.lid) return fail("self");
    if ((Number(a.is_owner) || opOf(a)) && me.op !== "owner") return fail("forbidden", 403);   // 운영팀 계정은 총괄만 다룹니다
    const w = { id: a.ws, name: a.wname || "" };
    if (op === "unlock") {
      await db.batch([db.prepare("UPDATE accounts SET fails=0, lock_until=0 WHERE login_id=?1").bind(lid), admLog(db, "acct-unlock", w, `${lid} 로그인 잠금 풀기`)]);
      return json({ ok: true });
    }
    if (op === "logout") {
      await db.batch([db.prepare("DELETE FROM sess WHERE ws=?1 AND member_id=?2").bind(a.ws, a.member_id), ntDrop(db, a.ws, a.member_id), admLog(db, "acct-logout", w, `${lid} 모든 기기 로그아웃`)]);
      return json({ ok: true });
    }
    if (op === "resetpw") {
      const pw = tmpPw();
      await db.batch([
        db.prepare("UPDATE accounts SET pw=?1, fails=0, lock_until=0 WHERE login_id=?2").bind(await makePw(pw), lid),
        db.prepare("DELETE FROM sess WHERE ws=?1 AND member_id=?2").bind(a.ws, a.member_id), ntDrop(db, a.ws, a.member_id),
        admLog(db, "acct-resetpw", w, `${lid} 임시 비밀번호 발급`)
      ]);
      return json({ ok: true, pw });
    }
    return fail("bad-request");
  },
  /* 성장·확산 지표 — 개수만 셉니다 (업무 내용 없음) */
  async "admin/growth"(db, me) {
    const no = opNeed(me, "see"); if (no) return no;
    const d30 = new Date(Date.now() - 30 * 864e5).toISOString(), d84 = new Date(Date.now() - 84 * 864e5).toISOString();
    const [inv, lnk, refTop, wk, invWk, ent] = await db.batch([
      db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN created_at>=?1 THEN 1 ELSE 0 END) AS n30, SUM(CASE WHEN created_at>=?1 AND opened_at IS NOT NULL THEN 1 ELSE 0 END) AS o30, SUM(CASE WHEN created_at>=?1 AND used_at IS NOT NULL THEN 1 ELSE 0 END) AS j30, SUM(CASE WHEN used_at IS NOT NULL THEN 1 ELSE 0 END) AS j, COUNT(DISTINCT ws) AS wsn FROM invites").bind(d30),
      db.prepare("SELECT kind, COUNT(*) AS n, SUM(CASE WHEN used_at IS NOT NULL THEN 1 ELSE 0 END) AS used, SUM(views) AS views, COUNT(DISTINCT ws) AS wsn FROM links GROUP BY kind"),
      db.prepare("SELECT r.id, r.name, COUNT(*) AS n, SUM(CASE WHEN w.status='active' THEN 1 ELSE 0 END) AS a FROM workspaces w JOIN workspaces r ON r.id=w.ref_ws GROUP BY r.id, r.name ORDER BY n DESC LIMIT 10"),
      db.prepare("SELECT substr(created_at,1,10) AS d, CASE WHEN ref_ws IS NULL THEN 0 ELSE 1 END AS ref, COUNT(*) AS n FROM workspaces WHERE created_at>=?1 AND status<>'rejected' GROUP BY d, ref").bind(d84),
      db.prepare("SELECT substr(used_at,1,10) AS d, COUNT(*) AS n FROM invites WHERE used_at>=?1 GROUP BY d").bind(d84),
      db.prepare("SELECT kind, COUNT(*) AS n, COUNT(DISTINCT ws) AS wsn FROM ent WHERE deleted=0 AND kind IN ('contact','project','task') GROUP BY kind")
    ]);
    const R = r => (r && r.results) || [], one = r => R(r)[0] || {};
    const i = one(inv);
    return json({
      ok: true,
      invites: { total: Number(i.n) || 0, d30: Number(i.n30) || 0, opened30: Number(i.o30) || 0, joined30: Number(i.j30) || 0, joined: Number(i.j) || 0, workspaces: Number(i.wsn) || 0 },
      links: Object.fromEntries(R(lnk).map(l => [l.kind, { n: Number(l.n) || 0, used: Number(l.used) || 0, views: Number(l.views) || 0, workspaces: Number(l.wsn) || 0 }])),
      refTop: R(refTop).map(r => ({ id: r.id, name: r.name, n: Number(r.n) || 0, active: Number(r.a) || 0 })),
      days: R(wk).map(r => ({ d: r.d, ref: Number(r.ref), n: Number(r.n) || 0 })),
      joinDays: R(invWk).map(r => ({ d: r.d, n: Number(r.n) || 0 })),
      ent: Object.fromEntries(R(ent).map(r => [r.kind, { n: Number(r.n) || 0, workspaces: Number(r.wsn) || 0 }]))
    });
  },
  /* 시스템 상태 — 표별 행 수, 보안 키, 세션 */
  async "admin/system"(db, me, b, req, url, env) {
    const no = opNeed(me, "see"); if (no) return no;
    const T = ["workspaces", "accounts", "ent", "sess", "invites", "links", "api_tokens", "fb", "adm_log", "err_log", "sp_res", "os_job", "cm_order"];
    const rs = await db.batch([
      db.prepare("SELECT " + T.map(t => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(", ") + ", (SELECT v FROM mw_meta WHERE k='schema') AS schema, (SELECT COUNT(*) FROM sess WHERE seen>=?1) AS s7, (SELECT login_id FROM accounts WHERE is_owner=1 LIMIT 1) AS owner, (SELECT COUNT(*) FROM accounts WHERE op_role IS NOT NULL) AS ops").bind(Date.now() - 7 * 864e5)
    ]);
    const r = ((rs[0] && rs[0].results) || [])[0] || {};
    const raw = adminKeyRaw(env);
    return json({ ok: true, schema: r.schema || "", owner: r.owner || "", ops: Number(r.ops) || 0, sessions7: Number(r.s7) || 0, tables: Object.fromEntries(T.map(t => [t, Number(r[t]) || 0])), keySet: !!adminKey(env), keyShort: !!raw && raw.length < 8, host: url.hostname, legacyDb: !!(env && env.SPACEDB) });
  }
});
/* 운영자 비밀번호 복구 — Cloudflare에 넣어 둔 보안 키(MW_ADMIN_KEY)로만. 다섯 번 틀리면 30분 막습니다 */
PUBLIC["owner-recover"] = async function (db, b, req, url, env) {
  if (!adminKey(env)) return fail("no-key", 404);
  const now = Date.now();
  const st = parse((await db.prepare("SELECT v FROM mw_meta WHERE k='recover_fail'").first() || {}).v) || { n: 0, until: 0 };
  if (Number(st.until) > now) return fail("locked", 429, { minutes: Math.ceil((Number(st.until) - now) / 60000) });
  if (!await keyMatch(env, b.key)) {
    const n = (Number(st.n) || 0) + 1, next = n >= 5 ? { n: 0, until: now + 30 * 60e3 } : { n, until: 0 };
    await db.batch([db.prepare("INSERT OR REPLACE INTO mw_meta(k,v) VALUES('recover_fail',?1)").bind(JSON.stringify(next)), admLog(db, "recover-fail", null, "운영자 복구 — 보안 키 틀림")]);
    return fail("bad-key", 403);
  }
  if (!pwValid(b.pw) || b.pw.length < 8) return fail("bad-pw");   // 운영자는 8자 이상
  const a = await db.prepare("SELECT login_id, ws, member_id FROM accounts WHERE is_owner=1 LIMIT 1").first();
  if (!a) return fail("not-found", 404);
  await db.batch([
    db.prepare("UPDATE accounts SET pw=?1, fails=0, lock_until=0, status='active' WHERE login_id=?2").bind(await makePw(b.pw), a.login_id),
    db.prepare("DELETE FROM sess WHERE ws=?1 AND member_id=?2").bind(a.ws, a.member_id), ntDrop(db, a.ws, a.member_id),
    db.prepare("INSERT OR REPLACE INTO mw_meta(k,v) VALUES('recover_fail',?1)").bind(JSON.stringify({ n: 0, until: 0 })),
    admLog(db, "recover", null, `운영자 ${a.login_id} 비밀번호를 보안 키로 다시 정함`)
  ]);
  return json({ ok: true, loginId: a.login_id });
};

/* ═══════════════ 마이에듀 — 학원 · 교습소 · 과외 · 레슨 ═══════════════
   · 반(수업)·수강생·수강 등록·출결·수업 기록·학생 기록·수강료·상담 문의를 여덟 표에 나눠 둡니다.
   · 월 수강료는 청구일에 '초안'으로 만들어 둡니다. 원장이 확인하고 확정하기 전에는 보호자에게 아무것도 가지 않습니다.
   · 회차권은 결제한 회차에서 출석·지각·보강(설정에 따라 무단 결석까지)을 뺀 만큼이 남습니다.
   · 보호자 페이지(ed-guard)는 수강생마다 하나입니다. 가입 없이 시간표·출결·진도·수강료·영수증을 봅니다.
     연락처·상담 기록·내부 메모는 보내지 않습니다.
   · 강사를 '현장 근무자'로 초대하면 자기가 맡은 반의 출결과 수업 기록만 씁니다. 수강료와 연락처는 받지 않습니다. */
const ED_DDL = [
  "CREATE TABLE IF NOT EXISTS ed_class(ws TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, subject TEXT, kind TEXT NOT NULL DEFAULT 'group', teacher_id TEXT NOT NULL DEFAULT '', room TEXT, cap INTEGER NOT NULL DEFAULT 0, sched TEXT NOT NULL DEFAULT '[]', fee INTEGER NOT NULL DEFAULT 0, fee_mode TEXT NOT NULL DEFAULT 'month', pack_n INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, d TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE TABLE IF NOT EXISTS ed_stu(ws TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'on', grade TEXT, school TEXT, phone TEXT, g_name TEXT, g_phone TEXT, minor INTEGER NOT NULL DEFAULT 0, start_date TEXT, end_date TEXT, d TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE TABLE IF NOT EXISTS ed_enr(ws TEXT NOT NULL, id TEXT NOT NULL, stu_id TEXT NOT NULL, class_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'on', mode TEXT NOT NULL DEFAULT 'month', fee INTEGER, start_date TEXT, end_date TEXT, d TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_ed_enr_stu ON ed_enr(ws,stu_id)",
  "CREATE TABLE IF NOT EXISTS ed_att(ws TEXT NOT NULL, id TEXT NOT NULL, date TEXT NOT NULL, class_id TEXT NOT NULL, stu_id TEXT NOT NULL, status TEXT NOT NULL, deduct INTEGER NOT NULL DEFAULT 0, note TEXT, who TEXT, at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_ed_att_key ON ed_att(ws,date,class_id,stu_id)",
  "CREATE INDEX IF NOT EXISTS idx_ed_att_stu ON ed_att(ws,stu_id,date)",
  "CREATE TABLE IF NOT EXISTS ed_les(ws TEXT NOT NULL, id TEXT NOT NULL, date TEXT NOT NULL, class_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'done', topic TEXT, hw TEXT, note TEXT, who TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_ed_les_key ON ed_les(ws,date,class_id)",
  "CREATE TABLE IF NOT EXISTS ed_note(ws TEXT NOT NULL, id TEXT NOT NULL, stu_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'memo', date TEXT NOT NULL, ym TEXT, title TEXT, body TEXT, share INTEGER NOT NULL DEFAULT 0, who TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_ed_note_stu ON ed_note(ws,stu_id,date)",
  "CREATE TABLE IF NOT EXISTS ed_bill(ws TEXT NOT NULL, id TEXT NOT NULL, stu_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'month', ym TEXT NOT NULL, title TEXT, items TEXT NOT NULL DEFAULT '[]', total INTEGER NOT NULL DEFAULT 0, due TEXT, status TEXT NOT NULL DEFAULT 'draft', paid_at TEXT, method TEXT, d TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))",
  "CREATE INDEX IF NOT EXISTS idx_ed_bill_ym ON ed_bill(ws,ym)",
  "CREATE INDEX IF NOT EXISTS idx_ed_bill_stu ON ed_bill(ws,stu_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_ed_bill_month ON ed_bill(ws,stu_id,ym) WHERE kind='month' AND status<>'void'",
  "CREATE TABLE IF NOT EXISTS ed_lead(ws TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT, grade TEXT, subject TEXT, src TEXT NOT NULL DEFAULT 'etc', status TEXT NOT NULL DEFAULT 'new', next_date TEXT, stu_id TEXT NOT NULL DEFAULT '', d TEXT NOT NULL DEFAULT '{}', created_at TEXT, updated_at TEXT, PRIMARY KEY(ws,id))"
];
const ED_TABLES = ["ed_class", "ed_stu", "ed_enr", "ed_att", "ed_les", "ed_note", "ed_bill", "ed_lead"];
Object.assign(SPC, {
  ed_class: ["id", "name", "subject", "kind", "teacher_id", "room", "cap", "sched", "fee", "fee_mode", "pack_n", "active", "sort", "d", "created_at", "updated_at"],
  ed_stu: ["id", "name", "status", "grade", "school", "phone", "g_name", "g_phone", "minor", "start_date", "end_date", "d", "created_at", "updated_at"],
  ed_enr: ["id", "stu_id", "class_id", "status", "mode", "fee", "start_date", "end_date", "d", "created_at", "updated_at"],
  ed_att: ["id", "date", "class_id", "stu_id", "status", "deduct", "note", "who", "at", "updated_at"],
  ed_les: ["id", "date", "class_id", "status", "topic", "hw", "note", "who", "updated_at"],
  ed_note: ["id", "stu_id", "kind", "date", "ym", "title", "body", "share", "who", "created_at", "updated_at"],
  ed_bill: ["id", "stu_id", "kind", "ym", "title", "items", "total", "due", "status", "paid_at", "method", "d", "created_at", "updated_at"],
  ed_lead: ["id", "name", "phone", "grade", "subject", "src", "status", "next_date", "stu_id", "d", "created_at", "updated_at"]
});
Object.assign(SPJ, { ed_class: { sched: "[]", d: "{}" }, ed_stu: { d: "{}" }, ed_enr: { d: "{}" }, ed_bill: { items: "[]", d: "{}" }, ed_lead: { d: "{}" } });
const ED_BIZ = ["academy", "tutoring", "private", "class"];   // 학원 · 교습소·공부방 · 과외·개인 레슨 · 클래스·강좌(성인 취미·자격 등)
const ED_CKIND = ["group", "one"];   // 반 수업 · 1:1
const ED_FEE = ["month", "pack", "free"];   // 월 수강료 · 회차권 · 받지 않음
const ED_SST = ["on", "pause", "wait", "left"];   // 다니는 중 · 쉬는 중 · 대기 · 그만둠
const ED_EST = ["on", "pause", "end"];
const ED_ATT = ["in", "late", "abs", "exc", "make"];   // 출석 · 지각 · 결석 · 미리 알린 결석(회차를 빼지 않음) · 보강
const ED_NOTE = ["memo", "consult", "report", "guard"];   // 학습 메모 · 상담 · 월간 리포트 · 보호자가 남긴 글
const ED_BK = ["month", "pack", "etc"];   // 월 수강료 · 회차권 · 교재비 등
const ED_BST = ["draft", "issued", "paid", "void"];
const ED_PAY = ["card", "transfer", "cash", "local", "etc"];   // 카드 · 계좌이체 · 현금 · 지역화폐·바우처 · 기타
const ED_LST = ["new", "talk", "trial", "won", "lost"];   // 새 문의 · 상담 · 체험 수업 · 등록 · 보류
const ED_SRC = ["referral", "naver", "sns", "flyer", "walk", "web", "etc"];   // 소개 · 네이버(지도·블로그) · SNS · 전단·현수막 · 지나가다 · 홈페이지 · 기타
const ED_LIMIT = { classes: 300, stus: 3000, enrs: 8000, notes: 30000, bills: 60000, leads: 5000, import: 500 };
const ED_FIELD = new Set(["mine", "att/save", "les/save"]);   // 강사(현장 근무자)도 쓰는 것 — 자기가 맡은 반만
const ED_GUARD_DAY = 10;   // 보호자 페이지 하나에서 하루에 남길 수 있는 알림(입금·결석·메모) 수

function edNorm(s) {   // 설정 — 운영 형태·상호, 수강료 청구 규칙, 회차권 규칙, 보호자 페이지에 보일 것, 운영 점검
  s = s && typeof s === "object" ? s : {};
  const o = k => (s[k] && typeof s[k] === "object" ? s[k] : {});
  const b = o("biz"), bl = o("bill"), pk = o("pack"), g = o("guard"), ins = o("ins"), st = o("staff");
  const bool = (v, d) => (v === undefined || v === null ? d : !!v);
  const staff = {};
  for (const [k, v] of Object.entries(st).slice(0, 200)) { const id = clip(k, 60); if (id && v && typeof v === "object" && dOk(v.crime)) staff[id] = { crime: dOk(v.crime) }; }
  return {
    set: !!s.set,
    biz: { type: ED_BIZ.includes(b.type) ? b.type : "academy", name: clip(b.name, 40), owner: clip(b.owner, 30), no: clip(b.no, 20), phone: clip(b.phone, 30), addr: clip(b.addr, 120), bank: clip(b.bank, 120), pay: mkUrl(b.pay) },
    bill: { day: clampInt(bl.day, 1, 28, 1), next: bool(bl.next, false), due: clampInt(bl.due, 0, 28, 7), auto: bool(bl.auto, true), fin: bool(bl.fin, true), prorate: bool(bl.prorate, true), round: [1, 10, 100, 1000].includes(Number(bl.round)) ? Number(bl.round) : 10, note: clip(bl.note, 300) },
    pack: { abs: bool(pk.abs, true), warn: clampInt(pk.warn, 0, 10, 2) },
    guard: { att: bool(g.att, true), les: bool(g.les, true), bill: bool(g.bill, true), report: bool(g.report, true), absent: bool(g.absent, true), msg: bool(g.msg, true) },
    refund: clip(s.refund, 1500),
    checks: (Array.isArray(s.checks) ? s.checks : []).map(x => clip(x, 30)).filter(Boolean).slice(0, 60),
    staff, ins: { until: dOk(ins.until), name: clip(ins.name, 60) },
    gen: ymOk(s.gen)
  };
}
async function edSettings(db, ws) { const m = await modSettings(db, ws, "ed"); return edNorm(m.settings); }
const edModOn = async (db, ws) => { const w = await db.prepare("SELECT modules FROM workspaces WHERE id=?1").bind(ws).first(); return !!w && (parse(w.modules) || []).includes("edu"); };
const edHas = async (db, ws, t, id) => !!(id && await db.prepare(`SELECT 1 AS x FROM ${t} WHERE ws=?1 AND id=?2`).bind(ws, id).first());
const edCount = async (db, ws, t, where) => Number(((await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ws=?1${where ? " AND " + where : ""}`).bind(ws).first()) || {}).n) || 0;
const edD = x => (x && x.d && typeof x.d === "object" ? x.d : {});
const edPhone = s => clip(String(s || "").replace(/[^\d+\-\s()]/g, ""), 20);
const edLast = ym => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };   // 그 달 마지막 날
const edMon = (ym, n) => { const [y, m] = ym.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const edDow = ds => { const w = new Date(ds + "T00:00:00Z").getUTCDay(); return w === 0 ? 7 : w; };   // 월=1 … 일=7
const edRound = (n, u) => Math.max(0, Math.floor((Number(n) || 0) / (u || 1)) * (u || 1));   // 원 단위 절사
const edMinorGuess = g => /^(미취학|유치|유아|어린이집|초|[5-7]세)/.test(String(g || "").replace(/\s/g, "")) ? 1 : 0;   // 학년으로 만 14세 미만을 짐작 — 화면에서 고칠 수 있습니다
function edSessions(sched, from, to) {   // from~to(포함) 사이에 시간표상 수업이 몇 번 있는지
  const per = new Map(); for (const x of sched || []) per.set(x.w, (per.get(x.w) || 0) + 1);
  if (!per.size || !from || !to || from > to) return 0;
  let n = 0; for (let d = from, i = 0; d <= to && i < 400; d = addDaysS(d, 1), i++) n += per.get(edDow(d)) || 0;
  return n;
}
const edSched = v => (Array.isArray(v) ? v : []).map(x => (x && typeof x === "object" && Number.isInteger(Number(x.w)) && Number(x.w) >= 1 && Number(x.w) <= 7 ? { w: Number(x.w), s: tOk(x.s), e: tOk(x.e) } : null)).filter(x => x && x.s).slice(0, 21).sort((a, b) => a.w - b.w || a.s.localeCompare(b.s));   // 요일(월=1…일=7)과 시작 시각이 있는 줄만
/* 청구 대상 달 — '다음 달 분을 미리'로 두면 청구일에 다음 달 수강료를 만듭니다 */
const edTarget = (set, today) => (set.bill.next ? edMon(today.slice(0, 7), 1) : today.slice(0, 7));

function edClassIn(b) {
  const o = {}, d = {};
  if ("name" in b) o.name = clip(b.name, 40);
  if ("subject" in b) o.subject = clip(b.subject, 30);
  if ("kind" in b) o.kind = ED_CKIND.includes(b.kind) ? b.kind : "group";
  if ("teacher_id" in b) o.teacher_id = clip(b.teacher_id, 60);
  if ("room" in b) o.room = clip(b.room, 30);
  if ("cap" in b) o.cap = clampInt(b.cap, 0, 500, 0);
  if ("sched" in b) o.sched = JSON.stringify(edSched(b.sched));
  if ("fee" in b) o.fee = mkInt(b.fee, 1e9);   // 월 수강료, 회차권이면 회차권 한 묶음 값
  if ("fee_mode" in b) o.fee_mode = ED_FEE.includes(b.fee_mode) ? b.fee_mode : "month";
  if ("pack_n" in b) o.pack_n = clampInt(b.pack_n, 0, 200, 0);
  if ("active" in b) o.active = b.active === false || b.active === 0 ? 0 : 1;
  if ("memo" in b) d.memo = clip(b.memo, 1000);
  if ("color" in b) d.color = /^#[0-9a-f]{6}$/i.test(String(b.color || "")) ? b.color : "";
  if ("pack_days" in b) d.pack_days = clampInt(b.pack_days, 0, 730, 0);   // 회차권 유효기간(일, 0은 없음)
  if ("young" in b) d.young = !!b.young;   // 초·중·고 학생 반 — 교습 시간 제한(조례) 점검에 씁니다
  return { o, d };
}
const ED_CLASS_D0 = () => ({ memo: "", color: "", pack_days: 0, young: true });
function edStuIn(b) {
  const o = {}, d = {};
  if ("name" in b) o.name = clip(b.name, 30);
  if ("status" in b) o.status = ED_SST.includes(b.status) ? b.status : "on";
  if ("grade" in b) o.grade = clip(b.grade, 20);
  if ("school" in b) o.school = clip(b.school, 40);
  if ("phone" in b) o.phone = edPhone(b.phone);
  if ("g_name" in b) o.g_name = clip(b.g_name, 30);
  if ("g_phone" in b) o.g_phone = edPhone(b.g_phone);
  if ("minor" in b) o.minor = b.minor ? 1 : 0;
  for (const k of ["start_date", "end_date"]) if (k in b) o[k] = dOk(b[k]) || null;
  if ("g_rel" in b) d.g_rel = clip(b.g_rel, 10);
  if ("memo" in b) d.memo = clip(b.memo, 2000);
  if ("disc" in b) { const x = b.disc && typeof b.disc === "object" ? b.disc : {}; const pct = x.type === "pct"; d.disc = { type: pct ? "pct" : "amt", v: pct ? clampInt(x.v, 0, 100, 0) : mkInt(x.v, 1e8), note: clip(x.note, 30) }; }
  if ("consent" in b) { const x = b.consent && typeof b.consent === "object" ? b.consent : {}; d.consent = { at: dOk(x.at), how: clip(x.how, 40) }; }
  if ("tags" in b) d.tags = (Array.isArray(b.tags) ? b.tags : String(b.tags || "").split(/[,\n]/)).map(x => clip(x, 16)).filter(Boolean).slice(0, 8);
  if ("leave_reason" in b) d.leave_reason = clip(b.leave_reason, 200);
  return { o, d };
}
const ED_STU_D0 = () => ({ g_rel: "", memo: "", disc: { type: "amt", v: 0, note: "" }, consent: { at: "", how: "" }, tags: [], leave_reason: "" });
const edStuRow = (o, d, now) => Object.assign({ id: bulkId("es"), name: "", status: "on", grade: "", school: "", phone: "", g_name: "", g_phone: "", minor: 0, start_date: kstToday(), end_date: null, created_at: now, updated_at: now }, o, { d: Object.assign(ED_STU_D0(), d) });
function edEnrIn(b) {
  const o = {}, d = {};
  if ("status" in b) o.status = ED_EST.includes(b.status) ? b.status : "on";
  if ("mode" in b) o.mode = ED_FEE.includes(b.mode) ? b.mode : "month";
  if ("fee" in b) o.fee = b.fee === "" || b.fee === null || b.fee === undefined ? null : mkInt(b.fee, 1e9);   // 비우면 반의 수강료를 씁니다
  for (const k of ["start_date", "end_date"]) if (k in b) o[k] = dOk(b[k]) || null;
  if ("memo" in b) d.memo = clip(b.memo, 300);
  if ("base" in b) d.base = clampInt(b.base, -500, 500, 0);   // 회차권 — 마이에듀를 쓰기 전부터 남아 있던 회차
  return { o, d };
}
const edEnrRow = (o, d, now) => Object.assign({ id: bulkId("en"), stu_id: "", class_id: "", status: "on", mode: "month", fee: null, start_date: kstToday(), end_date: null, created_at: now, updated_at: now }, o, { d: Object.assign({ memo: "", base: 0 }, d) });
function edItems(v) {
  const out = []; let sum = 0;
  for (const it of (Array.isArray(v) ? v : []).slice(0, 20)) {
    if (!it || typeof it !== "object") continue;
    const label = clip(it.label, 60); if (!label) continue;
    const amount = Math.max(-1e9, Math.min(1e9, intOr(String(it.amount ?? "").replace(/[^\d-]/g, ""), 0)));   // 할인은 음수 줄로
    const x = { label, amount, class_id: clip(it.class_id, 60), qty: clampInt(it.qty, 0, 500, 0) };
    if (it.note) x.note = clip(it.note, 80);
    out.push(x); sum += amount;
  }
  return { items: out, sum };
}
const ED_BILL_D0 = () => ({ paid_amt: 0, receipt: "", memo: "", refund: null, reported_at: "", reported_by: "", sent_at: "" });
const edBillRow = (o, d, now) => Object.assign({ id: bulkId("eb"), stu_id: "", kind: "month", ym: kstToday().slice(0, 7), title: "", items: "[]", total: 0, due: null, status: "draft", paid_at: null, method: null, created_at: now, updated_at: now }, o, { d: Object.assign(ED_BILL_D0(), d) });
function edLeadIn(b) {
  const o = {}, d = {};
  if ("name" in b) o.name = clip(b.name, 30);
  if ("phone" in b) o.phone = edPhone(b.phone);
  if ("grade" in b) o.grade = clip(b.grade, 20);
  if ("subject" in b) o.subject = clip(b.subject, 40);
  if ("src" in b) o.src = ED_SRC.includes(b.src) ? b.src : "etc";
  if ("status" in b) o.status = ED_LST.includes(b.status) ? b.status : "new";
  if ("next_date" in b) o.next_date = dOk(b.next_date) || null;
  if ("g_name" in b) d.g_name = clip(b.g_name, 30);
  if ("memo" in b) d.memo = clip(b.memo, 2000);
  if ("trial_class" in b) d.trial_class = clip(b.trial_class, 60);
  if ("lost_reason" in b) d.lost_reason = clip(b.lost_reason, 200);
  return { o, d };
}
const ED_LEAD_D0 = () => ({ g_name: "", memo: "", trial_class: "", lost_reason: "", by: "" });

/* 월 수강료 초안 — 다니는 중인 수강생마다 한 장. 반 여러 개면 한 장에 줄로, 그 달 중간에 시작했으면 수업 횟수만큼 */
async function edGen(db, ws, ym, set, only) {
  const first = ym + "-01", last = edLast(ym), today = kstToday();
  const rs = await db.batch([
    db.prepare("SELECT id, name, sched, fee FROM ed_class WHERE ws=?1").bind(ws),
    db.prepare("SELECT id, stu_id, class_id, fee, start_date, end_date FROM ed_enr WHERE ws=?1 AND status='on' AND mode='month' AND (start_date IS NULL OR start_date<=?2) AND (end_date IS NULL OR end_date>=?3)").bind(ws, last, first),
    db.prepare("SELECT id, name, d FROM ed_stu WHERE ws=?1 AND status='on'").bind(ws),
    db.prepare("SELECT stu_id FROM ed_bill WHERE ws=?1 AND ym=?2 AND kind='month' AND status<>'void'").bind(ws, ym)
  ]);
  const R = i => (rs[i] && rs[i].results) || [];
  const cls = new Map(R(0).map(c => [c.id, Object.assign(c, { sched: parse(c.sched) || [] })])), has = new Set(R(3).map(x => x.stu_id)), byStu = new Map();
  for (const e of R(1)) { if (!cls.has(e.class_id)) continue; if (!byStu.has(e.stu_id)) byStu.set(e.stu_id, []); byStu.get(e.stu_id).push(e); }
  const bday = ym + "-" + String(set.bill.day).padStart(2, "0"), due = addDaysS(bday > today ? bday : today, set.bill.due), now = iso(), out = [];
  for (const s of R(2)) {
    if (has.has(s.id) || (only && !only.has(s.id))) continue;
    const es = byStu.get(s.id); if (!es) continue;
    const items = [];
    for (const e of es) {
      const c = cls.get(e.class_id), fee = e.fee != null ? Number(e.fee) : Number(c.fee) || 0;
      if (!fee) continue;
      const it = { label: c.name, amount: fee, class_id: c.id, qty: 0 };
      const st0 = e.start_date && e.start_date > first ? e.start_date : null;
      if (set.bill.prorate && st0) {
        const all = edSessions(c.sched, first, last), part = edSessions(c.sched, st0, last);
        if (all > 0 && part < all) { it.amount = edRound(fee * part / all, set.bill.round); it.note = `${+st0.slice(5, 7)}/${+st0.slice(8)} 시작 · 수업 ${part}/${all}회`; }
      }
      items.push(it);
    }
    if (!items.length) continue;
    const disc = (parse(s.d) || {}).disc || {}, sub = items.reduce((a, x) => a + x.amount, 0);
    const dv = disc.type === "pct" ? edRound(sub * (Number(disc.v) || 0) / 100, set.bill.round) : Math.min(sub, Number(disc.v) || 0);
    if (dv > 0) items.push({ label: disc.note || "할인", amount: -dv, class_id: "", qty: 0 });
    out.push(edBillRow({ stu_id: s.id, kind: "month", ym, title: `${+ym.slice(5)}월 수강료`, items: JSON.stringify(items), total: Math.max(0, sub - dv), due }, {}, now));
  }
  return out;
}
/* 회차권 — 수강생·반마다 [산 회차, 쓴 회차, 처음부터 있던 회차] */
async function edPacks(db, ws, stuId) {
  const rs = await db.batch([
    db.prepare("SELECT b.stu_id AS s, json_extract(i.value,'$.class_id') AS c, SUM(json_extract(i.value,'$.qty')) AS q FROM ed_bill b, json_each(b.items) i WHERE b.ws=?1 AND b.kind='pack' AND b.status IN ('issued','paid')" + (stuId ? " AND b.stu_id=?2" : "") + " GROUP BY s, c").bind(...(stuId ? [ws, stuId] : [ws])),
    db.prepare("SELECT stu_id AS s, class_id AS c, SUM(deduct) AS u FROM ed_att WHERE ws=?1" + (stuId ? " AND stu_id=?2" : "") + " GROUP BY s, c").bind(...(stuId ? [ws, stuId] : [ws])),
    db.prepare("SELECT id, stu_id AS s, class_id AS c, json_extract(d,'$.base') AS base FROM ed_enr WHERE ws=?1 AND mode='pack' AND status<>'end'" + (stuId ? " AND stu_id=?2" : "")).bind(...(stuId ? [ws, stuId] : [ws]))
  ]);
  const R = i => (rs[i] && rs[i].results) || [], k = (s, c) => s + "|" + c, buy = new Map(), used = new Map();
  for (const x of R(0)) buy.set(k(x.s, x.c), Number(x.q) || 0);
  for (const x of R(1)) used.set(k(x.s, x.c), Number(x.u) || 0);
  return R(2).map(e => { const b = buy.get(k(e.s, e.c)) || 0, u = used.get(k(e.s, e.c)) || 0, base = Number(e.base) || 0; return { enr_id: e.id, stu_id: e.s, class_id: e.c, bought: b, used: u, base, left: base + b - u }; });
}

async function edAiSummary(db, me) {   // 클로드가 읽는 요약 — 연락처·보호자 이름은 넣지 않습니다
  const today = kstToday(), ym = today.slice(0, 7), w = edDow(today), since = addDaysS(today, -30), week = addDaysS(today, -7);
  const rs = await db.batch([
    db.prepare("SELECT v FROM mod_set WHERE ws=?1 AND mod='ed' AND k='settings'").bind(me.ws),
    db.prepare("SELECT id, name, subject, kind, teacher_id, cap, sched, fee, fee_mode, active FROM ed_class WHERE ws=?1 ORDER BY sort, created_at LIMIT 300").bind(me.ws),
    db.prepare("SELECT id, name, status, grade FROM ed_stu WHERE ws=?1 AND status<>'left' LIMIT 3000").bind(me.ws),
    db.prepare("SELECT stu_id, class_id, status, mode FROM ed_enr WHERE ws=?1 AND status<>'end' LIMIT 8000").bind(me.ws),
    db.prepare("SELECT date, class_id, stu_id, status FROM ed_att WHERE ws=?1 AND date>=?2 LIMIT 20000").bind(me.ws, since),
    db.prepare("SELECT date, class_id, status, topic, hw FROM ed_les WHERE ws=?1 AND date>=?2 ORDER BY date DESC LIMIT 60").bind(me.ws, week),
    db.prepare("SELECT stu_id, kind, ym, title, total, due, status, json_extract(d,'$.reported_at') AS rep FROM ed_bill WHERE ws=?1 AND (status IN ('issued','draft') OR ym=?2) LIMIT 5000").bind(me.ws, ym),
    db.prepare("SELECT name, grade, subject, src, status, next_date FROM ed_lead WHERE ws=?1 AND status IN ('new','talk','trial') ORDER BY COALESCE(next_date,'9999') LIMIT 60").bind(me.ws)
  ]);
  const R = i => (rs[i] && rs[i].results) || [], s0 = R(0)[0], set = edNorm(s0 ? parse(s0.v) : null);
  const cls = R(1).map(c => Object.assign(c, { sched: parse(c.sched) || [] })), cN = new Map(cls.map(c => [c.id, c.name])), sN = new Map(R(2).map(s => [s.id, s]));
  const att = R(4), packs = (await edPacks(db, me.ws)).filter(p => sN.has(p.stu_id));
  const todayCls = cls.filter(c => c.active && c.sched.some(x => x.w === w)).map(c => {
    const on = R(3).filter(e => e.class_id === c.id && e.status === "on").length, done = att.filter(a => a.date === today && a.class_id === c.id).length;
    return { id: c.id, name: c.name, time: c.sched.filter(x => x.w === w).map(x => x.s + (x.e ? "~" + x.e : "")).join(", "), students: on, checked: done };
  });
  const absent = new Map(); for (const a of att) if (a.status === "abs" && a.date >= week) absent.set(a.stu_id, (absent.get(a.stu_id) || 0) + 1);
  const bills = R(6), late = bills.filter(b => b.status === "issued" && b.due && b.due < today);
  const mon = bills.filter(b => b.ym === ym && b.status !== "void" && b.status !== "draft");
  return {
    today, business: { type: set.biz.type, name: set.biz.name },
    counts: { students: R(2).filter(s => s.status === "on").length, paused: R(2).filter(s => s.status === "pause").length, waiting: R(2).filter(s => s.status === "wait").length, classes: cls.filter(c => c.active).length },
    classes: cls.filter(c => c.active).map(c => ({ id: c.id, name: c.name, subject: c.subject || "", kind: c.kind, feeMode: c.fee_mode, fee: c.fee, capacity: c.cap || null, students: R(3).filter(e => e.class_id === c.id && e.status === "on").length, schedule: c.sched.map(x => ["", "월", "화", "수", "목", "금", "토", "일"][x.w] + " " + x.s + (x.e ? "~" + x.e : "")).join(", ") })),
    todayClasses: todayCls,
    attendance30d: { records: att.length, present: att.filter(a => ["in", "late", "make"].includes(a.status)).length, absent: att.filter(a => a.status === "abs").length, excused: att.filter(a => a.status === "exc").length },
    absentTwiceThisWeek: [...absent].filter(([, n]) => n >= 2).map(([id, n]) => ({ student: (sN.get(id) || {}).name || "", grade: (sN.get(id) || {}).grade || "", absences: n })),
    fees: {
      month: ym, billed: mon.reduce((a, b) => a + (Number(b.total) || 0), 0), paid: mon.filter(b => b.status === "paid").reduce((a, b) => a + (Number(b.total) || 0), 0),
      drafts: bills.filter(b => b.status === "draft").length,
      overdue: late.slice(0, 40).map(b => ({ student: (sN.get(b.stu_id) || {}).name || "", title: b.title || "", amount: b.total, due: b.due, guardianSaidPaid: !!b.rep }))
    },
    lowPacks: packs.filter(p => p.left <= set.pack.warn).slice(0, 40).map(p => ({ student: (sN.get(p.stu_id) || {}).name || "", class: cN.get(p.class_id) || "", left: p.left })),
    recentLessons: R(5).filter(l => l.status === "done" && (l.topic || l.hw)).map(l => ({ date: l.date, class: cN.get(l.class_id) || "", topic: l.topic || "", homework: l.hw || "" })),
    leads: R(7).map(l => ({ name: l.name, grade: l.grade || "", subject: l.subject || "", source: l.src, status: l.status, next: l.next_date || "" })),
    hint: "금액은 원입니다. 수강생 연락처와 보호자 정보는 넣지 않았습니다. 쓰기 토큰은 propose의 ed-report(월간 학습 리포트 초안 — student, month, body)·ed-lead(상담 문의 — name, phone, grade, subject, memo)로 제안할 수 있습니다. 리포트는 초안으로만 들어가고, 원장이 확인해 보호자에게 공개합니다."
  };
}
async function edPropItems(db, me, prop) {   // AI 제안 → 학습 리포트 초안 · 상담 문의
  const p = prop.payload, now = iso(), bump = db.prepare("UPDATE workspaces SET sp_ver=sp_ver+1 WHERE id=?1").bind(me.ws);
  if (prop.kind === "ed-report") {
    const s = await db.prepare("SELECT id, name FROM ed_stu WHERE ws=?1 AND (id=?2 OR name=?2) AND status<>'left' ORDER BY (id=?2) DESC LIMIT 1").bind(me.ws, p.student).first();
    if (!s) return { error: "not-found", hint: "수강생을 찾지 못했습니다." };
    const ym = p.month || kstToday().slice(0, 7), row = { id: bulkId("eo"), stu_id: s.id, kind: "report", date: kstToday(), ym, title: p.title || `${+ym.slice(5)}월 학습 리포트`, body: p.body, share: 0, who: "ai", created_at: now, updated_at: now };
    return { items: [actRow(me, `AI 제안으로 ${s.name} 학생의 ${+ym.slice(5)}월 학습 리포트 초안을 더했습니다.`)], stmts: spBulk(db, "ed_note", me.ws, [row]).concat([bump]), applied: { noteId: row.id, student: s.name } };
  }
  const row = Object.assign({ id: bulkId("el"), name: p.name, phone: edPhone(p.phone), grade: p.grade, subject: p.subject, src: ED_SRC.includes(p.src) ? p.src : "etc", status: "new", next_date: p.next || null, stu_id: "", created_at: now, updated_at: now }, { d: Object.assign(ED_LEAD_D0(), { memo: p.memo || "", by: "ai" }) });
  return { items: [actRow(me, `AI 제안으로 상담 문의 "${row.name}"을(를) 더했습니다.`)], stmts: spBulk(db, "ed_lead", me.ws, [row]).concat([bump]), applied: { leadId: row.id, name: row.name } };
}
/* 앞으로 2주 안에 챙길 날 — 아침 요약과 전날 알림에 씁니다. 수강생이 많아도 날짜마다 한 줄로 묶습니다 */
async function edUpcoming(db, me, today, to) {
  const set = await edSettings(db, me.ws), tgt = edTarget(set, today), items = [], late = [];
  const rs = await db.batch([
    db.prepare("SELECT due, COUNT(*) AS n, SUM(total) AS t FROM ed_bill WHERE ws=?1 AND status='issued' AND due IS NOT NULL AND due<=?2 GROUP BY due").bind(me.ws, to),
    db.prepare("SELECT id, name, status, next_date FROM ed_lead WHERE ws=?1 AND status IN ('new','talk','trial') AND next_date IS NOT NULL AND next_date<=?2 LIMIT 40").bind(me.ws, to),
    db.prepare("SELECT COUNT(*) AS n FROM ed_bill WHERE ws=?1 AND ym=?2 AND kind='month'").bind(me.ws, tgt)
  ]);
  const R = i => (rs[i] && rs[i].results) || [];
  let ln = 0, lt = 0, l0 = "";
  for (const x of R(0)) { if (x.due < today) { ln += Number(x.n) || 0; lt += Number(x.t) || 0; if (!l0 || x.due < l0) l0 = x.due; } else items.push({ k: "ed:due:" + x.due, date: x.due, type: "money", title: `수강료 납부 기한 — ${x.n}명`, url: "#/edu/bill" }); }
  if (ln) late.push({ k: "ed:late", date: l0, type: "money", title: `수강료 미납 — ${ln}명 · ${(lt || 0).toLocaleString("ko-KR")}원`, url: "#/edu/bill" });
  for (const l of R(1)) (l.next_date < today ? late : items).push({ k: "ed:lead:" + l.id, date: l.next_date, type: "due", title: `${l.status === "trial" ? "체험 수업" : "상담 연락"} — ${l.name}`, url: "#/edu/lead" });
  const bday = today.slice(0, 8) + String(set.bill.day).padStart(2, "0");   // 이번 달 청구일
  if (set.set && !(Number(((R(2)[0]) || {}).n) > 0) && bday <= to) items.push({ k: "ed:gen:" + tgt, date: bday < today ? today : bday, type: "money", title: `${+tgt.slice(5)}월 수강료 청구서 만들기`, url: "#/edu/bill" });
  return { items, late };
}
/* 자동 안내 문자 — 납부 기한 전·지남. 보내기 직전에 상태를 다시 읽는 것은 msgAutoWs가 합니다 */
async function edMsgAuto(db, w, set, A, today, sign) {
  if (!(A.edDue && A.edDue.on) && !(A.edLate && A.edLate.on)) return [];
  if (!tierOf(w).modules.includes("edu")) return [];
  const d1 = A.edDue.on ? addDaysS(today, A.edDue.days) : "", d2 = A.edLate.on ? addDaysS(today, -A.edLate.days) : "";
  const rows = (await db.prepare("SELECT b.id, b.title, b.total, b.due, json_extract(b.d,'$.reported_at') AS rep, s.id AS sid, s.name, s.phone, s.g_name, s.g_phone FROM ed_bill b JOIN ed_stu s ON s.ws=b.ws AND s.id=b.stu_id WHERE b.ws=?1 AND b.status='issued' AND b.total>0 AND b.due IN (?2,?3) AND s.status<>'left' LIMIT 80").bind(w.ws, d1 || "-", d2 || "-").all()).results || [];
  const won = n => (Number(n) || 0).toLocaleString("ko-KR") + "원", md = d => String(d || "").slice(5).replace("-", "/"), out = [];
  for (const b of rows) {
    const to = phoneKR(b.g_phone) || phoneKR(b.phone); if (!to) continue;
    const isDue = A.edDue.on && b.due === d1;
    if (!isDue && b.rep) continue;   // 보호자가 이미 보냈다고 알려 온 건에는 미납 안내를 보내지 않습니다
    out.push({ tpl: isDue ? "auto.edDue" : "auto.edLate", ref_kind: "ed-bill", ref_id: b.id, to, name: b.g_name || b.name, fields: { 상호: sign, 이름: b.name, 제목: b.title || "수강료", 금액: won(b.total), 기한: md(b.due) }, link: { kind: "ed-guard", target: b.sid } });
  }
  return out;
}

const EDU = {
  async data(db, me) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const today = kstToday(), now = iso();
    let set = await edSettings(db, me.ws), gen = null;
    const tgt = edTarget(set, today);
    if (set.set && set.bill.auto && +today.slice(8) >= set.bill.day && set.gen !== tgt) {   // 청구일이 지났으면 그 달 초안을 한 번 만들어 둡니다(보내지는 않습니다)
      const rows = await edGen(db, me.ws, tgt, set);
      set = Object.assign({}, set, { gen: tgt });
      const r = await spRun(db, me, spBulk(db, "ed_bill", me.ws, rows, "ignore").concat([db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'ed','settings',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(set))]));
      gen = { ym: tgt, n: rows.length };
      if (r.v != null) me.spv = r.v;
    }
    const since = addDaysS(today, -400), ym0 = edMon(today.slice(0, 7), -24);
    const rs = await db.batch([
      db.prepare(spSel("ed_class", "ws=?1", "ORDER BY sort, created_at LIMIT 300")).bind(me.ws),
      db.prepare(spSel("ed_stu", "ws=?1", "ORDER BY name LIMIT 3000")).bind(me.ws),
      db.prepare(spSel("ed_enr", "ws=?1", "ORDER BY created_at LIMIT 8000")).bind(me.ws),
      db.prepare(spSel("ed_att", "ws=?1 AND date>=?2", "ORDER BY date DESC LIMIT 40000")).bind(me.ws, since),
      db.prepare(spSel("ed_les", "ws=?1 AND date>=?2", "ORDER BY date DESC LIMIT 20000")).bind(me.ws, since),
      db.prepare(spSel("ed_note", "ws=?1", "ORDER BY date DESC, created_at DESC LIMIT 10000")).bind(me.ws),
      db.prepare(spSel("ed_bill", "ws=?1 AND (ym>=?2 OR status IN ('draft','issued'))", "ORDER BY ym DESC, created_at DESC LIMIT 30000")).bind(me.ws, ym0),
      db.prepare(spSel("ed_lead", "ws=?1", "ORDER BY created_at DESC LIMIT 3000")).bind(me.ws),
      db.prepare("SELECT target, token, created_at, expires_at, views, last_view FROM links WHERE ws=?1 AND kind='ed-guard' AND expires_at>?2 ORDER BY created_at").bind(me.ws, now),
      db.prepare("SELECT b.stu_id AS s, json_extract(i.value,'$.class_id') AS c, SUM(json_extract(i.value,'$.qty')) AS q FROM ed_bill b, json_each(b.items) i WHERE b.ws=?1 AND b.kind='pack' AND b.status IN ('issued','paid') GROUP BY s, c").bind(me.ws),
      db.prepare("SELECT stu_id AS s, class_id AS c, SUM(deduct) AS u FROM ed_att WHERE ws=?1 GROUP BY s, c").bind(me.ws)
    ]);
    const R = i => (rs[i] && rs[i].results) || [];
    const links = {}; for (const l of R(8)) links[l.target] = { token: l.token, createdAt: l.created_at, expiresAt: l.expires_at, views: Number(l.views) || 0, lastView: l.last_view || "" };
    const packs = { buy: R(9).map(x => [x.s, x.c, Number(x.q) || 0]), used: R(10).map(x => [x.s, x.c, Number(x.u) || 0]) };   // 회차권 — 400일보다 오래된 출석까지 셉니다
    return rawJson({ ok: true, v: me.spv, today, settings: set, gen, links, packs },
      ',"classes":' + rawArr(rs[0]) + ',"stus":' + rawArr(rs[1]) + ',"enrs":' + rawArr(rs[2]) + ',"atts":' + rawArr(rs[3]) + ',"less":' + rawArr(rs[4]) + ',"notes":' + rawArr(rs[5]) + ',"bills":' + rawArr(rs[6]) + ',"leads":' + rawArr(rs[7]));
  },
  async settings(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const cur = await edSettings(db, me.ws), p = b && b.set && typeof b.set === "object" ? b.set : {};
    const merged = Object.assign({}, cur, p);
    for (const k of ["biz", "bill", "pack", "guard", "ins", "staff"]) if (p[k] && typeof p[k] === "object") merged[k] = Object.assign({}, cur[k], p[k]);
    if (p.staff && typeof p.staff === "object") for (const [k, v] of Object.entries(p.staff)) if (!v || !v.crime) delete merged.staff[k];
    delete merged.gen; merged.gen = cur.gen;   // 자동으로 만든 달은 서버만 적습니다
    if (p.bill && (("day" in p.bill && p.bill.day !== cur.bill.day) || ("next" in p.bill && !!p.bill.next !== cur.bill.next))) merged.gen = "";   // 청구일을 바꾸면 다시 셉니다
    const s = edNorm(merged);
    if (JSON.stringify(s).length > 20000) return fail("too-large", 413);
    const { v } = await spRun(db, me, [db.prepare("INSERT INTO mod_set(ws,mod,k,v) VALUES(?1,'ed','settings',?2) ON CONFLICT(ws,mod,k) DO UPDATE SET v=excluded.v").bind(me.ws, JSON.stringify(s))]);
    return json({ ok: true, v, settings: s });
  },
  async "class/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), { o, d } = edClassIn(b || {}), now = iso();
    if (o.teacher_id && !await db.prepare("SELECT 1 AS x FROM accounts WHERE ws=?1 AND member_id=?2 AND status='active'").bind(me.ws, o.teacher_id).first()) return fail("bad-teacher");
    if (!id) {
      if (!o.name) return fail("bad-request");
      const n = await edCount(db, me.ws, "ed_class");
      if (n >= ED_LIMIT.classes) return fail("limit", 409);
      const row = Object.assign({ id: bulkId("ec"), name: "", subject: "", kind: "group", teacher_id: "", room: "", cap: 0, sched: "[]", fee: 0, fee_mode: "month", pack_n: 0, active: 1, sort: n + 1, created_at: now, updated_at: now }, o, { d: Object.assign(ED_CLASS_D0(), d) });
      const { v } = await spRun(db, me, spBulk(db, "ed_class", me.ws, [row]));
      return json({ ok: true, v, cls: await spOne(db, "ed_class", me.ws, row.id) });
    }
    const cur = await spOne(db, "ed_class", me.ws, id);
    if (!cur) return fail("not-found", 404);
    if ("name" in o && !o.name) return fail("bad-request");
    o.d = JSON.stringify(Object.assign(ED_CLASS_D0(), edD(cur), d)); o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE ed_class SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, cls: await spOne(db, "ed_class", me.ws, id) });
  },
  async "class/del"(db, me, b) {   // 수강 등록이나 출결이 붙어 있으면 지우지 않습니다 (대신 '쉬는 반'으로)
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60);
    if (!id) return fail("bad-request");
    const u = await db.prepare("SELECT (SELECT COUNT(*) FROM ed_enr WHERE ws=?1 AND class_id=?2) + (SELECT COUNT(*) FROM ed_att WHERE ws=?1 AND class_id=?2) AS n").bind(me.ws, id).first();
    if (Number(u && u.n) > 0) return fail("in-use", 409, { n: Number(u.n) });
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM ed_class WHERE ws=?1 AND id=?2").bind(me.ws, id), db.prepare("DELETE FROM ed_les WHERE ws=?1 AND class_id=?2").bind(me.ws, id)]);
    return json({ ok: true, v });
  },
  async "stu/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), { o, d } = edStuIn(b || {}), now = iso();
    if (!id) {
      if (!o.name) return fail("bad-request");
      if (await edCount(db, me.ws, "ed_stu") >= ED_LIMIT.stus) return fail("limit", 409);
      if (!("minor" in o)) o.minor = edMinorGuess(o.grade);
      const row = edStuRow(o, d, now), enr = [];
      for (const x of (Array.isArray(b.enroll) ? b.enroll : []).slice(0, 12)) {   // 등록하면서 반을 함께 고를 수 있습니다
        const c = await db.prepare("SELECT id, fee_mode FROM ed_class WHERE ws=?1 AND id=?2").bind(me.ws, clip(x && x.class_id, 60)).first();
        if (!c || enr.some(e => e.class_id === c.id)) continue;
        const e = edEnrIn(Object.assign({ mode: c.fee_mode }, x));
        enr.push(edEnrRow(Object.assign({ stu_id: row.id, class_id: c.id, start_date: row.start_date }, e.o), e.d, now));
      }
      const { v } = await spRun(db, me, spBulk(db, "ed_stu", me.ws, [row]).concat(enr.length ? spBulk(db, "ed_enr", me.ws, enr) : []));
      return json({ ok: true, v, stu: await spOne(db, "ed_stu", me.ws, row.id), enrs: enr.length ? (await db.prepare(spSel("ed_enr", "ws=?1 AND stu_id=?2")).bind(me.ws, row.id).all()).results.map(r => parse(r.j)) : [] });
    }
    const cur = await spOne(db, "ed_stu", me.ws, id);
    if (!cur) return fail("not-found", 404);
    if ("name" in o && !o.name) return fail("bad-request");
    const stmts = [];
    if (o.status === "left" && cur.status !== "left") {   // 그만두면 수강을 끝내고, 보호자 페이지를 닫습니다
      const end = o.end_date || kstToday(); o.end_date = end;
      stmts.push(db.prepare("UPDATE ed_enr SET status='end', end_date=COALESCE(end_date,?3), updated_at=?4 WHERE ws=?1 AND stu_id=?2 AND status<>'end'").bind(me.ws, id, end, now));
      stmts.push(db.prepare("UPDATE links SET expires_at=?3 WHERE ws=?1 AND kind='ed-guard' AND target=?2 AND expires_at>?3").bind(me.ws, id, new Date(Date.now() - 1000).toISOString()));
    }
    if (o.status && o.status !== "left" && cur.status === "left" && !("end_date" in o)) o.end_date = null;
    o.d = JSON.stringify(Object.assign(ED_STU_D0(), edD(cur), d)); o.updated_at = now;
    stmts.unshift(db.prepare(`UPDATE ed_stu SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o)));
    const { v } = await spRun(db, me, stmts);
    return json({ ok: true, v, stu: await spOne(db, "ed_stu", me.ws, id), enrs: (await db.prepare(spSel("ed_enr", "ws=?1 AND stu_id=?2")).bind(me.ws, id).all()).results.map(r => parse(r.j)) });
  },
  /* 지우기 — 그 수강생의 출결·기록·청구서까지 함께 지웁니다(개인정보를 남기지 않으려면). 돈 메뉴에 적힌 줄은 앱이 따로 정리합니다 */
  async "stu/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60);
    if (!id || !await edHas(db, me.ws, "ed_stu", id)) return fail("not-found", 404);
    const bills = ((await db.prepare("SELECT id FROM ed_bill WHERE ws=?1 AND stu_id=?2").bind(me.ws, id).all()).results || []).map(x => x.id);
    const { v } = await spRun(db, me, [
      ...["ed_enr", "ed_att", "ed_note", "ed_bill"].map(t => db.prepare(`DELETE FROM ${t} WHERE ws=?1 AND stu_id=?2`).bind(me.ws, id)),
      db.prepare("DELETE FROM ed_stu WHERE ws=?1 AND id=?2").bind(me.ws, id),
      db.prepare("UPDATE ed_lead SET stu_id='' WHERE ws=?1 AND stu_id=?2").bind(me.ws, id),
      db.prepare("UPDATE links SET expires_at=?3 WHERE ws=?1 AND kind='ed-guard' AND target=?2 AND expires_at>?3").bind(me.ws, id, new Date(Date.now() - 1000).toISOString())
    ]);
    return json({ ok: true, v, bills });
  },
  /* 엑셀·명단에서 붙여 넣은 줄을 한 번에 — 이름과 보호자 연락처가 같은 사람은 건너뜁니다 */
  async "stu/import"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const list = (Array.isArray(b.rows) ? b.rows : []).slice(0, ED_LIMIT.import), now = iso();
    if (!list.length) return fail("bad-request");
    const [sr, cr, nr] = await db.batch([
      db.prepare("SELECT name, g_phone, phone FROM ed_stu WHERE ws=?1").bind(me.ws),
      db.prepare("SELECT id, name, fee_mode FROM ed_class WHERE ws=?1").bind(me.ws),
      db.prepare("SELECT COUNT(*) AS n FROM ed_stu WHERE ws=?1").bind(me.ws)
    ]);
    const key = (n, p) => String(n || "").replace(/\s/g, "") + "|" + String(p || "").replace(/[^\d]/g, "");
    const seen = new Set(((sr && sr.results) || []).map(s => key(s.name, s.g_phone || s.phone))), cls = (cr && cr.results) || [];
    const room = ED_LIMIT.stus - (Number((((nr && nr.results) || [])[0] || {}).n) || 0);
    const stus = [], enrs = []; let skip = 0;
    for (const x of list) {
      const { o, d } = edStuIn(x && typeof x === "object" ? x : {});
      if (!o.name) { skip++; continue; }
      const k = key(o.name, o.g_phone || o.phone); if (seen.has(k)) { skip++; continue; } seen.add(k);
      if (stus.length >= room) { skip++; continue; }
      if (!("minor" in o)) o.minor = edMinorGuess(o.grade);
      const row = edStuRow(o, d, now); stus.push(row);
      for (const nm of String(x.classes || x.class || "").split(/[,/·]/).map(s => s.trim()).filter(Boolean).slice(0, 6)) {
        const c = cls.find(c => c.name === nm) || cls.find(c => c.name.replace(/\s/g, "") === nm.replace(/\s/g, ""));
        if (c && !enrs.some(e => e.stu_id === row.id && e.class_id === c.id)) enrs.push(edEnrRow({ stu_id: row.id, class_id: c.id, mode: c.fee_mode, start_date: row.start_date }, {}, now));
      }
    }
    if (!stus.length) return json({ ok: true, added: 0, skipped: skip, enrolled: 0 });
    const { v } = await spRun(db, me, spBulk(db, "ed_stu", me.ws, stus).concat(enrs.length ? spBulk(db, "ed_enr", me.ws, enrs) : []));
    return json({ ok: true, v, added: stus.length, skipped: skip, enrolled: enrs.length });
  },
  async "enr/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), { o, d } = edEnrIn(b || {}), now = iso();
    if (!id) {
      const sid = clip(b.stu_id, 60), cid = clip(b.class_id, 60);
      if (!await edHas(db, me.ws, "ed_stu", sid)) return fail("not-found", 404);
      const c = await db.prepare("SELECT id, fee_mode FROM ed_class WHERE ws=?1 AND id=?2").bind(me.ws, cid).first();
      if (!c) return fail("bad-class");
      if (await db.prepare("SELECT 1 AS x FROM ed_enr WHERE ws=?1 AND stu_id=?2 AND class_id=?3 AND status<>'end'").bind(me.ws, sid, cid).first()) return fail("dup", 409);
      if (await edCount(db, me.ws, "ed_enr") >= ED_LIMIT.enrs) return fail("limit", 409);
      const row = edEnrRow(Object.assign({ stu_id: sid, class_id: cid, mode: c.fee_mode }, o), d, now);
      const { v } = await spRun(db, me, spBulk(db, "ed_enr", me.ws, [row]));
      return json({ ok: true, v, enr: await spOne(db, "ed_enr", me.ws, row.id) });
    }
    const cur = await spOne(db, "ed_enr", me.ws, id);
    if (!cur) return fail("not-found", 404);
    if (o.status && o.status !== "end" && cur.status === "end" && await db.prepare("SELECT 1 AS x FROM ed_enr WHERE ws=?1 AND stu_id=?2 AND class_id=?3 AND status<>'end' AND id<>?4").bind(me.ws, cur.stu_id, cur.class_id, id).first()) return fail("dup", 409);
    if (o.status === "end" && !("end_date" in o)) o.end_date = kstToday();
    o.d = JSON.stringify(Object.assign({ memo: "", base: 0 }, edD(cur), d)); o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE ed_enr SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, enr: await spOne(db, "ed_enr", me.ws, id) });
  },
  async "enr/del"(db, me, b) {   // 잘못 넣은 수강 등록 — 출결은 남깁니다
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM ed_enr WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },
  /* 출결 — 한 반·한 날짜를 통째로. 상태를 비우면 그 줄을 지웁니다. 휴강으로 적으면 그날 출결은 없앱니다 */
  async "att/save"(db, me, b) {
    const date = dOk(b.date), cid = clip(b.class_id, 60), today = kstToday();
    if (!date || date > addDaysS(today, 60) || date < addDaysS(today, -400)) return fail("bad-date");
    const c = await db.prepare("SELECT id, teacher_id FROM ed_class WHERE ws=?1 AND id=?2").bind(me.ws, cid).first();
    if (!c) return fail("not-found", 404);
    if (!isMgr(me) && c.teacher_id !== me.id) return fail("forbidden", 403);
    const list = (Array.isArray(b.rows) ? b.rows : []).slice(0, 300), ids = [...new Set(list.map(x => clip(x && x.stu_id, 60)).filter(Boolean))];
    const [sr, er] = await db.batch([
      db.prepare("SELECT id FROM ed_stu WHERE ws=?1 AND id IN (SELECT value FROM json_each(?2))").bind(me.ws, JSON.stringify(ids)),
      db.prepare("SELECT stu_id FROM ed_enr WHERE ws=?1 AND class_id=?2").bind(me.ws, cid)
    ]);
    const okStu = new Set(((sr && sr.results) || []).map(x => x.id)), inCls = new Set(((er && er.results) || []).map(x => x.stu_id));
    const set = await edSettings(db, me.ws), now = iso(), L = b.les && typeof b.les === "object" ? b.les : null, off = !!(L && L.status === "off"), rows = [], dels = [];
    for (const x of list) {
      const sid = clip(x && x.stu_id, 60); if (!okStu.has(sid)) continue;
      const s = String(x.status || "");
      if (!isMgr(me) && !inCls.has(sid) && s !== "make") continue;   // 강사는 자기 반 수강생(과 보강 온 학생)만
      if (!s || off) { dels.push(sid); continue; }
      if (!ED_ATT.includes(s)) continue;
      rows.push({ id: bulkId("ea"), date, class_id: cid, stu_id: sid, status: s, deduct: s === "exc" ? 0 : s === "abs" ? (set.pack.abs ? 1 : 0) : 1, note: clip(x.note, 200), who: me.id, at: tOk(x.at) || null, updated_at: now });
    }
    const stmts = [];
    if (off) stmts.push(db.prepare("DELETE FROM ed_att WHERE ws=?1 AND date=?2 AND class_id=?3").bind(me.ws, date, cid));
    else if (dels.length) stmts.push(db.prepare("DELETE FROM ed_att WHERE ws=?1 AND date=?2 AND class_id=?3 AND stu_id IN (SELECT value FROM json_each(?4))").bind(me.ws, date, cid, JSON.stringify(dels)));
    if (rows.length && !off) stmts.push(...spBulk(db, "ed_att", me.ws, rows, "ON CONFLICT(ws,date,class_id,stu_id) DO UPDATE SET status=excluded.status, deduct=excluded.deduct, note=excluded.note, who=excluded.who, at=COALESCE(excluded.at, ed_att.at), updated_at=excluded.updated_at"));
    if (L) stmts.push(...edLesStmts(db, me, date, cid, L, now));
    if (!stmts.length) return json({ ok: true, v: null, atts: [], les: null });
    const { v } = await spRun(db, me, stmts);
    const [ar, lr] = await db.batch([db.prepare(spSel("ed_att", "ws=?1 AND date=?2 AND class_id=?3")).bind(me.ws, date, cid), db.prepare(spSel("ed_les", "ws=?1 AND date=?2 AND class_id=?3")).bind(me.ws, date, cid)]);
    return json({ ok: true, v, atts: ((ar && ar.results) || []).map(r => parse(r.j)), les: (((lr && lr.results) || [])[0] && parse(lr.results[0].j)) || null });
  },
  async "les/save"(db, me, b) {   // 수업 기록 — 진도·과제·반 메모, 휴강
    const date = dOk(b.date), cid = clip(b.class_id, 60), today = kstToday();
    if (!date || date > addDaysS(today, 60) || date < addDaysS(today, -400)) return fail("bad-date");
    const c = await db.prepare("SELECT id, teacher_id FROM ed_class WHERE ws=?1 AND id=?2").bind(me.ws, cid).first();
    if (!c) return fail("not-found", 404);
    if (!isMgr(me) && c.teacher_id !== me.id) return fail("forbidden", 403);
    const now = iso(), stmts = edLesStmts(db, me, date, cid, b, now);
    if (b.status === "off") stmts.push(db.prepare("DELETE FROM ed_att WHERE ws=?1 AND date=?2 AND class_id=?3").bind(me.ws, date, cid));
    const { v } = await spRun(db, me, stmts);
    const r = await db.prepare(spSel("ed_les", "ws=?1 AND date=?2 AND class_id=?3")).bind(me.ws, date, cid).first();
    return json({ ok: true, v, les: r ? parse(r.j) : null });
  },
  /* 강사 화면 — 내가 맡은 반의 앞뒤 2주. 수강료·연락처는 보내지 않습니다 */
  async mine(db, me) {
    const today = kstToday(), from = addDaysS(today, -14), to = addDaysS(today, 14), all = isMgr(me);
    const cw = all ? "ws=?1 AND active=1" : "ws=?1 AND active=1 AND teacher_id=?2", cb = all ? [me.ws] : [me.ws, me.id];
    const cls = ((await db.prepare(`SELECT id, name, subject, kind, room, cap, sched, teacher_id FROM ed_class WHERE ${cw} ORDER BY sort, created_at LIMIT 100`).bind(...cb).all()).results || []).map(c => Object.assign(c, { sched: parse(c.sched) || [] }));
    if (!cls.length) return json({ ok: true, today, classes: [], stus: [], enrs: [], atts: [], less: [], biz: { name: (await edSettings(db, me.ws)).biz.name } });
    const ids = JSON.stringify(cls.map(c => c.id));
    const rs = await db.batch([
      db.prepare("SELECT e.id, e.stu_id, e.class_id, e.status, e.mode, e.start_date, e.end_date FROM ed_enr e WHERE e.ws=?1 AND e.status<>'end' AND e.class_id IN (SELECT value FROM json_each(?2))").bind(me.ws, ids),
      db.prepare("SELECT s.id, s.name, s.grade, s.status FROM ed_stu s WHERE s.ws=?1 AND s.status IN ('on','pause') AND s.id IN (SELECT stu_id FROM ed_enr WHERE ws=?1 AND status<>'end' AND class_id IN (SELECT value FROM json_each(?2)))").bind(me.ws, ids),
      db.prepare(spSel("ed_att", "ws=?1 AND date>=?2 AND date<=?3 AND class_id IN (SELECT value FROM json_each(?4))")).bind(me.ws, from, to, ids),
      db.prepare(spSel("ed_les", "ws=?1 AND date>=?2 AND date<=?3 AND class_id IN (SELECT value FROM json_each(?4))")).bind(me.ws, from, to, ids),
      db.prepare("SELECT v FROM mod_set WHERE ws=?1 AND mod='ed' AND k='settings'").bind(me.ws)
    ]);
    const R = i => (rs[i] && rs[i].results) || [], s0 = R(4)[0], set = edNorm(s0 ? parse(s0.v) : null);
    return json({ ok: true, today, classes: cls, enrs: R(0), stus: R(1), atts: R(2).map(r => parse(r.j)), less: R(3).map(r => parse(r.j)), biz: { name: set.biz.name, type: set.biz.type }, pack: set.pack });
  },
  async "note/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), now = iso(), o = {};
    if ("kind" in b) o.kind = ED_NOTE.includes(b.kind) && b.kind !== "guard" ? b.kind : "memo";
    if ("date" in b) o.date = dOk(b.date) || kstToday();
    if ("ym" in b) o.ym = ymOk(b.ym) || null;
    if ("title" in b) o.title = clip(b.title, 80);
    if ("body" in b) o.body = clip(b.body, 6000);
    if ("share" in b) o.share = b.share ? 1 : 0;
    if (!id) {
      const sid = clip(b.stu_id, 60);
      if (!await edHas(db, me.ws, "ed_stu", sid)) return fail("not-found", 404);
      if (!o.body && !o.title) return fail("bad-request");
      if (await edCount(db, me.ws, "ed_note") >= ED_LIMIT.notes) return fail("limit", 409);
      const row = Object.assign({ id: bulkId("eo"), stu_id: sid, kind: "memo", date: kstToday(), ym: null, title: "", body: "", share: 0, who: me.id, created_at: now, updated_at: now }, o);
      const { v } = await spRun(db, me, spBulk(db, "ed_note", me.ws, [row]));
      return json({ ok: true, v, note: await spOne(db, "ed_note", me.ws, row.id) });
    }
    const cur = await spOne(db, "ed_note", me.ws, id);
    if (!cur) return fail("not-found", 404);
    if (cur.kind === "guard") { for (const k of Object.keys(o)) if (k !== "share") delete o[k]; o.share = 0; }   // 보호자가 남긴 글은 고치지 않습니다(읽음 표시만)
    o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE ed_note SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, note: await spOne(db, "ed_note", me.ws, id) });
  },
  async "note/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM ed_note WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },
  /* 월 수강료 초안 만들기 — dry면 만들 목록만 돌려줍니다 */
  async "bill/gen"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const ym = ymOk(b.ym) || kstToday().slice(0, 7), set = await edSettings(db, me.ws);
    const only = Array.isArray(b.ids) ? new Set(b.ids.map(x => clip(x, 60))) : null;
    const rows = await edGen(db, me.ws, ym, set, only);
    if (b.dry) return json({ ok: true, preview: rows });
    if (!rows.length) return json({ ok: true, v: null, bills: [] });
    if (await edCount(db, me.ws, "ed_bill") + rows.length > ED_LIMIT.bills) return fail("limit", 409);
    const { v } = await spRun(db, me, spBulk(db, "ed_bill", me.ws, rows, "ignore"));
    return json({ ok: true, v, bills: ((await db.prepare(spSel("ed_bill", "ws=?1 AND id IN (SELECT value FROM json_each(?2))")).bind(me.ws, JSON.stringify(rows.map(r => r.id))).all()).results || []).map(r => parse(r.j)) });
  },
  async "bill/save"(db, me, b) {   // 직접 만드는 청구서(회차권·교재비 등)와 초안·청구 중인 것 고치기
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), now = iso(), o = {}, d = {};
    if ("title" in b) o.title = clip(b.title, 60);
    if ("ym" in b) o.ym = ymOk(b.ym) || kstToday().slice(0, 7);
    if ("due" in b) o.due = dOk(b.due) || null;
    if ("items" in b) { const it = edItems(b.items); o.items = JSON.stringify(it.items); o.total = Math.max(0, it.sum); }
    if ("memo" in b) d.memo = clip(b.memo, 500);
    if (!id) {
      const sid = clip(b.stu_id, 60), kind = ED_BK.includes(b.kind) ? b.kind : "etc";
      if (!await edHas(db, me.ws, "ed_stu", sid)) return fail("not-found", 404);
      if (!o.items || o.items === "[]") return fail("bad-request");
      if (kind === "month" && await db.prepare("SELECT 1 AS x FROM ed_bill WHERE ws=?1 AND stu_id=?2 AND ym=?3 AND kind='month' AND status<>'void'").bind(me.ws, sid, o.ym || kstToday().slice(0, 7)).first()) return fail("dup", 409);
      if (await edCount(db, me.ws, "ed_bill") >= ED_LIMIT.bills) return fail("limit", 409);
      const set = await edSettings(db, me.ws), st = b.status === "issued" ? "issued" : "draft";
      const row = edBillRow(Object.assign({ stu_id: sid, kind, status: st, due: st === "issued" ? addDaysS(kstToday(), set.bill.due) : null }, o), d, now);
      if (!row.title) row.title = kind === "pack" ? "회차권" : kind === "month" ? `${+row.ym.slice(5)}월 수강료` : "교재비·기타";
      const { v } = await spRun(db, me, spBulk(db, "ed_bill", me.ws, [row]));
      return json({ ok: true, v, bill: await spOne(db, "ed_bill", me.ws, row.id) });
    }
    const cur = await spOne(db, "ed_bill", me.ws, id);
    if (!cur) return fail("not-found", 404);
    if (cur.status === "paid" || cur.status === "void") return fail("bad-state", 409);
    o.d = JSON.stringify(Object.assign(ED_BILL_D0(), edD(cur), d)); o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE ed_bill SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, bill: await spOne(db, "ed_bill", me.ws, id) });
  },
  async "bill/issue"(db, me, b) {   // 초안 → 청구. 기한이 없으면 오늘부터 설정한 날 수만큼
    if (!isMgr(me)) return fail("forbidden", 403);
    const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(x => clip(x, 60)).filter(Boolean).slice(0, 3000);
    if (!ids.length) return fail("bad-request");
    const set = await edSettings(db, me.ws), due = dOk(b.due) || addDaysS(kstToday(), set.bill.due), now = iso();
    const { v } = await spRun(db, me, [db.prepare("UPDATE ed_bill SET status='issued', due=COALESCE(CASE WHEN ?3<>'' THEN ?3 END, due, ?4), updated_at=?5 WHERE ws=?1 AND status='draft' AND id IN (SELECT value FROM json_each(?2))").bind(me.ws, JSON.stringify(ids), dOk(b.due) || "", due, now)]);
    return json({ ok: true, v, bills: ((await db.prepare(spSel("ed_bill", "ws=?1 AND id IN (SELECT value FROM json_each(?2))")).bind(me.ws, JSON.stringify(ids)).all()).results || []).map(r => parse(r.j)) });
  },
  async "bill/paid"(db, me, b) {   // 납부 확인
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), cur = await spOne(db, "ed_bill", me.ws, id);
    if (!cur) return fail("not-found", 404);
    if (cur.status === "void") return fail("bad-state", 409);
    const date = dOk(b.date) || kstToday(), amt = b.amount === undefined || b.amount === "" ? cur.total : mkInt(b.amount, 1e10), method = ED_PAY.includes(b.method) ? b.method : "transfer";
    const receipt = ["done", "none", "na", ""].includes(b.receipt) ? b.receipt : "";
    const d = JSON.stringify(Object.assign(ED_BILL_D0(), edD(cur), { paid_amt: amt, receipt }));
    const { v } = await spRun(db, me, [db.prepare("UPDATE ed_bill SET status='paid', paid_at=?3, method=?4, d=?5, due=COALESCE(due,?3), updated_at=?6 WHERE ws=?1 AND id=?2").bind(me.ws, id, date, method, d, iso())]);
    return json({ ok: true, v, bill: await spOne(db, "ed_bill", me.ws, id) });
  },
  async "bill/unpaid"(db, me, b) {   // 납부 확인 취소
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), cur = await spOne(db, "ed_bill", me.ws, id);
    if (!cur || cur.status !== "paid") return fail("bad-state", 409);
    const d = JSON.stringify(Object.assign(ED_BILL_D0(), edD(cur), { paid_amt: 0, receipt: "", refund: null }));
    const { v } = await spRun(db, me, [db.prepare("UPDATE ed_bill SET status='issued', paid_at=NULL, method=NULL, d=?3, updated_at=?4 WHERE ws=?1 AND id=?2").bind(me.ws, id, d, iso())]);
    return json({ ok: true, v, bill: await spOne(db, "ed_bill", me.ws, id) });
  },
  async "bill/void"(db, me, b) {   // 청구 취소 — 기록은 남깁니다. 초안은 그냥 지웁니다
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), cur = await spOne(db, "ed_bill", me.ws, id);
    if (!cur) return fail("not-found", 404);
    if (cur.status === "paid") return fail("bad-state", 409);
    const { v } = await spRun(db, me, [cur.status === "draft" ? db.prepare("DELETE FROM ed_bill WHERE ws=?1 AND id=?2").bind(me.ws, id) : db.prepare("UPDATE ed_bill SET status='void', updated_at=?3 WHERE ws=?1 AND id=?2").bind(me.ws, id, iso())]);
    return json({ ok: true, v, removed: cur.status === "draft" });
  },
  async "bill/refund"(db, me, b) {   // 교습비 반환 기록 — 납부한 청구서에만
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), cur = await spOne(db, "ed_bill", me.ws, id);
    if (!cur || cur.status !== "paid") return fail("bad-state", 409);
    const x = edD(cur), amt = mkInt(b.amount, 1e10);
    if (amt > (Number(x.paid_amt) || cur.total)) return fail("too-much");
    const refund = amt > 0 ? { amt, at: dOk(b.date) || kstToday(), reason: clip(b.reason, 200), calc: clip(b.calc, 300) } : null;
    const { v } = await spRun(db, me, [db.prepare("UPDATE ed_bill SET d=?3, updated_at=?4 WHERE ws=?1 AND id=?2").bind(me.ws, id, JSON.stringify(Object.assign(ED_BILL_D0(), x, { refund })), iso())]);
    return json({ ok: true, v, bill: await spOne(db, "ed_bill", me.ws, id) });
  },
  async "bill/sent"(db, me, b) {   // 문자·링크로 보냈다는 표시
    if (!isMgr(me)) return fail("forbidden", 403);
    const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map(x => clip(x, 60)).filter(Boolean).slice(0, 3000);
    const { v } = await spRun(db, me, [db.prepare("UPDATE ed_bill SET d=json_set(CASE WHEN json_valid(d) THEN d ELSE '{}' END,'$.sent_at',?3) WHERE ws=?1 AND id IN (SELECT value FROM json_each(?2))").bind(me.ws, JSON.stringify(ids), iso())]);
    return json({ ok: true, v });
  },
  async "lead/save"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), { o, d } = edLeadIn(b || {}), now = iso();
    if (!id) {
      if (!o.name) return fail("bad-request");
      if (await edCount(db, me.ws, "ed_lead") >= ED_LIMIT.leads) return fail("limit", 409);
      const row = Object.assign({ id: bulkId("el"), name: "", phone: "", grade: "", subject: "", src: "etc", status: "new", next_date: null, stu_id: "", created_at: now, updated_at: now }, o, { d: Object.assign(ED_LEAD_D0(), d, { by: me.id }) });
      const { v } = await spRun(db, me, spBulk(db, "ed_lead", me.ws, [row]));
      return json({ ok: true, v, lead: await spOne(db, "ed_lead", me.ws, row.id) });
    }
    const cur = await spOne(db, "ed_lead", me.ws, id);
    if (!cur) return fail("not-found", 404);
    if ("name" in o && !o.name) return fail("bad-request");
    o.d = JSON.stringify(Object.assign(ED_LEAD_D0(), edD(cur), d)); o.updated_at = now;
    const { v } = await spRun(db, me, [db.prepare(`UPDATE ed_lead SET ${setCols(o, 3)} WHERE ws=?1 AND id=?2`).bind(me.ws, id, ...Object.values(o))]);
    return json({ ok: true, v, lead: await spOne(db, "ed_lead", me.ws, id) });
  },
  async "lead/del"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const { v } = await spRun(db, me, [db.prepare("DELETE FROM ed_lead WHERE ws=?1 AND id=?2").bind(me.ws, clip(b.id, 60))]);
    return json({ ok: true, v });
  },
  /* 등록으로 넘기기 — 상담 문의로 수강생을 만들고 반에 넣습니다 */
  async "lead/convert"(db, me, b) {
    if (!isMgr(me)) return fail("forbidden", 403);
    const id = clip(b.id, 60), l = await spOne(db, "ed_lead", me.ws, id);
    if (!l) return fail("not-found", 404);
    if (l.stu_id && await edHas(db, me.ws, "ed_stu", l.stu_id)) return fail("bad-state", 409);
    if (await edCount(db, me.ws, "ed_stu") >= ED_LIMIT.stus) return fail("limit", 409);
    const now = iso(), x = edD(l), adult = b.adult === true;
    const s = edStuIn(Object.assign({ name: l.name, grade: l.grade, start_date: dOk(b.start_date) || kstToday() }, adult ? { phone: l.phone } : { g_phone: l.phone, g_name: x.g_name }, b.stu && typeof b.stu === "object" ? b.stu : {}));
    if (!("minor" in s.o)) s.o.minor = edMinorGuess(s.o.grade);
    const row = edStuRow(s.o, Object.assign(s.d, { memo: [x.memo, l.subject ? "상담 과목: " + l.subject : ""].filter(Boolean).join("\n") }), now), enr = [];
    for (const cid of (Array.isArray(b.class_ids) ? b.class_ids : []).slice(0, 12)) {
      const c = await db.prepare("SELECT id, fee_mode FROM ed_class WHERE ws=?1 AND id=?2").bind(me.ws, clip(cid, 60)).first();
      if (c && !enr.some(e => e.class_id === c.id)) enr.push(edEnrRow({ stu_id: row.id, class_id: c.id, mode: c.fee_mode, start_date: row.start_date }, {}, now));
    }
    const { v } = await spRun(db, me, spBulk(db, "ed_stu", me.ws, [row]).concat(enr.length ? spBulk(db, "ed_enr", me.ws, enr) : [], [db.prepare("UPDATE ed_lead SET status='won', stu_id=?3, updated_at=?4 WHERE ws=?1 AND id=?2").bind(me.ws, id, row.id, now)]));
    return json({ ok: true, v, stu: await spOne(db, "ed_stu", me.ws, row.id), enrs: enr.length ? ((await db.prepare(spSel("ed_enr", "ws=?1 AND stu_id=?2")).bind(me.ws, row.id).all()).results || []).map(r => parse(r.j)) : [], lead: await spOne(db, "ed_lead", me.ws, id) });
  }
};
function edLesStmts(db, me, date, cid, L, now) {
  const row = { id: bulkId("ls"), date, class_id: cid, status: L.status === "off" ? "off" : "done", topic: clip(L.topic, 300), hw: clip(L.hw, 300), note: clip(L.note, 1000), who: me.id, updated_at: now };
  if (row.status === "done" && !row.topic && !row.hw && !row.note) return [db.prepare("DELETE FROM ed_les WHERE ws=?1 AND date=?2 AND class_id=?3").bind(me.ws, date, cid)];   // 빈 기록은 남기지 않습니다
  return spBulk(db, "ed_les", me.ws, [row], "ON CONFLICT(ws,date,class_id) DO UPDATE SET status=excluded.status, topic=excluded.topic, hw=excluded.hw, note=excluded.note, who=excluded.who, updated_at=excluded.updated_at");
}

/* ───────── 보호자 페이지 (ed-guard) ─────────
   수강생마다 하나, 1년. 시간표·이번 달 출결·최근 진도와 과제·수강료·영수증·남은 회차·공개한 리포트를 보여 줍니다.
   연락처·상담 기록·학습 메모·내부 메모는 보내지 않습니다. 설정에서 고른 것만 나갑니다. */
Object.assign(LINK_KINDS, {
  "ed-guard": {
    exists: async (db, me, id) => isMgr(me) && hasMod(me, "edu") && !!(await db.prepare("SELECT 1 AS x FROM ed_stu WHERE ws=?1 AND id=?2 AND status<>'left'").bind(me.ws, id).first()),
    view: async (db, l) => {
      if (!await edModOn(db, l.ws)) return null;
      const s = await db.prepare("SELECT id, name, grade, status FROM ed_stu WHERE ws=?1 AND id=?2").bind(l.ws, l.target).first();
      if (!s || s.status === "left") return null;
      const set = await edSettings(db, l.ws), G = set.guard, today = kstToday(), ym = today.slice(0, 7), since = addDaysS(today, -62), y0 = today.slice(0, 4) + "-01";
      const rs = await db.batch([
        db.prepare("SELECT e.class_id, e.status, e.mode, c.name, c.subject, c.room, c.sched, c.kind FROM ed_enr e JOIN ed_class c ON c.ws=e.ws AND c.id=e.class_id WHERE e.ws=?1 AND e.stu_id=?2 AND e.status<>'end' ORDER BY c.sort").bind(l.ws, s.id),
        db.prepare("SELECT date, class_id, status, at FROM ed_att WHERE ws=?1 AND stu_id=?2 AND date>=?3 ORDER BY date DESC LIMIT 120").bind(l.ws, s.id, since),
        db.prepare("SELECT date, class_id, status, topic, hw FROM ed_les WHERE ws=?1 AND date>=?3 AND date<=?4 AND class_id IN (SELECT class_id FROM ed_enr WHERE ws=?1 AND stu_id=?2 AND status<>'end') ORDER BY date DESC LIMIT 40").bind(l.ws, s.id, since, today),
        db.prepare("SELECT id, kind, ym, title, items, total, due, status, paid_at, method, d FROM ed_bill WHERE ws=?1 AND stu_id=?2 AND status IN ('issued','paid') AND (ym>=?3 OR status='issued' OR paid_at>=?4) ORDER BY ym DESC, created_at DESC LIMIT 40").bind(l.ws, s.id, edMon(ym, -12), y0),
        db.prepare("SELECT id, ym, title, body, date FROM ed_note WHERE ws=?1 AND stu_id=?2 AND kind='report' AND share=1 ORDER BY date DESC LIMIT 12").bind(l.ws, s.id),
        db.prepare("SELECT name FROM workspaces WHERE id=?1").bind(l.ws)
      ]);
      const R = i => (rs[i] && rs[i].results) || [], cN = new Map(R(0).map(c => [c.class_id, c.name]));
      const packs = (await edPacks(db, l.ws, s.id)).map(p => ({ class: cN.get(p.class_id) || "", left: p.left })).filter(p => p.class);
      const bills = R(3).map(b => { const x = parse(b.d) || {}; return { id: b.id, kind: b.kind, ym: b.ym, title: b.title || "", items: (parse(b.items) || []).map(i => ({ label: i.label, amount: i.amount, qty: i.qty || 0, note: i.note || "" })), total: b.total, due: b.due || "", status: b.status, paidAt: b.paid_at || "", method: b.method || "", paidAmt: Number(x.paid_amt) || 0, reported: !!x.reported_at, refund: x.refund ? { amt: x.refund.amt, at: x.refund.at } : null }; });
      const w = ((R(5)[0]) || {}).name || "";
      return {
        kind: "ed-guard", title: set.biz.name || w, student: { name: s.name, grade: s.grade || "", status: s.status }, today,
        classes: R(0).map(c => ({ name: c.name, subject: c.subject || "", room: c.room || "", kind: c.kind, mode: c.mode, paused: c.status === "pause", sched: parse(c.sched) || [] })),
        att: G.att ? R(1).map(a => ({ date: a.date, class: cN.get(a.class_id) || "", status: a.status, at: a.at || "" })) : null,
        les: G.les ? R(2).filter(x => x.status === "done" && (x.topic || x.hw)).map(x => ({ date: x.date, class: cN.get(x.class_id) || "", topic: x.topic || "", hw: x.hw || "" })).slice(0, 16) : null,
        offs: R(2).filter(x => x.status === "off" && x.date >= today).map(x => ({ date: x.date, class: cN.get(x.class_id) || "" })),
        bills: G.bill ? bills.filter(b => b.status === "issued" || b.ym >= edMon(ym, -12) || (b.paidAt || "") >= y0) : null,
        year: G.bill ? { y: today.slice(0, 4), paid: bills.filter(b => b.status === "paid" && (b.paidAt || "").startsWith(today.slice(0, 4))).reduce((a, b) => a + (b.paidAmt || b.total) - (b.refund ? b.refund.amt : 0), 0) } : null,
        packs: G.bill ? packs : null,
        reports: G.report ? R(4).map(n => ({ id: n.id, ym: n.ym || "", title: n.title || "", body: n.body || "", date: n.date })) : null,
        can: { absent: G.absent, msg: G.msg, paid: G.bill },
        biz: { name: set.biz.name || w, owner: set.biz.owner, no: set.biz.no, phone: set.biz.phone, addr: set.biz.addr, bank: G.bill ? set.biz.bank : "", pay: G.bill ? set.biz.pay : "", type: set.biz.type, note: G.bill ? set.bill.note : "", refund: set.refund }
      };
    },
    act: async () => ({ error: "bad-state" })
  }
});
/* 보호자가 남기는 것 — 수강료를 보냈다고 알리기 · 결석을 미리 알리기 · 선생님께 한마디. 링크 하나에 하루 열 번까지 */
PUBLIC["ed/guard"] = async function (db, b) {
  const l = await linkRow(db, b.t);
  if (!l || l.kind !== "ed-guard") return fail("not-found", 404);
  if (l.expires_at < iso()) return fail("expired", 410);
  if (!await edModOn(db, l.ws)) return fail("closed", 403);
  const s = await db.prepare("SELECT id, name, status FROM ed_stu WHERE ws=?1 AND id=?2").bind(l.ws, l.target).first();
  if (!s || s.status === "left") return fail("not-found", 404);
  const set = await edSettings(db, l.ws), action = String(b.action || ""), today = kstToday(), now = iso(), who = clip(b.name, 30);
  if (!["paid", "absent", "late", "msg"].includes(action)) return fail("bad-request");
  if ((action === "paid" && !set.guard.bill) || ((action === "absent" || action === "late") && !set.guard.absent) || (action === "msg" && !set.guard.msg)) return fail("closed", 403);
  const op = parse(l.opts) || {}, used = op.d === today ? Number(op.n) || 0 : 0;
  if (used >= ED_GUARD_DAY) return fail("busy", 429);
  const stmts = [db.prepare("UPDATE links SET opts=?2 WHERE token=?1").bind(l.token, JSON.stringify(Object.assign({}, op, { d: today, n: used + 1 })))];
  let title = "", body = "", to = await whoIs(db, l.ws, ["admin"]);
  if (action === "paid") {
    const bl = await spOne(db, "ed_bill", l.ws, clip(b.bill_id, 60));
    if (!bl || bl.stu_id !== s.id || bl.status !== "issued") return fail("bad-state", 409);
    stmts.push(db.prepare("UPDATE ed_bill SET d=?3, updated_at=?4 WHERE ws=?1 AND id=?2").bind(l.ws, bl.id, JSON.stringify(Object.assign(ED_BILL_D0(), edD(bl), { reported_at: now, reported_by: who })), now));
    title = "보호자가 수강료를 보냈다고 알려 왔습니다"; body = `${s.name} · ${bl.title || "수강료"} ${(Number(bl.total) || 0).toLocaleString("ko-KR")}원 — 통장에서 확인해 주세요`;
  } else {
    const note = clip(b.note, 500);
    if (!note) return fail("note-required");
    if (action === "absent" || action === "late") {   // 늦음은 출결을 미리 적지 않고, 원장님과 그 반 강사에게 알리기만 합니다
      const date = dOk(b.date);
      if (!date || date < today || date > addDaysS(today, 30)) return fail("bad-date");
      const w = edDow(date), cls = ((await db.prepare("SELECT c.id, c.name, c.sched, c.teacher_id FROM ed_enr e JOIN ed_class c ON c.ws=e.ws AND c.id=e.class_id WHERE e.ws=?1 AND e.stu_id=?2 AND e.status='on'").bind(l.ws, s.id).all()).results || []).filter(c => (parse(c.sched) || []).some(x => x.w === w));
      if (action === "absent") {
        const rows = cls.map(c => ({ id: bulkId("ea"), date, class_id: c.id, stu_id: s.id, status: "exc", deduct: 0, note: clip("보호자 알림: " + note, 200), who: "guard", at: null, updated_at: now }));
        if (rows.length) stmts.push(...spBulk(db, "ed_att", l.ws, rows, "ignore"));   // 이미 출결을 적었으면 그대로 둡니다
      }
      const md = `${+date.slice(5, 7)}/${+date.slice(8)}`, what = action === "absent" ? "결석" : "늦음";
      to = to.concat(cls.map(c => c.teacher_id).filter(Boolean));
      stmts.push(...spBulk(db, "ed_note", l.ws, [{ id: bulkId("eo"), stu_id: s.id, kind: "guard", date: today, ym: null, title: `${md} ${what} 예정`, body: note, share: 0, who: "guard:" + who, created_at: now, updated_at: now }]));
      title = action === "absent" ? "보호자가 결석을 미리 알려 왔습니다" : "보호자가 늦는다고 알려 왔습니다"; body = `${s.name} · ${md}${cls.length ? " " + cls.map(c => c.name).join(", ") : ""} — ${note}`;
    } else {
      stmts.push(...spBulk(db, "ed_note", l.ws, [{ id: bulkId("eo"), stu_id: s.id, kind: "guard", date: today, ym: null, title: "보호자 메시지", body: note, share: 0, who: "guard:" + who, created_at: now, updated_at: now }]));
      title = "보호자가 글을 남겼습니다"; body = `${s.name} — ${note}`;
    }
  }
  stmts.push(db.prepare("UPDATE workspaces SET sp_ver=sp_ver+1 WHERE id=?1").bind(l.ws));
  await db.batch(stmts);
  await notify(db, l.ws, [...new Set(to)], { type: "reply", title, body, url: action === "paid" ? "#/edu/bill" : "#/edu", tag: "ed-guard:" + s.id });
  return json({ ok: true });
};
AIFN.edu = async (db, me) => { if (!aiMod(me, "edu")) return { error: "module-off" }; return await edAiSummary(db, me); };
AI_KINDS.push("ed-report", "ed-lead");
MCP_TOOLS.splice(MCP_TOOLS.findIndex(t => t.name === "myworks_propose"), 0, { name: "myworks_edu", description: "마이에듀: 반·시간표와 수강생 수, 오늘 수업과 출석 체크 상황, 최근 30일 출결, 이번 주 두 번 이상 결석한 수강생, 이달 수강료 청구·납부와 미납, 남은 회차가 적은 회차권, 최근 수업 진도·과제, 진행 중인 상담 문의 (연락처는 넣지 않음)", input: {} });
mcpFn.myworks_edu = "edu";
MSG_AUTO_HOOKS.push(edMsgAuto);

/* ───────── 진입점 ───────── */
const CANON_HOST = "myworks.ai.kr", MOVE_HOSTS = new Set(["myworkspro.pages.dev", "www.myworks.ai.kr"]);
export async function onRequest(context) {
  const pend = [];   // 응답 뒤에 마저 할 일(푸시 보내기 등). Cloudflare에서는 waitUntil에 맡기고, 없는 곳(로컬 시험)에서는 끝날 때까지 기다립니다
  const res = await route(context, p => { p = Promise.resolve(p).catch(() => {}); if (typeof context.waitUntil === "function") context.waitUntil(p); else pend.push(p); });
  if (pend.length) await Promise.allSettled(pend);
  return res;
}
async function route(context, wait) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const isMcp = url.pathname === "/mcp" || url.pathname === "/mcp/";
  // 주소 통일 — 예전 주소와 www는 myworks.ai.kr로 옮깁니다. 서버(API)와 AI 접속(MCP)은 예전 주소로도 그대로 받습니다.
  if (MOVE_HOSTS.has(url.hostname) && !url.pathname.startsWith("/api/") && !isMcp && (request.method === "GET" || request.method === "HEAD"))
    return new Response(null, { status: 301, headers: { location: "https://" + CANON_HOST + url.pathname + url.search, "cache-control": "max-age=86400" } });
  if (!url.pathname.startsWith("/api/") && !isMcp) return next();
  if (!env.DB) return fail("db-not-bound", 503, { hint: "Pages 설정 → Bindings에서 D1 데이터베이스를 변수 이름 DB로 연결하세요." });
  const D = env.DB, db = { prepare: q => D.prepare(q), batch: l => D.batch(l), exec: q => D.exec(q), env, wait };   // 요청마다 하나 — 뒤에서 env와 wait를 꺼내 씁니다
  if (isMcp) { try { await ensure(db); return await mcp(db, request); } catch (e) { return fail("server-error", 500, { detail: String((e && e.message) || e).slice(0, 300) }); } }
  const path = url.pathname.slice(5).replace(/\/+$/, "");
  let body = {};
  if (request.method === "POST") { try { body = await request.json(); } catch (e) { body = {}; } if (!body || typeof body !== "object") body = {}; }
  try {
    await ensure(db);
    if (Object.prototype.hasOwnProperty.call(PUBLIC, path)) return await PUBLIC[path](db, body, request, url, env);
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
    const MODS = { "sp/": ["space", SPACE], "os/": ["outsourcing", OUTS], "cm/": ["commerce", COMM], "tx/": ["tax", TAX], "pp/": ["people", PEOP], "mk/": ["marketing", MKT], "cr/": ["creator", CREA], "ed/": ["edu", EDU] };
    const mk = Object.keys(MODS).find(k => path.startsWith(k));
    if (mk) {   // 업종 모듈 — 프로 워크스페이스에서 켠 모듈만, 협력사 역할은 쓰지 않습니다
      const [mod, H] = MODS[mk], fn = path.slice(3);
      if (!Object.prototype.hasOwnProperty.call(H, fn)) return fail("not-found", 404);
      const me = await auth(db, request);
      if (!me) return fail("unauthorized", 401);
      if (me.err) return fail(me.err, 403);
      if (me.role === "partner") return fail("forbidden", 403);
      if (!hasMod(me, mod)) return fail("module-off", 403, { module: mod });
      if (isField(me) && !(mod === "space" || (mod === "commerce" && me.role === "worker") || (mod === "people" && PP_SELF.has(fn)) || (mod === "edu" && ED_FIELD.has(fn)))) return fail("forbidden", 403);   // 현장 근무자는 마이스토어·마이셀러 발송·내 근무, 시설 담당은 마이스토어·내 근무만
      return await H[fn](db, me, body, request, url, env);
    }
    if (!Object.prototype.hasOwnProperty.call(PRIVATE, path)) return fail("not-found", 404);
    const me = await auth(db, request);
    if (!me) return fail("unauthorized", 401);
    if (me.err) return fail(me.err, 403);
    if (path === "sync" || path === "state") maybeTick(db);   // 누군가 쓰고 있으면 5분에 한 번 예약 알림을 챙깁니다
    if (path.startsWith("admin/")) {   // 총괄관리 — 운영팀만, 보안 키가 설정돼 있으면 이 로그인에서 한 번 확인한 뒤에만
      if (!me.op) return fail("forbidden", 403);
      if (adminKey(env) && !me.admOk && path !== "admin/gate" && path !== "admin/unlock") return fail("need-key", 403);
      const dbA = { prepare: q => db.prepare(q), batch: l => db.batch(l), exec: q => db.exec(q), env, wait, actor: `${me.name || ""} (${me.lid || ""})` };
      return await PRIVATE[path](dbA, me, body, request, url, env);
    }
    return await PRIVATE[path](db, me, body, request, url, env);
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 500);
    try { await db.prepare("INSERT INTO err_log(id,at,path,msg,ws) VALUES(?1,?2,?3,?4,'')").bind(uid("e"), iso(), path.slice(0, 80), msg).run(); } catch (e2) {}
    return fail("server-error", 500, { detail: msg.slice(0, 300) });
  }
}
