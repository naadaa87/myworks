// 알림(알림함 · 휴대폰 푸시 · 예약 알림) 서버 시험 — node tests/notify.test.mjs
// 푸시 서버는 흉내 냅니다. 받은 내용은 서버 코드와 따로 짠 풀이(node:crypto)로 풀어 규격(RFC 8291 · VAPID)에 맞는지 봅니다.
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
  if (p !== "owner-setup" && DB.queries > maxQ) { maxQ = DB.queries; maxQPath = p; }
  return { s: r.status, j: await r.json(), q: DB.queries };
}
const b64u = b => Buffer.from(b).toString("base64url"), unb = s => Buffer.from(String(s), "base64url");

/* ── 푸시 서버 흉내 — 받은 요청을 모아 둡니다 ── */
const sentPush = []; let pushStatus = 201;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const url = String(u);
  if (/fcm\.googleapis\.com|push\.apple\.com|mozilla\.com/.test(url)) { sentPush.push({ url, headers: Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])), body: Buffer.from(init.body) }); return new Response("", { status: typeof pushStatus === "function" ? pushStatus(url) : pushStatus }); }
  throw new Error("unexpected fetch " + url);
};
/* 기기 하나 — 브라우저가 만드는 구독과 같은 모양 */
function device(host = "https://fcm.googleapis.com/fcm/send/") {
  const ecdh = nodeCrypto.createECDH("prime256v1"); ecdh.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  return { ecdh, auth, sub: { endpoint: host + nodeCrypto.randomBytes(12).toString("hex"), keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) }, ua: "시험 기기" } };
}
/* 받은 본문 풀기 — RFC 8291 / 8188 (aes128gcm) */
function openPush(dev, body) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const secret = dev.ecdh.computeSecret(asPub);
  const ikm = Buffer.from(nodeCrypto.hkdfSync("sha256", secret, dev.auth, Buffer.concat([Buffer.from("WebPush: info\0"), dev.ecdh.getPublicKey(), asPub]), 32));
  const cek = Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const dec = nodeCrypto.createDecipheriv("aes-128-gcm", cek, nonce); dec.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
  let end = plain.length - 1; while (end >= 0 && plain[end] === 0) end--;
  return { rs, idlen, delim: plain[end], json: JSON.parse(plain.subarray(0, end).toString("utf8")) };
}
function vapidOk(header, pubB64, endpoint) {   // Authorization: vapid t=<JWT>, k=<공개키>
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header || ""); if (!m || m[2] !== pubB64) return false;
  const [h, p, sg] = m[1].split("."), head = JSON.parse(unb(h)), pay = JSON.parse(unb(p));
  const raw = unb(pubB64), key = nodeCrypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) }, format: "jwk" });
  const good = nodeCrypto.verify("sha256", Buffer.from(h + "." + p), { key, dsaEncoding: "ieee-p1363" }, unb(sg));
  const now = Date.now() / 1000;
  return good && head.alg === "ES256" && pay.aud === new URL(endpoint).origin && pay.exp > now && pay.exp <= now + 24 * 3600 && /^(https:|mailto:)/.test(pay.sub);
}

/* ── 준비 ── */
const A = (await call("owner-setup", { loginId: "boss01", pw: "pass1234", name: "김대표", workspace: "하루 디자인" })).j.token;
await call("member/create", { loginId: "staff01", pw: "pw123456", name: "민 매니저", role: "staff" }, A);
await call("member/create", { loginId: "part01", pw: "pw123456", name: "외주 박", role: "partner" }, A);
await call("member/create", { loginId: "alba01", pw: "pw123456", name: "알바 최", role: "worker" }, A);
const S = (await call("login", { loginId: "staff01", pw: "pw123456" })).j.token, P = (await call("login", { loginId: "part01", pw: "pw123456" })).j.token, W = (await call("login", { loginId: "alba01", pw: "pw123456" })).j.token;
const st0 = (await call("state", null, A)).j, meA = st0.me, meS = (await call("state", null, S)).j.me, meP = (await call("state", null, P)).j.me, meW = (await call("state", null, W)).j.me;

/* ── 처음 상태 ── */
let r = await call("nt/list", null, A);
ok(r.s === 200 && r.j.items.length === 0 && r.j.unread === 0 && r.j.push.open === false && r.j.push.key === "" && r.j.push.devices === 0, "empty list, push closed by default");
ok(r.j.prefs.off.length === 0 && r.j.prefs.quiet[0] === 22 && r.j.prefs.quiet[1] === 8 && r.j.prefs.digest === "08:30", "default prefs");
const devA = device();
r = await call("nt/sub", devA.sub, A); ok(r.s === 403 && r.j.error === "push-closed", "cannot register a device while push is closed");
r = await call("nt/test", {}, A); ok(r.s === 403 && r.j.error === "push-closed", "test push refused while closed");
r = await call("nt/list", null, null); ok(r.s === 401, "needs login");

/* ── 운영자가 푸시를 엽니다 ── */
r = await call("admin/settings", { op: "save", settings: { feat: { push: true } } }, S); ok(r.s === 403, "staff of operator ws without op role cannot change platform");
r = await call("admin/settings", { op: "save", settings: { feat: { push: true } } }, A); ok(r.s === 200 && r.j.platform.feat.push === true && r.j.platform.signup === "approve", "operator opens push, other settings kept");
r = await call("admin/settings", { op: "save", settings: { contact: "help@example.com" } }, A); ok(r.j.platform.feat.push === true && r.j.platform.contact === "help@example.com", "push switch survives other saves");
r = await call("nt/list", null, A); const PUB = r.j.push.key;
ok(r.j.push.open === true && unb(PUB).length === 65 && unb(PUB)[0] === 4, "server key is an uncompressed P-256 point");
r = await call("nt/list", null, S); ok(r.j.push.key === PUB, "same key for everyone");

/* ── 기기 등록 ── */
r = await call("nt/sub", { endpoint: "https://evil.example.com/x", keys: devA.sub.keys }, A); ok(r.s === 400 && r.j.error === "bad-sub", "only browser push servers are accepted");
r = await call("nt/sub", { endpoint: "http://fcm.googleapis.com/fcm/send/x", keys: devA.sub.keys }, A); ok(r.s === 400, "https only");
r = await call("nt/sub", { endpoint: devA.sub.endpoint, keys: { p256dh: "AAAA", auth: devA.sub.keys.auth } }, A); ok(r.s === 400, "bad key refused");
r = await call("nt/sub", devA.sub, A); ok(r.s === 200 && r.j.devices === 1, "device registered");
r = await call("nt/sub", devA.sub, A); ok(r.j.devices === 1, "same device twice stays one");
const devS = device("https://web.push.apple.com/"), devS2 = device("https://updates.push.services.mozilla.com/wpush/v2/");
r = await call("nt/sub", devS.sub, S); ok(r.j.devices === 1, "staff device (apple)");
r = await call("nt/sub", devS2.sub, S); ok(r.j.devices === 2, "staff second device (mozilla)");

/* ── 시험 알림 — 암호화와 서명이 규격에 맞는지 ── */
sentPush.length = 0;
r = await call("nt/test", {}, A);
ok(r.s === 200 && r.j.sent === 1 && r.j.devices === 1 && sentPush.length === 1, "test push sent to my one device");
let m = sentPush[0];
ok(m.url === devA.sub.endpoint && m.headers["content-encoding"] === "aes128gcm" && m.headers.ttl === "86400" && m.headers["content-type"] === "application/octet-stream", "push headers");
ok(vapidOk(m.headers.authorization, PUB, m.url), "VAPID signature verifies with the published key");
let o = openPush(devA, m.body);
ok(o.rs === 4096 && o.idlen === 65 && o.delim === 2 && o.json.t === "마이웍스 알림이 켜졌습니다" && o.json.u === "#/dashboard" && o.json.g === "test", "payload decrypts (RFC 8291) " + JSON.stringify(o.json));
ok(m.body.length < 4096, "single record");
let bad = false; try { openPush(devS, m.body); } catch (e) { bad = true; } ok(bad, "another device cannot read it");
r = await call("nt/test", {}, P); ok(r.s === 400 && r.j.error === "no-device", "no device → clear error");

/* ── 업무를 맡기면 받는 사람에게 ── */
const now = new Date().toISOString();
const pj = { id: "p1", name: "카페 리뉴얼", status: "진행중", ownerId: meA, memberIds: [meS, meP], createdAt: now, updatedAt: now };
await call("push", { ops: [{ kind: "project", id: "p1", data: pj }] }, A);
sentPush.length = 0;
r = await call("push", { ops: [{ kind: "task", id: "t1", data: { id: "t1", title: "시안 2종 만들기", projectId: "p1", assigneeId: meS, status: "대기", createdAt: now, updatedAt: now } }, { kind: "task", id: "t0", data: { id: "t0", title: "내 일", projectId: "p1", assigneeId: meA, status: "대기", createdAt: now, updatedAt: now } }] }, A);
ok(r.j.saved === 2, "tasks saved");
r = await call("nt/list", null, S);
ok(r.j.unread === 1 && r.j.items[0].type === "task" && r.j.items[0].title === "새 업무가 배정되었습니다" && r.j.items[0].body === "시안 2종 만들기" && r.j.items[0].url === "#/board" && !r.j.items[0].read_at, "assignee gets it " + JSON.stringify(r.j.items[0]));
ok(sentPush.length === 2 && sentPush.every(x => [devS.sub.endpoint, devS2.sub.endpoint].includes(x.url)), "pushed to both of the assignee's devices, not to the sender");
o = openPush(devS, sentPush.find(x => x.url === devS.sub.endpoint).body); ok(o.json.t === "새 업무가 배정되었습니다" && o.json.b === "시안 2종 만들기", "push body matches");
ok(vapidOk(sentPush.find(x => x.url === devS.sub.endpoint).headers.authorization, PUB, devS.sub.endpoint) && vapidOk(sentPush.find(x => x.url === devS2.sub.endpoint).headers.authorization, PUB, devS2.sub.endpoint), "audience differs per push server");
r = await call("nt/list", null, A); ok(r.j.items.filter(x => x.type === "task").length === 0, "no notice for my own task");
sentPush.length = 0;
await call("push", { ops: [{ kind: "task", id: "t1", data: { id: "t1", title: "시안 2종 만들기", projectId: "p1", assigneeId: meS, status: "진행중", createdAt: now, updatedAt: now } }] }, A);
r = await call("nt/list", null, S); ok(r.j.unread === 1 && sentPush.length === 0, "same assignee again → no second notice");
r = await call("sync?since=0", null, S); ok(r.j.badges.nt === 1, "unread count rides on sync badges");
r = await call("sync?since=0", null, P); ok(r.j.badges.nt === undefined, "no badge when nothing unread");
// 여러 건을 한 번에
await call("push", { ops: [1, 2, 3, 4].map(i => ({ kind: "task", id: "tb" + i, data: { id: "tb" + i, title: "묶음 " + i, projectId: "p1", assigneeId: meP, status: "대기", createdAt: now, updatedAt: now } })) }, A);
r = await call("nt/list", null, P); ok(r.j.items.length === 1 && r.j.items[0].title === "업무 4건이 배정되었습니다" && r.j.items[0].body === "묶음 1 · 묶음 2 · 묶음 3 외", "bulk assignment → one notice " + r.j.items[0].body);
// 검토 요청 → 프로젝트 책임자
sentPush.length = 0;
r = await call("push", { ops: [{ kind: "task", id: "tb1", data: { id: "tb1", title: "묶음 1", projectId: "p1", assigneeId: meP, status: "검토", createdAt: now, updatedAt: now } }] }, P);
ok(r.j.saved === 1, "partner moves own task to review");
r = await call("nt/list", null, A); ok(r.j.items[0] && r.j.items[0].title === "검토를 기다리는 업무가 있습니다" && r.j.items[0].body === "묶음 1", "project owner hears about review");
ok(sentPush.length === 1 && sentPush[0].url === devA.sub.endpoint, "owner device pushed");
await call("push", { ops: [{ kind: "task", id: "tb1", data: { id: "tb1", title: "묶음 1 (수정)", projectId: "p1", assigneeId: meP, status: "검토", createdAt: now, updatedAt: now } }] }, P);
r = await call("nt/list", null, A); ok(r.j.items.filter(x => x.title.startsWith("검토")).length === 1, "still in review → not repeated");
// 의견
sentPush.length = 0;
await call("push", { ops: [{ kind: "comment", id: "c1", data: { id: "c1", projectId: "p1", memberId: meS, text: "로고는 왼쪽 정렬이 낫겠습니다", ts: "11/20 10:00" } }] }, S);
r = await call("nt/list", null, A); ok(r.j.items[0].title === "민 매니저 님이 의견을 남겼습니다" && r.j.items[0].body.startsWith("카페 리뉴얼 — 로고는") && r.j.items[0].url === "#/project/p1", "comment → owner " + r.j.items[0].body);
r = await call("nt/list", null, P); ok(r.j.items[0].title === "민 매니저 님이 의견을 남겼습니다", "comment → other project member");
r = await call("nt/list", null, S); ok(!r.j.items.some(x => x.title.includes("의견")), "not to the author");
await call("push", { ops: [{ kind: "comment", id: "c1", data: { id: "c1", projectId: "p1", memberId: meS, text: "로고는 왼쪽 정렬이 낫겠습니다", ts: "11/20 10:00" } }] }, S);
r = await call("nt/list", null, A); ok(r.j.items.filter(x => x.title.includes("의견")).length === 1, "same comment pushed again → no repeat");

/* ── 읽음 ── */
r = await call("nt/list", null, A); const unreadA = r.j.unread, firstId = r.j.items[0].id;
r = await call("nt/read", { ids: [firstId] }, A); ok(r.j.unread === unreadA - 1, "mark one read");
r = await call("nt/read", { ids: [firstId] }, S); r = await call("nt/list", null, S); ok(r.j.unread === 1, "cannot read others' items");
r = await call("nt/read", {}, A); ok(r.s === 400, "needs ids or all");
r = await call("nt/read", { all: true }, A); ok(r.j.unread === 0, "mark all read");
r = await call("sync?since=0", null, A); ok(r.j.badges.nt === undefined, "badge cleared");

/* ── 끈 종류 · 방해 금지 시간 — 알림함에는 쌓이고 푸시만 가지 않습니다 ── */
r = await call("nt/prefs", { prefs: { off: ["task", "nope"], quiet: null, digest: "07:00" } }, S);
ok(r.j.prefs.off.join() === "task" && r.j.prefs.quiet === null && r.j.prefs.digest === "07:00", "prefs saved and cleaned");
sentPush.length = 0;
await call("push", { ops: [{ kind: "task", id: "t2", data: { id: "t2", title: "꺼 둔 종류", projectId: "p1", assigneeId: meS, status: "대기", createdAt: now, updatedAt: now } }] }, A);
r = await call("nt/list", null, S); ok(r.j.items[0].body === "꺼 둔 종류" && sentPush.length === 0, "type switched off → inbox only");
const hourNow = new Date(Date.now() + 9 * 3600e3).getUTCHours();
r = await call("nt/prefs", { prefs: { off: [], quiet: [hourNow, (hourNow + 1) % 24], digest: "" } }, S); ok(r.j.prefs.digest === "" && r.j.prefs.quiet[0] === hourNow, "quiet hours set to now, digest off");
await call("push", { ops: [{ kind: "task", id: "t3", data: { id: "t3", title: "조용한 시간", projectId: "p1", assigneeId: meS, status: "대기", createdAt: now, updatedAt: now } }] }, A);
r = await call("nt/list", null, S); ok(r.j.items[0].body === "조용한 시간" && sentPush.length === 0, "quiet hours → inbox only");
r = await call("nt/test", {}, S); ok(r.j.sent === 2, "test push ignores quiet hours");
r = await call("nt/prefs", { prefs: { off: [], quiet: [(hourNow + 2) % 24, (hourNow + 3) % 24] } }, S); ok(r.j.prefs.digest === "08:30", "digest back to default when not given");

/* ── 확인 링크에 답하면 보낸 사람에게 ── */
await call("push", { ops: [{ kind: "task", id: "t9", data: { id: "t9", title: "로고 최종본", projectId: "p1", assigneeId: meA, status: "검토", review: "requested", deliverables: [{ name: "logo.pdf", url: "https://example.com/logo.pdf" }], createdAt: now, updatedAt: now } }] }, A);
r = await call("link/create", { kind: "delivery", target: "t9" }, S); const LT = r.j.token || (r.j.link && r.j.link.token);
ok(!!LT, "delivery link made by staff " + JSON.stringify(r.j).slice(0, 120));
sentPush.length = 0;
r = await call("link/act", { t: LT, action: "change", note: "색을 조금 더 밝게 부탁드립니다", by: "이고객" });
ok(r.s === 200 && r.j.status === "changed", "client asks for a change");
r = await call("nt/list", null, S);
ok(r.j.items[0].type === "reply" && r.j.items[0].title === "납품 수정 요청이 왔습니다" && r.j.items[0].body === "이고객 — 색을 조금 더 밝게 부탁드립니다" && r.j.items[0].url === "#/board", "link reply → the member who sent it " + JSON.stringify(r.j.items[0]));
ok(sentPush.length === 2, "and pushed");
o = openPush(devS2, sentPush.find(x => x.url === devS2.sub.endpoint).body); ok(o.json.t === "납품 수정 요청이 왔습니다" && o.json.g.startsWith("link:"), "push tag groups by link");

/* ── 참여 요청 → 관리자 ── */
const inv = st0.ws.invite;
r = await call("signup", { mode: "join", loginId: "newbie1", pw: "pw123456", name: "새 사람", code: inv, agree: true });
ok(r.j.status === "pending", "join request " + JSON.stringify(r.j));
r = await call("nt/list", null, A); ok(r.j.items[0].type === "team" && r.j.items[0].title === "참여 요청이 들어왔습니다" && r.j.items[0].url === "#/members", "admin hears about the join request");
r = await call("nt/list", null, S); ok(!r.j.items.some(x => x.type === "team"), "staff does not");
/* ── 새 워크스페이스 신청 · 문의 → 운영팀 ── */
r = await call("signup", { mode: "new", loginId: "other01", pw: "pw123456", name: "다른 대표", workspace: "다른 회사", contact: "010-0000-0000", agree: true });
ok(r.j.status === "pending", "new workspace pending");
r = await call("nt/list", null, A); ok(r.j.items[0].type === "sys" && r.j.items[0].title === "새 워크스페이스 개설 신청이 들어왔습니다" && r.j.items[0].body === "다른 회사 · 다른 대표", "operator hears about it");
r = await call("fb/send", { kind: "idea", body: "문자 보내기가 있으면 좋겠습니다" }, S);
r = await call("nt/list", null, A); ok(r.j.items[0].title === "새 문의가 들어왔습니다", "operator hears about feedback");
const fbId = (await call("admin/fb", {}, A)).j.items[0].id;
r = await call("admin/fb", { op: "save", id: fbId, reply: "다음 판에 들어갑니다", status: "done" }, A);
r = await call("nt/list", null, S); ok(r.j.items[0].title === "문의에 답변이 달렸습니다" && r.j.items[0].body === "다음 판에 들어갑니다", "asker hears about the reply");
r = await call("admin/fb", { op: "save", id: fbId, status: "done" }, A);
r = await call("nt/list", null, S); ok(r.j.items.filter(x => x.title === "문의에 답변이 달렸습니다").length === 1, "saving again without a new reply → no repeat");

/* ── AI 제안 — 잇달아 올려도 한 번 ── */
r = await call("token/create", { name: "클로드", scope: "write" }, A); const TK = r.j.token;
const ai = async body => { const req = new Request("https://myworks.ai.kr/api/ai/propose", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + TK }, body: JSON.stringify(body) }); return (await onRequest({ request: req, env: ENV, next: async () => null })).json(); };
await call("nt/read", { all: true }, A);
let pr = await ai({ kind: "create-task", payload: { title: "견적서 보내기", project: "카페 리뉴얼" }, reason: "대화에서 약속" });
ok(pr.status === "pending", "proposal pending " + JSON.stringify(pr).slice(0, 100));
await ai({ kind: "create-task", payload: { title: "계약서 초안", project: "카페 리뉴얼" } });
await ai({ kind: "create-task", payload: { title: "일정 공유", project: "카페 리뉴얼" } });
r = await call("nt/list", null, A); ok(r.j.items.filter(x => x.type === "ai").length === 1 && r.j.unread === 1, "three proposals → one notice");

/* ── 매장: 시설 접수 · 청소 배정 ── */
await call("ws/modules", { modules: ["space"] }, A);
await call("push", { ops: [{ kind: "store", id: "s1", data: { id: "s1", name: "홍대점", status: "운영중", managerId: meA, memberIds: [meW], createdAt: now, updatedAt: now } }] }, A);
r = await call("sp/data", null, A);
await call("sp/prof", { sid: "s1", on: true }, A);
r = await call("sp/iss/save", { branch_id: "s1", title: "에어컨에서 물이 샙니다", priority: "긴급" }, W);
ok(r.s === 200, "worker reports an issue " + JSON.stringify(r.j).slice(0, 100));
r = await call("nt/list", null, A); ok(r.j.items[0].type === "store" && r.j.items[0].title === "[긴급] 시설 문제가 접수되었습니다" && r.j.items[0].url === "#/space/fac", "admin hears about the issue");
r = await call("nt/list", null, W); ok(!r.j.items.some(x => x.title.includes("시설")), "reporter is not notified");
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
r = await call("sp/asg/save", { date: today, branch_id: "s1", region: "", worker: meW }, A);
ok(r.s === 200, "assignment saved " + JSON.stringify(r.j).slice(0, 100));
r = await call("nt/list", null, W); ok(r.j.items[0] && r.j.items[0].title === "청소가 배정되었습니다", "worker hears about the assignment");

/* ── 예약 알림 맡기기 → tick ── */
const at = ms => new Date(Date.now() + ms).toISOString();
r = await call("nt/plan", { items: [
  { k: "due:t1", due: at(-10 * 60e3), type: "due", title: "오늘 마감 1건", body: "시안 2종 만들기", url: "#/board" },
  { k: "tax:vat", due: at(3 * 864e5), type: "money", title: "부가세 신고 3일 전", url: "#/tax/cal" },
  { k: "due:t1", due: at(-5 * 60e3), type: "due", title: "같은 열쇠 두 번" },
  { k: "old", due: at(-5 * 3600e3), title: "너무 지난 것" },
  { k: "far", due: at(60 * 864e5), title: "너무 먼 것" },
  { k: "", due: at(1000), title: "열쇠 없음" }, { k: "x", due: "언젠가", title: "날짜 아님" }, { k: "y", due: at(1000) }
] }, A);
ok(r.j.planned === 2, "plan keeps the valid ones " + r.j.planned);
r = await call("nt/plan", { items: [{ k: "s:late", due: at(-60e3), type: "digest", title: "오늘 할 일 3건 · 지연 1건", url: "#/dashboard" }] }, S);
await call("nt/read", { all: true }, A); await call("nt/read", { all: true }, S);
DB.raw.exec("UPDATE mw_meta SET v='00000000000000' WHERE k='tick'");   // 방금 tick이 돌았더라도 다시 돌 수 있게
sentPush.length = 0;
r = await call("tick");
ok(r.s === 200 && r.j.ran === true && r.j.due === 2, "tick delivers what is due " + JSON.stringify(r.j));
ok(r.j.sent === 3 && sentPush.length === 3, "pushed to A(1 device) and S(2 devices)");
o = openPush(devA, sentPush.find(x => x.url === devA.sub.endpoint).body); ok(o.json.t === "오늘 마감 1건" && o.json.b === "시안 2종 만들기", "scheduled push content");
ok(sentPush.find(x => x.url === devS.sub.endpoint).headers.urgency === "low", "digest goes out with low urgency");
r = await call("nt/list", null, A); ok(r.j.items[0].title === "오늘 마감 1건" && r.j.items[0].type === "due" && r.j.unread === 1, "and lands in the inbox");
r = await call("tick"); ok(r.j.ran === false, "second tick inside the gap does nothing");
DB.raw.exec("UPDATE mw_meta SET v='00000000000000' WHERE k='tick'");
r = await call("tick"); ok(r.j.ran === true && r.j.due === 0, "nothing left to send (future one stays)");
ok(DB.raw.prepare("SELECT COUNT(*) AS n FROM nt_sched").get().n === 1, "future reminder still planned");
r = await call("nt/plan", { items: [] }, A); ok(r.j.planned === 0 && DB.raw.prepare("SELECT COUNT(*) AS n FROM nt_sched").get().n === 0, "plan replaces the whole set");
// 묶음(ns)마다 따로 바꿉니다 — 세금 일정을 맡겨도 앱이 맡긴 것은 그대로
await call("nt/plan", { items: [{ k: "a", due: at(864e5), title: "앱이 맡긴 것" }] }, A);
r = await call("nt/plan", { ns: "tx", items: [{ k: "vat", due: at(2 * 864e5), type: "money", title: "부가세 신고 3일 전" }] }, A);
ok(r.j.planned === 1 && DB.raw.prepare("SELECT GROUP_CONCAT(k) AS k FROM (SELECT k FROM nt_sched ORDER BY k)").get().k === "app:a,tx:vat", "namespaces kept apart");
await call("nt/plan", { ns: "tx", items: [] }, A);
ok(DB.raw.prepare("SELECT GROUP_CONCAT(k) AS k FROM nt_sched").get().k === "app:a", "clearing one namespace leaves the other");
await call("nt/plan", { items: [] }, A);
// 다가오는 일 — 받을 돈 · 견적 유효기간
const kd = n => new Date(Date.now() + 9 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
DB.raw.exec(`INSERT INTO os_job(ws,id,client_name,title,status,created_at,updated_at) VALUES('${st0.ws.id}','j1','모노가구','브랜드 로고','billing','x','x')`);
DB.raw.exec(`INSERT INTO os_invoice(ws,id,job_id,no,amount,tax_mode,tax,net,due_date,status,created_at,updated_at) VALUES('${st0.ws.id}','v1','j1','INV-1',1000000,'vat',100000,1100000,'${kd(3)}','issued','x','x'),('${st0.ws.id}','v2','j1','INV-2',500000,'none',0,500000,'${kd(-2)}','issued','x','x'),('${st0.ws.id}','v3','j1','INV-3',1,'none',0,1,'${kd(1)}','paid','x','x'),('${st0.ws.id}','v4','j1','INV-4',1,'none',0,1,'${kd(40)}','issued','x','x')`);
DB.raw.exec(`INSERT INTO os_quote(ws,id,job_id,no,items,vat,supply,tax,total,valid_until,status,created_at,updated_at) VALUES('${st0.ws.id}','q1','j1','Q-1','[]',1,1,0,1,'${kd(5)}','sent','x','x'),('${st0.ws.id}','q2','j1','Q-2','[]',1,1,0,1,'${kd(5)}','approved','x','x')`);
r = await call("nt/upcoming", null, A);
ok(r.j.items.length === 2 && r.j.items[0].k === "inv:v1" && r.j.items[0].date === kd(3) && r.j.items[0].title === "입금 기한 — 모노가구 · 브랜드 로고" && r.j.items[1].k === "qt:q1" && r.j.late.length === 1 && r.j.late[0].k === "inv:v2", "upcoming: open invoice, open quote; overdue invoice listed as late " + JSON.stringify(r.j).slice(0, 200));
r = await call("nt/upcoming", null, W); ok(r.j.items.length === 0 && r.j.late.length === 0, "field worker gets nothing");
// 계정이 꺼진 사람의 예약은 보내지 않고 지웁니다
await call("nt/plan", { items: [{ k: "p:1", due: at(-60e3), title: "협력사 예약" }] }, P);
await call("member/update", { id: meP, active: false }, A);
DB.raw.exec("UPDATE mw_meta SET v='00000000000000' WHERE k='tick'");
r = await call("tick"); ok(r.j.due === 0 && DB.raw.prepare("SELECT COUNT(*) AS n FROM nt_sched").get().n === 0, "disabled member: dropped, not sent " + JSON.stringify(r.j));

/* ── 지워진 구독은 정리 ── */
pushStatus = u => u === devS2.sub.endpoint ? 410 : 201;
r = await call("nt/test", {}, S); ok(r.j.sent === 1 && r.j.failed === 1, "one gone, one fine");
r = await call("nt/list", null, S); ok(r.j.push.devices === 1, "gone device removed");
pushStatus = 500;
for (let i = 0; i < 10; i++) await call("nt/test", {}, S);
r = await call("nt/list", null, S); ok(r.j.push.devices === 0, "ten failures in a row → removed");
pushStatus = 201;

/* ── 기기 끄기 · 닫기 ── */
r = await call("nt/unsub", { endpoint: devA.sub.endpoint }, S); ok(r.j.devices === 0, "cannot remove someone else's device");
r = await call("nt/list", null, A); ok(r.j.push.devices === 1, "A still has it");
r = await call("nt/unsub", { endpoint: devA.sub.endpoint }, A); ok(r.j.devices === 0, "device removed");
await call("nt/sub", devA.sub, A);
r = await call("admin/settings", { op: "save", settings: { feat: { push: false } } }, A); ok(r.j.platform.feat.push === false, "operator closes push");
sentPush.length = 0;
await call("push", { ops: [{ kind: "comment", id: "c2", data: { id: "c2", projectId: "p1", memberId: meS, text: "닫힌 뒤", ts: "x" } }] }, S);
r = await call("nt/list", null, A); ok(r.j.items[0].body.endsWith("닫힌 뒤") && sentPush.length === 0 && r.j.push.open === false && r.j.push.key === "", "closed → inbox only, key hidden");

/* ── 구성원을 지우면 그 사람의 알림·기기도 ── */
await call("admin/settings", { op: "save", settings: { feat: { push: true } } }, A);
await call("nt/sub", devS.sub, S);
ok(DB.raw.prepare("SELECT COUNT(*) AS n FROM nt_item WHERE member_id=?").get(meS).n > 0, "staff has items");
r = await call("member/delete", { id: meS }, A); ok(r.s === 200, "member deleted");
ok(["nt_item", "nt_sub", "nt_sched"].every(t => DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE member_id=?`).get(meS).n === 0) && DB.raw.prepare("SELECT COUNT(*) AS n FROM ws_set WHERE k=?").get("nt:" + meS).n === 0, "their notices, devices, plans and prefs are gone");

/* ── 로그인이 끝난 기기로는 보내지 않습니다 ── */
{
  await call("member/create", { loginId: "late01", pw: "pw123456", name: "늦게 온 직원", role: "staff" }, A);
  let L = (await call("login", { loginId: "late01", pw: "pw123456" })).j.token;
  const meL = (await call("state", null, L)).j.me, WSL = DB.raw.prepare("SELECT ws FROM accounts WHERE login_id='late01'").get().ws, devs = () => DB.raw.prepare("SELECT COUNT(*) AS n FROM nt_sub WHERE member_id=?").get(meL).n;
  r = await call("nt/sub", devS2.sub, L); ok(r.s === 200 && devs() === 1, "new member registers a device");
  sentPush.length = 0; r = await call("nt/test", {}, L); ok(r.j.sent === 1 && sentPush.length === 1, "and receives a push");
  // 로그인한 앱이 30일 넘게 다녀가지 않은 기기
  DB.raw.prepare("UPDATE nt_sub SET seen_at=? WHERE member_id=?").run(new Date(Date.now() - 31 * 864e5).toISOString(), meL);
  sentPush.length = 0; r = await call("nt/test", {}, L); ok(r.j.error === "no-device" && sentPush.length === 0, "a device the app has not visited for 30 days gets nothing " + JSON.stringify(r.j));
  await call("nt/sub", devS2.sub, L);
  sentPush.length = 0; r = await call("nt/test", {}, L); ok(r.j.sent === 1, "back once the app checks in again");
  // 비밀번호를 바꾸면
  r = await call("password", { old: "pw123456", pw: "pw7654321" }, L); ok(r.s === 200 && devs() === 0, "changing the password clears the registered devices " + r.s);
  await call("nt/sub", devS2.sub, L);
  // 운영자가 모든 기기에서 로그아웃시키면
  r = await call("admin/accounts", { op: "logout", loginId: "late01" }, A); ok(r.s === 200 && devs() === 0, "operator's log-out-everywhere clears them too " + r.s);
  L = (await call("login", { loginId: "late01", pw: "pw7654321" })).j.token;
  await call("nt/sub", devS2.sub, L); ok(devs() === 1, "registered again after logging back in");
  // 계정을 끄면
  await call("push", { ops: [{ kind: "task", id: "tL", data: { id: "tL", title: "꺼진 사람에게 맡긴 일", status: "대기", assigneeId: meL } }] }, A);
  r = await call("member/update", { id: meL, active: false }, A); ok(r.s === 200 && devs() === 0, "deactivating a member removes their devices");
  // 지워지지 않고 남은 등록이 있더라도 꺼진 계정으로는 보내지 않습니다
  DB.raw.prepare("INSERT INTO nt_sub(id,ws,member_id,endpoint,p256dh,auth,ua,created_at,fails,seen_at) VALUES('left1',?,?,?,?,?,'x',?,0,?)").run(WSL, meL, devS2.sub.endpoint, devS2.sub.keys.p256dh, devS2.sub.keys.auth, new Date().toISOString(), new Date().toISOString());
  sentPush.length = 0;
  await call("push", { ops: [{ kind: "task", id: "tL2", data: { id: "tL2", title: "또 맡긴 일", status: "대기", assigneeId: meL } }] }, A);
  ok(sentPush.length === 0, "nothing is pushed to a deactivated account even if a registration is left over");
}

globalThis.fetch = realFetch;
ok(maxQ < 50, `queries per request stay under 50 (max ${maxQ} at ${maxQPath})`);
console.log(`통과 ${pass} · 실패 ${failN} · 요청당 최대 쿼리 ${maxQ} (${maxQPath})`);
process.exit(failN ? 1 : 0);
