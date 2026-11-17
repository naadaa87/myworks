// 마이택스·마이피플 서버 시험 — node tests/taxpeople.test.mjs
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
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const A = (await call("owner-setup", { loginId: "boss01", pw: "pass1234", name: "대표", workspace: "하루상회" })).j.token;
let r = await call("tx/data", null, A); ok(r.s === 403 && r.j.error === "module-off", "tax off by default");
r = await call("ws/modules", { modules: ["tax", "people", "space"] }, A); ok(r.j.modules.includes("tax") && r.j.modules.includes("people"), "modules on " + JSON.stringify(r.j.modules));

/* ── 마이택스 ── */
r = await call("tx/data", null, A);
ok(r.s === 200 && Array.isArray(r.j.biz) && Array.isArray(r.j.docs) && r.j.keys && r.j.keys.nts === false && Array.isArray(r.j.recv), "tax data");
r = await call("tx/biz/save", { name: "하루상회 (개인)", kind: "indiv", vat: "general", biz_no: "123-45-67890", industry: "retail", region: "metro", links: { brands: ["하루"], stores: [], mods: ["commerce"], main: true } }, A);
const bz = r.j.biz; ok(bz && bz.biz_no === "1234567890" && bz.links.main === true && bz.links.mods[0] === "commerce", "biz save " + JSON.stringify(bz));
r = await call("tx/biz/save", { name: "하루공방", vat: "simple", industry: "food" }, A); const bz2 = r.j.biz; ok(bz2.vat === "simple", "biz2");
r = await call("tx/biz/save", { id: bz2.id, vat: "exempt", memo: "꽃 판매" }, A); ok(r.j.biz.vat === "exempt" && r.j.biz.memo === "꽃 판매", "biz update");
r = await call("tx/doc/save", { dir: "sale", kind: "세금계산서", date: today, partner: "가나상사", partner_no: "220-81-12345", supply: 1000000, vat: 100000, biz_id: bz.id, status: "plan", ref: "inv_1" }, A);
const d1 = r.j.doc; ok(d1.total === 1100000 && d1.status === "plan" && d1.partner_no === "2208112345", "doc save");
r = await call("tx/doc/save", { dir: "sale", date: today, supply: 10, vat: 1, ref: "inv_1" }, A); ok(r.s === 409, "doc ref dup");
r = await call("tx/doc/import", { biz_id: bz.id, rows: [
  { dir: "buy", kind: "세금계산서", date: today, partner: "다라물산", partner_no: "1112233333", supply: 200000, vat: 20000, approve_no: "20261117-41000000-00000001" },
  { dir: "buy", kind: "카드", date: today, partner: "문구점", supply: 9091, vat: 909, total: 10000 },
  { dir: "sale", kind: "현금영수증", date: today, total: 33000, supply: 30000, vat: 3000, approve_no: "C123" },
  { dir: "buy", kind: "세금계산서", date: "bad", supply: 1 }
] }, A);
ok(r.j.added === 3, "import 3 " + JSON.stringify(r.j));
r = await call("tx/doc/import", { rows: [{ dir: "buy", kind: "세금계산서", date: today, supply: 200000, vat: 20000, approve_no: "20261117-41000000-00000001" }, { dir: "buy", kind: "카드", date: today, partner: "문구점", supply: 9091, vat: 909, total: 10000 }] }, A);
ok(r.j.added === 0 && r.j.skipped === 2, "import dedupe " + JSON.stringify(r.j));
r = await call("tx/data", null, A); const docs = r.j.docs; ok(docs.length === 4, "docs 4");
r = await call("tx/doc/link", { pairs: [{ id: docs[0].id, fin_id: "f_1" }, { id: docs[1].id, fin_id: "f_2" }] }, A); ok(r.j.linked === 2, "link");
r = await call("tx/data", null, A); ok(r.j.docs.filter(d => d.fin_id).length === 2, "linked saved");
r = await call("tx/kpi/save", { name: "월 매출", metric: "rev", period: "month", target: 30000000, unit: "원" }, A); const k1 = r.j.kpi; ok(k1 && k1.target === 30000000, "kpi");
r = await call("tx/kpi/save", { name: "신규 고객", metric: "manual", period: "month", target: 20, unit: "명" }, A); const k2 = r.j.kpi;
r = await call("tx/kval/save", { kpi_id: k2.id, period: today.slice(0, 7), value: 12, memo: "인스타 유입" }, A); ok(r.j.kval.value === 12, "kval");
r = await call("tx/kval/save", { kpi_id: k2.id, period: "2026-13x", value: 1 }, A); ok(r.s === 400, "kval bad period");
r = await call("tx/kval/save", { kpi_id: k2.id, period: today.slice(0, 4) + "-Q4", value: 30, target: 60 }, A); ok(r.j.kval.target === 60, "kval quarter");
r = await call("tx/settings", { set: { struct: { groups: [{ id: "rev", name: "매출", type: "rev" }, { id: "cogs", name: "매출원가", type: "cogs" }], map: { "매출": "rev", "자재·비품": "cogs" } }, cash: { open: 5000000, asof: today, fixed: [{ name: "임대료", amount: 1500000, day: 25 }] }, me: { deps: 2, yellow: 300000 } } }, A);
ok(r.j.settings.struct.groups.length === 2 && r.j.settings.cash.fixed[0].amount === 1500000 && r.j.settings.me.deps === 2, "tax settings");
r = await call("tx/settings", { set: { done: ["vat-2026-07-25"] } }, A); ok(r.j.settings.done[0] === "vat-2026-07-25" && r.j.settings.cash.open === 5000000, "settings merge");
r = await call("tx/grant/save", { title: "2026 소상공인 디지털 전환 지원", org: "중기부", url: "https://www.bizinfo.go.kr/x", deadline: today, ext_id: "PB1" }, A); const g1 = r.j.grant; ok(g1 && g1.status === "watch", "grant");
r = await call("tx/grant/save", { title: "중복", ext_id: "PB1" }, A); ok(r.s === 409, "grant dup");
r = await call("tx/grant/save", { id: g1.id, status: "applied", url: "javascript:alert(1)" }, A); ok(r.j.grant.status === "applied" && r.j.grant.url === "", "grant update + url guard");
r = await call("tx/bizcheck", { nos: ["2208112345"] }, A); ok(r.s === 400 && r.j.error === "no-key", "bizcheck needs key");
r = await call("tx/feed", {}, A); ok(r.s === 400 && r.j.error === "no-key", "feed needs key");
r = await call("tx/biz/del", { id: bz2.id }, A); ok(r.s === 200, "biz del");

/* ── 마이피플 ── */
await call("member/create", { loginId: "alba01", pw: "pw123456", name: "김알바", role: "worker" }, A);
await call("member/create", { loginId: "mgr001", pw: "pw123456", name: "박매니저", role: "staff" }, A);
const W = (await call("login", { loginId: "alba01", pw: "pw123456" })).j.token;
const S = (await call("login", { loginId: "mgr001", pw: "pw123456" })).j.token;
const st0 = (await call("state", null, A)).j;
const mlist = Object.values(st0.entities || {}).flat().filter(x => x && typeof x === "object");
const alba = mlist.find(m => m.loginId === "alba01") || mlist.flatMap(x => Object.values(x)).find(m => m && m.loginId === "alba01");
const albaId = alba && alba.id;
if (!albaId) console.log(JSON.stringify(st0.entities).slice(0, 400));
ok(!!albaId, "alba member id");
r = await call("pp/data", null, A); ok(r.s === 200 && r.j.admin === true && Array.isArray(r.j.pays), "pp data admin");
r = await call("pp/staff/save", { name: "김알바", member_id: albaId, kind: "part", pay_type: "hour", rate: 10320, ins: "none", week_hours: 20, days: [1, 3, 5], birth: "2001-03-04", docs: { contract: today, health: "2027-01-10" } }, A);
const sf = r.j.staff; ok(sf && sf.rate === 10320 && sf.days.length === 3 && sf.docs.contract === today && sf.birth === "2001-03-04", "staff save " + JSON.stringify(sf).slice(0, 200));
r = await call("pp/staff/save", { name: "이직원", kind: "full", pay_type: "month", rate: 2600000, ins: "four", tax_m: 41000, meal: 200000 }, A); const sf2 = r.j.staff;
r = await call("pp/data", null, S); ok(r.s === 200 && r.j.admin === false && !("pays" in r.j) && r.j.staff.every(s => !("rate" in s) && !("birth" in s)), "staff role no pay info");
r = await call("pp/staff/save", { id: sf2.id, rate: 9999999 }, S); ok(r.s === 200, "staff role edit");
r = await call("pp/data", null, A); ok(r.j.staff.find(s => s.id === sf2.id).rate === 2600000, "staff role cannot change rate");
// 근무표
const mon = (() => { const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); })();
const add = (ds, n) => { const d = new Date(ds + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
r = await call("pp/shift/save", { rows: [{ staff_id: sf.id, date: mon, t_start: "09:00", t_end: "15:00", brk: 30 }, { staff_id: sf.id, date: add(mon, 2), t_start: "18:00", t_end: "24:00" }, { staff_id: sf.id, date: "x" }] }, A);
ok(r.j.shifts.length === 2 && r.j.shifts[1].t_end === "24:00", "shift save");
r = await call("pp/shift/copy", { from: mon, to: add(mon, 7) }, A); ok(r.j.added === 2, "shift copy");
r = await call("pp/shift/copy", { from: mon, to: add(mon, 7) }, A); ok(r.j.added === 0, "shift copy idempotent");
// 근무자 — 내 근무, 출퇴근
r = await call("pp/data", null, W); ok(r.s === 403, "worker no pp data");
r = await call("pp/staff/save", { name: "x" }, W); ok(r.s === 403, "worker no staff save");
r = await call("pp/me", null, W); ok(r.s === 200 && r.j.staff.length === 1 && r.j.staff[0].rate === 10320 && r.j.shifts.length >= 2 && !("memo" in r.j.staff[0]), "worker me");
r = await call("pp/clock", { act: "out" }, W); ok(r.s === 409 && r.j.error === "not-in", "out before in");
r = await call("pp/clock", { act: "in", lat: 37.55, lng: 126.92 }, W); ok(r.s === 200 && r.j.att.in_at && r.j.att.lat === 37.55, "clock in");
r = await call("pp/clock", { act: "in" }, W); ok(r.s === 409, "double in");
r = await call("pp/clock", { act: "out", brk: 30 }, W); ok(r.s === 200 && r.j.att.out_at && r.j.att.brk === 30, "clock out");
r = await call("pp/me", null, A); ok(r.s === 200 && r.j.staff.length === 0, "admin without staff profile");
// 관리자 출퇴근 수정·추가
r = await call("pp/att/save", { staff_id: sf.id, in_at: mon + "T00:00:00.000Z", out_at: mon + "T06:00:00.000Z", brk: 30 }, A); const at1 = r.j.att; ok(at1 && at1.src === "mgr" && at1.date === mon, "att add (KST date)");
r = await call("pp/att/save", { id: at1.id, in_at: mon + "T01:00:00.000Z", out_at: mon + "T00:30:00.000Z" }, A); ok(r.s === 400, "att bad time");
r = await call("pp/att/save", { id: at1.id, out_at: mon + "T07:00:00.000Z" }, S); ok(r.s === 200 && r.j.att.edited_by === "박매니저", "staff edits att");
// 건당
r = await call("pp/job/save", { staff_id: sf.id, date: today, qty: 3, rate: 15000 }, A); ok(r.j.job.qty === 3 && r.j.job.rate === 15000, "job");
// 급여
const per = today.slice(0, 7);
r = await call("pp/pay/save", { staff_id: sf.id, period: per, pfrom: per + "-01", pto: today, items: [{ k: "base", label: "기본급", basis: "20시간 × 10,320원", amount: 206400 }, { k: "wk", label: "주휴수당", basis: "4시간 × 10,320원", amount: 41280 }], deds: [{ k: "it", label: "소득세", amount: 0 }], employer: 0, pay_date: today }, A);
const py = r.j.pay; ok(py.gross === 247680 && py.net === 247680 && py.status === "draft", "pay save");
r = await call("pp/pay/save", { staff_id: sf.id, period: per, items: [{ k: "base", label: "기본급", amount: 200000 }], deds: [{ k: "bt", label: "소득세(3%)", amount: 6000 }, { k: "bl", label: "지방소득세", amount: 600 }] }, A);
ok(r.j.pay.id === py.id && r.j.pay.net === 193400, "pay upsert same period");
r = await call("link/create", { kind: "payslip", target: py.id }, A); ok(r.s === 404, "draft payslip no link");
r = await call("pp/pay/status", { id: py.id, status: "confirmed" }, A); ok(r.j.pay.status === "confirmed", "confirm");
r = await call("pp/me", null, W); ok(r.j.pays.length === 1 && r.j.pays[0].net === 193400 && !("employer" in r.j.pays[0]), "worker sees own payslip");
r = await call("link/create", { kind: "payslip", target: py.id }, S); ok(r.s === 404, "staff cannot make payslip link");
r = await call("link/create", { kind: "payslip", target: py.id }, A); const tok = r.j.token; ok(!!tok, "payslip link");
r = await call("link/get?t=" + tok); ok(r.j.view.kind === "payslip" && r.j.view.client === "김알바" && r.j.view.pay.net === 193400 && r.j.view.pay.birth === "2001-03-04" && r.j.view.status === "pending", "payslip view");
r = await call("link/act", { t: tok, action: "change", note: "주휴수당이 빠졌어요", by: "김알바" }); ok(r.j.status === "changed", "payslip question");
r = await call("pp/data", null, A); ok(r.j.acks.find(a => a.id === py.id && a.result === "changed" && /주휴/.test(a.note)), "ack visible");
r = await call("pp/pay/status", { id: py.id, status: "paid", fin_id: "f_pay1" }, A); ok(r.j.pay.status === "paid" && r.j.pay.paid_at && r.j.pay.fin_id === "f_pay1", "paid");
r = await call("pp/pay/save", { staff_id: sf.id, period: per, items: [{ label: "x", amount: 1 }] }, A); ok(r.s === 409, "paid locked");
r = await call("pp/pay/del", { id: py.id }, A); ok(r.s === 409, "paid not deletable");
r = await call("pp/staff/del", { id: sf.id }, A); ok(r.s === 409, "staff with records not deletable");
r = await call("pp/staff/save", { id: sf.id, status: "end", end_date: today }, A); ok(r.j.staff.status === "end", "staff end");
r = await call("pp/clock", { act: "in" }, W); ok(r.s === 404, "ended staff cannot clock");
// 마이택스가 급여를 봅니다
r = await call("tx/data", null, A); ok(r.j.pay.length === 1 && r.j.pay[0].wh === 6600 && r.j.staffN === 1, "tax sees payroll " + JSON.stringify(r.j.pay));
// 위치·설정
r = await call("pp/settings", { set: { five: true, rates: { np: 4.75 } } }, S); ok(r.s === 403, "staff cannot change pay settings");
r = await call("pp/settings", { set: { five: true, payday: 5 } }, A); ok(r.j.settings.five === true && r.j.settings.payday === 5 && r.j.settings.rates.np === 4.75, "pp settings");
// 명함
r = await call("pp/card/save", { contact_id: "ct_x", img: "data:image/jpeg;base64,AAAA" }, A); ok(r.s === 404, "card needs contact");
await call("push", { ops: [{ kind: "contact", id: "ct_1", data: { id: "ct_1", name: "최파트너", company: "공간디자인", kind: "외주" } }] }, A);
r = await call("pp/card/save", { contact_id: "ct_1", img: "data:image/jpeg;base64,AAAA" }, A); ok(r.s === 200, "card save");
r = await call("pp/card/save", { contact_id: "ct_1", img: "javascript:x" }, A); ok(r.s === 400, "card bad");
r = await call("pp/partner", { id: "ct_1" }, A); ok(r.j.img === "data:image/jpeg;base64,AAAA" && Array.isArray(r.j.jobs), "partner card");
r = await call("pp/partner", { id: "ct_1" }, W); ok(r.s === 403, "worker no partner");
console.log(`통과 ${pass} · 실패 ${failN}`);
process.exit(failN ? 1 : 0);
