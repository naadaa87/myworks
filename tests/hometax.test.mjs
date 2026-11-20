// 홈택스 자료 자동 수집 서버 시험 — node tests/hometax.test.mjs
// 팝빌(홈택스 수집)은 tests/mock-upstream.mjs 가 흉내 냅니다. 토큰 서버 흉내는 요청 서명을 다시 계산해 맞을 때만 토큰을 줍니다.
import fs from "node:fs"; import path from "node:path"; import { pathToFileURL } from "node:url";
import { makeD1 } from "./d1-local.mjs";
import MOCK, { PB_LINK_ID, PB_SECRET } from "./mock-upstream.mjs";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tmp = path.join(ROOT, "tests", ".mw_test_" + Date.now() + ".mjs");
fs.writeFileSync(tmp, fs.readFileSync(path.join(ROOT, "functions/_middleware.js"), "utf8"));
const { onRequest } = await import(pathToFileURL(tmp).href); fs.unlinkSync(tmp);
const DB = makeD1(); const ENV = { DB };
let pass = 0, failN = 0, maxQ = 0, maxQPath = "";
const ok = (c, m) => { if (c) pass++; else { failN++; console.log("✗", m); } };
async function call(p, body, token, method) {
  const req = new Request("https://myworks.ai.kr/api/" + p, { method: method || (body ? "POST" : "GET"), headers: Object.assign({ "content-type": "application/json" }, token ? { authorization: "Bearer " + token } : {}), body: body ? JSON.stringify(body) : undefined });
  DB.resetCount();
  const r = await onRequest({ request: req, env: ENV, next: async () => null });
  if (p !== "owner-setup" && p !== "restore" && p !== "admin/ws" && DB.queries > maxQ) { maxQ = DB.queries; maxQPath = p; }   // admin/ws(삭제)는 표마다 한 줄씩 지우는 한 묶음(batch) — D1은 묶음을 쿼리 하나로 셉니다
  return { s: r.status, j: await r.json(), q: DB.queries };
}
const kd = n => new Date(Date.now() + 9 * 3600e3 + n * 864e5).toISOString().slice(0, 10);

const A = (await call("owner-setup", { loginId: "boss01", pw: "pass1234", name: "김대표", workspace: "하루 디자인" })).j.token;
await call("ws/modules", { modules: ["tax"] }, A);
await call("member/create", { loginId: "staff01", pw: "pw123456", name: "민 매니저", role: "staff" }, A);
await call("member/create", { loginId: "alba01", pw: "pw123456", name: "알바 최", role: "worker" }, A);
const S = (await call("login", { loginId: "staff01", pw: "pw123456" })).j.token, W = (await call("login", { loginId: "alba01", pw: "pw123456" })).j.token;
const WS = (await call("state", null, A)).j.ws.id;
let r = await call("tx/biz/save", { name: "하루 디자인", kind: "indiv", vat: "general", biz_no: "123-45-67890" }, A);
const BIZ = r.j.biz.id;
r = await call("tx/biz/save", { name: "번호 없는 사업자", kind: "indiv", vat: "general" }, A); const BIZ0 = r.j.biz.id;

/* ── 닫혀 있을 때 ── */
r = await call("tx/ht/state", null, A); ok(r.s === 200 && r.j.open === false && Object.keys(r.j.biz).length === 0 && r.j.jobs.length === 0, "closed until the operator sets the keys");
r = await call("tx/data", null, A); ok(r.j.keys.ht === false, "tax screen knows it is closed");
r = await call("tx/ht/join", { biz_id: BIZ, agree: true, form: {} }, A); ok(r.j.error === "ht-closed", "join refused while closed");
r = await call("tx/ht/collect", { biz_id: BIZ }, A); ok(r.j.error === "ht-closed", "collect refused while closed");
ENV.POPBILL_LINK_ID = PB_LINK_ID; ENV.POPBILL_SECRET_KEY = "short"; r = await call("tx/ht/state", null, A); ok(r.j.open === false, "a too-short secret is ignored");
ENV.POPBILL_SECRET_KEY = PB_SECRET; ENV.POPBILL_TEST = "1";
r = await call("tx/ht/state", null, S); ok(r.j.open === true && r.j.test === true, "open (test environment) once both values are set");
r = await call("tx/ht/state", null, W); ok(r.s === 403, "field worker cannot see it");

/* ── ① 수집 서비스 가입 ── */
const FORM = { ceo: "김하루", name: "하루 디자인", addr: "서울 마포구 어울마당로 1", bizType: "서비스", bizClass: "디자인", contactName: "김하루", contactEmail: "haru@example.com", contactTel: "010-1111-2222" };
r = await call("tx/ht/join", { biz_id: BIZ0, agree: true, form: FORM }, A); ok(r.s === 400 && r.j.error === "no-bizno", "needs a business registration number");
r = await call("tx/ht/join", { biz_id: "nope", agree: true, form: FORM }, A); ok(r.s === 404, "unknown business");
r = await call("tx/ht/join", { biz_id: BIZ, agree: true, form: FORM }, S); ok(r.s === 403, "only the admin joins");
r = await call("tx/ht/join", { biz_id: BIZ, form: FORM }, A); ok(r.j.error === "need-agree", "must agree to hand the business details over");
r = await call("tx/ht/join", { biz_id: BIZ, agree: true, form: Object.assign({}, FORM, { addr: "" }) }, A); ok(r.j.error === "bad-request", "every field is required");
r = await call("tx/ht/join", { biz_id: BIZ, agree: true, form: Object.assign({}, FORM, { contactEmail: "no-at" }) }, A); ok(r.j.error === "bad-request", "email must look like one");
r = await call("tx/ht/join", { biz_id: BIZ, agree: true, form: FORM }, A);
ok(r.s === 200 && r.j.biz[BIZ].joined && r.j.biz[BIZ].corp === "1234567890" && r.j.account && /^mw1234567890[0-9a-f]{4}$/.test(r.j.account.id) && /[A-Za-z]/.test(r.j.account.pw) && /\d/.test(r.j.account.pw) && /[!@#$%^&*()_+~]/.test(r.j.account.pw) && r.j.account.pw.length >= 8 && r.j.account.pw.length <= 20, "joined; the provider account is shown once " + JSON.stringify(r.j.account));
const PBPW = r.j.account.pw;
const joinReq = MOCK.pb.find(x => x.path === "/Join" && x.method === "POST");
ok(joinReq && joinReq.body.LinkID === PB_LINK_ID && joinReq.body.CorpNum === "1234567890" && joinReq.body.CEOName === "김하루" && joinReq.body.ContactTEL === "010-1111-2222", "join form sent as the provider expects");
ok(!JSON.stringify(DB.raw.prepare("SELECT v FROM mod_set WHERE ws=? AND mod='tx' AND k='ht'").get(WS)).includes(PBPW), "the provider password is not stored");
r = await call("tx/ht/join", { biz_id: BIZ, agree: true, form: FORM }, A); ok(r.j.already === true && r.j.account === null, "joining again only confirms");

/* ── ② 홈택스 부서사용자 ── */
r = await call("tx/ht/collect", { biz_id: BIZ }, A); ok(r.j.error === "not-ready", "cannot collect before the hometax login is registered");
r = await call("tx/ht/dept", { biz_id: BIZ, id: "haru01", pwd: "wrong" }, A);
ok(r.s === 502 && r.j.error === "provider" && r.j.detail.includes("부서사용자") && r.j.biz[BIZ].dept.ti === false, "wrong login → the provider's message is shown " + r.j.detail);
r = await call("tx/ht/dept", { biz_id: BIZ, id: "haru01", pwd: "" }, A); ok(r.j.error === "bad-request", "needs id and password");
r = await call("tx/ht/dept", { biz_id: BIZ, id: "haru01", pwd: "Dept!Pass#2026" }, S); ok(r.s === 403, "only the admin registers it");
const tok0 = MOCK.pbTokens;
r = await call("tx/ht/dept", { biz_id: BIZ, id: "haru01", pwd: "Dept!Pass#2026" }, A);
ok(r.s === 200 && r.j.biz[BIZ].dept.ti && r.j.biz[BIZ].dept.cb && r.j.biz[BIZ].dept.id === "haru01", "hometax read-only login registered for invoices and cash receipts");
ok(MOCK.pb.filter(x => x.path === "/HomeTax/Taxinvoice/DeptUser" && x.method === "POST").pop().body.pwd === "Dept!Pass#2026" && MOCK.pb.some(x => x.path === "/HomeTax/Cashbill/DeptUser/Check"), "sent to both services and checked");
const dump = DB.raw.prepare("SELECT GROUP_CONCAT(v) AS v FROM mod_set WHERE ws=?").get(WS).v + JSON.stringify(DB.raw.prepare("SELECT * FROM ht_job").all());
ok(!dump.includes("Dept!Pass#2026"), "the hometax password is never stored here");
ok(MOCK.pbTokens >= 1 && MOCK.pb.some(x => /\/POPBILL_TEST\/Token$/.test(x.path) && x.body.access_id === "1234567890" && x.body.scope.join() === "member,111") && MOCK.pb.some(x => /Token$/.test(x.path) && x.body.scope.join() === "member,141"), "tokens were issued — the request signature matched (test service, one scope each)");

/* ── ③ 가져오기 ── */
r = await call("tx/ht/collect", { biz_id: BIZ, from: kd(-400), to: kd(30) }, S);
ok(r.s === 200 && r.j.requested === 4 && r.j.to === kd(0) && r.j.from === kd(-92) && r.j.jobs.length === 4 && r.j.jobs.every(j => j.state === "req"), "staff starts a collection; period clamped to three months ending today " + r.j.from + "~" + r.j.to);
const reqs = MOCK.pb.filter(x => x.method === "POST" && /^\/HomeTax\/(Taxinvoice|Cashbill)\/(SELL|BUY)\?/.test(x.path)).map(x => x.path);
ok(reqs.length === 4 && reqs.some(p => p === `/HomeTax/Taxinvoice/SELL?DType=W&SDate=${kd(-92).replace(/-/g, "")}&EDate=${kd(0).replace(/-/g, "")}`) && reqs.some(p => p.startsWith("/HomeTax/Cashbill/BUY?SDate=")), "four jobs requested with the provider's parameters");
r = await call("tx/ht/collect", { biz_id: BIZ }, A); ok(r.s === 409 && r.j.error === "busy", "no second request while one is running");
r = await call("tx/ht/poll", { biz_id: BIZ }, A); ok(r.j.pending === 4 && r.j.added === 0, "first check: still collecting");
r = await call("tx/ht/poll", { biz_id: BIZ }, S);
ok(r.j.pending === 0 && r.j.added === 7 && r.j.skipped === 0 && r.j.jobs.filter(j => j.state === "done").length === 4 && r.j.biz[BIZ].last === kd(0) && r.j.biz[BIZ].lastAdded === 7, "second check: 7 documents added " + JSON.stringify({ a: r.j.added, s: r.j.skipped, w: r.j.warn }));
r = await call("tx/data", null, A);
const docs = r.j.docs.filter(d => d.source === "hometax-auto");
ok(r.j.keys.ht === true && docs.length === 7 && docs.every(d => d.biz_id === BIZ && d.status === "done"), "they are in the evidence ledger under that business");
const sale1 = docs.find(d => d.approve_no === "2026S0000000000000000001"), buy2 = docs.find(d => d.approve_no === "2026B0000000000000000002");
ok(sale1 && sale1.dir === "sale" && sale1.kind === "세금계산서" && sale1.partner === "모노가구" && sale1.partner_no === "2223344444" && sale1.supply === 1000000 && sale1.vat === 100000 && sale1.total === 1100000 && sale1.date === kd(-3) && sale1.item === "브랜드 로고 디자인", "sales invoice mapped (partner = buyer)");
ok(buy2 && buy2.dir === "buy" && buy2.kind === "계산서" && buy2.partner === "책방" && buy2.vat === 0 && buy2.total === 300000, "tax-free purchase invoice becomes 계산서 (partner = seller)");
const cbCancel = docs.find(d => d.memo === "취소거래"), cbSale = docs.find(d => d.kind === "현금영수증" && d.dir === "sale");
ok(cbCancel && cbCancel.kind === "현금영수증" && cbCancel.dir === "buy" && cbCancel.total === -11000 && cbCancel.vat === -1000 && cbCancel.partner === "문구나라", "cancelled cash receipt comes in as a negative amount");
ok(cbSale && cbSale.total === 55000 && cbSale.partner === "홍길동" && cbSale.item === "소득공제용", "cash receipt sale mapped");
// 다시 가져와도 겹치지 않습니다
DB.raw.exec("UPDATE ht_job SET at='2000-01-01T00:00:00.000Z' WHERE state='req'");
r = await call("tx/ht/collect", { biz_id: BIZ }, A); ok(r.j.requested === 4 && r.j.from === kd(-7), "next time it starts a week before the last run " + r.j.from);
await call("tx/ht/poll", { biz_id: BIZ }, A); r = await call("tx/ht/poll", { biz_id: BIZ }, A);
ok(r.j.added === 0 && r.j.skipped === 7 && r.j.biz[BIZ].lastAdded === 0, "same documents are skipped the second time");
r = await call("tx/doc/import", { biz_id: BIZ, rows: [{ dir: "sale", kind: "세금계산서", date: kd(-3), partner: "모노가구", partner_no: "2223344444", supply: 1000000, vat: 100000, total: 1100000, approve_no: "2026S0000000000000000001" }, { dir: "buy", kind: "카드", date: kd(-1), partner: "주유소", total: 50000, approve_no: "CARD1" }] }, A);
ok(r.j.added === 1 && r.j.skipped === 1, "a file upload of the same invoice is skipped too; new rows still go in");
// 손으로 지운 것은 다시 가져오면 돌아옵니다(대장에 없으므로) — 고친 것은 그대로
r = await call("tx/doc/save", { id: sale1.id, memo: "입금 확인함" }, A);
DB.raw.exec("UPDATE ht_job SET at='2000-01-01T00:00:00.000Z' WHERE state='req'");
await call("tx/ht/collect", { biz_id: BIZ }, A); await call("tx/ht/poll", { biz_id: BIZ }, A); await call("tx/ht/poll", { biz_id: BIZ }, A);
r = await call("tx/data", null, A); ok(r.j.docs.find(d => d.id === sale1.id).memo === "입금 확인함", "a document you edited is left alone");

/* ── 자동 수집 ── */
r = await call("tx/ht/auto", { biz_id: BIZ, on: true }, S); ok(r.s === 403, "only the admin switches automatic collection");
r = await call("tx/ht/auto", { biz_id: BIZ0, on: true }, A); ok(r.j.error === "no-bizno", "needs a registered business");
r = await call("tx/ht/auto", { biz_id: BIZ, on: true }, A); ok(r.j.biz[BIZ].auto === true && DB.raw.prepare("SELECT COUNT(*) AS n FROM ht_auto").get().n === 1, "automatic collection on → queued");
const tick = async () => { DB.raw.exec("UPDATE mw_meta SET v='00000000000000' WHERE k='tick'"); DB.raw.exec("UPDATE ht_auto SET next_at='2000-01-01T00:00:00.000Z'"); return call("tick"); };
DB.raw.exec(`DELETE FROM tx_doc WHERE ws='${WS}' AND source='hometax-auto' AND approve_no LIKE 'C%'`);   // 현금영수증 3건이 새로 올라온 것처럼
DB.raw.exec(`UPDATE mod_set SET v=json_set(v,'$.biz.${BIZ}.lastAt','2000-01-01T00:00:00.000Z') WHERE ws='${WS}' AND mod='tx' AND k='ht'`);
const jobsBefore = DB.raw.prepare("SELECT COUNT(*) AS n FROM ht_job").get().n;
r = await tick(); ok(r.j.ran && DB.raw.prepare("SELECT COUNT(*) AS n FROM ht_job WHERE auto=1 AND state='req'").get().n === 4 && DB.raw.prepare("SELECT COUNT(*) AS n FROM ht_job").get().n === jobsBefore + 4, "tick 1: requests today's collection " + JSON.stringify(r.j));
r = await tick(); ok(DB.raw.prepare("SELECT COUNT(*) AS n FROM ht_job WHERE state='req'").get().n === 4 && r.j.htAdded === 0, "tick 2: still collecting");
r = await tick(); ok(r.j.htAdded === 3 && DB.raw.prepare("SELECT COUNT(*) AS n FROM ht_job WHERE state='req'").get().n === 0, "tick 3: three new documents added " + JSON.stringify(r.j));
r = await call("nt/list", null, A); ok(r.j.items[0].title === "홈택스에서 새 증빙 3건을 가져왔습니다" && r.j.items[0].url === "#/tax/docs" && r.j.items[0].type === "money", "admin is told");
const nx = DB.raw.prepare("SELECT next_at FROM ht_auto").get().next_at;
ok(nx > new Date().toISOString() && Date.parse(nx) - Date.now() < 34 * 3600e3 && [21, 22].includes(new Date(nx).getUTCHours()), "next run is tomorrow morning (about 6:30–7:10 Korea time) " + nx);
r = await tick(); const n4 = DB.raw.prepare("SELECT COUNT(*) AS n FROM ht_job").get().n;
ok(n4 === jobsBefore + 4 && (r.j.htAdded === 0 || r.j.htAdded === undefined), "already collected today → nothing new is requested");
r = await call("ws/modules", { modules: [] }, A);
r = await tick(); ok(DB.raw.prepare("SELECT COUNT(*) AS n FROM ht_job").get().n === n4, "tax module off → no collection");
await call("ws/modules", { modules: ["tax"] }, A);

/* ── 끊기 · 백업 ── */
r = await call("backup", null, A); ok(!JSON.stringify(r.j).includes('"k":"ht"') && JSON.stringify(r.j).includes("hometax-auto"), "backup has the documents but not the connection state");
r = await call("tx/ht/disconnect", { biz_id: BIZ }, S); ok(r.s === 403, "only the admin disconnects");
r = await call("tx/ht/disconnect", { biz_id: BIZ }, A);
ok(r.j.biz[BIZ].dept.ti === false && r.j.biz[BIZ].dept.cb === false && r.j.biz[BIZ].auto === false && r.j.biz[BIZ].joined === true && DB.raw.prepare("SELECT COUNT(*) AS n FROM ht_auto").get().n === 0, "disconnected: login removed at the provider, automatic collection off");
ok(MOCK.pb.filter(x => x.method === "DELETE" && /DeptUser$/.test(x.path)).length === 2, "delete sent for both services");
r = await call("tx/ht/collect", { biz_id: BIZ }, A); ok(r.j.error === "not-ready", "cannot collect after disconnecting");
r = await call("tx/data", null, A); ok(r.j.docs.filter(d => d.source === "hometax-auto").length === 7, "collected documents stay");
// 사업자번호를 바꾸면 연결은 처음부터
await call("tx/biz/save", { id: BIZ, biz_no: "999-88-77777" }, A);
r = await call("tx/ht/collect", { biz_id: BIZ }, A); ok(r.j.error === "not-ready", "different registration number → start over");

/* ── 워크스페이스를 지우면 수집 서비스에 남긴 조회 아이디도 지웁니다 ── */
{
  await call("signup", { mode: "new", loginId: "other01", pw: "pw123456", name: "다른 대표", workspace: "다른 회사", contact: "010-0000-0000", agree: true });
  const ows = DB.raw.prepare("SELECT id FROM workspaces WHERE name='다른 회사'").get().id;
  await call("admin/ws", { id: ows, action: "approve" }, A);
  const B = (await call("login", { loginId: "other01", pw: "pw123456" })).j.token;
  await call("ws/modules", { modules: ["tax"] }, B);
  const ob = (await call("tx/biz/save", { name: "다른 회사", kind: "indiv", vat: "general", biz_no: "222-33-44444" }, B)).j.biz.id;
  r = await call("tx/ht/join", { biz_id: ob, agree: true, form: FORM }, B); ok(r.s === 200 && r.j.biz[ob].joined, "second workspace joins " + JSON.stringify(r.j).slice(0, 120));
  r = await call("tx/ht/dept", { biz_id: ob, id: "other01", pwd: "Dept!Pass#2026" }, B); ok(r.s === 200 && r.j.biz[ob].dept.ti && r.j.biz[ob].dept.cb, "and registers its lookup login");
  const before = MOCK.pb.filter(x => x.method === "DELETE" && /DeptUser$/.test(x.path) && x.corp === "2223344444").length;
  r = await call("admin/ws", { id: ows, action: "delete" }, A); ok(r.s === 200, "operator deletes the workspace");
  const after = MOCK.pb.filter(x => x.method === "DELETE" && /DeptUser$/.test(x.path) && x.corp === "2223344444").length;
  ok(before === 0 && after === 2, `the lookup login is removed at the provider too (${before} → ${after})`);
  ok(DB.raw.prepare("SELECT COUNT(*) AS n FROM mod_set WHERE ws=?").get(ows).n === 0 && DB.raw.prepare("SELECT COUNT(*) AS n FROM ht_job WHERE ws=?").get(ows).n === 0, "nothing about the connection is left here");
}
ok(maxQ < 50, `queries per request stay under 50 (max ${maxQ} at ${maxQPath})`);
console.log(`통과 ${pass} · 실패 ${failN} · 요청당 최대 쿼리 ${maxQ} (${maxQPath})`);
process.exit(failN ? 1 : 0);
