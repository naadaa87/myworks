// 알림·문자·홈택스·빠른 입력 브라우저 시험 — Playwright와 크롬이 있는 곳에서:
//   NODE_PATH=<playwright가 있는 node_modules> node tests/upgrade.e2e.mjs [스크린샷 폴더]
// 로컬 시험 서버를 바깥 서비스 흉내(MW_MOCK=1)와 함께 띄우고 화면을 눌러 봅니다. 바깥 주소는 모두 막습니다.
import { spawn } from "node:child_process"; import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = 8700 + Math.floor(Math.random() * 90), BASE = "http://localhost:" + PORT, SHOTS = process.argv[2] || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PB_SECRET = Buffer.from("mock-linkhub-secret-key-0123456789").toString("base64");
const srv = spawn(process.execPath, ["--no-warnings", path.join(ROOT, "tests/dev-server.mjs"), ROOT, String(PORT)], { stdio: ["ignore", "pipe", "ignore"], env: Object.assign({}, process.env, { MW_MOCK: "1", MW_VAULT_KEY: "a-long-enough-vault-key-2026", POPBILL_LINK_ID: "MYWORKSTEST", POPBILL_SECRET_KEY: PB_SECRET, POPBILL_TEST: "1" }) });
await new Promise(res => srv.stdout.on("data", d => String(d).includes("dev") && res()));
let browser = null;
const bye = code => { try { srv.kill(); } catch (e) {} if (browser) browser.close().catch(() => {}); setTimeout(() => process.exit(code), 300); };
let pass = 0, failN = 0, lastStep = "";
const stopped = e => { console.log("✗ 시험이 중간에 멈췄습니다:", String((e && e.message) || e).split("\n").slice(0, 3).join(" / "), "(‘" + lastStep + "’ 다음)"); console.log(`통과 ${pass} · 실패 ${failN + 1}`); bye(1); };
process.on("uncaughtException", stopped); process.on("unhandledRejection", stopped);
setTimeout(() => { console.log("✗ 시간 초과"); bye(1); }, Number(process.env.E2E_TIMEOUT || 300) * 1000).unref();
const ok = (c, m) => { lastStep = m; if (c) pass++; else { failN++; console.log("✗", m); } };
const api = async (p, body, token) => { const r = await fetch(BASE + "/api/" + p, { method: body ? "POST" : "GET", headers: Object.assign({ "content-type": "application/json" }, token ? { authorization: "Bearer " + token } : {}), body: body ? JSON.stringify(body) : undefined }); return r.json(); };
const kd = n => new Date(Date.now() + 9 * 3600e3 + n * 864e5).toISOString().slice(0, 10);

/* ── 데이터 ── */
const A = (await api("owner-setup", { loginId: "boss01", pw: "pass1234", name: "김하루", workspace: "하루 디자인" })).token;
await api("member/create", { loginId: "staff01", pw: "pw123456", name: "민 매니저", role: "staff" }, A);
const S = (await api("login", { loginId: "staff01", pw: "pw123456" })).token;
const meA = (await api("state", null, A)).me, meS = (await api("state", null, S)).me;

browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const errors = [];
/* 브라우저의 푸시 구독을 흉내 냅니다 — 진짜 푸시 서버(FCM)는 여기서 닿지 않습니다 */
const PUSH_STUB = () => {
  window.__perm = "default";
  try { Object.defineProperty(Notification, "permission", { get: () => window.__perm, configurable: true }); Notification.requestPermission = async () => (window.__perm = "granted"); } catch (e) {}
  let sub = null;
  const make = async opt => { const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]); const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)); const b = a => btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); const ep = "https://fcm.googleapis.com/fcm/send/e2e-" + Math.random().toString(36).slice(2); return { endpoint: ep, options: opt, toJSON: () => ({ endpoint: ep, keys: { p256dh: b(pub), auth: b(crypto.getRandomValues(new Uint8Array(16))) } }), unsubscribe: async () => { sub = null; return true; } }; };
  if (window.PushManager) { PushManager.prototype.subscribe = async function (opt) { sub = await make(opt); return sub; }; PushManager.prototype.getSubscription = async function () { return sub; }; }
};
async function open(token, vp, hash) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  await ctx.route(u => !u.href.startsWith(BASE), r => r.abort());
  await ctx.addInitScript(PUSH_STUB);
  const page = await ctx.newPage(); page.setDefaultTimeout(9000);
  page.on("pageerror", e => errors.push(String(e).slice(0, 240))); page.on("dialog", d => d.accept());
  await page.goto(BASE + "/app/"); await page.evaluate(t => localStorage.setItem("mw_token_v1", t), token); await page.reload();
  await page.waitForSelector("#app:not(.hidden)"); await page.waitForFunction(() => typeof NT !== "undefined" && NT._t.S.at > 0);
  if (hash) { await page.evaluate(h => { location.hash = h; }, hash); await page.waitForTimeout(400); }
  return page;
}
const shot = async (page, name, full) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + ".png"), fullPage: !!full }); };
const txt = (page, sel) => page.evaluate(s => { const el = document.querySelector(s); return el ? el.innerText.replace(/\s+/g, " ").trim() : ""; }, sel);
const toastOf = page => page.evaluate(() => document.querySelector("#toast").textContent);
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const PC = { width: 1280, height: 900 }, PHONE = { width: 390, height: 800 };

/* ═══ 1. 시작 안내 · 빠른 입력 · 찾기 ═══ */
let p = await open(A, PC);
ok(await p.evaluate(() => document.querySelector('link[rel="manifest"]').getAttribute("href")) === "/app/manifest.webmanifest", "앱 설치 정보(manifest)가 파일로 걸려 있음");
ok(await p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration("/app/"); return !!r; }), "서비스 워커 등록");
ok((await txt(p, "#start-card")).includes("어떤 일을 하시나요?") && (await p.locator("[data-start=pick]").count()) === 5, "새 워크스페이스: 하는 일 고르기 다섯 가지");
await shot(p, "01-start-pick");
await p.click('[data-start="pick"][data-k="create"]'); await p.waitForSelector(".start-steps");
ok((await txt(p, "#start-card")).includes("콘텐츠를 만들어요") && (await p.locator(".start-step").count()) === 4 && (await txt(p, "#nav-side")).includes("마이크리에이터"), "‘콘텐츠를 만들어요’ → 4단계가 나오고 마이크리에이터가 켜짐");
await p.click('[data-start="reset"]'); await p.waitForSelector("[data-start=pick]");
await p.click('[data-start="pick"][data-k="work"]'); await p.waitForSelector(".start-steps");
ok((await txt(p, ".start-step:first-child")).includes("고객 한 명 적기") && (await txt(p, "#start-card h2")).includes("0/4"), "다른 일로 바꾸기 → ‘의뢰받아 일해요’ 0/4");
await shot(p, "02-start-steps");
// 빠른 입력
await p.keyboard.press("Control+k"); await p.waitForSelector("#cmd-in");
ok((await txt(p, "#cmd-list")).includes("이렇게 적어 보세요"), "Ctrl+K로 빠른 입력 창이 열리고 예시가 보임");
await p.fill("#cmd-in", "내일까지 견적서 보내기"); await p.waitForSelector(".cmd-it");
ok((await txt(p, ".cmd-it.on")).includes("업무 추가 — 견적서 보내기") && (await txt(p, ".cmd-it.on")).includes("마감 내일") && (await txt(p, "#cmd-pjbox")).includes("내 업무"), "“내일까지 견적서 보내기” → 업무, 마감 내일, 담을 프로젝트");
await shot(p, "03-cmd-task");
await p.keyboard.press("Enter"); await p.waitForFunction(() => DB.tasks.length === 1);
await p.fill("#cmd-in", "점심 12,000원"); await p.waitForTimeout(120);
ok((await txt(p, ".cmd-it.on")).includes("지출 기록 — 12,000원"), "“점심 12,000원” → 지출이 먼저");
await p.keyboard.press("Enter"); await p.waitForFunction(() => DB.finance.length === 1);
await p.fill("#cmd-in", "입금 110만원 모노가구"); await p.waitForTimeout(120);
ok((await txt(p, ".cmd-it.on")).includes("수입 기록 — 1,100,000원"), "“입금 110만원 모노가구” → 수입이 먼저");
await p.keyboard.press("Enter"); await p.waitForFunction(() => DB.finance.length === 2);
await p.fill("#cmd-in", "이지수 010-2222-3333"); await p.waitForTimeout(120);
ok((await txt(p, ".cmd-it.on")).includes("연락처 추가 — 이지수"), "“이지수 010-2222-3333” → 연락처가 먼저");
await p.keyboard.press("Enter"); await p.waitForFunction(() => DB.contacts.length === 1);
const d1 = await p.evaluate(() => ({ t: DB.tasks[0], pj: projectById(DB.tasks[0].projectId).name, f: DB.finance.map(x => [x.kind, x.amount, x.memo, x.date === todayStr()].join("|")), c: DB.contacts[0] }));
ok(d1.t.title === "견적서 보내기" && d1.t.due === kd(1) && d1.t.assigneeId === meA && d1.pj === "내 업무", "업무: 제목·마감·담당·‘내 업무’ 프로젝트 " + JSON.stringify([d1.t.title, d1.t.due, d1.pj]));
ok(d1.f[0] === "지출|12000|점심|true" && d1.f[1] === "수입|1100000|모노가구|true", "돈: 지출·수입 기록 " + d1.f.join(" / "));
ok(d1.c.name === "이지수" && d1.c.phone === "010-2222-3333", "연락처 기록");
await p.fill("#cmd-in", "견적"); await p.waitForTimeout(150);
ok((await txt(p, "#cmd-list")).includes("찾은 것") && (await txt(p, "#cmd-list")).includes("업무 · 내 업무"), "같은 칸에서 찾기 — 방금 넣은 업무가 나옴");
await p.fill("#cmd-in", "이지수"); await p.waitForTimeout(150);
ok((await txt(p, "#cmd-list")).includes("연락처 · 010-2222-3333"), "연락처도 찾음");
await p.keyboard.press("Escape"); await p.waitForFunction(() => !document.querySelector("#modal-root").classList.contains("show"));
ok((await txt(p, "#view")).includes("견적서 보내기") || (await txt(p, "#view")).includes("1/4"), "창을 닫으면 뒤 화면이 새로 그려짐");
ok((await txt(p, "#start-card h2")).includes("1/4") && (await p.locator(".start-step.done").count()) === 1, "연락처를 적었더니 첫 단계가 끝난 것으로 표시 (1/4)");
ok(await overflow(p) <= 0, "PC: 홈 가로 넘침 없음");

/* ═══ 2. 알림함 · 푸시 ═══ */
// 직원이 관리자에게 업무를 맡기고 의견을 남깁니다
const now = new Date().toISOString();
await api("push", { ops: [{ kind: "project", id: "p9", data: { id: "p9", name: "카페 리뉴얼", status: "진행중", ownerId: meA, memberIds: [meS], createdAt: now, updatedAt: now } }] }, A);
await api("push", { ops: [{ kind: "task", id: "t9", data: { id: "t9", title: "시안 2종 만들기", projectId: "p9", assigneeId: meA, status: "대기", createdAt: now, updatedAt: now } }, { kind: "comment", id: "c9", data: { id: "c9", projectId: "p9", memberId: meS, text: "로고는 왼쪽 정렬이 낫겠습니다", ts: "11/20 10:00" } }] }, S);
await p.evaluate(() => pollSync(true)); await p.waitForFunction(() => NT._t.S.unread === 2);
ok((await txt(p, "#side-nt")).includes("2"), "왼쪽 ‘알림’에 안 읽은 수 2");
await p.click("#side-nt"); await p.waitForSelector("#nt-list .nt-it");
const inbox = await txt(p, "#nt-list");
ok(inbox.includes("새 업무가 배정되었습니다") && inbox.includes("시안 2종 만들기") && inbox.includes("민 매니저 님이 의견을 남겼습니다") && (await p.locator(".nt-it.new").count()) === 2, "알림함: 맡은 업무와 의견 두 건, 둘 다 새 알림");
await shot(p, "04-inbox");
ok(!(await txt(p, "#m-box")).includes("켜기"), "푸시가 닫혀 있으면 ‘켜기’ 안내가 없음");
await p.click('.nt-it:has-text("의견을 남겼습니다")'); await p.waitForFunction(() => location.hash === "#/project/p9");
ok(await p.evaluate(() => NT._t.S.unread) === 1 && (await txt(p, "#side-nt")).includes("1"), "알림을 누르면 그 화면으로 가고 읽음 처리");
await p.click("#side-nt"); await p.waitForSelector("#nt-list"); await p.click('[data-nt="set"]'); await p.waitForSelector("#nt-set");
ok((await txt(p, ".nt-dev")).includes("준비 중") && (await txt(p, ".nt-dev")).includes("총괄관리"), "알림 설정: 푸시가 닫혀 있다고 알리고, 운영자에게는 여는 곳을 안내");
ok((await p.locator(".nt-type").count()) === 9 && await p.isChecked("#nt-q-on") && await p.inputValue("#nt-d-at") === "08:30", "받을 알림 9가지, 방해 금지 켜짐, 아침 요약 8:30");
await shot(p, "05-nt-settings-closed");
// 운영자가 푸시를 엽니다
await p.click('[data-nt="admin"]'); await p.waitForSelector("#adm-feat-push");
await p.check("#adm-feat-push"); await p.click('[data-adm="feat-save"]'); await p.waitForFunction(() => document.querySelector("#toast").textContent.includes("푸시 알림을 열었습니다"));
ok((await api("nt/list", null, A)).push.open === true, "총괄관리 → 기능 열기에서 푸시를 엶");
await shot(p, "06-admin-feat", true);
await p.click("#side-nt"); await p.waitForSelector("#nt-list");
ok((await txt(p, ".nt-hint")).includes("이 기기에서 푸시 알림을 켜면"), "알림함에 ‘이 기기에서 켜기’ 안내가 나옴");
await p.click('[data-nt="set"]'); await p.waitForSelector("#nt-set");
ok((await txt(p, ".nt-dev")).includes("이 기기에서 푸시 알림 받기"), "알림 설정: 아직 꺼진 상태");
await p.click('.nt-dev [data-nt="on"]'); await p.waitForSelector(".nt-dev.on");
ok((await txt(p, ".nt-dev.on")).includes("받고 있습니다") && (await api("nt/list", null, A)).push.devices === 1, "켜기 → 권한 허용 → 기기 등록");
await shot(p, "07-nt-settings-on");
await p.click('[data-nt="test"]'); await p.waitForFunction(() => document.querySelector("#toast").textContent.includes("시험 알림을 보냈습니다"));
ok(true, "시험 알림 보내기");
await p.uncheck('.nt-type[value="digest"]'); await p.selectOption("#nt-q-from", "23"); await p.click('[data-nt="save"]'); await p.waitForFunction(() => document.querySelector("#toast").textContent.includes("알림 설정을 저장했습니다"));
const prefs = (await api("nt/list", null, A)).prefs;
ok(prefs.off.includes("digest") && prefs.quiet[0] === 23 && prefs.quiet[1] === 8 && prefs.digest === "08:30", "설정 저장: 아침 요약 푸시 끔, 방해 금지 23시부터 " + JSON.stringify(prefs));
// 푸시가 켜진 뒤 새 알림 → 서버가 이 기기로 보냄
await api("push", { ops: [{ kind: "comment", id: "c10", data: { id: "c10", projectId: "p9", memberId: meS, text: "색은 조금 더 밝게요", ts: "x" } }] }, S);
await p.evaluate(() => pollSync(true)); await p.waitForFunction(() => document.querySelector("#toast").textContent.includes("알림 ·"));
ok((await toastOf(p)).includes("의견을 남겼습니다"), "앱이 열려 있으면 새 알림을 화면 아래에 잠깐 보여 줌");
const planned = await p.evaluate(async () => { await NT.plan(true); return NT._t.planItems().map(x => x.k + "|" + x.title); });
ok(planned.some(x => x.startsWith("eve:" )) && planned.every(x => !x.includes("undefined")), "앞으로 챙길 것 맡기기: 내일 마감 업무의 전날 알림 " + JSON.stringify(planned));
ok(await p.evaluate(() => NT._t.pushState()) === "on", "네 번째 단계(휴대폰 알림)가 끝난 것으로 인식");

/* ═══ 3. 문자·알림톡 ═══ */
await p.evaluate(() => { location.hash = "#/data"; }); await p.waitForSelector(".conn-grid");
ok((await txt(p, ".conn-grid")).includes("문자·알림톡") && (await txt(p, ".conn-grid")).includes("휴대폰 알림"), "연동·데이터 맨 위에 연결 카드");
await p.click('.conn-card [data-nav="msg"]'); await p.waitForSelector("#mg-key");
ok((await txt(p, "#view")).includes("발송 계정 연결") && (await txt(p, "#view")).includes("마이웍스가 따로 받는 돈은 없습니다"), "연결 전: 세 걸음 안내");
await shot(p, "08-msg-connect");
await p.fill("#mg-key", "NCSTESTKEY000001"); await p.fill("#mg-secret", "wrong"); await p.click('[data-msg="connect"]'); await p.waitForFunction(() => document.querySelector("#toast").textContent.includes("모두 넣어"));
await p.fill("#mg-secret", "SECRETSECRET0001"); await p.click('[data-msg="connect"]'); await p.waitForSelector(".mg-conn");
ok((await p.evaluate(() => location.hash)) === "#/msg/set" && (await txt(p, ".mg-conn")).includes("연결되어 있습니다") && (await txt(p, ".mg-stat")).includes("010-1111-2222"), "연결 → 잔액·발신번호를 읽고 ‘연결·문구’로");
await p.waitForFunction(() => document.querySelectorAll(".mg-k").length > 0);
ok((await p.locator(".mg-tpl").count()) === 12 && (await p.locator(".mg-k").count()) === 12 && (await txt(p, "#mg-k-pf")).includes("하루 디자인"), "용도 12가지의 문구와 알림톡 연결, 카카오톡 채널 읽힘");
// 알림톡: 견적서 용도에 템플릿을 잇습니다
await p.selectOption('.mg-k[data-k="link.quote"] .mg-k-sel', "KA01TP000000000000001"); await p.waitForSelector('.mg-k[data-k="link.quote"] .mg-k-var');
const vars = await p.evaluate(() => [...document.querySelectorAll('.mg-k[data-k="link.quote"] .mg-k-var')].map(s => s.dataset.v + "=" + s.value));
ok(vars.join() === "상호=상호,이름=이름,제목=제목,코드=코드", "템플릿 변수가 같은 이름의 자리와 자동으로 이어짐 " + vars.join());
await p.check("#mg-k-on"); await p.click('[data-msg="k-save"]'); await p.waitForFunction(() => document.querySelector("#toast").textContent.includes("알림톡 연결을 저장"));
await shot(p, "09-msg-settings", true);
// 직접 보내기
await p.click('[data-msg="tab"][data-to=""]'); await p.waitForSelector("#mg-add");
await p.fill("#mg-add", "이지수"); await p.press("#mg-add", "Enter"); await p.waitForSelector(".mg-chip");
await p.fill("#mg-add", "010-9999-0000"); await p.press("#mg-add", "Enter"); await p.waitForFunction(() => document.querySelectorAll(".mg-chip").length === 2);
await p.fill("#mg-text", "[하루 디자인] {이름}님, 시안은 금요일까지 보내드리겠습니다.");
ok((await txt(p, "#mg-cnt")).includes("문자(SMS)") && (await txt(p, "#mg-cnt")).includes("/90바이트"), "글자 수(바이트)와 문자 종류 표시");
await p.fill("#mg-text", "[하루 디자인] {이름}님, 시안은 금요일까지 보내드리겠습니다. 수정할 부분이 있으면 편하게 말씀해 주세요.");
ok((await txt(p, "#mg-cnt")).includes("긴 문자(LMS)"), "90바이트를 넘으면 긴 문자");
await shot(p, "10-msg-send");
await p.click('[data-msg="sendmany"]'); await p.waitForFunction(() => document.querySelector("#toast").textContent.includes("2명에게 보냈습니다"));
await p.click('[data-msg="tab"][data-to="log"]'); await p.waitForSelector(".mg-lrow");
const logTxt = await txt(p, ".mg-log");
ok((await p.locator(".mg-lrow").count()) === 2 && logTxt.includes("이지수님, 시안은") && logTxt.includes("고객님, 시안은") && logTxt.includes("보냄"), "보낸 기록 2건 — {이름}이 받는 사람 이름으로 바뀜");
// 견적 링크 → 문자·알림톡
await p.evaluate(() => flushPush());   // 화면에서 적은 연락처가 서버에 올라간 뒤에
const job = (await api("os/job/save", { title: "브랜드 로고 디자인", client_id: (await p.evaluate(() => DB.contacts[0].id)), amount: 1100000 }, A)).job;
await api("os/quote/save", { job_id: job.id, items: [{ title: "로고 시안 3종", qty: 1, unit: 1000000 }], vat: true, valid_until: kd(14), status: "sent" }, A);
await p.evaluate(async () => { await pollSync(true); OUTS.refresh(true); location.hash = "#/outsourcing/quotes"; }); await p.waitForSelector('[data-os="quote-link"]');
await p.click('[data-os="quote-link"]'); await p.waitForSelector('#m-box [data-msg="compose"]');
await p.click('#m-box [data-msg="compose"]'); await p.waitForSelector("#mg-to");
const cm = await p.evaluate(() => ({ name: document.querySelector("#mg-name").value, to: document.querySelector("#mg-to").value, text: document.querySelector("#mg-text").value, k: !!document.querySelector("#mg-kakao") && document.querySelector("#mg-kakao").checked }));
ok(cm.name === "이지수" && cm.to === "010-2222-3333" && cm.text.includes("[하루 디자인] 이지수님, 요청하신 견적서를 보내드립니다.") && cm.text.includes("브랜드 로고 디자인") && /\/link\/[0-9a-f]{32}$/.test(cm.text.trim()) && cm.k === true, "견적 링크 창 → 받는 사람·문구·링크가 채워지고 알림톡이 골라져 있음");
await shot(p, "11-msg-compose");
await p.click('[data-msg="send1"]'); await p.waitForFunction(() => document.querySelector("#toast").textContent.includes("알림톡을 보냈습니다"));
const lg = (await api("msg/data", null, A)).log[0];
ok(lg.kind === "ata" && lg.tpl === "link.quote" && lg.ref_kind === "quote" && lg.to_name === "이지수" && lg.status === "sent", "알림톡으로 나가고 기록에 견적과 이어져 남음");
// 자동 안내
await p.evaluate(() => { location.hash = "#/msg/auto"; }); await p.waitForSelector(".mg-auto");
ok((await p.locator(".mg-auto").count()) === 4 && (await txt(p, ".mg-note")).includes("오전 9시부터 오후 8시"), "자동 안내 네 가지(마이스토어가 켜져 있어 예약 안내 포함)와 보내는 시간 안내");
await p.check('.mg-a-on[data-k="invDue"]'); await p.fill("#mg-a-invDue", "2"); await p.click('[data-msg="auto-save"]'); await p.waitForFunction(() => document.querySelector("#toast").textContent.includes("자동 안내를 저장"));
const au = (await api("msg/data", null, A)).settings.auto;
ok(au.invDue.on === true && au.invDue.days === 2 && au.invLate.on === false, "입금 기한 2일 전 안내만 켬");
await shot(p, "12-msg-auto", true);
ok(await overflow(p) <= 0, "PC: 문자·알림톡 가로 넘침 없음");

/* ═══ 4. 홈택스 자동 수집 ═══ */
await api("ws/modules", { modules: ["tax", "creator", "space"] }, A);
await api("tx/biz/save", { name: "하루 디자인", kind: "indiv", vat: "general", biz_no: "123-45-67890", industry: "디자인" }, A);
await p.evaluate(async () => { await pollSync(true); location.hash = "#/tax/docs"; }); await p.waitForSelector('[data-ht="setup"]');
ok((await txt(p, "#ht-card")).includes("홈택스 자동 수집") && (await txt(p, "#ht-card")).includes("123-45-67890") && (await txt(p, "#ht-card")).includes("시험 환경"), "증빙 탭에 홈택스 자동 수집 카드");
await p.click('[data-ht="setup"]'); await p.waitForSelector("#ht-addr");
ok((await txt(p, "#m-box")).includes("팝빌") && (await p.locator(".ht-step").count()) === 3, "잇기 창: 세 걸음, 어디로 정보가 가는지 밝힘");
await p.click('[data-ht="join"]'); await p.waitForFunction(() => /동의|빠진 칸/.test(document.querySelector("#toast").textContent));
await p.fill("#ht-ceo", "김하루"); await p.fill("#ht-addr", "서울 마포구 어울마당로 1"); await p.fill("#ht-type", "서비스"); await p.fill("#ht-ctel", "010-1111-2222"); await p.fill("#ht-cmail", "haru@example.com"); await p.check("#ht-agree");
await p.click('[data-ht="join"]'); await p.waitForSelector("#ht-did");
ok((await txt(p, ".ht-step.done")).includes("팝빌 아이디") && (await txt(p, ".ht-step.done")).includes("다시 보여 드리지 않으니"), "① 등록 끝 — 팝빌 계정을 한 번만 보여 줌");
await p.fill("#ht-did", "haru01"); await p.fill("#ht-dpw", "wrong"); await p.click('[data-ht="dept"]'); await p.waitForFunction(() => document.querySelector("#toast").textContent.includes("부서사용자 아이디 또는 비밀번호"));
ok(true, "② 틀린 비밀번호 → 수집 서비스가 준 사유를 그대로 보여 줌");
await p.fill("#ht-dpw", "Dept!Pass#2026"); await p.click('[data-ht="dept"]'); await p.waitForSelector('#m-box [data-ht="collect"]');
ok((await p.locator(".ht-step.done").count()) === 2 && (await txt(p, "#m-box")).includes("세금계산서와 현금영수증을 모두 가져옵니다"), "② 부서사용자 등록 — 두 가지 모두 가져올 수 있음");
await shot(p, "13-ht-setup");
await p.check('#m-box [data-ht-auto]'); await p.waitForFunction(() => document.querySelector("#toast").textContent.includes("날마다 아침에 자동으로"));
await p.click('#m-box [data-ht="collect"]'); await p.waitForSelector(".ht-spin");
ok((await txt(p, "#ht-card")).includes("가져오는 중"), "③ 지금 가져오기 → 가져오는 중 표시");
await p.waitForFunction(() => document.querySelectorAll("#view table.tbl tbody tr").length >= 7, null, { timeout: 40000 });
ok((await toastOf(p)).includes("새 증빙 7건") && (await txt(p, "#ht-card")).includes("새로 7건") && await p.isChecked("#ht-card [data-ht-auto]"), "7건이 증빙 대장에 들어오고, 카드에 마지막 수집과 ‘날마다 자동’ 표시");
const rows = await txt(p, "#view table.tbl tbody");
ok(rows.includes("모노가구") && rows.includes("문구나라") && rows.includes("계산서") && rows.includes("현금영수증") && rows.includes("-11,000"), "세금계산서·계산서·현금영수증, 취소 거래는 음수로");
await shot(p, "14-ht-docs", true);
ok(await overflow(p) <= 0, "PC: 증빙 탭 가로 넘침 없음");
await p.context().close();

/* ═══ 5. 직원 화면 · 휴대폰 ═══ */
p = await open(S, PHONE);
ok((await txt(p, "#tabbar")).replace(/\s+/g, " ").includes("홈") && (await p.locator("#tabbar button").count()) === 5 && (await txt(p, "#tabbar")).includes("전체") && (await txt(p, "#tabbar")).includes("입력"), "휴대폰: 아래 탭 다섯 칸 — 홈·보드·입력·돈·전체");
ok(!(await txt(p, "#view")).includes("어떤 일을 하시나요?"), "직원에게는 시작 안내가 나오지 않음");
await shot(p, "15-phone-home");
await p.click('#tabbar [data-g="menu"]'); await p.waitForSelector(".menu-grid");
const menu = await txt(p, ".menu-grid");
ok(menu.includes("마이택스") && menu.includes("마이크리에이터") && menu.includes("연동·데이터") && (await txt(p, ".menu-foot")).includes("문자·알림톡"), "‘전체’에 모든 메뉴와 알림·문자·설정");
await shot(p, "16-phone-menu");
await p.click('.menu-grid [data-nav="tax"]'); await p.waitForFunction(() => location.hash === "#/tax");
ok(await p.waitForFunction(() => document.querySelector("#tb-more").classList.contains("on"), null, { timeout: 4000 }).then(() => true, () => false), "아래 탭에 없는 메뉴로 가면 ‘전체’가 켜짐");
await p.click("#top-nt"); await p.waitForSelector("#nt-list");
ok((await txt(p, "#m-box")).includes("알림") && (await txt(p, ".nt-hint")).includes("켜기"), "휴대폰 위쪽 종 → 알림함, 푸시 켜기 안내");
await p.evaluate(() => closeModal());
await p.click('#tabbar [data-g="cmd"]'); await p.waitForSelector("#cmd-in");
await p.fill("#cmd-in", "다음 주 월요일 시안 검토"); await p.waitForSelector(".cmd-it");
ok((await txt(p, ".cmd-it.on")).includes("업무 추가 — 시안 검토") && (await txt(p, "#cmd-pjbox")).includes("카페 리뉴얼"), "휴대폰 ＋: 직원은 참여한 프로젝트에 업무를 담음");
await shot(p, "17-phone-cmd");
await p.keyboard.press("Enter"); await p.waitForFunction(() => DB.tasks.some(t => t.title === "시안 검토"));
await p.evaluate(() => closeModal());
for (const h of ["#/dashboard", "#/msg", "#/msg/set", "#/msg/auto", "#/tax/docs", "#/data"]) { await p.evaluate(x => { location.hash = x; }, h); await p.waitForTimeout(500); ok(await overflow(p) <= 0, "휴대폰 " + h + " 가로 넘침 없음 (" + (await overflow(p)) + ")"); }
await p.evaluate(() => { location.hash = "#/msg/set"; }); await p.waitForSelector(".mg-conn");
ok(!(await txt(p, "#view")).includes("연결 끊기") && await p.isDisabled("#mg-sign"), "직원은 연결·문구를 볼 수만 있음");
await p.evaluate(() => { location.hash = "#/tax/docs"; }); await p.waitForSelector("#ht-card .ht-row");
ok((await p.locator('#ht-card [data-ht="collect"]').count()) === 1 && (await p.locator('#ht-card [data-ht="setup"]').count()) === 0, "직원은 가져오기만 할 수 있고 잇기·설정은 없음");
await p.context().close();

ok(errors.length === 0, "화면 오류 없음 " + JSON.stringify(errors.slice(0, 3)));
console.log(`통과 ${pass} · 실패 ${failN}`);
bye(failN ? 1 : 0);
