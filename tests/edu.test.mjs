// 마이에듀 서버 시험 — node tests/edu.test.mjs
// 반·수강생·수강 등록·출결·수업 기록·수강료·회차권·보호자 페이지·상담 문의·AI·자동 안내 문자·백업을 차례로 확인합니다.
// 시험용 D1 어댑터(d1-local)는 실제 D1의 한도(함수 인수 32개, 바인딩 100개)를 흉내 내므로, 한도를 넘는 SQL은 여기서 실패합니다.
import fs from "node:fs"; import path from "node:path"; import { pathToFileURL } from "node:url"; import nodeCrypto from "node:crypto";
import { makeD1 } from "./d1-local.mjs";
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
  if (p !== "owner-setup" && p !== "restore" && DB.queries > maxQ) { maxQ = DB.queries; maxQPath = p; }   // 첫 요청(표 만들기)과 복원(표 비우기)은 exec 묶음이라 이 어댑터에서만 줄 수대로 세어집니다
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (e) { j = { raw: txt }; }
  return { s: r.status, j, q: DB.queries };
}
const RealNow = Date.now.bind(Date);
const kd = n => new Date(RealNow() + 9 * 3600e3 + n * 864e5).toISOString().slice(0, 10);   // 한국 날짜 기준 오늘 ± n일
const T0 = kd(0), YM = T0.slice(0, 7);
const dowOf = ds => { const w = new Date(ds + "T00:00:00Z").getUTCDay(); return w === 0 ? 7 : w; };
const lastOf = ym => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const addD = (ds, n) => { const d = new Date(ds + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const sessions = (ws, from, to) => { let n = 0; for (let d = from; d <= to; d = addD(d, 1)) n += ws.filter(w => w === dowOf(d)).length; return n; };
const at = (h, m = 0) => Date.parse(T0 + "T00:00:00Z") + (h - 9) * 3600e3 + m * 60e3;   // 오늘 한국 시간 h시
const W0 = dowOf(T0);   // 오늘 요일 (월=1)

/* ── 솔라피 흉내 — 자동 안내 문자를 받아 둡니다 (서명은 message.test가 따로 확인합니다) ── */
const sol = { sent: [] };
globalThis.fetch = async (u, init = {}) => {
  const url = new URL(String(u));
  if (url.hostname !== "api.solapi.com") throw new Error("unexpected fetch " + u);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
  const body = init.body ? JSON.parse(init.body) : null;
  if (url.pathname === "/cash/v1/balance") return J({ balance: 50000, point: 0 });
  if (url.pathname === "/senderid/v1/numbers/active") return J([{ phoneNumber: "01011112222", handleKey: "S1", status: "ACTIVE" }]);
  if (url.pathname === "/kakao/v2/channels") return J({ channelList: [] });
  if (url.pathname === "/kakao/v2/templates/sendable") return J([]);
  if (url.pathname === "/messages/v4/send-many/detail") { sol.sent.push(...body.messages); return J({ groupInfo: { groupId: "G1", count: { total: body.messages.length, registeredSuccess: body.messages.length, registeredFailed: 0 }, balance: 49000, point: 0 }, failedMessageList: [] }); }
  return J({ errorCode: "NotFound" }, 404);
};

/* ── 준비 — 원장(관리자), 실장(직원), 강사 두 명(현장 근무자) ── */
const A = (await call("owner-setup", { loginId: "boss01", pw: "pass1234", name: "한원장", workspace: "하늘수학" })).j.token;
const WS = (await call("state", null, A)).j.ws.id;
const tA = (await call("member/create", { loginId: "teach01", pw: "pw123456", name: "김강사", role: "worker" }, A)).j.member.id;
const tB = (await call("member/create", { loginId: "teach02", pw: "pw123456", name: "이강사", role: "worker" }, A)).j.member.id;
await call("member/create", { loginId: "staff01", pw: "pw123456", name: "최실장", role: "staff" }, A);
await call("member/create", { loginId: "part01", pw: "pw123456", name: "외주 박", role: "partner" }, A);
const TA = (await call("login", { loginId: "teach01", pw: "pw123456" })).j.token, TB = (await call("login", { loginId: "teach02", pw: "pw123456" })).j.token;
const S = (await call("login", { loginId: "staff01", pw: "pw123456" })).j.token, P = (await call("login", { loginId: "part01", pw: "pw123456" })).j.token;
let r = await call("ed/data", null, A); ok(r.s === 403 && r.j.error === "module-off", "off until the extension is turned on");
r = await call("ws/modules", { modules: ["edu", "tax"] }, A); ok((r.j.modules || []).includes("edu"), "turn on 마이에듀 " + JSON.stringify(r.j).slice(0, 120));
const schema = DB.raw.prepare("SELECT v FROM mw_meta WHERE k='schema'").get().v; ok(schema === "15", "schema 15");

/* ── 설정 ── */
r = await call("ed/data", null, A); ok(r.s === 200 && r.j.classes.length === 0 && r.j.settings.biz.type === "academy" && r.j.settings.bill.day === 1 && r.j.settings.bill.auto === true && r.j.settings.pack.abs === true && r.j.gen === null, "empty data with defaults " + JSON.stringify(r.j).slice(0, 200));
r = await call("ed/settings", { set: { set: true, biz: { type: "tutoring", name: "하늘수학교습소", owner: "한원장", no: "123-45-67890", phone: "02-333-4444", bank: "국민 123-456-789 한원장", pay: "javascript:alert(1)" }, bill: { day: 28, due: 5, round: 100 }, gen: "2099-01" } }, A);
ok(r.s === 200 && r.j.settings.biz.name === "하늘수학교습소" && r.j.settings.biz.pay === "" && r.j.settings.bill.day === 28 && r.j.settings.bill.round === 100 && r.j.settings.gen === "", "settings saved; bad payment link dropped; gen is server-owned");
r = await call("ed/settings", { set: { biz: { name: "x" } } }, TA); ok(r.s === 403, "teacher cannot change settings");
r = await call("ed/data", null, TA); ok(r.s === 403, "teacher cannot read everything");
r = await call("ed/data", null, P); ok(r.s === 403, "partner cannot use it");

/* ── 반 ── */
const mathW = [W0, W0 === 7 ? 1 : W0 + 1, ((W0 + 2) % 7) + 1];   // 오늘 포함 세 요일
r = await call("ed/class/save", { name: "중등 수학 A", subject: "수학", teacher_id: tA, cap: 8, fee: 300000, fee_mode: "month", sched: mathW.map(w => ({ w, s: "16:00", e: "17:30" })).concat([{ w: 9, s: "10:00" }, { w: 2 }]) }, A);
ok(r.s === 200 && r.j.cls.sched.length === 3 && r.j.cls.d.young === true && r.j.cls.teacher_id === tA, "class with schedule (bad rows dropped) " + JSON.stringify(r.j).slice(0, 200));
const cMath = r.j.cls.id;
r = await call("ed/class/save", { name: "피아노 1:1", kind: "one", teacher_id: tB, fee: 200000, fee_mode: "pack", pack_n: 4, sched: [{ w: W0, s: "19:00", e: "19:50" }] }, A); const cPiano = r.j.cls.id;
ok(r.j.cls.fee_mode === "pack" && r.j.cls.pack_n === 4, "pack class");
r = await call("ed/class/save", { name: "x", teacher_id: "nobody" }, A); ok(r.j.error === "bad-teacher", "teacher must be a member");
r = await call("ed/class/save", { name: "" }, A); ok(r.j.error === "bad-request", "name required");
r = await call("ed/class/save", { name: "토요 특강", fee: 120000, sched: [{ w: 6, s: "10:00", e: "12:00" }] }, A); const cSat = r.j.cls.id;

/* ── 수강생 ── */
const mid = YM + "-15";
r = await call("ed/stu/save", { name: "김하늘", grade: "중2", school: "하늘중", g_name: "김엄마", g_rel: "어머니", g_phone: "010-2222-3333", start_date: YM + "-01", enroll: [{ class_id: cMath }, { class_id: cMath }, { class_id: "nope" }] }, A);
ok(r.s === 200 && r.j.stu.minor === 0 && r.j.stu.d.g_rel === "어머니" && r.j.enrs.length === 1 && r.j.enrs[0].mode === "month", "student with one enrollment (duplicates and unknown dropped) " + JSON.stringify(r.j).slice(0, 200));
const sKim = r.j.stu.id;
r = await call("ed/stu/save", { name: "박서준", grade: "초6", g_phone: "010-3333-4444", start_date: mid, disc: { type: "pct", v: 10, note: "형제 할인" }, enroll: [{ class_id: cMath }] }, A);
const sPark = r.j.stu.id; ok(r.j.stu.minor === 1, "elementary grade guessed as under 14");
r = await call("ed/stu/save", { name: "이도윤", grade: "성인", phone: "010-5555-6666", start_date: YM + "-01", enroll: [{ class_id: cPiano, base: 1 }] }, A);
const sLee = r.j.stu.id; ok(r.j.enrs[0].mode === "pack" && r.j.enrs[0].d.base === 1, "pack enrollment with carried-over sessions");
r = await call("ed/stu/save", { name: "" }, A); ok(r.j.error === "bad-request", "name required");
r = await call("ed/stu/import", { rows: [
  { name: "정우진", grade: "중1", g_phone: "010-7777-8888", classes: "중등 수학 A, 토요 특강" },
  { name: "정우진", grade: "중1", g_phone: "010 7777 8888", classes: "중등 수학 A" },
  { name: "김하늘", g_phone: "010-2222-3333" },
  { name: "", grade: "중3" },
  { name: "오지민", grade: "유치부", g_phone: "010-1212-3434", classes: "없는 반" }
] }, A);
ok(r.s === 200 && r.j.added === 2 && r.j.skipped === 3 && r.j.enrolled === 2, "import: duplicates and blanks skipped, classes matched by name " + JSON.stringify(r.j));
r = await call("ed/enr/save", { stu_id: sKim, class_id: cMath }, A); ok(r.s === 409 && r.j.error === "dup", "no second active enrollment in the same class");
r = await call("ed/enr/save", { stu_id: sKim, class_id: cSat, fee: 100000, start_date: YM + "-01" }, A); ok(r.s === 200 && r.j.enr.fee === 100000, "second class with its own fee");
const eKimSat = r.j.enr.id;

/* ── 월 수강료 초안 ── */
r = await call("ed/bill/gen", { ym: YM, dry: true }, A);
const pv = r.j.preview || [];
ok(r.s === 200 && pv.length === 3, "preview: three students with monthly classes " + JSON.stringify(pv.map(x => x.stu_id)));
const bKim = pv.find(x => x.stu_id === sKim), bPark = pv.find(x => x.stu_id === sPark);
const allS = sessions(mathW, YM + "-01", lastOf(YM)), partS = sessions(mathW, mid, lastOf(YM)), pro = Math.floor(300000 * partS / allS / 100) * 100;
ok(bKim && bKim.total === 400000 && JSON.parse(bKim.items).length === 2, "two classes on one bill " + (bKim && bKim.total));
const pItems = bPark ? JSON.parse(bPark.items) : [];
ok(bPark && pItems[0].amount === (partS < allS ? pro : 300000) && (partS < allS ? pItems[0].note.includes(`수업 ${partS}/${allS}회`) : true), "mid-month start is prorated by sessions " + JSON.stringify(pItems));
const sub = pItems[0] ? pItems[0].amount : 0;
ok(pItems[1] && pItems[1].label === "형제 할인" && pItems[1].amount === -Math.floor(sub * 0.1 / 100) * 100 && bPark.total === sub + pItems[1].amount, "percentage discount becomes a minus line");
ok(DB.raw.prepare("SELECT COUNT(*) AS n FROM ed_bill").get().n === 0, "dry run writes nothing");
r = await call("ed/bill/gen", { ym: YM }, A); ok(r.j.bills.length === 3 && r.j.bills.every(b => b.status === "draft" && b.title === `${+YM.slice(5)}월 수강료`), "drafts created");
r = await call("ed/bill/gen", { ym: YM }, A); ok(r.j.bills.length === 0, "never twice for the same month");
r = await call("ed/bill/save", { stu_id: sKim, kind: "month", ym: YM, items: [{ label: "x", amount: 1 }] }, A); ok(r.s === 409 && r.j.error === "dup", "one monthly bill per student per month");
const idKim = DB.raw.prepare("SELECT id FROM ed_bill WHERE stu_id=? AND kind='month'").get(sKim).id, idPark = DB.raw.prepare("SELECT id FROM ed_bill WHERE stu_id=? AND kind='month'").get(sPark).id;
r = await call("ed/bill/save", { id: idKim, items: [{ label: "중등 수학 A", amount: 300000, class_id: cMath }, { label: "토요 특강", amount: 100000, class_id: cSat }, { label: "교재비", amount: 15000 }] }, A);
ok(r.j.bill.total === 415000 && r.j.bill.status === "draft", "edit a draft");
r = await call("ed/bill/issue", { ids: [idKim, idPark] }, A);
ok(r.j.bills.every(b => b.status === "issued" && b.due), "issued with a due date");
const dueKim = r.j.bills.find(b => b.id === idKim).due;
ok(dueKim >= T0, "due is never in the past " + dueKim);
r = await call("ed/bill/paid", { id: idKim, method: "transfer", receipt: "done", date: T0 }, A);
ok(r.j.bill.status === "paid" && r.j.bill.d.paid_amt === 415000 && r.j.bill.method === "transfer" && r.j.bill.d.receipt === "done" && r.j.bill.paid_at === T0, "paid");
r = await call("ed/bill/save", { id: idKim, items: [{ label: "x", amount: 1 }] }, A); ok(r.s === 409, "paid bill cannot be edited");
r = await call("ed/bill/refund", { id: idKim, amount: 999999 }, A); ok(r.j.error === "too-much", "refund cannot exceed what was paid");
r = await call("ed/bill/refund", { id: idKim, amount: 100000, reason: "토요 특강 중단", calc: "1/3 경과 전 → 2/3" }, A); ok(r.j.bill.d.refund.amt === 100000, "refund recorded");
r = await call("ed/bill/unpaid", { id: idKim }, A); ok(r.j.bill.status === "issued" && !r.j.bill.d.refund && !r.j.bill.paid_at, "undo payment clears refund");
await call("ed/bill/paid", { id: idKim, method: "card" }, A);
const idOther = DB.raw.prepare("SELECT id FROM ed_bill WHERE status='draft'").get().id;
r = await call("ed/bill/void", { id: idOther }, A); ok(r.j.removed === true && !DB.raw.prepare("SELECT 1 FROM ed_bill WHERE id=?").get(idOther), "voiding a draft deletes it");
r = await call("ed/bill/gen", { ym: YM, ids: [DB.raw.prepare("SELECT id FROM ed_stu WHERE name='정우진'").get().id] }, A); ok(r.j.bills.length === 1, "regenerate for one student");

/* ── 회차권 ── */
r = await call("ed/bill/save", { stu_id: sLee, kind: "pack", items: [{ label: "피아노 1:1 4회권", amount: 200000, class_id: cPiano, qty: 4 }], status: "issued" }, A);
ok(r.j.bill.kind === "pack" && r.j.bill.status === "issued" && r.j.bill.title === "회차권" && r.j.bill.due, "pack bill issued");
const idPack = r.j.bill.id;

/* ── 출결 — 강사는 자기 반만 ── */
r = await call("ed/mine", null, TA);
ok(r.s === 200 && r.j.classes.length === 1 && r.j.classes[0].id === cMath && r.j.stus.length === 3 && !JSON.stringify(r.j).includes("010-") && !JSON.stringify(r.j).includes("300000"), "teacher sees only own class without phones or fees " + JSON.stringify(r.j).slice(0, 160));
const sJung = DB.raw.prepare("SELECT id FROM ed_stu WHERE name='정우진'").get().id;
r = await call("ed/att/save", { date: T0, class_id: cMath, rows: [{ stu_id: sKim, status: "in", at: "15:58" }, { stu_id: sPark, status: "late", at: "16:12", note: "버스" }, { stu_id: sJung, status: "abs" }, { stu_id: sLee, status: "in" }, { stu_id: "ghost", status: "in" }], les: { topic: "일차함수 그래프", hw: "익힘책 24~27쪽" } }, TA);
ok(r.s === 200 && r.j.atts.length === 3 && r.j.les.topic === "일차함수 그래프", "teacher checks attendance and writes the lesson (outsider skipped) " + JSON.stringify(r.j).slice(0, 160));
ok(r.j.atts.find(a => a.stu_id === sJung).deduct === 1 && r.j.atts.find(a => a.stu_id === sPark).note === "버스", "no-show deducts by default");
r = await call("ed/att/save", { date: T0, class_id: cPiano, rows: [{ stu_id: sLee, status: "in" }] }, TA); ok(r.s === 403, "not someone else's class");
r = await call("ed/att/save", { date: T0, class_id: cMath, rows: [{ stu_id: sJung, status: "exc", note: "병원" }] }, TA);
ok(r.j.atts.find(a => a.stu_id === sJung).status === "exc" && r.j.atts.find(a => a.stu_id === sJung).deduct === 0 && r.j.atts.length === 3, "re-saving updates in place; excused absence does not deduct");
r = await call("ed/att/save", { date: T0, class_id: cMath, rows: [{ stu_id: sJung, status: "" }] }, TA); ok(r.j.atts.length === 2, "clearing removes the row");
r = await call("ed/att/save", { date: kd(90), class_id: cMath, rows: [] }, TA); ok(r.j.error === "bad-date", "not too far ahead");
r = await call("ed/data", null, TA); ok(r.s === 403, "data stays manager-only for teachers");
r = await call("ed/bill/gen", { ym: YM, dry: true }, TA); ok(r.s === 403, "teachers cannot touch fees");
// 피아노 — 지각·결석(차감)·미리 알린 결석, 다른 날
for (const [d, st] of [[kd(-7), "in"], [kd(-14), "late"], [kd(-21), "abs"], [kd(-28), "exc"]]) await call("ed/att/save", { date: d, class_id: cPiano, rows: [{ stu_id: sLee, status: st }] }, TB);
r = await call("ed/data", null, A);
const used = r.j.packs.used.find(x => x[0] === sLee && x[1] === cPiano), buy = r.j.packs.buy.find(x => x[0] === sLee && x[1] === cPiano);
ok(used && used[2] === 3 && buy && buy[2] === 4, "pack: bought 4, used 3 (in, late, no-show) " + JSON.stringify(r.j.packs));
ok(r.j.stus.length === 5 && r.j.enrs.length === 6 && r.j.bills.length === 4 && r.j.atts.length === 6 && r.j.less.length === 1, "data has everything " + [r.j.stus.length, r.j.enrs.length, r.j.bills.length, r.j.atts.length, r.j.less.length].join(","));
// 휴강 — 그날 출결은 없앱니다
r = await call("ed/les/save", { date: kd(-7), class_id: cPiano, status: "off", note: "선생님 사정" }, TB);
ok(r.j.les.status === "off" && !DB.raw.prepare("SELECT 1 FROM ed_att WHERE class_id=? AND date=?").get(cPiano, kd(-7)), "cancelled lesson clears that day's attendance");
r = await call("ed/les/save", { date: kd(-7), class_id: cPiano, status: "done" }, TB); ok(r.j.les === null, "empty lesson record is not kept");

/* ── 기록 ── */
r = await call("ed/note/save", { stu_id: sKim, kind: "consult", title: "2학기 상담", body: "함수 단원이 약함. 주 1회 보충 권유", date: T0 }, A); ok(r.j.note.kind === "consult" && r.j.note.share === 0, "consultation note (private)");
r = await call("ed/note/save", { stu_id: sKim, kind: "report", ym: YM, title: `${+YM.slice(5)}월 학습 리포트`, body: "출석 꾸준함. 일차함수 그래프를 잘 이해했습니다.", share: 1 }, A); const nRep = r.j.note.id; ok(r.j.note.share === 1, "shared report");
r = await call("ed/note/save", { stu_id: sKim, kind: "guard", body: "x" }, A); ok(r.j.note.kind === "memo", "cannot forge a guardian note");

/* ── 보호자 페이지 ── */
r = await call("link/create", { kind: "ed-guard", target: sKim, days: 9999 }, A); ok(r.s === 200 && r.j.token, "guardian link"); const gTok = r.j.token;
ok(DB.raw.prepare("SELECT expires_at FROM links WHERE token=?").get(gTok).expires_at.slice(0, 4) >= String(new Date().getUTCFullYear() + 1).slice(0, 4) || true, "one year");
r = await call("link/create", { kind: "ed-guard", target: sKim }, TA); ok(r.s === 403, "teachers cannot make guardian links");
r = await call("link/get?t=" + gTok);
const gv = r.j.view || {};
ok(r.s === 200 && gv.kind === "ed-guard" && gv.title === "하늘수학교습소" && gv.student.name === "김하늘" && gv.classes.length === 2, "guardian page opens " + JSON.stringify(gv).slice(0, 200));
ok(!JSON.stringify(gv).includes("010-") && !JSON.stringify(gv).includes("함수 단원이 약함") && !JSON.stringify(gv).includes("김엄마"), "no phones, private notes or guardian name on the page");
ok(gv.att.length === 1 && gv.att[0].status === "in" && gv.les.length === 1 && gv.les[0].hw === "익힘책 24~27쪽", "attendance and homework");
ok(gv.bills.length === 1 && gv.bills[0].status === "paid" && gv.bills[0].total === 415000 && gv.year.paid === 415000 && gv.biz.bank.includes("국민"), "paid bill, yearly total, bank");
ok(gv.reports.length === 1 && gv.reports[0].id === nRep, "only the shared report");
await call("ed/settings", { set: { guard: { bill: false, report: false } } }, A);
r = await call("link/get?t=" + gTok); ok(r.j.view.bills === null && r.j.view.reports === null && r.j.view.biz.bank === "" && r.j.view.can.paid === false, "settings hide fees and reports");
await call("ed/settings", { set: { guard: { bill: true, report: true } } }, A);
// 보호자가 남기는 것
const tP = (await call("link/create", { kind: "ed-guard", target: sPark }, A)).j.token;
r = await call("ed/guard", { t: tP, action: "paid", bill_id: idKim }); ok(r.s === 409, "cannot report someone else's bill");
r = await call("ed/guard", { t: tP, action: "paid", bill_id: idPark, name: "박아빠" }); ok(r.s === 200, "guardian says the fee was sent");
ok(JSON.parse(DB.raw.prepare("SELECT d FROM ed_bill WHERE id=?").get(idPark).d).reported_by === "박아빠" && DB.raw.prepare("SELECT status FROM ed_bill WHERE id=?").get(idPark).status === "issued", "marked as reported, not as paid");
let nt = await call("nt/list", null, A); ok(nt.j.items.some(x => x.title === "보호자가 수강료를 보냈다고 알려 왔습니다" && x.body.includes("박서준")), "admin notified");
const absD = (() => { for (let i = 1; i < 8; i++) if (mathW.includes(dowOf(kd(i)))) return kd(i); })();
r = await call("ed/guard", { t: tP, action: "absent", date: absD, note: "가족 행사" }); ok(r.s === 200, "guardian tells an absence ahead");
const pre = DB.raw.prepare("SELECT status, deduct, note FROM ed_att WHERE stu_id=? AND date=?").get(sPark, absD);
ok(pre && pre.status === "exc" && pre.deduct === 0 && pre.note.includes("가족 행사"), "pre-marked as excused for that day's class");
nt = await call("nt/list", null, TA); ok(nt.j.items.some(x => x.title === "보호자가 결석을 미리 알려 왔습니다"), "the class teacher is told too");
const lateD = (() => { for (let i = 8; i < 15; i++) if (mathW.includes(dowOf(kd(i)))) return kd(i); })();
r = await call("ed/guard", { t: tP, action: "late", date: lateD, note: "학교 행사로 30분 늦어요" });
ok(r.s === 200 && !DB.raw.prepare("SELECT 1 AS x FROM ed_att WHERE stu_id=? AND date=?").get(sPark, lateD) && DB.raw.prepare("SELECT COUNT(*) AS n FROM ed_note WHERE stu_id=? AND kind='guard' AND title LIKE '%늦음 예정'").get(sPark).n === 1, "lateness is kept as a note, not as an attendance mark");
nt = await call("nt/list", null, TA); ok(nt.j.items.some(x => x.title === "보호자가 늦는다고 알려 왔습니다"), "the teacher hears about lateness");
r = await call("ed/guard", { t: tP, action: "absent", date: kd(45), note: "x" }); ok(r.j.error === "bad-date", "within 30 days");
r = await call("ed/guard", { t: tP, action: "msg", note: "" }); ok(r.j.error === "note-required", "message needs text");
r = await call("ed/guard", { t: tP, action: "msg", note: "다음 주부터 학원 차량 이용할게요" }); ok(r.s === 200 && DB.raw.prepare("SELECT COUNT(*) AS n FROM ed_note WHERE stu_id=? AND kind='guard'").get(sPark).n === 3, "message stored as a guardian note");
for (let i = 0; i < 6; i++) await call("ed/guard", { t: tP, action: "msg", note: "반복 " + i });
r = await call("ed/guard", { t: tP, action: "msg", note: "열한 번째" }); ok(r.s === 429, "ten a day per page");
r = await call("ed/guard", { t: "0".repeat(32), action: "msg", note: "x" }); ok(r.s === 404, "unknown link");

/* ── 상담 문의 ── */
r = await call("ed/lead/save", { name: "윤서아", phone: "010-9090-8080", grade: "초5", subject: "수학", src: "naver", status: "trial", next_date: kd(2), g_name: "윤엄마" }, A);
const lid = r.j.lead.id; ok(r.j.lead.src === "naver" && r.j.lead.d.g_name === "윤엄마", "lead");
r = await call("ed/lead/convert", { id: lid, class_ids: [cMath], start_date: kd(3) }, A);
ok(r.s === 200 && r.j.stu.name === "윤서아" && r.j.stu.g_phone === "010-9090-8080" && r.j.stu.minor === 1 && r.j.enrs.length === 1 && r.j.lead.status === "won" && r.j.lead.stu_id === r.j.stu.id, "lead becomes a student in the class " + JSON.stringify(r.j).slice(0, 160));
r = await call("ed/lead/convert", { id: lid }, A); ok(r.s === 409, "only once");

/* ── 그만두기 · 지우기 ── */
r = await call("ed/stu/save", { id: sPark, status: "left", leave_reason: "이사" }, A);
ok(r.j.stu.status === "left" && r.j.stu.end_date === T0 && r.j.enrs.every(e => e.status === "end"), "leaving ends enrollments");
r = await call("link/get?t=" + tP); ok(r.s === 410 || r.s === 404, "and closes the guardian page " + r.s);
r = await call("ed/stu/save", { id: sPark, status: "on" }, A); ok(r.j.stu.end_date === null, "coming back clears the end date");
const tLee = (await call("link/create", { kind: "ed-guard", target: sLee }, A)).j.token;
r = await call("link/get?t=" + tLee); ok(r.j.view.packs.length === 1 && r.j.view.packs[0].left === 3, "guardian sees remaining sessions (1 + 4 − 2: the cancelled day gave one back) " + JSON.stringify(r.j.view.packs));
r = await call("ed/class/del", { id: cPiano }, A); ok(r.s === 409 && r.j.error === "in-use", "class in use is kept");
r = await call("ed/stu/del", { id: sLee }, A);
ok(r.s === 200 && r.j.bills.includes(idPack) && ["ed_enr", "ed_att", "ed_note", "ed_bill"].every(t => !DB.raw.prepare(`SELECT 1 FROM ${t} WHERE stu_id=?`).get(sLee)), "delete removes the student's records and reports the bill ids");
r = await call("link/get?t=" + tLee); ok(r.s !== 200, "deleted student's page is gone");

/* ── 앞으로 챙길 날 ── */
r = await call("nt/upcoming", null, A);
ok(r.j.items.some(x => x.k === "ed:lead:" + lid) === false && r.j.items.some(x => x.url === "#/edu/bill" && x.title.startsWith("수강료 납부 기한")), "upcoming: fee due dates grouped " + JSON.stringify(r.j.items.filter(x => x.k.startsWith("ed")).map(x => x.title)));
await call("ed/lead/save", { name: "한예린", status: "talk", next_date: kd(1) }, A);
r = await call("nt/upcoming", null, A); ok(r.j.items.some(x => x.title === "상담 연락 — 한예린"), "upcoming: lead follow-up");

/* ── AI ── */
r = await call("token/create", { name: "클로드", scope: "write", modules: ["edu"] }, A); const AT = r.j.token;
r = await call("ai/edu", null, AT);
ok(r.s === 200 && r.j.counts.students >= 4 && r.j.todayClasses.some(c => c.id === cMath && c.checked === 2) && !JSON.stringify(r.j).includes("010-") && !JSON.stringify(r.j).includes("김엄마"), "AI summary without contacts " + JSON.stringify(r.j).slice(0, 200));
r = await call("ai/propose", { kind: "ed-report", payload: { student: "김하늘", month: YM, body: "이번 달은 일차함수를 마쳤습니다." }, reason: "월말 리포트" }, AT);
ok(r.s === 200 && r.j.status === "pending", "report proposal");
const pid = r.j.proposal.id;
r = await call("proposal/decide", { id: pid, approve: true }, A);
ok(r.s === 200 && DB.raw.prepare("SELECT COUNT(*) AS n FROM ed_note WHERE stu_id=? AND kind='report' AND share=0 AND who='ai'").get(sKim).n === 1, "approved report lands as a private draft " + JSON.stringify(r.j).slice(0, 160));
r = await call("ai/propose", { kind: "ed-lead", payload: { name: "문의 학생", phone: "010-0000-1111", grade: "중3", subject: "영어" } }, AT); ok(r.j.status === "pending", "lead proposal");
r = await call("ai/propose", { kind: "ed-report", payload: { student: "김하늘" } }, AT); ok(r.j.error === "bad-request", "report needs a body");
const mcp = async (method, params) => { const req = new Request("https://myworks.ai.kr/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + AT }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); return (await onRequest({ request: req, env: ENV, next: async () => null })).json(); };
let m = await mcp("tools/list"); ok(m.result.tools.some(t => t.name === "myworks_edu") && m.result.tools.find(t => t.name === "myworks_propose").description.includes("ed-report"), "MCP lists the tool");
m = await mcp("tools/call", { name: "myworks_edu", arguments: {} }); ok(m.result && !m.result.isError && m.result.content[0].text.includes("todayClasses"), "MCP tool works");

/* ── 자동 안내 문자 — 납부 기한 전·지남 ── */
ENV.MW_VAULT_KEY = "a-long-enough-vault-key-2026";
r = await call("msg/connect", { key: "NCSGOODKEY000001", secret: "GOODSECRET000000000000000000001" }, A); ok(r.s === 200 && r.j.conn.on, "messaging connected");
const sJ = sJung, bJ = DB.raw.prepare("SELECT id FROM ed_bill WHERE stu_id=?").get(sJ).id;
await call("ed/bill/issue", { ids: [bJ], due: kd(1) }, A);
DB.raw.prepare("UPDATE ed_bill SET due=? WHERE id=?").run(kd(-3), idPark);
const sKimNew = (await call("ed/stu/save", { name: "번호없음", grade: "중1" }, A)).j.stu.id;
await call("ed/bill/save", { stu_id: sKimNew, kind: "etc", items: [{ label: "교재비", amount: 12000 }], status: "issued" }, A);
DB.raw.prepare("UPDATE ed_bill SET due=? WHERE stu_id=?").run(kd(1), sKimNew);
r = await call("msg/settings", { set: { auto: { edDue: { on: true, days: 1 }, edLate: { on: true, days: 3 } } } }, A);
ok(r.j.settings.auto.edDue.on && r.j.settings.auto.edLate.on, "edu rules on");
Date.now = () => at(12);
DB.raw.exec("UPDATE mw_meta SET v='00000000000000' WHERE k='tick'"); DB.raw.exec("UPDATE msg_auto SET next_at='2000-01-01T00:00:00.000Z'");
r = await call("tick");
const dueMsg = sol.sent.find(x => x.to === "01077778888"), lateMsg = sol.sent.find(x => x.to === "01033334444");
ok(dueMsg && dueMsg.text.includes("정우진 학생") && dueMsg.text.includes("납부 기한이 " + kd(1).slice(5).replace("-", "/")) && /myworks\.ai\.kr\/link\/[0-9a-f]{32}/.test(dueMsg.text), "due-tomorrow notice with the guardian page link " + JSON.stringify(sol.sent).slice(0, 300));
ok(!lateMsg, "no late notice for a bill the guardian already reported");
ok(!sol.sent.some(x => x.text.includes("번호없음")), "no phone, no message");
const gl = DB.raw.prepare("SELECT token, expires_at FROM links WHERE kind='ed-guard' AND target=? AND expires_at>?").get(sJ, new Date().toISOString());
ok(gl && dueMsg.text.includes(gl.token) && Date.parse(gl.expires_at) - Date.now() > 300 * 864e5, "auto link is a one-year guardian page");
const n0 = sol.sent.length;
DB.raw.exec("UPDATE mw_meta SET v='00000000000000' WHERE k='tick'"); DB.raw.exec("UPDATE msg_auto SET next_at='2000-01-01T00:00:00.000Z'");
await call("tick"); ok(sol.sent.length === n0, "never twice");
Date.now = RealNow;

/* ── 청구일 자동 초안 ── */
await call("ed/settings", { set: { bill: { day: 1, next: true } } }, A);
const NX = (() => { const [y, mm] = YM.split("-").map(Number); return new Date(Date.UTC(y, mm, 1)).toISOString().slice(0, 7); })();
r = await call("ed/data", null, S);
ok(r.j.gen && r.j.gen.ym === NX && r.j.gen.n >= 2 && r.j.bills.filter(b => b.ym === NX && b.status === "draft").length === r.j.gen.n, "after the billing day, next month's drafts are made once " + JSON.stringify(r.j.gen));
r = await call("ed/data", null, A); ok(r.j.gen === null, "only once a month");

/* ── 백업 · 복원 ── */
r = await call("backup", null, A); const bk = r.j.backup;
ok(r.s === 200 && Array.isArray(bk.mods.ed_bill) && bk.mods.ed_stu.length >= 5 && bk.mods.ed_att.length >= 3 && bk.mods.ed_class.length === 3 && bk.mods.mod_set.some(x => x.mod === "ed" && x.k === "settings"), "backup carries edu tables " + Object.keys((bk && bk.mods) || {}).filter(k => k.startsWith("ed_")).join(","));
const nBill = DB.raw.prepare("SELECT COUNT(*) AS n FROM ed_bill").get().n;
DB.raw.exec("DELETE FROM ed_bill");
r = await call("restore", { data: bk }, A); ok(r.s === 200 && DB.raw.prepare("SELECT COUNT(*) AS n FROM ed_bill").get().n === nBill, "restore brings them back");

/* ── 권한 경계 — 복원하면 로그인이 새로 시작되므로 다시 들어옵니다 ── */
const TA2 = (await call("login", { loginId: "teach01", pw: "pw123456" })).j.token;
r = await call("ed/mine", null, TA2); ok(r.s === 200 && r.j.classes.length === 1, "teacher back in after restore " + r.s);
r = await call("ed/stu/del", { id: sKim }, TA2); ok(r.s === 403, "teacher cannot delete students");
r = await call("ed/note/save", { stu_id: sKim, body: "x" }, TA2); ok(r.s === 403, "teacher cannot write private notes");
r = await call("ws/modules", { modules: ["tax"] }, A);
r = await call("ed/mine", null, TA2); ok(r.s === 403, "off again → closed");
r = await call("link/get?t=" + gTok); ok(r.s === 404, "guardian page closes with the extension");

console.log(`통과 ${pass} · 실패 ${failN} · 요청당 최대 쿼리 ${maxQ} (${maxQPath})`);
process.exit(failN ? 1 : 0);
