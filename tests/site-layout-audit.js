// 홈페이지 화면 폭별 점검 — 로컬에서 저장소를 http://localhost:8099 로 띄운 뒤 실행: node tests/site-layout-audit.js <출력폴더> [shots]
// 폰 360·390·430 / 태블릿 768·834·1024·1180 / PC 1280·1440·1920 폭에서 모든 페이지의 가로 넘침, 눌린 글, 화면 밖 요소, 작은 터치 영역, 겹침, 깨진 이미지, 메뉴 열림을 검사한다.
// 레이아웃 점검: 페이지 × 화면 폭마다
//  1) 가로 넘침(페이지 전체)  2) 글이 너무 좁은 상자에 눌린 것(한 줄에 몇 글자 안 됨)
//  3) 화면 밖으로 나간 요소  4) 작은 터치 영역(모바일·태블릿)  5) 형제 요소끼리 겹침
//  6) 이미지 깨짐  7) 콘솔 오류
// 사용: node audit.js [출력폴더] [shots]
const { chromium } = require("playwright");
const fs = require("fs");
const OUT = process.argv[2] || __dirname + "/out";
const SHOTS = process.argv[3] === "shots";
fs.mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:8099";
const PAGES = ["/", "/store", "/building", "/tax", "/seller", "/pricing", "/guide", "/notice", "/start", "/terms", "/privacy"];
const VPS = [
  { n: "phone-360", w: 360, h: 760, touch: true },
  { n: "phone-390", w: 390, h: 844, touch: true },
  { n: "phone-430", w: 430, h: 932, touch: true },
  { n: "tab-768", w: 768, h: 1024, touch: true },
  { n: "tab-834", w: 834, h: 1194, touch: true },
  { n: "tab-1024", w: 1024, h: 768, touch: true },
  { n: "tab-1180", w: 1180, h: 820, touch: true },
  { n: "pc-1280", w: 1280, h: 800 },
  { n: "pc-1440", w: 1440, h: 900 },
  { n: "pc-1920", w: 1920, h: 1080 },
];

(async () => {
  const b = await chromium.launch();
  const report = [];
  for (const vp of VPS) {
    const ctx = await b.newContext({ viewport: { width: vp.w, height: vp.h }, hasTouch: !!vp.touch, isMobile: vp.w < 600, deviceScaleFactor: 1 });
    const pg = await ctx.newPage();
    const errs = [];
    pg.on("pageerror", (e) => errs.push(e.message));
    pg.on("console", (m) => { if (m.type() === "error" && !/ERR_TUNNEL|net::ERR/.test(m.text())) errs.push(m.text()); });
    for (const p of PAGES) {
      errs.length = 0;
      await pg.goto(BASE + p, { waitUntil: "networkidle" }).catch(() => {});
      await pg.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo({ top: y, behavior: 'instant' }); await new Promise((r) => setTimeout(r, 30)); } window.scrollTo({ top: 0, behavior: 'instant' }); });
      await pg.waitForTimeout(250);
      const r = await pg.evaluate(({ touch }) => {
        const W = document.documentElement.clientWidth;
        const issues = [];
        const label = (el) => { let s = el.tagName.toLowerCase(); if (el.className && typeof el.className === "string") s += "." + el.className.trim().split(/\s+/).join("."); const t = (el.innerText || el.alt || "").replace(/\s+/g, " ").trim().slice(0, 40); return s + (t ? ` “${t}”` : ""); };
        const visible = (el) => { const cs = getComputedStyle(el); if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return false; const rc = el.getBoundingClientRect(); return rc.width > 0 && rc.height > 0; };
        const inScroller = (el) => { for (let a = el.parentElement; a; a = a.parentElement) { const ox = getComputedStyle(a).overflowX; if (ox === "auto" || ox === "scroll" || ox === "hidden") return true; } return false; };
        if (document.documentElement.scrollWidth > W + 1) issues.push({ k: "page-overflow", d: `scrollWidth ${document.documentElement.scrollWidth} > ${W}` });
        const all = [...document.querySelectorAll("body *")].filter(visible);
        for (const el of all) {
          const rc = el.getBoundingClientRect();
          // 화면 밖
          if ((rc.right > W + 1 || rc.left < -1) && !inScroller(el) && getComputedStyle(el).position !== "fixed") issues.push({ k: "offscreen", d: label(el) + ` [${Math.round(rc.left)}..${Math.round(rc.right)}]` });
          // 좁게 눌린 글: 직접 텍스트가 10자 이상인데 폭이 너무 좁음(한 줄 6자 이하)
          const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").replace(/\s+/g, "");
          if (own.length >= 10) {
            const fs = parseFloat(getComputedStyle(el).fontSize) || 16;
            const lh = parseFloat(getComputedStyle(el).lineHeight) || fs * 1.5;
            if (rc.width < fs * 6.5 && rc.height > lh * 2.5) issues.push({ k: "squeezed-text", d: label(el) + ` w=${Math.round(rc.width)} fs=${fs}` });
          }
          // 이미지 깨짐
          if (el.tagName === "IMG" && (!el.complete || el.naturalWidth === 0)) issues.push({ k: "broken-img", d: el.getAttribute("src") });
        }
        // 작은 터치 영역 (터치 기기에서)
        if (touch) {
          for (const el of document.querySelectorAll("a, button, input, select, summary, label[for]")) {
            if (!visible(el)) continue;
            if (getComputedStyle(el).pointerEvents === "none") continue;
            if (el.closest(".doc") && el.tagName === "A" && getComputedStyle(el).display === "inline") continue; // 본문 속 글 링크는 제외
            if (el.tagName === "INPUT" && el.closest("label")) { const lr = el.closest("label").getBoundingClientRect(); if (lr.height >= 40) continue; } // 줄 전체가 눌리는 체크박스
            const rc = el.getBoundingClientRect();
            if (rc.height < 32 || rc.width < 32) issues.push({ k: "small-tap", d: label(el) + ` ${Math.round(rc.width)}x${Math.round(rc.height)}` });
          }
        }
        // 형제 겹침 (그리드·플렉스 자식끼리)
        for (const box of document.querySelectorAll("*")) {
          const cs = getComputedStyle(box); if (!/(grid|flex)/.test(cs.display)) continue;
          const kids = [...box.children].filter(visible).filter((k) => getComputedStyle(k).position !== "absolute" && getComputedStyle(k).position !== "fixed");
          for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
            const a = kids[i].getBoundingClientRect(), c = kids[j].getBoundingClientRect();
            const ox = Math.min(a.right, c.right) - Math.max(a.left, c.left), oy = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
            if (ox > 2 && oy > 2) issues.push({ k: "overlap", d: label(kids[i]) + " ⟷ " + label(kids[j]) });
          }
        }
        return { issues, h: document.documentElement.scrollHeight, title: document.title };
      }, { touch: !!vp.touch });
      if (errs.length) r.issues.push(...errs.map((e) => ({ k: "console", d: e })));
      // 중복 제거
      const seen = new Set(); r.issues = r.issues.filter((i) => { const key = i.k + i.d; if (seen.has(key)) return false; seen.add(key); return true; });
      report.push({ vp: vp.n, page: p, n: r.issues.length, issues: r.issues });
      if (SHOTS) await pg.screenshot({ path: `${OUT}/${vp.n}${p === "/" ? "-home" : p.replace(/\//g, "-")}.png`, fullPage: true });
    }
    // 메뉴 상태: 모바일·태블릿은 햄버거, PC는 서비스 드롭다운
    await pg.goto(BASE + "/pricing", { waitUntil: "networkidle" });
    const burger = await pg.$("button.nav-btn, label.nav-btn");
    if (burger && (await burger.isVisible())) { await burger.click(); await pg.waitForTimeout(150); if (SHOTS) await pg.screenshot({ path: `${OUT}/${vp.n}-menu-open.png` }); }
    else { const lab = await pg.$(".nav-group .nav-label"); if (lab) { if (vp.touch) await lab.tap().catch(() => lab.click()); else await lab.hover(); await pg.waitForTimeout(150); const open = await pg.evaluate(() => { const m = document.querySelector(".nav-group .menu"); return m && getComputedStyle(m).display !== "none"; }); report.push({ vp: vp.n, page: "(서비스 메뉴 " + (vp.touch ? "탭" : "호버") + ")", n: open ? 0 : 1, issues: open ? [] : [{ k: "menu", d: "서비스 메뉴가 열리지 않음" }] }); if (SHOTS) await pg.screenshot({ path: `${OUT}/${vp.n}-menu-open.png` }); } }
    await ctx.close();
  }
  await b.close();
  fs.writeFileSync(OUT + "/report.json", JSON.stringify(report, null, 1));
  const bad = report.filter((r) => r.n);
  console.log(`검사 ${report.length}건, 문제 있는 화면 ${bad.length}건`);
  const byKind = {};
  bad.forEach((r) => r.issues.forEach((i) => { (byKind[i.k] = byKind[i.k] || []).push(`${r.vp} ${r.page}: ${i.d}`); }));
  for (const [k, list] of Object.entries(byKind)) { console.log(`\n■ ${k} (${list.length})`); list.slice(0, 25).forEach((l) => console.log("  " + l)); if (list.length > 25) console.log("  …"); }
})();
