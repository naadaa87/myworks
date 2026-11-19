// 마이크리에이터 브라우저 시험 — Playwright와 크롬이 있는 곳에서:
//   NODE_PATH=<playwright가 있는 node_modules> node tests/creator.e2e.mjs [스크린샷 폴더]
// 로컬 시험 서버(tests/dev-server.mjs)를 띄우고 데이터를 넣은 뒤 화면을 눌러 봅니다. 바깥 주소는 모두 막습니다.
import { spawn } from "node:child_process"; import fs from "node:fs"; import path from "node:path"; import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = 8900 + Math.floor(Math.random() * 90), BASE = "http://localhost:" + PORT, SHOTS = process.argv[2] || "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const srv = spawn(process.execPath, ["--no-warnings", path.join(ROOT, "tests/dev-server.mjs"), ROOT, String(PORT)], { stdio: ["ignore", "pipe", "ignore"] });
await new Promise(res => srv.stdout.on("data", d => String(d).includes("dev") && res()));
let browser = null;
const bye = code => { try { srv.kill(); } catch (e) {} if (browser) browser.close().catch(() => {}); setTimeout(() => process.exit(code), 300); };
let pass = 0, failN = 0, lastStep = "";
const stopped = e => { console.log("✗ 시험이 중간에 멈췄습니다:", String((e && e.message) || e).split("\n").slice(0, 3).join(" / "), "(‘" + lastStep + "’ 다음)"); console.log(`통과 ${pass} · 실패 ${failN + 1}`); bye(1); };
process.on("uncaughtException", stopped); process.on("unhandledRejection", stopped);
setTimeout(() => { console.log("✗ 시간 초과"); bye(1); }, Number(process.env.E2E_TIMEOUT || 360) * 1000).unref();
const ok = (c, m) => { lastStep = m; if (c) pass++; else { failN++; console.log("✗", m); } };
const api = async (p, body, token) => { const r = await fetch(BASE + "/api/" + p, { method: body ? "POST" : "GET", headers: Object.assign({ "content-type": "application/json" }, token ? { authorization: "Bearer " + token } : {}), body: body ? JSON.stringify(body) : undefined }); return r.json(); };
const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (ds, n) => { const d = new Date(ds + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const monShift = (ym, n) => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5) - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const today = kst(), ym = today.slice(0, 7), fmt = n => Math.round(n).toLocaleString("ko-KR");
const man = n => { n = Math.round(n); const a = Math.abs(n); return (a >= 1e8 ? (Math.round(a / 1e6) / 100).toLocaleString("ko-KR") + "억" : a >= 1e4 ? (Math.round(a / 1e3) / 10).toLocaleString("ko-KR") + "만" : a.toLocaleString("ko-KR")) + "원"; };

/* ── 데이터 넣기 — 셀프 인테리어 채널 ‘하루의 작업실’ ── */
const A = (await api("owner-setup", { loginId: "boss01", pw: "pass1234", name: "김하루", workspace: "하루의 작업실" })).token;
await api("ws/modules", { modules: ["creator", "tax", "people"] }, A);
await api("member/create", { loginId: "staff01", pw: "pw123456", name: "매니저 민", role: "staff" }, A);
await api("member/create", { loginId: "alba01", pw: "pw123456", name: "박알바", role: "worker" }, A);
await api("cr/settings", { set: { set: true, biz: { type: "exempt", wht: 3.3, name: "하루의 작업실", person: "김하루", email: "haru@example.com", phone: "010-0000-0000" } } }, A);
const ch = {};
for (const [k, name, platform, handle, topic, url] of [["yt", "하루의 작업실", "youtube", "@haru_works", "셀프 인테리어", "https://youtube.com/@haru_works"], ["ig", "@haru.home", "instagram", "@haru.home", "집 꾸미기", "https://instagram.com/haru.home"], ["blog", "하루의 집수리 노트", "naver_blog", "haru_note", "집수리 기록", ""]])
  ch[k] = (await api("cr/chan/save", { name, platform, handle, topic, url }, A)).chan.id;
const SUBS = { yt: [41200, 43100, 44800, 46900, 48900, 50100], ig: [10800, 11100, 11500, 11900, 12200, 12400], blog: [2900, 2950, 3000, 3040, 3080, 3100] };
const VIEWS = { yt: [252000, 281000, 266000, 309000, 325000, 180000], ig: [70000, 76000, 81000, 88000, 93000, 60000], blog: [18000, 17500, 19000, 20500, 21000, 12000] };
for (const k of Object.keys(SUBS)) for (let i = 0; i < 6; i++) await api("cr/snap/save", { chan_id: ch[k], ym: monShift(ym, i - 5), subs: SUBS[k][i], views: VIEWS[k][i], posts: k === "ig" ? 12 : 5 }, A);
const mk = async o => (await api("cr/deal/save", o, A)).deal;
const D = {};
D.nego = await mk({ brand: "따숨", title: "난방 텐트 리뷰", type: "paid", stage: "nego", chan_id: ch.yt, amount: 700000, tax_mode: "wht", post_due: addDays(today, 25) });
D.contract = await mk({ brand: "모노가구", agency: "플랜에이", person: "이지수", contact: "jisoo@example.com", title: "원목 선반 리뷰", type: "paid", stage: "nego", chan_id: ch.yt, amount: 1500000, tax_mode: "wht", items: "긴 영상 1편 + 쇼츠 1편", draft_due: addDays(today, 2), post_due: addDays(today, 9), pay_due: addDays(today, 40), revisions: 2, usage: "브랜드 인스타그램 재게시", usage_until: addDays(today, 100), excl: "가구 브랜드", excl_until: addDays(today, 60), guide: "#모노가구 #원목선반", memo: "작년에도 한 번 했음" });
D.making = await mk({ brand: "페인트하우스", title: "셀프 페인팅 브랜디드", type: "paid", stage: "making", chan_id: ch.yt, amount: 2000000, tax_mode: "wht", items: "긴 영상 1편", draft_due: addDays(today, -1), post_due: addDays(today, 6) });
D.review = await mk({ brand: "클린홈", title: "욕실 청소 세트", type: "gift", stage: "review", chan_id: ch.ig, gift_value: 80000, post_due: addDays(today, 1) });
D.posted = await mk({ brand: "툴박스", title: "전동 드릴 PPL", type: "paid", stage: "posted", chan_id: ch.yt, amount: 800000, tax_mode: "wht", pay_due: addDays(today, -3), show_case: true, disc: { how: "제목에 [광고]", ok: ["word", "place", "seen", "agreed"] }, result: { urls: ["https://youtu.be/drill"], posted_at: addDays(today, -12), view: 52300, likes: 1800, cmts: 240, at: today } });
D.settle = await mk({ brand: "라이트온", title: "간접 조명 리뷰", type: "paid", stage: "settle", chan_id: ch.yt, amount: 1200000, tax_mode: "wht", pay_due: addDays(today, 10), disc: { how: "제목에 [광고]", ok: ["word", "place", "seen", "agreed"] }, result: { urls: ["https://youtu.be/light"], posted_at: addDays(today, -20), view: 40000, likes: 900, cmts: 120, at: today } });
D.done1 = await mk({ brand: "그린월", title: "벽지 브랜디드", type: "paid", stage: "posted", chan_id: ch.yt, amount: 1800000, tax_mode: "wht", show_case: true, result: { urls: ["https://youtu.be/wall"], posted_at: addDays(today, -40), view: 90000, likes: 3100, cmts: 410, at: addDays(today, -10) } });
D.done2 = await mk({ brand: "스틸랙", title: "선반 PPL", type: "paid", stage: "posted", chan_id: ch.yt, amount: 900000, tax_mode: "wht", show_case: false, result: { urls: ["https://youtu.be/rack"], posted_at: addDays(today, -70), view: 30000, at: addDays(today, -40) } });
D.lost = await mk({ brand: "바른공구", title: "공구 세트", type: "paid", stage: "lost", amount: 300000, lost_reason: "금액이 맞지 않음" });
await api("cr/deal/paid", { id: D.done1.id, date: addDays(ym + "-01", -5) }, A);
await api("cr/deal/paid", { id: D.done2.id, date: addDays(monShift(ym, -1) + "-01", -8) }, A);
const ct = async o => (await api("cr/cont/save", o, A)).cont;
const C = {};
await api("cr/cont/bulk", { rows: [{ title: "좁은 현관 정리하는 법", chan_id: ch.yt, format: "short" }, { title: "겨울 결로 막는 법", chan_id: ch.yt, format: "long" }, { title: "월세집 벽 구멍 메우기", chan_id: ch.blog, format: "blog" }] }, A);
C.plan = await ct({ title: "공구 수납장 만들기", chan_id: ch.yt, format: "long", stage: "plan", post_date: addDays(today, 16) });
C.shoot = await ct({ title: "원목 선반 달아 보기", chan_id: ch.yt, deal_id: D.contract.id, format: "long", stage: "shoot", shoot_date: addDays(today, 1), post_date: addDays(today, 9), editor: "편집자 민", cost: 150000, checks: ["thumb", "title"] });
C.edit = await ct({ title: "방 하나 셀프 페인팅", chan_id: ch.yt, deal_id: D.making.id, format: "long", stage: "edit", post_date: addDays(today, 1), editor: "편집자 민", cost: 200000 });
C.review = await ct({ title: "욕실 청소 루틴 릴스", chan_id: ch.ig, deal_id: D.review.id, format: "short", stage: "review", post_date: addDays(today, 1) });
C.sched = await ct({ title: "이번 주 집수리 Q&A", chan_id: ch.yt, format: "live", stage: "sched", post_date: addDays(today, 2), post_time: "20:00" });
C.p1 = await ct({ title: "전동 드릴 고르는 법", chan_id: ch.yt, deal_id: D.posted.id, format: "long", stage: "posted", post_date: addDays(today, -12), url: "https://youtu.be/drill", view: 52300, likes: 1800, cmts: 240, shares: 90, saves: 300, stat_at: today, editor: "편집자 민", cost: 150000 });
C.p2 = await ct({ title: "간접 조명 달기", chan_id: ch.yt, deal_id: D.settle.id, format: "long", stage: "posted", post_date: addDays(today, -20), url: "https://youtu.be/light", view: 40000, likes: 900, cmts: 120, stat_at: today });
C.p3 = await ct({ title: "벽지 셀프 도배", chan_id: ch.yt, deal_id: D.done1.id, format: "long", stage: "posted", post_date: addDays(today, -40), url: "https://youtu.be/wall", view: 90000, likes: 3100, cmts: 410 });
C.p4 = await ct({ title: "실리콘 다시 쏘기", chan_id: ch.yt, format: "short", stage: "posted", post_date: addDays(today, -5), url: "https://youtu.be/sil", view: 21000, likes: 700, cmts: 60 });
C.p5 = await ct({ title: "현관 신발장 정리", chan_id: ch.ig, format: "short", stage: "posted", post_date: addDays(today, -8), url: "https://instagram.com/p/x1", view: 15000, likes: 1200, cmts: 45 });
C.p6 = await ct({ title: "제목만 있는 옛 영상", chan_id: ch.yt, format: "long", stage: "posted", post_date: addDays(today, -120), view: 12000 });
for (let i = 0; i < 6; i++) { const m = monShift(ym, i - 5), usd = [280.5, 310.2, 295.8, 351.4, 372.9, 205.1][i]; await api("cr/inc/save", { date: i === 5 ? today : addDays(monShift(m, 1) + "-01", 20), ym: m, src: "ads", chan_id: ch.yt, title: `애드센스 ${+m.slice(5)}월분`, cur: "USD", fx_amount: usd, fx_rate: 1380 }, A); }
await api("cr/inc/save", { date: today, src: "fan", chan_id: ch.yt, title: "채널 멤버십", gross: 185000 }, A);
await api("cr/inc/save", { date: addDays(today, 0), src: "affil", chan_id: ch.blog, title: "쿠팡 파트너스", gross: 64000, wht: 2112 }, A);
const R = {};
R.r1 = (await api("cr/rate/save", { name: "브랜디드 영상 1편", chan_id: ch.yt, format: "long", price: 1500000, note: "기획·촬영·편집, 수정 2번" }, A)).rate;
R.r2 = (await api("cr/rate/save", { name: "쇼츠 1편", chan_id: ch.yt, format: "short", price: 400000 }, A)).rate;
await api("cr/settings", { set: { kit: { name: "하루", tagline: "혼자 사는 집을 직접 고치는 사람", bio: "월세집도 고쳐 쓸 수 있다는 걸 보여 드립니다.\n공구, 자재, 수납을 직접 써 보고 솔직하게 이야기합니다.", topics: ["셀프 인테리어", "공구", "자취"], aud: { f: 46, m: 54, ages: "25–34세가 절반" }, picks: [C.p3.id, C.p1.id, C.p4.id] } } }, A);
const SUM = { incGross: Math.round(205.1 * 1380) + 185000 + 64000, incNet: Math.round(205.1 * 1380) + 185000 + 64000 - 2112, unpaidNet: (800000 - 26400) + (1200000 - 39600) };

/* ── 브라우저 ── */
browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] });
const errors = [];
async function open(token, vp, hash) {
  const ctx = await browser.newContext({ viewport: vp || { width: 1280, height: 900 }, locale: "ko-KR", timezoneId: "Asia/Seoul", acceptDownloads: true });
  await ctx.route("**/*", r => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
  if (token) await ctx.addInitScript(t => { try { localStorage.setItem("mw_token_v1", t); } catch (e) {} }, token);
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
  const page = await ctx.newPage();
  page.on("pageerror", e => errors.push("pageerror: " + e.message + " (‘" + lastStep.slice(0, 40) + "’ 다음)"));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource|net::ERR/.test(m.text())) errors.push("console: " + m.text()); });
  page.on("dialog", d => d.accept());
  page.setDefaultTimeout(15000);
  await page.goto(BASE + (hash || "/app/#/creator"), { waitUntil: "domcontentloaded" });
  if (token) await page.waitForFunction(() => typeof ME !== "undefined" && !!ME && document.querySelector("#view") && document.querySelector("#view").textContent.trim().length > 10, null, { timeout: 20000 });
  return { ctx, page };
}
let { ctx, page } = await open(A);
const go = async h => { await page.evaluate(x => { location.hash = x; }, h); await page.waitForTimeout(300); };
const txt = (sel, pg) => (pg || page).evaluate(s => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, " ").trim() : ""; }, sel);
const count = (sel, pg) => (pg || page).evaluate(s => document.querySelectorAll(s).length, sel);
const toast = () => txt("#toast");
const shot = async (n, pg) => { if (SHOTS) await (pg || page).screenshot({ path: path.join(SHOTS, n + ".png"), fullPage: true }); };
const noOverflow = async (n, pg) => { const o = await (pg || page).evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })); ok(o.sw <= o.iw + 1, `가로 넘침 없음: ${n} (${o.sw}/${o.iw})`); };
const closeM = async () => { await page.evaluate(() => closeModal()); await page.waitForTimeout(120); };

/* 1. 요약 */
await page.waitForSelector(".mkx .sp-kpis");
ok((await txt("#nav-side [data-nav='creator']")).includes("마이크리에이터"), "메뉴에 마이크리에이터");
ok((await txt(".mkx .sp-kpis .stat:nth-child(1) .s-num")) === man(SUM.incGross), "이달 수익 " + (await txt(".mkx .sp-kpis .stat:nth-child(1) .s-num")) + " = " + man(SUM.incGross));
ok((await txt(".mkx .sp-kpis .stat:nth-child(2) .s-num")) === man(SUM.unpaidNet), "받을 돈 = 3.3% 뗀 금액 " + (await txt(".mkx .sp-kpis .stat:nth-child(2) .s-num")));
ok((await txt(".mkx .sp-kpis .stat:nth-child(3) .s-num")).startsWith("6"), "진행 중인 협찬 6건");
ok((await txt(".mkx .sp-kpis .stat:nth-child(4) .s-num")).startsWith("6.6만"), "구독자 합계 " + (await txt(".mkx .sp-kpis .stat:nth-child(4) .s-num")));
const al = await page.evaluate(() => CR._t.alerts().map(a => a.sev + " " + a.title));
ok(al.some(t => t.startsWith("3 ") && t.includes("페인트하우스") && t.includes("초안 제출 1일 지남")), "챙길 것: 초안 마감 지남");
ok(al.some(t => t.startsWith("3 ") && t.includes("툴박스") && t.includes("입금 예정일이 3일 지났습니다")), "챙길 것: 입금 지연");
ok(al.some(t => t.includes("클린홈") && t.includes("광고 표기")), "챙길 것: 제품 협찬도 광고 표기 점검");
ok(al.some(t => t.includes("방 하나 셀프 페인팅") && t.includes("아직 편집 단계")), "챙길 것: 게시 임박인데 편집 중");
ok(!al.some(t => t.includes("바른공구") || t.includes("그린월")), "무산·완료 건은 챙길 것에 없음");
ok(al[0].startsWith("3 "), "급한 것부터 정렬");
ok(await count(".mkx .cr-stack > div") === 6, "6개월 수익 막대");
const wk = await page.evaluate(() => CR._t.weekItems(7).map(w => w.k + ":" + w.title));
ok(wk.some(w => w.startsWith("촬영:원목 선반")) && wk.some(w => w.startsWith("게시:이번 주 집수리")) && wk.some(w => w.startsWith("게시 마감:페인트하우스")) && !wk.some(w => w.includes("툴박스") || w.includes("모노가구")), "이레 안 일정 " + wk.length + "개 (협의 중인 건의 마감은 아직 넣지 않음)");
await shot("01-dash"); await noOverflow("요약");
if (SHOTS) { await page.setViewportSize({ width: 1280, height: 790 }); await page.mouse.move(700, 5); await page.screenshot({ path: path.join(SHOTS, "site-creator.png") }); await page.setViewportSize({ width: 1280, height: 900 }); }   // 홈페이지 소개 페이지에 쓰는 화면

/* 2. 협찬 보드 */
await go("#/creator/deal"); await page.waitForSelector(".cr-board");
ok(await count(".cr-board .cr-col") === 7, "보드 7칸");
const cols = await page.evaluate(() => [...document.querySelectorAll(".cr-board .cr-col")].map(c => c.querySelector("h3").textContent.replace(/\s+/g, " ").trim() + "|" + c.querySelectorAll(".cr-card").length));
ok(cols[1].startsWith("협의 2") && cols[2].startsWith("계약 0") && cols[3].startsWith("제작 1") && cols[5].startsWith("게시 1") && cols[6].startsWith("정산 대기 1"), "칸별 건수 " + cols.join(" / "));
ok((await txt(".mkx")).includes("바른공구") === false, "무산 건은 보드에 없음");
ok((await txt(".mkx .sp-box.info")) === "", "독점 조건은 계약 전이라 아직 안 뜸");
await shot("02-deal-board"); await noOverflow("협찬 보드");
// 조건 확인서 → 브랜드가 수정 요청 → 고쳐서 → 확인
await page.click(`.cr-card[data-id="${D.contract.id}"]`); await page.waitForSelector(".cr-wide .cr-steps");
ok((await txt(".cr-wide")).includes("1,500,000원") && (await txt(".cr-wide")).includes("원천징수 3.3% 49,500원") && (await txt(".cr-wide")).includes("1,450,500원 입금"), "협찬 상세: 3.3% 떼고 받는 돈");
ok((await txt(".cr-wide")).includes("작년에도 한 번 했음"), "메모는 내 화면에만");
await shot("03-deal-view");
await page.click('[data-cr="deal-sheet"]'); await page.waitForSelector("#cr-lk-msg");
const sheetUrl = (await txt(".m-box .linkbox")).trim();
ok(/\/link\/[0-9a-f]{32}$/.test(sheetUrl) && (await page.inputValue("#cr-lk-msg")).includes(sheetUrl) && (await page.inputValue("#cr-lk-msg")).includes("하루의 작업실"), "조건 확인서 링크와 보낼 말");
const brand = await open(null, { width: 900, height: 900 }, "/app/#/link/" + sheetUrl.split("/").pop());
await brand.page.waitForSelector("#lk-box .cr-kv");
const sheetTxt = await txt("#lk-box", brand.page);
ok(sheetTxt.includes("협찬 조건 확인서") && sheetTxt.includes("하루의 작업실 · 김하루 → 모노가구 (플랜에이)") && sheetTxt.includes("haru@example.com") && sheetTxt.includes("긴 영상 1편 + 쇼츠 1편") && sheetTxt.includes("1,450,500원") && sheetTxt.includes("2번까지") && sheetTxt.includes("가구 브랜드") && sheetTxt.includes("조건을 확인했습니다"), "브랜드가 보는 조건 확인서");
ok(!sheetTxt.includes("작년에도") && !sheetTxt.includes("jisoo@"), "확인서에 메모·연락처 없음");
await shot("04-sheet-brand", brand.page);
await brand.page.fill("#lk-note", "게시일을 일주일 늦춰 주세요"); await brand.page.fill("#lk-by", "이지수"); await brand.page.click('[data-act="lk-change"]'); await brand.page.waitForTimeout(900);
ok((await txt("#lk-box", brand.page)).includes("수정을 요청하셨습니다"), "브랜드: 수정 요청 보냄");
await closeM(); await page.evaluate(() => CR.refresh(true)); await page.waitForTimeout(900);
ok((await txt(`.cr-card[data-id="${D.contract.id}"]`)).includes("수정 요청") && (await txt(".sp-tabs [data-to='deal'] .nbadge")) === "1", "보드에 수정 요청 표시와 탭 배지");
await page.click(`.cr-card[data-id="${D.contract.id}"]`); await page.waitForSelector(".cr-wide .sp-box.warn");
ok((await txt(".cr-wide .sp-box.warn")).includes("게시일을 일주일 늦춰 주세요"), "수정 요청 내용이 보임");
await page.click('[data-cr="deal-edit"]'); await page.waitForSelector("#cr-d-post");
await page.fill("#cr-d-post", addDays(today, 16)); await page.click('[data-cr="deal-save"]'); await page.waitForSelector(".cr-wide .cr-steps");
ok(!(await txt(".cr-wide")).includes("수정을 요청했습니다"), "조건을 고치면 수정 요청이 풀림");
await brand.page.reload(); await brand.page.waitForSelector("#lk-box .cr-kv");
await brand.page.fill("#lk-by", "이지수"); await brand.page.click('[data-act="lk-approve"]'); await brand.page.waitForTimeout(900);
ok((await txt("#lk-box", brand.page)).includes("확인하셨습니다") && (await txt("#lk-box", brand.page)).includes("이지수님이"), "브랜드: 조건 확인");
await brand.ctx.close();
await closeM(); await page.evaluate(() => CR.refresh(true)); await page.waitForTimeout(900);
const st1 = await page.evaluate(id => { const d = CR._t.S.deals.find(x => x.id === id); return { stage: d.stage, reply: d.reply, by: d.terms && d.terms.by, due: d.terms && d.terms.post_due }; }, D.contract.id);
ok(st1.stage === "contract" && st1.reply === "approved" && st1.by === "이지수" && st1.due === addDays(today, 16), "확인하면 계약 단계로, 조건이 그대로 남음 " + JSON.stringify(st1));
ok((await txt(".mkx .sp-box.info")).includes("가구 브랜드"), "계약 뒤에는 독점 조건이 보드 위에 뜸");
const al2 = await page.evaluate(() => CR._t.alerts().map(a => a.title));
ok(al2.some(t => t.includes("모노가구") && t.includes("초안 제출 2일 남음")) && await page.evaluate(() => CR._t.weekItems(7).some(w => w.k === "초안" && w.title.includes("모노가구"))), "계약하면 초안 마감을 챙기기 시작");
// 독점 경고 — 새 건을 적을 때
await page.click('.page-head [data-cr="deal-new"]'); await page.waitForSelector("#cr-d-brand");
ok((await txt(".cr-wide .sp-box.warn")).includes("모노가구") && (await txt("#cr-d-taxout")).includes("금액을 적으면"), "새 건: 독점 경고와 세금 안내");
await page.fill("#cr-d-brand", "우드온"); await page.fill("#cr-d-title", "수납장 리뷰"); await page.fill("#cr-d-amount", "1000000"); await page.waitForTimeout(100);
ok((await txt("#cr-d-taxout")).includes("3.3% 33,000원 떼고 967,000원 입금"), "금액을 적으면 받을 돈 계산 (기본: 원천징수)");
await page.selectOption("#cr-d-tax", "vat"); await page.waitForTimeout(100);
ok((await txt("#cr-d-taxout")).includes("부가세 100,000원 더해 1,100,000원 입금"), "세금계산서로 바꾸면 부가세");
await page.selectOption("#cr-d-tax", "wht"); await page.click('[data-cr="deal-save"]'); await page.waitForSelector(".cr-wide .cr-steps");
ok(await page.evaluate(() => CR._t.S.deals.some(d => d.brand === "우드온" && d.amount === 1000000 && d.stage === "nego")), "협찬 건 저장");
// 단계 옮기기
await page.click('.cr-steps [data-v="contract"]'); await page.waitForTimeout(700);
ok((await toast()).includes("계약") && await page.evaluate(() => CR._t.S.deals.find(d => d.brand === "우드온").stage === "contract"), "단계 누르면 옮겨짐");
await closeM();
// 입금 확인 → 수익에 한 줄, 완료로
await page.click(`.cr-card[data-id="${D.posted.id}"]`); await page.waitForSelector('[data-cr="deal-pay"]');
await page.click('.cr-acts [data-cr="deal-pay"]'); await page.waitForSelector("#cr-p-amount");
ok((await txt("#cr-p-net")) === "773,600원", "입금 확인: 들어왔어야 하는 돈 " + (await txt("#cr-p-net")));
await page.click('[data-cr="deal-paid"]'); await page.waitForSelector(".cr-wide .cr-steps");
const pd = await page.evaluate(id => { const d = CR._t.S.deals.find(x => x.id === id), i = CR._t.S.incs.find(x => x.deal_id === id); return { stage: d.stage, paid: d.d.paid_amount, inc: i && i.net, src: i && i.src }; }, D.posted.id);
ok(pd.stage === "done" && pd.paid === 773600 && pd.inc === 773600 && pd.src === "sponsor", "입금 확인 → 완료, 수익 기록 " + JSON.stringify(pd));
// 결과 보고서
await page.fill("#cr-v-note", "댓글에 구매처 문의가 많았습니다."); await page.click('[data-cr="deal-report"]'); await page.waitForSelector("#cr-lk-msg");
const repUrl = (await txt(".m-box .linkbox")).trim();
const rep = await open(null, { width: 420, height: 900 }, "/app/#/link/" + repUrl.split("/").pop());
await rep.page.waitForSelector("#lk-box .cr-num4");
const repTxt = await txt("#lk-box", rep.page);
ok(repTxt.includes("결과 보고서") && repTxt.includes("52,300") && repTxt.includes("툴박스") && repTxt.includes("전동 드릴 고르는 법") && repTxt.includes("구매처 문의") && repTxt.includes("제목에 [광고]"), "브랜드가 보는 결과 보고서");
ok(!repTxt.includes("800,000") && !repTxt.includes("773,600"), "보고서에 금액 없음");
ok(await count("#lk-box button", rep.page) === 0, "보고서는 보기 전용");
await shot("05-report-mobile", rep.page); await noOverflow("결과 보고서(폰)", rep.page); await rep.ctx.close();
await closeM();
// 무산 처리 · 목록 보기
await page.click(`.cr-card[data-id="${D.nego.id}"]`); await page.waitForSelector('[data-cr="deal-lost"]');
await page.click('[data-cr="deal-lost"]'); await page.waitForSelector("#cr-l-why"); await page.fill("#cr-l-why", "일정이 맞지 않음"); await page.click('[data-cr="deal-lost-go"]'); await page.waitForTimeout(700);
ok(await page.evaluate(id => { const d = CR._t.S.deals.find(x => x.id === id); return d.stage === "lost" && d.d.lost_reason === "일정이 맞지 않음"; }, D.nego.id), "무산 처리와 사유");
await closeM();
await page.selectOption('[data-crc="dst"]', "all"); await page.waitForSelector(".mkx table.tbl");
ok(await count(".mkx table.tbl tbody tr") === 10 && (await txt(".mkx table.tbl")).includes("바른공구"), "목록: 모두 10건");
await page.fill('[data-cri="dq"]', "그린"); await page.waitForTimeout(300);
ok(await count(".mkx table.tbl tbody tr") === 1, "검색");
await page.fill('[data-cri="dq"]', ""); await page.selectOption('[data-crc="dst"]', "open"); await page.waitForTimeout(200);

/* 3. 콘텐츠 */
await go("#/creator/cont"); await page.waitForSelector(".cr-board");
const cc = await page.evaluate(() => [...document.querySelectorAll(".cr-board .cr-col")].map(c => c.querySelector("h3").textContent.replace(/\s+/g, " ").trim()));
ok(cc.length === 6 && cc[0] === "아이디어 3" && cc[2] === "촬영 1" && cc[3] === "편집 1" && cc[5] === "예약 1", "제작 보드 " + cc.join(" / "));
ok(await count(".mkx table.tbl tbody tr") === 6 && (await txt(".mkx table.tbl tbody tr:nth-child(1)")).includes("실리콘 다시 쏘기"), "게시한 것 표 (최근 것부터)");
ok((await txt(".mkx table.tbl")).includes("3.9%"), "반응률 = (좋아요+댓글)÷조회");
await shot("06-content-board"); await noOverflow("콘텐츠 보드");
await page.click(`.cr-card[data-id="${C.shoot.id}"]`); await page.waitForSelector("#cr-c-title");
ok((await page.inputValue("#cr-c-cost")) === "150,000" && (await txt("#cr-c-chkn")) === "2/9" && (await page.inputValue("#cr-c-deal")) === D.contract.id, "콘텐츠 상세: 외주비·점검·협찬 연결");
await page.check('.cr-c-chk[value="ad"]'); ok((await txt("#cr-c-chkn")) === "3/9", "점검 체크");
await page.selectOption("#cr-c-stage", "edit"); await page.click('[data-cr="cont-save"]'); await page.waitForTimeout(700);
ok(await page.evaluate(id => { const c = CR._t.S.conts.find(x => x.id === id); return c.stage === "edit" && c.d.checks.length === 3; }, C.shoot.id), "콘텐츠 저장");
await page.click('.page-head [data-cr="idea-open"]'); await page.waitForSelector("#cr-i-text");
await page.fill("#cr-i-text", "타일 줄눈 새로 넣기\n\n문 손잡이 바꾸기"); await page.click('[data-cr="idea-save"]'); await page.waitForTimeout(1200);
ok((await toast()).includes("2개") && (await txt(".cr-board .cr-col:nth-child(1) h3")).includes("5"), "아이디어 여러 개 담기");
await page.click('[data-cr="cview"][data-v="cal"]'); await page.waitForSelector(".mk-cal");
ok((await txt(".mk-cal")).includes("이번 주 집수리 Q&A") && (await txt(".mk-cal")).includes("20:00"), "달력에 예약한 콘텐츠와 시각");
await shot("07-content-cal"); await noOverflow("콘텐츠 달력");
await page.click('[data-cr="cview"][data-v="board"]');

/* 4. 수익 */
await go("#/creator/inc"); await page.waitForSelector(".mkx .sp-kpis");
const gross2 = SUM.incGross + 800000, net2 = SUM.incNet + 773600;
ok((await txt(".mkx .sp-kpis .stat:nth-child(1) .s-num")) === man(gross2), "이달 수익 (입금 확인한 협찬 포함) " + (await txt(".mkx .sp-kpis .stat:nth-child(1) .s-num")));
ok((await txt(".mkx .sp-kpis .stat:nth-child(2) .s-num")) === man(net2), "실제 입금 " + man(net2));
ok((await txt(".mkx .sp-kpis .stat:nth-child(3) .s-num")) === man(26400 + 2112), "미리 뗀 세금");
ok(await count(".mkx .cr-stack > div") === 12, "12개월 막대");
ok((await txt(".mkx")).includes("받을 돈") && (await txt(".mkx")).includes("라이트온") && !(await txt(".mkx .card:nth-of-type(1)")).includes("툴박스 — 전동 드릴 PPL1"), "받을 돈 목록에 정산 대기 건");
ok(await count(".mkx table.tbl tbody tr") === 4 && (await txt(".mkx table.tbl")).includes("USD 205.1 × 1,380"), "이달 기록 4건, 외화 표시");
await shot("08-income"); await noOverflow("수익");
await page.click('[data-cr="fin-send"]'); await page.waitForTimeout(600);
const fin1 = await page.evaluate(() => DB.finance.filter(f => f.source === "creator").map(f => ({ k: f.kind, a: f.amount, p: f.proof || "", m: f.memo })));
ok(fin1.filter(f => f.k === "수입").length === 4 && fin1.filter(f => f.k === "지출").length === 1 && fin1.find(f => f.m.includes("툴박스")).a === 773600 && fin1.find(f => f.m.includes("툴박스")).p === "원천징수" && fin1.find(f => f.k === "지출").a === 150000, "돈에 기록: 수입 4건(입금액) + 외주비 1건 " + fin1.length);
ok(await count(".mkx table.tbl .pill.p-green") === 4, "‘기록됨’ 표시");
await page.click('[data-cr="fin-send"]'); await page.waitForTimeout(500);
ok((await toast()).includes("이미 같은 내용") && await page.evaluate(() => DB.finance.filter(f => f.source === "creator").length) === 5, "다시 눌러도 두 번 들어가지 않음");
await page.click(".mkx table.tbl tbody tr:has-text('채널 멤버십')"); await page.waitForSelector("#cr-n-gross");
await page.fill("#cr-n-gross", "200000"); await page.waitForTimeout(100); ok((await txt("#cr-n-net")).includes("200,000원"), "수익 고치기: 입금액 미리 보기");
await page.click('[data-cr="inc-save"]'); await page.waitForTimeout(700);
ok((await toast()).includes("다시 누르면"), "돈에 보낸 줄을 고치면 다시 보내라고 안내");
await page.click('[data-cr="fin-send"]'); await page.waitForTimeout(500);
ok(await page.evaluate(() => DB.finance.find(f => f.source === "creator" && f.memo.includes("멤버십")).amount) === 200000, "다시 보내면 금액만 고침");
await page.click('.page-head [data-cr="inc-new"]'); await page.waitForSelector("#cr-n-cur");
await page.selectOption("#cr-n-cur", "USD"); await page.fill("#cr-n-fxa", "100"); await page.fill("#cr-n-fxr", "1400"); await page.waitForTimeout(100);
ok((await page.inputValue("#cr-n-gross")) === "140,000", "외화 × 환율 = 원화 자동 계산");
await page.fill("#cr-n-title", "틱톡 크리에이터 펀드"); await page.selectOption("#cr-n-src", "ads"); await page.click('[data-cr="inc-save"]'); await page.waitForTimeout(700);
ok(await count(".mkx table.tbl tbody tr") === 5, "수익 추가");
await go("#/money"); await page.waitForTimeout(500);
ok((await txt("#view")).includes("마이크리에이터"), "돈 메뉴에 마이크리에이터 기록이 보임");

/* 5. 채널 */
await go("#/creator/chan"); await page.waitForSelector(".cr-chans");
ok(await count(".cr-chan") === 3 && (await txt(".cr-chan:nth-child(1) .big")).startsWith("50,100") && (await txt(".cr-chan:nth-child(1)")).includes("구독자") && (await txt(".cr-chan:nth-child(2)")).includes("팔로워") && (await txt(".cr-chan:nth-child(3)")).includes("이웃"), "채널 카드와 부르는 말");
const avgYt = Math.round((52300 + 40000 + 90000 + 21000) / 4);
ok((await txt(".cr-chan:nth-child(1)")).includes(fmt(avgYt) + "회") && (await txt(".cr-chan:nth-child(1)")).includes("최근 4개"), "평균 조회 = 최근 90일 콘텐츠 " + fmt(avgYt));
const rpm = Math.round((Math.round(205.1 * 1380) + 140000) / 180000 * 1000);
ok((await txt(".cr-chan:nth-child(1)")).includes(fmt(rpm) + "원"), "조회 1,000회당 = 광고수익 ÷ 조회 (" + fmt(rpm) + "원)");
ok(await count(".cr-chan:nth-child(1) .cr-spark polyline") === 1, "구독자 흐름 선");
await shot("09-channels"); await noOverflow("채널");
await page.click('.cr-chan:nth-child(1) [data-cr="snap-new"]'); await page.waitForSelector("#cr-s-subs");
ok((await page.inputValue("#cr-s-subs")) === "50,100", "이달 숫자가 채워져 있음");
await page.fill("#cr-s-subs", "50,800"); await page.click('[data-cr="snap-save"]'); await page.waitForTimeout(700);
ok((await txt(".cr-chan:nth-child(1) .big")).startsWith("50,800") && await page.evaluate(() => CR._t.S.snaps.length) === 18, "같은 달은 고쳐짐 (줄이 늘지 않음)");
await page.click('.page-head [data-cr="chan-new"]'); await page.waitForSelector("#cr-h-name"); await page.selectOption("#cr-h-plat", "tiktok"); await page.fill("#cr-h-name", "하루 틱톡"); await page.click('[data-cr="chan-save"]'); await page.waitForTimeout(700);
ok(await count(".cr-chan") === 4 && (await txt(".cr-chan:nth-child(4)")).includes("아직 적은 숫자가 없습니다"), "채널 추가");

/* 6. 단가 · 견적 */
await go("#/creator/rate"); await page.waitForSelector("#cr-q-out");
const mr = await page.evaluate(() => { const m = CR._t.myRates(); return { n: m.rows.length, med: m.med, avg: m.avg }; });
const cpvs = [800000 / 52300, 1200000 / 40000, 1800000 / 90000, 900000 / 30000].sort((a, b) => a - b);
ok(mr.n === 4 && Math.abs(mr.med - (cpvs[1] + cpvs[2]) / 2) < 1e-9 && Math.abs(mr.avg - 4700000 / 212300) < 1e-9, "내 실제 단가: 4건, 가운데 값 " + mr.med.toFixed(2) + "원");
ok((await txt("#cr-q-out .v")) === "1,500,000원" && (await txt("#cr-q-out")).includes("원천징수 3.3%") && (await txt("#cr-q-out")).includes("1,450,500"), "견적: 단가표 첫 항목");
await page.check('[data-crc="calc-opt"][value="usage"]'); await page.check('[data-crc="calc-opt"][value="rush"]'); await page.waitForTimeout(100);
ok((await txt("#cr-q-out .v")) === "2,400,000원" && (await txt("#cr-q-out")).includes("2차 활용 +30%") && (await txt("#cr-q-out")).includes("450,000"), "조건을 더하면 +30% +30%");
await page.click('[data-cr="calc-mode"][data-v="views"]'); await page.waitForSelector("#cr-q-views");
ok(Math.abs(Number(await page.inputValue("#cr-q-cpv")) - Math.round(mr.med * 10) / 10) < 1e-9, "예상 조회수 방식: 내 가운데 값이 채워짐");
await page.fill("#cr-q-views", "60,000"); await page.fill("#cr-q-cpv", "25"); await page.waitForTimeout(100);
ok((await txt("#cr-q-out .v")) === "2,400,000원" && (await txt("#cr-q-out")).includes("60,000회 × 조회당 25원"), "60,000 × 25 = 150만 + 조건 90만");
await shot("10-rates"); await noOverflow("단가·견적");
await page.click('[data-cr="quote-copy"]'); await page.waitForTimeout(200); ok((await toast()).includes("복사"), "견적 문구 복사");
await page.click('[data-cr="quote-deal"]'); await page.waitForSelector("#cr-d-amount");
ok((await page.inputValue("#cr-d-amount")) === "2,400,000", "견적 금액으로 협찬 건 만들기"); await closeM();
await page.click('[data-cr="rate-new"]'); await page.waitForSelector("#cr-r-name"); await page.fill("#cr-r-name", "인스타그램 릴스 1편"); await page.fill("#cr-r-price", "500000"); await page.click('[data-cr="rate-save"]'); await page.waitForTimeout(700);
ok(await page.evaluate(() => CR._t.S.rates.length) === 3, "단가표 추가");

/* 7. 미디어킷 */
await go("#/creator/kit"); await page.waitForSelector('[data-cr="kit-on"]');
ok((await txt(".mkx")).includes("닫힘") && await count(".cr-k-pick") === 5 && await count(".cr-k-pick:checked") === 3, "미디어킷: 닫힘, 대표 콘텐츠 후보(주소 있는 것만) 5개");
await shot("11-kit-edit");
await page.click('[data-cr="kit-on"]'); await page.waitForSelector(".mkx .linkbox");
const kitUrl = (await txt(".mkx .linkbox")).trim();
ok(/\/link\/[0-9a-f]{32}$/.test(kitUrl) && (await txt(".mkx")).includes("공개 중"), "미디어킷 열기 → 주소");
const kit = await open(null, { width: 1100, height: 900 }, "/app/#/link/" + kitUrl.split("/").pop());
await kit.page.waitForSelector("#lk-box .cr-kit-top");
let kt = await txt("#lk-box", kit.page);
ok(kt.includes("하루") && kt.includes("혼자 사는 집을 직접 고치는 사람") && kt.includes("50,800") && kt.includes("12,400") && kt.includes(fmt(avgYt)) && kt.includes("셀프 인테리어"), "미디어킷: 채널 숫자와 소개");
ok(kt.includes(fmt(Math.round((180000 + 325000 + 309000) / 3))), "월 조회 = 최근 석 달 평균");
ok(kt.includes("벽지 셀프 도배") && kt.includes("전동 드릴 고르는 법") && kt.includes("여성 46%"), "대표 콘텐츠와 보는 사람");
ok(kt.includes("함께한 브랜드") && kt.includes("툴박스") && kt.includes("그린월") && !kt.includes("스틸랙") && !kt.includes("모노가구"), "함께한 브랜드: 보여 주기로 한 건만");
ok(!kt.includes("1,500,000") && !kt.includes("800,000") && !kt.includes("단가"), "금액·단가는 안 나감");
ok((await count("#lk-box .lk-cta", kit.page)) === 1, "마이웍스 알아보기 링크");
await shot("12-kit-public", kit.page); await noOverflow("미디어킷", kit.page);
await kit.page.click('[data-cr="inq-send"]'); await kit.page.waitForTimeout(200);
ok((await txt("#toast", kit.page)).includes("회사나 담당자"), "문의: 빈 칸 안내");
await kit.page.fill("#cr-iq-company", "오크랩"); await kit.page.fill("#cr-iq-name", "박서연"); await kit.page.fill("#cr-iq-email", "seoyeon@oaklab.example"); await kit.page.fill("#cr-iq-budget", "100~200만 원"); await kit.page.fill("#cr-iq-msg", "신제품 원목 책상 협업을 제안드립니다.\n12월 둘째 주 게시를 희망합니다.");
await kit.page.click('[data-cr="inq-send"]'); await kit.page.waitForTimeout(900);
ok((await txt("#lk-box", kit.page)).includes("문의를 보냈습니다") && (await count("#cr-inq", kit.page)) === 0, "문의 보냄");
// 받은 쪽: 보드 ‘문의’ 칸에 새 문의
await go("#/creator/deal"); await page.evaluate(() => CR.refresh(true)); await page.waitForTimeout(1000);
ok((await txt(".cr-board .cr-col:nth-child(1)")).includes("오크랩") && (await txt(".cr-board .cr-col:nth-child(1) .cr-card.new")).includes("새 문의") && (await txt(".sp-tabs [data-to='deal'] .nbadge")) === "1", "문의가 보드 ‘문의’ 칸에 새 문의로");
await page.click(".cr-board .cr-col:nth-child(1) .cr-card.new"); await page.waitForSelector(".cr-wide .cr-inq");
ok((await txt(".cr-wide .cr-inq")).includes("신제품 원목 책상") && (await txt(".cr-wide .cr-inq")).includes("seoyeon@oaklab.example") && (await txt(".cr-wide .cr-inq")).includes("100~200만 원"), "문의 원문이 건 안에 남음");
await shot("13-inquiry"); await closeM(); await page.waitForTimeout(400);
ok((await count(".cr-card.new")) === 0 && !(await txt(".cr-board .cr-col:nth-child(1)")).includes("새 문의") && (await count(".sp-tabs [data-to='deal'] .nbadge")) === 0, "열어 보면 새 문의 표시와 탭 배지가 풀림");
// 단가 보여 주기 · 문의 끄기
await go("#/creator/kit"); await page.waitForSelector("#cr-k-rates");
await page.check("#cr-k-rates"); await page.uncheck("#cr-k-inq"); await page.click('[data-cr="kit-save"]'); await page.waitForTimeout(700);
await kit.page.reload(); await kit.page.waitForSelector("#lk-box .cr-kit-top"); kt = await txt("#lk-box", kit.page);
ok(kt.includes("단가") && kt.includes("브랜디드 영상 1편") && kt.includes("1,500,000원") && (await count("#cr-inq", kit.page)) === 0, "단가를 켜면 나가고, 문의를 끄면 양식이 사라짐");
await page.click('[data-cr="kit-off"]'); await page.waitForTimeout(700);
await kit.page.reload(); await kit.page.waitForTimeout(900);
ok((await txt("#lk-box", kit.page)).includes("찾을 수 없습니다"), "닫으면 주소가 열리지 않음"); await kit.ctx.close();

/* 8. 설정 · 안내 */
await go("#/creator/set"); await page.waitForSelector('input[name="cr-biz"]');
ok(await page.isChecked('input[name="cr-biz"][value="exempt"]') && (await txt(".mkx")).includes("제목이나 본문 첫 부분") && (await txt(".mkx")).includes("5분마다"), "설정: 사업 형태와 광고 표기 안내");
await page.check('input[name="cr-biz"][value="taxable"]'); await page.click('[data-cr="set-save"]'); await page.waitForTimeout(700);
await go("#/creator/rate"); await page.waitForSelector("#cr-q-out");
ok((await txt("#cr-q-out")).includes("부가세 10%"), "과세사업자로 바꾸면 견적이 부가세로");
await shot("14-settings-effect");
await go("#/creator/set"); await page.waitForSelector('input[name="cr-biz"]'); await shot("15-settings"); await noOverflow("설정·안내");

/* 9. 홈 · 확장판 · AI 제안 */
await go("#/dashboard"); await page.waitForSelector("#cr-dash-slot .card");
ok((await txt("#cr-dash-slot")).includes("진행 중인 협찬") && (await txt("#cr-dash-slot")).includes("이달 수익") && (await txt("#cr-dash-slot")).includes("지금 챙길 것"), "홈 요약 카드");
await shot("16-home");
await go("#/ext"); await page.waitForTimeout(400);
ok((await txt("#view")).includes("마이크리에이터") && (await txt("#view")).includes("미디어킷 주소 하나로"), "확장판 목록에 마이크리에이터");
await shot("17-ext");
const TK = (await api("token/create", { name: "클로드", scope: "write", modules: ["creator"] }, A)).token;
await api("ai/propose", { kind: "cr-idea", payload: { title: "겨울 결로 막는 법 2탄", channel: "하루의 작업실", format: "long" }, reason: "댓글 요청이 많음" }, TK);
await api("ai/propose", { kind: "cr-deal", payload: { brand: "따숨", title: "전기요 리뷰", amount: 600000, due: addDays(today, 30) } }, TK);
await page.evaluate(() => pollSync(true)); await page.waitForTimeout(1200); await go("#/dashboard"); await page.waitForTimeout(600);
ok((await txt("#view")).includes("콘텐츠 아이디어") && (await txt("#view")).includes("겨울 결로 막는 법 2탄") && (await txt("#view")).includes("협찬 건") && (await txt("#view")).includes("600,000원"), "AI 제안이 ‘오늘 결정할 것’에");

/* 10. 권한 · 휴대폰 */
const staff = await open((await api("login", { loginId: "staff01", pw: "pw123456" })).token);
await staff.page.waitForSelector(".mkx .sp-kpis"); ok((await txt(".mkx .sp-kpis .stat:nth-child(3) .s-lb", staff.page)).includes("진행 중인 협찬"), "직원도 씀"); await staff.ctx.close();
const worker = await open((await api("login", { loginId: "alba01", pw: "pw123456" })).token);
await worker.page.waitForTimeout(600); ok(!(await txt("#view", worker.page)).includes("진행 중인 협찬") && (await count("[data-nav='creator']", worker.page)) === 0, "현장 근무자에게는 안 보임"); await worker.ctx.close();
await ctx.close();
({ ctx, page } = await open(A, { width: 390, height: 844 }));
await page.waitForSelector(".mkx .sp-kpis"); await shot("20-m-dash"); await noOverflow("폰: 요약");
for (const [h, sel, n] of [["deal", ".cr-board", "협찬"], ["cont", ".cr-board", "콘텐츠"], ["inc", ".sp-kpis", "수익"], ["chan", ".cr-chans", "채널"], ["rate", "#cr-q-out", "단가"], ["kit", "#cr-k-name", "미디어킷"], ["set", 'input[name="cr-biz"]', "설정"]]) { await go("#/creator/" + h); await page.waitForSelector(sel); await shot("21-m-" + h); await noOverflow("폰: " + n); }
await go("#/creator/deal"); await page.waitForSelector(".cr-board");
await page.click(`.cr-card[data-id="${D.contract.id}"]`); await page.waitForSelector(".cr-wide .cr-steps"); await shot("22-m-deal-view");
ok(await page.evaluate(() => { const m = document.querySelector("#m-box"); return m.scrollWidth <= m.clientWidth + 1; }), "폰: 협찬 상세가 창 안에 들어감");
await closeM();
await page.click('[data-cr="cview"]', { timeout: 1000 }).catch(() => {});
await go("#/creator/cont"); await page.waitForSelector(".cr-board"); await page.click('[data-cr="cview"][data-v="cal"]'); await page.waitForSelector(".mk-cal"); await shot("23-m-cal"); await noOverflow("폰: 달력");

ok(errors.length === 0, "콘솔 오류 없음" + (errors.length ? ": " + errors.slice(0, 4).join(" | ") : ""));
console.log(`통과 ${pass} · 실패 ${failN}`);
bye(failN ? 1 : 0);
