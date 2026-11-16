// 마이스토어 서버 시험 — 업종 유형 · 오픈·마감 점검 · 일 마감 · 소모품 · 리뷰·문의 · 예약형 예약 — node tests/store.test.mjs
import fs from "node:fs"; import path from "node:path"; import { pathToFileURL } from "node:url";
import { makeD1 } from "./d1-local.mjs";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = path.join(ROOT, "tests", ".mw_test_" + Date.now() + ".mjs");
fs.writeFileSync(tmp, fs.readFileSync(path.join(ROOT, "functions/_middleware.js"), "utf8"));
const { onRequest } = await import(pathToFileURL(tmp).href); fs.unlinkSync(tmp);
const DB = makeD1(); const ENV = { DB };
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log("✗", m); } };
async function call(p, body, token) {
  const req = new Request("https://myworks.ai.kr/api/" + p, { method: body ? "POST" : "GET", headers: Object.assign({ "content-type": "application/json" }, token ? { authorization: "Bearer " + token } : {}), body: body ? JSON.stringify(body) : undefined });
  const r = await onRequest({ request: req, env: ENV, next: async () => null });
  return { s: r.status, j: await r.json() };
}
const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addD = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const today = kst(), yday = addD(today, -1);
const A = (await call("owner-setup", { loginId: "boss01", pw: "pass1234", name: "사장", workspace: "하루카페" })).j.token;
let r = await call("sp/data", null, A); ok(r.s === 200 || r.j.error === "module-off", "store data reachable or off");
r = await call("ws/modules", { modules: ["space"] }, A); ok(r.s === 200 && r.j.modules.includes("space"), "turn on store");
// 매장 두 곳: 카페(음식), 파티룸(공간대여)
const now = new Date().toISOString();
await call("push", { ops: [
  { kind: "store", id: "s_cafe", data: { id: "s_cafe", name: "하루카페 합정", brand: "하루", status: "운영중", region: "합정", createdAt: now, updatedAt: now } },
  { kind: "store", id: "s_room", data: { id: "s_room", name: "하루 파티룸", brand: "하루", status: "운영중", region: "합정", createdAt: now, updatedAt: now } },
  { kind: "store", id: "s_hair", data: { id: "s_hair", name: "하루 헤어", brand: "하루", status: "운영중", region: "합정", createdAt: now, updatedAt: now } }
] }, A);
r = await call("member/create", { loginId: "part01", pw: "pw123456", name: "알바", role: "worker" }, A); ok(r.s === 200, "worker create");
const st = (await call("state", null, A)).j; const wid = Object.keys(st.entities || {}).length ? null : null;
const W0 = await call("login", { loginId: "part01", pw: "pw123456" }); const W = W0.j.token; const wMe = W0.j.me || (await call("state", null, W)).j.me;
r = await call("sp/prof", { sid: "s_cafe", on: 1, type: "food", worker: wMe, hours: ["09:00", "22:00"], float: 100000 }, A); ok(r.s === 200 && r.j.prof.type === "food" && r.j.prof.float === 100000, "prof type food");
r = await call("sp/prof", { sid: "s_room", on: 1, type: "space" }, A); ok(r.j.prof.type === "space", "prof space");
r = await call("sp/prof", { sid: "s_hair", on: 1, type: "appt", staff: "원장, 디자이너 민지", hours: ["10:00", "20:00"] }, A); ok(r.j.prof.staff === "원장, 디자이너 민지", "prof appt staff");
r = await call("sp/prof", { sid: "s_cafe", on: 1, type: "weird" }, A); ok(r.j.prof.type === "", "bad type ignored");
await call("sp/prof", { sid: "s_cafe", on: 1, type: "food", worker: wMe, hours: ["09:00", "22:00"], float: 100000 }, A);
// 업종 기본 점검 항목
r = await call("sp/chk/seed", { type: "food" }, A); ok(r.s === 200 && r.j.added === 14 && r.j.settings.biz === "food", "seed food " + JSON.stringify(r.j).slice(0, 120));
r = await call("sp/chk/seed", { type: "retail" }, A); ok(r.j.added === 0 && r.j.settings.biz === "retail", "seed again skipped");
r = await call("sp/data", null, A);
ok(r.j.checks.filter(c => c.list === "open").length === 6 && r.j.checks.filter(c => c.list === "close").length === 8, "checks by list");
ok(r.j.checks.some(c => !c.list), "clean seeds still there");
ok(r.j.branches.find(b => b.id === "s_hair").type === "appt", "branch type in data");
r = await call("sp/chk/save", { label: "커피머신 청소", category: "청소", list: "close" }, A); ok(r.j.item.list === "close", "chk save list");
// 오픈 점검 — 근무자 제출
r = await call("sp/cln/save", { task_key: `s_cafe|${today}|open`, branch_id: "s_cafe", clean_date: today, kind: "open", checks: { a: 1 }, status: "done" }, W); ok(r.s === 200 && r.j.cleaning.kind === "open" && r.j.cleaning.status === "done", "worker open check " + JSON.stringify(r.j).slice(0, 100));
// 일 마감
r = await call("sp/day/save", { branch_id: "s_cafe", date: today, sales: { 카드: 812000, 현금: 54000, 배달앱: 120000, 이상한키: "abc" }, guests: 63, cash_open: 100000, cash_out: 12000, cash_close: 142000, note: "우유 2개 현금 구매" }, W);
ok(r.s === 200 && r.j.day.sales.카드 === 812000 && !("이상한키" in r.j.day.sales) && r.j.day.closed_name === "알바", "worker day close");
r = await call("sp/day/save", { branch_id: "s_cafe", date: addD(today, -3), sales: { 카드: 1 } }, W); ok(r.s === 400 && r.j.error === "bad-date", "worker old date");
r = await call("sp/day/save", { branch_id: "s_cafe", date: yday, sales: { 카드: 700000 }, cash_close: 90000 }, W); ok(r.s === 200, "worker yesterday ok");
r = await call("sp/day/save", { branch_id: "s_hair", date: today, sales: { 카드: 1 } }, W); ok(r.s === 200, "worker all branches when no restriction");
r = await call("sp/day/check", { branch_id: "s_cafe", date: today }, A); ok(r.s === 200 && r.j.day.status === "checked" && r.j.day.check_name === "사장", "mgr check");
r = await call("sp/day/save", { branch_id: "s_cafe", date: today, sales: { 카드: 1 } }, W); ok(r.s === 409 && r.j.error === "locked", "checked locked for worker");
r = await call("sp/day/save", { branch_id: "s_cafe", date: today, sales: { 카드: 812000, 현금: 55000 }, cash_close: 143000 }, A); ok(r.s === 200 && r.j.day.closed_name === "알바" && r.j.day.status === "closed", "mgr edit keeps closer");
r = await call("sp/day/save", { branch_id: "s_cafe", date: addD(today, -40), sales: { 카드: 5 } }, A); ok(r.s === 200, "mgr any date");
r = await call("sp/data", null, W); ok(r.j.days.length >= 2 && r.j.days.every(d => d.date >= yday), "worker sees recent days only " + r.j.days.map(d => d.date));
r = await call("sp/data?from=" + addD(today, -45) + "&to=" + today, null, A); ok(r.j.days.length === 4, "mgr days range " + r.j.days.length);
// 소모품
r = await call("sp/sup/save", { name: "원두 1kg", unit: "봉", qty: 3, min_qty: 4, branch_id: "s_cafe", vendor: "https://example.com/beans" }, A); ok(r.s === 200 && r.j.supply.name === "원두 1kg", "sup create"); const sup = r.j.supply;
r = await call("sp/sup/save", { name: "x" }, W); ok(r.s === 403, "worker cannot create sup");
r = await call("sp/sup/save", { id: sup.id, qty: 2, name: "바꿈" }, W); ok(r.s === 200 && r.j.supply.qty === 2 && r.j.supply.name === "원두 1kg" && r.j.supply.updated_name === "알바", "worker qty only");
r = await call("sp/data", null, W); ok(r.j.sup.length === 1 && !("vendor" in r.j.sup[0]), "worker sup without vendor");
// 리뷰·문의
r = await call("sp/rev/save", { branch_id: "s_cafe", channel: "네이버", kind: "review", rating: 4, author: "j***", body: "라떼가 맛있어요. 자리가 좀 좁아요.", date: today }, A); ok(r.s === 200 && r.j.review.status === "todo", "rev create"); const rv = r.j.review;
r = await call("sp/rev/save", { id: rv.id, reply: "감사합니다!", status: "done" }, A); ok(r.j.review.status === "done" && r.j.review.replied_name === "사장", "rev reply");
r = await call("sp/rev/save", { body: "x" }, W); ok(r.s === 403, "worker no rev");
r = await call("sp/data", null, W); ok(Array.isArray(r.j.rev) && r.j.rev.length === 0, "worker no rev data");
// 예약형 예약
r = await call("sp/res/save", { branch_id: "s_hair", res_date: today, slot: "etc", start_t: "14:00", end_t: "15:30", staff: "디자이너 민지", service: "커트+펌", customer: "김손님", phone: "010-0000-1111", amount: 98000, status: "확정" }, A);
ok(r.s === 200 && r.j.reservation.staff === "디자이너 민지" && r.j.reservation.service === "커트+펌", "appt res");
r = await call("sp/data", null, W); const wr = r.j.res.find(x => x.branch_id === "s_hair"); ok(wr && !wr.customer && !wr.amount && !wr.phone, "worker res no customer/amount");
// 백업에 새 표 포함
r = await call("sp/data", null, A); ok(r.j.settings.biz === "retail", "settings biz kept");
console.log(`통과 ${pass} · 실패 ${failN}`);
process.exit(failN ? 1 : 0);
