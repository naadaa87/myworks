# 공개 홈페이지 생성기

`gen.js`가 저장소 루트의 홈페이지 HTML(`index.html`, `store.html` … `privacy.html`), `site/site.css`, `site/site.js`, `site/img/*`, `link/index.html`, `_redirects`를 만든다.

```
node src/site/gen.js . README.md
```

- 첫 번째 인자: 출력 디렉터리(저장소 루트 `.`)
- 두 번째 인자: 가이드 페이지의 원본인 README.md 경로(pandoc 필요)

문구·가격·서비스 설명은 `gen.js` 위쪽의 `SVC`, `PRICING` 상수를 고친다. 화면 캡처는 저장소의 `site/img/`에 넣고 `gen.js`에서 파일 이름으로 참조한다.
