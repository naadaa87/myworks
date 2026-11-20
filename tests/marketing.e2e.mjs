// 마이마케팅 브라우저 시험 — Playwright와 크롬이 있는 곳에서:
//   NODE_PATH=<playwright가 있는 node_modules> node tests/marketing.e2e.mjs [스크린샷 폴더]
// 로컬 시험 서버(tests/dev-server.mjs)를 띄우고 데이터를 넣은 뒤 화면을 눌러 봅니다. 바깥 주소는 모두 막고, 엑셀 읽기 모듈만 XLSX_FILE에서 내줍니다.
import { spawn } from "node:child_process"; import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = 8700 + Math.floor(Math.random() * 200), BASE = "http://localhost:" + PORT, SHOTS = process.argv[2] || "";
const XLSX_FILE = process.env.XLSX_FILE || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const srv = spawn(process.execPath, ["--no-warnings", path.join(ROOT, "tests/dev-server.mjs"), ROOT, String(PORT)], { stdio: ["ignore", "pipe", "ignore"] });
await new Promise(res => srv.stdout.on("data", d => String(d).includes("dev") && res()));
let browser = null;
const bye = code => { try { srv.kill(); } catch (e) {} if (browser) browser.close().catch(() => {}); setTimeout(() => process.exit(code), 300); };
const stopped = e => { console.log("✗ 시험이 중간에 멈췄습니다:", String((e && e.message) || e).split("\n").slice(0, 3).join(" / ")); console.log(`통과 ${pass} · 실패 ${failN + 1}`); bye(1); };
process.on("uncaughtException", stopped);
process.on("unhandledRejection", e => { console.log("✗ 시험이 중간에 멈췄습니다:", String((e && e.message) || e).split("\n")[0]); console.log(`통과 ${pass} · 실패 ${failN + 1}`); bye(1); });
setTimeout(() => { console.log("✗ 시간 초과"); bye(1); }, Number(process.env.E2E_TIMEOUT || 360) * 1000).unref();
let pass = 0, failN = 0;
let lastStep = "";
const ok = (c, m) => { lastStep = m; if (c) pass++; else { failN++; console.log("✗", m); } };
const api = async (p, body, token) => { const r = await fetch(BASE + "/api/" + p, { method: body ? "POST" : "GET", headers: Object.assign({ "content-type": "application/json" }, token ? { authorization: "Bearer " + token } : {}), body: body ? JSON.stringify(body) : undefined }); return r.json(); };
const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (ds, n) => { const d = new Date(ds + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const today = kst(), fmt = n => Math.round(n).toLocaleString("ko-KR");

/* ── 데이터 넣기 ── */
const A = (await api("owner-setup", { loginId: "boss01", pw: "pass1234", name: "최대표", workspace: "하루공방" })).token;
await api("ws/modules", { modules: ["marketing", "tax", "people", "space", "commerce"] }, A);
await api("member/create", { loginId: "staff01", pw: "pw123456", name: "김직원", role: "staff" }, A);
await api("member/create", { loginId: "alba01", pw: "pw123456", name: "박알바", role: "worker" }, A);
await api("mk/settings", { set: { set: true, mode: "opt", budget: 1500000, biz: { type: "space", goal: "lead", aov: 120000, margin: 40, region: "홍대 합정", offer: "홍대입구역 3분, 20명까지 들어가는 파티룸" }, target: { cpa: 20000, roas: 0 } } }, A);
const ch = {};
for (const [k, name, kind, cat, handle] of [["sa", "네이버 파워링크", "naver_sa", "search"], ["meta", "인스타그램 광고", "meta_ads", "target"], ["ig", "인스타그램 @haru", "instagram", "content", "@haru"], ["place", "네이버 플레이스", "naver_place", "local"]])
  ch[k] = (await api("mk/chan/save", { name, kind, cat, handle }, A)).chan.id;
const cp = {};
cp.good = (await api("mk/camp/save", { name: "파티룸 지역 키워드", chan_id: ch.sa, cat: "search", goal: "lead", budget: 20000, budget_type: "day", landing: "https://example.com/party" }, A)).camp.id;
cp.bad = (await api("mk/camp/save", { name: "릴스 관심사 타겟", chan_id: ch.meta, cat: "target", goal: "lead", budget: 30000, budget_type: "day", landing: "https://example.com/reels" }, A)).camp.id;
cp.dead = (await api("mk/camp/save", { name: "브랜드 검색", chan_id: ch.sa, cat: "search", goal: "lead", budget: 5000, budget_type: "day", landing: "https://example.com/" }, A)).camp.id;
cp.place = (await api("mk/camp/save", { name: "플레이스 광고", chan_id: ch.place, cat: "local", goal: "visit", budget: 300000, status: "plan" }, A)).camp.id;
const rows = [];
for (let i = 1; i <= 40; i++) {
  const date = addDays(today, -i);
  rows.push({ date, camp_id: cp.good, cost: 18000, imp: 2500, clk: 60, conv: i % 2 ? 2 : 1 });
  rows.push({ date, camp_id: cp.bad, label: "소재A 후기", cost: 16000, imp: 7000, clk: 45, conv: i % 2 ? 1 : 0 });
  rows.push({ date, camp_id: cp.bad, label: "소재B 가격", cost: 12000, imp: 6000, clk: 25, conv: 0 });
  rows.push({ date, camp_id: cp.dead, cost: 3000, imp: 900, clk: 40, conv: 0 });
}
rows.push({ date: today, camp_id: cp.good, cost: 7000, imp: 900, clk: 22, conv: 1 });
const imp = await api("mk/stat/import", { rows, src: "file" }, A); ok(imp.added === rows.length, "seed stats " + JSON.stringify(imp));
await api("mk/stat/save", { date: addDays(today, -1), chan_id: ch.ig, view: 5400, eng: 310, fol: 1820 }, A);
await api("mk/post/save", { title: "11월 대관 후기 릴스", chan_id: ch.ig, date: addDays(today, 2), format: "릴스", status: "ready" }, A);
await api("mk/post/save", { title: "지난주 브라이덜 샤워 현장", chan_id: ch.ig, date: addDays(today, -20), format: "피드", status: "posted", view: 3200, eng: 240 }, A);
await api("mk/kw/import", { rows: [{ word: "홍대 파티룸", vol_pc: 1200, vol_mo: 9800, comp: "높음", state: "use" }, { word: "합정 소규모 모임", vol_pc: 90, vol_mo: 700, comp: "낮음" }, { word: "연남동 생일파티", vol_pc: 110, vol_mo: 1300, comp: "중간" }] }, A);
// 예상 숫자 (화면과 맞춰 볼 것)
const ym = today.slice(0, 7), monthRows = rows.filter(r => r.date.startsWith(ym)), mCost = monthRows.reduce((s, r) => s + r.cost, 0), mConv = monthRows.reduce((s, r) => s + r.conv, 0);
const last30 = rows.filter(r => r.date >= addDays(today, -29)), c30 = last30.reduce((s, r) => s + r.cost, 0), k30 = last30.reduce((s, r) => s + r.clk, 0), v30 = last30.reduce((s, r) => s + r.conv, 0), i30 = last30.reduce((s, r) => s + r.imp, 0);

/* ── 브라우저 ── */
browser = await chromium.launch({ executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"] });
const errors = [];
async function open(token, vp) {
  const ctx = await browser.newContext({ viewport: vp || { width: 1280, height: 900 }, locale: "ko-KR", timezoneId: "Asia/Seoul", acceptDownloads: true });
  await ctx.route("**/*", r => { const u = r.request().url(); if (u.startsWith(BASE)) return r.continue(); if (XLSX_FILE && u.includes("xlsx.full.min.js")) return r.fulfill({ status: 200, contentType: "application/javascript", body: fs.readFileSync(XLSX_FILE) }); return r.abort(); });
  await ctx.addInitScript(t => { try { localStorage.setItem("mw_token_v1", t); } catch (e) {} }, token);
  const page = await ctx.newPage();
  page.on("pageerror", e => errors.push("pageerror: " + e.message + " (‘" + lastStep.slice(0, 40) + "’ 다음)"));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR/.test(m.text())) errors.push("console: " + m.text()); });
  page.on("dialog", d => d.accept());
  page.setDefaultTimeout(15000);
  await page.goto(BASE + "/app/#/marketing", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof ME !== "undefined" && !!ME && document.querySelector("#view") && document.querySelector("#view").textContent.trim().length > 10, null, { timeout: 20000 });
  return { ctx, page };
}
const { ctx, page } = await open(A);
const go = async h => { await page.evaluate(x => { location.hash = x; }, h); await page.waitForTimeout(250); };
const txt = sel => page.evaluate(s => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }, sel);
const count = sel => page.evaluate(s => document.querySelectorAll(s).length, sel);
const toast = () => txt("#toast");
const shot = async n => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, n + ".png"), fullPage: true }); };
const noOverflow = async n => { const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })); ok(o.sw <= o.iw + 1, `가로 넘침 없음: ${n} (${o.sw}/${o.iw})`); };
const man = n => { n = Math.round(n); const a = Math.abs(n); return (a >= 1e8 ? (Math.round(a / 1e6) / 100).toLocaleString("ko-KR") + "억" : a >= 1e4 ? (Math.round(a / 1e3) / 10).toLocaleString("ko-KR") + "만" : a.toLocaleString("ko-KR")) + "원"; };

/* 1. 현황 */
await page.waitForSelector(".mkx .sp-kpis");
ok((await txt("#nav-side [data-nav='marketing']")).includes("마이마케팅"), "메뉴에 마이마케팅");
ok((await txt(".mkx .sp-kpis .stat:nth-child(1) .s-num")) === man(mCost), "이달 광고비 " + (await txt(".mkx .sp-kpis .stat:nth-child(1) .s-num")) + " = " + man(mCost));
ok((await txt(".mkx .sp-kpis .stat:nth-child(2) .s-num")).startsWith(String(mConv)), "이달 전환 " + mConv);
ok((await txt(".mkx .sp-kpis .stat:nth-child(1) .s-sub")).includes(Math.round(mCost / 1500000 * 100) + "%"), "예산 사용률");
ok(await count(".mk-bars .mk-bar") === 14, "14일 막대");
ok(await count(".mkx table.tbl tbody tr") >= 2, "채널별 표");
ok((await txt(".mkx")).includes("고칠 것"), "최적화 모드: 현황에 고칠 것");
const kl = await page.evaluate(() => [...document.querySelectorAll(".mkx .tx-kline")].map(e => e.textContent.replace(/\s+/g, " ").trim()));
ok(kl.length === 4 && kl[0].includes(Math.round(mCost / 1500000 * 100) + "%") && kl[1].includes(Math.round(20000 / (mCost / mConv) * 100) + "%") && kl[2].includes("75건") && kl[3].startsWith("설정 점검 최적화"), "목표 대비 카드: " + kl.join(" | "));
await shot("01-dash");

/* 2. 모드 → 부스터, 실행안 자동 대기열 */
await page.click('.mk-mode [data-v="boost"]'); await page.waitForTimeout(900);
ok((await toast()).includes("부스터"), "부스터 모드 전환");
await go("#/marketing/boost"); await page.waitForSelector(".mk-act");
const acts1 = await page.evaluate(() => MK._t.S.acts.map(a => ({ key: a.key, title: a.title, from: a.from_v, to: a.to_v, kind: a.kind })));
const move = acts1.find(a => a.key && a.key.startsWith("move:"));
ok(move && move.title.includes("릴스 관심사 타겟") && move.title.includes("파티룸 지역 키워드") && move.title.includes("4,000원"), "예산 옮기기 실행안: " + (move && move.title));
ok(move && move.from === "30,000원 → 26,000원" && move.to === "20,000원 → 24,000원", "옮기는 금액 " + (move && move.from + " / " + move.to));
ok(acts1.some(a => a.key.startsWith("stop:")), "전환 없는 캠페인 멈춤 실행안");
ok(acts1.some(a => a.key.startsWith("duel:") && a.title.includes("소재B 가격") && a.title.includes("소재A 후기")), "소재 겨루기 실행안");
ok(acts1.some(a => a.key.startsWith("creative:")), "소재 3개 이상 실행안");
ok(!acts1.some(a => a.key.startsWith("scale:") || a.key.startsWith("cut:")), "옮기기에 쓴 캠페인은 늘리기·줄이기를 따로 내지 않음");
ok(!acts1.some(a => a.key.startsWith("auto:")), "파워링크에는 자동화 상품 권유를 내지 않음");
const order = await page.evaluate(() => [...document.querySelectorAll(".mkx .card .mk-act h3")].map(h => h.textContent.replace(/\s+/g, " ").trim()));
ok(order[0].includes("멈추고") && order[1].includes("옮기기"), "돈이 새는 것부터: " + order.slice(0, 2).join(" → "));
ok((await txt(".sp-tabs [data-to='boost'] .nbadge")) === String(acts1.length), "부스터 탭 배지 " + acts1.length);
ok((await txt(".mkx .sp-kpis .stat:nth-child(1) .s-num")) === "2만원", "목표 전환당 비용 표시");
const vd = await page.evaluate(() => [...document.querySelectorAll(".mkx table.tbl tbody tr")].map(tr => tr.textContent.replace(/\s+/g, " ").trim()));
ok(vd.some(t => t.includes("파티룸 지역 키워드") && t.includes("늘리기")) && vd.some(t => t.includes("릴스 관심사 타겟") && t.includes("줄이기")) && vd.some(t => t.includes("브랜드 검색") && t.includes("멈춤")), "예산 판단 표");
// 숫자 검산: 좋은 캠페인의 14일 CPA = 252,000 ÷ 21 = 12,000 → 목표 20,000의 167%
ok(vd.some(t => t.includes("파티룸 지역 키워드") && t.includes("12,000원") && t.includes("167%")), "목표 대비 검산 " + vd.find(t => t.includes("파티룸 지역")));
await shot("02-boost");
// 했어요 → 한 일로
const nTodo = await count(".mk-act [data-v='done']");
await page.click(".mk-act [data-v='done']"); await page.waitForTimeout(600);
ok(await count(".mk-act [data-v='done']") === nTodo - 1 && (await txt(".mkx")).includes("한 일과 효과") && (await txt(".mkx")).includes("효과 재는 중"), "했어요 → 한 일과 효과");
// 업무로 보내기
await page.click(".mk-act [data-mk='act-task']"); await page.waitForSelector("#mk-k-proj");
await page.selectOption("#mk-k-proj", "__new"); await page.click("[data-mk='task-go']"); await page.waitForTimeout(600);
const tk = await page.evaluate(() => ({ t: DB.tasks.filter(t => t.source === "marketing").length, p: DB.projects.filter(p => p.name === "마케팅").length, sent: MK._t.S.acts.filter(a => a.task_id).length }));
ok(tk.t === 1 && tk.p === 1 && tk.sent === 1, "업무로 보내기 " + JSON.stringify(tk));
// 직접 적기
await page.click("[data-mk='act-new']"); await page.fill("#mk-n-title", "플레이스 대표 사진 새로 올리기"); await page.click("[data-mk='act-save']"); await page.waitForTimeout(500);
ok((await txt(".mkx .card")).includes("플레이스 대표 사진 새로 올리기") && await page.evaluate(() => MK._t.S.acts.find(a => a.title.startsWith("플레이스 대표")).mode === "boost"), "할 일 직접 적기 (부스터 목록에)");

/* 3. 최적화 */
await go("#/marketing/opt"); await page.waitForSelector(".mk-iss");
const iss = await page.evaluate(() => MK._t.issues().map(i => i.code + ":" + (i.camp ? i.camp.name : i.chan.name)));
ok(iss.includes("notrack:브랜드 검색") && iss.includes("highcpa:릴스 관심사 타겟"), "진단: " + iss.join(", "));
ok(!iss.some(x => x.endsWith("파티룸 지역 키워드")), "잘하는 캠페인은 고칠 것 없음");
ok((await txt(".mk-iss.s3")).includes("전환") , "먼저 볼 것이 위에");
const q0 = await page.evaluate(() => MK._t.S.acts.length);
await page.click(".mk-iss [data-mk='iss-queue']"); await page.waitForTimeout(600);
ok(await page.evaluate(() => MK._t.S.acts.length) === q0 + 1 && (await txt(".mk-iss")).includes("실행안에 담김") && (await txt(".mkx")).includes("담아 둔 할 일") && (await txt(".sp-tabs [data-to='opt'] .nbadge")) === "1", "고칠 것 → 할 일로 담기, 최적화 탭에 표시");
ok(await count("details.mk-chk") === 5, "점검표: 공통 + 채널 4종 (" + await count("details.mk-chk") + ")");
await page.click("details.mk-chk[open] .mk-ci input"); await page.waitForTimeout(500);
ok((await txt("details.mk-chk[open] summary em")).startsWith("1/") && (await txt("#mk-chk-tot")).startsWith("1/"), "점검표 체크 — 묶음과 전체 수가 바로 바뀜");
await page.fill("#mk-u-url", "example.com/party"); await page.fill("#mk-u-src", "naver"); await page.fill("#mk-u-med", "cpc"); await page.fill("#mk-u-cmp", "연말 모임");
ok((await txt("#mk-u-out")) === "https://example.com/party?utm_source=naver&utm_medium=cpc&utm_campaign=" + encodeURIComponent("연말 모임"), "링크 꼬리표 " + await txt("#mk-u-out"));
await shot("03-opt");

/* 4. 캠페인 */
await go("#/marketing/camp"); await page.waitForSelector(".mk-camp");
ok(await count(".mk-camp") === 4, "캠페인 카드 4개");
await page.click(".mk-camp:has-text('릴스 관심사 타겟')"); await page.waitForSelector(".mk-wide");
const cv = await txt(".mk-wide");
ok(cv.includes("소재A 후기") && cv.includes("소재B 가격") && cv.includes("고칠 것") && cv.includes("목표 전환당 20,000원"), "캠페인 상세: 소재별·고칠 것·목표");
// 7일 = 7 × 28,000 = 196,000
ok(cv.includes("196,000"), "캠페인 7일 광고비 검산");
await shot("04-camp-view");
await page.click(".mk-wide [data-mk='camp-edit']"); await page.waitForSelector("#mk-p-name");
await page.fill("#mk-p-memo", "소재 교체 예정"); await page.selectOption("#mk-p-mode", "opt"); await page.click("[data-mk='camp-save']"); await page.waitForTimeout(600);
ok(await page.evaluate(id => { const c = MK._t.S.camps.find(x => x.id === id); return c.memo === "소재 교체 예정" && c.mode === "opt"; }, cp.bad), "캠페인 수정");
await page.click("[data-mk='camp-new']"); await page.waitForSelector("#mk-p-name");
await page.fill("#mk-p-name", "12월 체험단"); await page.selectOption("#mk-p-chan", ch.ig);
ok(await page.$eval("#mk-p-cat", e => e.value) === "content", "채널을 고르면 분류가 따라옴");
await page.fill("#mk-p-budget", "250000"); await page.selectOption("#mk-p-status", "plan"); await page.click("[data-mk='camp-save']"); await page.waitForTimeout(600);
ok(await count(".mk-camp") === 5, "캠페인 추가");
await page.fill("[data-mki='cq']", "체험단"); await page.waitForTimeout(300);
ok(await count(".mk-camp") === 1 && await page.evaluate(() => document.activeElement && document.activeElement.dataset.mki === "cq"), "검색하면서 입력 칸 유지");
await page.fill("[data-mki='cq']", ""); await page.waitForTimeout(200);

/* 5. 성과 */
await go("#/marketing/perf"); await page.waitForSelector(".mk-funnel");
const sumRow = await txt(".mkx table.tbl tr.sum");
ok(sumRow.includes(fmt(c30)) && sumRow.includes(fmt(k30)) && sumRow.includes(fmt(i30)), "30일 합계 줄 = 넣은 숫자 (" + fmt(c30) + ")");
ok(sumRow.includes(fmt(Math.round(c30 / v30)) + "원"), "전환당 검산 " + fmt(Math.round(c30 / v30)));
await page.click("[data-mk='grp'][data-v='camp']"); await page.waitForTimeout(200);
ok((await txt(".mkx table.tbl")).includes("브랜드 검색"), "캠페인별로 나눠 보기");
await page.click("[data-mk='grp'][data-v='date']"); await page.waitForTimeout(200);
ok(await page.evaluate(() => document.querySelector(".mkx .card table.tbl tbody").children.length) >= 30, "날짜별로 나눠 보기");
await page.click("[data-mk='per'][data-v='7']"); await page.waitForTimeout(200);
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("[data-mk='perf-csv']")]);
const csvPath = await dl.path(), csv = fs.readFileSync(csvPath, "utf8");
ok(csv.includes("날짜") && csv.includes("파티룸 지역 키워드") && csv.split("\n").length > 20, "CSV 내려받기 " + csv.split("\n").length + "줄");
// 성과 적기 (채널에 직접)
await page.click(".page-head [data-mk='stat-new']"); await page.waitForSelector("#mk-t-date");
await page.selectOption("#mk-t-camp", "ch:" + ch.place); await page.fill("#mk-t-date", addDays(today, -1));
await page.fill("#mk-t-conv", "3"); await page.fill("#mk-t-memo", "전화 문의 3건, 지도 보고 왔다고 함"); await page.click("[data-mk='stat-save']"); await page.waitForTimeout(700);
ok(await page.evaluate(id => MK._t.S.stats.some(r => r.chan_id === id && r.conv === 3 && r.src === "manual"), ch.place), "성과 적기 (전화 문의)");
// 상세가 있는 칸에 합계를 적으면 확인을 받음
await page.click(".page-head [data-mk='stat-new']"); await page.waitForSelector("#mk-t-date");
await page.selectOption("#mk-t-camp", cp.bad); await page.fill("#mk-t-date", addDays(today, -1)); await page.dispatchEvent("#mk-t-date", "change");
ok((await txt("#mk-t-hint")).includes("상세 기록 2줄"), "상세 기록이 있다고 알림");
await page.fill("#mk-t-cost", "30000"); await page.fill("#mk-t-imp", "13000"); await page.fill("#mk-t-clk", "70"); await page.click("[data-mk='stat-save']");
await page.waitForSelector("#mk-yes"); await page.click("#mk-yes"); await page.waitForTimeout(900);
ok(await page.evaluate(([id, d]) => { const r = MK._t.S.stats.filter(x => x.camp_id === id && x.date === d); return r.length === 1 && r[0].cost === 30000 && !r[0].label; }, [cp.bad, addDays(today, -1)]), "확인 뒤 한 줄로 바꿈");
// 클릭 > 노출이면 막음
await page.click(".page-head [data-mk='stat-new']"); await page.waitForSelector("#mk-t-date"); await page.selectOption("#mk-t-camp", cp.dead); await page.fill("#mk-t-date", addDays(today, -50));
await page.fill("#mk-t-imp", "10"); await page.fill("#mk-t-clk", "20"); await page.click("[data-mk='stat-save']"); await page.waitForTimeout(300);
ok((await toast()).includes("클릭이 노출보다"), "말이 안 되는 숫자 막기"); await page.click(".m-foot [data-g='modal-close']");
await shot("05-perf");

/* 6. 보고서 파일 올리기 — 네이버 식 CSV (머리말 줄, 합계 줄 포함) */
if (XLSX_FILE) {
  const tmpCsv = path.join(process.env.TMPDIR || "/tmp", "mk_report_" + Date.now() + ".csv");
  fs.writeFileSync(tmpCsv, "﻿캠페인 보고서\n기간: " + addDays(today, -3) + " ~ " + addDays(today, -2) + "\n일별,캠페인,광고그룹,노출수,클릭수,클릭률(%),\"평균클릭비용(VAT포함,원)\",\"총비용(VAT포함,원)\",전환수,전환매출액(원)\n"
    + [addDays(today, -3) + ".,쇼핑검색 겨울 상품,그룹A,\"4,200\",88,2.1,410,\"36,080\",3,\"210,000\"", addDays(today, -3) + ".,쇼핑검색 겨울 상품,그룹B,\"1,100\",12,1.09,380,\"4,560\",0,0", addDays(today, -2) + ".,쇼핑검색 겨울 상품,그룹A,\"3,900\",80,2.05,400,\"32,000\",2,\"150,000\"", "합계,,,\"9,200\",180,1.96,403,\"72,640\",5,\"360,000\""].join("\n") + "\n");
  await page.click(".page-head [data-mk='up-open']"); await page.waitForSelector("#mk-up-file");
  await page.selectOption("#mk-up-chan", "new:naver_shop");
  await page.setInputFiles("#mk-up-file", tmpCsv); await page.waitForSelector("[data-mk='up-go']", { timeout: 15000 });
  const pv = await txt("#mk-up-out");
  ok(pv.includes("읽은 줄 3개") && pv.includes("72,640원") && pv.includes("캠페인 1개"), "파일 미리보기: 합계 줄 빼고 3줄, 총비용 열을 광고비로 (" + pv.slice(0, 90) + ")");
  const mp = await page.evaluate(() => ({ m: MK._t.U.imp.map, H: MK._t.U.imp.H }));
  ok(mp.H[mp.m.cost].startsWith("총비용") && mp.H[mp.m.clk] === "클릭수" && mp.H[mp.m.imp] === "노출수" && mp.H[mp.m.conv] === "전환수" && mp.H[mp.m.rev].startsWith("전환매출") && mp.H[mp.m.label] === "광고그룹" && mp.H[mp.m.date] === "일별", "열 자동 맞춤 " + JSON.stringify(mp.m));
  await shot("06-upload");
  await page.click("[data-mk='up-go']"); await page.waitForTimeout(1200);
  const up = await page.evaluate(() => { const c = MK._t.S.camps.find(x => x.name === "쇼핑검색 겨울 상품"), ch = c && MK._t.S.chans.find(x => x.id === c.chan_id), r = c ? MK._t.S.stats.filter(x => x.camp_id === c.id) : []; return { camp: !!c, kind: ch && ch.kind, n: r.length, cost: r.reduce((s, x) => s + x.cost, 0), rev: r.reduce((s, x) => s + x.rev, 0), labels: [...new Set(r.map(x => x.label))].sort() }; });
  ok(up.camp && up.kind === "naver_shop" && up.n === 3 && up.cost === 72640 && up.rev === 360000 && up.labels.join() === "그룹A,그룹B", "가져오기: 채널·캠페인 생성, 숫자 일치 " + JSON.stringify(up));
  // 같은 파일을 다시 올려도 겹치지 않음
  await page.click(".page-head [data-mk='up-open']"); await page.waitForSelector("#mk-up-file"); await page.selectOption("#mk-up-chan", "new:naver_shop");
  await page.setInputFiles("#mk-up-file", tmpCsv); await page.waitForSelector("[data-mk='up-go']"); await page.click("[data-mk='up-go']"); await page.waitForTimeout(1200);
  ok(await page.evaluate(() => { const c = MK._t.S.camps.filter(x => x.name === "쇼핑검색 겨울 상품"); return c.length === 1 && MK._t.S.stats.filter(x => x.camp_id === c[0].id).reduce((s, x) => s + x.cost, 0) === 72640 && MK._t.S.chans.filter(x => x.kind === "naver_shop").length === 1; }), "두 번 올려도 겹치지 않음");
  // 매출을 기록한 캠페인만으로 ROAS — 360,000 ÷ 72,640 = 495.6%
  await go("#/marketing/perf"); await page.waitForSelector(".mk-funnel"); await page.click("[data-mk='per'][data-v='30']"); await page.waitForTimeout(250);
  ok((await txt(".mk-funnel")).includes("ROAS 495.6%") && (await txt(".mkx table.tbl tr.sum")).includes("495.6%"), "ROAS는 매출을 기록한 광고의 광고비만으로 (" + (await txt(".mk-funnel > div:nth-child(4)")) + ")");
  // 메타 식 영문·한글 열 인식
  const dc = await page.evaluate(() => { const H = ["보고 시작", "보고 종료", "캠페인 이름", "광고 세트 이름", "광고 이름", "지출 금액 (KRW)", "노출", "링크 클릭", "CTR(링크 클릭률)", "CPC(링크 클릭당 비용)", "결과", "구매 전환값"], m = MK._t.detectCols(H); return Object.fromEntries(Object.entries(m).map(([k, i]) => [k, i < 0 ? "" : H[i]])); });
  ok(dc.date === "보고 시작" && dc.camp === "캠페인 이름" && dc.label === "광고 세트 이름" && dc.cost === "지출 금액 (KRW)" && dc.imp === "노출" && dc.clk === "링크 클릭" && dc.conv === "결과" && dc.rev === "구매 전환값", "메타 보고서 열 인식 " + JSON.stringify(dc));
  const dg = await page.evaluate(() => { const H = ["Day", "Campaign", "Ad group", "Impressions", "Clicks", "CTR", "Avg. CPC", "Cost", "Conversions", "Conv. value", "Cost / conv."], m = MK._t.detectCols(H); return Object.fromEntries(Object.entries(m).map(([k, i]) => [k, i < 0 ? "" : H[i]])); });
  ok(dg.date === "Day" && dg.camp === "Campaign" && dg.cost === "Cost" && dg.clk === "Clicks" && dg.imp === "Impressions" && dg.conv === "Conversions" && dg.rev === "Conv. value", "구글 보고서 열 인식 " + JSON.stringify(dg));
  ok(await page.evaluate(() => MK._t.toDate("2026.11.03.") === "2026-11-03" && MK._t.toDate("2026-11-3") === "2026-11-03" && MK._t.toDate("20261103") === "2026-11-03" && MK._t.toDate("합계") === "" && MK._t.toDate(46329) === "2026-11-03"), "날짜 읽기");
} else console.log("· XLSX_FILE이 없어 파일 올리기 시험은 건너뜁니다");

/* 7. 돈에 기록 */
await go("#/marketing/perf"); await page.waitForSelector("[data-mk='fin-send']");
await page.click("[data-mk='fin-send']"); await page.waitForTimeout(500);
const fin = await page.evaluate(() => DB.finance.filter(f => f.source === "marketing").map(f => ({ a: f.amount, c: f.category, k: f.mkKey, m: f.memo })));
const mCostNow = await page.evaluate(() => { const t = new Date(), ym = t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0"); return MK._t.S.stats.filter(r => r.date.startsWith(ym)).reduce((s, r) => s + r.cost, 0); });
ok(fin.length >= 2 && fin.every(f => f.c === "마케팅") && fin.reduce((s, f) => s + f.a, 0) === mCostNow, "돈에 기록: 채널별 지출, 합계 일치 " + fin.reduce((s, f) => s + f.a, 0) + "/" + mCostNow);
await page.click("[data-mk='fin-send']"); await page.waitForTimeout(400);
ok(await page.evaluate(() => DB.finance.filter(f => f.source === "marketing").length) === fin.length && (await toast()).includes("이미 같은 금액"), "다시 눌러도 겹치지 않음");
await go("#/money"); await page.waitForTimeout(300);
ok((await txt("#view")).includes("마이마케팅"), "돈 메뉴에 출처 표시");

/* 8. 콘텐츠 */
await go("#/marketing/content"); await page.waitForSelector(".mk-cal");
ok(await count(".mk-day") >= 28 && await count(".mk-post") >= 1, "달력");
await page.click(".page-head [data-mk='post-new']"); await page.waitForSelector("#mk-o-title");
await page.fill("#mk-o-title", "연말 모임 체크리스트"); await page.fill("#mk-o-date", addDays(today, 1)); await page.check("#mk-o-paid");
ok(await page.isVisible("#mk-o-paidbox") && (await txt("#mk-o-paidbox")).includes("제목이나 본문 첫 부분"), "협찬 글 표시 안내");
await page.click("[data-mk='post-save']"); await page.waitForTimeout(600);
ok(await page.evaluate(() => MK._t.S.posts.some(p => p.title === "연말 모임 체크리스트" && p.paid === 1)), "콘텐츠 추가");
await page.click(".page-head [data-mk='idea-open']"); await page.waitForSelector(".mk-idea");
ok(await count(".mk-idea") === 12, "아이디어 12개");
await page.check(".mk-idea >> nth=0"); await page.check(".mk-idea >> nth=3"); await page.click("[data-mk='idea-add']"); await page.waitForTimeout(900);
ok(await page.evaluate(() => MK._t.S.posts.filter(p => !p.date && p.status === "idea").length) === 2, "아이디어 담기");
await page.click(".mk-post >> nth=0"); await page.waitForSelector("#mk-o-view"); await page.click(".m-foot [data-g='modal-close']");
await shot("07-content");

/* 9. 키워드 */
await go("#/marketing/kw"); await page.waitForSelector(".mkx table.tbl");
ok(await count(".mkx table.tbl tbody tr") === 3 && (await txt(".mkx")).includes("연결하면 연관 키워드"), "키워드 목록 · 연결 안내");
await page.click("[data-mk='kw-new']"); await page.fill("#mk-a-words", "홍대 브라이덜샤워\n합정 파티룸, 망원 파티룸\n홍대 파티룸"); await page.fill("#mk-a-grp", "지역+업종"); await page.click("[data-mk='kw-add']"); await page.waitForTimeout(700);
ok(await page.evaluate(() => MK._t.S.kws.length) === 6, "키워드 여러 개 추가 (이미 있는 것은 그대로)");
await page.click("[data-mk='kw-mix']"); await page.waitForSelector("#mk-x-a"); await page.fill("#mk-x-a", "상수\n연남"); await page.fill("#mk-x-b", "파티룸\n모임 장소");
ok((await txt("#mk-x-n")).startsWith("4개"), "조합 수 미리보기"); await page.click("[data-mk='mix-add']"); await page.waitForTimeout(700);
ok(await page.evaluate(() => MK._t.S.kws.some(k => k.word === "연남 모임 장소" && k.grp === "조합")), "조합기");
await page.selectOption(".mkx table.tbl tbody tr:first-child select", "neg"); await page.waitForTimeout(500);
ok(await page.evaluate(() => MK._t.S.kws.filter(k => k.state === "neg").length) === 1, "상태 바로 바꾸기");
await shot("08-kw");

/* 10. 설정 · 기획 */
await go("#/marketing/set"); await page.waitForSelector("#mk-s-aov");
ok((await txt("#mk-be")).includes("48,000원") && (await txt("#mk-be")).includes("250%"), "손익분기 계산 (120,000 × 40% = 48,000 · ROAS 250%)");
await page.fill("#mk-s-margin", "50"); ok((await txt("#mk-be")).includes("60,000원") && (await txt("#mk-be")).includes("200%"), "입력하면 바로 다시 계산");
await page.fill("#mk-s-margin", "40"); await page.fill("#mk-s-aud", "생일·브라이덜 샤워를 준비하는 20~30대"); await page.click("[data-mk='set-save']"); await page.waitForTimeout(600);
ok(await page.evaluate(() => MK._t.S.settings.biz.aud.startsWith("생일") && MK._t.S.settings.mode === "boost" && MK._t.S.settings.checks.length === 1), "설정 저장 (모드·점검표는 그대로)");
await page.click("[data-mk='set-tab'][data-v='1']"); await page.waitForTimeout(200);
await page.click("[data-mk='chan-new']"); await page.waitForSelector("#mk-c-kind"); await page.selectOption("#mk-c-kind", "youtube");
ok(await page.$eval("#mk-c-name", e => e.value) === "유튜브 채널" && await page.$eval("#mk-c-cat", e => e.value) === "video", "채널 종류를 고르면 이름·분류 채움");
await page.fill("#mk-c-handle", "@harustudio"); await page.click("[data-mk='chan-save']"); await page.waitForTimeout(600);
ok(await page.evaluate(() => MK._t.S.chans.some(c => c.kind === "youtube" && c.handle === "@harustudio")), "채널 추가");
await page.click("[data-mk='set-tab'][data-v='2']"); await page.waitForTimeout(200);
const cn = await txt(".mkx");
ok(cn.includes("아직 광고 계정을 연결할 수 없습니다") && cn.includes("MW_VAULT_KEY") && await page.$eval("[data-mk='conn-open'][data-src='naver']", e => e.disabled), "연결: 금고 키가 없으면 막고 운영자에게 방법 안내");
await shot("09-set-conn");
await page.click("[data-mk='set-tab'][data-v='3']"); await page.waitForSelector("#mk-g-days");
await page.fill("#mk-g-days", "14"); await page.fill("[data-ref='search'][data-k='ctr']", "1.5"); await page.click("[data-mk='guard-save']"); await page.waitForTimeout(600);
ok(await page.evaluate(() => MK._t.S.settings.guard.days === 14 && MK._t.S.settings.ref.search.ctr === 1.5 && MK._t.S.settings.ref.search.cvr === 1.5), "판단 기준 저장");
await page.fill("#mk-g-days", "7"); await page.click("[data-mk='guard-save']"); await page.waitForTimeout(500);
// 기획 마법사
await page.click("[data-mk='set-tab'][data-v='0']"); await page.waitForTimeout(200); await page.click("[data-mk='plan-open']"); await page.waitForSelector("#mk-w1-type");
ok(await page.$eval("#mk-w1-type", e => e.value) === "space" && await page.$eval("#mk-w1-budget", e => e.value) === "1500000", "마법사: 설정 값을 미리 채움");
await page.fill("#mk-w1-ka", "홍대, 합정"); await page.fill("#mk-w1-kb", "스터디룸, 회의실"); await page.check(".mk-w1-as[value='insta']");
await page.click("[data-mk='plan-next']"); await page.waitForSelector("[data-mk-pct]");
const pl = await page.evaluate(() => { const P = MK._t.U.plan.P; return { pct: P.mix.map(m => m.pct), budgets: P.camps.map(c => c.budget), be: P.be, t: P.tCpa, chans: P.chans.map(c => c.kind), posts: P.posts.length, kws: P.kws.map(k => k.word), acts: P.acts.map(a => a.title) }; });
ok(pl.pct.join() === "35,25,25,15" && pl.budgets.join() === "525000,375000,375000,225000" && pl.be === 48000 && pl.t === 33600, "기획안: 배분 35/25/25/15, 금액, 손익분기 48,000 · 목표 33,600 " + JSON.stringify(pl.budgets));
ok(pl.posts === 8 && pl.kws.length === 4 && pl.kws.includes("합정 회의실") && pl.acts.includes("네이버 스마트플레이스 등록하기") && pl.chans.includes("instagram"), "기획안: 콘텐츠 8 · 키워드 4 · 플레이스 등록부터");
await shot("10-plan");
await page.fill("[data-mk-pct='0']", "40"); await page.waitForTimeout(150);
ok((await txt("#mk-w2-sum")).includes("105%") && (await txt(".mk-mix>div:first-child>b")) === "600,000원", "비율을 고치면 금액·합계가 바로 바뀜");
await page.click("[data-mk='plan-apply']"); await page.waitForTimeout(300);
ok((await toast()).includes("100%"), "비율 합계가 100이 아니면 막음");
await page.fill("[data-mk-pct='3']", "10"); await page.waitForTimeout(150);
const campsBefore = await page.evaluate(() => MK._t.S.camps.length);
await page.click("[data-mk='plan-apply']"); await page.waitForTimeout(1500);
const ap = await page.evaluate(() => ({ camps: MK._t.S.camps.length, plan: MK._t.S.camps.filter(c => c.status === "plan").map(c => c.name + ":" + c.budget), hash: location.hash, posts: MK._t.S.posts.length, mode: MK._t.S.settings.mode, tcpa: MK._t.S.settings.target.cpa }));
ok(await page.evaluate(() => MK._t.S.acts.filter(a => a.status === "todo" && a.mode === "opt" && a.kind !== "etc").length) >= 10 && (await txt(".sp-tabs [data-to='opt'] .nbadge")) !== "", "기획안의 처음 할 일은 최적화 쪽 할 일로");
ok(ap.camps === campsBefore + 4 && ap.plan.includes("네이버 플레이스 광고:600000") && ap.plan.includes("체험단:150000") && ap.hash === "#/marketing/camp" && ap.mode === "boost" && ap.tcpa === 20000, "기획안 만들기 — 준비 상태 캠페인, 직접 정한 목표·모드는 유지 " + JSON.stringify(ap.plan));
// 기획 파일 가져오기
await go("#/marketing/set"); await page.waitForSelector("[data-mk='pim-open']"); await page.click("[data-mk='pim-open']"); await page.waitForSelector("#mk-j-text");
await page.fill("#mk-j-text", "이렇게 해 보세요.\n```json\n" + JSON.stringify({ format: "myworks-marketing/v1", channels: [{ name: "당근 비즈프로필", kind: "daangn", category: "local" }], campaigns: [{ channel: "당근 비즈프로필", name: "동네 쿠폰 광고", goal: "visit", budget: 100000, budget_type: "month" }], posts: [{ channel: "인스타그램 @haru", date: addDays(today, 5), title: "평일 낮 할인 안내", body: "초안", format: "피드" }], actions: [{ title: "쿠폰 문구 정하기", detail: "첫 방문 10%", campaign: "동네 쿠폰 광고", kind: "setup" }], keywords: [{ word: "무료 대관", group: "제외", state: "neg" }] }) + "\n```");
await page.click("[data-mk='pim-read']"); await page.waitForTimeout(200);
ok((await txt("#mk-j-out")).includes("채널 1 · 캠페인 1") && !(await page.$eval("[data-mk='pim-apply']", e => e.disabled)), "기획 파일 읽기");
await page.click("[data-mk='pim-apply']"); await page.waitForTimeout(1200);
ok(await page.evaluate(() => MK._t.S.camps.some(c => c.name === "동네 쿠폰 광고" && c.status === "plan") && MK._t.S.kws.some(k => k.word === "무료 대관" && k.state === "neg") && MK._t.S.acts.some(a => a.title === "쿠폰 문구 정하기" && a.by === "ai") && MK._t.S.posts.some(p => p.title === "평일 낮 할인 안내" && p.status === "draft")), "기획 파일 가져오기");
await page.click("[data-mk='pim-open']"); await page.fill("#mk-j-text", "{bad"); await page.click("[data-mk='pim-read']");
ok((await txt("#mk-j-out")).includes("JSON으로 읽지 못했습니다"), "잘못된 파일 안내"); await page.click(".m-foot [data-g='modal-close']");

/* 11. 홈 · 확장판 · 주간 리포트 · AI 접속 */
await go("#/dashboard"); await page.waitForSelector("#mk-dash-slot .card");
const hd = await txt("#mk-dash-slot");
ok(hd.includes("광고·홍보") && hd.includes("이달 광고비") && hd.includes("실행안"), "홈 카드: " + hd.slice(0, 80));
await shot("11-home");
await go("#/ext"); await page.waitForSelector(".ext-card");
ok((await txt(".ext-grid")).includes("마이마케팅") && await page.evaluate(() => { const c = [...document.querySelectorAll(".ext-card")].find(x => x.textContent.includes("마이마케팅")); return c.classList.contains("on") && !!c.querySelector("input.mod-ck:checked"); }), "확장판 카드 켜짐");
await shot("12-ext");
ok(await page.evaluate(() => { const r = weekRange(0); return MK.weekText(...r).includes("광고·홍보 (마이마케팅)"); }), "주간 리포트 문단");
await go("#/data"); await page.waitForSelector("[data-act='tk-new']"); await page.click("[data-act='tk-new']"); await page.waitForSelector("#tk-name");
ok((await txt("#m-box")).includes("마이마케팅") && await count(".tk-mod[value='marketing']") === 1, "AI 접속: 토큰에 마이마케팅 고르기"); await page.click(".m-foot [data-g='modal-close']");
// 끄면 메뉴에서 사라지고, 켜면 돌아옴
await go("#/ext"); await page.waitForSelector(".ext-card");
await page.evaluate(() => { const c = [...document.querySelectorAll(".ext-card")].find(x => x.textContent.includes("마이마케팅")); c.querySelector("input.mod-ck").click(); }); await page.waitForTimeout(900);
ok(await count("#nav-side [data-nav='marketing']") === 0, "끄면 메뉴에서 사라짐");
await go("#/marketing"); await page.waitForTimeout(400); ok((await txt("#view")).includes("꺼져 있습니다"), "꺼진 상태 안내");
await go("#/ext"); await page.waitForSelector(".ext-card");
await page.evaluate(() => { const c = [...document.querySelectorAll(".ext-card")].find(x => x.textContent.includes("마이마케팅")); c.querySelector("input.mod-ck").click(); }); await page.waitForTimeout(900);
ok(await count("#nav-side [data-nav='marketing']") === 1, "켜면 돌아옴");

/* 12. 다른 화면이 그대로인지 */
for (const h of ["dashboard", "plan", "projects", "board", "stores", "members", "money", "tax", "tax/kpi", "tax/set", "space", "commerce", "outsourcing", "data", "ext", "admin"]) {
  const n0 = errors.length; await go("#/" + h); await page.waitForTimeout(450);
  ok(errors.length === n0 && (await txt("#view")).length > 20, "화면 열림: " + h + (errors.length > n0 ? " — " + errors.slice(n0).join(" | ") : ""));
}
// 마이택스 설정: 사업자에 마이마케팅 광고비 연결 항목
ok(await page.evaluate(() => typeof TX.view === "function" && typeof MK.view === "function"), "모듈 객체");

/* 13. 직원·근무자 */
const S2 = (await api("login", { loginId: "staff01", pw: "pw123456" })).token, W2 = (await api("login", { loginId: "alba01", pw: "pw123456" })).token;
{ const o = await open(S2); await o.page.waitForSelector(".mkx .sp-kpis", { timeout: 15000 }); ok(await o.page.evaluate(() => !!document.querySelector("#nav-side [data-nav='marketing']")), "직원: 메뉴와 화면");
  await o.page.evaluate(() => { location.hash = "#/marketing/set"; }); await o.page.waitForTimeout(300); await o.page.click("[data-mk='set-tab'][data-v='2']"); await o.page.waitForTimeout(200);
  ok((await o.page.evaluate(() => document.querySelector(".mkx").textContent)).includes("연결은 워크스페이스 관리자가 합니다"), "직원: 연결은 관리자만"); await o.ctx.close(); }
{ const o = await open(W2); await o.page.waitForTimeout(1200); ok(await o.page.evaluate(() => !document.querySelector("#nav-side [data-nav='marketing']") && !location.hash.includes("marketing")), "현장 근무자: 메뉴 없음, 주소로도 못 들어감"); await o.ctx.close(); }

/* 14. 폰 폭 390px */
await ctx.close();
{ const o = await open(A, { width: 390, height: 800 }); const p = o.page; await p.waitForSelector(".mkx");
  const over = async n => { const r = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })); ok(r.sw <= r.iw + 1, `폰 가로 넘침 없음: ${n} (${r.sw}/${r.iw})`); if (SHOTS) await p.screenshot({ path: path.join(SHOTS, "m-" + n + ".png"), fullPage: true }); };
  for (const t of ["", "camp", "perf", "content", "kw", "opt", "boost", "set"]) { await p.evaluate(x => { location.hash = "#/marketing" + (x ? "/" + x : ""); }, t); await p.waitForTimeout(350); await over(t || "dash"); }
  for (const i of [1, 2, 3]) { await p.click(`[data-mk='set-tab'][data-v='${i}']`); await p.waitForTimeout(200); await over("set" + i); }
  await p.evaluate(() => { location.hash = "#/marketing/camp"; }); await p.waitForSelector(".mk-camp"); await p.click(".mk-camp >> nth=0"); await p.waitForSelector(".mk-wide"); await over("camp-view");
  ok(await p.evaluate(() => { const b = document.querySelector("#m-box"); return b.getBoundingClientRect().width <= window.innerWidth; }), "폰: 모달이 화면 안"); await p.click(".m-foot [data-g='modal-close']");
  await p.click("[data-mk='plan-open']"); await p.waitForSelector("#mk-w1-type"); await over("plan1"); await p.click("[data-mk='plan-next']"); await p.waitForSelector("[data-mk-pct]"); await over("plan2"); await p.click(".m-foot [data-g='modal-close']");
  await p.evaluate(() => { location.hash = "#/marketing/perf"; }); await p.waitForTimeout(300); await p.click(".page-head [data-mk='stat-new']"); await p.waitForSelector("#mk-t-date"); await over("stat"); await p.click(".m-foot [data-g='modal-close']");
  await p.click(".page-head [data-mk='up-open']"); await p.waitForSelector("#mk-up-file"); await over("upload"); await p.click(".m-foot [data-g='modal-close']");
  await p.evaluate(() => { location.hash = "#/marketing/content"; }); await p.waitForTimeout(300);
  ok(await p.evaluate(() => getComputedStyle(document.querySelector(".mk-cal")).gridTemplateColumns.split(" ").length === 1 && [...document.querySelectorAll(".mk-day.blank")].every(e => getComputedStyle(e).display === "none")), "폰: 달력이 목록으로");
  await p.evaluate(() => { location.hash = "#/dashboard"; }); await p.waitForSelector("#mk-dash-slot .card"); await over("home");
  await p.click('#tabbar [data-g="menu"]'); await p.waitForSelector(".menu-grid");
  ok((await p.evaluate(() => document.querySelector(".menu-grid").textContent)).includes("마이마케팅"), "폰: 아래 탭의 ‘전체’ 메뉴에 마이마케팅");
  await p.click('#m-box [data-g="modal-close"], .m-dim', { force: true }).catch(() => {}); await p.evaluate(() => { if (document.querySelector("#modal-root").classList.contains("show")) closeModal(); });
  await o.ctx.close(); }

ok(errors.length === 0, "콘솔·스크립트 오류 없음" + (errors.length ? " — " + [...new Set(errors)].slice(0, 6).join(" | ") : ""));
console.log(`통과 ${pass} · 실패 ${failN}`);
bye(failN ? 1 : 0);
