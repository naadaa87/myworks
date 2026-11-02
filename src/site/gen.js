// 마이웍스 공개 홈페이지 생성기 — node gen.js <출력 디렉터리>
// 생성 결과(HTML)는 저장소에 그대로 올라간다. 문구를 고칠 때는 이 파일을 고치고 다시 생성한다.
const fs = require("fs");
const path = require("path");
const OUT = process.argv[2] || path.join(__dirname, "dist");
fs.mkdirSync(path.join(OUT, "site", "img"), { recursive: true });

const SITE = "https://myworkspro.pages.dev";
const DATE = "2026. 11. 2.";

// ---------- 공통 데이터 ----------
const SVC = [
  { id: "store", name: "마이스토어", color: "#1F7A5A", who: "자영업자 · 점주 · 공간 운영자", one: "매장과 공간을 하루 단위로 굴린다",
    line: "지점 · 예약 · 일 마감 · 근무자 · 점검 · 리뷰를 한 흐름으로", status: "part",
    now: "공간 대관(예약 → 청소 배정·확인 → 시설 → 손익)은 지금 쓸 수 있습니다.", next: "일 마감 · 근무자 체크리스트 · 점검 · 리뷰는 2026년 12월 추가 예정입니다.",
    cases: ["파티룸·스터디룸처럼 예약으로 돌아가는 공간을 두세 곳 운영한다", "직원 없이 혼자 매장을 보며 저녁에 그날 매출을 정리한다", "청소·개점·마감을 근무자에게 맡기되 고객 정보는 보여 주고 싶지 않다"],
    features: [["지점", "매장·공간 단위 운영. 영업시간, 규칙, 담당, 채널"], ["예약·대관", "달력에서 바로 등록. 채널별 수수료가 자동 계산된다(네이버·스페이스클라우드·직접 등)"], ["일 마감", "카드·현금·배달·예약 매출과 시재를 적으면 돈 메뉴와 세금 준비로 흘러간다"], ["근무자", "교대·체크리스트·시재 인계. 근무자 화면에는 예약자 이름·연락처·금액이 보이지 않는다"], ["점검", "청소·안전·위생 체크리스트, 소모품 발주 알림, 시설 고장 신고와 처리"], ["리뷰·문의", "플랫폼 리뷰·문의를 모아 두고, 답글 초안은 AI가 쓰고 사람이 확정한다"]],
    img: { src: "space-pnl.jpg", alt: "마이스토어 공간 대관 손익 화면 — 지점별 매출, 채널 수수료, 영업이익" },
    with: ["tax", "seller"], price: "월 19,000원 · 지점 3개 포함 · 추가 지점 1개당 5,000원" },
  { id: "building", name: "마이빌딩", color: "#2B4FD6", who: "소규모 건물주 · 임대인 · 상가 운영자", one: "임대차와 건물 관리를 혼자서 챙긴다",
    line: "호실 · 계약 · 수납 · 공실 · 시설 점검 · 정산을 달력과 알림으로", status: "soon",
    now: "", next: "2027년 1분기 출시 예정입니다. 비공개 베타에 먼저 초대합니다.",
    cases: ["2~3층짜리 건물에 상가와 사무실 호실 몇 개를 직접 관리한다", "월세 입금은 통장을 보고 확인하고, 계약 만기는 수첩에 적어 둔다", "소방 점검 보고를 한 번 놓쳐 과태료를 낸 적이 있다"],
    features: [["건물·호실", "건물마다 호실·면적·용도·임차인. 공실은 한눈에"], ["임대차계약", "기간·보증금·월세·관리비·인상 조건. 만기 90/60/30일 전 알림, 갱신요구권 안내"], ["수납", "월세·관리비 고지서 발행, 입금 확인, 미납 알림. 임차인은 확인 링크로 고지서와 영수증을 본다"], ["공실", "공실 → 광고 → 문의 → 계약까지 단계 관리. 중개사 공유 링크"], ["시설·점검", "소방·승강기·전기 등 법정 점검 주기를 달력에 올리고, 수리는 업체에 견적 요청"], ["정산·세금", "공과금 배분, 세금계산서 발행 체크, 임대소득 자료를 마이택스로"]],
    img: null, with: ["tax"], price: "월 19,000원 · 건물 3개·호실 30개 포함 · 추가 호실 10개당 5,000원" },
  { id: "tax", name: "마이택스", color: "#6B4ED6", who: "1인 사업자 · 프리랜서 · 소상공인", one: "세금 낼 준비를 평소에 끝내 둔다",
    line: "증빙함 · 세금 달력 · 예상 세금 · 절세 체크 · 세무사 공유", status: "soon",
    now: "", next: "2027년 1분기 출시 예정입니다. 비공개 베타에 먼저 초대합니다.",
    cases: ["부가세 신고 때마다 영수증을 찾느라 이틀을 쓴다", "세무사에게 자료를 카톡으로 보내는데 빠진 것이 늘 있다", "매장 매출과 온라인 판매 매출을 따로 집계하고 있다"],
    features: [["증빙함", "세금계산서·현금영수증·카드 매입을 한곳에. 사진을 올리면 항목을 추천한다"], ["세금 달력", "부가세·종합소득세·원천세·4대보험 일정을 내 사업자 유형에 맞게 알린다"], ["예상 세금", "이번 분기 낼 돈을 대략 보여 주고, 미리 떼어 둘 금액을 제안한다(안내용 추정치)"], ["절세 체크", "노란우산·연금계좌·사업용 카드 등록·적격증빙 같은 기본 점검표"], ["세무사 공유", "내 세무사를 읽기 전용으로 초대하고, 기간별 자료를 묶어 보낸다"], ["하지 않는 것", "신고·대리·세무 상담은 하지 않는다. 자료 정리와 일정, 준비 상태까지가 마이택스의 일이다"]],
    img: null, with: ["store", "building", "seller"], price: "월 9,900원 · 세무사 초대 무료 · 증빙 보관 5GB" },
  { id: "seller", name: "마이셀러", color: "#0E8A8A", who: "1인 온라인 판매자 · 부업 셀러", one: "주문·재고·발송·정산을 하루 한 번에 끝낸다",
    line: "채널 · 상품 · 주문 · 재고 · 수발주 · 발송 · 문의 · 손익", status: "part",
    now: "주문 엑셀 업로드, 상품·재고, 발송 작업자 화면, 문의, 채널별 손익은 지금 쓸 수 있습니다.", next: "송장 일괄 처리 · 수발주 · 정산 대사는 2026년 12월 추가 예정입니다.",
    cases: ["스마트스토어와 쿠팡 주문을 엑셀로 내려받아 합치고 송장을 다시 올린다", "한쪽에서 품절된 상품이 다른 쪽에서 팔려 취소가 난다", "정산이 맞는지 확인할 시간이 없다"],
    features: [["주문 모으기", "채널별 주문 엑셀을 올리면 열을 자동으로 맞춘다. 채널마다 한 번 맞추면 기억한다"], ["상품·재고", "옵션 단위 재고, 입고·출고·조정 기록, 안전재고 알림"], ["수발주", "공급처 발주서 → 입고 확인 → 재고 반영. 발주서는 확인 링크로 보낸다"], ["발송", "작업자 화면에서 포장·송장·발송 처리. 금액·매입가·정산 정보는 작업자 기기로 가지 않는다"], ["문의·CS", "채널별 문의를 모으고 답변 템플릿으로 빠르게"], ["정산·손익", "채널 수수료·광고비·택배비를 반영한 상품별·채널별 손익, 정산 대사"]],
    img: { src: "commerce.jpg", alt: "마이셀러 현황 화면 — 발송할 주문, 답할 문의, 재고 부족 상품, 이달 매출" },
    with: ["tax"], price: "월 19,000원 · 월 주문 1,000건 포함 · 추가 1,000건당 5,000원" },
];
const byId = Object.fromEntries(SVC.map((s) => [s.id, s]));

const PRICING = {
  basic: { name: "베이직", price: 0, note: "기본 기능 전부. 브랜드 2개, 유료 좌석 2명, 무료 게스트 5명, 확인 링크 월 30건, AI 읽기 토큰 1개" },
  pro: { name: "프로", price: 12000, year: 9900, note: "브랜드 제한 없음, 유료 좌석 5명 포함, 무료 게스트 20명, 확인 링크 무제한, AI 읽기·쓰기 토큰, 알림톡 월 100건 포함" },
  svc: { store: 19000, building: 19000, tax: 9900, seller: 19000 },
  seat: 4900, bundleDiscount: 0.1, all: 49000, allYear: 39900,
};

// ---------- 공통 조각 ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const won = (n) => n.toLocaleString("ko-KR") + "원";

function head(title, desc, extra = "") {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:image" content="${SITE}/site/img/og.png">
<meta name="theme-color" content="#FF4712">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='4' y='9' width='24' height='5' fill='%23FF4712'/%3E%3Crect x='4' y='18' width='16' height='5' fill='%23FF4712'/%3E%3C/svg%3E">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<link rel="stylesheet" href="/site/site.css">
${extra}
</head>
<body>`;
}

function header(active = "") {
  const a = (k) => (active === k ? ' class="on"' : "");
  return `
<header class="top">
  <div class="wrap">
    <a class="logo" href="/" aria-label="마이웍스 홈"><span class="mark"></span>마이웍스</a>
    <button type="button" class="nav-btn" aria-label="메뉴 열기" aria-expanded="false" aria-controls="site-nav"><span></span><span></span><span></span></button>
    <nav class="nav" id="site-nav">
      <div class="nav-group"><button type="button" class="nav-label" aria-expanded="false" aria-haspopup="true">서비스 <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button>
        <div class="menu">
          <a href="/store"${a("store")}><i class="dot" style="background:#1F7A5A"></i>마이스토어</a>
          <a href="/building"${a("building")}><i class="dot" style="background:#2B4FD6"></i>마이빌딩</a>
          <a href="/tax"${a("tax")}><i class="dot" style="background:#6B4ED6"></i>마이택스</a>
          <a href="/seller"${a("seller")}><i class="dot" style="background:#0E8A8A"></i>마이셀러</a>
        </div>
      </div>
      <a href="/pricing"${a("pricing")}>가격</a>
      <a href="/guide"${a("guide")}>가이드</a>
      <a href="/notice"${a("notice")}>공지</a>
      <a href="/app/" class="login">로그인</a>
      <a href="/start" class="btn primary small">시작하기</a>
    </nav>
  </div>
</header>`;
}

function footer() {
  return `
<footer class="foot">
  <div class="wrap">
    <div class="foot-grid">
      <div>
        <div class="logo small"><span class="mark"></span>마이웍스</div>
        <p class="muted">혼자 하는 일을 끝까지 처리하는 일터.<br>㈜블랭크가 만들고 직접 씁니다.</p>
      </div>
      <div>
        <b>서비스</b>
        <a href="/store">마이스토어</a><a href="/building">마이빌딩</a><a href="/tax">마이택스</a><a href="/seller">마이셀러</a>
      </div>
      <div>
        <b>안내</b>
        <a href="/pricing">가격</a><a href="/guide">가이드</a><a href="/notice">공지</a><a href="/start">시작하기</a>
      </div>
      <div>
        <b>회사</b>
        <span>㈜블랭크 · 대표 최시준</span>
        <a href="mailto:spaceblank0100@gmail.com">spaceblank0100@gmail.com</a>
        <a href="/terms">이용약관</a><a href="/privacy">개인정보처리방침</a>
      </div>
    </div>
    <div class="foot-bottom muted">
      <span>© ${new Date().getFullYear()} ㈜블랭크. 마이웍스는 Cloudflare 위에서 동작합니다.</span>
      <span>최근 갱신 ${DATE}</span>
    </div>
  </div>
</footer>
<script src="/site/site.js" defer></script>
</body>
</html>`;
}

function page({ file, title, desc, active, body, extra = "" }) {
  const html = head(title, desc, extra) + header(active) + `\n<main>${body}\n</main>` + footer();
  fs.writeFileSync(path.join(OUT, file), html);
  console.log("written", file, html.length);
}

const svcCard = (s, full = false) => `
<a class="svc-card" href="/${s.id}">
  <div class="svc-head"><i class="dot" style="background:${s.color}"></i><b>${s.name}</b>${statusChip(s)}</div>
  <p class="svc-one">${esc(s.one)}</p>
  <p class="muted small">${esc(s.who)}</p>
  ${full ? `<p class="svc-line">${esc(s.line)}</p>` : ""}
  <span class="more">자세히 →</span>
</a>`;
const statusChip = (s) => s.status === "now" ? '<span class="chip ok">사용 가능</span>' : s.status === "part" ? '<span class="chip ok">일부 사용 가능</span>' : '<span class="chip soon">2027년 1분기</span>';

// ---------- 홈 ----------
const redirectScript = `<script>
(function(){try{
  var h=location.hash||"";
  if(/^#(\\/link\\/|join=|\\/)/.test(h)){location.replace("/app/"+h);return;}
  if(!/[?&]site=1/.test(location.search)&&(localStorage.getItem("mw_token_v1")||localStorage.getItem("mw_session_v1"))){location.replace("/app/");}
}catch(e){}})();
</script>`;

page({
  file: "index.html", active: "home",
  title: "마이웍스 — 혼자 하는 일을 끝까지 처리하는 일터",
  desc: "1인 사업자·프리랜서·소규모 팀을 위한 업무 플랫폼. 오늘 결정할 것, 일, 거래, 돈, 사람을 한곳에 두고 매장·건물·세금·판매는 필요한 것만 켭니다.",
  extra: redirectScript,
  body: `
<section class="hero">
  <div class="wrap hero-grid">
    <div class="hero-text">
      <p class="kicker">1인 사업자 · 프리랜서 · 소규모 팀을 위한</p>
      <h1>혼자 하는 일을<br>끝까지 처리하는 일터.</h1>
      <p class="lead">오늘 결정할 것, 일, 거래, 돈, 사람을 한곳에 둡니다. 매장·건물·세금·판매는 필요한 것만 켭니다. 함께 일할 사람은 역할에 맞게 부르고, 고객은 계정 없이 링크 하나로 승인합니다.</p>
      <div class="cta">
        <a class="btn primary" href="/start">무료로 시작하기</a>
        <a class="btn" href="/guide">어떻게 쓰는지 보기</a>
      </div>
      <p class="muted small">카드 등록 없이 시작합니다. 기본 기능은 계속 무료이고, 분야 서비스는 14일 체험 뒤 월 이용료를 받습니다.</p>
    </div>
    <div class="hero-shots">
      <img class="shot desk" src="/site/img/home-desktop.jpg" alt="마이웍스 오늘 화면 — 오늘 결정할 것 다섯 건이 카드로 모여 있고 승인·열기 버튼이 붙어 있다" width="1280" height="790" loading="eager">
      <img class="shot phone" src="/site/img/home-mobile.jpg" alt="같은 화면을 폰으로 본 모습" width="513" height="760" loading="eager">
    </div>
  </div>
</section>

<section class="sec">
  <div class="wrap">
    <p class="kicker">기본 서비스</p>
    <h2>매일 여는 다섯 메뉴</h2>
    <p class="lead">마이웍스를 열면 이 다섯 가지가 있습니다. 어떤 일을 하든 같습니다.</p>
    <div class="five">
      <div><b>오늘</b><p>승인·확인이 필요한 일이 맨 위에 모입니다. 처리하면 사라집니다.</p></div>
      <div><b>일</b><p>프로젝트와 업무, 주간 플랜. 맡기고, 검수 요청을 받고, 승인으로 끝냅니다.</p></div>
      <div><b>거래</b><p>고객 → 견적 → 납품 → 청구·입금. 상대방은 링크에서 승인합니다.</p></div>
      <div><b>돈</b><p>수입·지출과 월별 손익. 각 서비스의 매출·비용이 여기로 모입니다.</p></div>
      <div><b>사람</b><p>직원·근무자·파트너·전문가는 구성원으로, 고객·거래처는 연락처로.</p></div>
    </div>
  </div>
</section>

<section class="sec alt">
  <div class="wrap">
    <p class="kicker">분야 서비스</p>
    <h2>필요한 것만 켭니다</h2>
    <p class="lead">매장을 보면서 건물도 관리하고, 온라인으로도 파는 사람이 많습니다. 그래서 분야는 앱이 아니라 스위치입니다. 켜면 메뉴에 나타나고, 끄면 메뉴만 사라지고 데이터는 남습니다.</p>
    <div class="svc-grid">${SVC.map((s) => svcCard(s)).join("")}</div>
  </div>
</section>

<section class="sec">
  <div class="wrap two">
    <div>
      <p class="kicker">함께 일하기</p>
      <h2>‘나’를 중심으로 사람을 부릅니다</h2>
      <p>직원과 관리자는 좌석을 쓰고, 현장 근무자·파트너·세무사 같은 전문가는 무료로 초대합니다. 초대하기 전에 그 사람이 보게 될 화면을 미리 봅니다.</p>
      <p>보이는 범위는 화면에서 숨기는 것이 아니라 서버가 애초에 보내지 않는 방식으로 지킵니다. 근무자 기기에는 예약자 이름·연락처·금액이 가지 않습니다.</p>
      <p>고객·임차인·공급처에게는 가입을 요구하지 않습니다. 견적서, 납품물, 청구서, 고지서는 확인 링크 하나로 보내고, 상대가 누른 결과는 내 ‘오늘 결정할 것’에 올라옵니다.</p>
      <a class="text-link" href="/guide#확인-링크--계정-없는-상대에게-보내기">확인 링크가 어떻게 동작하는지 →</a>
    </div>
    <figure class="shot-frame">
      <img class="shot" src="/site/img/link-quote.jpg" alt="고객이 받는 견적 확인 링크 페이지 — 견적 항목과 합계, 승인 버튼 하나" width="1100" height="1013" loading="lazy">
      <figcaption class="muted small">고객이 받는 확인 링크. 로그인 없이 한 페이지, 버튼 하나.</figcaption>
    </figure>
  </div>
</section>

<section class="sec alt">
  <div class="wrap two rev">
    <figure class="shot-frame">
      <img class="shot" src="/site/img/people.jpg" alt="사람 메뉴 — 구성원과 연락처 탭, 고객·거래처·외주 구분" width="1280" height="790" loading="lazy">
      <figcaption class="muted small">사람 메뉴. 구성원은 역할별로, 바깥 사람은 연락처로.</figcaption>
    </figure>
    <div>
      <p class="kicker">AI</p>
      <h2>클로드를 연결하면 내 데이터로 답합니다</h2>
      <p>개인 토큰으로 클로드를 커넥터(MCP)로 연결하면 “오늘 뭐 해야 해?”, “외주 미수금 얼마야?”에 내 워크스페이스 데이터로 답합니다.</p>
      <p>변경은 제안으로만 올라옵니다. 업무 추가, 상태 변경, 연락처 추가 같은 제안은 ‘오늘 결정할 것’에서 승인해야 반영됩니다. AI가 만든 것에는 AI 표시가 붙습니다.</p>
      <a class="text-link" href="/guide#ai-접속--클로드를-마이웍스에-연결하기">AI 접속 설정 방법 →</a>
    </div>
  </div>
</section>

<section class="sec">
  <div class="wrap">
    <p class="kicker">가격</p>
    <h2>기본은 무료, 분야 서비스는 골라서</h2>
    <div class="price-row">
      <div class="price-cell"><b>베이직</b><div class="p">0원</div><p class="muted small">기본 기능 전부. 브랜드 2개, 좌석 2명</p></div>
      <div class="price-cell"><b>프로</b><div class="p">월 12,000원</div><p class="muted small">좌석 5명, 브랜드 무제한, AI 쓰기, 알림</p></div>
      <div class="price-cell"><b>분야 서비스</b><div class="p">월 9,900~19,000원</div><p class="muted small">서비스마다. 2개 이상이면 10% 할인</p></div>
      <div class="price-cell"><b>올인원</b><div class="p">월 49,000원</div><p class="muted small">프로 + 서비스 4개 전부</p></div>
    </div>
    <p class="muted small">예정 요금입니다. 정식 요금은 공개 베타 때 확정하고, 베타 참여자는 1년간 이 가격으로 고정합니다. 근무자·파트너·전문가 초대와 확인 링크 상대방은 요금이 없습니다.</p>
    <a class="text-link" href="/pricing">전체 가격표와 계산기 →</a>
  </div>
</section>

<section class="sec cta-sec">
  <div class="wrap center">
    <h2>지금 시작하면 오늘 화면부터 나옵니다</h2>
    <p class="lead">가입 뒤 5분 안에 첫 데이터가 보이도록 만들었습니다. 쓰다가 서비스를 꺼도 데이터는 남습니다.</p>
    <div class="cta center"><a class="btn primary" href="/start">무료로 시작하기</a><a class="btn" href="/app/">이미 계정이 있어요</a></div>
  </div>
</section>`,
});

// ---------- 서비스 4장 ----------
SVC.forEach((s) => {
  const withList = s.with.map((id) => `<a class="pill" href="/${id}"><i class="dot" style="background:${byId[id].color}"></i>${byId[id].name}</a>`).join("");
  const shot = s.img ? `<figure class="shot-frame"><img class="shot" src="/site/img/${s.img.src}" alt="${esc(s.img.alt)}" loading="lazy"><figcaption class="muted small">${esc(s.img.alt)}</figcaption></figure>`
    : `<div class="wire"><b>화면 구성(예정)</b><ul>${s.features.map((f) => `<li>${esc(f[0])}</li>`).join("")}</ul><p class="muted small">출시 전 비공개 베타에서 실제 화면을 먼저 보여 드립니다.</p></div>`;
  const statusBox = s.status === "soon"
    ? `<div class="status soon"><b>준비 중</b><p>${esc(s.next)}</p><a class="btn small" href="mailto:spaceblank0100@gmail.com?subject=${encodeURIComponent(`[마이웍스] ${s.name} 베타 참여 신청`)}">베타 참여 신청(메일)</a></div>`
    : `<div class="status ok"><b>지금 쓸 수 있는 것</b><p>${esc(s.now)}</p><p class="muted">${esc(s.next)}</p></div>`;
  page({
    file: `${s.id}.html`, active: s.id,
    title: `${s.name} — ${s.one} | 마이웍스`,
    desc: `${s.who}를 위한 마이웍스의 분야 서비스. ${s.line}.`,
    body: `
<section class="hero sub" style="--svc:${s.color}">
  <div class="wrap">
    <p class="kicker"><i class="dot" style="background:${s.color}"></i>마이웍스의 분야 서비스 ${statusChip(s)}</p>
    <h1>${s.name}<span class="h-sub">${esc(s.one)}</span></h1>
    <p class="lead">${esc(s.who)}를 위한 서비스입니다. ${esc(s.line)}.</p>
    ${statusBox}
  </div>
</section>
<section class="sec">
  <div class="wrap">
    <h2>이런 분을 위해</h2>
    <ol class="cases">${s.cases.map((c) => `<li>${esc(c)}</li>`).join("")}</ol>
  </div>
</section>
<section class="sec alt">
  <div class="wrap">
    <h2>하는 일</h2>
    <div class="feat-grid">${s.features.map((f) => `<div class="feat"><b>${esc(f[0])}</b><p>${esc(f[1])}</p></div>`).join("")}</div>
  </div>
</section>
<section class="sec">
  <div class="wrap">
    <h2>화면</h2>
    ${shot}
  </div>
</section>
<section class="sec alt">
  <div class="wrap two">
    <div>
      <h2>함께 켜면 좋은 서비스</h2>
      <p>${s.id === "tax" ? "마이택스는 다른 서비스의 매출·비용을 자동으로 받아 집계합니다. 어느 서비스를 켜든 세금 준비는 같이 끝납니다." : "서비스끼리는 데이터를 주고받습니다. 이 서비스의 매출과 비용은 돈 메뉴와 마이택스로 자동으로 흘러갑니다."}</p>
      <div class="pills">${withList}</div>
    </div>
    <div>
      <h2>가격</h2>
      <p class="price-line">${esc(s.price)}</p>
      <p class="muted small">예정 요금입니다. 2개 이상 켜면 각 10% 할인, 프로와 서비스 4개를 전부 켜면 월 49,000원입니다. 14일 체험 뒤 결제가 시작되고, 끄면 데이터는 남습니다.</p>
      <a class="text-link" href="/pricing">전체 가격표 →</a>
    </div>
  </div>
</section>
<section class="sec cta-sec">
  <div class="wrap center">
    <h2>${s.status === "soon" ? "출시 전에 먼저 써 보고 싶다면" : "오늘부터 쓸 수 있습니다"}</h2>
    <div class="cta center">${s.status === "soon"
      ? `<a class="btn primary" href="mailto:spaceblank0100@gmail.com?subject=${encodeURIComponent(`[마이웍스] ${s.name} 베타 참여 신청`)}">베타 참여 신청</a><a class="btn" href="/start">마이웍스 먼저 시작하기</a>`
      : `<a class="btn primary" href="/start">무료로 시작하기</a><a class="btn" href="/guide">가이드 보기</a>`}</div>
  </div>
</section>`,
  });
});

// ---------- 가격 ----------
page({
  file: "pricing.html", active: "pricing",
  title: "가격 — 마이웍스", desc: "마이웍스 베이직은 무료, 프로는 월 12,000원. 마이스토어·마이빌딩·마이택스·마이셀러는 골라서 켭니다. 계산기로 월 금액을 바로 확인하세요.",
  body: `
<section class="hero sub">
  <div class="wrap">
    <p class="kicker">가격</p>
    <h1>기본은 무료, 분야 서비스는 골라서</h1>
    <p class="lead">아래는 예정 요금입니다. 정식 요금은 2027년 공개 베타 때 확정하며, 비공개 베타 참여자는 1년간 이 가격으로 고정합니다. 지금은 베이직으로 시작하고, 프로와 서비스는 운영자가 켜 드립니다.</p>
  </div>
</section>
<section class="sec">
  <div class="wrap">
    <div class="table-wrap stack-wrap">
      <table class="price-table">
        <thead><tr><th>구분</th><th>월 요금</th><th>포함</th></tr></thead>
        <tbody>
          <tr><td><b>마이웍스 베이직</b></td><td class="num">0원</td><td data-label="포함">${esc(PRICING.basic.note)}</td></tr>
          <tr><td><b>마이웍스 프로</b></td><td class="num">${won(PRICING.pro.price)}<span class="sub">연 결제 시 ${won(PRICING.pro.year)}/월</span></td><td data-label="포함">${esc(PRICING.pro.note)}</td></tr>
          ${SVC.map((s) => `<tr><td><i class="dot" style="background:${s.color}"></i><b>${s.name}</b></td><td class="num">${won(PRICING.svc[s.id])}</td><td data-label="포함">${esc(s.price.replace(/^월 [\d,]+원 · /, ""))}</td></tr>`).join("")}
          <tr><td><b>서비스 2개 이상</b></td><td class="num">각 10% 할인</td><td data-label="예">예: 마이스토어 + 마이택스 = 26,010원/월</td></tr>
          <tr><td><b>마이웍스 올인원</b></td><td class="num">${won(PRICING.all)}<span class="sub">연 결제 시 ${won(PRICING.allYear)}/월</span></td><td data-label="포함">프로 + 서비스 4개 전부. 개별 합산(78,900원) 대비 약 38% 할인</td></tr>
          <tr><td><b>추가 좌석</b></td><td class="num">1명당 ${won(PRICING.seat)}</td><td data-label="비고">관리자·직원 좌석. 현장 근무자·파트너·전문가·확인 링크 상대방은 무료</td></tr>
        </tbody>
      </table>
    </div>
    <h3>실비 항목</h3>
    <div class="table-wrap stack-wrap">
      <table class="stack">
        <thead><tr><th>항목</th><th>요금</th><th>비고</th></tr></thead>
        <tbody>
          <tr><td>알림톡·문자 발송</td><td data-label="요금">건당 실비 + 10원</td><td data-label="비고">프로에 월 100건 포함</td></tr>
          <tr><td>AI 사용량</td><td data-label="요금">프로에 월 기본량 포함</td><td data-label="비고">초과분은 사용량 단위로 안내 뒤 과금</td></tr>
          <tr><td>파일 저장</td><td data-label="요금">베이직 1GB · 프로 10GB</td><td data-label="비고">추가 10GB당 2,000원/월</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</section>
<section class="sec alt">
  <div class="wrap calc">
    <h2>월 금액 계산기</h2>
    <p class="lead">쓸 서비스와 좌석 수를 고르면 월 금액이 바로 보입니다.</p>
    <div class="calc-grid">
      <div class="calc-form">
        <label class="row"><input type="checkbox" id="c-pro" checked> <b>마이웍스 프로</b> <span class="muted">${won(PRICING.pro.price)}</span></label>
        ${SVC.map((s) => `<label class="row"><input type="checkbox" class="c-svc" data-id="${s.id}" data-price="${PRICING.svc[s.id]}"> <i class="dot" style="background:${s.color}"></i><b>${s.name}</b> <span class="muted">${won(PRICING.svc[s.id])}</span></label>`).join("")}
        <label class="row"><span>추가 좌석(관리자·직원)</span><input type="number" inputmode="numeric" id="c-seats" min="0" max="50" value="0" class="inline"> <span class="muted">1명당 ${won(PRICING.seat)}</span></label>
        <label class="row"><input type="checkbox" id="c-year"> 연 결제로 계산</label>
      </div>
      <div class="calc-out">
        <div class="calc-total"><span class="muted">월 합계</span><div class="p" id="c-total">0원</div></div>
        <ul id="c-lines" class="calc-lines"></ul>
        <p class="muted small" id="c-note"></p>
      </div>
    </div>
  </div>
</section>
<section class="sec">
  <div class="wrap">
    <h2>자주 묻는 것</h2>
    <div class="faq">
      <details><summary>지금 돈을 내야 하나요?</summary><p>아닙니다. 지금은 베이직 무료로 시작합니다. 프로와 분야 서비스는 운영자가 켜 드리고, 결제는 2027년 공개 베타 뒤에 시작합니다.</p></details>
      <details><summary>체험이 끝나면 어떻게 되나요?</summary><p>베이직 규칙으로 돌아갑니다. 데이터는 그대로 남고 메뉴만 사라집니다. 다시 켜면 그대로 보입니다.</p></details>
      <details><summary>서비스를 끄면 데이터는요?</summary><p>남습니다. 백업에도 포함되고, 언제든 엑셀·JSON으로 전부 내려받을 수 있습니다.</p></details>
      <details><summary>근무자나 세무사도 요금을 내나요?</summary><p>아닙니다. 현장 근무자·파트너·전문가(세무사·관리업체·중개사)는 무료 게스트입니다. 돈을 받는 좌석은 관리자·직원뿐입니다.</p></details>
      <details><summary>고객이 확인 링크를 열 때 비용이 드나요?</summary><p>아닙니다. 상대방은 계정도, 요금도 없습니다.</p></details>
      <details><summary>거래 수수료가 있나요?</summary><p>없습니다. 월 이용료만 받습니다. 플랫폼 수수료 위에 또 하나의 %를 더하지 않습니다.</p></details>
      <details><summary>세금계산서를 받을 수 있나요?</summary><p>결제가 시작되면 월 단위로 발행합니다. 사업자 정보는 설정에서 등록합니다.</p></details>
      <details><summary>해지는 어떻게 하나요?</summary><p>설정에서 바로 할 수 있습니다. 다음 결제일까지 쓰고, 그 뒤 베이직으로 돌아갑니다.</p></details>
    </div>
  </div>
</section>`,
});

// ---------- 가이드 (README → HTML) ----------
const readmePath = process.argv[3];
if (readmePath && fs.existsSync(readmePath)) {
  const { execSync } = require("child_process");
  let html = execSync(`pandoc "${readmePath}" -f gfm -t html --wrap=none`, { encoding: "utf8" });
  // 첫 h1(제목)과 그 아래 소개 블록은 사이트가 대신하므로, 첫 "---" 이후부터 쓴다
  const cut = html.indexOf("<hr />");
  if (cut > 0) html = html.slice(cut + 6);
  // 운영자용 배포 절차(이번 버전 올리는 방법)는 README에만 둔다
  html = html.split(/(?=<h2 id=)/).filter((sec) => !/^<h2 id="[^"]*올리는-방법/.test(sec)).join("");
  // h2 id → 한글 앵커 유지(pandoc이 만든 id 사용)
  const toc = [];
  html = html.replace(/<h2 id="([^"]+)">([^<]+)<\/h2>/g, (m, id, t) => { toc.push([id, t]); return `<h2 id="${id}">${t}</h2>`; });
  html = html.replace(/사이트주소\/#\/link\//g, "사이트주소/app/#/link/");
  // 표: 모바일에서 행마다 카드로 쌓을 수 있게 머리글을 data-label로 붙인다
  html = html.replace(/<table>([\s\S]*?)<\/table>/g, (m, inner) => {
    const heads = [...inner.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => x[1].replace(/<[^>]+>/g, "").trim());
    const body = inner.replace(/<tr([^>]*)>([\s\S]*?)<\/tr>/g, (tm, ta, cells) => {
      let i = 0;
      return `<tr${ta}>` + cells.replace(/<td([^>]*)>/g, (cm, ca) => { const h = heads[i++] || ""; return h ? `<td${ca} data-label="${h.replace(/"/g, "&quot;")}">` : `<td${ca}>`; }) + "</tr>";
    });
    return `<div class="table-wrap stack-wrap"><table class="stack${heads.length <= 2 ? " two-col" : ""}">${body}</table></div>`;
  });
  page({
    file: "guide.html", active: "guide",
    title: "가이드 — 마이웍스", desc: "마이웍스 사용 안내. 이용 흐름, 등급, 오늘 결정할 것, 사람, 스페이스, 아웃소싱, 커머스, 확인 링크, AI 접속, 데이터 백업.",
    body: `
<section class="hero sub">
  <div class="wrap">
    <p class="kicker">가이드</p>
    <h1>마이웍스 사용 안내</h1>
    <p class="lead">지금 운영 중인 버전(v4) 기준입니다. 메뉴 이름이 바뀌는 재편(마이스토어·마이셀러로의 통합)은 반영될 때마다 공지와 함께 이 페이지를 갱신합니다.</p>
    <div class="guide-quick">
      <a class="pill" href="#이용-흐름">처음 시작</a><a class="pill" href="#등급--베이직과-프로">등급</a><a class="pill" href="#홈--오늘-결정할-것">오늘 결정할 것</a><a class="pill" href="#사람--구성원과-연락처">사람·초대</a><a class="pill" href="#확인-링크--계정-없는-상대에게-보내기">확인 링크</a><a class="pill" href="#ai-접속--클로드를-마이웍스에-연결하기">AI 접속</a>
    </div>
  </div>
</section>
<section class="sec guide">
  <div class="wrap guide-grid">
    <details class="guide-toc" open><summary><span>목차 <span class="muted">${toc.length}개</span></span></summary><nav>${toc.map(([id, t]) => `<a href="#${id}">${esc(t)}</a>`).join("")}</nav></details>
    <article class="doc">${html}</article>
  </div>
</section>`,
  });
}

// ---------- 공지 ----------
page({
  file: "notice.html", active: "notice",
  title: "공지 — 마이웍스", desc: "마이웍스 배포 소식과 바뀐 점.",
  body: `
<section class="hero sub"><div class="wrap"><p class="kicker">공지</p><h1>바뀐 점</h1><p class="lead">배포할 때마다 한 줄씩 남깁니다. 장애가 있으면 맨 위에 적습니다.</p></div></section>
<section class="sec"><div class="wrap doc">
  <div class="notice"><time>2026. 11. 2.</time><h3>운영자용 ‘총괄관리’와 앱 안 문의·공지를 추가했습니다</h3>
    <p>운영자 계정의 ‘운영’ 메뉴를 ‘총괄관리’로 바꾸고 현황, 워크스페이스, 가입·베타, 결제·매출, 문의, 공지, 기록, 오픈 준비 화면을 붙였습니다. 운영자는 <code>/admin</code> 주소로 바로 들어갈 수 있습니다. 운영자에게도 각 워크스페이스의 업무 내용은 보이지 않고, 계정 목록과 기록 개수만 보입니다.</p>
    <p>가입 화면에 ‘베타 코드’ 칸이 생겼습니다. 초대받은 코드를 넣으면 승인을 기다리지 않고 바로 시작합니다. 앱의 ‘문의’ 버튼으로 운영자에게 오류나 의견을 보낼 수 있고, 답변은 같은 창과 홈 화면에서 확인합니다. 점검이나 바뀐 점은 앱 화면 위 공지로 알려 드립니다.</p></div>
  <div class="notice"><time>2026. 11. 2.</time><h3>화면 폭에 따라 깨지던 곳을 고쳤습니다</h3>
    <p>‘시작하기’ 페이지의 단계 설명이 좁은 칸에 눌려 보이던 문제를 고쳤습니다. 폰에서는 가격표와 가이드의 표가 옆으로 잘리지 않고 한 줄씩 쌓여 보이고, 태블릿에서는 서비스·가격 카드가 두 줄로 정리됩니다. 한글이 단어 중간에서 끊기지 않게 줄바꿈 규칙을 바꾸고, 폰·태블릿에서 누르기 쉽도록 링크와 버튼 크기를 키웠습니다.</p>
    <p>‘회원가입 하러 가기’를 누르면 앱의 가입 화면이 바로 열립니다(<code>/app/#signup</code>).</p>
    <p>앱에서도 폰과 태블릿(가로 1024px)에서 홈·외주·판매 화면의 카드가 화면 밖으로 밀려 옆으로 흔들리던 문제를 고쳤습니다. 고객에게 보내는 확인 링크의 금액이 폰에서 두 줄로 끊기지 않게 했고, 한글이 단어 중간에서 끊기지 않게 했습니다. 데이터와 서버에는 바뀐 것이 없습니다.</p></div>
  <div class="notice"><time>2026. 10. 31.</time><h3>공개 홈페이지를 열고 주소 체계를 바꿨습니다</h3>
    <p>첫 화면(<code>/</code>)은 이제 소개 페이지입니다. 앱은 <code>/app/</code>으로 옮겼고, 로그인된 기기에서 첫 화면을 열면 자동으로 앱이 열립니다. 예전에 보낸 확인 링크(<code>/#/link/…</code>)와 초대 링크(<code>/#join=…</code>)는 그대로 동작합니다. 홈 화면에 추가해 둔 바로가기도 그대로 쓸 수 있습니다.</p>
    <p>마이웍스를 대표 서비스로 두고 마이스토어·마이빌딩·마이택스·마이셀러 네 분야 서비스로 넓히는 계획을 소개 페이지와 가격 페이지에 적었습니다. 지금 운영 중인 스페이스·아웃소싱·커머스 모듈은 그대로 쓸 수 있고, 다음 배포부터 새 이름과 자리로 차례로 옮깁니다.</p></div>
  <div class="notice"><time>2026. 10. 21.</time><h3>v4 반영 확인</h3><p>저장소의 파일이 10월 10일 최종본과 같은지 확인했습니다. 운영 데이터에는 변화가 없습니다.</p></div>
  <div class="notice"><time>2026. 10. 10.</time><h3>v4 — 등급, 오늘 결정할 것, 검수, 사람, 확인 링크, AI 접속, 아웃소싱·커머스</h3>
    <p>베이직·프로 등급과 모듈 스위치, 홈의 ‘오늘 결정할 것’, 검수 요청·승인 흐름, 구성원과 연락처, 계정 없는 상대에게 보내는 확인 링크(견적 승인·납품 확인·청구서), 클로드를 연결하는 AI 접속(개인 토큰·MCP, 제안 → 승인), 아웃소싱·커머스 모듈, 스페이스의 채널별 수수료율, 운영 콘솔의 등급 설정을 더했습니다. 서버 테스트 418건, 화면 테스트 282건을 통과했습니다.</p></div>
</div></section>`,
});

// ---------- 시작하기 ----------
page({
  file: "start.html", active: "start",
  title: "시작하기 — 마이웍스", desc: "마이웍스 가입 안내. 회원가입 뒤 운영자 승인을 거쳐 베이직으로 시작합니다.",
  body: `
<section class="hero sub"><div class="wrap"><p class="kicker">시작하기</p><h1>세 단계면 됩니다</h1><p class="lead">카드 등록 없이 시작합니다. 지금은 비공개 운영 기간이라 가입 뒤 운영자 승인이 한 번 있습니다. 보통 하루 안에 처리됩니다.</p></div></section>
<section class="sec"><div class="wrap">
  <ol class="steps">
    <li><div><b>회원가입</b><p>아래 ‘회원가입 하러 가기’를 누르면 가입 화면이 바로 열립니다. 워크스페이스 이름, 이름, 아이디, 비밀번호, 연락처를 적습니다. 사업자 정보는 묻지 않습니다.</p></div></li>
    <li><div><b>승인</b><p>운영자가 신청 내용을 보고 승인합니다. 승인되면 어느 기기에서든 같은 아이디로 로그인할 수 있습니다. 새 워크스페이스는 베이직으로 시작합니다.</p></div></li>
    <li><div><b>첫 데이터</b><p>프로젝트 하나, 매장 하나, 또는 거래처 하나만 넣어 보세요. ‘오늘’ 화면이 채워지기 시작합니다. 프로나 분야 서비스가 필요하면 설정에서 요청하거나 메일로 알려 주세요.</p></div></li>
  </ol>
  <div class="cta"><a class="btn primary" href="/app/#signup">회원가입 하러 가기</a><a class="btn" href="/app/">이미 계정이 있어요</a></div>
  <p class="muted small"><a class="text-link" href="/guide#이용-흐름">이용 흐름 자세히 →</a></p>
  <p class="muted small">팀원으로 합류하려면 관리자가 보낸 초대 링크를 여세요. 초대 링크 없이 가입하면 새 워크스페이스가 만들어집니다.</p>
</div></section>`,
});

// ---------- 약관 · 개인정보 ----------
page({
  file: "terms.html", active: "",
  title: "이용약관 — 마이웍스", desc: "마이웍스 이용약관(초안).",
  body: `
<section class="hero sub"><div class="wrap"><p class="kicker">이용약관</p><h1>마이웍스 이용약관</h1><p class="lead">초안입니다. 공개 베타 전에 전문가 검토를 거쳐 확정하며, 바뀌면 공지와 함께 시행일을 적습니다.</p></div></section>
<section class="sec"><div class="wrap doc legal">
<h2>제1조 (목적)</h2><p>이 약관은 ㈜블랭크(이하 “회사”)가 제공하는 마이웍스 및 분야 서비스(이하 “서비스”)의 이용 조건과 절차, 회사와 이용자의 권리·의무를 정합니다.</p>
<h2>제2조 (정의)</h2><ul><li>“워크스페이스”는 이용자가 개설해 데이터를 보관하고 구성원을 초대하는 단위입니다.</li><li>“소유자”는 워크스페이스를 개설한 이용자, “구성원”은 소유자가 초대해 함께 쓰는 사람입니다.</li><li>“상대방”은 계정 없이 확인 링크로 참여하는 고객·임차인·공급처 등입니다.</li></ul>
<h2>제3조 (계정과 승인)</h2><ul><li>가입 신청 뒤 회사의 승인으로 계정이 활성화됩니다. 회사는 비공개 운영 기간 동안 승인 여부와 시기를 정할 수 있습니다.</li><li>이용자는 아이디·비밀번호를 스스로 관리하며, 제3자에게 넘기지 않습니다.</li></ul>
<h2>제4조 (서비스의 제공과 변경)</h2><ul><li>회사는 서비스를 웹으로 제공하며, 기능·메뉴·이름을 바꿀 수 있습니다. 중요한 변경은 공지합니다.</li><li>분야 서비스는 이용자가 켜고 끕니다. 끄더라도 데이터는 남으며, 다시 켜면 그대로 보입니다.</li><li>회사는 점검·장애·법령상 이유로 서비스를 일시 중단할 수 있으며, 가능한 한 미리 알립니다.</li></ul>
<h2>제5조 (요금)</h2><ul><li>기본 기능은 무료입니다. 프로와 분야 서비스의 요금은 가격 페이지에 게시하며, 정식 요금은 공개 베타 시점에 확정합니다.</li><li>요금 변경은 시행 60일 전에 공지합니다. 베타 참여자에게 약속한 가격 고정 기간은 지킵니다.</li><li>해지는 언제든 할 수 있고, 결제한 기간이 끝나면 베이직으로 돌아갑니다.</li></ul>
<h2>제6조 (데이터의 소유와 이용)</h2><ul><li>워크스페이스에 입력된 데이터는 소유자의 것입니다. 회사는 서비스 제공·장애 대응·통계 목적의 집계 외에 이를 열람하거나 이용하지 않습니다.</li><li>이용자는 언제든 데이터를 내려받을 수 있습니다. 해지 뒤 30일이 지나면 데이터를 삭제합니다.</li><li>이용자가 입력한 고객·임차인 정보는 이용자가 개인정보처리자이며, 회사는 이를 수탁 처리합니다.</li></ul>
<h2>제7조 (금지 행위)</h2><ul><li>타인의 계정 이용, 서비스의 역설계·무단 수집, 법령에 어긋나는 데이터의 입력, 상대방에게 동의 없는 광고성 메시지 발송.</li></ul>
<h2>제8조 (책임의 범위)</h2><ul><li>마이택스가 보여 주는 예상 금액과 일정은 안내용 추정치이며, 세무 신고·대리·상담이 아닙니다. 세무 판단은 이용자와 이용자가 지정한 세무사가 합니다.</li><li>마이빌딩의 법령 안내는 참고 자료이며 법률 자문이 아닙니다.</li><li>회사는 고의·중과실이 없는 한 무료 서비스의 장애로 생긴 손해에 책임지지 않으며, 유료 서비스는 결제한 요금 범위 안에서 책임집니다.</li></ul>
<h2>제9조 (분쟁)</h2><p>이 약관은 대한민국 법을 따르며, 분쟁은 회사 소재지 관할 법원에서 다룹니다.</p>
<p class="muted small">시행일: 확정 시 공지합니다. 문의: spaceblank0100@gmail.com</p>
</div></section>`,
});

page({
  file: "privacy.html", active: "",
  title: "개인정보처리방침 — 마이웍스", desc: "마이웍스 개인정보처리방침(초안).",
  body: `
<section class="hero sub"><div class="wrap"><p class="kicker">개인정보처리방침</p><h1>마이웍스 개인정보처리방침</h1><p class="lead">초안입니다. 공개 베타 전에 전문가 검토를 거쳐 확정합니다.</p></div></section>
<section class="sec"><div class="wrap doc legal">
<h2>1. 수집하는 항목</h2><ul><li>계정: 이름, 아이디, 비밀번호(해시로만 저장), 연락처, 이메일(선택), 가입 목적.</li><li>사업자 정보(마이택스 이용 시): 사업자 유형·등록번호.</li><li>이용 기록: 접속 일시, 기기 정보, 활동 기록(누가 언제 무엇을 바꿨는지).</li><li>이용자가 입력하는 업무 데이터: 프로젝트·업무·거래·재무·연락처·예약·주문 등. 이 안의 고객·임차인·공급처 정보는 이용자가 개인정보처리자이며 회사는 수탁 처리합니다.</li></ul>
<h2>2. 이용 목적</h2><ul><li>서비스 제공과 계정 관리, 구성원 초대·권한 관리, 확인 링크 발송, 알림 발송, 결제(시작 시), 장애 대응, 통계(집계값만).</li></ul>
<h2>3. 보관 기간</h2><ul><li>계정과 업무 데이터: 해지 또는 워크스페이스 삭제 뒤 30일까지 보관 후 삭제. 법령상 보관 의무가 있는 거래 기록은 그 기간 동안 보관.</li><li>백업: 일 단위 백업은 30일간 보관.</li></ul>
<h2>4. 처리 위탁과 국외 이전</h2><ul><li>Cloudflare, Inc. — 서버·데이터베이스·파일 저장(미국 등 해외 데이터센터).</li><li>Anthropic — AI 기능(이용자가 요청한 범위의 데이터를 처리, 서버 호출 시). 이용자가 직접 연결한 AI 커넥터는 이용자의 계약에 따릅니다.</li><li>결제 대행사, 알림톡·이메일 발송 대행사 — 해당 기능을 켠 경우.</li></ul>
<h2>5. 이용자의 권리</h2><ul><li>열람·정정·삭제·처리정지 요청은 앱 안 설정 또는 아래 연락처로 할 수 있습니다. 데이터 전체 내려받기는 언제든 가능합니다.</li></ul>
<h2>6. 안전성 확보</h2><ul><li>비밀번호와 AI 토큰은 해시로만 저장합니다. 역할별로 서버가 전송 범위를 제한해 근무자·파트너 기기로는 고객 연락처·금액이 가지 않습니다. 접속은 HTTPS로만 합니다.</li></ul>
<h2>7. 책임자</h2><p>㈜블랭크 개인정보 보호책임자 최시준 · spaceblank0100@gmail.com</p>
<p class="muted small">시행일: 확정 시 공지합니다.</p>
</div></section>`,
});

// ---------- 확인 링크 안내 페이지 (/link/<토큰> → 앱으로) ----------
fs.mkdirSync(path.join(OUT, "link"), { recursive: true });
fs.writeFileSync(path.join(OUT, "link", "index.html"), `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>마이웍스 확인 링크</title>
<script>(function(){var m=location.pathname.match(/\\/link\\/([0-9a-f]{32})/);if(m){location.replace("/app/#/link/"+m[1]);}})();</script>
<style>body{font-family:Pretendard,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:#F8F7F4;color:#1C1B19;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}div{text-align:center;padding:24px}a{color:#FF4712}</style></head>
<body><div><p>확인 링크를 여는 중입니다.</p><p style="color:#6B6861;font-size:14px">자동으로 열리지 않으면 보낸 분에게 링크를 다시 요청하세요. <a href="/">마이웍스 소개</a></p></div></body></html>`);

// ---------- 총괄관리 바로가기 (/admin → 앱의 총괄관리) ----------
fs.writeFileSync(path.join(OUT, "admin.html"), `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>마이웍스 총괄관리</title>
<script>location.replace("/app/#/admin"+(location.hash&&/^#[a-z]+$/.test(location.hash)?"/"+location.hash.slice(1):""));</script>
<style>body{font-family:Pretendard,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:#F8F7F4;color:#1C1B19;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}div{text-align:center;padding:24px}a{color:#FF4712}</style></head>
<body><div><p>총괄관리로 이동하는 중입니다.</p><p style="color:#6B6861;font-size:14px">운영자 계정으로 로그인해야 열립니다. <a href="/app/#/admin">직접 열기</a></p></div></body></html>`);

// _redirects
fs.writeFileSync(path.join(OUT, "_redirects"), `/link/*  /link/index.html  200\n`);

// ---------- CSS ----------
// 폭 기준: 폰 ≤600 · 태블릿 601~1100 (≤900은 햄버거 메뉴) · PC ≥1101
fs.writeFileSync(path.join(OUT, "site", "site.css"), `
:root{--bg:#FFFFFF;--paper:#F8F7F4;--surface:#FFFFFF;--surface-2:#F3F1EC;--line:#E6E3DC;--ink:#1C1B19;--ink-2:#3A3835;--muted:#6B6861;--point:#FF4712;--point-soft:#FFF1EC;--ok:#1E8E5A;--ok-soft:#E6F4EC;--radius:12px;--max:1120px;--gutter:20px;--head:64px}
*,*::before,*::after{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:calc(var(--head) + 12px);-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Pretendard Variable",Pretendard,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",system-ui,sans-serif;font-size:16px;line-height:1.65;-webkit-font-smoothing:antialiased;font-feature-settings:"tnum";word-break:keep-all;overflow-wrap:break-word;line-break:strict}
a{color:inherit;text-decoration:none}img{max-width:100%;height:auto;display:block}
button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
:focus-visible{outline:2px solid var(--point);outline-offset:2px;border-radius:6px}
.wrap{max-width:var(--max);margin:0 auto;padding:0 var(--gutter)}
h1,h2,h3{letter-spacing:-.015em;line-height:1.3;margin:0 0 14px}
h1{font-size:44px;font-weight:700}h2{font-size:28px;font-weight:700}h3{font-size:19px;font-weight:600;margin-top:28px}
p{margin:0 0 12px}.muted{color:var(--muted)}.small{font-size:13.5px}.center{text-align:center}
.kicker{color:var(--point);font-weight:700;font-size:14px;letter-spacing:.02em;margin-bottom:10px;display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px}
.lead{font-size:18px;color:var(--ink-2);max-width:62ch}.center .lead{margin-left:auto;margin-right:auto}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle;flex:none}
.chip{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:600;vertical-align:middle;white-space:nowrap}
.chip.ok{background:var(--ok-soft);color:var(--ok)}.chip.soon{background:var(--surface-2);color:var(--muted)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:9px;padding:11px 20px;font-weight:600;font-size:15px;line-height:1.25;cursor:pointer;transition:background .15s;text-align:center}
.btn:hover{background:var(--surface-2)}.btn.primary{background:var(--point);border-color:var(--point);color:#fff}.btn.primary:hover{filter:brightness(1.05);background:var(--point)}
.btn.small{min-height:40px;padding:8px 14px;font-size:14px}
.text-link{display:inline-block;padding:6px 0;color:var(--point);font-weight:600}.text-link:hover{text-decoration:underline}
.cta{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0 12px}.cta.center{justify-content:center}

/* 머리글 */
.top{position:sticky;top:0;z-index:30;background:rgba(255,255,255,.94);-webkit-backdrop-filter:saturate(1.2) blur(8px);backdrop-filter:saturate(1.2) blur(8px);border-bottom:1px solid var(--line)}
.top .wrap{display:flex;align-items:center;justify-content:space-between;height:var(--head);gap:16px}
.logo{display:inline-flex;align-items:center;gap:9px;min-height:44px;font-weight:800;font-size:19px;letter-spacing:-.01em;white-space:nowrap}
.logo .mark{width:18px;height:14px;flex:none;background:linear-gradient(var(--point),var(--point)) top left/18px 5px no-repeat,linear-gradient(var(--point),var(--point)) bottom left/12px 5px no-repeat}
.logo.small{font-size:17px;min-height:0;margin-bottom:10px}
.nav{display:flex;align-items:center;gap:4px}
.nav a,.nav .nav-label{display:inline-flex;align-items:center;gap:6px;min-height:40px;padding:8px 12px;border-radius:8px;font-weight:500;font-size:15px;color:var(--ink-2);white-space:nowrap}
.nav a:hover,.nav .nav-label:hover{background:var(--surface-2)}.nav a.on{color:var(--point);background:var(--point-soft);font-weight:600}
.nav .login{margin-left:8px}.nav .btn{margin-left:4px;color:#fff;min-height:40px}.nav .btn:hover{background:var(--point)}
.nav-group{position:relative}
.nav-group .nav-label svg{transition:transform .15s}
.nav-group.open .nav-label svg{transform:rotate(180deg)}
.nav-group .menu{display:none}
.nav-btn{display:none}
@media (min-width:901px){
  .nav-group .menu{position:absolute;left:0;top:100%;padding-top:8px;min-width:200px}
  .nav-group .menu::before{content:"";position:absolute;inset:0 0 auto 0;height:8px}
  .nav-group .menu a{display:flex;width:100%;border-radius:0;background:var(--surface);border:1px solid var(--line);border-top:0;padding:11px 14px;min-height:44px}
  .nav-group .menu a:first-child{border-top:1px solid var(--line);border-radius:10px 10px 0 0}
  .nav-group .menu a:last-child{border-radius:0 0 10px 10px;box-shadow:0 14px 30px rgba(28,27,25,.10)}
  .nav-group .menu a:hover{background:var(--paper)}
  .nav-group.open .menu{display:block}
}
@media (min-width:901px) and (hover:hover){.nav-group:hover .menu{display:block}}

/* 첫 화면 */
.hero{padding:64px 0 48px;background:var(--bg)}
.hero-grid{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:48px;align-items:center}
.hero h1{font-size:46px;margin-bottom:18px}
.hero-shots{position:relative;padding:0 0 28px}
.shot{border:1px solid var(--line);border-radius:12px;box-shadow:0 20px 50px rgba(28,27,25,.10);background:#fff}
.hero-shots .desk{width:100%;position:relative;z-index:1}
.hero-shots .phone{position:absolute;right:0;bottom:0;width:30%;z-index:2;border-radius:16px;box-shadow:0 24px 50px rgba(28,27,25,.18)}
.hero.sub{padding:56px 0 40px;border-bottom:1px solid var(--line)}
.hero.sub h1{font-size:40px}.h-sub{display:block;font-size:22px;font-weight:500;color:var(--muted);margin-top:8px;letter-spacing:0}
.status{margin-top:22px;border-radius:var(--radius);padding:16px 18px;max-width:720px;border:1px solid var(--line);background:var(--paper)}
.status b{display:block;margin-bottom:4px}.status p{margin:0 0 6px}.status.ok{border-left:4px solid var(--ok)}.status.soon{border-left:4px solid var(--svc,var(--point))}.status .btn{margin-top:8px}

/* 구역 */
.sec{padding:72px 0}.sec.alt{background:var(--paper)}
.sec h2{margin-bottom:12px}
.two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:56px;align-items:center}
.shot-frame{margin:0}.shot-frame figcaption{margin-top:10px}
.five{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;margin-top:28px}
.five div{border-top:3px solid var(--point);padding:14px 0 0}.five b{display:block;font-size:18px;margin-bottom:6px}.five p{color:var(--muted);font-size:14.5px;margin:0}
.svc-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:28px}
.svc-card{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:20px 18px;transition:transform .15s,box-shadow .15s}
.svc-card:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(28,27,25,.08)}
.svc-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:17px}.svc-head .dot{margin-right:0}.svc-head .chip{margin-left:auto}
.svc-one{font-size:15.5px;margin:10px 0 4px;font-weight:500}.svc-card .more{margin-top:auto;padding-top:12px;color:var(--point);font-weight:600;font-size:14px}
.price-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:26px 0 14px}
.price-cell{border:1px solid var(--line);border-radius:var(--radius);padding:18px;background:var(--surface)}.price-cell b{color:var(--muted);font-size:14px;font-weight:600}.price-cell .p{font-size:24px;font-weight:700;margin:6px 0 4px;letter-spacing:-.02em;line-height:1.3}
.cta-sec{background:var(--paper);border-top:1px solid var(--line)}

/* 서비스 페이지 */
.cases{counter-reset:c;list-style:none;padding:0;margin:20px 0 0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.cases li{counter-increment:c;border:1px solid var(--line);border-radius:var(--radius);padding:18px 18px 18px 56px;position:relative;font-size:15.5px;background:var(--surface)}
.cases li::before{content:counter(c);position:absolute;left:18px;top:17px;width:26px;height:26px;border-radius:50%;background:var(--point);color:#fff;font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center}
.feat-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:24px}
.feat{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px}.feat b{display:block;margin-bottom:6px;font-size:16px}.feat p{margin:0;color:var(--ink-2);font-size:14.5px}
.wire{border:1px dashed var(--line);border-radius:var(--radius);padding:22px;background:var(--paper);max-width:560px}
.wire ul{columns:2;margin:10px 0;padding-left:20px}.wire li{margin:4px 0}
.pills{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.pill{display:inline-flex;align-items:center;min-height:40px;border:1px solid var(--line);border-radius:999px;padding:7px 14px;font-weight:600;font-size:14px;background:var(--surface)}
.pill:hover{border-color:var(--point);color:var(--point)}
.price-line{font-size:19px;font-weight:700;margin:6px 0 8px}

/* 표 */
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);margin:18px 0}
table{border-collapse:collapse;width:100%;font-size:14.5px}
th{text-align:left;font-weight:600;color:var(--muted);font-size:13px;padding:11px 14px;border-bottom:1px solid var(--line);background:var(--surface-2);white-space:nowrap}
td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}
td.num{white-space:nowrap;font-weight:600}td .sub{display:block;font-weight:400;color:var(--muted);font-size:12.5px}
.price-table td:first-child{white-space:nowrap}

/* 계산기 */
.calc-grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:28px;margin-top:20px;align-items:start}
.calc-form{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:4px 18px}
.calc-form .row{display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px;min-height:52px;padding:10px 0;border-bottom:1px solid var(--line);cursor:pointer}.calc-form .row:last-child{border-bottom:0}
.calc-form input[type=checkbox]{width:20px;height:20px;margin:0;accent-color:var(--point);flex:none}
.calc-form .row .muted{margin-left:auto}
.inline{width:76px;min-height:40px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;font:inherit;font-size:16px;text-align:right;background:#fff}
.calc-out{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:22px;border-top:4px solid var(--point);position:sticky;top:calc(var(--head) + 16px)}
.calc-total .p{font-size:36px;font-weight:700;letter-spacing:-.02em;margin:4px 0 12px;line-height:1.2}
.calc-lines{list-style:none;padding:0;margin:0 0 12px}.calc-lines li{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px dashed var(--line);font-size:14.5px}.calc-lines li span:last-child{font-weight:600;white-space:nowrap}

/* 자주 묻는 것 */
.faq details{border-bottom:1px solid var(--line)}
.faq summary{cursor:pointer;font-weight:600;font-size:16px;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:16px;padding:16px 0;min-height:52px}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";color:var(--point);font-weight:700;font-size:20px;line-height:1}.faq details[open] summary::after{content:"−"}
.faq details p{margin:0 0 16px;color:var(--ink-2)}

/* 가이드·문서 */
.guide-quick{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}
.guide-grid{display:grid;grid-template-columns:240px minmax(0,1fr);gap:48px;align-items:start}
.guide-grid>*{min-width:0}
.guide-toc{position:sticky;top:calc(var(--head) + 20px);font-size:14px;max-height:calc(100vh - var(--head) - 40px);overflow:auto}
.guide-toc summary{list-style:none;color:var(--muted);font-size:13px;font-weight:700;margin-bottom:8px;pointer-events:none}
.guide-toc summary::-webkit-details-marker{display:none}
.guide-toc nav{display:flex;flex-direction:column;gap:2px}
.guide-toc a{padding:7px 10px;border-radius:7px;color:var(--ink-2)}.guide-toc a:hover{background:var(--surface-2)}
.doc{max-width:760px;font-size:15.5px}.doc h2{font-size:24px;margin:44px 0 12px;padding-top:16px;border-top:1px solid var(--line)}.doc h2:first-child{border-top:0;margin-top:0;padding-top:0}
.doc h3{font-size:18px;margin:28px 0 8px}.doc ul,.doc ol{padding-left:22px}.doc li{margin:5px 0}
.doc code{font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;font-size:.88em;background:var(--surface-2);padding:1px 6px;border-radius:5px;word-break:break-all}
.doc pre{background:var(--surface-2);padding:14px 16px;border-radius:10px;overflow:auto;font-size:13px;line-height:1.55;max-width:100%}.doc pre code{background:none;padding:0;word-break:normal;white-space:pre}
.doc blockquote{margin:14px 0;padding:10px 16px;border-left:3px solid var(--point);background:var(--point-soft);border-radius:0 10px 10px 0}.doc blockquote p{margin:0}
.doc hr{border:0;border-top:1px solid var(--line);margin:36px 0}
.doc a:not(.btn):not(.pill){color:var(--point)}
.notice{border-top:1px solid var(--line);padding:24px 0}.notice:first-child{border-top:0;padding-top:0}.notice time{color:var(--point);font-weight:700;font-size:14px;white-space:nowrap}.notice h3{margin:6px 0 8px}

/* 시작하기 단계 */
.steps{counter-reset:s;list-style:none;padding:0;margin:0 0 24px;display:grid;gap:14px;max-width:820px}
.steps li{counter-increment:s;display:grid;grid-template-columns:40px minmax(0,1fr);gap:16px;align-items:start;border:1px solid var(--line);border-radius:var(--radius);padding:22px;background:var(--surface)}
.steps li::before{content:counter(s);width:36px;height:36px;border-radius:50%;background:var(--point);color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center}
.steps b{display:block;font-size:17px;margin:5px 0 4px}.steps p{margin:0;color:var(--ink-2)}
.legal h2{font-size:18px;margin:28px 0 8px;border-top:0;padding-top:0}

/* 바닥글 */
.foot{border-top:1px solid var(--line);padding:48px 0 28px;background:var(--bg)}
.foot-grid{display:grid;grid-template-columns:1.4fr 1fr 1fr 1.3fr;gap:24px}
.foot-grid b{display:block;margin-bottom:4px;font-size:14px}.foot-grid a,.foot-grid span{display:block;color:var(--ink-2);font-size:14px;padding:7px 0;line-height:1.5}.foot-grid a:hover{color:var(--point)}
.foot-bottom{display:flex;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;margin-top:28px;padding-top:16px;border-top:1px solid var(--line);font-size:13px}

/* ── 태블릿 가로·작은 노트북 (≤1100) ── */
@media (max-width:1100px){
  .svc-grid,.price-row{grid-template-columns:repeat(2,minmax(0,1fr))}
  .hero-grid{gap:36px}.two{gap:40px}
  .foot-grid{grid-template-columns:1.2fr 1fr 1fr 1.3fr}
}
/* ── 태블릿 세로 (≤900): 햄버거 메뉴, 한 단 배치 ── */
@media (max-width:900px){
  :root{--head:58px}
  h1,.hero h1{font-size:36px}.hero.sub h1{font-size:32px}h2{font-size:25px}.lead{font-size:17px}.h-sub{font-size:19px}
  .nav-btn{display:flex;flex-direction:column;justify-content:center;align-items:center;gap:5px;width:44px;height:44px;margin-right:-8px;border-radius:8px}
  .nav-btn span{display:block;width:22px;height:2px;background:var(--ink);border-radius:2px;transition:transform .2s,opacity .2s}
  .top.nav-open .nav-btn span:nth-child(1){transform:translateY(7px) rotate(45deg)}
  .top.nav-open .nav-btn span:nth-child(2){opacity:0}
  .top.nav-open .nav-btn span:nth-child(3){transform:translateY(-7px) rotate(-45deg)}
  .nav{display:none;position:absolute;left:0;right:0;top:var(--head);max-height:calc(100vh - var(--head));max-height:calc(100dvh - var(--head));overflow-y:auto;background:var(--surface);border-bottom:1px solid var(--line);flex-direction:column;align-items:stretch;padding:8px var(--gutter) 18px;gap:2px;box-shadow:0 24px 40px rgba(28,27,25,.10)}
  .top.nav-open .nav{display:flex}
  .nav a{min-height:48px;padding:12px 10px;font-size:16px}
  .nav .login{margin:6px 0 0}.nav .btn{margin:8px 0 0;min-height:48px;justify-content:center}
  .nav-group .nav-label{min-height:36px;padding:12px 10px 4px;color:var(--muted);font-size:13px;pointer-events:none}.nav-group .nav-label svg{display:none}
  .nav-group .menu{display:flex;flex-direction:column}.nav-group .menu a{display:flex;padding-left:24px}
  .hero{padding:44px 0 32px}.hero-grid{grid-template-columns:1fr;gap:28px}
  .hero-shots{max-width:680px;padding-bottom:24px}.hero-shots .phone{width:28%}
  .two{grid-template-columns:1fr;gap:28px}.two.rev>figure{order:2}
  .five{grid-template-columns:repeat(3,minmax(0,1fr));row-gap:22px}
  .cases{grid-template-columns:1fr}
  .feat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .guide-grid{grid-template-columns:1fr;gap:20px}
  .guide-toc{position:static;max-height:none;overflow:visible;border:1px solid var(--line);border-radius:var(--radius);background:var(--paper)}
  .guide-toc summary{pointer-events:auto;cursor:pointer;display:flex;justify-content:space-between;align-items:center;margin:0;padding:14px 16px;min-height:50px;font-size:15px;color:var(--ink)}
  .guide-toc summary::after{content:"+";color:var(--point);font-size:20px;font-weight:700;line-height:1}.guide-toc[open] summary::after{content:"−"}
  .guide-toc nav{padding:0 8px 10px}.guide-toc a{min-height:44px;display:flex;align-items:center}
  .foot-grid{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:28px}
  .foot-grid a,.foot-grid span{padding:8px 0}
  .sec{padding:52px 0}
  .calc-out{position:static}
}
/* ── 폰 (≤600) ── */
@media (max-width:600px){
  :root{--gutter:16px}
  h1,.hero h1{font-size:30px}.hero.sub h1{font-size:28px}h2{font-size:22px}h3{font-size:18px}.lead{font-size:16px}.h-sub{font-size:17px}
  .hero{padding:32px 0 24px}.hero.sub{padding:36px 0 28px}.sec{padding:44px 0}
  .cta .btn{flex:1 1 100%}
  .hero-shots .phone{display:none}.hero-shots{padding-bottom:0}
  .five{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 14px}
  .svc-grid,.price-row,.feat-grid,.calc-grid{grid-template-columns:1fr}
  .svc-card{padding:18px 16px}
  .wire ul{columns:1}
  .steps li{grid-template-columns:32px minmax(0,1fr);gap:12px;padding:18px 16px}.steps li::before{width:32px;height:32px;font-size:14px}.steps b{margin-top:3px}
  .foot-grid{grid-template-columns:1fr}
  .foot-bottom{flex-direction:column}
  .calc-total .p{font-size:30px}
  /* 표를 행마다 카드로 쌓기 */
  .table-wrap.stack-wrap{overflow:visible;border:0;background:none;border-radius:0}
  table.stack,table.price-table{min-width:0}
  table.stack thead,table.price-table thead{display:none}
  table.stack tr,table.price-table tr{display:block;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:12px 14px;margin-bottom:10px}
  table.stack td,table.price-table td{display:block;border:0;padding:3px 0}
  table.stack td:first-child{font-weight:700;font-size:15.5px;padding-bottom:6px}
  table.stack td[data-label]:not(:first-child)::before,table.price-table td[data-label]::before{content:attr(data-label);display:block;color:var(--muted);font-size:12.5px;font-weight:600;margin-top:4px}
  table.stack.two-col td[data-label]:not(:first-child)::before{display:none}
  table.price-table tr{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px}
  table.price-table td:first-child{white-space:normal;font-size:15.5px}
  table.price-table td.num{text-align:right}
  table.price-table td:nth-child(3){grid-column:1/-1;color:var(--ink-2);font-size:14px;border-top:1px dashed var(--line);margin-top:8px;padding-top:8px}
  table.price-table td:nth-child(3)::before{display:none}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}html{scroll-behavior:auto}}
@media print{.top,.foot,.cta,.nav-btn{display:none!important}.sec,.hero{padding:16px 0}}
`);

// ---------- JS ----------
fs.writeFileSync(path.join(OUT, "site", "site.js"), `
(function(){
  var top=document.querySelector(".top"), burger=document.querySelector(".nav-btn");
  // 모바일·태블릿 메뉴
  function setMenu(open){ if(!top) return; top.classList.toggle("nav-open",open); if(burger){burger.setAttribute("aria-expanded",open?"true":"false");burger.setAttribute("aria-label",open?"메뉴 닫기":"메뉴 열기");} }
  if(burger) burger.addEventListener("click",function(e){ e.stopPropagation(); setMenu(!top.classList.contains("nav-open")); });
  document.querySelectorAll(".nav a").forEach(function(a){ a.addEventListener("click",function(){ setMenu(false); closeGroups(); }); });
  // PC·태블릿 가로: 서비스 메뉴는 눌러서 열고 닫는다(마우스는 올리기만 해도 열림)
  var groups=[].slice.call(document.querySelectorAll(".nav-group"));
  function closeGroups(except){ groups.forEach(function(g){ if(g!==except){ g.classList.remove("open"); var b=g.querySelector(".nav-label"); if(b) b.setAttribute("aria-expanded","false"); } }); }
  groups.forEach(function(g){ var b=g.querySelector(".nav-label"); if(!b) return; b.addEventListener("click",function(e){ e.stopPropagation(); var open=!g.classList.contains("open"); closeGroups(g); g.classList.toggle("open",open); b.setAttribute("aria-expanded",open?"true":"false"); }); });
  document.addEventListener("click",function(e){ if(top && !top.contains(e.target)) setMenu(false); if(!e.target.closest || !e.target.closest(".nav-group")) closeGroups(); });
  document.addEventListener("keydown",function(e){ if(e.key==="Escape"){ setMenu(false); closeGroups(); } });
  window.addEventListener("resize",function(){ if(window.innerWidth>900) setMenu(false); });
  // 가이드 목차: 좁은 화면에서는 접어 둔다
  if(window.matchMedia && window.matchMedia("(max-width:900px)").matches){ document.querySelectorAll("details.guide-toc").forEach(function(d){ d.removeAttribute("open"); d.querySelectorAll("a").forEach(function(a){ a.addEventListener("click",function(){ d.removeAttribute("open"); }); }); }); }
})();
// 가격 계산기 — 숫자는 서버 상수와 같이 바꾼다
(function(){
  var P=${JSON.stringify({ pro: PRICING.pro.price, proYear: PRICING.pro.year, svc: PRICING.svc, names: Object.fromEntries(SVC.map((s) => [s.id, s.name])), seat: PRICING.seat, disc: PRICING.bundleDiscount, all: PRICING.all, allYear: PRICING.allYear })};
  var total=document.getElementById("c-total"); if(!total) return;
  var won=function(n){return n.toLocaleString("ko-KR")+"원";};
  function calc(){
    var pro=document.getElementById("c-pro").checked, year=document.getElementById("c-year").checked;
    var seatsEl=document.getElementById("c-seats");
    var seats=Math.min(50,Math.max(0,parseInt(seatsEl.value||"0",10)||0));
    var svcs=[].slice.call(document.querySelectorAll(".c-svc:checked")).map(function(el){return el.dataset.id;});
    var lines=[], sum=0;
    if(pro){var p=year?P.proYear:P.pro; lines.push(["마이웍스 프로",p]); sum+=p;}
    var disc=svcs.length>=2?P.disc:0;
    svcs.forEach(function(id){var v=Math.round(P.svc[id]*(1-disc)); lines.push([P.names[id]+(disc?" (10% 할인)":""),v]); sum+=v;});
    if(seats>0){lines.push(["추가 좌석 "+seats+"명",seats*P.seat]); sum+=seats*P.seat;}
    var note="";
    if(pro&&svcs.length===4){var all=year?P.allYear:P.all; var base=sum-seats*P.seat; if(all<base){sum=all+seats*P.seat; lines=[["마이웍스 올인원 (프로 + 서비스 4개)",all]]; if(seats>0)lines.push(["추가 좌석 "+seats+"명",seats*P.seat]); note="프로와 서비스 4개를 전부 고르면 올인원 요금이 적용됩니다.";}}
    if(!pro&&svcs.length){note="분야 서비스는 프로에서 켭니다. 프로를 함께 계산에 넣어 주세요.";}
    if(!lines.length){note="베이직은 무료입니다. 프로와 서비스를 골라 보세요.";}
    total.textContent=won(sum)+(year?" (연 결제)":"");
    document.getElementById("c-lines").innerHTML=lines.map(function(l){return "<li><span>"+l[0]+"</span><span>"+won(l[1])+"</span></li>";}).join("");
    document.getElementById("c-note").textContent=(note?note+" ":"")+"예정 요금이며 VAT 별도입니다.";
  }
  document.querySelectorAll("#c-pro,.c-svc,#c-seats,#c-year").forEach(function(el){el.addEventListener("input",calc);el.addEventListener("change",calc);});
  calc();
})();
`);

// 이미지 복사
// 화면 캡처는 저장소의 site/img/ 에 두고 그대로 쓴다. (생성기 옆에 img/ 폴더가 있으면 그것을 복사한다)
const imgSrc = path.join(__dirname, "img");
if (fs.existsSync(imgSrc)) fs.readdirSync(imgSrc).forEach((f) => fs.copyFileSync(path.join(imgSrc, f), path.join(OUT, "site", "img", f)));
console.log("done →", OUT);
