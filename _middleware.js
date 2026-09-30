/* 마이웍스 서버 — Cloudflare Pages Functions + D1
   이 파일을 저장소의 functions/_middleware.js 경로에 두고,
   Pages 프로젝트 설정에서 D1 데이터베이스를 변수 이름 DB 로 바인딩하면 동작합니다. */

const WS = "main";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });

async function init(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS rows(ws TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT, pw TEXT, deleted INTEGER DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(ws,kind,id))"
  ).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_rows_sync ON rows(ws,updated_at)").run();
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, ws TEXT NOT NULL, member_id TEXT NOT NULL, created_at TEXT NOT NULL)"
  ).run();
}

const nowStr = () => String(Date.now()).padStart(14, "0");

async function isInitialized(db) {
  const r = await db.prepare("SELECT COUNT(*) AS c FROM rows WHERE ws=?1 AND kind='meta'").bind(WS).first();
  return !!(r && r.c > 0);
}

async function authMember(db, request) {
  const t = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!t) return null;
  const srow = await db.prepare("SELECT member_id FROM sessions WHERE token=?1 AND ws=?2").bind(t, WS).first();
  if (!srow) return null;
  const m = await db.prepare("SELECT data FROM rows WHERE ws=?1 AND kind='member' AND id=?2 AND deleted=0")
    .bind(WS, srow.member_id).first();
  if (!m) return null;
  const data = JSON.parse(m.data || "{}");
  if (data.active === false) return null;
  return { id: srow.member_id, role: data.role || "staff", token: t };
}

function upsertStmt(db, kind, id, data, pw, deleted, now) {
  return db.prepare(
    "INSERT INTO rows(ws,kind,id,data,pw,deleted,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7) " +
    "ON CONFLICT(ws,kind,id) DO UPDATE SET data=excluded.data, deleted=excluded.deleted, updated_at=excluded.updated_at, pw=COALESCE(excluded.pw, rows.pw)"
  ).bind(WS, kind, id, data == null ? null : JSON.stringify(data), pw || null, deleted ? 1 : 0, now);
}

function backupToOps(data) {
  const ops = [];
  const meta = { workspace: (data.meta && data.meta.workspace) || "마이웍스", brands: data.brands || [], finCats: data.finCats || null };
  ops.push({ kind: "meta", id: "ws", data: meta });
  const map = [["member","members"],["project","projects"],["store","stores"],["task","tasks"],["comment","comments"],["fin","finance"],["routine","routines"],["template","templates"],["plan","plans"],["act","activity"]];
  for (const [kind, arr] of map) {
    for (const it of (Array.isArray(data[arr]) ? data[arr] : [])) {
      if (!it || !it.id) continue;
      const row = { ...it };
      let pw;
      if (kind === "member" && row.pwHash) { pw = row.pwHash; delete row.pwHash; }
      ops.push({ kind, id: it.id, data: row, pw });
    }
  }
  return ops;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return next();
  if (!env.DB) return json({ error: "db-not-bound", hint: "Pages 설정 → 바인딩에서 D1을 변수 이름 DB로 연결하세요." }, 503);

  const db = env.DB;
  await init(db);
  const path = url.pathname.slice(5).replace(/\/+$/, "");
  let body = {};
  if (request.method === "POST") { try { body = await request.json(); } catch (e) {} }

  try {
    /* ── 상태 ── */
    if (path === "status") {
      const inited = await isInitialized(db);
      let workspace = "";
      if (inited) {
        const m = await db.prepare("SELECT data FROM rows WHERE ws=?1 AND kind='meta' AND id='ws'").bind(WS).first();
        workspace = m ? (JSON.parse(m.data || "{}").workspace || "") : "";
      }
      return json({ ok: true, initialized: inited, workspace });
    }

    /* ── 최초 설정 ── */
    if (path === "setup" && request.method === "POST") {
      if (await isInitialized(db)) return json({ error: "initialized" }, 409);
      const a = body.admin || {};
      if (!a.id || !a.loginId || !a.pwHash) return json({ error: "bad-request" }, 400);
      const now = nowStr();
      const adminRow = { ...a }; const pw = adminRow.pwHash; delete adminRow.pwHash;
      await db.batch([
        upsertStmt(db, "meta", "ws", { workspace: body.workspace || "마이웍스", brands: body.brands || [], finCats: null }, null, 0, now),
        upsertStmt(db, "member", a.id, adminRow, pw, 0, now)
      ]);
      const token = crypto.randomUUID();
      await db.prepare("INSERT INTO sessions(token,ws,member_id,created_at) VALUES(?1,?2,?3,?4)")
        .bind(token, WS, a.id, now).run();
      return json({ ok: true, token, me: a.id, now });
    }

    /* ── 로그인 ── */
    if (path === "login" && request.method === "POST") {
      if (!(await isInitialized(db))) return json({ error: "not-initialized" }, 409);
      const { loginId, pw } = body;
      const all = await db.prepare("SELECT id,data,pw FROM rows WHERE ws=?1 AND kind='member' AND deleted=0").bind(WS).all();
      const hit = (all.results || []).find(r => { try { return JSON.parse(r.data || "{}").loginId === loginId; } catch (e) { return false; } });
      if (!hit || !pw || hit.pw !== String(pw)) return json({ error: "invalid" }, 401);
      const md = JSON.parse(hit.data || "{}");
      if (md.active === false) return json({ error: "inactive" }, 403);
      const token = crypto.randomUUID();
      await db.prepare("INSERT INTO sessions(token,ws,member_id,created_at) VALUES(?1,?2,?3,?4)")
        .bind(token, WS, hit.id, nowStr()).run();
      return json({ ok: true, token, me: hit.id });
    }

    /* ── 로그아웃 ── */
    if (path === "logout" && request.method === "POST") {
      const t = body.token || (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (t) await db.prepare("DELETE FROM sessions WHERE token=?1").bind(t).run();
      return json({ ok: true });
    }

    /* ── 백업 파일로 서버 시드 (미초기화 상태) 또는 관리자 복원 ── */
    if (path === "restore" && request.method === "POST") {
      const inited = await isInitialized(db);
      if (inited) {
        const me = await authMember(db, request);
        if (!me) return json({ error: "unauthorized" }, 401);
        if (me.role !== "admin") return json({ error: "forbidden" }, 403);
      }
      const data = body.data || {};
      if (!data.meta || data.meta.app !== "myworks" || !Array.isArray(data.members) || !data.members.length)
        return json({ error: "bad-backup" }, 400);
      const now = nowStr();
      await db.prepare("DELETE FROM rows WHERE ws=?1").bind(WS).run();
      const ops = backupToOps(data);
      for (let i = 0; i < ops.length; i += 40) {
        await db.batch(ops.slice(i, i + 40).map(o => upsertStmt(db, o.kind, o.id, o.data, o.pw, 0, now)));
      }
      return json({ ok: true, now });
    }

    /* ── 이하 인증 필요 ── */
    const me = await authMember(db, request);
    if (!me) return json({ error: "unauthorized" }, 401);

    if (path === "state") {
      const all = await db.prepare("SELECT kind,id,data FROM rows WHERE ws=?1 AND deleted=0").bind(WS).all();
      const entities = {}; let meta = {};
      for (const r of (all.results || [])) {
        const d = JSON.parse(r.data || "{}");
        if (r.kind === "meta") { meta = d; continue; }
        (entities[r.kind] = entities[r.kind] || []).push(d);
      }
      return json({ ok: true, me: me.id, workspace: meta.workspace || "", meta, entities, now: nowStr() });
    }

    if (path.startsWith("sync")) {
      const since = url.searchParams.get("since") || "0";
      const all = await db.prepare("SELECT kind,id,data,deleted,updated_at FROM rows WHERE ws=?1 AND updated_at>=?2")
        .bind(WS, since).all();
      const rows = (all.results || []).map(r => ({
        kind: r.kind, id: r.id, deleted: r.deleted ? 1 : 0,
        data: r.deleted ? null : JSON.parse(r.data || "{}"), updated_at: r.updated_at
      }));
      return json({ ok: true, rows, now: nowStr() });
    }

    if (path === "push" && request.method === "POST") {
      const ops = Array.isArray(body.ops) ? body.ops : [];
      if (!ops.length) return json({ ok: true, now: nowStr() });
      if (ops.length > 500) return json({ error: "too-many-ops" }, 413);
      const now = nowStr();
      for (let i = 0; i < ops.length; i += 40) {
        await db.batch(ops.slice(i, i + 40).map(o =>
          upsertStmt(db, String(o.kind || ""), String(o.id || ""), o.deleted ? null : (o.data || {}), o.pw, o.deleted ? 1 : 0, now)
        ));
      }
      return json({ ok: true, now });
    }

    if (path === "wipe" && request.method === "POST") {
      if (me.role !== "admin") return json({ error: "forbidden" }, 403);
      await db.prepare("DELETE FROM rows WHERE ws=?1").bind(WS).run();
      await db.prepare("DELETE FROM sessions WHERE ws=?1").bind(WS).run();
      return json({ ok: true });
    }

    return json({ error: "not-found" }, 404);
  } catch (e) {
    return json({ error: "server-error", detail: String(e && e.message || e) }, 500);
  }
}
