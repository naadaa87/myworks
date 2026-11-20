// 문자·알림톡 서버 시험 — node tests/message.test.mjs
// 솔라피는 흉내 냅니다. 흉내 서버가 요청의 서명(HMAC-SHA256)을 직접 다시 계산해 맞을 때만 받습니다.
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
  if (p !== "owner-setup" && p !== "restore" && DB.queries > maxQ) { maxQ = DB.queries; maxQPath = p; }
  return { s: r.status, j: await r.json(), q: DB.queries };
}

/* ── 솔라피 흉내 ── */
const KEYS = { NCSGOODKEY000001: "GOODSECRET000000000000000000001" };
const sol = { calls: [], failTo: new Set(), balance: 12000, senders: ["01011112222", "0212345678"], sigs: new Set() };
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init = {}) => {
  const url = new URL(String(u));
  if (url.hostname !== "api.solapi.com") throw new Error("unexpected fetch " + u);
  const auth = (init.headers && init.headers.authorization) || "", m = /^HMAC-SHA256 apiKey=([^,]+), date=([^,]+), salt=([^,]+), signature=([0-9a-f]+)$/.exec(auth);
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
  if (!m) return J({ errorCode: "InvalidAuthorization", errorMessage: "헤더 형식이 올바르지 않습니다." }, 401);
  const [, k, date, salt, sig] = m, secret = KEYS[k];
  if (!secret || nodeCrypto.createHmac("sha256", secret).update(date + salt).digest("hex") !== sig) return J({ errorCode: "SignatureDoesNotMatch", errorMessage: "서명이 일치하지 않습니다." }, 403);
  if (Math.abs(Date.parse(date) - realNow()) > 15 * 60e3 && Math.abs(Date.parse(date) - Date.now()) > 15 * 60e3) return J({ errorCode: "RequestTimeTooSkewed" }, 403);
  if (salt.length < 12 || sol.sigs.has(sig)) return J({ errorCode: "DuplicatedSignature" }, 403);
  sol.sigs.add(sig);
  const body = init.body ? JSON.parse(init.body) : null;
  sol.calls.push({ method: init.method || "GET", path: url.pathname, body });
  if (url.pathname === "/cash/v1/balance") return J({ balance: sol.balance, point: 300 });
  if (url.pathname === "/senderid/v1/numbers/active") return J(sol.senders.map(p => ({ phoneNumber: p, handleKey: "SID_" + p, status: "ACTIVE" })));
  if (url.pathname === "/kakao/v2/channels") return J({ channelList: [{ channelId: "KA01PF000000000000001", searchId: "@haru", channelName: "하루 디자인" }] });
  if (url.pathname === "/kakao/v2/templates/sendable") return J([
    { templateId: "KA01TP000000000000001", name: "견적서 안내", channelId: "KA01PF000000000000001", content: "[#{상호}] #{이름}님, 견적서를 보내드립니다.\n건명: #{제목}", status: "APPROVED", variables: [{ name: "상호" }, { name: "이름" }, { name: "제목" }, { name: "코드" }], buttons: [{ buttonType: "WL", buttonName: "견적서 보기", linkMo: "https://myworks.ai.kr/link/#{코드}" }] },
    { templateId: "KA01TP000000000000002", name: "입금 기한 안내", channelId: "KA01PF000000000000001", content: "#{이름}님, #{제목} 입금 기한은 #{기한}입니다.", status: "APPROVED", variables: [{ name: "이름" }, { name: "제목" }, { name: "기한" }] }
  ]);
  if (url.pathname === "/messages/v4/send-many/detail") {
    const msgs = body.messages, failed = msgs.filter(x => sol.failTo.has(x.to)), good = msgs.filter(x => !sol.failTo.has(x.to));
    sol.balance -= good.length * 20;
    return J({ groupInfo: { groupId: "G" + sol.calls.length, count: { total: msgs.length, registeredSuccess: good.length, registeredFailed: failed.length }, balance: sol.balance, point: 300 }, failedMessageList: failed.map(x => ({ to: x.to, statusCode: "1062", statusMessage: "발송 가능한 번호가 아닙니다." })), messageList: good.map((x, i) => ({ messageId: "M" + sol.calls.length + "_" + i, to: x.to, statusCode: "2000", statusMessage: "정상 접수" })) });
  }
  return J({ errorCode: "NotFound" }, 404);
};
const RealNow = Date.now.bind(Date), realNow = () => RealNow();
const lastSend = () => sol.calls.filter(c => c.path === "/messages/v4/send-many/detail").pop();
const kd = n => new Date(Date.now() + 9 * 3600e3 + n * 864e5).toISOString().slice(0, 10);

/* ── 준비 ── */
const A = (await call("owner-setup", { loginId: "boss01", pw: "pass1234", name: "김대표", workspace: "하루 디자인" })).j.token;
await call("member/create", { loginId: "staff01", pw: "pw123456", name: "민 매니저", role: "staff" }, A);
await call("member/create", { loginId: "part01", pw: "pw123456", name: "외주 박", role: "partner" }, A);
await call("member/create", { loginId: "alba01", pw: "pw123456", name: "알바 최", role: "worker" }, A);
const S = (await call("login", { loginId: "staff01", pw: "pw123456" })).j.token, P = (await call("login", { loginId: "part01", pw: "pw123456" })).j.token, W = (await call("login", { loginId: "alba01", pw: "pw123456" })).j.token;
const WS = (await call("state", null, A)).j.ws.id;

/* ── 처음 상태 · 권한 ── */
let r = await call("msg/data", null, A);
ok(r.s === 200 && r.j.open === false && r.j.conn.on === false && r.j.settings.from === "" && r.j.settings.dayMax === 300 && r.j.log.length === 0 && r.j.tpl["link.quote"].name === "견적서 보내기" && r.j.fields.includes("링크"), "empty state, vault closed");
ok(Object.values(r.j.settings.auto).every(x => x.on === false) && r.j.settings.kakao.on === false, "automatic notices are off by default");
r = await call("msg/data", null, P); ok(r.s === 403, "partner cannot read");
r = await call("msg/data", null, W); ok(r.s === 403, "worker cannot read");
r = await call("msg/connect", { key: "NCSGOODKEY000001", secret: KEYS.NCSGOODKEY000001 }, A); ok(r.s === 400 && r.j.error === "no-vault", "cannot connect without the vault key");
r = await call("msg/send", { items: [{ to: "010-2222-3333", text: "안녕하세요" }] }, A); ok(r.j.error === "not-connected", "cannot send before connecting");
ENV.MW_VAULT_KEY = "a-long-enough-vault-key-2026";
r = await call("msg/data", null, S); ok(r.j.open === true, "vault open → staff sees it is available");

/* ── 연결 ── */
r = await call("msg/connect", { key: "NCSGOODKEY000001", secret: "wrong-secret-000000000" }, A); ok(r.s === 400 && r.j.error === "bad-key" && r.j.detail.includes("서명"), "wrong secret → bad-key with the provider's message");
r = await call("msg/connect", { key: "short", secret: "x" }, A); ok(r.j.error === "bad-request", "needs both values");
r = await call("msg/connect", { key: "NCSGOODKEY000001", secret: KEYS.NCSGOODKEY000001 }, S); ok(r.s === 403, "only the admin connects");
r = await call("msg/connect", { key: "NCSGOODKEY000001", secret: KEYS.NCSGOODKEY000001 }, A);
ok(r.s === 200 && r.j.conn.on && r.j.conn.balance === 12000 && r.j.conn.point === 300 && r.j.conn.senders.join() === "01011112222,0212345678" && r.j.conn.tail === "…0001", "connected: balance and sender numbers read");
ok(r.j.settings.from === "01011112222" && r.j.settings.sign === "하루 디자인", "first sender number and workspace name become the defaults");
ok(!JSON.stringify(r.j).includes("GOODSECRET") && !JSON.stringify(r.j).includes("sealed"), "secret never comes back");
const rawConn = DB.raw.prepare("SELECT v FROM mod_set WHERE ws=? AND mod='msg' AND k='conn'").get(WS).v;
ok(!rawConn.includes("GOODSECRET") && !rawConn.includes("NCSGOODKEY000001") && /"sealed":"v1\./.test(rawConn), "stored sealed, not in clear");
r = await call("msg/data", null, S); ok(r.j.conn.on && !JSON.stringify(r.j).includes("sealed"), "data shows connection without secrets");

/* ── 채널 · 템플릿 읽기, 설정 ── */
r = await call("msg/refresh", {}, S);
ok(r.s === 200 && r.j.conn.channels.length === 1 && r.j.conn.channels[0].id === "KA01PF000000000000001" && r.j.conn.templates.length === 2 && r.j.conn.templates[0].vars.join() === "상호,이름,제목,코드", "channels and approved templates read");
r = await call("msg/settings", { set: { from: "01099998888" } }, A); ok(r.s === 400 && r.j.error === "bad-sender", "sender must be one registered at the provider");
r = await call("msg/settings", { set: { sign: "하루" } }, S); ok(r.s === 403, "staff cannot change settings");
r = await call("msg/settings", { set: { sign: "  하루 디자인 스튜디오 아주 긴 이름입니다만  ", dayMax: 99999, tpl: { "link.quote": "[{상호}] {이름}님 견적입니다 {링크}", "nope": "x", "link.invoice": r.j && "" } } }, A);
ok(r.s === 200 && r.j.settings.sign.length <= 20 && r.j.settings.dayMax === 2000 && r.j.settings.tpl["link.quote"] === "[{상호}] {이름}님 견적입니다 {링크}" && !("nope" in r.j.settings.tpl) && !("link.invoice" in r.j.settings.tpl), "settings cleaned");
r = await call("msg/settings", { set: { sign: "하루 디자인", dayMax: 5, tpl: { "link.quote": "" } } }, A);
ok(r.j.settings.sign === "하루 디자인" && r.j.settings.dayMax === 5, "settings merge");

/* ── 보내기 ── */
r = await call("msg/send", { items: [{ to: "02-123-4567", text: "유선 번호" }] }, A); ok(r.j.error === "bad-phone", "mobile numbers only");
r = await call("msg/send", { items: [{ to: "010-2222-3333", text: "   " }] }, A); ok(r.j.error === "empty", "empty text refused");
r = await call("msg/send", { items: [{ to: "010-2222-3333", text: "(광고) 11월 할인 행사 안내" }] }, A); ok(r.j.error === "ad-not-allowed", "advertising text refused");
r = await call("msg/send", { items: [{ to: "010-2222-3333", text: "가".repeat(1001) }] }, A); ok(r.j.error === "too-long", "over 2,000 bytes refused");
r = await call("msg/send", { items: [{ to: "010-2222-3333", text: "x" }] }, P); ok(r.s === 403, "partner cannot send");
const n0 = sol.calls.length;
r = await call("msg/send", { items: [{ to: "+82 10-2222-3333", name: "이고객", text: "[하루 디자인] 견적서를 보내드립니다. https://myworks.ai.kr/link/abc", tpl: "link.quote", ref_kind: "quote", ref_id: "q1" }] }, S);
ok(r.s === 200 && r.j.sent === 1 && r.j.failed === 0 && r.j.results[0].kind === "sms" && r.j.results[0].status === "sent" && r.j.balance === 11980 && r.j.today === 1, "staff sends a short text " + JSON.stringify(r.j));
let c = lastSend();
ok(sol.calls.length === n0 + 1 && c.method === "POST" && c.body.showMessageList === true && c.body.messages.length === 1 && c.body.messages[0].to === "01022223333" && c.body.messages[0].from === "01011112222" && c.body.messages[0].type === "SMS" && !c.body.messages[0].subject, "one request, number cleaned, SMS under 90 bytes");
r = await call("msg/send", { items: [{ to: "01022223333", name: "이고객", text: "[하루 디자인] 이고객님, 요청하신 견적서를 보내드립니다.\n브랜드 로고 디자인\nhttps://myworks.ai.kr/link/0123456789abcdef0123456789abcdef" }] }, A);
c = lastSend(); ok(r.j.results[0].kind === "lms" && c.body.messages[0].type === "LMS" && c.body.messages[0].subject === "하루 디자인", "longer text goes as LMS with the name as subject");
sol.failTo.add("01000000000");
r = await call("msg/send", { items: [{ to: "010-0000-0000", name: "없는 번호", text: "안내드립니다" }, { to: "010-4444-5555", name: "박거래", text: "안내드립니다" }, { to: "010-4444-5555", name: "박거래", text: "안내드립니다 (같은 번호 두 번)" }] }, A);
ok(r.j.sent === 1 && r.j.failed === 1 && r.j.results.length === 2 && r.j.results[0].status === "failed" && r.j.results[0].err === "발송 가능한 번호가 아닙니다." && r.j.results[1].status === "sent", "per-recipient result; duplicate recipient dropped " + JSON.stringify(r.j.results));
r = await call("msg/data", null, A);
ok(r.j.today === 3 && r.j.month === 3 && r.j.log.length === 4 && r.j.log.filter(x => x.status === "failed").length === 1 && r.j.log.some(x => x.to_name === "이고객" && x.ref_id === "q1" && x.by_name === "민 매니저" && x.auto === 0) && r.j.conn.balance === sol.balance, "log and balance updated");
r = await call("msg/log", { ref_id: "q1" }, S); ok(r.j.log.length === 1 && r.j.log[0].tpl === "link.quote", "log by what it was about");
r = await call("msg/send", { items: [1, 2, 3].map(i => ({ to: "0105555000" + i, text: "한도 시험" })) }, A); ok(r.s === 429 && r.j.error === "day-limit" && r.j.limit === 5 && r.j.used === 3, "daily limit holds");
r = await call("msg/send", { items: Array.from({ length: 51 }, (_, i) => ({ to: "0106000" + String(1000 + i), text: "많이" })) }, A); ok(r.j.error === "too-many", "50 per request");
await call("msg/settings", { set: { dayMax: 300 } }, A);

/* ── 알림톡 — 템플릿을 용도에 잇기 ── */
r = await call("msg/settings", { set: { kakao: { on: true, pfId: "KA01PF000000000000001", map: { "link.quote": { templateId: "KA01TP000000000000001", name: "견적서 안내", vars: { 상호: "상호", 이름: "이름", 제목: "제목", 코드: "코드" } }, "auto.invDue": { templateId: "KA01TP000000000000002", name: "입금 기한 안내", vars: { 이름: "이름", 제목: "제목", 기한: "기한" } }, "weird": { templateId: "x" } } } } }, A);
ok(r.s === 200 && r.j.settings.kakao.on && Object.keys(r.j.settings.kakao.map).join() === "link.quote,auto.invDue", "template mapping saved, unknown purpose dropped");
r = await call("msg/send", { items: [{ to: "010-2222-3333", name: "이고객", text: "[하루 디자인] 이고객님, 견적서를 보내드립니다.", tpl: "link.quote", ref_kind: "quote", ref_id: "q2", fields: { 상호: "하루 디자인", 이름: "이고객", 제목: "브랜드 로고", 링크: "https://myworks.ai.kr/link/0123456789abcdef0123456789abcdef", 코드: "0123456789abcdef0123456789abcdef" } }] }, A);
c = lastSend();
ok(r.j.results[0].kind === "ata" && c.body.messages[0].kakaoOptions.pfId === "KA01PF000000000000001" && c.body.messages[0].kakaoOptions.templateId === "KA01TP000000000000001" && c.body.messages[0].kakaoOptions.variables["#{이름}"] === "이고객" && c.body.messages[0].kakaoOptions.variables["#{코드}"] === "0123456789abcdef0123456789abcdef" && c.body.messages[0].from === "01011112222" && !("text" in c.body.messages[0]), "mapped purpose goes as 알림톡 with #{…} variables and a sender for fallback");
r = await call("msg/send", { items: [{ to: "010-2222-3333", name: "이고객", text: "[하루 디자인] 견적서를 보내드립니다.", tpl: "link.quote", ref_id: "q3", fields: { 상호: "하루 디자인", 이름: "이고객", 제목: "" } }] }, A);
c = lastSend(); ok(r.j.results[0].kind === "sms" && !c.body.messages[0].kakaoOptions, "a blank variable → sent as a text instead");
r = await call("msg/send", { kakao: false, items: [{ to: "010-2222-3333", text: "문자로만", tpl: "link.quote", ref_id: "q4", fields: { 상호: "a", 이름: "b", 제목: "c", 코드: "d" } }] }, A);
ok(r.j.results[0].kind === "sms", "caller can ask for a plain text");

/* ── 자동 안내 ── */
const at = (h, m = 0) => Date.parse(kdReal(0) + "T00:00:00Z") + (h - 9) * 3600e3 + m * 60e3;   // 오늘 한국 시간 h시
function kdReal(n) { return new Date(RealNow() + 9 * 3600e3 + n * 864e5).toISOString().slice(0, 10); }
const setNow = ms => { Date.now = () => ms; };
const tickNow = async () => { DB.raw.exec("UPDATE mw_meta SET v='00000000000000' WHERE k='tick'"); DB.raw.exec("UPDATE msg_auto SET next_at='2000-01-01T00:00:00.000Z'"); return call("tick"); };   // 기다리지 않고 바로 돌려 봅니다
setNow(at(12));
await call("push", { ops: [{ kind: "contact", id: "c1", data: { id: "c1", name: "이고객", phone: "010-2222-3333", kind: "고객" } }, { kind: "contact", id: "c2", data: { id: "c2", name: "번호 없는 고객", phone: "", kind: "고객" } }] }, A);
DB.raw.exec(`INSERT INTO os_job(ws,id,client_id,client_name,title,status,created_at,updated_at) VALUES('${WS}','j1','c1','이고객','브랜드 로고','billing','x','x'),('${WS}','j2','c2','번호 없는 고객','명함','billing','x','x')`);
DB.raw.exec(`INSERT INTO os_invoice(ws,id,job_id,no,amount,tax_mode,tax,net,due_date,status,created_at,updated_at) VALUES
 ('${WS}','v1','j1','INV-1',1000000,'vat',100000,1100000,'${kd(1)}','issued','x','x'),
 ('${WS}','v2','j1','INV-2',500000,'none',0,500000,'${kd(-3)}','issued','x','x'),
 ('${WS}','v3','j1','INV-3',1,'none',0,1,'${kd(1)}','paid','x','x'),
 ('${WS}','v4','j2','INV-4',1,'none',0,1,'${kd(1)}','issued','x','x'),
 ('${WS}','v5','j1','INV-5',1,'none',0,1,'${kd(5)}','issued','x','x')`);
r = await tickNow(); ok(r.j.ran && r.j.autoSent === undefined, "nothing automatic while every rule is off " + JSON.stringify(r.j));
r = await call("msg/settings", { set: { auto: { invDue: { on: true, days: 1 }, invLate: { on: true, days: 3 } } } }, A);
ok(r.j.settings.auto.invDue.on && r.j.settings.auto.invLate.on && !r.j.settings.auto.quoteNudge.on && DB.raw.prepare("SELECT COUNT(*) AS n FROM msg_auto").get().n === 1, "rules on → workspace queued");
const before = sol.calls.length;
r = await tickNow();
ok(r.j.autoSent === 2, "two notices go out: due tomorrow and three days late " + JSON.stringify(r.j));
c = lastSend();
ok(sol.calls.length === before + 1 && c.body.messages.length === 2, "one provider request for both");
const mDue = c.body.messages.find(x => x.kakaoOptions), mLate = c.body.messages.find(x => !x.kakaoOptions);
ok(mDue && mDue.kakaoOptions.templateId === "KA01TP000000000000002" && mDue.kakaoOptions.variables["#{기한}"] === kd(1).slice(5).replace("-", "/") && mDue.to === "01022223333", "due-tomorrow notice uses the mapped 알림톡 template");
const linkTok = DB.raw.prepare("SELECT token FROM links WHERE ws=? AND kind='invoice' AND target='v2'").get(WS);
ok(mLate && mLate.type === "LMS" && mLate.text.includes("입금 기한(" + kd(-3).slice(5).replace("-", "/") + ")이 지났습니다") && linkTok && mLate.text.includes("https://myworks.ai.kr/link/" + linkTok.token), "late notice is a text with a fresh confirm link");
r = await call("link/get?t=" + linkTok.token); ok(r.s === 200 && r.j.view.kind === "invoice" && r.j.view.invoice.no === "INV-2", "that link opens the invoice");
r = await call("msg/data", null, A); ok(r.j.log.filter(x => x.auto === 1 && x.status === "sent").length === 2 && r.j.log.find(x => x.auto === 1).by_name === "자동", "logged as automatic");
r = await call("nt/list", null, A); ok(r.j.items[0].title === "자동 안내 2건을 보냈습니다" && r.j.items[0].url === "#/msg/log", "admin is told what went out");
DB.raw.exec("UPDATE msg_auto SET next_at='2000-01-01T00:00:00.000Z'");
const b2 = sol.calls.length; r = await tickNow(); ok(r.j.autoSent === 0 && sol.calls.length === b2, "same notice is never sent twice");
// 그 사이 입금되면 보내지 않습니다
DB.raw.exec(`UPDATE os_invoice SET due_date='${kd(1)}' WHERE ws='${WS}' AND id='v5'`); DB.raw.exec(`UPDATE os_invoice SET status='paid' WHERE ws='${WS}' AND id='v5'`);
DB.raw.exec("UPDATE msg_auto SET next_at='2000-01-01T00:00:00.000Z'");
r = await tickNow(); ok(r.j.autoSent === 0, "paid in the meantime → not sent");
/* ── 자동 안내는 먼저 적고 보냅니다 — 도중에 끊겨도 두 번 가지 않습니다 ── */
{
  DB.raw.exec(`INSERT INTO os_invoice(ws,id,job_id,no,amount,tax_mode,tax,net,due_date,status,created_at,updated_at) VALUES('${WS}','v9','j1','INV-9',300000,'none',0,300000,'${kd(1)}','issued','x','x')`);
  const n0 = sol.calls.length, realFetch2 = globalThis.fetch;
  globalThis.fetch = async (u, init) => { if (/send-many/.test(String(u))) { await realFetch2(u, init); throw new Error("connection lost after the provider accepted it"); } return realFetch2(u, init); };
  r = await tickNow();
  globalThis.fetch = realFetch2;
  const held = DB.raw.prepare("SELECT status, auto, to_no FROM msg_log WHERE ref_id='v9'").all();
  ok(sol.calls.length > n0 && held.length === 1 && held[0].status === "pending" && held[0].auto === 1, "the notice was written down before sending and is left as pending " + JSON.stringify(held));
  const n1 = sol.calls.filter(c => /send-many/.test(c.path)).length;
  r = await tickNow();
  ok(sol.calls.filter(c => /send-many/.test(c.path)).length === n1 && DB.raw.prepare("SELECT COUNT(*) AS n FROM msg_log WHERE ref_id='v9'").get().n === 1, "and it is not sent a second time");
  r = await call("msg/log", null, A); ok(r.j.log.some(x => x.ref_id === "v9" && x.status === "pending"), "the log shows it so the owner can check");
  r = await call("nt/list", null, A); ok(r.j.items[0].title === "자동 안내를 보내다 연결이 끊겼습니다", "and the admin is told");
  // 받는 쪽에서 거절한 안내는 두 번까지만 시도합니다
  await call("push", { ops: [{ kind: "contact", id: "c7", data: { id: "c7", name: "없는 번호 고객", phone: "010-9999-0000", kind: "고객" } }] }, A);
  DB.raw.exec(`INSERT INTO os_job(ws,id,client_id,client_name,title,status,created_at,updated_at) VALUES('${WS}','j7','c7','없는 번호 고객','간판','billing','x','x')`);
  DB.raw.exec(`INSERT INTO os_invoice(ws,id,job_id,no,amount,tax_mode,tax,net,due_date,status,created_at,updated_at) VALUES('${WS}','v7','j7','INV-7',10000,'none',0,10000,'${kd(1)}','issued','x','x')`);
  sol.failTo.add("01099990000");
  const tries = () => DB.raw.prepare("SELECT COUNT(*) AS n FROM msg_log WHERE ref_id='v7' AND status='failed'").get().n;
  await tickNow(); await tickNow(); ok(tries() === 2, "a rejected notice is tried twice " + tries());
  const n2 = sol.calls.filter(c => /send-many/.test(c.path)).length;
  await tickNow(); ok(tries() === 2 && sol.calls.filter(c => /send-many/.test(c.path)).length === n2, "then left alone");
  sol.failTo.delete("01099990000");
}

// 밤에는 쉽니다
DB.raw.exec(`UPDATE os_invoice SET status='issued' WHERE ws='${WS}' AND id='v5'`);
setNow(at(23)); DB.raw.exec("UPDATE msg_auto SET next_at='2000-01-01T00:00:00.000Z'");
const b3 = sol.calls.length; r = await tickNow();
const nextAt = DB.raw.prepare("SELECT next_at FROM msg_auto").get().next_at;
ok(sol.calls.length === b3 && nextAt === kdReal(1) + "T00:00:00.000Z", "at night nothing is sent; next run is 9 a.m. Korea time " + nextAt);
setNow(at(6)); DB.raw.exec("UPDATE msg_auto SET next_at='2000-01-01T00:00:00.000Z'"); r = await tickNow();
ok(sol.calls.length === b3 && DB.raw.prepare("SELECT next_at FROM msg_auto").get().next_at === kdReal(0) + "T00:00:00.000Z", "early morning waits until 9 a.m. the same day");
setNow(at(9, 5)); DB.raw.exec("UPDATE msg_auto SET next_at='2000-01-01T00:00:00.000Z'"); r = await tickNow();
ok(r.j.autoSent === 1 && lastSend().body.messages[0].kakaoOptions.variables["#{제목}"] === "브랜드 로고", "morning: the one that became due goes out");
// 견적 회신 요청 — 링크를 보낸 지 3일
DB.raw.exec(`INSERT INTO os_quote(ws,id,job_id,no,items,vat,supply,tax,total,valid_until,status,created_at,updated_at) VALUES('${WS}','q9','j1','Q-9','[]',1,1,0,1,'${kd(20)}','sent','x','x'),('${WS}','q8','j1','Q-8','[]',1,1,0,1,'${kd(20)}','approved','x','x')`);
const t3 = new Date(at(15) - 3 * 864e5).toISOString();
DB.raw.exec(`INSERT INTO links(token,ws,kind,target,created_by,created_at,expires_at) VALUES('${"a".repeat(32)}','${WS}','quote','q9',NULL,'${t3}','${new Date(RealNow() + 20 * 864e5).toISOString()}'),('${"b".repeat(32)}','${WS}','quote','q8',NULL,'${t3}','${new Date(RealNow() + 20 * 864e5).toISOString()}')`);
await call("msg/settings", { set: { auto: { invDue: { on: false }, invLate: { on: false }, quoteNudge: { on: true, days: 3 } } } }, A);
setNow(at(10)); DB.raw.exec("UPDATE msg_auto SET next_at='2000-01-01T00:00:00.000Z'"); r = await tickNow();
c = lastSend(); ok(r.j.autoSent === 1 && c.body.messages[0].text.includes("보내드린 견적서를 확인해 주세요") && c.body.messages[0].text.includes("/link/" + "a".repeat(32)), "quote nudge after three days, only for quotes still waiting");
// 예약 전날 안내 — 마이스토어
await call("ws/modules", { modules: ["space"] }, A);
await call("push", { ops: [{ kind: "store", id: "s1", data: { id: "s1", name: "홍대점", status: "운영중" } }] }, A);
DB.raw.exec(`INSERT INTO sp_res(ws,id,branch_id,res_date,slot,resno,customer,phone,amount,status,start_t,created_at) VALUES('${WS}','r1','s1','${kd(1)}','night','R1','최손님','010-7777-8888',100000,'확정','19:00','x'),('${WS}','r2','s1','${kd(1)}','day','R2','취소 손님','010-7777-9999',1,'취소','12:00','x'),('${WS}','r3','s1','${kd(2)}','day','R3','모레 손님','010-7777-0000',1,'확정','12:00','x'),('${WS}','r4','s1','${kd(1)}','day','R4','번호 없음','',1,'확정','12:00','x')`);
await call("msg/settings", { set: { auto: { quoteNudge: { on: false }, resEve: { on: true, hour: 18, note: "입실 10분 전부터 들어오실 수 있습니다. 주차는 건물 뒤편입니다." } } } }, A);
setNow(at(14)); DB.raw.exec("UPDATE msg_auto SET next_at='2000-01-01T00:00:00.000Z'"); r = await tickNow(); ok(r.j.autoSent === 0, "reservation notice waits for the set hour");
setNow(at(18, 10)); DB.raw.exec("UPDATE msg_auto SET next_at='2000-01-01T00:00:00.000Z'"); r = await tickNow();
c = lastSend();
ok(r.j.autoSent === 1 && c.body.messages.length === 1 && c.body.messages[0].to === "01077778888" && c.body.messages[0].text.includes("최손님님, 내일(" + kd(1).slice(5).replace("-", "/") + ") 19:00 홍대점 예약 안내드립니다") && c.body.messages[0].text.includes("주차는 건물 뒤편"), "tomorrow's guest gets the note; cancelled, later, and phone-less ones do not: " + c.body.messages[0].text.replace(/\n/g, " / "));
Date.now = RealNow;

/* ── 규칙을 모두 끄면 대기열에서 빠집니다 · 연결 끊기 ── */
r = await call("msg/settings", { set: { auto: { resEve: { on: false } } } }, A); ok(DB.raw.prepare("SELECT COUNT(*) AS n FROM msg_auto").get().n === 0, "all rules off → dequeued");
/* ── 백업에는 연결 정보가 없고, 복원해도 연결은 그대로 ── */
r = await call("backup", null, A);
const bk = JSON.stringify(r.j);
ok(r.s === 200 && !bk.includes("sealed") && !bk.includes('"k":"conn"') && bk.includes('"mod":"msg"') && bk.includes('"sign":"하루 디자인"'), "backup carries settings but not the connection");
r = await call("restore", { data: r.j.backup }, A);
const after = DB.raw.prepare("SELECT v FROM mod_set WHERE ws=? AND mod='msg' AND k='conn'").get(WS);
ok(r.s === 200 && after && after.v === DB.raw.prepare("SELECT v FROM mod_set WHERE ws=? AND mod='msg' AND k='conn'").get(WS).v && (await call("msg/data", null, (await call("login", { loginId: "boss01", pw: "pass1234" })).j.token)).j.conn.on, "restore keeps the connection " + JSON.stringify(r.j).slice(0, 120));
const A2 = (await call("login", { loginId: "boss01", pw: "pass1234" })).j.token;
const S2 = (await call("login", { loginId: "staff01", pw: "pw123456" })).j.token;   // 복원하면 다른 구성원은 다시 로그인합니다
r = await call("msg/disconnect", {}, S2); ok(r.s === 403, "only the admin disconnects");
r = await call("msg/disconnect", {}, A2); ok(r.j.conn.on === false && !DB.raw.prepare("SELECT 1 AS x FROM mod_set WHERE ws=? AND mod='msg' AND k='conn'").get(WS), "disconnected: sealed key removed");
r = await call("msg/send", { items: [{ to: "01022223333", text: "끊은 뒤" }] }, A2); ok(r.j.error === "not-connected", "cannot send after disconnecting");
r = await call("msg/data", null, A2); ok(r.j.log.length >= 9 && r.j.conn.on === false, "log stays");

globalThis.fetch = realFetch;
ok(maxQ < 50, `queries per request stay under 50 (max ${maxQ} at ${maxQPath})`);
/* ── 보낸 기록은 1년 뒤에 지웁니다 ── */
{
  const real = Date.now; setNow(at(12));   // 정각 — 한 시간에 한 번 도는 정리가 걸리는 때
  const oldAt = new Date(Date.now() - 366 * 864e5).toISOString(), newAt = new Date(Date.now() - 300 * 864e5).toISOString();
  DB.raw.exec(`INSERT INTO msg_log(ws,id,at,kind,to_no,status) VALUES('${WS}','old1','${oldAt}','SMS','01000000000','ok'),('${WS}','keep1','${newAt}','SMS','01000000000','ok')`);
  await tickNow();
  const left = DB.raw.prepare("SELECT id FROM msg_log WHERE id IN ('old1','keep1')").all().map(x => x.id);
  ok(left.length === 1 && left[0] === "keep1", "a record older than a year is removed, a younger one stays " + JSON.stringify(left));
  Date.now = real;
}
console.log(`통과 ${pass} · 실패 ${failN} · 요청당 최대 쿼리 ${maxQ} (${maxQPath})`);
process.exit(failN ? 1 : 0);
