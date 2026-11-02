
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
  var P={"pro":12000,"proYear":9900,"svc":{"store":19000,"building":19000,"tax":9900,"seller":19000},"names":{"store":"마이스토어","building":"마이빌딩","tax":"마이택스","seller":"마이셀러"},"seat":4900,"disc":0.1,"all":49000,"allYear":39900};
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
