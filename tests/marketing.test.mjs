// 마이마케팅 서버 시험 — node tests/marketing.test.mjs
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
  return { s: r.status, j: await r.json(), q: DB.queries };
}
const addDays = (ds, n) => { const d = new Date(ds + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), d1 = addDays(today, -1), d2 = addDays(today, -2), d3 = addDays(today, -3);

const A = (await call("owner-setup", { loginId: "boss01", pw: "pass1234", name: "대표", workspace: "하루공방" })).j.token;
let r = await call("mk/data", null, A); ok(r.s === 403 && r.j.error === "module-off", "marketing off by default");
r = await call("ws/modules", { modules: ["marketing", "space"] }, A); ok(r.j.modules.includes("marketing"), "module on " + JSON.stringify(r.j.modules));
await call("member/create", { loginId: "staff01", pw: "pw123456", name: "직원", role: "staff" }, A);
await call("member/create", { loginId: "alba01", pw: "pw123456", name: "알바", role: "worker" }, A);
await call("member/create", { loginId: "part01", pw: "pw123456", name: "협력", role: "partner" }, A);
const S = (await call("login", { loginId: "staff01", pw: "pw123456" })).j.token, W = (await call("login", { loginId: "alba01", pw: "pw123456" })).j.token, P = (await call("login", { loginId: "part01", pw: "pw123456" })).j.token;

/* ── 처음 상태 · 설정 ── */
r = await call("mk/data", null, A);
ok(r.s === 200 && r.j.chans.length === 0 && r.j.camps.length === 0 && r.j.stats.length === 0 && r.j.settings.mode === "basic" && r.j.conn.naver.on === false && r.j.keys.vault === false, "empty data");
r = await call("mk/data", null, W); ok(r.s === 403, "worker cannot read");
r = await call("mk/data", null, P); ok(r.s === 403, "partner cannot read");
r = await call("mk/data", null, S); ok(r.s === 200, "staff reads");
r = await call("mk/settings", { set: { mode: "boost", budget: "1,500,000", biz: { type: "space", aov: 120000, margin: 45, goal: "lead", region: "서울 마포", assets: ["place", "insta"] }, target: { cpa: 18000, roas: 350 }, guard: { step: 99, minClk: 1 }, ref: { search: { ctr: 1.2, cvr: 3 }, bogus: { ctr: 5 } } } }, A);
ok(r.j.settings.mode === "boost" && r.j.settings.budget === 1500000 && r.j.settings.biz.margin === 45 && r.j.settings.target.cpa === 18000 && r.j.settings.guard.step === 50 && r.j.settings.guard.minClk === 5 && r.j.settings.ref.search.ctr === 1.2 && !r.j.settings.ref.bogus, "settings normalize " + JSON.stringify(r.j.settings.guard));
r = await call("mk/settings", { set: { checks: ["naver_sa:ext", "meta:pixel"], mode: "weird" } }, A);
ok(r.j.settings.checks.length === 2 && r.j.settings.mode === "basic" && r.j.settings.budget === 1500000, "settings merge keeps budget");
await call("mk/settings", { set: { mode: "boost" } }, A);

/* ── 채널 ── */
r = await call("mk/chan/save", { name: "네이버 파워링크", kind: "naver_sa", cat: "search", url: "javascript:alert(1)" }, A); const ch1 = r.j.chan; ok(ch1 && ch1.kind === "naver_sa" && ch1.url === "" && ch1.active === 1, "chan save + url guard");
r = await call("mk/chan/save", { name: "인스타그램 광고", kind: "meta_ads", cat: "target" }, A); const ch2 = r.j.chan;
r = await call("mk/chan/save", { name: "인스타그램 계정", kind: "instagram", cat: "content", handle: "@haru" }, S); const ch3 = r.j.chan; ok(ch3.handle === "@haru", "staff saves chan");
r = await call("mk/chan/save", { name: "", kind: "x" }, A); ok(r.s === 400, "chan needs name");
r = await call("mk/chan/save", { id: ch3.id, name: "인스타 @haru", kind: "nope" }, A); ok(r.j.chan.name === "인스타 @haru" && r.j.chan.kind === "etc", "chan update");
await call("mk/chan/save", { id: ch3.id, kind: "instagram" }, A);

/* ── 캠페인 ── */
r = await call("mk/camp/save", { name: "파티룸 지역 키워드", chan_id: "nope" }, A); ok(r.s === 400 && r.j.error === "bad-channel", "camp bad channel");
r = await call("mk/camp/save", { name: "파티룸 지역 키워드", chan_id: ch1.id, cat: "search", goal: "lead", budget: 20000, budget_type: "day", target_cpa: 15000, landing: "https://example.com/party", mode: "boost" }, A);
const cp1 = r.j.camp; ok(cp1 && cp1.budget === 20000 && cp1.budget_type === "day" && cp1.target_cpa === 15000 && cp1.mode === "boost" && cp1.status === "live", "camp save");
r = await call("mk/camp/save", { name: "릴스 리타겟", chan_id: ch2.id, cat: "target", goal: "sale", budget: 600000, target_roas: 400, status: "weird", mode: "x" }, A);
const cp2 = r.j.camp; ok(cp2.status === "live" && cp2.mode === "" && cp2.target_roas === 400 && cp2.target_cpa === null, "camp defaults");
r = await call("mk/camp/save", { id: cp2.id, status: "pause", memo: "소재 교체 대기" }, A); ok(r.j.camp.status === "pause" && r.j.camp.name === "릴스 리타겟", "camp update");
r = await call("mk/camp/save", { id: "none", name: "x" }, A); ok(r.s === 404, "camp 404");

/* ── 성과: 직접 입력 ── */
r = await call("mk/stat/save", { date: "2026-13-40x", chan_id: ch1.id }, A); ok(r.s === 400 && r.j.error === "bad-date", "stat bad date");
r = await call("mk/stat/save", { date: d1, chan_id: "nope", cost: 1 }, A); ok(r.s === 400 && r.j.error === "bad-channel", "stat bad channel");
r = await call("mk/stat/save", { date: d1, camp_id: cp1.id, cost: "18,400", imp: 2100, clk: 64, conv: "3", rev: 0 }, A);
ok(r.j.stat.cost === 18400 && r.j.stat.chan_id === ch1.id && r.j.stat.conv === 3 && r.j.stat.src === "manual", "stat save takes channel from campaign");
r = await call("mk/stat/save", { date: d1, camp_id: cp1.id, cost: 19000, imp: 2200, clk: 70, conv: 4 }, A);
r = await call("mk/data", null, A); ok(r.j.stats.length === 1 && r.j.stats[0].cost === 19000, "same cell replaced, not doubled");
r = await call("mk/stat/save", { date: d1, chan_id: ch3.id, view: 5400, eng: 310, fol: 1820 }, A); ok(r.j.stat.fol === 1820 && r.j.stat.camp_id === "", "channel-level organic row");

/* ── 성과: 보고서 파일 ── */
r = await call("mk/stat/import", { chan_id: ch2.id, rows: [
  { date: d2, camp: "릴스 리타겟", label: "소재A 후기", cost: 30000, imp: 9000, clk: 120, conv: 2, rev: 240000 },
  { date: d2, camp: "릴스 리타겟", label: "소재B 가격", cost: 20000, imp: 8000, clk: 60, conv: 1, rev: 110000 },
  { date: d2, camp: "릴스 리타겟", label: "", cost: 50000, imp: 17000, clk: 180, conv: 3, rev: 350000 },
  { date: d2, camp: "릴스  리타겟", label: "소재A 후기", cost: 1000, imp: 100, clk: 1, conv: 0.5, rev: 0 },
  { date: d2, camp: "신규 관심사 타겟", cost: 12000, imp: 6000, clk: 40, conv: 0 },
  { date: "nope", camp: "x", cost: 1 }, null
] }, A);
ok(r.j.added === 3 && r.j.camps === 1 && r.j.skipped === 2 && r.j.from === d2, "import: total row dropped when detail exists, new campaign made " + JSON.stringify(r.j));
r = await call("mk/data", null, A);
const sA = r.j.stats.find(x => x.label === "소재A 후기"); ok(sA && sA.cost === 31000 && sA.conv === 2.5 && sA.camp_id === cp2.id && sA.src === "file", "import: same label summed, matched by name ignoring spaces");
const cp3 = r.j.camps.find(c => c.name === "신규 관심사 타겟"); ok(cp3 && cp3.chan_id === ch2.id && cp3.cat === "target", "import: campaign created with channel category");
r = await call("mk/stat/import", { chan_id: ch2.id, rows: [{ date: d2, camp: "릴스 리타겟", cost: 55000, imp: 17500, clk: 185, conv: 3, rev: 360000 }] }, A);
r = await call("mk/data", null, A); ok(r.j.stats.filter(x => x.camp_id === cp2.id && x.date === d2).length === 1 && r.j.stats.find(x => x.camp_id === cp2.id && x.date === d2).cost === 55000, "re-import replaces the whole cell");
r = await call("mk/stat/import", { chan_id: ch2.id, rows: [{ date: d3, camp: "릴스 리타겟", label: "소재A 후기", cost: 9000, imp: 3000, clk: 30, conv: 1 }, { date: d3, camp: "릴스 리타겟", label: "소재B 가격", cost: 7000, imp: 2800, clk: 12, conv: 0 }] }, A);
r = await call("mk/stat/save", { date: d3, camp_id: cp2.id, cost: 1 }, A); ok(r.s === 409 && r.j.error === "has-detail" && r.j.n === 2, "manual total blocked when detail rows exist");
r = await call("mk/stat/save", { date: d3, camp_id: cp2.id, cost: 16500, imp: 5800, clk: 42, conv: 1, replace: true }, A); ok(r.s === 200 && r.j.replaced === 2, "replace with confirmation");
r = await call("mk/stat/save", { date: d3, camp_id: cp2.id, label: "소재C", cost: 100 }, A);
r = await call("mk/data", null, A); ok(r.j.stats.filter(x => x.camp_id === cp2.id && x.date === d3).length === 1 && r.j.stats.find(x => x.camp_id === cp2.id && x.date === d3).label === "소재C", "labelled row removes the total row of its cell");
r = await call("mk/stat/import", { chan_id: "nope", rows: [{ date: d1, cost: 1 }] }, A); ok(r.s === 400 && r.j.error === "bad-channel", "import bad channel");
r = await call("mk/stat/import", { rows: [{ date: d1, cost: 1 }] }, A); ok(r.s === 400 && r.j.error === "empty", "import without channel = nothing to add");
r = await call("mk/stat/import", { chan_id: ch1.id, mkcamp: false, rows: [{ date: d2, camp: "없는 캠페인", cost: 700, clk: 3 }] }, A);
r = await call("mk/data", null, A); ok(r.j.stats.some(x => x.chan_id === ch1.id && x.camp_id === "" && x.cost === 700) && !r.j.camps.some(c => c.name === "없는 캠페인"), "mkcamp=false keeps row on channel");
const big = []; for (let i = 0; i < 3000; i++) big.push({ date: addDays(today, -(i % 60) - 5), camp: "대량 " + (i % 50), label: "g" + (i % 7), cost: 100 + i, imp: 1000, clk: 10 });
r = await call("mk/stat/import", { chan_id: ch1.id, rows: big }, A); ok(r.s === 200 && r.j.camps === 50 && r.q < 20, "bulk import 3000 rows in " + r.q + " queries");
// 채널 옮기기 → 성과도 따라감, 캠페인 삭제 → 성과 삭제
r = await call("mk/camp/save", { id: cp3.id, chan_id: ch1.id }, A);
r = await call("mk/data", null, A); ok(r.j.stats.filter(x => x.camp_id === cp3.id).every(x => x.chan_id === ch1.id), "moving campaign moves its stats");
r = await call("mk/chan/del", { id: ch2.id }, A); ok(r.s === 409 && r.j.error === "in-use", "channel in use cannot be deleted");
r = await call("mk/camp/del", { id: cp3.id }, A); ok(r.s === 200 && r.j.stats === 1, "camp delete removes stats");
const idsBulk = (await call("mk/data", null, A)).j.stats.filter(x => /^대량/.test("대량") && x.label.startsWith("g")).map(x => x.id);
r = await call("mk/stat/del", { ids: idsBulk }, A); ok(r.j.deleted === idsBulk.length && idsBulk.length > 100, "stat bulk delete " + idsBulk.length);

/* ── 콘텐츠 ── */
r = await call("mk/post/save", { title: "11월 대관 후기 릴스", chan_id: ch3.id, date: today, time: "19:30", format: "릴스", status: "ready", body: "촬영 컷 3장", paid: true, url: "ftp://x" }, A);
const po1 = r.j.post; ok(po1 && po1.time === "19:30" && po1.paid === 1 && po1.url === "" && po1.status === "ready", "post save");
r = await call("mk/post/save", { id: po1.id, status: "posted", url: "https://instagram.com/p/abc", view: 4200, eng: 260 }, A); ok(r.j.post.status === "posted" && r.j.post.view === 4200 && r.j.post.title === "11월 대관 후기 릴스", "post update");
r = await call("mk/post/save", { body: "제목 없음" }, A); ok(r.s === 400, "post needs title");
r = await call("mk/post/save", { title: "아이디어" }, A); const po2 = r.j.post; ok(po2.status === "idea" && po2.date === null, "idea post");
r = await call("mk/post/del", { id: po2.id }, A); ok(r.s === 200, "post del");

/* ── 키워드 ── */
r = await call("mk/kw/save", { word: "  홍대   파티룸 ", grp: "지역", state: "use", bid: 700 }, A); const kw1 = r.j.kw; ok(kw1.word === "홍대 파티룸" && kw1.state === "use" && kw1.bid === 700, "kw save trims");
r = await call("mk/kw/save", { word: "홍대 파티룸" }, A); ok(r.s === 409 && r.j.error === "dup", "kw dup");
r = await call("mk/kw/import", { rows: [{ word: "홍대 파티룸", vol_pc: 1200, vol_mo: 9800, comp: "높음", grp: "덮어쓰면 안 됨" }, { word: "연남동 파티룸", vol_pc: 300, vol_mo: 2400, comp: "중간" }, { word: "연남동 파티룸" }, { word: "" }] }, A);
ok(r.j.n === 2 && r.j.kws.length === 2, "kw import");
const k1 = r.j.kws.find(k => k.word === "홍대 파티룸"); ok(k1.vol_mo === 9800 && k1.grp === "지역" && k1.state === "use" && k1.id === kw1.id && !!k1.checked_at, "kw import refreshes volume, keeps group/state");
r = await call("mk/kw/save", { id: kw1.id, word: "연남동 파티룸" }, A); ok(r.s === 409, "kw rename dup");
r = await call("mk/kw/save", { id: kw1.id, state: "neg", memo: "전환 없음" }, A); ok(r.j.kw.state === "neg", "kw update");
r = await call("mk/kw/del", { ids: [r.j.kw.id] }, A); ok(r.j.deleted === 1, "kw del");

/* ── 실행안 ── */
r = await call("mk/act/bulk", { rows: [
  { key: "scale:" + cp1.id + ":2026-W47", kind: "budget", mode: "boost", camp_id: cp1.id, title: "예산 20% 늘리기", detail: "목표 CPA 안", from_v: "20,000원", to_v: "24,000원", base: { cost: 133000, conv: 9, cpa: 14778 } },
  { key: "ctr:" + cp2.id + ":2026-W47", kind: "creative", mode: "opt", camp_id: cp2.id, title: "소재 교체" },
  { key: "ctr:" + cp2.id + ":2026-W47", kind: "creative", title: "중복 열쇠" }, { title: "열쇠 없음" }
] }, A);
ok(r.j.acts.length === 2 && r.j.acts.find(a => a.kind === "budget").base.cpa === 14778 && r.j.acts.every(a => a.by === "auto"), "act bulk");
const ac1 = r.j.acts.find(a => a.kind === "budget");
r = await call("mk/act/bulk", { rows: [{ key: "scale:" + cp1.id + ":2026-W47", title: "예산 또 늘리기" }, { key: "new:1", title: "새 실행안" }] }, A);
ok(r.j.acts.length === 2 && r.j.acts.find(a => a.key.startsWith("scale")).title === "예산 20% 늘리기", "act bulk ignores existing key");
r = await call("mk/act/save", { id: ac1.id, status: "done", task_id: "t_1" }, A); ok(r.j.act.status === "done" && !!r.j.act.done_at && r.j.act.task_id === "t_1", "act done");
r = await call("mk/act/save", { id: ac1.id, status: "todo" }, A); ok(r.j.act.status === "todo" && r.j.act.done_at === null, "act reopen");
r = await call("mk/act/save", { title: "랜딩 첫 화면 문구 고치기", detail: "전화 버튼 위로", kind: "landing" }, S); const ac3 = r.j.act; ok(ac3.status === "todo" && ac3.key === null && ac3.mode === "opt", "manual act");
r = await call("mk/act/del", { id: ac3.id }, A); ok(r.s === 200, "act del");

/* ── 기획안 한 번에 ── */
const plan = { chans: [{ name: "네이버 플레이스", kind: "naver_place", cat: "local" }, { name: "네이버 파워링크 2", kind: "naver_sa", cat: "search" }, { name: "체험단", kind: "influencer", cat: "influ" }],
  camps: [{ chan: "naver_place", name: "플레이스 광고", goal: "visit", budget: 300000 }, { chan: "체험단", name: "12월 체험단 5팀", goal: "aware", budget: 250000, budget_type: "total" }, { chan: "naver_sa", name: "파티룸 지역 키워드", budget: 1 }, { chan: "없는 채널", name: "버려짐" }],
  posts: [{ chan: "instagram", date: addDays(today, 3), title: "연말 예약 오픈 안내", format: "피드" }, { title: "" }],
  acts: [{ title: "스마트플레이스 사진 10장 교체", chan: "naver_place", kind: "setup" }], kws: ["홍대 파티룸", "합정 파티룸", { word: "무료", state: "neg" }],
  set: { plan: { at: "2026-11-19T00:00:00Z", type: "space", goal: "lead", budget: 1500000 } } };
r = await call("mk/plan/apply", plan, A);
ok(r.s === 200 && r.j.made.chans === 2 && r.j.made.camps === 2 && r.j.made.posts === 1 && r.j.made.acts === 1 && r.j.made.kws === 3 && r.q < 20, "plan apply " + JSON.stringify(r.j.made) + " q=" + r.q);
r = await call("mk/data", null, A);
ok(r.j.chans.length === 5 && r.j.camps.find(c => c.name === "플레이스 광고").status === "plan" && r.j.camps.find(c => c.name === "플레이스 광고").cat === "local" && r.j.settings.plan.type === "space" && r.j.settings.mode === "boost", "plan result: status plan, category from channel, settings merged");
ok(r.j.kws.find(k => k.word === "무료").state === "neg" && r.j.posts.find(p => p.title === "연말 예약 오픈 안내").chan_id === ch3.id, "plan: negative keyword, post on existing channel by kind");
r = await call("mk/plan/apply", plan, A); ok(r.j.made.chans === 0 && r.j.made.camps === 0, "plan apply twice does not duplicate channels/campaigns");
r = await call("mk/plan/apply", {}, A); ok(r.s === 400 && r.j.error === "empty", "plan empty");

/* ── 광고 계정 연결 ── */
r = await call("mk/conn/save", { src: "naver", key: "0100000000abcdEFGH1234", secret: "AQAAAABsecretSECRET==", cid: "1234567" }, A); ok(r.s === 400 && r.j.error === "no-vault", "conn needs vault key");
ENV.MW_VAULT_KEY = "short"; r = await call("mk/conn/save", { src: "naver", key: "k", secret: "s", cid: "1" }, A); ok(r.j.error === "no-vault", "short vault key ignored");
ENV.MW_VAULT_KEY = "a-long-enough-vault-key-2026";
r = await call("mk/conn/save", { src: "naver", key: "0100000000abcdEFGH1234", secret: "AQAAAABsecretSECRET==", cid: "1234567" }, S); ok(r.s === 403, "staff cannot save connection");
r = await call("mk/conn/save", { src: "naver", key: "0100000000abcdEFGH1234", secret: "AQAAAABsecretSECRET==", cid: "123-4567" }, A);
ok(r.s === 200 && r.j.conn.naver.on && r.j.conn.naver.cid === "1234567" && r.j.conn.naver.tail === "…1234" && !JSON.stringify(r.j).includes("secretSECRET"), "conn saved, secret not echoed");
const rawConn = DB.raw.prepare("SELECT v FROM mod_set WHERE mod='mk' AND k='conn'").get().v;
ok(!rawConn.includes("secretSECRET") && !rawConn.includes("abcdEFGH1234") && /"sealed":"v1\.[0-9a-f]{24}\.[0-9a-f]+"/.test(rawConn), "stored encrypted");
r = await call("mk/data", null, S); ok(r.j.conn.naver.on === true && r.j.keys.vault === true && !JSON.stringify(r.j.conn).includes("sealed"), "data shows connection status only");

// 바깥 서비스 흉내
const calls = []; let naverCamps, naverStats, metaPages, ytItem, failAll = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init) => {
  const url = new URL(String(u)), h = Object.fromEntries(Object.entries((init && init.headers) || {}).map(([k, v]) => [k.toLowerCase(), v]));
  calls.push({ host: url.host, path: url.pathname, q: Object.fromEntries(url.searchParams), h, body: init && init.body });
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
  if (failAll) return J({ title: "Forbidden" }, 403);
  if (url.host === "api.searchad.naver.com") {
    const want = nodeCrypto.createHmac("sha256", "AQAAAABsecretSECRET==").update(h["x-timestamp"] + "." + ((init && init.method) || "GET") + "." + url.pathname).digest("base64");
    if (h["x-signature"] !== want || h["x-api-key"] !== "0100000000abcdEFGH1234" || h["x-customer"] !== "1234567") return J({ title: "Invalid Signature" }, 403);
    if (url.pathname === "/ncc/campaigns") return J(naverCamps);
    if (url.pathname === "/stats") return J({ data: naverStats[url.searchParams.get("id")] || [] });
    if (url.pathname === "/keywordstool") return J({ keywordList: [{ relKeyword: "홍대파티룸", monthlyPcQcCnt: 1300, monthlyMobileQcCnt: 10200, compIdx: "높음", plAvgDepth: 15 }, { relKeyword: "홍대소규모파티룸", monthlyPcQcCnt: "< 10", monthlyMobileQcCnt: 40, compIdx: "낮음", plAvgDepth: 3 }] });
  }
  if (url.host === "graph.facebook.com") { if (url.pathname.endsWith("/insights")) return J(metaPages[url.searchParams.get("after") ? 1 : 0]); return J({ name: "하루공방 광고계정", currency: "KRW", account_status: 1 }); }
  if (url.host === "www.googleapis.com") return J({ items: ytItem ? [ytItem] : [] });
  if (url.host === "openapi.naver.com") return J({ results: [{ title: "파티룸", keywords: ["파티룸"], data: [{ period: "2026-10-05", ratio: 71.23456 }, { period: "2026-10-12", ratio: 100 }] }] });
  return J({}, 404);
};
r = await call("mk/conn/test", { src: "naver" }, S); ok(r.s === 502 || r.s === 200, "conn test reachable");
naverCamps = [{ nccCampaignId: "cmp-a001-01-000000001", name: "파티룸 지역 키워드", campaignTp: "WEB_SITE", useDailyBudget: true, dailyBudget: 20000 }, { nccCampaignId: "cmp-a001-01-000000002", name: "브랜드 검색", campaignTp: "BRAND_SEARCH", useDailyBudget: true, dailyBudget: 5000 }];
naverStats = { "cmp-a001-01-000000001": [{ dateStart: d2, dateEnd: d2, impCnt: 1900, clkCnt: 55, salesAmt: 16500, ccnt: 2, convAmt: 0 }, { dateStart: d1, dateEnd: d1, impCnt: 2300, clkCnt: 71, salesAmt: 20900, ccnt: 4, convAmt: 0 }, { dateStart: today, dateEnd: today, impCnt: 0, clkCnt: 0, salesAmt: 0, ccnt: 0 }],
  "cmp-a001-01-000000002": [{ dateStart: d1, dateEnd: d1, impCnt: 120, clkCnt: 30, salesAmt: 2100, ccnt: 1, convAmt: 0 }] };
r = await call("mk/conn/test", { src: "naver" }, S); ok(r.s === 200 && r.j.campaigns === 2, "naver test ok (signature verified by mock)");
calls.length = 0;
r = await call("mk/sync", { src: "naver", days: 7 }, S);
ok(r.s === 200 && r.j.rows === 3 && r.j.camps === 1 && r.q < 25, "naver sync " + JSON.stringify(r.j) + " q=" + r.q);
const statCall = calls.find(c => c.path === "/stats"); ok(statCall && statCall.q.timeIncrement === "1" && JSON.parse(statCall.q.timeRange).until === today && JSON.parse(statCall.q.fields).includes("salesAmt") && calls.length === 3, "naver stats request shape, " + calls.length + " calls");
r = await call("mk/data", null, A);
const n1 = r.j.stats.find(x => x.camp_id === cp1.id && x.date === d1); ok(n1 && n1.cost === 20900 && n1.src === "naver" && n1.conv === 4, "naver sync replaced the manual cell for the same campaign (matched by name)");
ok(r.j.camps.find(c => c.id === cp1.id).ext_id === "cmp-a001-01-000000001", "ext_id learned for existing campaign");
const brand = r.j.camps.find(c => c.name === "브랜드 검색"); ok(brand && brand.ext_id === "cmp-a001-01-000000002" && brand.budget === 5000 && brand.budget_type === "day" && brand.chan_id === ch1.id, "naver campaign created on existing naver channel");
ok(!!r.j.settings.synced.naver, "synced time saved");
r = await call("mk/sync", { src: "naver" }, S); ok(r.s === 429 && r.j.error === "too-soon", "sync throttled");
// 이름이 바뀌어도 광고 계정의 캠페인 번호로 이어짐
DB.raw.prepare("UPDATE mod_set SET v=json_set(v,'$.synced.naver','2026-01-01T00:00:00.000Z') WHERE mod='mk' AND k='settings'").run();
naverCamps[1].name = "브랜드 검색 (이름 바꿈)";
r = await call("mk/sync", { src: "naver", days: 7 }, S); ok(r.j.camps === 0 && r.j.rows === 3, "renamed campaign still matched by ext_id");
r = await call("mk/kwtool", { words: ["홍대 파티룸", "홍대 파티룸", ""] }, S); ok(r.s === 200 && r.j.items.length === 2 && r.j.items[0].vol_mo === 10200 && r.j.items[1].low === true && r.j.items[1].vol_pc === 10, "keyword tool");
ok(calls[calls.length - 1].q.hintKeywords === "홍대파티룸", "hint keywords without spaces, deduped");
// 메타
r = await call("mk/sync", { src: "meta" }, S); ok(r.s === 400 && r.j.error === "no-conn", "meta not connected");
r = await call("mk/conn/save", { src: "meta", token: "EAAGtoken1234567890", acct: "act_998877" }, A); ok(r.j.conn.meta.on && r.j.conn.meta.acct === "998877" && r.j.conn.naver.on, "meta conn keeps naver");
await call("mk/settings", { set: { metaConv: "purchase" } }, A);
metaPages = [{ data: [
  { campaign_id: "2385001", campaign_name: "릴스 리타겟", date_start: d1, date_stop: d1, spend: "41250.4", impressions: "15200", inline_link_clicks: "190", clicks: "260", actions: [{ action_type: "purchase", value: "3" }, { action_type: "omni_purchase", value: "4" }, { action_type: "offsite_conversion.fb_pixel_purchase", value: "3" }, { action_type: "link_click", value: "190" }], action_values: [{ action_type: "omni_purchase", value: "512000" }] },
  { campaign_id: "2385002", campaign_name: "신규 유사 타겟", date_start: d1, date_stop: d1, spend: "8000", impressions: "5000", clicks: "33" }
], paging: { next: "https://graph.facebook.com/v26.0/act_998877/insights?after=abc&access_token=EAAGtoken1234567890" } },
{ data: [{ campaign_id: "2385002", campaign_name: "신규 유사 타겟", date_start: d2, date_stop: d2, spend: "7000", impressions: "4100", inline_link_clicks: "21" }] }];
calls.length = 0;
r = await call("mk/sync", { src: "meta", days: 5 }, S); ok(r.s === 200 && r.j.rows === 3 && r.j.camps === 1, "meta sync " + JSON.stringify(r.j));
ok(calls.length === 2 && calls[0].q.level === "campaign" && calls[0].q.time_increment === "1" && calls[0].path === "/v26.0/act_998877/insights", "meta request + paging");
r = await call("mk/data", null, A);
const m1 = r.j.stats.find(x => x.camp_id === cp2.id && x.date === d1); ok(m1 && m1.cost === 41250 && m1.clk === 190 && m1.conv === 4 && m1.rev === 512000 && m1.src === "meta", "meta: link clicks, one purchase type only (no double count)");
const m2 = r.j.stats.find(x => x.date === d1 && x.cost === 8000); ok(m2 && m2.clk === 33 && m2.conv === 0, "meta: falls back to clicks");
failAll = true; DB.raw.prepare("UPDATE mod_set SET v=json_set(v,'$.synced.meta','2026-01-01T00:00:00.000Z') WHERE mod='mk' AND k='settings'").run();
r = await call("mk/sync", { src: "meta" }, S); ok(r.s === 502 && r.j.error === "conn-denied", "denied upstream reported");
r = await call("mk/data", null, A); ok(r.j.stats.find(x => x.camp_id === cp2.id && x.date === d1).cost === 41250, "failed sync leaves data");
failAll = false;
// 유튜브 · 데이터랩
r = await call("mk/sync", { src: "yt" }, S); ok(r.j.error === "no-key", "yt needs key");
ENV.YT_API_KEY = "yt-key"; r = await call("mk/sync", { src: "yt" }, S); ok(r.j.error === "no-channel", "yt needs channel");
r = await call("mk/chan/save", { name: "유튜브 하루공방", kind: "youtube", cat: "video", handle: "harustudio" }, A); const chY = r.j.chan;
ytItem = { statistics: { subscriberCount: "1520", viewCount: "88000", videoCount: "41" } };
calls.length = 0; r = await call("mk/sync", { src: "yt" }, S); ok(r.s === 200 && r.j.channels[0].subs === 1520 && calls[0].q.forHandle === "@harustudio", "yt first sync");
DB.raw.prepare("UPDATE mod_set SET v=json_set(v,'$.synced.yt','2026-01-01T00:00:00.000Z') WHERE mod='mk' AND k='settings'").run();
ytItem = { statistics: { subscriberCount: "1534", viewCount: "88950", videoCount: "42" } };
r = await call("mk/sync", { src: "yt" }, S);
r = await call("mk/data", null, A); const y = r.j.stats.filter(x => x.chan_id === chY.id);
ok(y.length === 1 && y[0].fol === 1534 && y[0].view === 950 && r.j.chans.find(c => c.id === chY.id).ext.views === 88950, "yt: followers snapshot, views as difference");
r = await call("mk/trend", { groups: [{ name: "파티룸", words: ["파티룸"] }] }, S); ok(r.j.error === "no-key", "trend needs key");
ENV.NAVER_CLIENT_ID = "id"; ENV.NAVER_CLIENT_SECRET = "sec";
r = await call("mk/trend", { groups: [{ name: "파티룸", words: ["파티룸", "홍대 파티룸"] }], months: 12 }, S); ok(r.s === 200 && r.j.unit === "week" && r.j.results[0].data[0].v === 71.23, "trend");
ok(JSON.parse(calls[calls.length - 1].body).keywordGroups[0].keywords.length === 2 && calls[calls.length - 1].h["x-naver-client-id"] === "id", "trend request");
DB.raw.prepare("UPDATE mod_set SET v=json_set(v,'$.trend',40) WHERE mod='mk' AND k='quota'").run();
r = await call("mk/trend", { groups: [{ name: "파티룸", words: ["파티룸"] }] }, S); ok(r.s === 429 && r.j.error === "quota", "trend daily cap per workspace");
r = await call("mk/sync", { src: "yt" }, S); ok(r.s === 429 && r.j.error === "too-soon", "yt sync at most every 30 minutes");

/* ── 백업·복원에서 연결 정보는 빼고 지킴 ── */
r = await call("backup", null, A); const bk = r.j.backup;
ok(r.s === 200 && Array.isArray(bk.mods.mk_camp) && bk.mods.mk_camp.length >= 4 && bk.mods.mk_stat.length > 0 && !JSON.stringify(bk).includes("sealed") && bk.mods.mod_set.some(x => x.mod === "mk" && x.k === "settings"), "backup has marketing tables, no connection secrets");
const nCamp = bk.mods.mk_camp.length, nStat = bk.mods.mk_stat.length;
await call("mk/camp/del", { id: cp1.id }, A);
r = await call("restore", { data: bk }, A); ok(r.s === 200, "restore " + JSON.stringify(r.j).slice(0, 120));
const A2 = r.j.token || A;
r = await call("mk/data", null, A2); ok(r.s === 200 && r.j.camps.length === nCamp && r.j.stats.length === nStat && r.j.conn.naver.on === true && r.j.conn.meta.on === true, "restore brings marketing back and keeps connections");
r = await call("mk/conn/del", { src: "meta" }, A2); ok(r.j.conn.meta.on === false && r.j.conn.naver.on === true, "conn del");
r = await call("mk/conn/test", { src: "meta" }, A2); ok(r.j.error === "no-conn", "no-conn after delete");

/* ── AI 접속 ── */
r = await call("token/create", { name: "클로드", scope: "write", modules: ["marketing"] }, A2); const TK = r.j.token; ok(/^mw_/.test(TK) && r.j.item.modules.includes("marketing"), "ai token with marketing");
r = await call("token/create", { name: "읽기", scope: "read", modules: [] }, A2); const TK0 = r.j.token;
r = await call("ai/marketing", null, TK0); ok(r.s === 403 && r.j.error === "module-off", "token without marketing module");
r = await call("ai/marketing", null, TK);
const sm = r.j; ok(r.s === 200 && sm.mode === "boost" && sm.target.cpa === 18000 && Array.isArray(sm.campaigns) && sm.channels.length >= 5, "ai summary");
const allStats = (await call("mk/data", null, A2)).j.stats, sumCost = allStats.filter(x => x.date >= addDays(today, -29)).reduce((s, x) => s + x.cost, 0);
ok(sm.last30.cost === sumCost && sm.last30.cost > 0, "ai summary cost equals stat rows (" + sm.last30.cost + ")");
{ const g = new Map(); for (const x of allStats.filter(x => x.date >= addDays(today, -29))) { const k = x.chan_id + "|" + x.camp_id, t = g.get(k) || { c: 0, v: 0 }; t.c += x.cost; t.v += x.rev; g.set(k, t); }
  let c = 0, v = 0; for (const t of g.values()) if (t.v > 0) { c += t.c; v += t.v; }
  ok(v > 0 && c < sumCost && sm.last30.roas === Math.round(v / c * 100), "ai summary ROAS counts only campaigns that record revenue (" + sm.last30.roas + "%)"); }
const c1 = sm.campaigns.find(c => c.name === "파티룸 지역 키워드"), c1rows = allStats.filter(x => x.camp_id === c1.id);
ok(c1.last30.clicks === c1rows.reduce((s, x) => s + x.clk, 0) && c1.last30.cpa === Math.round(c1rows.reduce((s, x) => s + x.cost, 0) / c1rows.reduce((s, x) => s + x.conv, 0)) && c1.last30.ctr === Math.round(c1.last30.clicks / c1.last30.impressions * 10000) / 100, "ai summary campaign ratios");
r = await call("ai/propose", { kind: "mk-action", payload: { title: "브랜드 검색 예산 유지, 지역 키워드 입찰 10% 낮추기", detail: "CPC가 2주 전보다 올랐습니다.", campaign: "파티룸 지역", kind: "bid", from: "700원", to: "630원" }, reason: "주간 점검" }, TK);
ok(r.s === 200 && r.j.status === "pending", "propose mk-action");
const pid = r.j.proposal.id;
r = await call("ai/propose", { kind: "mk-action", payload: { detail: "제목 없음" } }, TK); ok(r.s === 400, "propose needs title");
r = await call("ai/propose", { kind: "mk-post", payload: { title: "연말 모임 체크리스트 5가지", body: "1) 인원 …", channel: "인스타 @haru", date: addDays(today, 2), format: "카드뉴스" } }, TK); const pid2 = r.j.proposal.id;
r = await call("proposal/decide", { id: pid, approve: true }, A2); ok(r.s === 200 && r.j.proposal.status === "approved" && r.j.proposal.applied.campaign === "파티룸 지역 키워드", "approve mk-action → campaign found by partial name");
r = await call("proposal/decide", { id: pid2, approve: true }, A2); ok(r.j.proposal.applied.channel === "인스타 @haru", "approve mk-post");
r = await call("mk/data", null, A2);
const aiAct = r.j.acts.find(a => a.by === "ai"); ok(aiAct && aiAct.to_v === "630원" && aiAct.camp_id === c1.id && aiAct.status === "todo", "ai action in queue");
ok(r.j.posts.some(p => p.title === "연말 모임 체크리스트 5가지" && p.status === "draft" && p.chan_id === ch3.id), "ai post draft");
r = await call("ai/marketing", null, TK); ok(r.j.openActions.some(a => a.title.startsWith("브랜드 검색")) && r.j.upcomingContent.some(p => p.title.startsWith("연말 모임")), "summary shows actions and content");
const mcpReq = new Request("https://myworks.ai.kr/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + TK }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "myworks_marketing", arguments: {} } }]) });
const mcpRes = await (await onRequest({ request: mcpReq, env: ENV, next: async () => null })).json();
ok(mcpRes[0].result.tools.some(t => t.name === "myworks_marketing") && JSON.parse(mcpRes[1].result.content[0].text).last30.cost === sm.last30.cost, "mcp tool");

/* ── 끄면 막히고, 데이터는 남음 ── */
r = await call("ws/modules", { modules: ["space"] }, A2); r = await call("mk/data", null, A2); ok(r.s === 403 && r.j.error === "module-off", "off again");
r = await call("ai/propose", { kind: "mk-action", payload: { title: "x" } }, TK); ok(r.j.error === "module-off" || r.s === 403, "propose blocked when off");
r = await call("ws/modules", { modules: ["space", "marketing"] }, A2); r = await call("mk/data", null, A2); ok(r.j.camps.length === nCamp, "data kept after off/on");

globalThis.fetch = realFetch;
ok(maxQ < 50, "max queries per request " + maxQ + " (" + maxQPath + ")");
console.log(`통과 ${pass} · 실패 ${failN} · 요청당 최대 쿼리 ${maxQ} (${maxQPath})`);
process.exit(failN ? 1 : 0);
