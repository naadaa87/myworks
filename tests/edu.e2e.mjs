// 마이에듀 브라우저 시험 — Playwright와 크롬이 있는 곳에서:
//   NODE_PATH=<playwright가 있는 node_modules> CHROME=<크롬 경로> node tests/edu.e2e.mjs [스크린샷 폴더]
// 로컬 시험 서버(tests/dev-server.mjs)를 띄우고 데이터를 넣은 뒤 화면을 눌러 봅니다. 바깥 주소는 모두 막습니다.
import { spawn } from "node:child_process"; import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = 8800 + Math.floor(Math.random() * 90), BASE = "http://localhost:" + PORT, SHOTS = process.argv[2] || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const srv = spawn(process.execPath, ["--no-warnings", path.join(ROOT, "tests/dev-server.mjs"), ROOT, String(PORT)], { stdio: ["ignore", "pipe", "ignore"] });
await new Promise(res => srv.stdout.on("data", d => String(d).includes("dev") && res()));
let browser = null;
const bye = code => { try { srv.kill(); } catch (e) {} if (browser) browser.close().catch(() => {}); setTimeout(() => process.exit(code), 300); };
let pass = 0, failN = 0, lastStep = "";
const errors = [];
const stopped = e => { if (errors.length) console.log("  콘솔:", errors.slice(0, 3).join(" | ")); console.log("✗ 시험이 중간에 멈췄습니다:", String((e && e.message) || e).split("\n").slice(0, 3).join(" / "), "(‘" + lastStep + "’ 다음)"); console.log(`통과 ${pass} · 실패 ${failN + 1}`); bye(1); };
process.on("uncaughtException", stopped); process.on("unhandledRejection", stopped);
setTimeout(() => { console.log("✗ 시간 초과"); bye(1); }, Number(process.env.E2E_TIMEOUT || 420) * 1000).unref();
const ok = (c, m) => { lastStep = m; if (c) pass++; else { failN++; console.log("✗", m); } };
const api = async (p, body, token) => { const r = await fetch(BASE + "/api/" + p, { method: body ? "POST" : "GET", headers: Object.assign({ "content-type": "application/json" }, token ? { authorization: "Bearer " + token } : {}), body: body ? JSON.stringify(body) : undefined }); const j = await r.json(); if (!r.ok) throw new Error(p + " " + r.status + " " + JSON.stringify(j)); return j; };
const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (ds, n) => { const d = new Date(ds + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dowOf = ds => { const w = new Date(ds + "T00:00:00Z").getUTCDay(); return w === 0 ? 7 : w; };
const today = kst(), ym = today.slice(0, 7), W0 = dowOf(today), fmt = n => Math.round(n).toLocaleString("ko-KR");
const nextW = (w, n) => ((w - 1 + n) % 7) + 1;

/* ── 데이터 — 동네 수학 학원 ‘하늘수학’ ── */
const A = (await api("owner-setup", { loginId: "boss01", pw: "pass1234", name: "한원장", workspace: "하늘수학" })).token;
await api("ws/modules", { modules: ["edu", "tax", "people"] }, A);
const tch = (await api("member/create", { loginId: "teach01", pw: "pw123456", name: "김강사", role: "worker" }, A)).member.id;
await api("member/create", { loginId: "staff01", pw: "pw123456", name: "최실장", role: "staff" }, A);
await api("ed/settings", { set: { set: true, biz: { type: "academy", name: "하늘수학학원", owner: "한원장", no: "123-45-67890", phone: "02-333-4444", addr: "서울 마포구 서교동 1", bank: "국민 123-456-789 한원장" }, bill: { day: 1, due: 7, auto: false }, refund: "교습비는 학원법 시행령의 반환 기준에 따라 돌려드립니다." } }, A);
const C = {};
C.math = (await api("ed/class/save", { name: "중등 수학 A", subject: "수학", teacher_id: tch, cap: 8, fee: 300000, sched: [W0, nextW(W0, 2), nextW(W0, 4)].map(w => ({ w, s: "16:00", e: "17:30" })) }, A)).cls.id;
C.think = (await api("ed/class/save", { name: "초등 사고력", subject: "수학", cap: 6, fee: 220000, sched: [nextW(W0, 1), nextW(W0, 3)].map(w => ({ w, s: "14:30", e: "15:40" })) }, A)).cls.id;
C.late = (await api("ed/class/save", { name: "고등 심화", subject: "수학", teacher_id: tch, cap: 10, fee: 450000, sched: [{ w: nextW(W0, 1), s: "20:30", e: "22:30" }] }, A)).cls.id;
C.piano = (await api("ed/class/save", { name: "피아노 1:1", kind: "one", fee: 200000, fee_mode: "pack", pack_n: 4, sched: [{ w: W0, s: "19:00", e: "19:50" }] }, A)).cls.id;
await api("ed/stu/import", { rows: [
  { name: "김하늘", grade: "중2", school: "하늘중", g_name: "김엄마", g_phone: "010-2222-3333", classes: "중등 수학 A", start_date: ym + "-01" },
  { name: "박서준", grade: "중2", school: "하늘중", g_phone: "010-3333-4444", classes: "중등 수학 A", start_date: ym + "-01" },
  { name: "정우진", grade: "중1", g_phone: "010-7777-8888", classes: "중등 수학 A", start_date: ym + "-01" },
  { name: "오지민", grade: "초5", g_phone: "010-1212-3434", classes: "초등 사고력", start_date: ym + "-01" },
  { name: "윤서아", grade: "초4", g_phone: "010-5656-7878", classes: "초등 사고력", start_date: ym + "-01" },
  { name: "이준호", grade: "고2", g_phone: "010-9898-7676", classes: "고등 심화", start_date: ym + "-01" }
] }, A);
let D = await api("ed/data", null, A);
const sid = n => D.stus.find(s => s.name === n).id;
const lee = (await api("ed/stu/save", { name: "이도윤", grade: "성인", phone: "010-5555-6666", start_date: ym + "-01", enroll: [{ class_id: C.piano, base: 1 }] }, A)).stu.id;
await api("ed/bill/save", { stu_id: lee, kind: "pack", items: [{ label: "피아노 1:1 4회권", amount: 200000, class_id: C.piano, qty: 4 }], status: "issued" }, A);
const mathDays = Array.from({ length: 14 }, (_, i) => addDays(today, -(i + 1))).filter(d => [W0, nextW(W0, 2), nextW(W0, 4)].includes(dowOf(d))).slice(0, 4);   // 지난 수학 수업 네 번
for (const [i, dd] of mathDays.entries()) await api("ed/att/save", { date: dd, class_id: C.math, rows: [{ stu_id: sid("김하늘"), status: "in" }, { stu_id: sid("박서준"), status: i === 0 ? "abs" : "in" }, { stu_id: sid("정우진"), status: i < 2 ? "abs" : "late" }], les: { topic: "일차함수 " + (4 - i) + "차시", hw: "익힘책 " + (20 + i * 2) + "쪽" } }, A);
await api("ed/bill/gen", { ym }, A);
D = await api("ed/data", null, A);
const bKim = D.bills.find(b => b.stu_id === sid("김하늘") && b.kind === "month"), bPark = D.bills.find(b => b.stu_id === sid("박서준") && b.kind === "month");
await api("ed/bill/issue", { ids: D.bills.filter(b => b.status === "draft" && b.stu_id !== sid("윤서아")).map(b => b.id) }, A);
await api("ed/bill/paid", { id: bKim.id, method: "transfer", receipt: "", date: today }, A);
await api("ed/lead/save", { name: "한예린", grade: "초6", phone: "010-4545-6767", subject: "수학", src: "naver", status: "trial", next_date: today }, A);
await api("ed/lead/save", { name: "문지후", grade: "중3", phone: "010-1111-0000", src: "referral", status: "new" }, A);
await api("ed/note/save", { stu_id: sid("김하늘"), kind: "consult", title: "2학기 상담", body: "함수 단원 보충 권유" }, A);
const gTok = (await api("link/create", { kind: "ed-guard", target: sid("박서준"), days: 365 }, A)).token;
await api("ed/guard", { t: gTok, action: "msg", note: "다음 주부터 차량 이용할게요", name: "박아빠" });

/* ── 브라우저 ── */
browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] });
async function open(token, vp, hash) {
  const ctx = await browser.newContext({ viewport: vp || { width: 1280, height: 900 }, locale: "ko-KR", timezoneId: "Asia/Seoul", acceptDownloads: true });
  await ctx.route("**/*", r => (r.request().url().startsWith(BASE) || r.request().url().startsWith("about:") ? r.continue() : r.abort()));
  if (token) await ctx.addInitScript(t => { try { localStorage.setItem("mw_token_v1", t); } catch (e) {} }, token);
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  const page = await ctx.newPage();
  page.on("pageerror", e => errors.push("pageerror: " + e.message + " (‘" + lastStep.slice(0, 40) + "’ 다음)"));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR/.test(m.text())) errors.push("console: " + m.text()); });
  page.on("dialog", d => d.accept(d.type() === "prompt" ? "박아빠" : undefined));
  page.setDefaultTimeout(15000);
  await page.goto(BASE + (hash || "/app/#/edu"), { waitUntil: "domcontentloaded" });
  if (token) await page.waitForFunction(() => typeof ME !== "undefined" && !!ME && document.querySelector("#view") && document.querySelector("#view").textContent.trim().length > 10, null, { timeout: 20000 });
  return { ctx, page };
}
let { ctx, page } = await open(A);
const go = async h => { await page.evaluate(x => { location.hash = x; }, h); await page.waitForTimeout(350); };
const txt = (sel, pg) => (pg || page).evaluate(s => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }, sel);
const count = (sel, pg) => (pg || page).evaluate(s => document.querySelectorAll(s).length, sel);
const toastT = () => txt("#toast");
const shot = async (n, pg) => { if (SHOTS) await (pg || page).screenshot({ path: path.join(SHOTS, n + ".png"), fullPage: true }); };
const noOverflow = async (n, pg) => { const o = await (pg || page).evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })); ok(o.sw <= o.iw + 1, `가로 넘침 없음: ${n} (${o.sw}/${o.iw})`); };
const closeM = async () => { await page.evaluate(() => closeModal()); await page.waitForTimeout(150); };

/* 1. 오늘 */
await page.waitForSelector(".edx .sp-kpis");
ok((await txt("#nav-side [data-nav='edu']")).includes("마이에듀"), "메뉴에 마이에듀");
ok((await txt(".edx .sp-kpis .stat:nth-child(1) .s-num")).startsWith("7"), "다니는 학생 7명 " + (await txt(".edx .sp-kpis .stat:nth-child(1) .s-num")));
ok((await count(".edx .ed-cls")) === 2 && (await txt(".edx .ed-cls")).includes("중등 수학 A"), "오늘 수업 두 반 (수학·피아노)");
const acts = await page.evaluate(() => ED._t.attention().map(a => a.k));
ok(acts.includes("abs") && acts.includes("lead") && acts.includes("guard") && acts.includes("draft"), "챙길 것: 결석 두 번·상담 연락·보호자 글·초안 " + acts.join(","));
await shot("01-today");
/* 2. 출석 체크 */
await page.click(`.ed-cls[data-c="${C.math}"]`);
await page.waitForSelector(".ed-attm .ed-att-row");
ok((await count(".ed-att-row")) === 3, "명단 세 명");
await page.click('[data-ed="att-all"]');
ok((await count(".ed-att-seg button.on.in")) === 3, "모두 출석");
await page.click(`.ed-att-row[data-sid="${sid("정우진")}"] [data-v="abs"]`);
ok((await count(".ed-att-seg button.on.abs")) === 1, "한 명은 결석으로");
await page.fill("#ed-a-topic", "일차함수와 그래프"); await page.fill("#ed-a-hw", "익힘책 30쪽");
await page.click(`.ed-att-row[data-sid="${sid("박서준")}"] [data-v="late"]`);
await page.fill(`.ed-att-row[data-sid="${sid("박서준")}"] .ed-a-at`, "16:12");
await page.selectOption("#ed-a-extra", sid("오지민")); await page.click('[data-ed="att-extra"]');
ok((await count(".ed-att-row")) === 4 && (await count(".ed-att-seg button.on.make")) === 1, "보강 학생 더하기");
await shot("02-att");
await page.click('[data-ed="att-save"]'); await page.waitForTimeout(500);
ok((await toastT()).includes("4명"), "출결 저장 " + (await toastT()));
D = await api("ed/data", null, A);
const ta = D.atts.filter(a => a.date === today && a.class_id === C.math);
ok(ta.length === 4 && ta.find(a => a.stu_id === sid("박서준")).at === "16:12" && ta.find(a => a.stu_id === sid("오지민")).status === "make" && D.less.find(l => l.date === today && l.class_id === C.math).hw === "익힘책 30쪽", "서버에 출결·진도 저장");
ok((await txt(`.ed-cls[data-c="${C.math}"]`)).includes("3/3"), "오늘 수업 카드에 체크 수");
/* 3. 수강생 */
await go("#/edu/stu"); await page.waitForSelector(".ed-stu-tbl");
ok((await count(".ed-stu-tbl tbody tr")) === 7, "수강생 7명");
await page.fill("#ed-s-q", "김하늘"); await page.waitForTimeout(450);
ok((await count(".ed-stu-tbl tbody tr")) === 1, "찾기");
await page.fill("#ed-s-q", ""); await page.waitForTimeout(450);
await page.click(`.ed-stu-tbl tr[data-id="${sid("박서준")}"]`); await page.waitForSelector(".ed-sgrid");
ok((await txt(".ed-sgrid")).includes("중등 수학 A") && (await txt(".ed-sgrid")).includes("보호자가 남긴 글") && (await txt(".ed-sgrid")).includes("차량"), "수강생 상세: 반·기록·보호자 글");
await shot("03-stu");
await page.click('[data-ed="guard"]'); await page.waitForSelector("#m-box input[readonly]");
const gUrl = await page.$eval("#m-box input[readonly]", e => e.value);
ok(gUrl.endsWith("/link/" + gTok), "보호자 페이지 주소는 그대로 " + gUrl);
await closeM();
await page.click('[data-ed="stu-new"]'); await page.waitForSelector("#ed-f-name");
await page.fill("#ed-f-name", "송다은"); await page.fill("#ed-f-grade", "초3");
ok(await page.isChecked("#ed-f-minor"), "초등 학년이면 만 14세 미만 체크");
await page.fill("#ed-f-gphone", "010-3030-4040"); await page.check(`.ed-f-cls[value="${C.think}"]`);
await page.click('[data-ed="stu-save"]'); await page.waitForSelector(".ed-sgrid");
ok((await txt(".ed-sgrid")).includes("초등 사고력") && (await txt(".ed-sgrid")).includes("기록 없음"), "넣고 바로 상세 — 동의 기록 없음 표시");
await closeM();
/* 4. 명단 붙여넣기 */
await page.click('[data-ed="stu-import"]'); await page.waitForSelector("#ed-i-text");
await page.fill("#ed-i-text", "이름\t학년\t보호자연락처\t반\n강민재\t중3\t010-8080-9090\t중등 수학 A, 없는 반\n한소율\t초6\t010-6060-7070\t초등 사고력");
await page.waitForSelector("#ed-i-prev table");
ok((await txt("#ed-i-prev")).includes("2명") && (await txt("#ed-i-prev")).includes("없는 반"), "미리보기 — 없는 반 알림");
await page.click("#ed-i-go"); await page.waitForTimeout(800);
ok((await toastT()).includes("2명") && (await count(".ed-stu-tbl tbody tr")) === 10, "두 명 들어감 " + (await toastT()));
/* 5. 반·시간표 */
await go("#/edu/class"); await page.waitForSelector(".ed-tt");
ok((await count(".ed-tt-b")) === 7, "주간 시간표 블록 7개");
ok((await txt(".edx")).includes("22시까지인 지역"), "고등 심화 22시 넘김 경고");
await page.click('[data-ed="class-new"]'); await page.waitForSelector("#ed-c-name");
await page.fill("#ed-c-name", "토요 특강"); await page.selectOption("#ed-sc .ed-sc-w", "6"); await page.fill("#ed-sc .ed-sc-s", "10:00"); await page.fill("#ed-sc .ed-sc-e", "12:00");
await page.click('[data-ed="sc-add"]'); ok((await count("#ed-sc .ed-sc-row")) === 2, "요일 줄 더하기");
await page.click('#ed-sc .ed-sc-row:nth-child(2) [data-ed="sc-del"]');
await page.fill("#ed-c-fee", "120000"); await page.click('[data-ed="class-save"]'); await page.waitForTimeout(500);
ok((await count(".ed-tt-b")) === 8 && (await toastT()).includes("토요 특강"), "반 만들기");
await shot("05-class");
/* 6. 수강료 */
await go("#/edu/bill"); await page.waitForSelector(".ed-bill-tbl");
ok((await txt(".edx .sp-kpis .stat:nth-child(2) .s-num")).includes("30만"), "납부 30만원");
const nDraft = await count('.ed-bill-tbl input[data-ed="bsel"]');
ok(nDraft >= 1, "초안 고르기 칸 " + nDraft);
await page.click('[data-ed="bill-gen"]'); await page.waitForSelector("#m-box .ed-g-ck");
ok((await count("#m-box .ed-g-ck")) >= 3, "새로 들어온 학생 초안 미리보기 " + (await count("#m-box .ed-g-ck")));
await page.click('[data-ed="bill-gen-go"]'); await page.waitForTimeout(600);
ok((await toastT()).includes("초안"), "초안 만들기 " + (await toastT()));
await page.click('[data-ed="bsel-all"]'); await page.waitForTimeout(200);
await page.click('[data-ed="bill-issue"]'); await page.waitForSelector('[data-edq="yes"]'); await page.click('[data-edq="yes"]'); await page.waitForTimeout(600);
ok((await toastT()).includes("확정"), "고른 초안 확정 " + (await toastT()));
await page.click(`[data-ed="bill-paid"][data-id="${bPark.id}"]`); await page.waitForSelector("#ed-p-amt");
ok(await page.isVisible("#ed-p-hint"), "10만 원 이상 계좌이체 — 현금영수증 안내");
await page.selectOption("#ed-p-r", "done"); await page.click('[data-ed="paid-go"]'); await page.waitForTimeout(500);
const fin = await page.evaluate(id => (DB.finance || []).find(f => f.source === "edu" && f.edKey === "b:" + id), bPark.id);
ok(fin && fin.kind === "수입" && fin.amount === 300000 && fin.proof === "현금영수증" && fin.memo.includes("박서준"), "납부 → 돈 메뉴 수입 (현금영수증)");
await shot("06-bill");
await page.click(`.ed-bill-tbl tr[data-id="${bPark.id}"]`); await page.waitForSelector('[data-ed="refund"]');
await page.click('[data-ed="refund"]'); await page.waitForSelector("#ed-r-out .lk-amt");
await page.fill("#ed-r-all", "12"); await page.fill("#ed-r-done", "3"); await page.waitForTimeout(150);
ok((await txt("#ed-r-out")).includes("200,000원") && (await txt("#ed-r-out")).includes("2/3"), "반환 계산: 12회 중 3회 → 2/3 " + (await txt("#ed-r-out")));
await page.fill("#ed-r-done", "5"); await page.waitForTimeout(150); ok((await txt("#ed-r-out")).includes("150,000원"), "1/2 전 → 1/2");
await page.fill("#ed-r-done", "7"); await page.waitForTimeout(150); ok((await txt("#ed-r-out")).includes("0원") && (await txt("#ed-r-out")).includes("반환 없음"), "1/2 넘음 → 0원");
await page.fill("#ed-r-done", "3"); await page.fill("#ed-r-why", "이사"); await page.click('[data-ed="refund-go"]'); await page.waitForTimeout(500);
const rf = await page.evaluate(id => (DB.finance || []).find(f => f.source === "edu" && f.edKey === "r:" + id), bPark.id);
ok(rf && rf.kind === "지출" && rf.amount === 200000, "반환 → 돈 메뉴 지출");
await page.click(`.ed-bill-tbl tr[data-id="${bPark.id}"]`); await page.waitForSelector('[data-ed="receipt"]');
const [pop] = await Promise.all([page.waitForEvent("popup"), page.click('[data-ed="receipt"]')]);
await pop.waitForLoadState("domcontentloaded"); const pt = await pop.evaluate(() => document.body.innerText);
ok(pt.includes("영수증") && pt.includes("하늘수학학원") && pt.includes("123-45-67890") && pt.includes("박서준") && pt.includes("300,000원"), "영수증 인쇄 창");
await pop.close(); await closeM();
/* 7. 기록·리포트 */
await go("#/edu/note"); await page.waitForSelector(".seg");
ok((await txt(".edx")).includes("일차함수와 그래프"), "수업 기록 목록");
await page.click('[data-ed="nsub"][data-v="rep"]'); await page.waitForTimeout(300);
await page.click('[data-ed="rym"]:last-child'); await page.waitForTimeout(250);
const rymNow = await page.evaluate(() => ED._t.U.rym); if (rymNow !== ym) { await page.evaluate(m => { ED._t.U.rym = m; route(); }, ym); await page.waitForTimeout(250); }
await page.click(`[data-ed="rep-one"][data-sid="${sid("김하늘")}"]`); await page.waitForSelector("#ed-n-body");
const rb = await page.$eval("#ed-n-body", e => e.value);
ok(rb.includes("김하늘") && rb.includes("■ 출결") && rb.includes("일차함수와 그래프"), "리포트 초안: 출결·진도");
await page.check("#ed-n-share"); await page.click('[data-ed="note-save"]'); await page.waitForTimeout(500);
ok((await toastT()).includes("보호자 페이지에 보입니다"), "리포트 공개");
await shot("07-report");
/* 8. 상담 */
await go("#/edu/lead"); await page.waitForSelector(".ed-board");
ok((await count(".ed-lc")) === 2 && (await txt(".ed-board")).includes("오늘 체험"), "상담 보드");
await page.click(".ed-lc:has-text('한예린')"); await page.waitForSelector('[data-ed="lead-conv"]');
await page.click('[data-ed="lead-conv"]'); await page.waitForSelector(".ed-v-cls"); await page.check(`.ed-v-cls[value="${C.think}"]`);
await page.click('[data-ed="lead-conv-go"]'); await page.waitForSelector(".ed-sgrid");
ok((await txt(".ed-sgrid")).includes("초등 사고력") && (await txt("#m-box h2")).includes("한예린"), "등록으로 넘기면 수강생 상세가 열림");
await closeM();
/* 9. 운영 점검 · 설정 */
await go("#/edu/check"); await page.waitForSelector(".ed-ck");
ok((await txt(".edx")).includes("동의 기록이 없는") && (await txt(".edx")).includes("22시를 넘기는 반 1개") && (await txt(".edx")).includes("조회일이 없거나"), "운영 점검: 동의·교습 시간·강사 조회");
await page.fill(`.ed-ck-crime[data-id="${tch}"]`, today); await page.click('[data-ed="crime-save"]'); await page.waitForTimeout(500);
ok((await txt(".edx")).includes("모두 1년 안에 조회했습니다"), "강사 조회일 저장");
await shot("09-check");
await go("#/edu/set"); await page.waitForSelector("#ed-s-name");
await page.uncheck("#ed-s-gles"); await page.click('[data-ed="set-save"]'); await page.waitForTimeout(500);
ok((await api("ed/data", null, A)).settings.guard.les === false, "설정 저장");
await page.check("#ed-s-gles"); await page.click('[data-ed="set-save"]'); await page.waitForTimeout(400);
/* 10. 홈 · 확장판 */
await go("#/dashboard"); await page.waitForTimeout(700);
ok((await txt("#ed-dash-slot")).includes("오늘 수업") && (await txt("#ed-dash-slot")).includes("출석 체크"), "홈 요약 카드");
await go("#/ext"); await page.waitForTimeout(300);
ok((await txt("#view")).includes("보호자 페이지 — 시간표") && !(await txt(".ext-card[style*='B45309']")).includes("준비 예정"), "확장판 목록 — 마이에듀 켜짐");
/* 11. 보호자 페이지 (가입 없이) */
const g = await open(null, null, "/app/#/link/" + gTok);
await g.page.waitForSelector(".lk-head");
const gt = await txt("#lk-box", g.page);
ok(gt.includes("박서준") && gt.includes("하늘수학학원") && gt.includes("수업 시간") && gt.includes("일차함수와 그래프") && !gt.includes("010-"), "보호자 페이지: 이름·시간표·진도, 연락처 없음");
ok(gt.includes("반환 규정") && gt.includes("낸 수강료"), "반환 규정·낸 수강료");
await shot("11-guard", g.page);
const [gp] = await Promise.all([g.page.waitForEvent("popup"), g.page.click('[data-edg="receipt"]')]);
await gp.waitForLoadState("domcontentloaded"); ok((await gp.evaluate(() => document.body.innerText)).includes("영수증"), "보호자도 영수증"); await gp.close();
await g.page.fill("#ed-g-note", "병원 진료로 결석합니다"); await g.page.fill("#ed-g-name", "박엄마");
const absDay = (() => { for (let i = 1; i < 8; i++) { const d = addDays(today, i); if ([W0, nextW(W0, 2), nextW(W0, 4)].includes(dowOf(d))) return d; } })();
await g.page.fill("#ed-g-date", absDay); await g.page.click('[data-edg="send"]'); await g.page.waitForTimeout(600);
ok((await txt("#toast", g.page)).includes("알렸습니다"), "결석 미리 알리기");
D = await api("ed/data", null, A);
ok(D.atts.some(a => a.stu_id === sid("박서준") && a.date === absDay && a.status === "exc"), "그날 출결에 미리 알린 결석");
await g.ctx.close();
const g2 = await open(null, { width: 390, height: 844 }, "/app/#/link/" + (await api("link/create", { kind: "ed-guard", target: sid("정우진") }, A)).token);
await g2.page.waitForSelector(".lk-head");
ok((await count('[data-edg="paid"]', g2.page)) === 1, "낼 수강료에 ‘보냈어요’");
await g2.page.click('[data-edg="paid"]'); await g2.page.waitForTimeout(600);
ok((await txt("#lk-box", g2.page)).includes("보내셨다고 알려 드렸습니다"), "보냈어요 → 원장에게 알림");
await shot("12-m-guard", g2.page); await noOverflow("폰: 보호자 페이지", g2.page);
await g2.ctx.close();
await page.evaluate(() => pollSync(true)); await page.waitForTimeout(900);
await go("#/edu"); await page.waitForTimeout(1500);
ok((await page.evaluate(() => ED._t.attention().map(a => a.k))).includes("rep"), "원장 화면 — 보냈다고 알려 온 수강료");
/* 12. 강사 화면 */
const t1 = await open((await api("login", { loginId: "teach01", pw: "pw123456" })).token, { width: 390, height: 844 });
await t1.page.waitForSelector(".ed-cls");
ok((await txt("#view", t1.page)).includes("내 수업") && (await txt("#view", t1.page)).includes("중등 수학 A") && !(await txt("#view", t1.page)).includes("피아노"), "강사: 내 반만");
ok(!(await txt("#view", t1.page)).includes("010-") && !(await txt("#view", t1.page)).includes("300,000"), "강사: 연락처·수강료 없음");
await t1.page.click(`.ed-cls[data-c="${C.math}"]`); await t1.page.waitForSelector(".ed-att-row");
ok((await t1.page.evaluate(() => document.querySelectorAll(".ed-att-seg button.on").length)) >= 3, "강사도 오늘 출결이 보임");
await t1.page.click(`.ed-att-row[data-sid="${sid("정우진")}"] [data-v="exc"]`); await t1.page.click('[data-ed="att-save"]'); await t1.page.waitForTimeout(600);
ok((await txt("#toast", t1.page)).includes("저장"), "강사 출결 저장");
await shot("13-m-teacher", t1.page); await noOverflow("폰: 강사 화면", t1.page);
await t1.ctx.close();
/* 13. 휴대폰 */
await ctx.close();
({ ctx, page } = await open(A, { width: 390, height: 844 }));
await page.waitForSelector(".edx .sp-kpis"); await shot("14-m-today"); await noOverflow("폰: 오늘");
for (const [h, sel, n] of [["stu", ".ed-stu-tbl", "수강생"], ["class", ".ed-tt", "반·시간표"], ["bill", ".ed-bill-tbl", "수강료"], ["note", ".seg", "기록"], ["lead", ".ed-board", "상담"], ["check", ".ed-ck", "운영 점검"], ["set", "#ed-s-name", "설정"]]) { await go("#/edu/" + h); await page.waitForSelector(sel); await shot("15-m-" + h); await noOverflow("폰: " + n); }
await go("#/edu"); await page.waitForSelector(".ed-cls"); await page.click(`.ed-cls[data-c="${C.math}"]`); await page.waitForSelector(".ed-att-row");
ok(await page.evaluate(() => { const m = document.querySelector("#m-box"); return m.scrollWidth <= m.clientWidth + 1; }), "폰: 출석 체크 창이 화면 안에 들어감");
await shot("16-m-att");

ok(errors.length === 0, "콘솔 오류 없음" + (errors.length ? ": " + errors.slice(0, 4).join(" | ") : ""));
console.log(`통과 ${pass} · 실패 ${failN}`);
bye(failN ? 1 : 0);
