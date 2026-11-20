// 마이크리에이터 서버 시험 — node tests/creator.test.mjs
import fs from "node:fs"; import path from "node:path"; import { pathToFileURL } from "node:url";
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
const addDays = (ds, n) => { const d = new Date(ds + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), ym = today.slice(0, 7), pm = addDays(ym + "-01", -1).slice(0, 7);

const A = (await call("owner-setup", { loginId: "boss01", pw: "pass1234", name: "하루", workspace: "하루의 작업실" })).j.token;
let r = await call("cr/data", null, A); ok(r.s === 403 && r.j.error === "module-off", "creator off by default");
r = await call("ws/modules", { modules: ["creator", "tax"] }, A); ok(r.j.modules.includes("creator"), "module on " + JSON.stringify(r.j.modules));
await call("member/create", { loginId: "staff01", pw: "pw123456", name: "매니저", role: "staff" }, A);
await call("member/create", { loginId: "alba01", pw: "pw123456", name: "알바", role: "worker" }, A);
await call("member/create", { loginId: "part01", pw: "pw123456", name: "편집자", role: "partner" }, A);
const S = (await call("login", { loginId: "staff01", pw: "pw123456" })).j.token, W = (await call("login", { loginId: "alba01", pw: "pw123456" })).j.token, P = (await call("login", { loginId: "part01", pw: "pw123456" })).j.token;

/* ── 처음 상태 · 권한 · 설정 ── */
r = await call("cr/data", null, A);
ok(r.s === 200 && r.j.chans.length === 0 && r.j.deals.length === 0 && r.j.settings.biz.type === "none" && r.j.settings.biz.wht === 3.3 && r.j.settings.kit.on === false && r.j.kitLink === null, "empty data");
r = await call("cr/data", null, W); ok(r.s === 403, "worker cannot read");
r = await call("cr/data", null, P); ok(r.s === 403, "partner cannot read");
r = await call("cr/data", null, S); ok(r.s === 200, "staff reads");
r = await call("cr/settings", { set: { set: true, biz: { type: "taxable", wht: "45", name: "하루의 작업실", person: "김하루", email: "haru@example.com" }, opts: { usage: 999, excl: -5, rush: "x" }, cpv: "25.5", kit: { on: true, name: "하루", tagline: "혼자 사는 집을 고치는 사람", topics: "인테리어, 셀프시공,  ,자취", aud: { f: 140, m: "x", ages: "25–34가 절반" }, picks: ["a", "b"], rates: 1 } } }, A);
let st = r.j.settings;
ok(st.biz.type === "taxable" && st.biz.wht === 30 && st.opts.usage === 300 && st.opts.excl === 0 && st.opts.rush === 30 && st.cpv === 25.5 && st.kit.topics.length === 3 && st.kit.aud.f === 100 && st.kit.aud.m === null && st.kit.rates === true && st.kit.cases === true && st.kit.inquiry === true, "settings normalize " + JSON.stringify(st.opts));
r = await call("cr/settings", { set: { biz: { wht: 3.3 }, kit: { tagline: "집을 고치는 사람" } } }, S); st = r.j.settings;
ok(st.biz.type === "taxable" && st.biz.wht === 3.3 && st.biz.person === "김하루" && st.kit.name === "하루" && st.kit.tagline === "집을 고치는 사람" && st.kit.aud.ages === "25–34가 절반" && st.cpv === 25.5, "settings merge keeps the rest");
r = await call("cr/settings", { set: { biz: { type: "weird" } } }, W); ok(r.s === 403, "worker cannot save settings");

/* ── 채널 · 월별 숫자 ── */
r = await call("cr/chan/save", { name: "하루의 작업실", platform: "youtube", handle: "@haru", url: "javascript:alert(1)", topic: "인테리어" }, A); const ch1 = r.j.chan; ok(ch1 && ch1.platform === "youtube" && ch1.url === "" && ch1.active === 1 && ch1.sort === 1, "chan save + url guard");
r = await call("cr/chan/save", { name: "@haru.home", platform: "instagram", url: "https://instagram.com/haru.home" }, S); const ch2 = r.j.chan; ok(ch2.url.startsWith("https://") && ch2.sort === 2, "staff saves chan");
r = await call("cr/chan/save", { name: "", platform: "x" }, A); ok(r.s === 400, "chan needs name");
r = await call("cr/chan/save", { id: ch2.id, platform: "nope", memo: "릴스 위주" }, A); ok(r.j.chan.platform === "etc" && r.j.chan.name === "@haru.home" && r.j.chan.memo === "릴스 위주", "chan update keeps name");
await call("cr/chan/save", { id: ch2.id, platform: "instagram" }, A);
r = await call("cr/chan/save", { id: "none", name: "x" }, A); ok(r.s === 404, "chan 404");
r = await call("cr/snap/save", { chan_id: ch1.id, ym: pm, subs: "48,200", views: 310000, posts: 6 }, A); const sn1 = r.j.snap; ok(sn1 && sn1.subs === 48200 && sn1.views === 310000, "snap save with commas");
r = await call("cr/snap/save", { chan_id: ch1.id, ym: pm, subs: 48900, views: 325000, posts: 7 }, A); ok(r.j.snap.id === sn1.id && r.j.snap.subs === 48900, "same channel+month updates the same row");
await call("cr/snap/save", { chan_id: ch1.id, ym, subs: 50100, views: 180000, posts: 3 }, A);
await call("cr/snap/save", { chan_id: ch2.id, ym, subs: 12400, views: 90000, posts: 12 }, A);
r = await call("cr/snap/save", { chan_id: "nope", ym, subs: 1 }, A); ok(r.s === 400 && r.j.error === "bad-channel", "snap bad channel");
r = await call("cr/snap/save", { chan_id: ch1.id, ym: "2026-1", subs: 1 }, A); ok(r.s === 400 && r.j.error === "bad-date", "snap bad month");
r = await call("cr/data", null, A); ok(r.j.snaps.length === 3, "three snapshots");

/* ── 협찬 건 ── */
r = await call("cr/deal/save", { title: "브랜드 없음" }, A); ok(r.s === 400, "deal needs brand");
r = await call("cr/deal/save", { brand: "모노가구", chan_id: "nope" }, A); ok(r.s === 400 && r.j.error === "bad-channel", "deal bad channel");
r = await call("cr/deal/save", { brand: "모노가구", agency: "플랜에이", person: "이지수", contact: "jisoo@example.com", title: "원목 선반 리뷰", type: "paid", stage: "nego", chan_id: ch1.id, amount: "1,500,000", tax_mode: "vat", items: "긴 영상 1편 + 쇼츠 1편", draft_due: addDays(today, 5), post_due: addDays(today, 10), pay_due: addDays(today, 40), keep_until: addDays(today, 190), usage: "브랜드 인스타그램 재게시", usage_until: addDays(today, 100), excl: "가구 브랜드", excl_until: addDays(today, 60), revisions: 2, guide: "#모노가구 #원목선반", cond: "촬영용 제품은 반납하지 않습니다.", memo: "작년에도 한 번 했음", disc: { how: "제목에 [광고], 영상 처음과 끝에 유료 광고 포함", ok: ["title", "x".repeat(60)] } }, A);
const d1 = r.j.deal;
ok(d1 && d1.amount === 1500000 && d1.tax_mode === "vat" && d1.stage === "nego" && d1.reply === "" && d1.seen === 1 && d1.d.agency === "플랜에이" && d1.d.items.startsWith("긴 영상") && d1.d.revisions === 2 && d1.d.disc.ok.length === 2 && d1.d.disc.ok[1].length === 30 && d1.d.src === "manual" && d1.d.memo === "작년에도 한 번 했음" && d1.terms === null, "deal save " + JSON.stringify(d1.d).slice(0, 80));
r = await call("cr/deal/save", { id: d1.id, stage: "weird", type: "nope", memo: "메모만 고침" }, S);
ok(r.j.deal.stage === "nego" && r.j.deal.type === "paid" && r.j.deal.d.memo === "메모만 고침" && r.j.deal.d.agency === "플랜에이" && r.j.deal.d.guide === "#모노가구 #원목선반" && r.j.deal.amount === 1500000, "deal update merges d");
r = await call("cr/deal/save", { id: "none", brand: "x" }, A); ok(r.s === 404, "deal 404");
r = await call("cr/deal/save", { brand: "그린티", title: "차 세트 선물", type: "gift", stage: "inquiry", gift_value: 80000, tax_mode: "none" }, A); const d2 = r.j.deal; ok(d2.d.gift_value === 80000 && d2.amount === 0, "gift deal");
r = await call("cr/deal/save", { brand: "툴박스", title: "전동 드릴 PPL", type: "paid", stage: "posted", chan_id: ch1.id, amount: 800000, tax_mode: "wht", pay_due: addDays(today, -3), show_case: true, result: { urls: ["https://youtu.be/abc", "javascript:x", "https://youtu.be/def"], posted_at: addDays(today, -12), view: "52,300", likes: 1800, cmts: 240, note: "댓글에 구매 문의 많음" } }, A);
const d3 = r.j.deal; ok(d3.result.urls.length === 2 && d3.result.view === 52300 && d3.d.show_case === true && d3.stage === "posted", "deal result + url guard");
r = await call("cr/deal/save", { brand: "숨은건", title: "사례로 안 보여 줌", type: "paid", stage: "done", amount: 300000, tax_mode: "none", result: { urls: ["https://example.com/hidden"] } }, A); const d4 = r.j.deal;

/* ── 조건 확인서 링크 ── */
r = await call("link/create", { kind: "cr-deal", target: "nope" }, A); ok(r.s === 404, "deal link 404");
r = await call("link/create", { kind: "cr-deal", target: d1.id, days: 30 }, W); ok(r.s === 403, "worker cannot create link");
r = await call("link/create", { kind: "cr-deal", target: d1.id, days: 30 }, A); const T1 = r.j.token; ok(/^[0-9a-f]{32}$/.test(T1), "deal link");
r = await call("link/get?t=" + T1);
let v = r.j.view;
ok(r.s === 200 && v.kind === "cr-deal" && v.client === "모노가구" && v.company === "플랜에이" && v.status === "pending" && v.deal.amount === 1500000 && v.deal.vat === 150000 && v.deal.total === 1650000 && v.deal.net === 1650000 && v.deal.channel === "하루의 작업실" && v.deal.revisions === 2 && v.deal.excl === "가구 브랜드" && v.deal.disclosure.startsWith("제목에 [광고]") && v.sender.name === "김하루" && v.sender.workspace === "하루의 작업실", "deal sheet " + JSON.stringify(v.deal).slice(0, 80));
ok(!JSON.stringify(r.j).includes("작년에도") && !JSON.stringify(r.j).includes("메모만 고침") && !JSON.stringify(r.j).includes("jisoo@"), "deal sheet has no private memo or contact");
r = await call("link/act", { t: T1, action: "change" }); ok(r.s === 400 && r.j.error === "note-required", "change needs note");
r = await call("link/act", { t: T1, action: "change", note: "게시일을 일주일 늦춰 주세요", by: "이지수" }); ok(r.s === 200 && r.j.status === "changed", "brand asks for change");
r = await call("cr/data", null, A); let x = r.j.deals.find(d => d.id === d1.id);
ok(x.reply === "changed" && x.d.reply_note.startsWith("게시일을") && x.seen === 0 && x.stage === "nego" && x.d.agency === "플랜에이", "change recorded, marked unread");
r = await call("cr/deal/seen", { id: d1.id }, A); r = await call("cr/data", null, A); ok(r.j.deals.find(d => d.id === d1.id).seen === 1, "seen");
r = await call("cr/deal/save", { id: d1.id, memo: "브랜드와 통화함" }, A); ok(r.j.deal.reply === "changed", "memo edit keeps the change request");
r = await call("cr/deal/save", { id: d1.id, post_due: addDays(today, 17) }, A); ok(r.j.deal.reply === "" && r.j.deal.d.reply_note === "", "editing a term clears the change request");
r = await call("link/get?t=" + T1); ok(r.j.view.status === "pending" && r.j.view.deal.post_due === addDays(today, 17), "same link shows the edited terms");
r = await call("link/act", { t: T1, action: "approve", by: "이지수", note: "확인했습니다" }); ok(r.s === 200 && r.j.status === "approved", "brand approves");
r = await call("cr/data", null, A); x = r.j.deals.find(d => d.id === d1.id);
ok(x.reply === "approved" && x.stage === "contract" && x.terms && x.terms.amount === 1500000 && x.terms.total === 1650000 && x.terms.by === "이지수" && x.terms.post_due === addDays(today, 17) && x.seen === 0, "approval moves to contract and keeps a snapshot");
r = await call("link/act", { t: T1, action: "approve" }); ok(r.s === 409, "cannot approve twice");
await call("cr/deal/save", { id: d1.id, amount: 1700000 }, A);
r = await call("link/get?t=" + T1); ok(r.j.view.status === "approved" && r.j.view.deal.amount === 1500000 && r.j.view.agreedBy === "이지수", "after approval the link shows what was agreed");
r = await call("cr/deal/save", { id: d1.id, reply: "" }, A); ok(r.j.deal.reply === "" && r.j.deal.terms && r.j.deal.terms.amount === 1500000, "ask again resets the reply");
r = await call("link/get?t=" + T1); ok(r.j.view.status === "pending" && r.j.view.deal.amount === 1700000 && r.j.view.deal.total === 1870000, "pending again with new amount");
await call("cr/deal/save", { id: d1.id, amount: 1500000 }, A);
r = await call("link/act", { t: T1, action: "approve", by: "이지수" }); ok(r.j.status === "approved", "approve again");
r = await call("activity", null, A);

/* ── 콘텐츠 ── */
r = await call("cr/cont/save", { chan_id: ch1.id }, A); ok(r.s === 400, "content needs title");
r = await call("cr/cont/save", { title: "x", deal_id: "nope" }, A); ok(r.s === 400 && r.j.error === "bad-deal", "content bad deal");
r = await call("cr/cont/save", { title: "원목 선반 달아 보기", chan_id: ch1.id, deal_id: d1.id, format: "long", stage: "shoot", shoot_date: addDays(today, 2), post_date: addDays(today, 17), post_time: "19:30", editor: "편집자 민", cost: "150,000", checks: ["thumb", "title"], memo: "대본 초안" }, A);
const c1 = r.j.cont; ok(c1 && c1.format === "long" && c1.stage === "shoot" && c1.d.cost === 150000 && c1.d.post_time === "19:30" && c1.d.checks.length === 2 && c1.d.editor === "편집자 민", "content save");
r = await call("cr/cont/save", { id: c1.id, stage: "edit", checks: ["thumb", "title", "ad"] }, S); ok(r.j.cont.stage === "edit" && r.j.cont.d.checks.length === 3 && r.j.cont.d.cost === 150000 && r.j.cont.d.memo === "대본 초안", "content update merges d");
r = await call("cr/cont/save", { title: "전동 드릴 고르는 법", chan_id: ch1.id, deal_id: d3.id, format: "long", stage: "posted", post_date: addDays(today, -12), url: "https://youtu.be/abc", view: 52300, likes: 1800, cmts: 240, shares: 90, saves: 300, stat_at: today }, A); const c2 = r.j.cont; ok(c2.view === 52300 && c2.d.saves === 300, "posted content with stats");
r = await call("cr/cont/save", { title: "좁은 현관 정리", chan_id: ch1.id, format: "short", stage: "review" }, A); const c3 = r.j.cont;
r = await call("cr/cont/save", { id: c3.id, stage: "posted", url: "https://youtu.be/s1", view: 21000 }, A); ok(r.j.cont.post_date === today, "moving to posted fills today's date");
r = await call("cr/cont/save", { title: "벽지 셀프 도배", chan_id: ch1.id, format: "long", stage: "posted", post_date: addDays(today, -40), url: "https://youtu.be/old", view: 88000 }, A); const c4 = r.j.cont;
r = await call("cr/cont/bulk", { rows: [{ title: "욕실 실리콘 다시 쏘기", chan_id: ch1.id, format: "short" }, { title: "", chan_id: ch1.id }, { title: "공구 추천 5가지", chan_id: "nope", stage: "posted" }] }, A); ok(r.j.made === 2, "bulk ideas skip empty titles");
r = await call("cr/cont/bulk", { rows: [] }, A); ok(r.s === 400 && r.j.error === "empty", "bulk empty");
r = await call("cr/data", null, A); ok(r.j.conts.length === 6 && r.j.conts.find(c => c.title === "공구 추천 5가지").chan_id === "", "contents listed, unknown channel dropped");

/* ── 입금 확인 · 수익 ── */
r = await call("cr/deal/paid", { id: d2.id, date: today }, A); ok(r.s === 400 && r.j.error === "no-amount", "gift deal has nothing to mark paid");
r = await call("cr/deal/paid", { id: d3.id, date: addDays(today, -1) }, A);
ok(r.s === 200 && r.j.deal.stage === "done" && r.j.deal.paid_at === addDays(today, -1) && r.j.inc.gross === 800000 && r.j.inc.wht === 26400 && r.j.inc.net === 773600 && r.j.inc.src === "sponsor" && r.j.inc.deal_id === d3.id && r.j.deal.d.paid_amount === 773600 && r.j.deal.d.show_case === true, "paid: 3.3% withheld, moved to done");
const i1 = r.j.inc;
r = await call("cr/deal/paid", { id: d3.id, date: today, amount: 900000 }, A); ok(r.j.inc.id === i1.id && r.j.inc.gross === 900000 && r.j.inc.wht === 29700 && r.j.inc.date === today, "paying again fixes the same income row");
r = await call("cr/deal/paid", { id: d1.id, date: today }, A); ok(r.j.deal.stage === "contract" && r.j.inc.vat === 150000 && r.j.inc.net === 1650000 && r.j.inc.chan_id === ch1.id, "advance payment keeps the stage, VAT added");
r = await call("cr/deal/unpaid", { id: d1.id }, A); ok(r.j.deal.paid_at === null && r.j.deal.inc_id === null && r.j.deal.d.paid_amount === 0, "unpaid");
r = await call("cr/inc/save", { date: today, src: "ads", chan_id: ch1.id, title: "애드센스 " + pm, ym: pm, cur: "USD", fx_amount: "412.35", fx_rate: "1,385.5" }, A);
const i2 = r.j.inc; ok(i2 && i2.gross === Math.round(412.35 * 1385.5) && i2.net === i2.gross && i2.ym === pm && i2.cur === "USD" && i2.fx_rate === 1385.5, "foreign income converted (" + (i2 && i2.gross) + ")");
r = await call("cr/inc/save", { date: today, src: "fan", title: "멤버십", gross: 120000 }, S); const i3 = r.j.inc; ok(i3.ym === ym && i3.cur === "KRW" && i3.fx_amount === null, "krw income defaults month");
r = await call("cr/inc/save", { src: "etc", gross: 1000 }, A); ok(r.s === 400 && r.j.error === "bad-date", "income needs date");
r = await call("cr/inc/save", { date: today, src: "etc" }, A); ok(r.s === 400 && r.j.error === "no-amount", "income needs amount");
r = await call("cr/inc/save", { id: i3.id, gross: 150000, wht: 4950, src: "nope" }, A); ok(r.j.inc.net === 145050 && r.j.inc.src === "etc" && r.j.inc.title === "멤버십", "income edit recomputes received amount");
r = await call("cr/inc/save", { id: i1.id, gross: 800000, wht: 26400 }, A); r = await call("cr/data", null, A); x = r.j.deals.find(d => d.id === d3.id);
ok(x.d.paid_amount === 773600 && x.paid_at === today && x.d.show_case === true, "editing a deal's income row keeps the deal in step");
r = await call("cr/inc/del", { id: i1.id }, A); r = await call("cr/data", null, A); x = r.j.deals.find(d => d.id === d3.id);
ok(x.paid_at === null && x.inc_id === null && x.stage === "settle" && x.d.paid_amount === 0 && x.d.show_case === true && !r.j.incs.some(i => i.id === i1.id), "deleting the income row reopens the deal");
await call("cr/deal/paid", { id: d3.id, date: today }, A);

/* ── 단가표 ── */
r = await call("cr/rate/save", { name: "브랜디드 영상 1편", chan_id: ch1.id, format: "long", price: "1,500,000", note: "기획·촬영·편집 포함" }, A); const rt1 = r.j.rate; ok(rt1.price === 1500000 && rt1.active === 1, "rate save");
r = await call("cr/rate/save", { name: "릴스 1편", chan_id: ch2.id, format: "short", price: 400000 }, A); const rt2 = r.j.rate;
r = await call("cr/rate/save", { id: rt2.id, active: false }, A); ok(r.j.rate.active === 0 && r.j.rate.name === "릴스 1편", "rate off");
r = await call("cr/rate/save", { name: "" }, A); ok(r.s === 400, "rate needs name");

/* ── 미디어킷 ── */
r = await call("link/create", { kind: "cr-kit", target: "other", days: 365 }, A); ok(r.s === 404, "kit target must be 'kit'");
r = await call("link/create", { kind: "cr-kit", target: "kit", days: 365 }, A); const TK1 = r.j.token; ok(/^[0-9a-f]{32}$/.test(TK1) && (new Date(r.j.expiresAt) - Date.now()) / 864e5 > 360, "kit link lasts a year");
r = await call("cr/settings", { set: { kit: { picks: [c2.id, c4.id, c1.id, "nope"], email: "haru@example.com", bio: "혼자 사는 집을 직접 고칩니다." } } }, A);
r = await call("link/get?t=" + TK1); v = r.j.view;
ok(r.s === 200 && v.kind === "cr-kit" && v.title === "하루" && v.tagline === "집을 고치는 사람" && v.channels.length === 2 && v.asOf === ym, "kit view");
const kc = v.channels.find(c => c.platform === "youtube");
ok(kc.subs === 50100 && kc.monthViews === Math.round((180000 + 325000) / 2) && kc.avgView === Math.round((52300 + 21000 + 88000) / 3) && kc.avgN === 3, "kit channel numbers come from records (" + kc.monthViews + ", " + kc.avgView + ")");
ok(v.picks.length === 2 && v.picks[0].title === "전동 드릴 고르는 법" && v.picks[0].view === 52300, "picks: only posted contents with a link");
ok(v.cases.length === 1 && v.cases[0].brand === "툴박스" && v.cases[0].url === "https://youtu.be/abc", "cases: only deals marked as showcase");
ok(v.rates.length === 1 && v.rates[0].name === "브랜디드 영상 1편" && v.rates[0].price === 1500000, "rates shown when turned on, inactive hidden");
{ const txt = JSON.stringify(r.j); ok(!txt.includes("숨은건") && !txt.includes("800000") && !txt.includes("모노가구") && !txt.includes("대본 초안") && !txt.includes("플랜에이"), "kit leaks no deal amounts, other brands or memos"); }
await call("cr/settings", { set: { kit: { rates: false, cases: false } } }, A);
r = await call("link/get?t=" + TK1); ok(r.j.view.rates.length === 0 && r.j.view.cases.length === 0, "rates and cases can be hidden");
await call("cr/settings", { set: { kit: { cases: true } } }, A);
r = await call("cr/data", null, A); ok(r.j.kitLink && r.j.kitLink.token === TK1 && r.j.kitLink.views >= 2, "kit link and views in data");

/* ── 협찬 문의 ── */
r = await call("link/inquiry", { t: TK1, name: "박서연", company: "오크랩", message: "신제품 원목 책상 협업을 제안드립니다.\n예산은 협의 가능합니다." }); ok(r.s === 400 && r.j.error === "need-contact", "inquiry needs a contact");
r = await call("link/inquiry", { t: TK1, name: "박서연", company: "오크랩", email: "nope", message: "문의" }); ok(r.s === 400 && r.j.error === "bad-email", "inquiry bad email");
r = await call("link/inquiry", { t: TK1, company: "오크랩", email: "a@b.co" }); ok(r.s === 400, "inquiry needs message");
r = await call("link/inquiry", { t: TK1, name: "봇", email: "bot@x.co", message: "스팸", hp: "filled" }); ok(r.s === 200, "honeypot answers ok");
r = await call("link/inquiry", { t: T1, name: "박서연", email: "a@b.co", message: "문의" }); ok(r.s === 404, "inquiry only on a kit link");
r = await call("link/inquiry", { t: TK1, name: "박서연", company: "오크랩", email: "seoyeon@oaklab.example", phone: "010-1234-5678", budget: "100~200만 원", type: "paid", message: "신제품 원목 책상 협업을 제안드립니다.\n예산은 협의 가능합니다." }); ok(r.s === 200 && r.j.ok, "inquiry accepted");
r = await call("cr/data", null, A); const dq = r.j.deals.find(d => d.d.src === "kit");
ok(r.j.deals.filter(d => d.d.src === "kit").length === 1 && dq.stage === "inquiry" && dq.seen === 0 && dq.brand === "오크랩" && dq.d.person === "박서연" && dq.d.contact.includes("010-1234-5678") && dq.d.inq.budget === "100~200만 원" && dq.title.startsWith("신제품 원목 책상") && dq.d.inq.message.includes("협의 가능"), "inquiry lands as an unread deal (honeypot one dropped)");
await call("cr/settings", { set: { kit: { inquiry: false } } }, A);
r = await call("link/inquiry", { t: TK1, name: "김", email: "a@b.co", message: "문의" }); ok(r.s === 403 && r.j.error === "closed", "inquiry closed when turned off");
r = await call("link/get?t=" + TK1); ok(r.j.view.inquiry === false, "kit says inquiry is off");
await call("cr/settings", { set: { kit: { inquiry: true } } }, A);
for (let i = 0; i < 39; i++) await call("link/inquiry", { t: TK1, name: "문의" + i, email: "q" + i + "@b.co", message: "문의 " + i });
r = await call("link/inquiry", { t: TK1, name: "넘침", email: "over@b.co", message: "문의" }); ok(r.s === 429, "40 inquiries a day at most");
r = await call("cr/data", null, A); ok(r.j.deals.filter(d => d.d.src === "kit").length === 40, "40 inquiry deals");
for (const d of r.j.deals.filter(d => d.d.src === "kit" && d.id !== dq.id)) await call("cr/deal/del", { id: d.id }, A);
await call("cr/settings", { set: { kit: { on: false } } }, A);
r = await call("link/get?t=" + TK1); ok(r.s === 404, "kit hidden when turned off");
await call("cr/settings", { set: { kit: { on: true } } }, A);

/* ── 결과 보고서 ── */
r = await call("link/create", { kind: "cr-report", target: d1.id }, A); ok(r.s === 404, "report only after posting");
r = await call("link/create", { kind: "cr-report", target: d3.id, days: 90 }, A); const T3 = r.j.token;
r = await call("link/get?t=" + T3); v = r.j.view;
ok(v.kind === "cr-report" && v.client === "툴박스" && v.report.view === 52300 && v.report.urls.length === 2 && v.report.contents.length === 1 && v.report.contents[0].saves === 300 && v.report.contents[0].channel === "하루의 작업실" && v.report.note.startsWith("댓글에"), "report view");
ok(!JSON.stringify(r.j).includes("800000") && !JSON.stringify(r.j).includes("773600"), "report has no amounts");
r = await call("link/act", { t: T3, action: "approve" }); ok(r.s === 409, "report is view only");

/* ── 지우기 ── */
r = await call("cr/chan/del", { id: ch1.id }, A); ok(r.s === 409 && r.j.error === "in-use", "channel in use");
r = await call("cr/chan/save", { name: "지울 채널", platform: "tiktok" }, A); const ch9 = r.j.chan; await call("cr/snap/save", { chan_id: ch9.id, ym, subs: 10 }, A);
r = await call("cr/chan/del", { id: ch9.id }, A); ok(r.s === 200, "empty channel deleted");
r = await call("cr/data", null, A); ok(!r.j.chans.some(c => c.id === ch9.id) && !r.j.snaps.some(s => s.chan_id === ch9.id), "its monthly numbers go with it");
r = await call("cr/deal/del", { id: d4.id }, A); ok(r.s === 200, "deal del");
r = await call("cr/cont/del", { id: c3.id }, A); r = await call("cr/rate/del", { id: rt2.id }, A); r = await call("cr/snap/del", { id: sn1.id }, A);
r = await call("cr/data", null, A); ok(r.j.conts.length === 5 && r.j.rates.length === 1 && r.j.snaps.length === 2 && !r.j.deals.some(d => d.id === d4.id), "deletes");
r = await call("link/create", { kind: "cr-deal", target: d2.id }, A); const T2 = r.j.token;
await call("cr/deal/del", { id: d2.id }, A);
r = await call("link/get?t=" + T2); ok(r.s === 410 || r.s === 404, "deleting a deal closes its link (" + r.s + ")");
r = await call("cr/deal/save", { id: dq.id, stage: "lost", lost_reason: "일정이 맞지 않음" }, A); ok(r.j.deal.stage === "lost" && r.j.deal.d.lost_reason === "일정이 맞지 않음" && r.j.deal.d.inq.company === "오크랩", "lost keeps the inquiry");
r = await call("link/create", { kind: "cr-deal", target: dq.id }, A); ok(r.s === 404, "no sheet for a lost deal");

/* ── 백업 · 복원 ── */
r = await call("backup", null, A); const bk = r.j.backup;
ok(r.s === 200 && bk.mods.cr_deal.length === 3 && bk.mods.cr_cont.length === 5 && bk.mods.cr_inc.length === 3 && bk.mods.cr_chan.length === 2 && bk.mods.cr_snap.length === 2 && bk.mods.cr_rate.length === 1 && bk.mods.mod_set.some(x => x.mod === "cr" && x.k === "settings") && !bk.mods.mod_set.some(x => x.k === "quota"), "backup has creator tables " + JSON.stringify(Object.fromEntries(Object.entries(bk.mods).filter(([k]) => k.startsWith("cr_")).map(([k, v]) => [k, v.length]))));
ok(bk.mods.cr_deal.find(d => d.id === d1.id).d.agency === "플랜에이" && bk.mods.cr_deal.find(d => d.id === d1.id).terms.by === "이지수", "backup keeps nested fields");
await call("cr/deal/del", { id: d1.id }, A); await call("cr/cont/del", { id: c1.id }, A);
r = await call("restore", { data: bk }, A); ok(r.s === 200, "restore " + JSON.stringify(r.j).slice(0, 120));
const A2 = r.j.token || A;
r = await call("cr/data", null, A2); x = r.j.deals.find(d => d.id === d1.id);
ok(r.s === 200 && r.j.deals.length === 3 && r.j.conts.length === 5 && r.j.incs.length === 3 && x && x.d.guide === "#모노가구 #원목선반" && x.terms.total === 1650000 && x.reply === "approved" && r.j.conts.find(c => c.id === c1.id).d.checks.length === 3 && r.j.settings.kit.name === "하루", "restore brings creator data back");

/* ── AI 접속 ── */
r = await call("token/create", { name: "클로드", scope: "write", modules: ["creator"] }, A2); const TK = r.j.token; ok(/^mw_/.test(TK) && r.j.item.modules.includes("creator"), "ai token with creator");
r = await call("token/create", { name: "읽기", scope: "read", modules: [] }, A2); const TK0 = r.j.token;
r = await call("ai/creator", null, TK0); ok(r.s === 403 && r.j.error === "module-off", "token without creator module");
r = await call("ai/creator", null, TK); const sm = r.j;
ok(r.s === 200 && sm.business.type === "taxable" && sm.channels.length === 2 && sm.channels[0].subscribers === 50100 && sm.openDeals.some(d => d.brand === "모노가구" && d.stage === "contract" && d.brandReply === "approved" && d.deliverables.startsWith("긴 영상")) && !sm.openDeals.some(d => d.brand === "툴박스"), "ai summary deals");
ok(sm.income.thisMonth.gross === 800000 + 150000 && sm.income.thisMonth.bySource.sponsor === 800000 && sm.income.lastMonth.bySource.ads === i2.gross && sm.exclusivity.some(e => e.brand === "모노가구" && e.scope === "가구 브랜드") && sm.upcomingContent.some(c => c.title === "원목 선반 달아 보기" && c.sponsored) && sm.recentPosts.some(p => p.views === 52300), "ai summary income, exclusivity, content");
r = await call("ai/propose", { kind: "cr-idea", payload: { title: "겨울 결로 막는 법", channel: "하루의 작업실", format: "long", date: addDays(today, 9), memo: "창틀 실리콘 → 단열 뽁뽁이 → 환기" }, reason: "검색량이 오르는 주제" }, TK); ok(r.s === 200 && r.j.status === "pending", "propose cr-idea"); const pid = r.j.proposal.id;
r = await call("ai/propose", { kind: "cr-idea", payload: { memo: "제목 없음" } }, TK); ok(r.s === 400, "cr-idea needs title");
r = await call("ai/propose", { kind: "cr-deal", payload: { brand: "따숨", title: "난방 텐트 리뷰", type: "paid", channel: "하루의", amount: 700000, due: addDays(today, 20), memo: "메일로 들어온 제안" } }, TK); const pid2 = r.j.proposal.id;
r = await call("ai/propose", { kind: "cr-deal", payload: { title: "브랜드 없음" } }, TK); ok(r.s === 400, "cr-deal needs brand");
r = await call("proposal/decide", { id: pid, approve: true }, A2); ok(r.s === 200 && r.j.proposal.status === "approved" && r.j.proposal.applied.channel === "하루의 작업실", "approve cr-idea");
r = await call("proposal/decide", { id: pid2, approve: true }, A2); ok(r.j.proposal.applied.brand === "따숨", "approve cr-deal");
// D1은 LIKE 패턴을 50바이트까지만 받습니다 — 한글로 긴 채널 이름을 보내도 승인이 깨지지 않아야 합니다
r = await call("ai/propose", { kind: "cr-idea", payload: { title: "긴 채널 이름 시험", channel: "하루의 작업실 메인 유튜브 채널 겨울 집 고치기 시리즈", format: "long" } }, TK);
r = await call("proposal/decide", { id: r.j.proposal.id, approve: true }, A2); ok(r.s === 200 && r.j.proposal.status === "approved" && !r.j.proposal.applied.channel, "long Korean channel name: approved, no wrong channel picked");
r = await call("ai/propose", { kind: "cr-idea", payload: { title: "영문 대소문자", channel: "하루의 작업실", format: "short" } }, TK);
r = await call("proposal/decide", { id: r.j.proposal.id, approve: true }, A2); ok(r.j.proposal.applied.channel === "하루의 작업실", "exact channel name still found");
r = await call("cr/data", null, A2);
ok(r.j.conts.some(c => c.title === "겨울 결로 막는 법" && c.stage === "idea" && c.chan_id === ch1.id && c.d.memo.startsWith("창틀")), "ai idea added");
x = r.j.deals.find(d => d.brand === "따숨"); ok(x && x.stage === "nego" && x.amount === 700000 && x.chan_id === ch1.id && x.d.src === "ai" && x.post_due === addDays(today, 20), "ai deal added");
const mcpReq = new Request("https://myworks.ai.kr/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + TK }, body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "myworks_creator", arguments: {} } }]) });
const mcpRes = await (await onRequest({ request: mcpReq, env: ENV, next: async () => null })).json();
ok(mcpRes[0].result.tools.some(t => t.name === "myworks_creator") && JSON.parse(mcpRes[1].result.content[0].text).channels.length === 2, "mcp tool");

/* ── 끄면 막히고, 데이터는 남음 ── */
r = await call("link/create", { kind: "cr-kit", target: "kit", days: 365 }, A2); const TK2 = r.j.token;
r = await call("link/get?t=" + TK1); ok(r.s === 410, "a new kit link closes the old address");
r = await call("ws/modules", { modules: ["tax"] }, A2); r = await call("cr/data", null, A2); ok(r.s === 403 && r.j.error === "module-off", "off again");
r = await call("link/get?t=" + TK2); ok(r.s === 404, "kit closed while the module is off");
r = await call("link/inquiry", { t: TK2, name: "김", email: "a@b.co", message: "문의" }); ok(r.s === 403, "no inquiries while off");
r = await call("ai/propose", { kind: "cr-idea", payload: { title: "x" } }, TK); ok(r.j.error === "module-off" || r.s === 403, "propose blocked when off");
r = await call("ws/modules", { modules: ["tax", "creator"] }, A2); r = await call("cr/data", null, A2); ok(r.j.deals.length === 4 && r.j.kitLink.token === TK2, "data kept after off/on");
r = await call("link/get?t=" + TK2); ok(r.s === 200, "kit back on");

ok(maxQ < 50, "max queries per request " + maxQ + " (" + maxQPath + ")");
console.log(`통과 ${pass} · 실패 ${failN} · 요청당 최대 쿼리 ${maxQ} (${maxQPath})`);
process.exit(failN ? 1 : 0);
