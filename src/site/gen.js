// 마이웍스 공개 홈페이지 생성기 — node gen.js <출력 디렉터리>
// 생성 결과(HTML)는 저장소에 그대로 올라간다. 문구를 고칠 때는 이 파일을 고치고 다시 생성한다.
const fs = require("fs");
const path = require("path");
const OUT = process.argv[2] || path.join(__dirname, "dist");
fs.mkdirSync(path.join(OUT, "site", "img"), { recursive: true });

const SITE = "https://myworks.ai.kr";
// 사업자 정보 — 사업자등록증(2024. 12. 5. 발급) 기준. 전자상거래법 제10조에 따라 첫 화면 아래에 표시합니다.
const BIZ = {
  name: "주식회사 블랭크", ceo: "최시준", no: "161-86-03494",
  addr: "서울특별시 강남구 영동대로 602, 6층 제트71 (삼성동)",
  tel: "010-2384-9580", email: "spaceblank0100@gmail.com",
  mailorder: "신고 진행 중", host: "myworks.ai.kr", hosting: "Cloudflare, Inc.",
};
const DATE = "2026. 11. 16.";
const ISO_DATE = "2026-11-16";
// 검색엔진 소유확인 — 네이버 서치어드바이저(HTML 태그 방식). 구글·Bing은 DNS로 확인해 태그가 필요 없다.
const NAVER_VERIFY = "586c9b2fa411e4a5f8fc39b971e52b7b6e9b4bed";
const { CATS, ARTICLES, FAQ } = require("./content.js");

// ---------- 공통 데이터 ----------
const SVC = [
  { id: "store", seoTitle: "마이스토어 — 매장·공간대여 운영 관리", seoDesc: "음식점·카페, 소매·무인매장, 미용실·필라테스 같은 예약형 매장, 파티룸·스터디룸 같은 공간대여를 위한 마이웍스 확장판. 예약, 오픈·마감 점검, 일 마감, 근무자 체크리스트, 소모품, 리뷰, 지점별 손익을 한 흐름으로 관리합니다.", name: "마이스토어", color: "#1F7A5A", who: "자영업자 · 점주 · 공간 운영자", one: "매장과 공간을 하루 단위로 굴린다",
    line: "지점 · 예약 · 오픈·마감 점검 · 일 마감 · 근무자 · 소모품 · 리뷰를 한 흐름으로", status: "now",
    now: "음식·카페, 소매·무인매장, 예약형 매장, 공간대여·숙박 네 업종의 예약·점검·일 마감·근무자·소모품·리뷰·손익을 지금 쓸 수 있습니다.", next: "지금은 무료 공개 기간이라 결제 없이 씁니다.",
    cases: ["카페 오픈·마감을 아르바이트에게 맡기고, 그날 매출과 시재는 휴대폰으로 받아 보고 싶다", "미용실·필라테스처럼 담당자별로 시간 예약을 받고 노쇼를 따로 챙긴다", "파티룸·스터디룸 청소를 근무자에게 맡기되 예약자 정보는 보여 주고 싶지 않다"],
    features: [["업종별 시작", "음식·카페, 소매·무인매장, 예약형 매장, 공간대여·숙박 중에서 고르면 점검 항목과 결제수단이 업종에 맞춰 준비된다"], ["예약", "공간 대관은 달력으로, 예약형 매장은 담당자별 시간 예약과 노쇼 기록으로. 채널별 수수료가 자동 계산된다"], ["일 마감", "결제수단별 매출과 시재를 적어 하루를 닫는다. 관리자가 확인하면 잠기고, 손익은 돈 메뉴로 보낼 수 있다"], ["근무자", "오픈·마감 점검과 청소 체크리스트를 휴대폰으로 제출한다. 근무자 화면에는 예약자 이름·연락처·금액이 보이지 않는다"], ["시설·소모품", "고장·오염 신고와 처리 기록, 소모품 남은 수량과 부족 알림"], ["리뷰·문의", "플랫폼 리뷰·문의를 모아 답글을 기록한다. 초안은 클로드에게 부탁할 문장을 복사해 받고, 확정은 사람이 한다"]],
    img: { src: "space-pnl.jpg", alt: "마이스토어 손익 화면 — 지점별 매출, 채널 수수료, 영업이익" },
    with: ["tax", "seller", "people"], price: "월 19,000원 · 지점 3개 포함 · 추가 지점 1개당 5,000원" },
  { id: "building", seoTitle: "마이빌딩 — 소규모 건물·임대관리", seoDesc: "소규모 건물주와 임대인을 위한 임대관리 서비스. 호실, 임대차계약 만기 알림, 월세·관리비 수납, 공실, 법정 점검을 달력과 알림으로 챙깁니다. 2027년 1분기 출시 예정.", name: "마이빌딩", color: "#2B4FD6", who: "소규모 건물주 · 임대인 · 상가 운영자", one: "임대차와 건물 관리를 혼자서 챙긴다",
    line: "호실 · 계약 · 수납 · 공실 · 시설 점검 · 정산을 달력과 알림으로", status: "soon",
    now: "", next: "2027년 1분기 출시 예정입니다. 비공개 베타에 먼저 초대합니다.",
    cases: ["2~3층짜리 건물에 상가와 사무실 호실 몇 개를 직접 관리한다", "월세 입금은 통장을 보고 확인하고, 계약 만기는 수첩에 적어 둔다", "소방 점검 보고를 한 번 놓쳐 과태료를 낸 적이 있다"],
    features: [["건물·호실", "건물마다 호실·면적·용도·임차인. 공실은 한눈에"], ["임대차계약", "기간·보증금·월세·관리비·인상 조건. 만기 90/60/30일 전 알림, 갱신요구권 안내"], ["수납", "월세·관리비 고지서 발행, 입금 확인, 미납 알림. 임차인은 확인 링크로 고지서와 영수증을 본다"], ["공실", "공실 → 광고 → 문의 → 계약까지 단계 관리. 중개사 공유 링크"], ["시설·점검", "소방·승강기·전기 등 법정 점검 주기를 달력에 올리고, 수리는 업체에 견적 요청"], ["정산·세금", "공과금 배분, 세금계산서 발행 체크, 임대소득 자료를 마이택스로"]],
    img: null, with: ["tax"], price: "월 19,000원 · 건물 3개·호실 30개 포함 · 추가 호실 10개당 5,000원" },
  { id: "tax", seoTitle: "마이택스 — 1인 사업자 매출·손익·세금 준비", seoDesc: "개인·법인 사업자와 3.3% 프리랜서를 위한 마이웍스 확장판. 매출·매출원가·수수료·인건비 구조를 내 사업에 맞게 정하고, 매출·현금 흐름과 KPI를 기간별로 봅니다. 사업자별 부가세·종합소득세 신고 자료, 홈택스 자료 대조, 세금 달력, 절세 점검과 지원사업 정리까지 한곳에서 합니다. 신고·세무 대리는 하지 않습니다.", name: "마이택스", color: "#6B4ED6", who: "개인·법인 사업자 · 3.3% 프리랜서 · 사업자가 여러 개인 분", one: "숫자와 세금 준비를 평소에 끝내 둔다",
    line: "손익 구조 · 매출·현금 흐름 · KPI · 신고 자료 · 증빙 · 세금 달력 · 절세·지원사업", status: "now",
    now: "돈 메뉴와 마이스토어·마이셀러·거래·마이피플 기록을 모아 손익과 현금 흐름, KPI를 보여 주고, 사업자별 부가세·종합소득세 신고 자료와 세금 달력을 지금 쓸 수 있습니다.", next: "지금은 무료 공개 기간이라 결제 없이 씁니다. 세금 숫자는 모두 참고용 추정이며, 신고는 홈택스나 세무사를 통해 합니다.",
    cases: ["부가세 신고 때마다 영수증과 카드 내역을 맞추느라 이틀을 쓴다", "사업자가 두 개인데 어느 매출이 어느 사업자 것인지 매번 헷갈린다", "이번 달에 얼마 남았는지, 다음 달 세금으로 얼마를 떼어 둬야 하는지 감으로 안다"],
    features: [["손익 구조", "매출·매출원가·수수료·인건비·임차료·마케팅처럼 내 사업에 맞는 항목을 직접 만들고, 돈 기록의 분류를 연결한다"], ["흐름과 KPI", "월별 매출·이익 흐름과 앞으로 60일 현금 흐름. 월·분기·연 단위 목표를 세우고 달성률을 기간별로 본다"], ["신고 자료", "부가세는 홈택스 신고서 칸 그대로, 종합소득세는 과세표준과 세율까지 추정한다. 사업자별로 나누고, 내 계좌 이체·보증금 같은 사업과 무관한 돈은 사유를 남겨 뺀다"], ["홈택스 자료 대조", "홈택스에서 받은 세금계산서·현금영수증·카드 내역 파일을 올리면 돈 기록과 자동으로 맞추고, 빠진 기록은 채운다"], ["세금 달력", "부가세·종합소득세·원천세·4대보험·세금계산서 발급 마감을 내 사업자 유형에 맞게 보여 주고 휴대폰 일정으로 보낸다"], ["절세·지원", "노란우산·장부·사업용 카드·적격증빙 같은 점검표와 예상 효과, 지원사업 정리, 세무사 상담용 요약 복사"]],
    img: { src: "tax.jpg", alt: "마이택스 현황 화면 — 이달 매출·영업이익, 최근 6개월 흐름, 다가오는 세금 일정, KPI" },
    with: ["store", "seller", "people"], price: "월 9,900원 · 사업자 여러 개, 신고 자료, 홈택스 자료 대조, 세금 달력" },
  { id: "people", seoTitle: "마이피플 — 파트너 관리와 아르바이트 근무·급여 관리", seoDesc: "함께 일하는 파트너의 평가·레퍼런스·협업 이력과 명함을 정리하고, 아르바이트·직원·건당 근무자의 근무표, 휴대폰 출퇴근, 시급·주급·월급·건당 급여 계산, 임금명세서 링크까지 한곳에서 관리하는 마이웍스 확장판입니다.", name: "마이피플", color: "#C2410C", who: "외주 파트너와 일하는 프리랜서 · 아르바이트와 직원을 쓰는 사장님", one: "함께 일하는 사람과 근무·급여를 한곳에서 챙긴다",
    line: "파트너 · 레퍼런스 · 명함 · 근무표 · 출퇴근 · 급여 · 임금명세서", status: "now",
    now: "파트너 평가·레퍼런스·협업 이력과 명함, 근무표와 휴대폰 출퇴근, 시급·일급·주급·월급·건당 급여 계산, 임금명세서 링크, 근로계약서 인쇄를 지금 쓸 수 있습니다.", next: "지금은 무료 공개 기간이라 결제 없이 씁니다. 급여 숫자는 기록으로 계산한 참고값이니 지급 전에 한 번 확인하세요.",
    cases: ["외주 디자이너·시공팀과 여러 번 일했는데, 누가 일정을 잘 지켰는지는 기억에만 있다", "아르바이트 근무표는 단톡방에, 출퇴근은 종이에, 급여는 엑셀로 따로 계산한다", "주휴수당과 3.3% 공제를 매달 손으로 계산하다 틀린 적이 있다"],
    features: [["파트너", "연락처마다 별점과 ‘다시 함께할지’, 단가·조건 메모, 협업 이력, 거래 기록을 모아 본다"], ["레퍼런스 체크", "물어볼 질문을 복사해 묻고, 들은 답과 추천도를 그 사람 기록에 남긴다"], ["명함", "명함 사진을 보관하고, 휴대폰에서 복사한 명함 글자를 붙여 넣으면 이름·회사·직함·연락처 칸을 채운다"], ["근무표·출퇴근", "주간 근무표를 칸을 눌러 짜고 지난주를 복사한다. 근무자는 휴대폰으로 출근·퇴근을 찍고, 매장과의 거리도 남는다"], ["급여 계산", "시급·일급·주급·월급·건당. 주 15시간 이상이면 주휴수당, 5인 이상이면 연장·야간 가산, 4대보험·3.3%·일용직 원천징수를 자동으로 뺀다"], ["명세서와 기록", "임금명세서를 링크로 보내면 근무자가 ‘받았습니다’를 누른다. 지급하면 인건비가 돈 메뉴와 마이택스로 간다. 급여 정보는 관리자만 본다"]],
    img: { src: "mypeople.jpg", alt: "마이피플 급여 화면 — 근무자별 지급액, 공제, 실지급액, 명세서 확인 여부" },
    with: ["store", "tax"], price: "" },
  { id: "seller", seoTitle: "마이셀러 — 온라인 셀러 주문·송장·재고·정산 관리", seoDesc: "스마트스토어·쿠팡·자사몰 주문을 한곳에 모으고 송장 일괄 처리, 옵션별 재고, 발주·입고, 반품·교환, 채널별 손익과 정산 대사까지 관리하는 1인 온라인 판매자용 마이웍스 확장판입니다.", name: "마이셀러", color: "#0E8A8A", who: "1인 온라인 판매자 · 부업 셀러 · 소규모 도매", one: "주문·송장·재고·정산을 하루 한 번에 끝낸다",
    line: "채널 · 주문 · 송장 · 재고 · 발주 · 반품·교환 · 문의 · 정산", status: "now",
    now: "주문 엑셀 업로드부터 송장 일괄 처리, 옵션별 재고와 기록, 발주·입고, 반품·교환, 문의, 상품별·채널별 손익과 정산 대사까지 지금 쓸 수 있습니다.", next: "지금은 무료 공개 기간이라 결제 없이 씁니다.",
    cases: ["스마트스토어와 쿠팡 주문을 엑셀로 내려받아 합치고 송장을 하나씩 다시 올린다", "공급처 발주를 카톡으로 하다 보니 수량이 자꾸 엇갈린다", "채널마다 정산이 맞는지 확인할 시간이 없다"],
    features: [["주문 모으기", "채널별 주문 엑셀을 올리면 열을 자동으로 맞춘다. 채널마다 한 번 맞추면 기억한다"], ["송장 일괄 처리", "택배 접수 파일을 받고, 송장이 붙은 파일을 올리면 주문번호로 찾아 한 번에 발송 처리한다. 채널별 송장 등록 파일도 바로 받는다"], ["상품·재고", "옵션 단위 재고와 안전재고 알림. 발송·반품·입고·조정이 모두 기록으로 남는다"], ["발주·입고", "발주서를 확인 링크로 보내면 공급처가 계정 없이 확인하거나 변경을 요청한다. 입고 처리하면 재고에 바로 더해진다"], ["반품·교환", "접수 → 회수 → 처리 완료. 재입고 여부를 고르고, 교환은 재발송 주문이 자동으로 생긴다"], ["발송 담당", "작업자 화면에서 포장·송장·발송 처리. 금액·매입가·정산 정보는 작업자 기기로 가지 않는다"], ["문의·CS", "답변 문구를 저장해 두고 골라 쓴다. 초안이 필요하면 클로드에 붙여 넣을 문장을 복사한다"], ["손익·정산", "채널 수수료·배송비·광고비를 반영한 채널별 손익과 상품별 마진, 정산 예정액과 입금액 대사"]],
    img: { src: "commerce.jpg", alt: "마이셀러 현황 화면 — 발송할 주문, 답할 문의, 재고 부족 상품, 이달 매출" },
    with: ["tax", "store"], price: "월 19,000원 · 월 주문 1,000건 포함 · 추가 1,000건당 5,000원" },
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

// 구조화 데이터(JSON-LD)
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
const ORG_ID = SITE + "/#organization";
const ORG_LD = {
  "@type": "Organization", "@id": ORG_ID, name: "마이웍스", legalName: BIZ.name, alternateName: ["MyWorks", "㈜블랭크"], url: SITE + "/",
  logo: { "@type": "ImageObject", url: SITE + "/site/img/icon-512.png", width: 512, height: 512 },
  email: BIZ.email, telephone: "+82-" + BIZ.tel.replace(/^0/, ""),
  address: { "@type": "PostalAddress", addressCountry: "KR", addressRegion: "서울특별시", addressLocality: "강남구", streetAddress: "영동대로 602, 6층 제트71" },
  founder: { "@type": "Person", name: BIZ.ceo },
};
const SITE_LD = { "@type": "WebSite", "@id": SITE + "/#website", name: "마이웍스", alternateName: ["MyWorks", "마이웍스 업무관리"], url: SITE + "/", inLanguage: "ko-KR", publisher: { "@id": ORG_ID } };
const APP_LD = {
  "@type": "SoftwareApplication", name: "마이웍스", applicationCategory: "BusinessApplication", operatingSystem: "Web",
  description: "1인 사업자·프리랜서·소규모 팀을 위한 업무관리 플랫폼. 오늘 결정할 것, 일, 거래, 돈, 사람을 한곳에서 관리합니다.",
  url: SITE + "/", inLanguage: "ko-KR", publisher: { "@id": ORG_ID },
  offers: { "@type": "Offer", price: "0", priceCurrency: "KRW", description: "베이직 — 기본 기능 무료" },
};
const crumbsLd = (items) => ({ "@type": "BreadcrumbList", itemListElement: items.map(([name, url], i) => ({ "@type": "ListItem", position: i + 1, name, item: SITE + url })) });
const graph = (...nodes) => ld({ "@context": "https://schema.org", "@graph": nodes });

function head(title, desc, extra = "", opt = {}) {
  const img = SITE + (opt.image || "/site/img/og.png");
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="${opt.noindex ? "noindex,follow" : "index,follow,max-image-preview:large,max-snippet:-1"}">
<meta name="naver-site-verification" content="${NAVER_VERIFY}">
<meta property="og:site_name" content="마이웍스">
<meta property="og:locale" content="ko_KR">
<meta property="og:type" content="${opt.type || "website"}">
<meta property="og:title" content="${esc(opt.ogTitle || title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${img}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(opt.ogTitle || title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${img}">
<meta name="theme-color" content="#FF4712">
<meta name="format-detection" content="telephone=no">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" type="image/svg+xml" href="/site/img/icon.svg">
<link rel="apple-touch-icon" href="/site/img/apple-touch-icon.png">
<link rel="alternate" type="application/rss+xml" title="마이웍스 블로그" href="/rss.xml">
<link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<link rel="stylesheet" href="/site/site.css">
${extra}
</head>
<body>
<a class="skip" href="#main">본문으로 건너뛰기</a>`;
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
          <a href="/features"${a("features")}><i class="dot" style="background:#FF4712"></i>기본 기능</a>
          <a href="/store"${a("store")}><i class="dot" style="background:#1F7A5A"></i>마이스토어</a>
          <a href="/building"${a("building")}><i class="dot" style="background:#2B4FD6"></i>마이빌딩</a>
          <a href="/tax"${a("tax")}><i class="dot" style="background:#6B4ED6"></i>마이택스</a>
          <a href="/seller"${a("seller")}><i class="dot" style="background:#0E8A8A"></i>마이셀러</a>
          <a href="/people"${a("people")}><i class="dot" style="background:#C2410C"></i>마이피플</a>
        </div>
      </div>
      <a href="/pricing"${a("pricing")}>가격</a>
      <a href="/blog/"${a("blog")}>블로그</a>
      <a href="/guide"${a("guide")}>가이드</a>
      <a href="/faq"${a("faq")}>자주 묻는 질문</a>
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
        <a href="/features">기본 기능</a><a href="/store">마이스토어</a><a href="/building">마이빌딩</a><a href="/tax">마이택스</a><a href="/seller">마이셀러</a><a href="/people">마이피플</a><a href="/pricing">가격</a>
      </div>
      <div>
        <b>안내</b>
        <a href="/start">시작하기</a><a href="/guide">가이드</a><a href="/faq">자주 묻는 질문</a><a href="/blog/">블로그</a><a href="/notice">공지</a>
      </div>
      <div>
        <b>회사</b>
        <a href="/about">회사 소개</a>
        <span>㈜블랭크 · 대표 최시준</span>
        <a href="mailto:${BIZ.email}">${BIZ.email}</a>
        <a href="tel:${BIZ.tel.replace(/-/g, "")}">${BIZ.tel}</a>
        <a href="/terms">이용약관</a><a href="/privacy"><b class="em">개인정보처리방침</b></a>
      </div>
    </div>
    <dl class="biz">
      <div><dt>상호</dt><dd>${BIZ.name}</dd></div>
      <div><dt>대표</dt><dd>${BIZ.ceo}</dd></div>
      <div><dt>사업자등록번호</dt><dd>${BIZ.no}</dd></div>
      <div><dt>통신판매업 신고</dt><dd>${BIZ.mailorder}</dd></div>
      <div class="wide"><dt>주소</dt><dd>${BIZ.addr}</dd></div>
      <div><dt>전화</dt><dd>${BIZ.tel}</dd></div>
      <div><dt>이메일</dt><dd>${BIZ.email}</dd></div>
      <div><dt>개인정보 보호책임자</dt><dd>${BIZ.ceo}</dd></div>
      <div><dt>호스팅 제공</dt><dd>${BIZ.hosting}</dd></div>
    </dl>
    <div class="foot-bottom muted">
      <span>© ${new Date().getFullYear()} ㈜블랭크. 마이웍스는 Cloudflare 위에서 동작합니다.</span>
      <span>최근 갱신 ${DATE}</span>
    </div>
  </div>
</footer>
<script src="/site/site.js" defer></script>
<script defer src="https://choisijun.com/k1.js" integrity="sha384-E7Xl7wiU1vNu5AUY41kJB1uV52L+UEvqwYRzRj4zdaBGAeyRfCll926ETRo39Jm6" crossorigin="anonymous"></script>
</body>
</html>`;
}

// 검색엔진용: 페이지마다 대표 주소(canonical)를 붙이고, 만든 페이지 목록으로 sitemap.xml을 만든다.
const PAGES = [];
const urlOf = (file) => file === "index.html" ? "/" : /\/index\.html$/.test(file) ? "/" + file.replace(/index\.html$/, "") : "/" + file.replace(/\.html$/, "");
// crumbs: [[이름, 주소], …] — 화면 위 경로와 구조화 데이터에 함께 쓴다(홈은 자동으로 붙는다)
const faqQ = q => { for (const [, list] of FAQ) for (const x of list) if (x[0] === q) return x; throw new Error("FAQ 없음: " + q); };
function page({ file, title, desc, active, body, extra = "", lastmod = ISO_DATE, crumbs = null, ldNodes = [], type, ogTitle, noindex = false, priority }) {
  const urlPath = urlOf(file);
  if (!noindex) PAGES.push({ url: urlPath, lastmod, priority: priority || (urlPath === "/" ? "1.0" : /^\/blog\/./.test(urlPath) ? "0.7" : "0.8") });
  const nodes = [...ldNodes];
  if (crumbs) nodes.push(crumbsLd([["홈", "/"], ...crumbs]));
  extra = `<link rel="canonical" href="${SITE}${urlPath}">\n<meta property="og:url" content="${SITE}${urlPath}">` + (nodes.length ? "\n" + graph(...nodes) : "") + (extra ? "\n" + extra : "");
  const html = head(title, desc, extra, { type, ogTitle, noindex }) + header(active) + `\n<main id="main">${body}\n</main>` + footer();
  fs.mkdirSync(path.dirname(path.join(OUT, file)), { recursive: true });
  fs.writeFileSync(path.join(OUT, file), html);
  console.log("written", file, html.length);
}
const crumbNav = (items) => `<nav class="crumbs" aria-label="현재 위치"><a href="/">홈</a>${items.map(([n, u], i) => i === items.length - 1 ? `<span aria-current="page">${esc(n)}</span>` : `<a href="${u}">${esc(n)}</a>`).join("")}</nav>`;

const svcCard = (s, full = false) => `
<a class="svc-card" href="/${s.id}">
  <div class="svc-head"><i class="dot" style="background:${s.color}"></i><b>${s.name}</b>${statusChip(s)}</div>
  <p class="svc-one">${esc(s.one)}</p>
  <p class="muted small">${esc(s.who)}</p>
  ${full ? `<p class="svc-line">${esc(s.line)}</p>` : ""}
  <span class="more">자세히 →</span>
</a>`;
const statusChip = (s) => s.status === "now" ? '<span class="chip ok">사용 가능</span>' : s.status === "part" ? '<span class="chip ok">일부 사용 가능</span>' : '<span class="chip soon">2027년 1분기</span>';

// ---------- 블로그 공통 ----------
const fmtDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${y}. ${m}. ${d}.`; };
const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const readMin = (html) => Math.max(2, Math.round(plain(html).length / 550));
const postCard = (a) => `
<a class="post-card" href="/blog/${a.slug}" data-cat="${a.cat}">
  <span class="post-cat">${esc(CATS[a.cat])}</span>
  <b>${esc(a.title)}</b>
  <p>${esc(a.desc)}</p>
  <span class="post-meta"><time datetime="${a.date}">${fmtDate(a.date)}</time> · 읽는 시간 ${readMin(a.body)}분</span>
</a>`;
const postsFor = (id, n = 3) => ARTICLES.filter((a) => a.svc.includes(id)).slice(0, n);
const relatedPosts = (id, title = "함께 읽으면 좋은 글") => {
  const list = postsFor(id);
  return list.length ? `
<section class="sec">
  <div class="wrap">
    <h2>${title}</h2>
    <div class="post-grid">${list.map(postCard).join("")}</div>
    <a class="text-link" href="/blog/">블로그 전체 보기 →</a>
  </div>
</section>` : "";
};
const faqHtml = (items) => `<div class="faq">${items.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("")}</div>`;
const faqLd = (items) => ({ "@type": "FAQPage", mainEntity: items.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) });

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
  title: "마이웍스 — 1인 사업자·프리랜서·소규모 팀을 위한 업무관리 플랫폼",
  ogTitle: "마이웍스 — 혼자 하는 일을 끝까지 처리하는 일터",
  desc: "오늘 결정할 것, 일, 거래, 돈, 사람을 한곳에서 관리하는 업무관리 서비스. 견적 승인은 링크 하나로, 근무자에게는 필요한 것만. 매장·공간대여, 건물 임대, 세금, 온라인 판매는 필요한 것만 켭니다. 기본 기능 무료.",
  extra: redirectScript,
  ldNodes: [ORG_LD, SITE_LD, APP_LD],
  body: `
<section class="hero">
  <div class="wrap hero-grid">
    <div class="hero-text">
      <p class="kicker">1인 사업자 · 프리랜서 · 소규모 팀을 위한 업무관리 플랫폼</p>
      <h1>혼자 하는 일을<br>끝까지 처리하는 일터.</h1>
      <p class="lead">오늘 결정할 것, 일, 거래, 돈, 사람을 한곳에 둡니다. 매장·건물·세금·판매는 필요한 것만 켭니다. 함께 일할 사람은 역할에 맞게 부르고, 고객은 계정 없이 링크 하나로 승인합니다.</p>
      <div class="cta">
        <a class="btn primary" href="/start">무료로 시작하기</a>
        <a class="btn" href="/guide">어떻게 쓰는지 보기</a>
      </div>
      <p class="muted small">카드 등록 없이 가입하면 바로 열립니다. 지금은 무료 공개 기간이라 기본 기능과 확장판(마이스토어·마이셀러)을 모두 무료로 씁니다.</p>
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
    <p class="kicker">이런 분들이 씁니다</p>
    <h2>혼자서, 또는 몇 명이서 여러 일을 굴리는 분</h2>
    <div class="who-grid">
      <a class="who" href="/store"><b>공간대여·파티룸 운영자</b><p>예약이 들어오면 청소 일정이 생기고, 근무자는 폰으로 체크리스트를 냅니다.</p><span class="more">마이스토어 →</span></a>
      <a class="who" href="/features#deal"><b>프리랜서·외주 수주</b><p>견적은 링크로 승인받고, 납품·청구·입금까지 한 줄로 이어집니다.</p><span class="more">거래 기능 →</span></a>
      <a class="who" href="/seller"><b>1인 온라인 셀러</b><p>채널별 주문 엑셀을 올리면 한 표로 모이고, 발송하면 재고가 빠집니다.</p><span class="more">마이셀러 →</span></a>
      <a class="who" href="/features#work"><b>작은 팀의 대표</b><p>맡기고, 검수 요청을 받고, 승인으로 끝냅니다. 협력사에게는 맡은 일만 보입니다.</p><span class="more">일 기능 →</span></a>
      <a class="who" href="/building"><b>작은 건물 임대인</b><p>계약 만기, 월세 입금, 법정 점검을 달력과 알림으로 챙깁니다. 2027년 1분기 예정.</p><span class="more">마이빌딩 →</span></a>
      <a class="who" href="/tax"><b>세금 준비가 버거운 사장님</b><p>매출·비용 구조와 현금 흐름을 보고, 신고 자료와 세금 일정을 평소에 맞춰 둡니다.</p><span class="more">마이택스 →</span></a>
    </div>
  </div>
</section>

<section class="sec">
  <div class="wrap">
    <p class="kicker">확장판</p>
    <h2>필요한 것만 켭니다</h2>
    <p class="lead">매장을 보면서 건물도 관리하고, 온라인으로도 파는 사람이 많습니다. 그래서 확장판은 앱이 아니라 스위치입니다. 켜면 메뉴에 나타나고, 끄면 메뉴만 사라지고 데이터는 남습니다.</p>
    <div class="svc-grid">${SVC.map((s) => svcCard(s)).join("")}</div>
  </div>
</section>

<section class="sec alt">
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

<section class="sec">
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

<section class="sec alt">
  <div class="wrap">
    <p class="kicker">가격</p>
    <h2>지금은 모두 무료입니다</h2>
    <p class="lead">무료 공개 기간에는 기본 기능과 확장판을 제한 없이 씁니다. 결제를 시작하기 전에 앱 공지로 먼저 알리고, 그때도 데이터는 그대로 남습니다. 아래는 결제를 시작한 뒤의 예정 요금입니다.</p>
    <div class="price-row">
      <div class="price-cell"><b>베이직</b><div class="p">0원</div><p class="muted small">기본 기능 전부. 브랜드 2개, 좌석 2명</p></div>
      <div class="price-cell"><b>프로</b><div class="p">월 12,000원</div><p class="muted small">좌석 5명, 브랜드 무제한, AI 쓰기, 알림</p></div>
      <div class="price-cell"><b>확장판</b><div class="p">월 9,900~19,000원</div><p class="muted small">서비스마다. 2개 이상이면 10% 할인</p></div>
      <div class="price-cell"><b>올인원</b><div class="p">월 49,000원</div><p class="muted small">프로 + 서비스 4개 전부</p></div>
    </div>
    <p class="muted small">예정 요금은 정식 결제를 시작할 때 확정합니다. 비공개 베타 참여자에게 약속한 1년 가격 고정은 그대로 지킵니다. 근무자·파트너·전문가 초대와 확인 링크 상대방은 요금이 없습니다.</p>
    <a class="text-link" href="/pricing">전체 가격표와 계산기 →</a>
  </div>
</section>

<section class="sec">
  <div class="wrap">
    <p class="kicker">블로그</p>
    <h2>혼자 일하는 사람을 위한 업무 노트</h2>
    <p class="lead">매장과 공간 운영, 외주 거래, 세금, 온라인 판매처럼 혼자 챙겨야 하는 일을 실무 순서대로 정리합니다.</p>
    <div class="post-grid">${["solo-business-work-management", "party-room-operation-checklist", "freelancer-quote-approval"].map((sl) => postCard(ARTICLES.find((a) => a.slug === sl))).join("")}</div>
    <a class="text-link" href="/blog/">글 ${ARTICLES.length}편 모두 보기 →</a>
  </div>
</section>

<section class="sec alt">
  <div class="wrap two start">
    <div>
      <p class="kicker">자주 묻는 질문</p>
      <h2>시작하기 전에 많이 묻는 것</h2>
      <p>마이웍스는 10년 넘게 340개가 넘는 공간을 기획·운영해 온 ㈜블랭크가 직접 쓰려고 만든 도구입니다.</p>
      <a class="text-link" href="/about">만든 이유와 원칙 →</a><br>
      <a class="text-link" href="/faq">자주 묻는 질문 전체 →</a>
    </div>
    ${faqHtml([FAQ[0][1][0], faqQ("고객이나 거래처도 가입해야 하나요?"), FAQ[2][1][0], FAQ[3][1][1], FAQ[4][1][1]])}
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
    title: `${s.seoTitle} | 마이웍스`, ogTitle: `${s.name} — ${s.one}`,
    desc: s.seoDesc,
    crumbs: [[s.name, `/${s.id}`]],
    body: `
<section class="hero sub" style="--svc:${s.color}">
  <div class="wrap">
    <p class="kicker"><i class="dot" style="background:${s.color}"></i>마이웍스 확장판 ${statusChip(s)}</p>
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
      ${s.price ? `<p class="price-line">${esc(s.price)}</p>
      <p class="muted small">결제를 시작한 뒤의 예정 요금입니다. 지금은 무료 공개 기간이라 결제 없이 씁니다. 2개 이상 켜면 각 10% 할인, 프로와 서비스 4개를 전부 켜면 월 49,000원입니다. 결제를 시작하기 전에 앱 공지로 먼저 알리고, 끄면 데이터는 남습니다.</p>` : `<p class="price-line">무료 공개 기간 동안 무료</p>
      <p class="muted small">정식 요금은 아직 정하지 않았습니다. 정하면 결제를 시작하기 전에 앱 공지로 먼저 알리고, 끄면 데이터는 남습니다.</p>`}
      <a class="text-link" href="/pricing">전체 가격표 →</a>
    </div>
  </div>
</section>
${relatedPosts(s.id, `${s.name}와 관련된 글`)}
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
// 답은 이용약관(제9·10·16조)과 같아야 한다.
const PRICE_FAQ = [
  ["지금 돈을 내야 하나요?", "아닙니다. 지금은 무료 공개 기간이라 기본 기능과 확장판(마이스토어·마이셀러)을 모두 무료로 씁니다. 카드 등록도 받지 않습니다. 결제를 시작하기 전에 앱 공지로 먼저 알립니다."],
  ["유료로 바뀌면 어떻게 되나요?", "결제하지 않은 워크스페이스는 베이직 규칙으로 돌아갑니다. 데이터는 그대로 남고, 확장판 메뉴만 사라집니다. 결제하면 그대로 다시 보입니다."],
  ["서비스를 끄면 데이터는요?", "남습니다. 전체 백업에도 포함되고, 언제든 백업 파일(JSON)로 내려받을 수 있습니다. 재무와 주문은 CSV로도 내보냅니다."],
  ["근무자나 세무사도 요금을 내나요?", "아닙니다. 현장 근무자·파트너·전문가(세무사·관리업체·중개사)는 무료 게스트입니다. 돈을 받는 좌석은 관리자·직원뿐입니다."],
  ["고객이 확인 링크를 열 때 비용이 드나요?", "아닙니다. 상대방은 계정도, 요금도 없습니다."],
  ["거래 수수료가 있나요?", "없습니다. 월 이용료만 받습니다. 플랫폼 수수료 위에 또 하나의 %를 더하지 않습니다."],
  ["세금계산서를 받을 수 있나요?", "결제가 시작되면 요청하시는 대로 세금계산서나 현금영수증을 발행합니다."],
  ["해지와 환불은 어떻게 하나요?", "앱의 ‘문의’나 이메일로 언제든 해지를 요청할 수 있습니다. 결제 후 7일 안에 유료 기능을 쓰지 않았다면 전액 환불하고, 월 결제는 다음 결제일부터 청구하지 않습니다. 연 결제는 쓴 개월 수를 월 정가로 빼고 남은 금액을 돌려드립니다."],
];
page({
  file: "pricing.html", active: "pricing",
  title: "가격 — 지금은 모두 무료 | 마이웍스", desc: "마이웍스는 무료 공개 기간입니다. 기본 기능과 확장판(마이스토어·마이셀러)을 모두 무료로 씁니다. 결제 시작 뒤의 예정 요금과 계산기도 함께 확인할 수 있습니다.",
  crumbs: [["가격", "/pricing"]],
  ldNodes: [APP_LD, faqLd(PRICE_FAQ)],
  body: `
<section class="hero sub">
  <div class="wrap">
    <p class="kicker">가격</p>
    <h1>지금은 모두 무료입니다</h1>
    <p class="lead">무료 공개 기간에는 기본 기능과 확장판을 제한 없이 씁니다. 아래는 결제를 시작한 뒤의 예정 요금입니다. 정식 요금은 결제를 시작할 때 확정하고, 시작하기 전에 앱 공지로 먼저 알립니다.</p>
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
          ${SVC.filter((s) => PRICING.svc[s.id]).map((s) => `<tr><td><i class="dot" style="background:${s.color}"></i><b>${s.name}</b></td><td class="num">${won(PRICING.svc[s.id])}</td><td data-label="포함">${esc(s.price.replace(/^월 [\d,]+원 · /, ""))}</td></tr>`).join("")}
          ${SVC.filter((s) => !PRICING.svc[s.id]).map((s) => `<tr><td><i class="dot" style="background:${s.color}"></i><b>${s.name}</b></td><td class="num">미정</td><td data-label="포함">무료 공개 기간에는 무료. 정식 요금은 정한 뒤 앱 공지로 먼저 알립니다</td></tr>`).join("")}
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
        ${SVC.filter((s) => PRICING.svc[s.id]).map((s) => `<label class="row"><input type="checkbox" class="c-svc" data-id="${s.id}" data-price="${PRICING.svc[s.id]}"> <i class="dot" style="background:${s.color}"></i><b>${s.name}</b> <span class="muted">${won(PRICING.svc[s.id])}</span></label>`).join("")}
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
    ${faqHtml(PRICE_FAQ)}
    <a class="text-link" href="/faq">자주 묻는 질문 전체 →</a>
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
    title: "가이드 — 마이웍스 사용 안내", desc: "마이웍스 사용 안내. 가입과 승인, 베이직·프로 등급, 오늘 결정할 것, 구성원과 연락처, 공간 운영(스페이스), 외주 관리(아웃소싱), 상품 판매(커머스), 확인 링크, AI 접속, 데이터 백업을 설명합니다.",
    crumbs: [["가이드", "/guide"]],
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
  file: "notice.html", active: "notice", lastmod: "2026-11-17",
  title: "공지 — 마이웍스 업데이트 소식", desc: "마이웍스 배포 소식과 바뀐 점을 날짜순으로 남깁니다.",
  crumbs: [["공지", "/notice"]],
  body: `
<section class="hero sub"><div class="wrap"><p class="kicker">공지</p><h1>바뀐 점</h1><p class="lead">배포할 때마다 한 줄씩 남깁니다. 장애가 있으면 맨 위에 적습니다.</p></div></section>
<section class="sec"><div class="wrap doc">
  <div class="notice"><time>2026. 11. 17.</time><h3>마이택스와 마이피플을 열었습니다</h3>
    <p><a href="/tax">마이택스</a>는 돈 메뉴와 각 확장판의 기록을 모아 손익과 현금 흐름을 보여 줍니다. 매출원가·수수료·인건비 같은 손익 항목을 내 사업에 맞게 직접 정할 수 있고, 월·분기·연 단위 KPI 목표를 세워 달성률을 기간별로 확인합니다. 사업자가 여러 개라면 브랜드·매장·확장판별로 어느 사업자의 돈인지 정해 두면 자동으로 나뉩니다.</p>
    <p>신고 자료 탭에서는 부가세를 홈택스 신고서 칸 그대로, 종합소득세는 과세표준과 세율까지 추정해 보여 줍니다. 내 계좌끼리 옮긴 돈, 보증금, 빌린 돈처럼 사업과 무관한 돈은 사유를 남기고 신고 자료에서 뺄 수 있습니다. 실제 사업 매출을 빼면 과소신고가 되므로, 카드·현금영수증·세금계산서처럼 국세청에 이미 자료가 있는 매출은 뺄 때 한 번 더 확인합니다. 홈택스에서 받은 세금계산서·현금영수증·카드 내역 파일을 올리면 돈 기록과 자동으로 맞추고, 세금 달력은 휴대폰 일정으로 내보낼 수 있습니다. 세금 숫자는 모두 참고용 추정이며, 신고는 홈택스나 세무사를 통해 합니다.</p>
    <p><a href="/people">마이피플</a>은 ‘사람’ 메뉴를 넓힌 것입니다. 연락처마다 별점과 협업 이력, 레퍼런스, 명함 사진을 남길 수 있고, 아르바이트·직원·건당 근무자의 근무표와 휴대폰 출퇴근, 급여 계산(주휴수당, 4대보험·3.3%·일용직 원천징수 포함), 임금명세서 링크, 근로계약서 인쇄를 지원합니다. 급여와 임금 정보는 워크스페이스 관리자만 봅니다. 두 확장판 모두 확장판 메뉴에서 켜면 바로 쓸 수 있고, 무료 공개 기간에는 무료입니다.</p></div>
  <div class="notice"><time>2026. 11. 17.</time><h3>지금은 모두 무료입니다 — 마이스토어·마이셀러를 정식으로 열었습니다</h3>
    <p>결제를 시작하기 전까지 무료 공개 기간으로 운영합니다. 기본 기능과 확장판(마이스토어·마이셀러)을 제한 없이 쓸 수 있고, 카드 등록도 받지 않습니다. 결제를 시작하기 전에는 앱 공지로 먼저 알립니다.</p>
    <p><a href="/store">마이스토어</a>는 음식·카페, 소매·무인매장, 예약형 매장, 공간대여·숙박 네 업종을 지원합니다. 업종을 고르면 오픈·마감 점검 항목이 준비되고, 근무자는 휴대폰으로 점검과 일 마감(결제수단별 매출·시재)을 제출합니다. 담당자별 시간 예약, 소모품 부족 알림, 리뷰·문의 기록도 함께 넣었습니다.</p>
    <p><a href="/seller">마이셀러</a>에는 송장 일괄 처리(택배 접수 파일 → 송장 파일 올리기 → 채널별 송장 등록 파일), 옵션별 재고와 움직임 기록, 공급처 발주서와 확인 링크, 입고, 반품·교환, 상품별 손익과 정산 대사를 더했습니다. 앱 메뉴 이름도 ‘스페이스’는 ‘마이스토어’, ‘커머스’는 ‘마이셀러’, ‘아웃소싱’은 ‘거래’로 바꿨고, 수입·지출을 모아 보는 ‘돈’ 메뉴와 확장판을 켜고 끄는 ‘확장판’ 메뉴를 새로 만들었습니다.</p></div>
  <div class="notice"><time>2026. 11. 17.</time><h3>연락처 가져오기, 사람마다 초대 링크, 진행 상황 공유를 추가했습니다</h3>
    <p>사람 → 연락처에서 구글 연락처·아이폰·안드로이드·네이버·엑셀 파일을 올리면 연락처를 한 번에 옮길 수 있습니다. 파일은 브라우저 안에서만 읽고, 고른 사람만 저장합니다.</p>
    <p>‘사람 초대’에서 연락처를 고르면 사람마다 다른 초대 링크가 만들어집니다. 카카오톡·문자·메일로 보내면 받은 사람이 아이디를 만들고 승인 없이 바로 프로젝트에 참여합니다. 프로젝트 화면의 ‘진행 상황 공유’로는 고객에게 진행률과 업무 목록을 로그인 없이 보여 줄 수 있습니다. 함께 일하는 분께 마이웍스를 소개할 수 있는 소개 링크도 사람 메뉴에 넣었습니다.</p></div>
  <div class="notice"><time>2026. 11. 16.</time><h3>블로그·자주 묻는 질문·기본 기능·회사 소개 페이지를 열었습니다</h3>
    <p><a href="/blog/">블로그</a>에 파티룸·무인매장 운영, 견적서와 미수금, 세금 일정, 임대관리, 온라인 판매, AI 연결에 관한 글 ${ARTICLES.length}편을 올렸습니다. <a href="/features">기본 기능</a> 페이지에서 오늘·일·거래·돈·사람 메뉴를 한 번에 볼 수 있고, <a href="/faq">자주 묻는 질문</a>에 가입·요금·데이터·AI 연결에 관한 답을 모았습니다. 마이웍스를 만드는 회사는 <a href="/about">회사 소개</a>에 적었습니다.</p>
    <p>네이버·구글·Bing 검색에 사이트를 등록하고, 새 글을 받아 볼 수 있는 <a href="/rss.xml">RSS</a>를 추가했습니다. 가격 페이지의 해지·환불 안내를 이용약관과 같은 내용으로 맞췄습니다. 앱과 데이터에는 바뀐 것이 없습니다.</p></div>
  <div class="notice"><time>2026. 11. 2.</time><h3>새 주소 myworks.ai.kr, 이용약관·개인정보처리방침 확정</h3>
    <p>마이웍스의 주소가 <b>myworks.ai.kr</b>로 바뀌었습니다. 예전 주소(myworkspro.pages.dev)나 www를 붙인 주소로 들어와도 새 주소로 자동으로 옮겨집니다. 브라우저가 주소별로 로그인을 따로 기억하기 때문에 새 주소에서 한 번 다시 로그인해 주세요. 데이터는 그대로입니다. 클로드 같은 AI를 MCP로 연결해 두셨다면 예전 주소도 계속 동작하지만, 연동·데이터 → AI 접속에 나오는 새 주소로 바꿔 두시길 권합니다.</p>
    <p><a href="/terms">이용약관</a>과 <a href="/privacy">개인정보처리방침</a>을 확정했습니다. 개인정보처리방침은 오늘부터, 이용약관은 11월 9일부터 시행합니다. 처리방침에는 데이터를 보관하는 Cloudflare(미국 본사, 데이터베이스는 아시아·태평양 지역)로의 국외 이전 항목·국가·시기·방법·기간과 거부 방법을 적었습니다. 홈페이지 아래에 사업자 정보를 표시했고, 가입 화면에 약관 동의 칸을 추가했습니다.</p></div>
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
  title: "시작하기 — 마이웍스 무료 가입 안내", desc: "마이웍스 가입 안내. 카드 등록 없이 회원가입하면 바로 워크스페이스가 열립니다. 무료 공개 기간에는 기본 기능과 확장판을 모두 무료로 씁니다.",
  crumbs: [["시작하기", "/start"]],
  body: `
<section class="hero sub"><div class="wrap"><p class="kicker">시작하기</p><h1>세 단계면 됩니다</h1><p class="lead">카드 등록 없이 시작합니다. 가입하면 바로 워크스페이스가 열리고, 무료 공개 기간에는 모든 기능을 무료로 씁니다.</p></div></section>
<section class="sec"><div class="wrap">
  <ol class="steps">
    <li><div><b>회원가입</b><p>아래 ‘회원가입 하러 가기’를 누르면 가입 화면이 바로 열립니다. 워크스페이스 이름, 이름, 아이디, 비밀번호, 연락처를 적습니다. 사업자 정보는 묻지 않습니다.</p></div></li>
    <li><div><b>바로 시작</b><p>가입하면 워크스페이스가 바로 열립니다. 어느 기기에서든 같은 아이디로 로그인할 수 있습니다. 매장이나 온라인 판매를 한다면 왼쪽 메뉴의 ‘확장판’에서 마이스토어·마이셀러를 켭니다.</p></div></li>
    <li><div><b>첫 데이터</b><p>프로젝트 하나, 매장 하나, 또는 거래처 하나만 넣어 보세요. ‘오늘’ 화면이 채워지기 시작합니다. 쓰다가 막히면 앱의 ‘문의’로 알려 주세요.</p></div></li>
  </ol>
  <div class="cta"><a class="btn primary" href="/app/#signup">회원가입 하러 가기</a><a class="btn" href="/app/">이미 계정이 있어요</a></div>
  <p class="muted small"><a class="text-link" href="/guide#이용-흐름">이용 흐름 자세히 →</a></p>
  <p class="muted small">팀원으로 합류하려면 관리자가 보낸 초대 링크를 여세요. 초대 링크 없이 가입하면 새 워크스페이스가 만들어집니다.</p>
</div></section>`,
});

// ---------- 약관 · 개인정보 ----------
// 표: 폰에서는 행마다 카드로 쌓입니다 (가이드 표와 같은 방식)
function ltable(heads, rows) {
  const two = heads.length <= 2;
  return `<div class="table-wrap stack-wrap"><table class="stack${two ? " two-col" : ""}"><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td data-label="${esc(heads[i])}">${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
const TERMS_ON = { posted: "2026년 11월 2일", from: "2026년 11월 9일" };
const PRIVACY_ON = { posted: "2026년 11월 2일", from: "2026년 11월 2일" };

page({
  file: "terms.html", active: "",
  title: "이용약관 — 마이웍스", desc: "마이웍스 서비스 이용약관.",
  crumbs: [["이용약관", "/terms"]], priority: "0.3",
  body: `
<section class="hero sub"><div class="wrap"><p class="kicker">이용약관</p><h1>마이웍스 이용약관</h1><p class="lead">공고일 ${TERMS_ON.posted} · 시행일 ${TERMS_ON.from}</p></div></section>
<section class="sec"><div class="wrap doc legal">
<h2>제1조 (목적)</h2>
<p>이 약관은 ${BIZ.name}(이하 “회사”)가 운영하는 마이웍스(${BIZ.host}, 이하 “서비스”)를 이용하는 조건과 절차, 회사와 이용자의 권리·의무와 책임을 정합니다.</p>

<h2>제2조 (용어)</h2>
<ol>
<li>“이용자”는 이 약관에 따라 계정을 만들어 서비스를 쓰는 사람입니다.</li>
<li>“워크스페이스”는 이용자가 개설해 데이터를 보관하고 구성원을 초대하는 단위입니다. 워크스페이스끼리는 데이터가 분리되어 서로 보이지 않습니다.</li>
<li>“워크스페이스 관리자”는 워크스페이스를 개설했거나 관리자 역할을 받은 이용자, “구성원”은 관리자가 초대·승인해 함께 쓰는 이용자(직원·현장 근무자·시설 담당·협력사 등)입니다.</li>
<li>“이용자 데이터”는 이용자가 서비스에 입력하거나 올린 업무·일정·거래·재무·연락처·예약·주문 정보 등 모든 데이터입니다.</li>
<li>“상대방”은 계정 없이 확인 링크로 견적·납품·청구 내용을 확인하고 응답하는 고객·거래처 등입니다.</li>
<li>“유료 서비스”는 프로 등급, 분야 서비스(모듈), 추가 좌석처럼 요금을 내고 쓰는 기능입니다.</li>
</ol>

<h2>제3조 (약관의 게시와 변경)</h2>
<ol>
<li>회사는 이 약관을 홈페이지 첫 화면 아래와 가입 화면에서 볼 수 있게 둡니다.</li>
<li>회사는 관련 법령을 어기지 않는 범위에서 약관을 바꿀 수 있습니다. 바꿀 때는 바뀌는 내용과 시행일을 시행 7일 전부터 홈페이지 공지와 앱 공지로 알리고, 이용자에게 불리한 변경은 30일 전부터 알리며 등록된 연락처로도 따로 알립니다.</li>
<li>이용자는 바뀐 약관에 동의하지 않으면 시행일 전까지 이용계약을 해지할 수 있습니다. 회사가 “시행일까지 거부 의사를 밝히지 않으면 동의한 것으로 본다”는 뜻을 함께 알렸는데도 이용자가 거부 의사를 밝히지 않으면 바뀐 약관에 동의한 것으로 봅니다.</li>
</ol>

<h2>제4조 (이용계약의 성립)</h2>
<ol>
<li>이용계약은 가입하려는 사람이 이 약관에 동의하고 가입을 신청한 뒤 회사가 승인하면 성립합니다. 회사가 발급한 베타 코드를 넣었거나 회사가 가입 방식을 ‘자동 개설’로 정한 기간에는 신청과 동시에 승인한 것으로 봅니다.</li>
<li>초대 링크로 기존 워크스페이스에 합류하는 경우에는 그 워크스페이스 관리자의 승인으로 이용계약이 성립합니다.</li>
<li>회사는 다음에 해당하는 신청은 승인하지 않거나 나중에 이용계약을 해지할 수 있습니다.
<ul><li>다른 사람의 이름·연락처를 쓰거나 내용을 사실과 다르게 적은 경우</li><li>만 14세 미만인 경우</li><li>이 약관 위반으로 이용이 제한된 적이 있는 사람이 다시 신청한 경우</li><li>서비스 운영에 필요한 설비에 여유가 없거나 기술상 제공이 어려운 경우(이때는 승인을 미룰 수 있습니다)</li></ul></li>
</ol>

<h2>제5조 (계정 관리)</h2>
<ol>
<li>이용자는 아이디와 비밀번호를 스스로 관리하며, 다른 사람에게 넘기거나 빌려주지 않습니다.</li>
<li>계정이 도용되었거나 그럴 염려가 있으면 바로 비밀번호를 바꾸고 회사나 워크스페이스 관리자에게 알립니다.</li>
<li>워크스페이스 관리자는 구성원의 계정 발급·역할·비활성화·삭제를 관리하며, 퇴사·계약 종료 등으로 권한이 필요 없어진 구성원의 접근을 바로 막을 책임이 있습니다.</li>
</ol>

<h2>제6조 (서비스의 내용)</h2>
<ol>
<li>회사는 다음 기능을 웹으로 제공합니다. 오늘 할 일과 결정할 것, 플랜, 프로젝트·매장·업무 관리, 사람(구성원·연락처) 관리, 재무 기록, 확인 링크, AI 접속(토큰·MCP), 데이터 가져오기·내보내기, 그리고 프로 등급에서 켜는 분야 서비스(스페이스·아웃소싱·커머스 등).</li>
<li>등급별로 쓸 수 있는 기능과 한도는 가격 페이지(${BIZ.host}/pricing)에 게시합니다.</li>
</ol>

<h2>제7조 (베타 서비스)</h2>
<ol>
<li>회사는 정식 오픈 전 일정 기간 동안 베타로 서비스를 제공할 수 있습니다. 베타 기간에는 요금을 받지 않거나 할인할 수 있고, 기능·화면·이름이 자주 바뀔 수 있습니다.</li>
<li>회사는 베타 기간에도 이용자 데이터를 보존하고 내려받을 수 있게 합니다. 기능을 없앨 때는 그 기능의 데이터를 내려받을 수 있게 미리 알립니다.</li>
<li>베타 참여자에게 약속한 혜택(가격 고정 등)은 약속한 기간 동안 지킵니다.</li>
</ol>

<h2>제8조 (서비스의 변경과 중단)</h2>
<ol>
<li>회사는 더 나은 서비스를 위해 기능을 바꾸거나 추가할 수 있습니다. 이용자의 이용에 큰 영향을 주는 변경은 7일 전에 공지합니다.</li>
<li>회사는 설비 점검·교체, 장애, 회사가 이용하는 클라우드(Cloudflare 등)의 장애, 천재지변처럼 어쩔 수 없는 사유가 있으면 서비스를 일시 중단할 수 있습니다. 미리 알 수 있는 중단은 미리 공지하고, 갑작스러운 중단은 끝난 뒤 알립니다.</li>
<li>회사가 서비스 전체를 종료할 때는 30일 전에 공지하고, 그 기간 동안 이용자가 데이터를 내려받을 수 있게 합니다. 유료 서비스의 남은 기간 요금은 돌려드립니다.</li>
</ol>

<h2>제9조 (요금과 결제)</h2>
<ol>
<li>베이직 등급은 무료입니다. 유료 서비스의 요금, 결제 주기, 결제 방법은 가격 페이지와 결제 화면에 게시합니다.</li>
<li>회사는 요금을 바꿀 때 시행 30일 전에 공지합니다. 이미 결제한 기간에는 바뀐 요금을 적용하지 않습니다.</li>
<li>결제가 확인되면 회사는 결제한 이용 기간만큼 유료 서비스를 제공하고, 요청하면 세금계산서나 현금영수증을 발행합니다.</li>
<li>이용 기간이 끝나고 결제가 이어지지 않으면 워크스페이스는 베이직 규칙으로 돌아갑니다. 이때도 데이터는 지우지 않으며, 다시 결제하면 그대로 이어서 씁니다.</li>
</ol>

<h2>제10조 (청약철회·해지·환불)</h2>
<ol>
<li>이용자는 결제한 날부터 7일 안에 유료 기능을 쓰지 않았다면 청약을 철회하고 전액 환불받을 수 있습니다.</li>
<li>월 단위 결제는 언제든 해지할 수 있습니다. 해지하면 다음 결제일부터 요금을 청구하지 않으며, 이미 결제한 달은 그 달이 끝날 때까지 씁니다.</li>
<li>연 단위 결제를 중간에 해지하면, 결제 금액에서 이미 쓴 개월 수만큼을 월 단위 정가로 계산해 빼고 남은 금액을 돌려드립니다. 한 달을 다 쓰지 않았어도 시작한 달은 쓴 것으로 봅니다.</li>
<li>회사 잘못으로 유료 서비스를 연속 4시간 이상 쓰지 못했거나 한 달에 합쳐 12시간 이상 쓰지 못했다면, 이용자가 요청하는 대로 그 시간의 세 배만큼 이용 기간을 늘리거나 그에 해당하는 요금을 돌려드립니다.</li>
<li>환불은 요청을 받은 날부터 3영업일 안에 처리하며, 결제한 수단으로 돌려드리는 것을 원칙으로 합니다.</li>
</ol>

<h2>제11조 (이용자 데이터)</h2>
<ol>
<li>이용자 데이터는 그 워크스페이스의 것입니다. 회사는 서비스 제공, 장애 대응, 이용자의 요청 처리, 법령상 의무 이행 외의 목적으로 이용자 데이터를 열람·이용·제공하지 않습니다.</li>
<li>회사의 운영 화면(총괄관리)에서도 워크스페이스의 업무 내용은 보이지 않으며, 계정 목록과 기록의 개수만 보입니다.</li>
<li>회사는 이용자 데이터를 인공지능 모델 학습에 쓰거나 다른 회사에 학습용으로 제공하지 않습니다.</li>
<li>이용자 데이터에 들어 있는 고객·거래처·예약자·주문 수령인·근무자 등 다른 사람의 개인정보는 그 워크스페이스를 운영하는 이용자(사업자)가 개인정보처리자이고, 회사는 그 처리를 위탁받은 수탁자입니다. 이용자는 이런 정보를 법령에 맞게 수집하고 필요한 고지·동의를 거쳐 입력해야 합니다. 회사는 수탁자로서 위탁받은 목적 밖에서 그 정보를 쓰지 않고, 개인정보처리방침에 적은 보호조치와 재위탁(국외 이전 포함)의 범위를 지킵니다.</li>
<li>워크스페이스 관리자는 언제든 연동·데이터 메뉴에서 이용자 데이터 전체를 파일로 내려받을 수 있습니다.</li>
</ol>

<h2>제12조 (확인 링크와 상대방)</h2>
<ol>
<li>이용자는 확인 링크로 상대방에게 견적·납품·청구 내용을 보여 주고 승인·수정 요청·확인을 받을 수 있습니다. 링크를 받은 사람은 계정 없이 그 내용을 볼 수 있으므로, 링크를 누구에게 보낼지는 이용자가 정하고 책임집니다.</li>
<li>확인 링크는 이용자가 정한 기간이 지나면 열리지 않습니다.</li>
</ol>

<h2>제13조 (외부 AI 연결)</h2>
<ol>
<li>이용자는 AI 접속 메뉴에서 토큰을 발급해 외부 AI 서비스(예: Claude)가 이용자 데이터를 읽거나 업무를 제안하게 할 수 있습니다. 쓰기 권한 토큰의 제안은 이용자가 승인해야 반영됩니다.</li>
<li>토큰으로 외부 AI 서비스에 전달된 데이터는 그 서비스의 약관과 개인정보 정책에 따라 처리됩니다. 토큰을 어떤 서비스에 연결할지는 이용자가 정하며, 필요 없어진 토큰은 이용자가 바로 회수해야 합니다.</li>
</ol>

<h2>제14조 (이용자의 의무와 금지 행위)</h2>
<p>이용자는 다음 행위를 하지 않습니다.</p>
<ul>
<li>다른 사람의 계정이나 개인정보를 몰래 쓰는 행위</li>
<li>법령에 어긋나거나 다른 사람의 권리를 침해하는 정보를 입력·전송하는 행위</li>
<li>받는 사람이 동의하지 않은 광고성 정보를 확인 링크 등으로 보내는 행위</li>
<li>서비스를 역설계하거나, 자동화 도구로 과도하게 요청해 운영을 방해하거나, 보안 장치를 우회하는 행위</li>
<li>서비스를 그대로 복제·재판매하거나 회사의 허락 없이 영리 목적으로 제공하는 행위</li>
</ul>

<h2>제15조 (이용 제한)</h2>
<ol>
<li>회사는 이용자가 제14조를 어기면 경고, 일시 이용 중지, 이용계약 해지 순으로 이용을 제한할 수 있습니다. 위반이 무겁거나 다른 이용자에게 피해가 번질 염려가 있으면 바로 중지할 수 있습니다.</li>
<li>회사는 이용을 제한하기 전에 사유와 기간을 알리고 이의를 말할 기회를 줍니다. 급한 경우에는 제한한 뒤 바로 알립니다.</li>
</ol>

<h2>제16조 (해지와 데이터 삭제)</h2>
<ol>
<li>워크스페이스 관리자는 언제든 앱의 ‘문의’나 이메일(${BIZ.email})로 워크스페이스 해지를 요청할 수 있습니다. 구성원은 소속 워크스페이스 관리자에게 계정 삭제를 요청하며, 관리자가 응하지 않으면 회사에 직접 요청할 수 있습니다.</li>
<li>회사는 해지 요청을 받으면 본인 확인 뒤 데이터를 내려받을 기회를 안내하고, 요청한 날부터 7일 안에 워크스페이스의 계정과 이용자 데이터를 삭제합니다. 바로 삭제를 원하면 그렇게 합니다. 삭제한 데이터는 되살릴 수 없습니다.</li>
<li>장애 복구용 시점 사본에 남은 데이터는 최대 30일 안에 자동으로 지워집니다. 법령에 따라 보관해야 하는 결제·세금계산서·분쟁 처리 기록은 개인정보처리방침에 적은 기간 동안 따로 보관합니다.</li>
</ol>

<h2>제17조 (회사의 의무)</h2>
<ol>
<li>회사는 서비스를 안정적으로 제공하고, 장애가 생기면 지체 없이 복구합니다.</li>
<li>회사는 개인정보처리방침에 따라 이용자의 개인정보를 보호합니다.</li>
<li>회사는 이용자의 문의와 불만을 영업일 기준 2일 안에 답하고, 처리에 시간이 걸리면 그 사유와 일정을 알립니다.</li>
</ol>

<h2>제18조 (손해배상과 책임의 범위)</h2>
<ol>
<li>회사나 이용자가 이 약관을 어겨 상대에게 손해를 끼치면 그 손해를 배상합니다.</li>
<li>회사는 다음의 경우 책임지지 않습니다. 다만 회사의 고의 또는 중대한 과실이 있으면 그렇지 않습니다.
<ul><li>천재지변이나 이에 준하는 사유, 회사가 통제할 수 없는 통신·클라우드 사업자의 장애로 서비스를 제공하지 못한 경우</li><li>이용자의 계정 관리 소홀이나 이용자가 연결한 외부 서비스 때문에 생긴 손해</li><li>무료로 제공하는 기능을 쓰다 생긴 손해</li></ul></li>
<li>서비스가 보여 주는 예상 세금·일정·법령 안내는 참고용 추정치이며 세무 신고·대리·상담이나 법률 자문이 아닙니다. 세무와 법률 판단은 이용자와 이용자가 정한 전문가가 합니다.</li>
</ol>

<h2>제19조 (알림)</h2>
<p>회사는 이용자에게 알릴 일이 있으면 앱 공지, 홈페이지 공지, 가입 때 적은 연락처 중 알맞은 방법을 씁니다. 모든 이용자에게 알릴 일은 7일 이상 홈페이지에 공지하는 것으로 개별 알림을 갈음할 수 있습니다. 다만 이용자에게 중대한 영향이 있는 일은 개별로 알립니다.</p>

<h2>제20조 (분쟁 해결)</h2>
<ol>
<li>회사와 이용자는 분쟁이 생기면 먼저 성실히 협의합니다.</li>
<li>이 약관은 대한민국 법을 따르며, 소송이 필요하면 민사소송법에 따른 관할 법원에서 다룹니다.</li>
</ol>

<h2>부칙</h2>
<p>이 약관은 ${TERMS_ON.from}부터 시행합니다. 시행일 전에 가입한 이용자에게도 시행일부터 적용합니다.</p>
<p class="muted small">${BIZ.name} · 대표 ${BIZ.ceo} · ${BIZ.addr} · ${BIZ.tel} · ${BIZ.email}</p>
</div></section>`,
});

page({
  file: "privacy.html", active: "",
  title: "개인정보처리방침 — 마이웍스", desc: "마이웍스 개인정보처리방침 — 처리 항목, 보유 기간, 처리 위탁과 국외 이전, 이용자의 권리.",
  crumbs: [["개인정보처리방침", "/privacy"]], priority: "0.3",
  body: `
<section class="hero sub"><div class="wrap"><p class="kicker">개인정보처리방침</p><h1>마이웍스 개인정보처리방침</h1><p class="lead">공개일 ${PRIVACY_ON.posted} · 시행일 ${PRIVACY_ON.from}</p></div></section>
<section class="sec"><div class="wrap doc legal">
<p>${BIZ.name}(이하 “회사”)는 마이웍스(${BIZ.host}, 이하 “서비스”)를 운영하면서 「개인정보 보호법」에 따라 이용자의 개인정보를 처리합니다. 이 방침은 회사가 어떤 개인정보를 왜, 얼마나 오래 처리하는지, 누구에게 맡기고 어느 나라로 옮기는지, 이용자가 어떻게 권리를 행사하는지 알려 드립니다.</p>
<blockquote><p><b>요약</b> — 회사는 서비스에 꼭 필요한 정보만 받습니다. 데이터는 Cloudflare의 클라우드에 보관되며(국외 이전), 광고나 AI 학습에 쓰지 않고, 다른 회사에 팔거나 넘기지 않습니다. 워크스페이스에 입력한 고객 정보는 그 워크스페이스를 운영하는 사업자의 것이며 회사는 보관과 전송만 맡습니다.</p></blockquote>

<h2>1. 처리하는 개인정보와 목적</h2>
${ltable(["구분", "항목", "목적", "근거"], [
  ["새 워크스페이스 가입", "필수: 워크스페이스 이름, 이름, 아이디, 비밀번호, 연락처(휴대폰 또는 이메일)<br>선택: 가입 목적, 베타 코드", "가입 확인과 승인, 본인 확인, 승인·이용 안내, 계정 관리", "계약 체결·이행 (법 제15조 제1항 제4호)"],
  ["초대받아 합류", "필수: 초대 코드, 이름, 아이디, 비밀번호<br>선택: 연락처", "합류 요청과 승인, 계정 관리", "계약 체결·이행"],
  ["서비스 이용 중 만들어지는 정보", "로그인 일시, 마지막 접속 일시, 로그인 실패 횟수, 로그인 유지 정보(세션), 활동 기록(누가 언제 무엇을 바꿨는지), AI 토큰 이름·사용 일시, 약관 동의 일시", "서비스 제공, 부정 이용 방지, 장애 대응, 분쟁 확인", "계약 이행, 정당한 이익 (제15조 제1항 제6호)"],
  ["문의", "문의 종류·내용, 문의한 화면 위치, 브라우저 정보<br>선택: 연락받을 곳", "문의 확인과 답변, 오류 수정", "계약 이행"],
  ["유료 이용", "입금자명, 입금일, 금액, 결제 방법, 이용 기간<br>세금계산서 발행 시: 상호, 사업자등록번호, 대표자 이름, 세금계산서 받을 이메일", "요금 정산, 세금계산서 발행, 환불", "계약 이행, 법령상 의무 (제15조 제1항 제2호)"],
  ["확인 링크로 응답한 상대방", "응답할 때 적은 이름, 메모, 응답 일시", "견적 승인·수정 요청 등 응답 기록을 이용자에게 전달", "이용자(사업자)의 위탁"],
])}
<p>회사 서버는 접속 IP 주소를 저장하지 않습니다. 다만 서비스가 동작하는 Cloudflare 네트워크가 요청을 전달하고 공격을 막는 과정에서 IP 주소와 브라우저 정보를 처리합니다. 회사는 만 14세 미만 아동의 가입을 받지 않으며, 주민등록번호와 같은 고유식별정보나 민감정보를 요구하지 않습니다.</p>

<h2>2. 이용자가 입력하는 업무 데이터 (위탁받아 처리하는 정보)</h2>
<p>이용자는 워크스페이스에 고객·거래처 연락처, 예약자 이름·연락처, 주문 수령인 이름·전화·주소, 근무자 정보 같은 다른 사람의 개인정보를 입력할 수 있습니다. 이 정보는 워크스페이스를 운영하는 이용자(사업자)가 개인정보처리자이고, 회사는 그 사업자에게서 보관·전송을 위탁받은 수탁자입니다.</p>
<ul>
<li>회사는 이 정보를 위탁받은 목적(서비스 제공) 밖에서 쓰지 않으며, 운영 화면에서도 내용을 볼 수 없게 만들었습니다.</li>
<li>현장 근무자·협력사 같은 구성원 기기로는 역할에 필요한 범위만 전송합니다. 예를 들어 근무자에게는 예약자 연락처·금액이 가지 않습니다.</li>
<li>이 정보의 주인(고객 등)이 열람·정정·삭제를 원하면 해당 사업자에게 요청해 주세요. 회사에 요청이 오면 그 사업자에게 바로 전달하고 처리에 협조합니다.</li>
<li>이 정보도 아래 4번의 국외 이전(Cloudflare 보관)과 3번의 보유 기간 원칙을 따릅니다.</li>
</ul>

<h2>3. 보유 기간과 파기</h2>
${ltable(["정보", "보유 기간"], [
  ["계정 정보", "계정 삭제 또는 워크스페이스 해지 때 지체 없이 파기"],
  ["워크스페이스의 업무 데이터", "해지 요청을 받은 날부터 7일 안에 파기 (바로 삭제를 원하면 즉시)"],
  ["반려된 가입 신청", "신청한 날부터 30일이 지나면 파기"],
  ["로그인 유지 정보(세션)", "로그아웃하거나 30일 동안 쓰지 않으면 파기"],
  ["문의 기록", "처리를 마친 날부터 3년 (「전자상거래 등에서의 소비자보호에 관한 법률」의 소비자 불만·분쟁 처리 기록)"],
  ["결제·환불 기록", "5년 (「전자상거래 등에서의 소비자보호에 관한 법률」의 대금 결제 기록)"],
  ["세금계산서 등 거래 증빙", "5년 (「국세기본법」, 「법인세법」)"],
  ["장애 복구용 시점 사본 (Cloudflare D1)", "최대 30일이 지나면 자동 삭제"],
  ["회사가 보관하는 전체 백업 파일", "만든 날부터 1년 안에 삭제"],
])}
<p>파기할 때는 데이터베이스에서 복구할 수 없게 지우고, 백업 파일은 파일째 삭제합니다. 법령 때문에 보관하는 기록은 다른 정보와 분리해 그 목적으로만 씁니다.</p>

<h2>4. 개인정보의 국외 이전</h2>
<p>회사는 서비스를 클라우드에서 운영하기 때문에 이용자의 개인정보를 해외 사업자의 시설에 보관·처리하도록 맡깁니다. 이는 이용자와 맺은 서비스 계약을 이행하는 데 필요한 처리위탁·보관이므로, 「개인정보 보호법」 제28조의8 제1항 제3호 가목에 따라 아래 사항을 이 방침에 공개하는 것으로 별도 동의를 갈음합니다.</p>
<h3>① Cloudflare, Inc. — 서버·데이터베이스</h3>
${ltable(["항목", "내용"], [
  ["이전받는 자", "Cloudflare, Inc. (101 Townsend St., San Francisco, CA 94107, USA)<br>개인정보 문의: privacyquestions@cloudflare.com"],
  ["이전되는 국가", "미국(본사), 그리고 Cloudflare 데이터센터가 있는 국가. 데이터베이스의 기본 저장 위치는 아시아·태평양 지역이며 정확한 도시는 Cloudflare가 지연 시간을 기준으로 정합니다. 이용자의 요청은 가까운 Cloudflare 데이터센터(대한민국 포함)를 거쳐 전달됩니다."],
  ["이전되는 항목", "1번의 모든 항목, 2번의 업무 데이터, 접속 IP 주소·브라우저 정보(전송·보안 처리)"],
  ["이전 시기와 방법", "서비스를 이용할 때마다 암호화된 통신(HTTPS)으로 전송해 보관"],
  ["이용 목적", "서버와 데이터베이스 운영, 데이터 보관과 장애 복구용 사본, 네트워크 전송, 보안(공격 차단)"],
  ["보유·이용 기간", "3번의 보유 기간과 같습니다. 위탁계약이 끝나면 파기합니다. (장애 복구용 시점 사본은 최대 30일)"],
])}
<h3>② Google LLC — 이메일 문의 수신</h3>
${ltable(["항목", "내용"], [
  ["이전받는 자", "Google LLC (1600 Amphitheatre Parkway, Mountain View, CA 94043, USA)<br>개인정보 문의: googlekrsupport@google.com"],
  ["이전되는 국가", "미국 등 Google 데이터센터가 있는 국가"],
  ["이전되는 항목", `회사 이메일(${BIZ.email})로 보낸 이메일 주소, 이름, 문의 내용`],
  ["이전 시기와 방법", "이용자가 이메일을 보낼 때 정보통신망으로 전송"],
  ["이용 목적", "이메일 문의 접수와 답변"],
  ["보유·이용 기간", "문의 처리를 마친 날부터 3년"],
])}
<h3>③ 국외 이전을 거부하는 방법과 그 효과</h3>
<p>국외 이전을 원하지 않으면 가입하지 않거나, 이미 가입했다면 앱의 ‘문의’나 개인정보 보호책임자 이메일로 계정 삭제(탈퇴)를 요청해 거부할 수 있습니다. 이메일 대신 앱의 ‘문의’를 쓰면 Google로는 이전되지 않습니다. 다만 Cloudflare 보관은 서비스를 제공하는 데 꼭 필요하므로, 이를 거부하면 서비스를 이용할 수 없습니다.</p>

<h2>5. 처리 위탁</h2>
${ltable(["수탁자", "맡기는 업무"], [
  ["Cloudflare, Inc.", "서버·데이터베이스 운영, 데이터 보관, 네트워크 전송과 보안"],
  ["Google LLC", "이메일 문의 수신(Gmail)"],
])}
<p>회사는 위탁계약에서 목적 밖 처리 금지, 안전조치, 재위탁 제한, 관리·감독, 손해배상 책임을 정하고 수탁자가 이를 지키는지 확인합니다. 결제 대행이나 알림톡 발송처럼 새로 위탁하게 되면, 그 기능을 시작하기 전에 이 방침을 고쳐 공지합니다.</p>

<h2>6. 제3자 제공</h2>
<p>회사는 이용자의 개인정보를 제3자에게 제공하지 않습니다. 법령에 특별한 규정이 있거나 수사기관이 법령에 정한 절차에 따라 요구하는 경우는 예외입니다. 이용자가 직접 확인 링크를 보내거나 외부 AI 서비스에 토큰을 연결해 데이터를 넘기는 것은 이용자의 지시에 따른 전송이며, 받는 쪽의 처리는 그 서비스의 정책을 따릅니다.</p>

<h2>7. 인공지능과 자동화된 결정</h2>
<ul>
<li>회사는 인공지능 모델을 직접 운영하지 않으며, 이용자의 데이터를 인공지능 학습에 쓰거나 학습용으로 제공하지 않습니다.</li>
<li>이용자가 AI 접속 메뉴로 연결한 외부 AI(예: Claude)는 이용자가 발급한 토큰의 범위 안에서만 데이터를 읽고, 쓰기 제안은 이용자가 승인해야 반영됩니다.</li>
<li>회사는 개인정보를 이용해 이용자에게 법적 효과나 중대한 영향을 주는 자동화된 결정을 하지 않습니다.</li>
</ul>

<h2>8. 이용자의 권리와 행사 방법</h2>
<ol>
<li>이용자는 언제든 자신의 개인정보를 열람·정정·삭제하거나 처리 정지를 요구할 수 있고, 동의한 처리에 대해서는 동의를 철회할 수 있습니다.</li>
<li>비밀번호는 앱의 설정에서 직접 바꾸고, 이름·연락처 같은 구성원 정보는 워크스페이스 관리자가 사람 메뉴에서 고칩니다. 워크스페이스 관리자는 연동·데이터 메뉴에서 데이터 전체를 내려받을 수 있습니다.</li>
<li>그 밖의 요청은 앱의 ‘문의’, 이메일(${BIZ.email}), 전화(${BIZ.tel})로 하시면 본인 확인 뒤 10일 안에 처리하고 결과를 알려 드립니다. 법령에 따라 요청을 거절하거나 미룰 때는 그 사유와 이의를 제기하는 방법을 함께 알려 드립니다.</li>
<li>법정대리인이나 위임을 받은 사람도 요청할 수 있으며, 이때는 위임장을 내야 합니다.</li>
</ol>

<h2>9. 안전성 확보 조치</h2>
<ul>
<li>관리: 개인정보 보호책임자를 두고, 운영자 계정도 워크스페이스의 업무 내용을 볼 수 없게 했으며, 운영 작업은 기록으로 남깁니다.</li>
<li>기술: 비밀번호와 AI 토큰은 복원할 수 없는 해시(PBKDF2)로만 저장합니다. 모든 통신은 HTTPS로 암호화합니다. 역할마다 서버가 보내는 정보의 범위를 제한합니다. 로그인을 10번 연속 실패하면 10분간 잠그고, 30일 동안 쓰지 않은 로그인은 끝냅니다.</li>
<li>물리: 데이터는 ISO/IEC 27001, SOC 2 인증을 받은 Cloudflare 데이터센터에 보관합니다.</li>
</ul>

<h2>10. 자동 수집 장치</h2>
<p>회사는 쿠키를 쓰지 않고, 광고나 이용 행태 분석을 위한 정보를 모으지 않습니다. 앱은 로그인 유지 정보, 빠른 화면 표시를 위한 데이터 사본, 닫은 공지 목록을 이용자 브라우저의 저장소(localStorage)에 둡니다. 로그아웃하면 지워지며, 브라우저 설정에서 사이트 데이터를 지워도 됩니다(다시 로그인하면 됩니다). 화면 글꼴과 일부 프로그램 파일은 외부 전송망(jsDelivr, Google Fonts, cdnjs)에서 불러오며, 이때 브라우저의 접속 정보가 그 서버에 전달될 수 있습니다. 회사는 이 과정에서 정보를 받지 않습니다.</p>

<h2>11. 개인정보 보호책임자</h2>
${ltable(["구분", "내용"], [
  ["개인정보 보호책임자", `${BIZ.ceo} (대표이사)`],
  ["연락처", `${BIZ.email} · ${BIZ.tel}`],
  ["열람 청구 접수", "앱의 ‘문의’ 또는 위 연락처"],
])}

<h2>12. 권익 침해 구제</h2>
<p>개인정보 침해에 대한 상담이나 구제가 필요하면 아래 기관에 문의할 수 있습니다.</p>
<ul>
<li>개인정보분쟁조정위원회: 1833-6972 (www.kopico.go.kr)</li>
<li>개인정보침해신고센터: 118 (privacy.kisa.or.kr)</li>
<li>대검찰청: 1301 (www.spo.go.kr)</li>
<li>경찰청: 182 (ecrm.police.go.kr)</li>
</ul>

<h2>13. 방침의 변경</h2>
<p>이 방침은 ${PRIVACY_ON.from}부터 시행합니다. 내용을 바꿀 때는 시행 7일 전부터 홈페이지와 앱 공지로 알리고, 수집 항목이나 국외 이전처럼 이용자 권리에 중요한 변경은 30일 전부터 알립니다.</p>
</div></section>`,
});

// ---------- 기본 기능 ----------
const FEATS = [
  { id: "today", name: "오늘", head: "아침에 열면 결정할 것부터 보입니다",
    lead: "마이웍스의 첫 화면은 할 일 목록이 아니라 ‘오늘 결정할 것’입니다. 내가 손대지 않으면 멈춰 있는 일을 먼저 처리하게 합니다.",
    items: ["오늘 브리핑 — 지연, 오늘 마감, 검토 대기, 결정할 것의 개수", "검수 요청 — 담당자가 결과물을 올리고 확인을 요청한 업무를 승인하거나 보완 요청", "견적 수정 요청 — 고객이 확인 링크에서 수정을 요청한 견적", "입금 기한이 지난 청구서 — 입금 확인 또는 청구 링크 다시 보내기", "AI 제안 — 클로드가 올린 업무 추가·상태 변경·연락처 제안을 승인하거나 거절", "합류 요청 — 초대 링크로 들어온 팀원 승인"] },
  { id: "work", name: "일", head: "맡기고, 검수 요청을 받고, 승인으로 끝냅니다",
    lead: "프로젝트와 매장의 업무를 한 보드에서 대기 → 진행중 → 검토 → 완료로 관리합니다. ‘다 했어요?’를 묻지 않아도 됩니다.",
    items: ["프로젝트 — 브랜드별 카드, 업무 목록, 목표, 메모, 링크, 의견, 예산", "매장 — 지점별 업무, 정기 점검, 매출·비용, 메모", "업무보드 — 프로젝트·매장 업무를 한 보드에서, 검수와 AI 표시 포함", "검수 흐름 — 담당자가 납품물 링크와 메모를 붙여 요청, 본인 업무는 본인이 승인할 수 없음", "반복 업무와 템플릿 — 매주·매월 자동 생성, 자주 쓰는 업무 묶음 저장", "플랜 — 일·주·월 계획과 체크리스트를 나만 보는 공간에서"] },
  { id: "deal", name: "거래", head: "견적에서 입금까지 한 줄로 잇습니다",
    lead: "고객 → 견적 → 진행·납품 → 청구 → 입금 확인이 한 안건으로 이어집니다. 어느 단계에서 멈춘 거래인지 바로 보입니다.",
    items: ["연락처 — 고객·거래처·외주를 이름·회사·구분·메모로 관리하고 검색", "견적 — 항목·수량·단가를 넣으면 공급가·부가세·합계 계산, 단가표에서 골라 넣기 (프로 · 아웃소싱)", "견적 승인 — 고객이 확인 링크에서 승인하면 안건이 ‘진행’으로, 승인된 견적은 수정 불가 (프로)", "납품 확인 — 결과물 확인 링크를 보내고 확인 또는 수정 요청을 받음 (베이직 포함)", "청구 — 부가세 10% 별도 / 3.3% 원천징수 / 없음 중 선택해 받을 금액 계산 (프로)", "입금 확인과 미수금 — 입금되면 안건이 완료되고 재무에 수입으로 기록"] },
  { id: "money", name: "돈", head: "매출과 비용이 한곳으로 모입니다",
    lead: "프로젝트 예산, 매장 매출·비용, 외주 입금, 판매 손익이 재무로 모입니다. 월말에 통장을 다시 계산하지 않아도 됩니다.",
    items: ["재무 기록 — 수입·지출을 프로젝트·매장별로 기록", "이달 재무 — 홈에서 이번 달 수입·지출·손익 확인", "모듈 손익 보내기 — 공간 운영·판매의 월 손익을 버튼 하나로 재무에 기록", "CSV 내보내기 — 세무사에게 보낼 자료를 엑셀로 열 수 있는 형식으로"] },
  { id: "people", name: "사람", head: "연락처를 가져오고, 사람마다 초대 링크로 부릅니다",
    lead: "구글·휴대폰에 있는 연락처를 한 번에 옮기고, 함께 일할 사람에게는 초대 링크를 보냅니다. 보이는 범위는 화면에서 숨기지 않고 서버가 애초에 보내지 않는 방식으로 지킵니다.",
    items: ["연락처 가져오기 — 구글 연락처(CSV), 아이폰·안드로이드(vCard), 네이버·아웃룩·엑셀(CSV), 붙여넣기. 같은 이메일·휴대폰은 하나로 합침", "사람 초대 — 사람마다 다른 링크를 카카오톡·문자·메일로 보내고, 받은 사람이 아이디를 만들면 승인 없이 지정한 프로젝트에 바로 참여", "보낸 초대 — 열어 봤는지, 참여했는지 보이고 취소하거나 기한을 다시 열 수 있음", "팀 초대 코드 — 여러 사람에게 같은 주소를 보내고 관리자가 승인하는 방식도 그대로", "역할 5가지 — 관리자, 직원, 현장 근무자, 시설 담당, 협력사", "현장 근무자 — 오늘 청소·시설 신고·오늘 발송만 보이고 예약자 이름·연락처·금액은 전송되지 않음", "협력사 — 참여 프로젝트와 맡은 업무만 보이고 예산·매출·연락처는 전송되지 않음", "퇴사·계약 종료 — 비활성화하면 즉시 로그아웃, 만든 AI 토큰도 함께 회수"] },
  { id: "link", name: "확인 링크", head: "고객은 가입 없이 링크 하나로 승인합니다",
    lead: "견적서, 납품물, 청구서를 링크로 보냅니다. 받은 사람은 로그인 없이 내용을 보고 승인·확인·수정 요청만 할 수 있습니다.",
    items: ["진행 상황 공유 — 프로젝트 진행률과 업무 목록을 읽기 전용 링크로 보여 주고, 몇 번 열어 봤는지 확인. 예산·메모·의견은 나가지 않음", "상대가 누른 결과는 내 ‘오늘 결정할 것’과 활동 기록에 바로 남음", "링크는 30일(견적은 정한 기간) 동안 유효하고, 새 링크를 만들면 이전 링크는 닫힘", "링크 페이지에는 고객 연락처, 내부 메모, 다른 업무 정보가 나가지 않음", "수정 요청이 오면 고친 뒤 같은 링크로 다시 승인받을 수 있음"] },
  { id: "ai", name: "AI 접속", head: "클로드가 내 데이터로 답하고, 변경은 제안으로 올립니다",
    lead: "개인 토큰으로 클로드를 커넥터(MCP)로 연결하면 “오늘 뭐 해야 해?”, “외주 미수금 얼마야?”에 내 워크스페이스 데이터로 답합니다.",
    items: ["읽기 토큰 — 묻고 정리하는 용도 (베이직 1개)", "쓰기 토큰 — 업무 추가·상태 변경·메모·연락처·외주 안건을 ‘제안’으로 올림 (프로)", "제안 → 승인 — 홈에서 승인해야 반영, 자동 반영은 고른 종류만", "AI가 만든 업무·연락처에는 AI 표시", "토큰은 만든 사람의 권한 범위 안에서만 읽고, 시간당 60회·하루 1,500회까지"] },
  { id: "data", name: "데이터·보안", head: "데이터는 이용자의 것입니다",
    lead: "워크스페이스끼리는 데이터가 완전히 분리됩니다. 운영자 화면에도 업무 내용은 보이지 않고 개수만 보입니다.",
    items: ["전체 백업·복원 — 백업 파일 하나로 내려받고 다른 기기에서 복원", "비밀번호·AI 토큰은 복원할 수 없는 해시(PBKDF2)로만 저장", "비밀번호 10회 연속 오류 시 10분 잠금, 30일 미사용 로그인 자동 종료", "모든 통신은 HTTPS, 데이터는 Cloudflare 클라우드에 보관", "이용자 데이터를 AI 학습에 쓰지 않음"] },
];
page({
  file: "features.html", active: "features", lastmod: "2026-11-17",
  title: "기본 기능 — 1인 사업자·소규모 팀 업무관리 | 마이웍스",
  desc: "마이웍스 기본 기능 소개. 오늘 결정할 것, 프로젝트·업무보드, 견적·납품·청구, 재무, 구성원·연락처, 확인 링크, AI 접속까지 1인 사업자와 소규모 팀이 매일 쓰는 업무관리 기능입니다.",
  crumbs: [["기본 기능", "/features"]],
  ldNodes: [APP_LD],
  body: `
<section class="hero sub">
  <div class="wrap">
    <p class="kicker">마이웍스 기본 기능</p>
    <h1>매일 여는 업무관리<span class="h-sub">오늘 · 일 · 거래 · 돈 · 사람을 한곳에</span></h1>
    <p class="lead">어떤 일을 하든 똑같이 쓰는 기본 기능입니다. 베이직(무료)에서 대부분 쓸 수 있고, 견적 승인·청구·AI 쓰기처럼 표시한 기능은 프로에서 열립니다.</p>
    <div class="guide-quick">${FEATS.map((f) => `<a class="pill" href="#${f.id}">${f.name}</a>`).join("")}</div>
  </div>
</section>
${FEATS.map((f, i) => `
<section class="sec${i % 2 ? " alt" : ""}" id="${f.id}">
  <div class="wrap feat-row">
    <div>
      <p class="kicker">${f.name}</p>
      <h2>${f.head}</h2>
      <p class="lead">${f.lead}</p>
    </div>
    <ul class="checks">${f.items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
  </div>
</section>`).join("")}
<section class="sec">
  <div class="wrap">
    <h2>엑셀·카톡으로 할 때와 무엇이 달라지나</h2>
    <div class="table-wrap stack-wrap"><table class="stack">
      <thead><tr><th>상황</th><th>엑셀·카톡·메모장</th><th>마이웍스</th></tr></thead>
      <tbody>
        <tr><td>견적 승인</td><td data-label="엑셀·카톡·메모장">카톡으로 “네, 진행해 주세요”. 어느 버전에 대한 답인지 남지 않는다</td><td data-label="마이웍스">확인 링크에서 승인. 승인한 견적과 시각이 기록되고 안건이 진행으로 바뀐다</td></tr>
        <tr><td>일 맡기기</td><td data-label="엑셀·카톡·메모장">단톡방에 지시하고 “다 했어요?”를 다시 묻는다</td><td data-label="마이웍스">담당자가 검수를 요청하면 홈에 올라오고, 승인하거나 보완을 요청한다</td></tr>
        <tr><td>근무자와 공유</td><td data-label="엑셀·카톡·메모장">예약 목록을 통째로 보낸다. 연락처와 금액도 함께 간다</td><td data-label="마이웍스">근무자 기기에는 오늘 할 일만 간다. 예약자 정보와 금액은 전송되지 않는다</td></tr>
        <tr><td>미수금 확인</td><td data-label="엑셀·카톡·메모장">월말에 통장과 청구 메일을 맞춰 본다</td><td data-label="마이웍스">입금 기한이 지난 청구서가 홈에 올라온다</td></tr>
        <tr><td>월 손익</td><td data-label="엑셀·카톡·메모장">시트를 여러 개 열어 다시 더한다</td><td data-label="마이웍스">매장·외주·판매 매출과 비용이 재무로 모인다</td></tr>
      </tbody>
    </table></div>
  </div>
</section>
<section class="sec alt">
  <div class="wrap">
    <p class="kicker">확장판</p>
    <h2>하는 일에 맞춰 필요한 것만 켭니다</h2>
    <p class="lead">기본 기능 위에 확장판을 스위치처럼 켭니다. 끄면 메뉴만 사라지고 데이터는 남습니다.</p>
    <div class="svc-grid">${SVC.map((s) => svcCard(s)).join("")}</div>
  </div>
</section>
${relatedPosts("features", "업무관리에 관한 글")}
<section class="sec cta-sec">
  <div class="wrap center">
    <h2>기본 기능은 계속 무료입니다</h2>
    <p class="lead">카드 등록 없이 시작하고, 쓰다가 필요해지면 확장판을 켭니다. 지금은 모두 무료입니다.</p>
    <div class="cta center"><a class="btn primary" href="/start">무료로 시작하기</a><a class="btn" href="/pricing">가격 보기</a></div>
  </div>
</section>`,
});

// ---------- 자주 묻는 질문 ----------
const FAQ_ALL = FAQ.flatMap(([, items]) => items);
page({
  file: "faq.html", active: "faq", lastmod: "2026-11-17",
  title: "자주 묻는 질문 — 마이웍스",
  desc: "마이웍스 자주 묻는 질문. 어떤 서비스인지, 가입과 초대, 요금과 환불, 데이터 저장과 보안, 클로드 AI 연결까지 한곳에 모았습니다.",
  crumbs: [["자주 묻는 질문", "/faq"]],
  ldNodes: [faqLd(FAQ_ALL)],
  body: `
<section class="hero sub">
  <div class="wrap">
    <p class="kicker">자주 묻는 질문</p>
    <h1>궁금한 점을 모았습니다</h1>
    <p class="lead">찾는 답이 없으면 앱의 ‘문의’나 <a class="inline-link" href="mailto:${BIZ.email}">${BIZ.email}</a>로 알려 주세요. 영업일 기준 2일 안에 답합니다.</p>
    <div class="guide-quick">${FAQ.map(([g], i) => `<a class="pill" href="#faq-${i + 1}">${esc(g)}</a>`).join("")}</div>
  </div>
</section>
<section class="sec">
  <div class="wrap faq-page">
    ${FAQ.map(([g, items], i) => `<div class="faq-group" id="faq-${i + 1}"><h2>${esc(g)}</h2>${faqHtml(items)}</div>`).join("")}
    <p class="muted small">요금은 예정 요금이며 정식 요금은 공개 베타 때 확정합니다. 자세한 기준은 <a class="inline-link" href="/pricing">가격</a>, <a class="inline-link" href="/terms">이용약관</a>, <a class="inline-link" href="/privacy">개인정보처리방침</a>에 있습니다.</p>
  </div>
</section>
<section class="sec cta-sec">
  <div class="wrap center">
    <h2>직접 써 보는 것이 가장 빠릅니다</h2>
    <div class="cta center"><a class="btn primary" href="/start">무료로 시작하기</a><a class="btn" href="/guide">가이드 보기</a></div>
  </div>
</section>`,
});

// ---------- 회사 소개 ----------
page({
  file: "about.html", active: "about",
  title: "회사 소개 — 마이웍스를 만드는 ㈜블랭크",
  desc: "마이웍스는 10년 넘게 340개가 넘는 공간을 기획·운영해 온 ㈜블랭크가 직접 쓰려고 만든 업무관리 서비스입니다. 만든 이유와 지키는 원칙, 회사 정보를 소개합니다.",
  crumbs: [["회사 소개", "/about"]],
  ldNodes: [ORG_LD],
  body: `
<section class="hero sub">
  <div class="wrap">
    <p class="kicker">회사 소개</p>
    <h1>직접 쓰려고 만든 업무 도구입니다</h1>
    <p class="lead">마이웍스는 ㈜블랭크가 만들고 매일 씁니다. 공간을 기획하고 운영하면서 필요했던 것을 하나씩 만들었고, 같은 방식으로 일하는 분들이 쓸 수 있게 열었습니다.</p>
  </div>
</section>
<section class="sec">
  <div class="wrap two start">
    <div>
      <h2>왜 만들었나</h2>
      <p>㈜블랭크와 대표 최시준은 10년 넘게 340개가 넘는 공간을 기획하고 운영해 왔습니다. 무인 파티룸 브랜드 쏘플파티룸을 만들었고, 공간 브랜딩·인테리어 서비스 Core Mood와 건물 운영 사업을 이어 오고 있습니다.</p>
      <p>공간이 늘수록 카톡방과 엑셀 시트도 함께 늘었습니다. 예약은 예약 사이트에, 청소 확인은 단톡방에, 견적은 메일에, 정산은 엑셀에 있었습니다. 사람을 더 뽑는 대신 일하는 방식을 바꾸기로 했고, 그 결과가 마이웍스입니다.</p>
      <p>그래서 마이웍스에는 실제로 매일 쓰는 기능부터 들어갑니다. 예약이 들어오면 청소 일정이 생기고, 근무자는 폰으로 체크리스트를 내고, 고객은 링크에서 견적을 승인합니다.</p>
    </div>
    <div>
      <h2>지키는 원칙</h2>
      <ul class="checks">
        <li><b>데이터는 이용자의 것입니다.</b> 언제든 전체를 내려받을 수 있고, 운영자도 업무 내용을 볼 수 없습니다.</li>
        <li><b>필요한 만큼만 보여 줍니다.</b> 근무자와 협력사 기기에는 일하는 데 필요한 정보만 전송합니다.</li>
        <li><b>거래에 수수료를 붙이지 않습니다.</b> 월 이용료만 받습니다.</li>
        <li><b>AI는 제안하고 사람이 승인합니다.</b> AI가 만든 것에는 표시를 붙입니다.</li>
        <li><b>세무·법률 판단은 하지 않습니다.</b> 자료 정리와 일정까지 돕고, 판단은 전문가에게 맡깁니다.</li>
      </ul>
    </div>
  </div>
</section>
<section class="sec alt">
  <div class="wrap">
    <h2>지금까지</h2>
    <div class="timeline">
      <div><time>2026. 10.</time><p>마이웍스 v4 — 등급, 오늘 결정할 것, 검수, 확인 링크, AI 접속, 아웃소싱·커머스</p></div>
      <div><time>2026. 10.</time><p>공개 홈페이지를 열고 마이스토어·마이빌딩·마이택스·마이셀러 계획 공개</p></div>
      <div><time>2026. 11.</time><p>정식 주소 myworks.ai.kr, 이용약관·개인정보처리방침 확정, 베타 운영 시작</p></div>
      <div><time>2026. 11.</time><p>연락처 가져오기, 사람마다 초대 링크, 진행 상황 공유, 소개 링크</p></div>
      <div><time>2026. 11.</time><p>무료 공개 시작, 마이스토어 네 업종·일 마감·점검, 마이셀러 송장 일괄 처리·발주·반품·정산 대사</p></div>
      <div><time>2026. 11.</time><p>마이택스(손익 구조·흐름·KPI·신고 자료·홈택스 자료 대조·세금 달력)와 마이피플(파트너·근무표·출퇴근·급여·임금명세서) 공개</p></div>
      <div><time>2027. 1분기 예정</time><p>마이빌딩 출시</p></div>
    </div>
    <a class="text-link" href="/notice">바뀐 점 전체 보기 →</a>
  </div>
</section>
<section class="sec">
  <div class="wrap">
    <h2>회사 정보</h2>
    <div class="table-wrap stack-wrap"><table class="stack two-col">
      <tbody>
        <tr><td>상호</td><td>${BIZ.name}</td></tr>
        <tr><td>대표</td><td>${BIZ.ceo}</td></tr>
        <tr><td>사업자등록번호</td><td>${BIZ.no}</td></tr>
        <tr><td>주소</td><td>${BIZ.addr}</td></tr>
        <tr><td>문의</td><td><a class="inline-link" href="mailto:${BIZ.email}">${BIZ.email}</a> · ${BIZ.tel}</td></tr>
        <tr><td>제휴·베타 참여</td><td>세무사·관리업체·중개사 등 전문가 파트너와 베타 참여 문의를 메일로 받습니다.</td></tr>
      </tbody>
    </table></div>
  </div>
</section>
<section class="sec cta-sec">
  <div class="wrap center">
    <h2>같은 방식으로 일해 보고 싶다면</h2>
    <div class="cta center"><a class="btn primary" href="/start">무료로 시작하기</a><a class="btn" href="/features">기본 기능 보기</a></div>
  </div>
</section>`,
});

// ---------- 블로그 ----------
const catOrder = Object.keys(CATS).filter((k) => ARTICLES.some((a) => a.cat === k));
page({
  file: "blog/index.html", active: "blog",
  title: "블로그 — 혼자 일하는 사람을 위한 업무 노트 | 마이웍스",
  desc: "1인 사업자·프리랜서·소규모 팀을 위한 업무관리 글. 파티룸·무인매장 운영, 견적서와 미수금, 세금 일정, 임대관리, 온라인 판매, AI 활용까지 실무에 바로 쓰는 내용을 정리합니다.",
  crumbs: [["블로그", "/blog/"]],
  ldNodes: [{ "@type": "Blog", "@id": SITE + "/blog/#blog", name: "마이웍스 블로그", url: SITE + "/blog/", inLanguage: "ko-KR", publisher: { "@id": ORG_ID },
    blogPost: ARTICLES.map((a) => ({ "@type": "BlogPosting", headline: a.title, url: `${SITE}/blog/${a.slug}`, datePublished: a.date })) }],
  body: `
<section class="hero sub">
  <div class="wrap">
    <p class="kicker">블로그</p>
    <h1>혼자 일하는 사람을 위한 업무 노트</h1>
    <p class="lead">매장과 공간 운영, 외주 거래, 세금과 돈, 임대, 온라인 판매처럼 혼자 챙겨야 하는 일을 실무 순서대로 정리합니다.</p>
    <div class="guide-quick" role="group" aria-label="주제 고르기">
      <button type="button" class="pill on" data-filter="all">전체 ${ARTICLES.length}</button>
      ${catOrder.map((k) => `<button type="button" class="pill" data-filter="${k}">${esc(CATS[k])} ${ARTICLES.filter((a) => a.cat === k).length}</button>`).join("")}
    </div>
  </div>
</section>
<section class="sec tight">
  <div class="wrap">
    <div class="post-grid" id="post-list">${ARTICLES.map(postCard).join("")}</div>
    <p class="muted small" style="margin-top:22px">새 글은 <a class="inline-link" href="/rss.xml">RSS</a>로 받아 볼 수 있습니다.</p>
  </div>
</section>`,
});

const SVC_LINK = { features: ["마이웍스 기본 기능", "/features"], store: ["마이스토어", "/store"], building: ["마이빌딩", "/building"], tax: ["마이택스", "/tax"], seller: ["마이셀러", "/seller"], people: ["마이피플", "/people"] };
ARTICLES.forEach((a) => {
  // 소제목에 번호 앵커를 붙이고 목차를 만든다
  const toc = [];
  const body = a.body.replace(/<h2>([\s\S]*?)<\/h2>/g, (m, t) => { toc.push(t); return `<h2 id="s${toc.length}">${t}</h2>`; });
  const others = [...ARTICLES.filter((x) => x.slug !== a.slug && x.cat === a.cat), ...ARTICLES.filter((x) => x.slug !== a.slug && x.cat !== a.cat && x.svc.some((v) => a.svc.includes(v)))].slice(0, 3);
  const rest = others.length < 3 ? ARTICLES.filter((x) => x.slug !== a.slug && !others.includes(x)).slice(0, 3 - others.length) : [];
  const url = `/blog/${a.slug}`;
  page({
    file: `blog/${a.slug}.html`, active: "blog", type: "article", lastmod: a.updated || a.date,
    title: `${a.title} | 마이웍스 블로그`, ogTitle: a.title, desc: a.desc,
    crumbs: [["블로그", "/blog/"], [a.title, url]],
    extra: `<meta property="article:published_time" content="${a.date}T09:00:00+09:00">\n<meta property="article:modified_time" content="${a.updated || a.date}T09:00:00+09:00">\n<meta property="article:section" content="${esc(CATS[a.cat])}">\n${a.tags.map((t) => `<meta property="article:tag" content="${esc(t)}">`).join("\n")}`,
    ldNodes: [{ "@type": "BlogPosting", "@id": SITE + url + "#post", headline: a.title, description: a.desc, url: SITE + url, mainEntityOfPage: SITE + url,
      datePublished: `${a.date}T09:00:00+09:00`, dateModified: `${a.updated || a.date}T09:00:00+09:00`, inLanguage: "ko-KR", articleSection: CATS[a.cat], keywords: a.tags.join(", "),
      image: SITE + "/site/img/og.png", author: { "@type": "Organization", name: "마이웍스 팀", url: SITE + "/about" }, publisher: { "@id": ORG_ID } }, ORG_LD],
    body: `
<article class="post">
  <header class="post-head">
    <div class="wrap narrow">
      ${crumbNav([["블로그", "/blog/"], [CATS[a.cat], "/blog/"]])}
      <h1>${esc(a.title)}</h1>
      <p class="post-meta"><time datetime="${a.date}">${fmtDate(a.date)}</time> · 읽는 시간 ${readMin(a.body)}분 · <a href="/about">마이웍스 팀</a></p>
      <p class="lead">${esc(a.desc)}</p>
    </div>
  </header>
  <div class="wrap narrow">
    ${toc.length > 2 ? `<nav class="post-toc" aria-label="이 글의 순서"><b>이 글의 순서</b><ul>${toc.map((t, i) => `<li><a href="#s${i + 1}">${t.replace(/<[^>]+>/g, "")}</a></li>`).join("")}</ul></nav>` : ""}
    <div class="doc post-body">${body}
      ${a.refs && a.refs.length ? `<div class="refs"><b>참고</b><ul>${a.refs.map(([t, u]) => `<li><a href="${esc(u)}" target="_blank" rel="noopener nofollow">${esc(t)}</a></li>`).join("")}</ul></div>` : ""}
    </div>
    <div class="post-tags">${a.tags.map((t) => `<span>#${esc(t.replace(/\s+/g, ""))}</span>`).join("")}</div>
    <aside class="post-cta">
      <div><b>${a.svc.map((v) => SVC_LINK[v][0]).join(" · ")}</b><p>이 글의 내용을 마이웍스에서 바로 써 볼 수 있습니다. 기본 기능은 무료입니다.</p></div>
      <div class="cta">${a.svc.slice(0, 1).map((v) => `<a class="btn" href="${SVC_LINK[v][1]}">${SVC_LINK[v][0]} 보기</a>`).join("")}<a class="btn primary" href="/start">무료로 시작하기</a></div>
    </aside>
  </div>
</article>
<section class="sec alt">
  <div class="wrap">
    <h2>다른 글</h2>
    <div class="post-grid">${[...others, ...rest].map(postCard).join("")}</div>
    <a class="text-link" href="/blog/">블로그 전체 보기 →</a>
  </div>
</section>`,
  });
});

// ---------- 404 ----------
page({
  file: "404.html", active: "", noindex: true,
  title: "페이지를 찾을 수 없습니다 — 마이웍스", desc: "주소가 바뀌었거나 없는 페이지입니다.",
  body: `
<section class="hero sub"><div class="wrap">
  <p class="kicker">404</p>
  <h1>페이지를 찾을 수 없습니다</h1>
  <p class="lead">주소가 바뀌었거나 없는 페이지입니다. 아래에서 찾는 곳으로 이동해 주세요.</p>
  <div class="cta"><a class="btn primary" href="/">홈으로</a><a class="btn" href="/app/">로그인</a><a class="btn" href="/guide">가이드</a><a class="btn" href="/blog/">블로그</a></div>
  <p class="muted small">확인 링크를 받으셨다면 보낸 분께 링크를 다시 요청해 주세요. 링크는 정해진 기간이 지나면 닫힙니다.</p>
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
fs.writeFileSync(path.join(OUT, "_redirects"), `/link/*  /link/index.html  200\n/join/*  /join/index.html  200\n`);

// ---------- 검색엔진 (robots.txt · sitemap.xml) ----------
// 파일이 없으면 Cloudflare Pages가 첫 화면 HTML을 대신 돌려줘 검색엔진이 사이트맵을 읽지 못한다.
fs.writeFileSync(path.join(OUT, "robots.txt"), `User-agent: *
Allow: /
Disallow: /app/
Disallow: /admin
Disallow: /link/
Disallow: /join/
Disallow: /api/

Sitemap: ${SITE}/sitemap.xml
`);
fs.writeFileSync(path.join(OUT, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${PAGES.map((u) => `  <url><loc>${SITE}${u.url}</loc><lastmod>${u.lastmod}</lastmod><priority>${u.priority}</priority></url>`).join("\n")}
</urlset>
`);
// RSS — 네이버 서치어드바이저·피드 리더용. 블로그 글을 최신순으로 싣는다.
const rfc822 = (iso) => new Date(iso + "T09:00:00+09:00").toUTCString().replace("GMT", "+0000");
const xml = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const feedItems = [...ARTICLES].sort((x, y) => (y.date > x.date ? 1 : y.date < x.date ? -1 : 0));
fs.writeFileSync(path.join(OUT, "rss.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>마이웍스 블로그</title>
  <link>${SITE}/blog/</link>
  <description>1인 사업자·프리랜서·소규모 팀을 위한 업무관리 글 — 매장·공간 운영, 외주 거래, 세금, 임대, 온라인 판매, AI 활용</description>
  <language>ko</language>
  <lastBuildDate>${rfc822(ISO_DATE)}</lastBuildDate>
  <atom:link href="${SITE}/rss.xml" rel="self" type="application/rss+xml"/>
${feedItems.map((a) => `  <item>
    <title>${xml(a.title)}</title>
    <link>${SITE}/blog/${a.slug}</link>
    <guid isPermaLink="true">${SITE}/blog/${a.slug}</guid>
    <pubDate>${rfc822(a.date)}</pubDate>
    <category>${xml(CATS[a.cat])}</category>
    <description>${xml(a.desc)}</description>
    <content:encoded><![CDATA[${a.body.replace(/\]\]>/g, "]]&gt;").replace(/href="\//g, `href="${SITE}/`).trim()}]]></content:encoded>
  </item>`).join("\n")}
</channel>
</rss>
`);
console.log("written robots.txt, sitemap.xml, rss.xml", PAGES.length);

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
.biz{display:flex;flex-wrap:wrap;gap:6px 18px;margin:28px 0 0;padding-top:16px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted);line-height:1.6}
.biz>div{display:flex;gap:6px;min-width:0}.biz dt{font-weight:600;color:var(--ink-2);white-space:nowrap}.biz dd{margin:0;overflow-wrap:anywhere}.biz a{color:inherit}
.foot-grid a .em{font-weight:700;color:var(--ink);display:inline;margin:0;font-size:inherit}
.biz+.foot-bottom{margin-top:14px}
@media (min-width:601px){.legal table.stack.two-col td:first-child{white-space:nowrap;padding-right:20px}}
.foot-bottom{display:flex;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;margin-top:28px;padding-top:16px;border-top:1px solid var(--line);font-size:13px}

/* 건너뛰기 · 경로 */
.skip{position:absolute;left:0;top:0;z-index:100;background:var(--ink);color:#fff;padding:10px 14px;border-radius:0 0 8px 0;transform:translateY(-130%)}.skip:focus{transform:none}
.crumbs{display:flex;flex-wrap:wrap;gap:4px 0;font-size:13.5px;color:var(--muted);margin-bottom:18px}
.crumbs a,.crumbs span{display:inline-flex;align-items:center;min-height:32px}.crumbs a:hover{color:var(--point)}
.crumbs a::after{content:"›";margin:0 8px;color:var(--line)}
.inline-link{color:var(--point);font-weight:600}.inline-link:hover{text-decoration:underline}
.two.start{align-items:start}
.narrow{max-width:800px}
.sec.tight{padding-top:28px}.sec.tight .post-grid{margin-top:0}

/* 이런 분들 · 기능 */
.who-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:26px}
.who{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:20px 18px;transition:transform .15s,box-shadow .15s}
.who:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(28,27,25,.08)}
.who b{font-size:17px;margin-bottom:6px}.who p{color:var(--ink-2);font-size:14.5px;margin:0 0 10px}.who .more{margin-top:auto;color:var(--point);font-weight:600;font-size:14px}
.feat-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:48px;align-items:start}
.checks{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.checks li{position:relative;padding:13px 16px 13px 44px;background:var(--surface);border:1px solid var(--line);border-radius:10px;font-size:15px;color:var(--ink-2)}
.checks li::before{content:"";position:absolute;left:17px;top:19px;width:13px;height:7px;border-left:2px solid var(--point);border-bottom:2px solid var(--point);transform:rotate(-45deg)}
.checks li b{color:var(--ink)}
.timeline{display:grid;gap:0;margin:22px 0 14px;border-left:2px solid var(--line);padding-left:20px;max-width:760px}
.timeline>div{position:relative;padding:8px 0 14px}.timeline>div::before{content:"";position:absolute;left:-26px;top:15px;width:10px;height:10px;border-radius:50%;background:var(--point)}
.timeline time{font-weight:700;font-size:14px;color:var(--point)}.timeline p{margin:2px 0 0;color:var(--ink-2)}
.faq-page{max-width:820px}.faq-group{margin-bottom:40px}.faq-group h2{font-size:22px;padding-bottom:10px;border-bottom:2px solid var(--ink);margin-bottom:0}
.two .faq{align-self:start}

/* 블로그 */
.post-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:24px 0 16px}
.post-card{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:20px 18px;transition:transform .15s,box-shadow .15s}
.post-card:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(28,27,25,.08)}
.post-card[hidden]{display:none}
.post-cat{color:var(--point);font-weight:700;font-size:12.5px;margin-bottom:8px}
.post-card b{font-size:17px;line-height:1.45;margin-bottom:8px}
.post-card p{color:var(--ink-2);font-size:14.5px;margin:0 0 14px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.post-meta{color:var(--muted);font-size:13px}.post-card .post-meta{margin-top:auto}
.pill.on{background:var(--ink);border-color:var(--ink);color:#fff}
button.pill{cursor:pointer;font-family:inherit}
.post-head{padding:44px 0 8px}
.post-head h1{font-size:36px;line-height:1.35;margin-bottom:14px}
.post-head .post-meta{margin-bottom:18px}.post-head .post-meta a{color:var(--ink-2);font-weight:600}
.post-head .lead{max-width:none;padding:16px 18px;background:var(--paper);border-radius:var(--radius);font-size:16.5px}
.post-toc{border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;margin:22px 0 8px;background:var(--surface)}
.post-toc b{font-size:13px;color:var(--muted)}.post-toc ul{list-style:none;margin:8px 0 0;padding:0}.post-toc li{margin:0;border-top:1px dashed var(--line)}.post-toc li:first-child{border-top:0}
.post-toc a{display:flex;align-items:center;min-height:36px;color:var(--ink-2)}.post-toc a:hover{color:var(--point)}
.post-body{max-width:none;font-size:16.5px;line-height:1.8;padding:14px 0 6px}
.post-body h2{font-size:23px;margin:40px 0 12px}.post-body h2:first-child{margin-top:16px}.post-body p{margin:0 0 16px}
.post-body li{margin:7px 0}
.callout{margin:30px 0 8px;padding:18px 20px;border:1px solid var(--line);border-left:4px solid var(--point);border-radius:var(--radius);background:var(--point-soft)}
.callout b{display:block;margin-bottom:6px;color:var(--point);font-size:14px}.callout p{margin:0;font-size:15.5px;line-height:1.7}
.refs{margin-top:28px;padding-top:14px;border-top:1px solid var(--line);font-size:13.5px;color:var(--muted)}.refs ul{margin:6px 0 0;padding-left:18px}.refs a{word-break:break-all}
.post-tags{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 26px}.post-tags span{font-size:13px;color:var(--muted);background:var(--surface-2);border-radius:999px;padding:4px 11px}
.post-cta{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;border:1px solid var(--line);border-radius:var(--radius);padding:20px;margin:0 0 56px;background:var(--surface)}
.post-cta b{font-size:17px}.post-cta p{margin:4px 0 0;color:var(--ink-2);font-size:14.5px}.post-cta .cta{margin:0}

/* ── 태블릿 가로·작은 노트북 (≤1100) ── */
@media (max-width:1100px){
  .svc-grid,.price-row{grid-template-columns:repeat(2,minmax(0,1fr))}
  .who-grid,.post-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .feat-row{gap:32px}
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
  .feat-row{grid-template-columns:1fr;gap:20px}
  .post-head h1{font-size:30px}
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
  .who-grid,.post-grid{grid-template-columns:1fr}
  .post-head{padding:28px 0 4px}.post-head h1{font-size:25px}.post-body{font-size:16px}.post-body h2{font-size:20px}
  .post-cta{flex-direction:column;align-items:stretch}.post-cta .cta .btn{flex:1 1 100%}
  .crumbs span{display:none}.crumbs a:last-of-type::after{display:none}
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
// 소개 링크(?ref=코드)로 들어오면 60일 동안 기억했다가 앱 가입 화면에 넘깁니다
(function(){
  try{ var c=(new URLSearchParams(location.search).get("ref")||"").toUpperCase().replace(/[^A-Z0-9]/g,""); if(c.length>=6&&c.length<=10) localStorage.setItem("mw_ref",JSON.stringify({c:c,at:Date.now()})); }catch(e){}
})();
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
// 블로그: 주제별로 보기
(function(){
  var btns=[].slice.call(document.querySelectorAll("[data-filter]")), list=document.getElementById("post-list"); if(!btns.length||!list) return;
  function apply(k){ btns.forEach(function(b){ var on=b.getAttribute("data-filter")===k; b.classList.toggle("on",on); b.setAttribute("aria-pressed",on?"true":"false"); });
    [].slice.call(list.children).forEach(function(c){ c.hidden = k!=="all" && c.getAttribute("data-cat")!==k; }); }
  btns.forEach(function(b){ b.addEventListener("click",function(){ apply(b.getAttribute("data-filter")); }); });
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
    if(!pro&&svcs.length){note="확장판은 프로에서 켭니다. 프로를 함께 계산에 넣어 주세요.";}
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
