// 마이셀러 서버 시험 — 송장 일괄 · 재고 기록 · 반품·교환 · 공급처·발주·확인 링크·입고 · 정산 대사 — node tests/seller.test.mjs
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
const A = (await call("owner-setup", { loginId: "seller1", pw: "pass1234", name: "셀러", workspace: "하루마켓" })).j.token;
await call("ws/modules", { modules: ["commerce"] }, A);
let r = await call("cm/data", null, A); ok(r.s === 200 && r.j.channels.length === 4 && Array.isArray(r.j.suppliers) && Array.isArray(r.j.pos), "data with new arrays");
const ch = r.j.channels[0].id;
r = await call("cm/settings", { set: { seller: "market", ans_tpl: ["안녕하세요", ""], carrier: "CJ대한통운" } }, A); ok(r.j.settings.seller === "market" && r.j.settings.ans_tpl.length === 1, "settings seller");
// 상품 — 옵션 단위
r = await call("cm/product/save", { name: "수제 쿠키", option: "초코", price: 12000, cost: 4000, stock: 50, safety: 10 }, A); const pC = r.j.product; ok(pC.option === "초코", "product option");
r = await call("cm/product/save", { name: "수제 쿠키", option: "버터", price: 12000, cost: 4000, stock: 30, safety: 10 }, A); const pB = r.j.product;
r = await call("cm/product/save", { id: pC.id, stock: 999, name: "수제 쿠키" }, A); ok(r.j.product.stock === 50, "stock not editable via save");
r = await call("cm/stock/log", { id: pC.id }, A); ok(r.j.items.length === 1 && r.j.items[0].reason === "처음 재고" && r.j.items[0].delta === 50, "initial stock log");
// 엑셀 가져오기 — 이름+옵션으로 연결
r = await call("cm/order/import", { mode: "merge", rows: [
  { channel_id: ch, order_no: "N-1001", order_date: today, product_name: "수제 쿠키", option: "초코", qty: 2, amount: 24000, receiver: "김고객", phone: "010-1", address: "서울" },
  { channel_id: ch, order_no: "N-1002", order_date: today, product_name: "수제 쿠키", option: "버터", qty: 1, amount: 12000, receiver: "이고객", phone: "010-2", address: "부산" },
  { channel_id: ch, order_no: "N-1003", order_date: today, product_name: "수제 쿠키", option: "버터", qty: 3, amount: 36000, receiver: "박고객", phone: "010-3", address: "대구" }
] }, A); ok(r.j.added === 3, "import 3");
r = await call("cm/data", null, A);
const o1 = r.j.orders.find(o => o.order_no === "N-1001"), o2 = r.j.orders.find(o => o.order_no === "N-1002"), o3 = r.j.orders.find(o => o.order_no === "N-1003");
ok(o1.product_id === pC.id && o2.product_id === pB.id, "matched by option");
// 송장 일괄
r = await call("cm/ship/bulk", { rows: [{ order_no: "N-1001", tracking: "111" }, { order_no: "N-1002", tracking: "222", carrier: "한진택배" }, { order_no: "N-9999", tracking: "999" }], carrier: "CJ대한통운" }, A);
ok(r.s === 200 && r.j.shipped === 2 && r.j.unmatched.includes("N-9999"), "bulk ship " + JSON.stringify(r.j));
r = await call("cm/data", null, A);
const p1 = r.j.products.find(p => p.id === pC.id), p2 = r.j.products.find(p => p.id === pB.id);
ok(p1.stock === 48 && p2.stock === 29, "stock deducted " + p1.stock + "/" + p2.stock);
const so1 = r.j.orders.find(o => o.order_no === "N-1001"), so2 = r.j.orders.find(o => o.order_no === "N-1002");
ok(so1.status === "shipped" && so1.tracking === "111" && so1.carrier === "CJ대한통운" && so2.carrier === "한진택배", "tracking set");
r = await call("cm/ship/bulk", { rows: [{ order_no: "N-1001", tracking: "111" }] }, A); ok(r.j.shipped === 0, "already shipped not twice");
r = await call("cm/stock/log", { id: pC.id }, A); ok(r.j.items.some(x => x.reason === "발송" && x.delta === -2 && x.ref === "N-1001"), "ship log");
// 단건 발송(기존 경로)도 기록
r = await call("cm/order/save", { id: o3.id, status: "shipped", tracking: "333" }, A); ok(r.j.order.status === "shipped", "single ship");
r = await call("cm/stock/log", { id: pB.id }, A); ok(r.j.items.filter(x => x.reason === "발송").length === 2, "single ship logged");
// 재고 실사
r = await call("cm/stock/adjust", { id: pB.id, stock: 20, reason: "파손 폐기" }, A); ok(r.j.product.stock === 20, "adjust");
r = await call("cm/stock/log", { id: pB.id }, A); ok(r.j.items[0].reason === "파손 폐기" && r.j.items[0].delta === -6, "adjust log " + JSON.stringify(r.j.items[0]));
// 반품 — 재입고
r = await call("cm/order/claim", { id: so1.id, type: "return", reason: "단순 변심", status: "requested", refund: 24000 }, A); ok(r.j.order.claim.status === "requested" && r.j.order.status === "shipped", "return requested");
r = await call("cm/order/claim", { id: so1.id, type: "return", reason: "단순 변심", status: "done", refund: 24000, restock: true }, A);
ok(r.j.order.status === "return" && r.j.order.claim.status === "done", "return done");
r = await call("cm/data", null, A); ok(r.j.products.find(p => p.id === pC.id).stock === 50, "restocked");
r = await call("cm/order/claim", { id: so1.id, type: "return", status: "requested" }, A); ok(r.s === 409, "done claim locked");
// 교환 — 재발송 주문 생성, 회수품 폐기(재입고 안 함)
r = await call("cm/order/claim", { id: so2.id, type: "exchange", reason: "부서짐", status: "done", restock: false }, A);
ok(r.j.created && r.j.created.status === "new" && r.j.created.amount === 0 && r.j.created.source === "exchange" && r.j.order.status === "shipped", "exchange creates reship");
// 공급처·발주
r = await call("cm/supplier/save", { name: "쿠키공방", contact: "최공방", phone: "010-9" }, A); const sup = r.j.supplier; ok(sup.name === "쿠키공방", "supplier");
r = await call("cm/po/save", { supplier_id: sup.id, items: [{ product_id: pC.id, name: "수제 쿠키", option: "초코", qty: 100, cost: 3800 }, { name: "포장 상자", qty: 200, cost: 150 }, { name: "", qty: 1 }], expected: today, memo: "오전 입고 부탁드립니다" }, A);
const po = r.j.po; ok(po.status === "draft" && po.items.length === 2 && po.total === 410000 && /^PO-\d{6}-01$/.test(po.no), "po draft " + po.no);
r = await call("link/create", { kind: "po", target: po.id }, A); const tok = r.j.token; ok(r.s === 200 && tok, "po link");
r = await call("link/get?t=" + tok); ok(r.j.view.kind === "po" && r.j.view.status === "draft" && r.j.view.po.items.length === 2 && r.j.view.client === "쿠키공방", "po view draft");
r = await call("link/act", { t: tok, action: "approve" }); ok(r.s === 409, "draft not confirmable");
r = await call("cm/po/status", { id: po.id, status: "sent" }, A); ok(r.j.po.status === "sent" && r.j.po.ordered_at, "po sent");
r = await call("cm/po/save", { id: po.id, memo: "x" }, A); ok(r.s === 409, "sent po locked");
r = await call("link/act", { t: tok, action: "change", note: "포장 상자는 150개만 가능합니다", by: "최공방" }); ok(r.j.status === "changed", "supplier change");
r = await call("cm/po/save", { id: po.id, items: [{ product_id: pC.id, name: "수제 쿠키", option: "초코", qty: 100, cost: 3800 }, { name: "포장 상자", qty: 150, cost: 150 }] }, A); ok(r.j.po.total === 402500, "edit after change");
await call("cm/po/status", { id: po.id, status: "sent" }, A);
r = await call("link/act", { t: tok, action: "approve", note: "11/20 출고", by: "최공방" }); ok(r.s === 200 && r.j.status === "approved", "supplier confirm");
r = await call("cm/data", null, A); const po2 = r.j.pos.find(x => x.id === po.id); ok(po2.status === "confirmed" && po2.reply_note === "11/20 출고" && po2.replied_by === "최공방", "po status after confirm " + po2.status);
r = await call("cm/po/receive", { id: po.id, qty: [90] }, A); ok(r.j.po.status === "received" && r.j.added === 90, "receive partial qty");
r = await call("cm/data", null, A); ok(r.j.products.find(p => p.id === pC.id).stock === 140, "stock after receive");
r = await call("cm/stock/log", { id: pC.id }, A); ok(r.j.items[0].reason === "입고" && r.j.items[0].ref === po.no, "receive log");
r = await call("cm/po/del", { id: po.id }, A); ok(r.s === 409, "received po not deletable");
r = await call("cm/supplier/del", { id: sup.id }, A); ok(r.s === 200, "supplier del when no open po");
// 정산 대사
r = await call("cm/settle/save", { ym: today.slice(0, 7), channel_id: ch, expected: 60000, received: 58000, memo: "배송비 차감" }, A); ok(r.j.settle.received === 58000 && r.j.settle.received_at, "settle");
r = await call("cm/data", null, A); ok(r.j.settles.length === 1, "settles in data");
// 발송 담당은 새 기능 못 씀
await call("member/create", { loginId: "pack01", pw: "pw123456", name: "포장", role: "worker" }, A);
const W = (await call("login", { loginId: "pack01", pw: "pw123456" })).j.token;
for (const [p, b] of [["cm/ship/bulk", { rows: [{ order_no: "x", tracking: "1" }] }], ["cm/po/save", { items: [{ name: "a", qty: 1 }] }], ["cm/order/claim", { id: o3.id }], ["cm/stock/log", { id: pC.id }], ["cm/settle/save", { ym: today.slice(0, 7), channel_id: ch }]]) { r = await call(p, b, W); ok(r.s === 403, "worker blocked " + p); }
r = await call("cm/data", null, W); ok(!("suppliers" in r.j) && r.j.orders.every(o => !("amount" in o)), "worker data unchanged");
{ const sh = r.j.orders.find(o => o.order_no === "N-1003"), op = r.j.orders.find(o => o.source === undefined && o.status === "new"); ok(sh && sh.receiver === "박**" && !sh.phone && !sh.address, "worker shipped masked " + JSON.stringify(sh)); ok(r.j.orders.some(o => o.status === "new" && o.address), "worker open has address"); }
console.log(`통과 ${pass} · 실패 ${failN}`);
process.exit(failN ? 1 : 0);
