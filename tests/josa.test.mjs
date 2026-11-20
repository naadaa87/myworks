// 조사 고르기(josa) — 서버와 앱에 같은 함수가 들어 있습니다. 두 곳 모두 같은 결과를 내는지 봅니다.
// 실행: node --no-warnings tests/josa.test.mjs
import fs from "node:fs";
const root = new URL("..", import.meta.url).pathname;
const pick = (file, from, to) => { const s = fs.readFileSync(root + file, "utf8"), a = s.indexOf(from), b = s.indexOf(to, a); if (a < 0 || b < 0) throw new Error(file + "에서 josa를 찾지 못했습니다"); return new Function(s.slice(a, b) + "; return josa;")(); };
const impl = { 서버: pick("functions/_middleware.js", "const JOSA = {", "const actRow = (me, text)"), 앱: pick("app/index.html", "const JOSA = {", "const confirm=m=>") };
const cases = [
  ['프로젝트 "모노가구"을(를) 만들었습니다.', '프로젝트 "모노가구"를 만들었습니다.'],
  ['연락처 "김지수"을(를) 추가했습니다.', '연락처 "김지수"를 추가했습니다.'],
  ['매장 "성수점"을(를) 등록했습니다.', '매장 "성수점"을 등록했습니다.'],
  ['마이크리에이터을(를) 켰습니다.', '마이크리에이터를 켰습니다.'],
  ['마이택스을(를) 켰습니다.', '마이택스를 켰습니다.'],
  ['마이피플을(를) 껐습니다.', '마이피플을 껐습니다.'],
  ['등급을 프로(으)로 저장했습니다.', '등급을 프로로 저장했습니다.'],
  ['등급을 베이직(으)로 저장했습니다.', '등급을 베이직으로 저장했습니다.'],
  ['기본 업종을 ‘소매·무인매장’(으)로 정했습니다.', '기본 업종을 ‘소매·무인매장’으로 정했습니다.'],
  ['기본 업종을 ‘음식·카페’(으)로 정했습니다.', '기본 업종을 ‘음식·카페’로 정했습니다.'],
  ['‘검토’(으)로 바꿨습니다', '‘검토’로 바꿨습니다'],
  ['완료(으)로 바꿨습니다', '완료로 바꿨습니다'],
  ['진행중(으)로 바꿨습니다', '진행중으로 바꿨습니다'],
  ['서울(으)로', '서울로'],
  ['지출 12,000원을(를) 기록했습니다', '지출 12,000원을 기록했습니다'],
  ['견적 Q-261120-02을(를) 삭제할까요?', '견적 Q-261120-02를 삭제할까요?'],
  ['견적 Q-261120-03을(를) 삭제할까요?', '견적 Q-261120-03을 삭제할까요?'],
  ['견적 을(를) 삭제할까요?', '견적을 삭제할까요?'],
  ['"Brand Kit"을(를) 삭제할까요?', '"Brand Kit"를 삭제할까요?'],
  ['"SIGNAL"을(를) 삭제할까요?', '"SIGNAL"을 삭제할까요?'],
  ['조사가 없는 문장은 그대로입니다.', '조사가 없는 문장은 그대로입니다.'],
  ['김대표이(가) 승인했습니다', '김대표가 승인했습니다'],
  ['이고객은(는) 확인했습니다', '이고객은 확인했습니다'],
  ['', ''],
];
let pass = 0, bad = 0;
for (const [name, josa] of Object.entries(impl)) for (const [i, o] of cases) { const r = josa(i); if (r === o) pass++; else { bad++; console.log("✗", name, JSON.stringify(i), "→", JSON.stringify(r), "(바람:", o + ")"); } }
console.log(`통과 ${pass} · 실패 ${bad}`);
process.exit(bad ? 1 : 0);
