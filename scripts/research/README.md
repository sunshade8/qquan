# scripts/research

`docs/research/results-2026-09.md`의 모든 수치를 만드는 스크립트. Node에서 직접 돈다 (`lib/price-cache.ts`·`lib/market-data.ts`·`lib/massive.ts`는 `cloudflare:workers`를 import하므로 여기서 쓸 수 없다).

```bash
node --experimental-strip-types scripts/research/h2-reversal.ts
```

## 공통 모듈

| 파일 | 역할 |
|---|---|
| `_load.ts` | Yahoo 일봉(수정주가로 OHLC 보정) · Massive 5분봉(장외 포함, 분당 5회 제한 스로틀, 120일 청크). 둘 다 `cache/`에 JSON 캐시 |
| `_stats.ts` | 거래 집계·t검정·자본곡선. 비용은 항상 `lib/broker-costs.ts`의 `roundTripPct()` |
| `_daily.ts` | 일봉 규칙 엔진. 신호는 봉 종가, 체결은 **다음 봉 종가**. 손절·익절은 진입 다음 봉부터 장중 판정, 한 봉에 둘 다 닿으면 손절 |
| `_intraday.ts` | 세션 분할·상대거래량(직전 세션 중앙값)·VWAP(09:30 누적) |
| `_events.ts` | FOMC 성명일(연준 캘린더, 비정기 7건 제외) · CPI/고용 발표일(FRED releases API) |
| `_prefetch-intraday.ts` | Massive 5분봉 8종목 2년치 선다운로드 (~13분, 캐시 후 재실행 불필요) |

## 가설 스크립트

`h1`~`h10` + 보조: `h2b`(날짜 클러스터·장기·용량 제한), `h5b`(`lib/intraday-fvg.ts`로 교차검증), `h9b`(분봉 pre-FOMC), `h2-spec-check`(채택 규칙을 `lib/strategy.ts` 사양으로 실행), `summary-portfolio`(`lib/daily-target.ts` 합산).

결과 JSON은 `out/`. 캐시(`cache/`)와 결과(`out/`)는 재생성 가능하므로 커밋 대상이 아니다.
