# cdfinder

개인용 CD 음반 탐색·가격 비교·소장 관리.

- `engine.js` — 구매 판단·가격 통계·싼 매물 판정 (웹앱과 수집기가 공유)
- `scanner/run.js` — 출처별 매물 수집 (GitHub Actions에서 15분마다 실행)
- `data/db.json` — 탐색 목록·매물·관측 이력·소장 기록
- `data/scan-report.json` — 최근 스캔의 출처별 결과

비밀 값(Settings → Secrets and variables → Actions): `ALADIN_TTB_KEY`(선택), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
