// 초대 링크·진행 공유 링크·소개 코드 서버 시험 — node tests/invite.test.mjs
import fs from "node:fs"; import path from "node:path"; import { pathToFileURL } from "node:url";
import { makeD1 } from "./d1-local.mjs";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = path.join(ROOT, "tests", ".mw_test_" + Date.now() + ".mjs");
fs.writeFileSync(tmp, fs.readFileSync(path.join(ROOT, "functions/_middleware.js"), "utf8"));
const { onRequest } = await import(pathToFileURL(tmp).href); fs.unlinkSync(tmp);
const DB = makeD1();
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log("✗", m); } };
async function call(p, body, token) {
  const req = new Request("https://myworks.ai.kr/api/" + p, { method: body ? "POST" : "GET", headers: Object.assign({ "content-type": "application/json" }, token ? { authorization: "Bearer " + token } : {}), body: body ? JSON.stringify(body) : undefined });
  const r = await onRequest({ request: req, env: { DB }, next: async () => null });
  return { s: r.status, j: await r.json() };
}
const A = (await call("owner-setup", { loginId: "owner1", pw: "pass1234", name: "운영자", workspace: "블랭크" })).j.token;
ok(A, "운영자 설정");
// 프로젝트 2개 만들기
await call("push", { ops: [
  { kind: "project", id: "p1", data: { id: "p1", name: "신규 지점 오픈", ownerId: "", memberIds: [], status: "진행중", budget: 5000000, notes: "비밀 메모" } },
  { kind: "project", id: "p2", data: { id: "p2", name: "브랜드 리뉴얼", ownerId: "", memberIds: [] } },
  { kind: "task", id: "t1", data: { id: "t1", projectId: "p1", title: "인테리어 견적 받기", status: "완료", due: "2026-11-20" } },
  { kind: "task", id: "t2", data: { id: "t2", projectId: "p1", title: "간판 시안", status: "진행중", due: "2026-11-25" } },
  { kind: "contact", id: "c1", data: { id: "c1", name: "김디자이너", email: "kim@example.com", kind: "외주" } }
] }, A);
const st0 = (await call("state", null, A)).j;
const ownerId = st0.me;
// 운영자 워크스페이스 이름 확인
ok(st0.ws && st0.ws.name, "state ws");
// 초대 만들기 — 관리자: 협력사로 p1
let r = await call("invite/create", { people: [{ name: "김디자이너", email: "KIM@example.com", contactId: "c1" }, { name: "박PM", phone: "010-1111-2222" }], role: "partner", projects: ["p1"], days: 14, msg: "같이 해요" }, A);
ok(r.s === 200 && r.j.invites.length === 2, "invite/create " + JSON.stringify(r.j).slice(0, 200));
const [inv1, inv2] = r.j.invites;
ok(inv1.email === "kim@example.com" && inv1.status === "sent" && /^[0-9a-f]{32}$/.test(inv1.token), "invite fields");
// 잘못된 프로젝트
r = await call("invite/create", { people: [{ name: "x" }], projects: ["nope"] }, A); ok(r.s === 404, "invite bad project");
// 공개: 열기
r = await call("invite/get?t=" + inv1.token);
ok(r.s === 200 && r.j.status === "open" && r.j.workspace === "블랭크" && r.j.inviter === "운영자" && r.j.projects[0] === "신규 지점 오픈" && r.j.role === "partner" && r.j.ref, "invite/get " + JSON.stringify(r.j));
r = await call("invite/list", null, A); ok(r.j.invites.find(x => x.token === inv1.token).status === "opened", "opened 상태");
// 수락 — 약관 동의 없이
r = await call("invite/accept", { t: inv1.token, name: "김디자이너", loginId: "kimdesign", pw: "pw123456" }); ok(r.s === 400 && r.j.error === "need-agree", "need-agree");
// 이미 있는 아이디
r = await call("invite/accept", { t: inv1.token, name: "김디자이너", loginId: "owner1", pw: "pw123456", agree: true }); ok(r.s === 409 && r.j.error === "taken", "taken");
// 수락
r = await call("invite/accept", { t: inv1.token, name: "김디자이너", loginId: "kimdesign", pw: "pw123456", agree: true });
ok(r.s === 200 && r.j.token && r.j.projects[0] === "p1", "accept " + JSON.stringify(r.j));
const P = r.j.token;
// 다시 수락 → used
r = await call("invite/accept", { t: inv1.token, name: "x", loginId: "kimdesign2", pw: "pw123456", agree: true }); ok(r.s === 409 && r.j.error === "used", "used");
r = await call("invite/get?t=" + inv1.token); ok(r.j.status === "joined", "get joined");
// 협력사 화면: p1만, 금액·메모 없음, 연락처 없음
const sp = (await call("state", null, P)).j;
ok(sp.role === "partner", "partner role");
const pj = (sp.entities.project || []);
ok(pj.length === 1 && pj[0].id === "p1" && pj[0].budget === undefined && pj[0].memberIds.includes(sp.me), "partner sees p1 only " + JSON.stringify(pj));
ok(!(sp.entities.contact || []).length, "partner no contacts");
// 관리자: 연락처에 memberId, 활동 기록
const sa = (await call("state", null, A)).j;
const c1 = sa.entities.contact.find(c => c.id === "c1");
ok(c1.memberId === sp.me && c1.joinedAt, "contact linked");
ok((sa.entities.act || []).some(a => /김디자이너님이 초대를 받아 합류/.test(a.text)), "act logged");
// 취소·다시 열기
r = await call("invite/update", { token: inv2.token, op: "revoke" }, A); ok(r.s === 200, "revoke");
r = await call("invite/get?t=" + inv2.token); ok(r.s === 410 && r.j.error === "revoked", "revoked get");
r = await call("invite/update", { token: inv2.token, op: "renew" }, A); ok(r.s === 200 && r.j.expiresAt, "renew");
r = await call("invite/get?t=" + inv2.token); ok(r.s === 200, "renewed open");
// 협력사는 초대 못 함
r = await call("invite/create", { people: [{ name: "x" }], projects: ["p1"] }, P); ok(r.s === 403, "partner cannot invite");
// 직원 만들기 → 직원은 참여한 프로젝트에 협력사로만
r = await call("member/create", { loginId: "staff1", pw: "pw123456", name: "직원", role: "staff" }, A);
// 베이직 한도(구성원 2) — 운영자 워크스페이스는 프로
ok(r.s === 200, "staff create " + JSON.stringify(r.j).slice(0, 100));
const S = (await call("login", { loginId: "staff1", pw: "pw123456" })).j.token;
r = await call("invite/create", { people: [{ name: "y" }], role: "staff", projects: ["p1"] }, S); ok(r.s === 403, "staff cannot invite staff");
r = await call("invite/create", { people: [{ name: "y" }], role: "partner", projects: ["p2"] }, S); ok(r.s === 403, "staff not member of p2");
r = await call("invite/create", { people: [{ name: "y" }], role: "partner", projects: [] }, S); ok(r.s === 400, "staff needs project");
// 진행 공유 링크
r = await call("link/create", { kind: "project", target: "p1", days: 30 }, A); ok(r.s === 200 && r.j.token, "project link");
const LT = r.j.token;
r = await call("link/get?t=" + LT);
ok(r.s === 200 && r.j.view.kind === "project" && r.j.view.progress.total === 2 && r.j.view.progress.done === 1 && r.j.view.tasks.length === 2 && r.j.ref, "project view " + JSON.stringify(r.j).slice(0, 300));
ok(!JSON.stringify(r.j).includes("5000000") && !JSON.stringify(r.j).includes("비밀 메모"), "no budget/notes in view");
r = await call("link/list", { kind: "project", target: "p1" }, A); ok(r.j.links[0].views === 1, "views counted");
r = await call("link/act", { t: LT, action: "approve" }); ok(r.s === 409, "project link no act");
r = await call("link/create", { kind: "project", target: "p2" }, S); ok(r.s === 404, "staff cannot share p2");
r = await call("link/create", { kind: "project", target: "p1", tasks: false }, A); const LT2 = r.j.token;
r = await call("link/get?t=" + LT); ok(r.s === 410, "old link closed");
r = await call("link/get?t=" + LT2); ok(r.j.view.tasks.length === 0 && r.j.view.showTasks === false && r.j.view.progress.total === 2, "tasks hidden");
r = await call("link/revoke", { token: LT2 }, A); ok(r.s === 200, "revoke link");
r = await call("link/get?t=" + LT2); ok(r.s === 410, "revoked link 410");
// 소개 코드 → 가입 → 보상
r = await call("ref/info", null, A); const code = r.j.code; ok(/^[A-Z0-9]{7}$/.test(code) && r.j.signups === 0, "ref/info " + JSON.stringify(r.j));
await call("admin/settings", { op: "save", settings: { signup: "open", refDays: 30 } }, A);
r = await call("signup", { mode: "new", workspace: "하루카페", name: "카페사장", loginId: "cafe01", pw: "pw123456", contact: "010-2222-3333", agree: true, ref: code });
ok(r.s === 200 && r.j.status === "active" && r.j.plan === "pro" && r.j.refDays === 30, "ref signup reward " + JSON.stringify(r.j));
r = await call("ref/info", null, A); ok(r.j.signups === 1 && r.j.opened === 1, "ref counted");
r = await call("admin/overview", null, A); const ow = r.j.workspaces.find(w => w.name === "블랭크"), nw = r.j.workspaces.find(w => w.name === "하루카페");
ok(ow.refs === 1 && nw.refBy === ow.id && nw.refPaid, "overview ref fields");
// 승인제에서 소개 → 승인 때 보상
await call("admin/settings", { op: "save", settings: { signup: "approve", refDays: 14 } }, A);
r = await call("signup", { mode: "new", workspace: "공방", name: "공방지기", loginId: "craft01", pw: "pw123456", contact: "010-3333-4444", agree: true, ref: code.toLowerCase() });
ok(r.j.status === "pending", "pending signup");
r = await call("admin/overview", null, A); const cw = r.j.workspaces.find(w => w.name === "공방");
ok(cw.refBy === ow.id && !cw.refPaid, "pending has ref");
r = await call("admin/ws", { id: cw.id, action: "approve" }, A); ok(r.s === 200 && r.j.refDays === 14, "approve reward");
r = await call("admin/overview", null, A); const cw2 = r.j.workspaces.find(w => w.name === "공방"); ok(cw2.planNow === "pro" && cw2.planUntil && cw2.refPaid, "approved ws pro until");
// 잘못된 코드는 무시
r = await call("signup", { mode: "new", workspace: "x카페", name: "x", loginId: "xcafe1", pw: "pw123456", contact: "1", agree: true, ref: "ZZZZZZZ" });
r = await call("admin/overview", null, A); ok(!r.j.workspaces.find(w => w.name === "x카페").refBy, "bad ref ignored");
// 베이직 한도: 하루카페(프로 30일)… 베이직 워크스페이스에서 ws-full 확인
await call("admin/settings", { op: "save", settings: { signup: "open", refDays: 0 } }, A);
r = await call("signup", { mode: "new", workspace: "베이직팀", name: "팀장", loginId: "basic01", pw: "pw123456", contact: "1", agree: true });
const B = (await call("login", { loginId: "basic01", pw: "pw123456" })).j.token;
{ const bw = (await call("admin/overview", null, A)).j.workspaces.find(w => w.name === "베이직팀"); await call("admin/ws", { id: bw.id, action: "plan", plan: "basic", limits: { members: 2 } }, A); }   // 무료 공개 기간에는 한도를 직접 정해 시험합니다
r = await call("invite/create", { people: [{ name: "a" }, { name: "b" }, { name: "c" }], role: "staff" }, B);
ok(r.s === 200 && r.j.seats.limit === 2, "basic invite create");
const bi = r.j.invites;
for (let i = 0; i < 2; i++) { const x = await call("invite/accept", { t: bi[i].token, name: "멤버" + i, loginId: "bmem" + i, pw: "pw123456", agree: true }); ok(x.s === 200, "basic accept " + i); }
r = await call("invite/accept", { t: bi[2].token, name: "멤버2", loginId: "bmem2", pw: "pw123456", agree: true }); ok(r.s === 403 && r.j.error === "ws-full", "ws-full");
// 백업에 invites 포함
r = await call("admin/export", { op: "tables" }, A); ok(r.s === 200 && r.j.tables.includes("invites"), "export tables");
r = await call("admin/export", { table: "invites" }, A); ok(r.s === 200 && r.j.rows.length >= 5, "export invites rows");
console.log(`통과 ${pass} · 실패 ${failN} · 쿼리 ${DB.queries}`);
process.exit(failN ? 1 : 0);
