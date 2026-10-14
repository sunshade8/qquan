# 로컬 연구 실행과 공유 시장 데이터

앱, 연구 실행기, 작업 큐, 상태 저장은 사용자 컴퓨터에서 동작한다. Vercel은 연구 서버나 데이터 저장소가 아니다. Cloudflare 계정/DB ID/API 토큰 없이 사용한다. 기본 Vite 런타임은 Node이며 명시적인 `QQUAN_RUNTIME=cloudflare`는 과거 배포 호환용이다. Vercel 환경에서는 로컬 연구 DB를 열지 않는다.

## 설치와 실행

Node 22.13 이상(검증: 23.11.0), Python 3.11–3.13(검증: 3.13.3)이 필요하다. Python 3.14는 이 PyArrow 고정 버전의 지원 대상으로 간주하지 않는다.

```sh
npm ci
npm run data:setup
npm run local
```

연구 runner의 URL은 loopback만 허용한다. 기존 `TRADING_RUNNER_URL`이 원격 URL이면 제거하거나 `http://127.0.0.1:3000`으로 바꾼다.

`npm run local`은 loopback 앱(`http://127.0.0.1:3000`), 다운로드 worker, 연구 전용 runner를 독립 프로세스로 실행한다. **거래 tick은 보내지 않는다.** 기존 실거래 감시는 별도로 `npm run trader`를 명시적으로 실행한다. 연구 시작은 거래 시작/실주문 활성화가 아니다.

개별 실행 또는 로컬 빌드:

```sh
npm run dev
npm run data:worker
npm run research:runner
npm run build:local
npm run start:local
```

빌드 서버도 loopback으로 시작한다. 앱 단독 모드의 설정 버튼은 detached 다운로드 worker를 시작한다. 브라우저를 닫아도 해당 worker는 계속된다. 재부팅 후에는 `npm run local` 또는 `npm run data:worker`를 실행해야 한다. 잠자기/전원 종료 동안 작업은 진행되지 않는다. 재시작 시 만료된 lease를 회수하고 검증된 구간은 건너뛴다. 연구 runner는 기존 체크포인트·완료 모델 응답·비용 장부·취소·중지·재개·최종 구간 소진 규칙을 유지한다. 앱이 내려가 있는 동안 연구 runner는 연결을 기다린다. OS 로그인 서비스 설치는 자동 수행하지 않는다.

`.dev.vars`의 기존 `MASSIVE_API_KEY` 또는 `POLYGON_API_KEY`를 재사용한다. Toss 토큰을 다운로드용으로 발급하지 않는다. Binance에는 계좌 키가 필요 없다. 모델 연구에는 기존 모델 키가 필요하며 원본 데이터 다운로드에는 필요 없다.

## 배포 사이트에서 로컬 저장소 사용

Sites는 사용자 컴퓨터의 파일을 직접 읽거나 Python을 실행할 수 없다. 호스팅 빌드는
공통 데이터 RPC를 D1 작업 전달 큐로 교체하고, `npm run data:bridge`가 인증된 HTTPS
요청으로 작업을 받아 **기존 같은 SQLite catalog/Parquet/snapshot**을 읽는다.
로컬 포트를 공개하지 않으며 별도 원본 데이터 다운로드나 파일 복사를 하지 않는다.
Sites에는 `LOCAL_DATA_BRIDGE_SECRET` 비밀값, 로컬 `.dev.vars`에는 같은 값과
`LOCAL_DATA_SITE_URL`, 기존 Sites 서비스 접근 토큰 `LOCAL_DATA_SITES_AUTHORIZATION`을 설정한다.
`get_site`의 기존 서비스 접근 토큰을 사용하며 확인을 위해 토큰을 새로 발급하지 않는다.
이 값들은 브라우저나 Git에 넣지 않는다.

```sh
npm run data:bridge
```

설정된 `npm run local`도 bridge를 함께 시작한다. bridge만 실행해도 Sites의 전략 생성과
저장소 조회는 동작한다. 연구 자동 진행 runner는 별도이며 브라우저에서도 기존 단계 진행을
사용할 수 있다. 컴퓨터가 꺼지거나 bridge가 종료되면 사이트에 **연결 끊김**을 표시한다.
데이터 부족은 연결 후 catalog와 파일 hash를 실제 검증한 결과로만 판단한다.
설정의 다운로드/재개 요청은 인증 후 같은 로컬 작업 큐에 넣고 로컬 downloader를 시작한다.
원격에서 임의 shell/파일 경로/URL/다운로드 범위를 전달할 수 없다. 전달 결과는 분할되어
수신되고 소비 후 지워지며, 미소비 결과도 만료 후 정리된다. 연결 작업은 lease가 맞는
실행기만 완료할 수 있고 결과가 누락되면 실패한다. catalog 원본과 snapshot은 로컬에 유지된다.
로그는 `~/.qquan/logs/data-bridge.log`에 저장할 수 있다. 재부팅 후 bridge를 다시 실행해야 한다.
OS 로그인 서비스는 설치하지 않는다.

## 사용자 데이터 위치

기본 `~/.qquan`, 변경은 비밀이 아닌 `QQUAN_DATA_DIR=/절대/경로`로 한다. 앱과 모든 runner/CLI에 같은 값을 사용한다. 소스 checkout이나 `.output`, `dist` 안에 두지 않는다.

| 위치 | 내용 |
| --- | --- |
| `state/research.sqlite` | 기존 앱/연구/거래 SQL 테이블, 다운로드 작업/구간/오류, catalog, 불변 snapshot 목록 |
| `parquet/stock/YYYY-MM/<sha256>.parquet` | Massive NVDA 원주가 1분봉 |
| `parquet/btc/YYYY-MM/<sha256>.parquet` | Binance Spot BTCUSDT 1분봉 |
| `parquet/eth/…`, `parquet/sol/…` | Binance Spot ETHUSDT, SOLUSDT 1분봉(같은 파이프라인, 2026-10-14) |
| `state/research.sqlite`의 `ct_orderbook_samples` | 비용 프로필용 공개 호가 스냅샷(아래 「호가 측정」) |
| `state/research.sqlite`의 `ct_calibration` | 설계자의 눈(블라인드 차트) 보정 기록(4단계, `docs/ct.md`「판과 눈」) |
| `parquet/binance-derivs/<종목>/{premium_1m,funding,metrics_5m}.parquet`, `manifest.json`, `raw/` | Binance USDⓈ-M 파생 공개 데이터(프리미엄 1분봉, 펀딩비, 5분 지표) — 천장 측정 전용, 연구·설계 도구에는 연결되지 않음 |
| `parquet/upbit/<시장>/minute.parquet`, `manifest.json`, `raw/*.jsonl` | Upbit KRW 1분봉(KRW-BTC/ETH/SOL/USDT, 최근 1년, 거래 없는 분은 봉이 없음) — 천장 측정 전용 |
| `cache/ceiling-field/` | 천장 측정용 평평한 float64 열, `results.jsonl`(조합별 결과, 재개용), `timing.json` |
| `research/out`, `research/journals` | CLI 연구 산출물과 연구 장부 mirror |
| `logs/data-worker.log` | detached 다운로드 worker 오류 |
| `backups/*.sqlite` | SQLite online backup 및 이전 전 사본 |

SQLite WAL, 30초 busy timeout, `BEGIN IMMEDIATE` batch로 프로세스 간 접근을 직렬화한다. 기존 D1의 parameterized prepare/bind/all/raw/first/run/batch 계약을 Node SQLite 어댑터로 유지한다. 연구·장부 lease는 같은 DB를 사용한다. 다운로드는 별도 dataset 활성 unique index와 token lease, heartbeat, worker 파일 잠금을 사용한다. 프로세스가 죽은 lease는 약 2분 뒤 재획득 가능하다. 취소된 이전 worker는 새 소유자의 작업을 갱신할 수 없다.

## 파생·Upbit 공개 데이터와 천장 측정(4단계 2부)

모두 공개 시세·아카이브만 쓰며 인증이나 계좌 API를 부르지 않는다. 다운로드는 재개할 수 있고(받은 zip·페이지는 건너뜀) 파일마다 SHA-256을 기록한다.

```sh
# Binance USDⓈ-M 파생(최근 36개월, BTC/ETH/SOL): 월 프리미엄 1분봉·펀딩비 + 일 5분 지표. 체크섬 파일로 검증. 약 10분, 원본 zip 139MB.
.venv/bin/python scripts/data/download-binance-derivs.py [--symbols BTCUSDT,ETHUSDT,SOLUSDT] [--months 36] [--end 2026-10-13]
# Upbit KRW 1분봉(공개 시세 API, 요청 200개 단위, 초당 8회 이하). 시장 하나당 약 21–34분, 시장별로 병렬 실행 가능.
.venv/bin/python scripts/data/download-upbit-minute.py --markets KRW-BTC,KRW-USDT,KRW-ETH,KRW-SOL --from 2025-10-13 --to 2026-10-14
# 측정용 열 내보내기 → 측정 → 보고서
.venv/bin/python scripts/data/export-ceiling-cache.py
node --experimental-strip-types --no-warnings scripts/research/ct-ceiling-field.ts [--only=btc,1y] [--skip-binance|--skip-upbit]
node --experimental-strip-types --no-warnings scripts/research/ct-ceiling-field.ts --report --out=docs/research/ct-ceiling-2026-10-14-field.md
```

제공 범위와 시각 의미는 [천장 측정 확장 보고서](research/ct-ceiling-2026-10-14-field.md) 2절 표에 있다(강제청산 이력은 제공되지 않음). 이 데이터는 **설계 도구·규칙 언어에 연결되지 않는다**. Upbit 거래가 없던 분은 측정에서만 직전 종가의 평평한 봉으로 채우고(채운 수를 보고서에 적음) 저장된 parquet에는 채우지 않는다.

실데이터 점검용 스크립트: `scripts/research/ct-contrast-modes.ts`(세 대조군 비교, 모델 비용 0), `scripts/research/ct-board-check.mjs`(판 서명 거부 확인, DB 읽기 전용). `QQUAN_CT_POLICY_VERSION=1`은 **검증 전용**으로 새 계약을 이전 정책(도구 버전 1)으로 동결한다 — 일반 사용에서는 설정하지 않는다.

## 소유자 ID (브라우저 간 연구 기록 공유)

연구·전략·대화·장부·LLM 사용량은 `owner_id`로 저장된다. `QQUAN_OWNER_ID`(UUID)를 `.dev.vars`에 두면 Safari/Chrome, `localhost`/`127.0.0.1` 어디서 열어도 같은 기록을 본다. 비워 두면 브라우저 쿠키가 소유자라 브라우저를 바꾸면 이전 기록이 보이지 않는다(데이터는 DB에 남아 있음). 이전 쿠키 소유자들의 기록은 한 번 합친다. 쓰기 전에 `backups/`에 사본을 만든다.

```sh
node --env-file=.dev.vars scripts/data/merge-owners.mjs --dry-run
node --env-file=.dev.vars scripts/data/merge-owners.mjs
```

## 백업과 기존 Miniflare 이전

```sh
.venv/bin/python scripts/data/migrate.py                 # 발견한 SQLite와 테이블 이름만 출력
.venv/bin/python scripts/data/migrate.py --backup        # WAL을 포함한 일관된 online backup
# 앱을 한번 실행해 대상 스키마를 만든 다음, 앱/연구/거래 runner를 중지한다.
.venv/bin/python scripts/data/migrate.py --import-file /원본/Miniflare.sqlite
```

이전기는 원본을 read-only로 열고 원본·대상 모두 backup한다. 알려진 앱 테이블 및 컬럼 이름/SQL 타입/기본키를 비교하고, 컬럼 순서가 달라도 명시적인 이름으로 삽입한다. 불일치 스키마나 키 충돌은 전체 import를 거부/rollback한다. 원본을 새 DB 파일로 간주하거나 덮어쓰지 않는다. 빈 새 환경도 독립적으로 사용 가능하다. 원격 D1 이전 기능은 구현하거나 실행하지 않았다.

완전한 복구에는 SQLite backup과 `parquet/`를 함께 보존해야 한다. immutable snapshot이 참조하는 과거 hash 파일을 임의 삭제하지 않는다. 원본 시장 파일은 재다운로드 가능하지만 정정 전 hash는 재생산이 보장되지 않는다.

## 설정 버튼과 CLI

Settings → **공유 로컬 1분봉 저장소**:

- 주식 1분봉: NVDA / Massive / 최근 5년
- 코인 1분봉: BTCUSDT·ETHUSDT·SOLUSDT Spot(종목마다 버튼) / Binance Public Data / 최근 5년

다운로드/증분 갱신은 저장된 작업 ID를 만들고 즉시 반환한다. 취소/재개는 같은 큐의 영구 상태를 변경한다. 진행률은 **파일 요청 구간 작업의 완료 수**이며 행 수/다운로드 바이트/ETA의 추정치가 아니다. 요청 기간과 검증 coverage, 내부 부족 범위, 손상 파일, 마지막 검증/최신 봉을 구분한다. 전체 5년 목표가 미완료여도 특정 연구 기간 coverage가 충분하면 사용할 수 있다.

```sh
# 기본 최근 5개 역년 길이. UTC 완료 일자 경계, [start,end).
node --env-file-if-exists=.dev.vars scripts/prefetch-market-data.mjs
node --env-file-if-exists=.dev.vars -e 'import {spawnSync} from "node:child_process"; const r=spawnSync(".venv/bin/python",["scripts/data/download-btc-minute.py"],{stdio:"inherit",env:process.env}); process.exitCode=r.status;'
# 키가 이미 shell에 설정되었다면 stock Python CLI도 직접 사용 가능하다.
.venv/bin/python scripts/data/download-stock-minute.py 2026-09-28 2026-09-29
.venv/bin/python scripts/data/download-btc-minute.py 2025-01-01 2025-02-01
# ETHUSDT / SOLUSDT도 같은 방식이다(기간을 생략하면 최근 5년, 이미 받은 구간은 건너뜀).
.venv/bin/python scripts/data/download-eth-minute.py
.venv/bin/python scripts/data/download-sol-minute.py
.venv/bin/python scripts/data/store.py status
.venv/bin/python scripts/data/store.py cancel JOB_UUID
.venv/bin/python scripts/data/store.py resume JOB_UUID
npm run data:worker
# 공급자 정정 아카이브를 명시적으로 재검증/갱신한다. 기본 실행은 네트워크 재검증을 하지 않는다.
.venv/bin/python scripts/data/download-btc-minute.py 2025-01-01 2025-02-01 --refresh
```

실제 다운로드 구현은 `download-stock-minute.py`, `download-btc-minute.py`가 공통 `store.py`를 호출한다. UI도 같은 `store.py` RPC/큐/공급자 함수를 사용한다. 임의 shell, 경로, URL을 브라우저 입력으로 실행하지 않는다. 작업 API는 loopback host, 동일 Origin POST, 허용된 action/dataset/UUID를 검사한다. 동시 다운로드는 제한되고 Massive 요청 간격은 DB에서 공유한다. 429/일시 오류는 제한된 backoff와 Retry-After, 401/403은 즉시 기록하며 무한 재시도하지 않는다.

주식은 최근 구간부터 최대 7일씩 진행한다. 계정 이용 권한을 로컬 설정으로 바꾸지 않는다. **2021-10-13–14 실제 요청은 HTTP 403**이었다. 이 계정으로 5년 전체를 제공할 수 있다고 주장하지 않는다. 거부 구간과 이미 확보한 구간을 보존한다. 구독 변경/결제는 수행하지 않는다.

Binance는(BTC·ETH·SOL 공통, 종목은 데이터셋의 `instrument`) 완료 월별 공식 ZIP/CHECKSUM을 우선하고, 부분 월/최근 구간/미공개 월별 파일은 일별 ZIP/CHECKSUM으로 보충한다. 404는 미공개 자료로 구분하며 실제 checksum/파싱 오류와 다르게 표시한다. 밀리초/2025년 이후 마이크로초를 UTC 밀리초로 정규화하고 원본 close-time의 마지막 마이크로초 대신 `end=start+60000`을 쓴다. 일별/월별 겹침은 결정적으로 제거한다. 정정은 `--refresh`로 새 hash 파일에 쓰며 기존 연구 snapshot은 유지한다.

## 스키마, 품질과 분할 정책

Parquet decimal128(30,10)은 가격·base volume·quote volume을 별도로 보존한다. Binance base는 BTC, quote는 USDT이며 주식 volume은 주식 수다. Node 엔진 경계에서만 JS number로 변환한다. market/instrument/venue/provider/quote currency/source/adjustment/schema version은 파일 metadata에 남는다. bar start/end는 int64 UTC 밀리초다. catalog는 요청 구간, 행 수, 실제 첫/마지막 봉, 크기/hash, URL/요청, 검증 시각, duplicate/결측 품질 보고서를 기록한다.

임시 파일을 Parquet로 readback하고 OHLC/시간/중복을 검증한 뒤 atomic rename하고 catalog에 등록한다. catalog에 없는 임시/고아 파일은 연구에 공개되지 않는다. 재조회 시 파일 hash와 스키마/행 수를 검증하며 손상 파일을 coverage로 인정하지 않는다. 다운로드/수집 실패는 미확보 범위다. 유효 응답 안의 무봉 구간은 합성하지 않는다. 주식 휴장/세션은 캘린더로 구별하며 거래정지·무거래·공급자 내부 누락을 OHLCV만으로 완전히 구분할 수 없다는 한계를 qualityReport에 남긴다. Binance 5년에도 아카이브 무봉 분이 있어 연속 분을 모두 채웠다고 주장하지 않는다.

주식 원본은 **adjusted=false**, dataset version `minute-v1-raw`다. 수정주가와 섞지 않는다. CT/relay의 정수 주식 수량·원주가 체결 계약과 맞추며, CT는 세션 경계에서 패턴 이력/포지션을 끊는다. NVDA 분할(2021-07-20, 2024-06-10)을 넘는 원주가 일봉 연구는 거부한다. 수정주가 파생 데이터셋은 아직 제공하지 않는다. 따라서 5년 raw 데이터를 통째로 일봉 가격 수익률 연구에 전달하지 않는다. NVDA 결과를 다른 모든 주식에 검증된 것으로 표현하지 않는다.

XNYS `exchange-calendars 4.11.2`에서 2020–2035 세션/휴장/조기 폐장을 생성한 TS 캘린더를 CT 엔진과 공유한다. Python 조회는 같은 라이브러리의 UTC 개장/폐장 경계로 DST를 처리한다. 재생성: `.venv/bin/python scripts/data/export-calendar.py`. 긴급 휴장 등의 공급자 캘린더 정정은 의존성/생성 파일 갱신과 재검증이 필요하다.

5/15/60분은 UTC 격자에서 실제 연속 1분봉을 모두 가진 완성 bucket만 생성한다. 정규장 세션 필터를 **집계 전에** 적용하며, 60분 주식 개장 첫 30분은 60분봉으로 만들지 않는다. 요청 종료/현재 시점 이후의 봉은 제외한다. 3분 legacy 전략도 같은 1분 원본에서 완성 bucket만 집계한다.

## 공통 조회와 소비자

`queryLocalMarket` → Python catalog/snapshot 검사 → 필요한 Parquet 파티션 → 세션 필터/로컬 집계다. `networkPolicy`의 연구 기본/지원 값은 `local-only`다. 부족한 데이터는 Settings의 실제 다운로드 버튼으로 안내하며 연구가 5년 다운로드를 몰래 시작하지 않는다. 반환에는 bars, datasetVersion, snapshot hash, provenance, coverage, missingRanges, qualityReport, localReadCount, externalRequestCount가 포함된다. 과대 요청은 제한하고 큰 stock 요청은 월 단위로 읽는다. 모델에 원봉 전체를 전달하지 않는다.

연결된 경로:

- CT 생성 preflight, 데이터 단계, 백테스트, 등록 버전 실행 준비: 불변 snapshot을 contract에 저장하고 Parquet에서 직접 읽는다. 새 CT의 원봉을 `ct_data_pages`/tool JSON에 복제하지 않는다.
- relay/전략 생성·탐색·slot 연구·백테스트: 공통 minute loader. 새 연구 상태에는 hash 파일 참조와 날짜/시간 선택 범위를 저장한다. 기존 v1/v2 연구 페이지는 계속 읽는다.
- Lab/에이전트 tool, 뉴스 intraday 비교, 이벤트 개장 전 분석, 일봉 백테스트와 Market history API: 공통 로컬 조회. NVDA가 아닌 요청에 NVDA를 대신 반환하지 않는다.
- 급등주 분봉 수집/읽기: 공통 로컬 조회. 전체 시장 연구는 단일 NVDA 데이터로 충족하지 못하므로 부족 범위를 명시하며 자동 전 종목 봉 다운로드를 하지 않는다.
- 독립 CLI 연구 `_load.ts` 및 이전 우주 종목 acquire도 같은 로컬 조회를 사용한다. 미지원 종목을 자동 다운로드하지 않는다.
- Toss 과거 분봉 cursor(24시간보다 이전)는 공통 로컬 조회로 보낸다. 최신 하루의 실시간 봉/현재가/호가/캘린더는 실시간 공급자를 사용한다.

남겨둔 외부 경로는 명시적으로 구별한다: 실시간 Toss/Upbit 호가·현재가·최근 봉, 계좌·잔고·주문·대사, Toss 현재 랭킹, TradingView 외부 표시용 위젯(연구 입력으로 사용하지 않음), 기존 급등주 실시간 후보의 전일 전체시장 통계(`allow-external`), 종목 메타 조회, 뉴스/SEC/FRED/공개 문서/모델 호출이다. 전체 시장 통계는 별도 기존 SQL 캐시이며 NVDA minute dataset이 대신 충족하지 않는다. 모델·검색·계좌 호출은 과거 시장 데이터 호출 수와 동일하지 않다. 기존 다른 코인 포지션의 감시/매도/취소는 유지하고 신규 매수는 BTC만 허용한다.

Binance BTCUSDT 연구는 USDT capital/0.1% 편도 가정/0.01 USDT tick/UTC 일자 기준이다. 실제 주문 가능 규칙을 조회한 실행 전략이라는 뜻은 아니다. Upbit KRW-BTC와 가격·통화·수수료·호가가 달라 **새 Binance 연구의 Upbit 모의/실전 시작을 차단**한다. 통화 이름만 바꾸거나 거래소/실주문을 자동 변경하지 않는다. 기존 Upbit 연구의 기록과 운용 청산 경로는 보존한다.

## 호가 측정과 비용 프로필 (2026-10-14)

CT 비용 프로필(`lib/ct-costs.ts`)의 스프레드·슬리피지는 가정이 아니라 공개 호가의 측정값이다. 인증·계좌·주문 없이 Binance `GET /api/v3/depth`(500호가)와 Upbit `GET /v1/orderbook`만 1분마다 호출하고, $1,000와 $10,000 시장가 주문이 mid를 얼마나 미는지 계산해 SQLite `ct_orderbook_samples`에 저장한다.

```sh
# 72시간 수집(백그라운드, 절전 방지). 로그: ~/.qquan/logs/orderbook-sampler.log
nohup caffeinate -i npm run data:orderbook -- --hours=72 >> ~/.qquan/logs/orderbook-sampler.log 2>&1 &
npm run data:orderbook -- --once                 # 한 번만 측정해 출력
npm run data:orderbook -- --summary              # 지금까지의 p50/p90/p99
npm run data:orderbook -- --profile --write-lib  # p90(올림)을 lib/ct-cost-measurements.ts에 기록
npm run data:orderbook -- --check                # 프로필이 측정 p90보다 낮으면 실패
```

측정 기간이 72시간을 채우기 전에는 프로필이 `provisional`(잠정)이고 화면에도 그렇게 표시된다. 컴퓨터가 잠들면 그 시간은 표본에 없다. 표를 갱신해도 이미 만들어진 계약의 비용은 바뀌지 않는다(계약이 숫자를 동결한다). 천장 측정은 `npm run research:ceiling`이다.

## 검증

```sh
npm run test:local
npx tsc --noEmit
npm run build:local
# 실제 내려받은 데이터가 있을 때: 모든 fetch 및 Python 시장 네트워크 차단
node --experimental-strip-types scripts/data/verify-local.mjs
node scripts/data/verify-runtime.mjs # 빌드 서버를 새 임시 사용자 DB로 두 번 실행
```

실제 검증 범위와 한계는 [2026-10-13 검증 기록](local-validation-2026-10-13.md)에 있다. 이번 변경은 로컬 commit만 하고, main push에 의한 자동 Vercel 배포를 피했다.
