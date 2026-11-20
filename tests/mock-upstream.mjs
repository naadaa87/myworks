// 바깥 서비스 흉내 — 브라우저 시험에서 로컬 시험 서버가 씁니다 (MW_MOCK=1 node tests/dev-server.mjs …)
// 솔라피(문자·알림톡) · 팝빌(홈택스 수집) · 브라우저 푸시 서버. 받은 요청은 globalThis.__MOCK 에 모아 둡니다.
import nodeCrypto from "node:crypto";
export const PB_LINK_ID = "MYWORKSTEST", PB_SECRET = Buffer.from("mock-linkhub-secret-key-0123456789").toString("base64");   // 시험 서버에 넣는 팝빌 값
const M = globalThis.__MOCK = { sol: [], push: [], pb: [], balance: 12000, failTo: new Set(), pbJobs: new Map(), pbMembers: new Set(), pbDept: new Set(), pbTokens: 0 };
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const real = globalThis.fetch;
const kd = n => new Date(Date.now() + 9 * 3600e3 + n * 864e5).toISOString().slice(0, 10).replace(/-/g, "");
globalThis.fetch = async (u, init = {}) => {
  const url = new URL(String(u));
  if (/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return real(u, init);
  const body = init.body && typeof init.body === "string" ? (() => { try { return JSON.parse(init.body); } catch (e) { return init.body; } })() : null;
  if (url.hostname === "api.solapi.com") {
    const auth = (init.headers && init.headers.authorization) || "";
    if (!/^HMAC-SHA256 apiKey=NCS[^,]*, date=[^,]+, salt=[^,]{12,}, signature=[0-9a-f]{64}$/.test(auth)) return J({ errorCode: "SignatureDoesNotMatch", errorMessage: "서명이 일치하지 않습니다." }, 403);
    M.sol.push({ method: init.method || "GET", path: url.pathname, body });
    if (url.pathname === "/cash/v1/balance") return J({ balance: M.balance, point: 0 });
    if (url.pathname === "/senderid/v1/numbers/active") return J([{ phoneNumber: "01011112222", handleKey: "SID_1", status: "ACTIVE" }]);
    if (url.pathname === "/kakao/v2/channels") return J({ channelList: [{ channelId: "KA01PF000000000000001", searchId: "@haru", channelName: "하루 디자인" }] });
    if (url.pathname === "/kakao/v2/templates/sendable") return J([{ templateId: "KA01TP000000000000001", name: "견적서 안내", channelId: "KA01PF000000000000001", content: "[#{상호}] #{이름}님, 견적서를 보내드립니다.\n건명: #{제목}", status: "APPROVED", variables: [{ name: "상호" }, { name: "이름" }, { name: "제목" }, { name: "코드" }] }]);
    if (url.pathname === "/messages/v4/send-many/detail") {
      const msgs = body.messages, bad = msgs.filter(x => M.failTo.has(x.to)), good = msgs.filter(x => !M.failTo.has(x.to));
      M.balance -= good.length * 20;
      return J({ groupInfo: { groupId: "G" + M.sol.length, count: { total: msgs.length, registeredSuccess: good.length, registeredFailed: bad.length }, balance: M.balance, point: 0 }, failedMessageList: bad.map(x => ({ to: x.to, statusCode: "1062", statusMessage: "발송 가능한 번호가 아닙니다." })), messageList: good.map((x, i) => ({ messageId: "M" + M.sol.length + "_" + i, to: x.to, statusCode: "2000", statusMessage: "정상 접수" })) });
    }
    return J({ errorCode: "NotFound" }, 404);
  }
  if (/googleapis\.com$|push\.apple\.com$|mozilla\.com$|notify\.windows\.com$/.test(url.hostname)) { M.push.push({ url: String(u), headers: init.headers }); return new Response("", { status: 201 }); }
  if (url.hostname === "auth.linkhub.co.kr") {   // 토큰 — 서명을 직접 다시 계산해 맞을 때만 내줍니다
    const h = init.headers || {}, m = /^LINKHUB (\S+) (\S+)$/.exec(h.Authorization || "");
    const want = nodeCrypto.createHmac("sha256", Buffer.from(PB_SECRET, "base64")).update("POST\n" + nodeCrypto.createHash("sha256").update(init.body).digest("base64") + "\n" + h["x-lh-date"] + "\n" + (h["x-lh-forwarded"] ? h["x-lh-forwarded"] + "\n" : "") + h["x-lh-version"] + "\n" + url.pathname).digest("base64");
    M.pb.push({ path: url.pathname, body });
    if (!m || m[1] !== PB_LINK_ID || m[2] !== want || h["x-lh-version"] !== "2.0" || !/^\/POPBILL(_TEST)?\/Token$/.test(url.pathname)) return J({ code: -99004002, message: "인증 정보가 올바르지 않습니다." }, 401);
    M.pbTokens++;
    return J({ session_token: "tok-" + body.access_id, expiration: new Date(Date.now() + 3600e3).toISOString(), serviceID: url.pathname.split("/")[1], scope: body.scope });
  }
  if (/^popbill(-test)?\.linkhub\.co\.kr$/.test(url.hostname)) {
    const p = url.pathname, q = url.searchParams, method = (init.headers && init.headers["X-HTTP-Method-Override"]) || init.method || "GET", tok = ((init.headers && init.headers.Authorization) || "").replace(/^Bearer tok-/, "");
    M.pb.push({ method, path: p + url.search, body, corp: tok });
    if (p === "/Join" && method === "GET") return J({ code: M.pbMembers.has(q.get("CorpNum")) ? 1 : 0, message: "" });
    if (p === "/Join" && method === "POST") { M.pbMembers.add(body.CorpNum); return J({ code: 1, message: "가입 완료" }); }
    const svc = p.startsWith("/HomeTax/Taxinvoice") ? "ti" : p.startsWith("/HomeTax/Cashbill") ? "cb" : "";
    if (!svc) return J({ code: -99999999, message: "지원하지 않는 요청" }, 400);
    if (!tok) return J({ code: -99004003, message: "인증 정보가 없습니다." }, 401);
    const rest = p.replace(/^\/HomeTax\/(Taxinvoice|Cashbill)/, "");
    if (rest === "/DeptUser" && method === "POST") { if (!body.id || body.pwd === "wrong") return J({ code: -11001010, message: "홈택스 부서사용자 아이디 또는 비밀번호가 올바르지 않습니다." }, 400); M.pbDept.add(tok); return J({ code: 1, message: "등록 완료" }); }
    if (rest === "/DeptUser" && method === "DELETE") { M.pbDept.delete(tok); return J({ code: 1, message: "삭제 완료" }); }
    if (rest === "/DeptUser") return J({ code: M.pbDept.has(tok) ? 1 : 0, message: M.pbDept.has(tok) ? "등록됨" : "미등록" });
    if (rest === "/DeptUser/Check") return M.pbDept.has(tok) ? J({ code: 1, message: "정상" }) : J({ code: -11001011, message: "부서사용자 계정이 등록되지 않았습니다." }, 400);
    if (rest === "/Contract") return J({ referenceID: "1", contractDT: "20261101", useEndDate: "20261231", baseDate: 1, state: 1, closeRequestYN: false, useRestrictYN: false, closeOnExpired: false, unPaidYN: false });
    const mj = /^\/(SELL|BUY)$/.exec(rest);
    if (mj && method === "POST") { if (!M.pbDept.has(tok)) return J({ code: -11001011, message: "부서사용자 계정이 등록되지 않았습니다." }, 400); const id = svc + mj[1] + String(M.pbJobs.size + 1).padStart(12, "0"); M.pbJobs.set(id, { svc, type: mj[1], polls: 0, corp: tok }); return J({ jobID: id }); }
    const ms = /^\/([A-Za-z0-9]+)\/State$/.exec(rest);
    if (ms) { const j = M.pbJobs.get(ms[1]); if (!j) return J({ code: -11000404, message: "작업을 찾을 수 없습니다." }, 400); j.polls++; return J({ jobID: ms[1], jobState: j.polls >= 2 ? 3 : 2, errorCode: j.polls >= 2 ? 1 : 0, errorReason: "", collectCount: 2 }); }
    const ml = /^\/([A-Za-z0-9]+)$/.exec(rest);
    if (ml && M.pbJobs.has(ml[1])) {
      const j = M.pbJobs.get(ml[1]), sell = j.type === "SELL";
      if (j.svc === "ti") return J({ code: 1, message: "확인완료", total: 2, perPage: 1000, pageNum: 1, pageCount: 1, list: [
        { ntsconfirmNum: "2026" + (sell ? "S" : "B") + "0000000000000000001", writeDate: kd(-3), issueDate: kd(-3), sendDate: kd(-2), taxType: "과세", purposeType: "청구", supplyCostTotal: "1000000", taxTotal: "100000", totalAmount: "1100000", remark1: "", invoiceType: sell ? "매출" : "매입", modifyYN: false, itemName: sell ? "브랜드 로고 디자인" : "인쇄물 제작", invoicerCorpNum: sell ? j.corp : "1112233333", invoicerCorpName: sell ? "하루 디자인" : "모두인쇄", invoiceeCorpNum: sell ? "2223344444" : j.corp, invoiceeCorpName: sell ? "모노가구" : "하루 디자인" },
        { ntsconfirmNum: "2026" + (sell ? "S" : "B") + "0000000000000000002", writeDate: kd(-10), issueDate: kd(-10), sendDate: kd(-9), taxType: "면세", purposeType: "영수", supplyCostTotal: "300000", taxTotal: "0", totalAmount: "300000", remark1: "", invoiceType: sell ? "매출" : "매입", modifyYN: false, itemName: sell ? "교육" : "도서", invoicerCorpNum: sell ? j.corp : "3334455555", invoicerCorpName: sell ? "하루 디자인" : "책방", invoiceeCorpNum: sell ? "4445566666" : j.corp, invoiceeCorpName: sell ? "배움터" : "하루 디자인" }] });
      return J({ code: 1, message: "확인완료", total: sell ? 1 : 2, perPage: 1000, pageNum: 1, pageCount: 1, list: sell ? [
        { ntsconfirmNum: "C" + kd(-1) + "S0001", tradeDate: kd(-1), tradeDT: kd(-1) + "101500", tradeType: "승인거래", tradeUsage: "소득공제용", totalAmount: "55000", supplyCost: "50000", tax: "5000", serviceFee: "0", invoiceType: "매출", customerName: "홍길동" }] : [
        { ntsconfirmNum: "C" + kd(-2) + "B0001", tradeDate: kd(-2), tradeDT: kd(-2) + "121000", tradeType: "승인거래", tradeUsage: "지출증빙용", totalAmount: "33000", supplyCost: "30000", tax: "3000", serviceFee: "0", invoiceType: "매입", franchiseCorpNum: "5556677777", franchiseCorpName: "문구나라" },
        { ntsconfirmNum: "C" + kd(-2) + "B0002", tradeDate: kd(-2), tradeDT: kd(-2) + "150000", tradeType: "취소거래", tradeUsage: "지출증빙용", totalAmount: "11000", supplyCost: "10000", tax: "1000", serviceFee: "0", invoiceType: "매입", franchiseCorpNum: "5556677777", franchiseCorpName: "문구나라" }] });
    }
    return J({ code: -99999999, message: "지원하지 않는 요청" }, 400);
  }
  throw new Error("mock-upstream: 막힌 주소 " + url.hostname);
};
export default M;
