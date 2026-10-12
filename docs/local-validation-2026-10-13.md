# 로컬 실행 전환 검증 — 2026-10-13 KST

이번 작업은 로컬에서만 실행했다. Vercel 배포 및 실주문, Toss 토큰 재발급, 유료 요금제 변경은 수행하지 않았다. main에 로컬 commit을 남기되 main push로 연결된 production 배포가 시작되지 않도록 push하지 않는다.

## 실제 데이터와 UI

시간 범위는 UTC [start,end)다. 실행 당시 UTC 날짜는 2026-10-12이며 완료 일자 경계가 목표 종료다.

| 데이터 | 검증 결과 |
| --- | --- |
| NVDA Massive 원주가 1분봉 | 2026-08-11–2026-10-12 coverage, 40,455행, 1,364,513 bytes. 주식 전체 목표는 부분 확보다. 장기 작업은 UI 취소/재개 검증 후 canceled, 구간 작업 9/261. |
| NVDA 짧은 실제 다운로드 | 2026-09-28–29, 프리/정규/애프터 포함 원본 949행. Parquet 검증 후 정규장 5분봉 78개를 조회했다. |
| NVDA 계정 권한 확인 | 2021-10-13–14 요청 실제 HTTP 403 authorization/entitlement refused. 이 구간을 받지 못했으며 5년 주식 확보 완료로 표시하지 않는다. 2년 설정은 계정 권한 증명이 아니다. |
| Binance Spot BTCUSDT | 공식 월별/일별 ZIP + CHECKSUM에서 2021-10-12–2026-10-12 전체 요청 coverage 확보. 결정적 중복 제거 후 2,629,360행, 활성 파일 147,245,105 bytes. 원본에 없는 80분을 합성하지 않았다. |

Settings에서 주식/코인 각 다운로드 버튼을 실제 클릭해 서로 다른 dataset 작업이 시작됨을 확인했다. BTC 작업은 90/90 구간 완료. 주식은 저장된 같은 작업을 재개해 3/261에서 9/261로 진행한 뒤 UI로 취소했다. 이미 확보된 파일은 그대로 남았다. 진행률은 행 수나 추정 완료 시간이 아닌 파일 요청 구간 작업 수다.

주식 전체 5년 다운로드는 끝내지 않았다. 위의 특정 403 구간 외 모든 미확보 구간을 공급자가 거부했다고 추정하지 않는다. 원본 결측은 실패 coverage와 구별하며, 주식 거래정지/실제 무거래/공급자 내부 누락 원인은 OHLCV만으로 확정할 수 없다.

## 외부 과거 데이터 요청 0회와 실제 엔진

`scripts/data/verify-local.mjs`는 JS fetch를 실패시키고 Python의 모든 시장 네트워크 요청도 `QQUAN_DENY_MARKET_NETWORK=1`로 차단한다. 실제 내려받은 Parquet를 공통 조회로 두 번 읽고, 실제 `loadCTData` 연구 데이터 단계와 결과가 일치함을 확인했으며 5/15/60분 집계 및 CT replay를 실행했다. 모델 호출·주문은 없다.

| 연구 입력 | 조회 범위 | 5분봉 | 실제 CT replay | 외부 요청 |
| --- | --- | ---: | --- | ---: |
| NVDA / USD / US | 2026-09-28–29 정규장 | 78 | measured, 14 trades | 0 |
| BTCUSDT / USDT / BinanceSpot | 2025-01-01–02-01 | 8,928 | measured, 215 trades | 0 |

이는 실행 경로 검증이며 전략 수익성 검증이 아니다. 같은 snapshot으로 반복 조회한 봉은 정확히 일치했다. 고정 hash는 각각 `c668d250236df3b7724c9d80ddc4710bb24b877d567df97fc41b03b008fbcbd5`, `398777a07d32b55a1c2a5536cf3148cde84dbcff5f72d4de2e25a91b5dda5fb4`다. 이후 새 파일이 추가되어도 기존 snapshot 파일은 보존한다.

BTC 전체 5년 CLI를 시장 네트워크 차단 상태로 정상 재실행했다. 기존 검증 구간을 재사용해 90/90 complete, 추가 과거 요청 없이 종료했다. LLM/공개 문서 검색 비용은 시장 데이터 요청 수와 별개다.

## 상태 DB, 재시작, 이전

Node 23.11.0 / Python 3.13.3 / PyArrow 21.0.0 / exchange-calendars 4.11.2 / pandas 2.3.3으로 실행했다. 기본 사용자 저장 위치는 `~/.qquan/state/research.sqlite`와 `~/.qquan/parquet/{stock,btc}`다.

`scripts/data/verify-runtime.mjs`로 실제 빌드 앱을 새 사용자 디렉터리에서 두 차례 시작했다. Cloudflare/D1, Toss/Upbit, Massive/Polygon, OpenAI/Anthropic 자격증명과 Vercel 변수를 제거하고 `.dev.vars` 로드를 건너뛰었다. CT GET 200, SQLite 작업의 재시작 후 id/status 유지, 다른 Origin 및 임의 URL 작업 요청 400을 확인했다. 이 검증은 새 데이터 디렉터리를 쓰며 기존 연구/거래를 실행하거나 변경하지 않는다.

기존 `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/`의 SQLite를 발견했다. 원본/대상 online backup 후 앱 테이블 이름·컬럼 이름·SQL 타입·PK를 확인하고 9,646행을 로컬 DB로 이전했다. 원본 파일은 보존했다. 전략 생성 8건, 거래 대시보드 9건, 기존 LLM usage 106건 등 저장 기록을 확인했다. backup은 `~/.qquan/backups`에 있다. 원격 D1 데이터에는 접근하거나 이전하지 않았다.

## 자동 검증

- Node 회귀/안전성 테스트: 372/372 통과. 기존 비용·모델 응답 재사용·최종 holdout 소진·취소·lease·주문 장부·청산 테스트 포함.
- Python 데이터 테스트: 9/9 통과. 파일 손상/coverage, queue 재시작·중복·취소/재개·취소 소유자 쓰기 거부, checksum, ms/us, 중복 충돌, immutable correction, 완성 bucket, 심볼·통화·거래소, DST/휴장/조기폐장/과거 캘린더, raw split 일봉 차단 포함.
- TypeScript 검사 및 로컬 node-server 빌드 통과. 변경한 핵심 런타임/다운로드 UI/조회/거래 연결 파일 ESLint 통과.
- 새 앱 실제 HTTP·재시작 검사와 실제 Parquet CT 엔진 검사 통과.

## 남은 제약과 명시적 예외

NVDA만 주식 기본 dataset으로 지원하며 전체시장·다른 종목 연구를 충족한다고 주장하지 않는다. Binance BTCUSDT 연구를 Upbit KRW-BTC 운용에 직접 연결하지 않는다. 수정주가 파생 dataset은 제공하지 않으며 raw 일봉 분할 경계 횡단을 차단한다. 원격 D1은 이전하지 않았다. 컴퓨터가 꺼지거나 잠들면 작업은 진행되지 않으며 재시작 후 runner를 다시 실행해야 한다.

실시간 가격·호가·최근 봉·계좌·주문·대사와 뉴스/기업 정보/문서/모델은 목적에 맞는 외부 공급자를 계속 사용한다. 기존 Upbit 비-BTC 포지션 감시·매도·취소는 유지한다. TradingView 외부 표시 위젯과 실시간 급등주 후보용 전일 전체시장 통계는 로컬 NVDA 연구 입력과 별개다. 전체 소비자 목록과 명시적 외부 경로는 [로컬 실행 문서](local-runtime.md)에 있다.
