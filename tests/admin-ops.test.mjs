// 본사 운영팀 권한 · 보안 키 · 계정 지원 · 복구 서버 시험 — node tests/admin-ops.test.mjs
import fs from "node:fs"; import path from "node:path"; import { pathToFileURL } from "node:url";
import { makeD1 } from "./d1-local.mjs";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = path.join(ROOT, "tests", ".mw_test_" + Date.now() + ".mjs");
fs.writeFileSync(tmp, fs.readFileSync(path.join(ROOT, "functions/_middleware.js"), "utf8"));
const { onRequest } = await import(pathToFileURL(tmp).href); fs.unlinkSync(tmp);
const DB = makeD1();
let ENV = { DB };
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log("✗", m); } };
async function call(p, body, token) {
  const req = new Request("https://myworks.ai.kr/api/" + p, { method: body ? "POST" : "GET", headers: Object.assign({ "content-type": "application/json" }, token ? { authorization: "Bearer " + token } : {}), body: body ? JSON.stringify(body) : undefined });
  const r = await onRequest({ request: req, env: ENV, next: async () => null });
  return { s: r.status, j: await r.json() };
}
const O = (await call("owner-setup", { loginId: "owner1", pw: "pass1234", name: "대표", workspace: "본사" })).j.token;
for (const [lid, name] of [["mgr01", "매니저"], ["cs01", "상담"], ["fin01", "재무"], ["view01", "보기"], ["plain01", "직원"]]) {
  const r = await call("member/create", { loginId: lid, pw: "pw123456", name, role: "staff" }, O); ok(r.s === 200, "member " + lid);
}
let r = await call("admin/team", { op: "set", loginId: "mgr01", role: "manager" }, O); ok(r.s === 200 && r.j.members.find(m => m.loginId === "mgr01").op === "manager", "set manager");
await call("admin/team", { op: "set", loginId: "cs01", role: "support" }, O);
await call("admin/team", { op: "set", loginId: "fin01", role: "finance" }, O);
await call("admin/team", { op: "set", loginId: "view01", role: "viewer" }, O);
r = await call("admin/team", { op: "set", loginId: "owner1", role: "viewer" }, O); ok(r.s === 400 && r.j.error === "self", "cannot change owner");
r = await call("admin/team", { op: "set", loginId: "nobody", role: "viewer" }, O); ok(r.s === 404, "team target missing");
const T = {};
for (const lid of ["mgr01", "cs01", "fin01", "view01", "plain01"]) T[lid] = (await call("login", { loginId: lid, pw: "pw123456" })).j.token;
// state에 역할·권한
let st = (await call("state", null, T.cs01)).j; ok(st.op === "support" && st.perms.includes("fb") && !st.perms.includes("pay"), "state op " + st.op);
st = (await call("state", null, T.plain01)).j; ok(st.op === "" && !st.perms.length, "plain no op");
// 다른 워크스페이스 + 결제 기록 + 문의 준비
await call("admin/settings", { op: "save", settings: { signup: "approve" } }, O);
await call("signup", { mode: "new", workspace: "고객사", name: "고객", loginId: "client01", pw: "pw123456", contact: "010", agree: true });
let ov = (await call("admin/overview", null, O)).j; const cw = ov.workspaces.find(w => w.name === "고객사");
await call("admin/pay", { op: "save", ws: cw.id, paidAt: "2026-11-17", amount: 12000, method: "계좌이체", item: "프로 1개월" }, O);
// 권한 표
const M = [
  ["admin/overview", null, { mgr01: 200, cs01: 200, fin01: 200, view01: 200, plain01: 403 }],
  ["admin/pay", { op: "list" }, { mgr01: 403, cs01: 403, fin01: 200, view01: 403 }],
  ["admin/fb", { op: "list" }, { mgr01: 200, cs01: 200, fin01: 403, view01: 403 }],
  ["admin/codes", { op: "list" }, { mgr01: 200, cs01: 403, fin01: 403, view01: 403 }],
  ["admin/ann", { op: "list" }, { mgr01: 200, cs01: 200, fin01: 403, view01: 403 }],
  ["admin/export", { op: "tables" }, { mgr01: 403, cs01: 403, fin01: 403, view01: 403 }],
  ["admin/accounts", { op: "search", q: "client" }, { mgr01: 200, cs01: 200, fin01: 403, view01: 403 }],
  ["admin/growth", null, { mgr01: 200, cs01: 200, fin01: 200, view01: 200 }],
  ["admin/system", null, { mgr01: 200, view01: 200 }],
  ["admin/settings", { op: "save", settings: { signup: "approve" } }, { mgr01: 200, cs01: 403, view01: 403 }],
  ["admin/launch", { op: "save", key: "x", done: true }, { mgr01: 200, cs01: 403, view01: 403 }],
  ["admin/team", { op: "set", loginId: "plain01", role: "viewer" }, { mgr01: 403, cs01: 403 }]
];
for (const [p, body, exp] of M) for (const [who, code] of Object.entries(exp)) { const x = await call(p, body || undefined, T[who]); ok(x.s === code, `${p} ${who} → ${x.s} (기대 ${code})`); }
// 재무는 금액이 보이고, 상담은 안 보임
ov = (await call("admin/overview", null, T.fin01)).j; ok(ov.summary.payMonth === 12000, "finance sees pay");
ov = (await call("admin/overview", null, T.cs01)).j; ok(ov.summary.payMonth === null, "support no pay");
r = await call("admin/ws-detail", { id: cw.id }, T.cs01); ok(r.s === 200 && r.j.payments.length === 0, "support detail no payments");
r = await call("admin/ws-detail", { id: cw.id }, T.fin01); ok(r.j.payments.length === 1, "finance detail payments");
// 재무는 가격표만 바꿀 수 있음
r = await call("admin/settings", { op: "save", settings: { prices: { pro: 15000 } } }, T.fin01); ok(r.s === 200 && r.j.platform.prices.pro === 15000, "finance prices");
r = await call("admin/settings", { op: "save", settings: { prices: { pro: 15000 }, signup: "open" } }, T.fin01); ok(r.s === 403, "finance cannot change signup");
// 현황의 운영 기록에는 보안 키 확인이 빠짐 (아래 키 시험 뒤 확인)
// 워크스페이스 동작
r = await call("admin/ws", { id: cw.id, action: "approve" }, T.fin01); ok(r.s === 403, "finance cannot approve");
r = await call("admin/ws", { id: cw.id, action: "approve" }, T.mgr01); ok(r.s === 200, "manager approve");
r = await call("admin/ws", { id: cw.id, action: "extend", days: 31 }, T.fin01); ok(r.s === 200 && r.j.planUntil, "finance extend");
r = await call("admin/ws", { id: cw.id, action: "delete" }, T.mgr01); ok(r.s === 403, "manager cannot delete");
r = await call("admin/ws", { id: cw.id, action: "resetpw", pw: "newpw1234" }, T.cs01); ok(r.s === 200, "support resetpw ws admin");
// 계정 지원
r = await call("admin/accounts", { op: "search", q: "client01" }, T.cs01); ok(r.j.items.length === 1 && r.j.items[0].wsName === "고객사", "search account");
r = await call("admin/accounts", { op: "resetpw", loginId: "owner1" }, T.cs01); ok(r.s === 403, "support cannot touch owner");
r = await call("admin/accounts", { op: "resetpw", loginId: "mgr01" }, T.cs01); ok(r.s === 403, "support cannot touch op");
r = await call("admin/accounts", { op: "resetpw", loginId: "cs01" }, T.cs01); ok(r.s === 400 && r.j.error === "self", "self");
for (let i = 0; i < 10; i++) await call("login", { loginId: "client01", pw: "wrong-pw" });
r = await call("login", { loginId: "client01", pw: "newpw1234" }); ok(r.s === 429, "client locked");
r = await call("admin/accounts", { op: "search", f: "locked" }, T.cs01); ok(r.j.items.some(a => a.loginId === "client01" && a.locked), "locked filter");
r = await call("admin/accounts", { op: "unlock", loginId: "client01" }, T.cs01); ok(r.s === 200, "unlock");
r = await call("login", { loginId: "client01", pw: "newpw1234" }); ok(r.s === 200, "login after unlock");
const CT = r.j.token;
r = await call("admin/accounts", { op: "logout", loginId: "client01" }, T.cs01); ok(r.s === 200, "force logout");
r = await call("state", null, CT); ok(r.s === 401, "session gone");
r = await call("admin/accounts", { op: "resetpw", loginId: "client01" }, T.cs01); ok(r.s === 200 && /^[a-z0-9]{10}$/.test(r.j.pw), "temp pw");
r = await call("login", { loginId: "client01", pw: r.j.pw }); ok(r.s === 200, "login temp pw");
// 운영 기록에 처리자
r = await call("admin/logs", { op: "list" }, O); ok(r.j.admin.some(l => l.action === "acct-unlock" && /상담 \(cs01\)/.test(l.actor || "")), "actor logged");
// 운영팀에서 빼면 바로 권한 없음
await call("admin/team", { op: "set", loginId: "view01", role: "" }, O);
r = await call("admin/overview", null, T.view01); ok(r.s === 403, "removed op");
// ── 보안 키
ENV = { DB, MW_ADMIN_KEY: "  blank-hq-key-2026  " };
r = await call("admin/overview", null, O); ok(r.s === 403 && r.j.error === "need-key", "need key");
r = await call("admin/gate", null, O); ok(r.j.keySet && !r.j.admOk && r.j.role === "총괄", "gate " + JSON.stringify(r.j));
r = await call("admin/unlock", { key: "wrong" }, O); ok(r.s === 403 && r.j.left === 4, "bad key left");
r = await call("admin/unlock", { key: "blank-hq-key-2026" }, O); ok(r.s === 200, "unlock ok");
r = await call("admin/overview", null, O); ok(r.s === 200 && !r.j.log.some(l => l.action === "key-ok"), "overview after key, no key-ok in recent");
r = await call("admin/logs", { op: "list" }, O); ok(r.j.admin.some(l => l.action === "key-ok" && /대표/.test(l.actor || "")), "key-ok logged with actor");
r = await call("admin/launch", { op: "get" }, O); ok(r.j.auto.adminkey === true, "launch auto adminkey");
r = await call("admin/gate", null, T.mgr01); ok(!r.j.admOk, "other session still locked");
for (let i = 0; i < 4; i++) await call("admin/unlock", { key: "x" + i }, T.mgr01);
r = await call("admin/unlock", { key: "x9" }, T.mgr01); ok(r.s === 429, "5 fails locked");
r = await call("state", null, T.mgr01); ok(r.s === 401, "mgr session ended");
ENV = { DB, MW_ADMIN_KEY: "short" };
r = await call("admin/gate", null, T.cs01); ok(!r.j.keySet && r.j.keyShort && r.j.admOk, "short key ignored");
// ── 운영자 비밀번호 복구
ENV = { DB };
r = await call("owner-recover", { key: "x", pw: "newowner1" }); ok(r.s === 404 && r.j.error === "no-key", "recover needs key set");
ENV = { DB, MW_ADMIN_KEY: "blank-hq-key-2026" };
r = await call("owner-recover", { key: "nope", pw: "newowner1" }); ok(r.s === 403, "recover bad key");
r = await call("owner-recover", { key: "blank-hq-key-2026", pw: "123" }); ok(r.s === 400 && r.j.error === "bad-pw", "recover bad pw");
r = await call("owner-recover", { key: "blank-hq-key-2026", pw: "1234567" }); ok(r.s === 400 && r.j.error === "bad-pw", "recover pw 8+");
r = await call("owner-recover", { key: "blank-hq-key-2026", pw: "newowner1" }); ok(r.s === 200 && r.j.loginId === "owner1", "recover ok");
r = await call("state", null, O); ok(r.s === 401, "owner old session gone");
r = await call("login", { loginId: "owner1", pw: "newowner1" }); ok(r.s === 200, "owner login new pw");
for (let i = 0; i < 5; i++) await call("owner-recover", { key: "bad" + i, pw: "zzzzzz12" });
r = await call("owner-recover", { key: "blank-hq-key-2026", pw: "zzzzzz12" }); ok(r.s === 429, "recover locked after 5");
console.log(`통과 ${pass} · 실패 ${failN}`);
process.exit(failN ? 1 : 0);
