
// 가격 계산기 — 숫자는 서버 상수와 같이 바꾼다
(function(){
  var P={"pro":12000,"proYear":9900,"svc":{"store":19000,"building":19000,"tax":9900,"seller":19000},"names":{"store":"마이스토어","building":"마이빌딩","tax":"마이택스","seller":"마이셀러"},"seat":4900,"disc":0.1,"all":49000,"allYear":39900};
  var total=document.getElementById("c-total"); if(!total) return;
  var won=function(n){return n.toLocaleString("ko-KR")+"원";};
  function calc(){
    var pro=document.getElementById("c-pro").checked, year=document.getElementById("c-year").checked;
    var seats=Math.max(0,parseInt(document.getElementById("c-seats").value||"0",10));
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
    document.getElementById("c-note").textContent=note+" 예정 요금이며 VAT 별도입니다.";
  }
  document.querySelectorAll("#c-pro,.c-svc,#c-seats,#c-year").forEach(function(el){el.addEventListener("input",calc);el.addEventListener("change",calc);});
  calc();
})();
// 모바일 메뉴: 링크를 누르면 닫기
document.querySelectorAll(".nav a").forEach(function(a){a.addEventListener("click",function(){var t=document.getElementById("nav-toggle");if(t)t.checked=false;});});
