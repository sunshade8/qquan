# 지시서 C — 코인 전부 Binance 기준 + Upbit 제외 + 지정가 전용 체결

이 문서를 구현 에이전트에게 그대로 전달한다. 이전 대화 없이 수행할 수 있다. 계획만 내지 말고 코드, 테스트, 화면 확인, 문서까지 끝낸다.

프로젝트: `/Users/woojinpark/Desktop/qquan`. 시작 전에 다음 문서를 읽는다.
- `AGENTS.md`, `CLAUDE.md`
- `docs/binance-api.md`: Binance 조사 기록과 현재 구현 상태 표가 있다. 이미 있는 것을 다시 만들지 않는다.
- `docs/ct.md`: 특히 「비용 프로필」 「통합 의사결정·부품·북·Binance」 절.
- `docs/research/ct-ceiling-2026-10-15-execution.md`: 지정가 체결을 측정한 방식과 한계.
- 전략 탭 대시보드나 공통 주문 경로(`lib/trading-runner.ts`, `lib/trading-account-lock.ts`, `lib/dashboard-types.ts`)를 건드리기 전에 `docs/toss-api.md`.

## 0. 소유자 결정

1. **코인은 모두 Binance 기준이다.** 연구, 데이터, 비용, 리플레이, 천장 측정, 호가 측정, 모의, 실전, 화면, 설정이 모두 해당된다.
2. **Upbit은 제외한다.** 단, 나중에 소유자가 다시 켤 수 있어야 하므로 **삭제가 아니라 비활성·격리**한다(자세한 내용은 2절).
3. **모든 주문은 시장가가 아니라 지정가다.** 연구 체결 모델, 비용, 모의 체결, 실전 주문이 모두 해당된다.
4. Binance 자격증명은 `.dev.vars`에 있다: `BINANCE_API_KEY`, `BINANCE_API_SECRET`, `BINANCE_TRADING_DISABLED`, `BINANCE_NETWORK`(테스트넷 키 이름은 `.env.example`의 `BINANCE_TESTNET_API_KEY/SECRET`). 키 값은 출력, 문서, 로그, URL, 브라우저, 커밋에 절대 남기지 않는다. 키는 IP 제한(`ipRestrict=true`)이 걸려 있으니 실패하면 자격증명 문제로 단정하지 말고 IP부터 의심한다.

## 1. 수수료 — 공식 자료 (2026-10-17 확인)

| 상품 | 등급 | Maker | Taker | BNB 할인 | 출처 |
|---|---|---:|---:|---|---|
| Spot | Regular User | **0.100%** | **0.100%** | 25% → 0.075% / 0.075% | [Binance Fee Schedule](https://www.binance.com/en/fee/schedule) (페이지에 수정일 표기 없음, 2026-10-17 조회) |
| USDⓈ-M 선물 | Regular User (VIP 0) | **0.0200%** | **0.0500%** | 10% (BNB를 USDⓈ-M 계정에 보유해야 적용) | [Binance Futures Fee Structure & Fee Calculations](https://www.binance.com/en/support/faq/detail/360033544231) ("Updated on 2026-05-01 11:51") |

규칙:
- **BNB 할인은 가정하지 않는다.** 계정이 실제로 BNB로 수수료를 내도록 설정되어 있고 잔고가 있다는 것을 API로 확인한 경우에만 별도 프로필 버전으로 둔다.
- **계정의 실제 요율을 읽는다.** Spot은 `GET /api/v3/account/commission`(종목별 standard/tax/special/discount), USDⓈ-M은 `GET /fapi/v1/commissionRate`(이미 200 확인됨, `docs/binance-api.md`). 계약에 동결하는 값은 `max(공식 표, 계정 실제 값)`이고, 둘 다 출처와 조회 시각을 계약에 기록한다. 읽기만 하고 설정은 바꾸지 않는다.
- 구현 직전에 위 두 페이지와 [Spot Commission FAQ](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/commission_faq.md)를 다시 열어 값이 바뀌지 않았는지 확인하고, 바뀌었으면 새 값과 확인일로 고친다.

**중요한 사실(소유자에게도 보고할 것):** Spot Regular 등급은 maker와 taker가 **둘 다 0.1%**다. 그래서 현물에서 지정가로 바꿔도 **수수료는 줄지 않고**, 줄어드는 것은 스프레드와 슬리피지(충격)뿐이다. BTCUSDT는 원래 충격이 거의 0이었다(`docs/ct.md`: 약 0.00001%). 수수료 차이가 생기는 것은 선물이다(maker 0.02% vs taker 0.05%). 이 점을 계약 문구와 화면에 숨기지 말고 표시한다.

## 2. Upbit 제외 (비활성·격리)

현재 Upbit 참조가 있는 파일(T 복제본 제외): `app/local-data-settings.tsx`, `app/trading-dashboards.tsx`, `lib/upbit.ts`, `lib/ct-trading.ts`, `lib/ct-costs.ts`, `lib/ct-cost-measurements.ts`, `lib/ct-data.ts`, `lib/ct-research-store.ts`, `lib/ct-spec.ts`, `lib/ct-ceiling-features.ts`, `lib/dashboard-types.ts`, `lib/market-precision.ts`, `lib/trading-account-lock.ts`, `lib/trading-runner.ts`, `scripts/data/download-upbit-minute.py`, `scripts/data/export-ceiling-cache.py`, `scripts/data/measure-orderbook.mjs`, `scripts/data/verify-runtime.mjs`, `scripts/research/ct-ceiling-execution.ts`, `scripts/research/ct-ceiling-field.ts`, 테스트 `tests/ct-account.test.mjs`, `tests/ct-adapters.test.mjs`, `tests/ct-ceiling-features.test.mjs`, `tests/local-data.test.py`. 시작할 때 `grep -rli upbit`로 다시 센다.

- **화면:** Upbit 선택지, 다운로드 버튼, 계정·잔고 표시, 비용 표, 경고 문구를 모든 탭(CT, T, 전략 대시보드, Settings, 급등주)에서 보이지 않게 한다.
- **신규 경로:** 새 연구 생성, 새 모의·실전 시작, 호가 샘플러, 천장 측정 기본값이 Upbit을 선택할 수 없게 한다. 서버도 거부한다(UI에서 숨기는 것만으로는 부족하다).
- **격리 방식:** 코드는 지우지 않는다. 기능 플래그 하나(예: `QQUAN_ENABLE_UPBIT`, 기본 꺼짐)로 막고, Upbit 전용 코드는 한곳에서 꺼지도록 정리한다. 플래그를 켜면 이전 동작으로 돌아와야 한다. 이것을 테스트로 고정한다.
- **보존할 것:** 과거 Upbit 연구 기록, 거래 기록, 등록 패키지, `upbit-krw` 비용 프로필, 이전 계약(`ct-pattern-1/2/3`)의 저장된 비용은 **그대로 읽히고 그대로 재현**되어야 한다. 골든 회귀 테스트(`tests/ct-pattern-1-regression.test.mjs`, `tests/ct-pattern-2-regression.test.mjs`)는 해시가 바뀌면 안 된다. 열린 Upbit 포지션이 있으면 청산·조회 경로는 남긴다. 먼저 로컬 DB(`~/.qquan/state/research.sqlite`)에서 열린 포지션이 있는지 읽기 전용으로 확인한다.
- **T 복제본**(`lib/t-*.ts`, `app/t-*.tsx`, `app/api/invest/t/**`)에도 같은 규칙을 적용한다. T는 CT를 자동으로 따라가지 않는 별도 복제본이므로 직접 고쳐야 한다.
- 환경변수 `UPBIT_*`는 `.dev.vars`에서 지우지 않는다(소유자 파일). `.env.example`에서는 "비활성, 플래그로 켬" 주석을 단다.

## 3. 지정가 전용 체결

### 3.1 주문 종류 (공식 명세로 확인 후 구현)

- **Spot:** 진입과 목표 청산은 `LIMIT_MAKER`(post-only: 즉시 체결될 가격이면 거부되어 taker가 되지 않음) 또는 `LIMIT` + `GTC`. 손절은 `STOP_LOSS_LIMIT`. 동시에 거는 목표와 손절은 OCO 주문 목록. 근거: [Spot REST](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md), [Filters](https://github.com/binance/binance-spot-api-docs/blob/master/filters.md).
- **USDⓈ-M:** `LIMIT` + `timeInForce: GTX`(post-only). 조건부 주문(손절·목표·트레일)은 `/fapi/v1/algoOrder`의 별도 수명주기를 따르고, `docs/binance-api.md`의 One-way/Hedge·`reduceOnly` 제약을 지킨다.
- 가격과 수량은 Decimal로 다루고 `PRICE_FILTER`, `LOT_SIZE`, `NOTIONAL`, 가격 밴드를 통과하게 맞춘다. 반올림 때문에 위험 한도를 넘지 않게 한다.

### 3.2 손절의 위험 (기본 정책 — 소유자에게 보고)

지정가 손절은 가격이 갭으로 뛰어넘으면 **체결되지 않을 수 있다.** "모두 지정가"를 그대로 적용하면 손실 상한이 사라진다. 기본 정책은 다음과 같다.

1. 손절은 `STOP_LOSS_LIMIT`(지정가 = 손절가에서 설정한 여유폭만큼 불리한 쪽)로 건다.
2. N초(설정값) 안에 체결되지 않으면 지정가를 따라 내리며 재주문한다(chase). 재주문 횟수와 간격은 설정값이다.
3. 그래도 체결되지 않고 손실이 위험 한도를 넘으면 **비상 시장가 청산 하나만 예외로 허용**한다. 이 예외는 기본 켜짐이고, 발생할 때마다 기록하며 화면에 표시한다. 끄는 설정을 두되, 끄면 "손실 상한 없음" 경고를 띄운다.

이 정책을 계약에 동결하고 백테스트, 모의, 실전이 같은 함수를 쓰게 한다(`ctExitStep` 방식과 같다).

### 3.3 백테스트·모의 체결 모델 (가장 중요)

현재 천장 측정의 지정가 모델은 "결정 봉 종가에 지정가, 다음 봉이 **닿으면** 체결"이라 체결률 96~99%의 관대한 상한이었다(`ct-ceiling-2026-10-15-execution.md`). 실제로는 대기열 순서와 역선택 때문에 그보다 나쁘다. 새 계약은 다음을 따른다.

- **체결 조건:** 매수 지정가는 이후 봉의 저가가 지정가보다 **엄격히 낮을 때만**(관통) 체결한다. 닿기만 한 경우(`low == limit`)는 기본적으로 미체결로 본다. 관통 폭 기준(틱 수)은 설정값으로 두고 계약에 동결한다. 매도는 대칭으로 처리한다.
- **유효 시간:** 지정가 주문은 K봉(설정값) 안에 체결되지 않으면 취소한다. 미체결 신호는 거래로 세지 않고 `unfilled`로 기록한다. 체결률을 결과에 보고한다.
- **역선택:** 체결된 거래와 미체결 신호의 이후 수익을 비교해 보고한다. 지정가는 "가격이 불리하게 갈 때 더 잘 체결된다"는 편향이 있다.
- **비용:** 지정가 체결 다리에는 maker 요율, 3.2의 비상 시장가 다리에는 taker 요율과 측정 충격(p90)을 붙인다. 비용 2배 스트레스는 그대로 유지한다.
- **모의 체결:** Binance 실시간 호가와 체결 스트림으로 같은 규칙(관통 체결)을 적용한다. 백테스트와 모의가 같은 함수를 쓴다.
- 새 의미는 **새 엔진·비용 프로필 버전**으로 낸다(예: `binance-spot-usdt` v2 `execution: limit`, 선물은 `binance-usdm` v1). 이전 계약은 저장된 값으로 같은 결과를 내야 한다.

### 3.4 실전 안전

- `BINANCE_TRADING_DISABLED=true` 잠금을 그대로 유지한다. 이 작업에서 **실주문, 테스트 주문 이외의 주문, 레버리지·마진 모드·포지션 모드 변경, 이체, 차입을 호출하지 않는다.**
- 주문 경로 검증은 `/api/v3/order/test`(체결 증거가 아님을 명시)와 fixture 테스트로 한다. 테스트넷 키가 있으면 테스트넷에서 지정가 수명주기(제출 → 부분 체결 → 취소 → 대사)를 확인하고, 없으면 "테스트넷 미검증"이라고 보고한다.
- 주문 의도 장부(`lib/ct-order-intents-store.ts`)가 작성만 되고 호출처가 없다고 기록돼 있다. 지정가 주문은 대기 시간이 길어 재시작·타임아웃 대사가 중요하므로 이 장부를 실제 경로에 연결한다.

## 4. 그 밖에 Binance로 맞출 것

- 호가 샘플러(`scripts/data/measure-orderbook.mjs`, 테이블 `ct_orderbook_samples`)는 Binance만 수집한다. 선물 호가 측정을 추가한다(이전 측정은 선물 호가를 현물로 근사했다).
- Settings의 데이터 다운로드, coverage, 품질 보고는 Binance Spot(BTC, ETH, SOL)과, 필요하면 USDⓈ-M 1분봉(`scripts/data/download-binance-um-klines.py`)만 둔다.
- 천장 측정 스크립트의 기본 시나리오에서 Upbit을 뺀다(플래그로만 켬). 지정가 시나리오는 3.3의 관통 체결 모델로 다시 정의한다. **천장 측정을 다시 돌리는 것은 이 작업 범위가 아니다.** 실행 방법만 문서에 남긴다.
- CT·T 설계자 시스템 프롬프트에 체결과 비용 설명이 있다면, 기존 고정 바이트(테스트로 SHA가 고정된 상수)를 고치지 말고 **새 `traderTools`/정책 버전**으로 낸다(`docs/ct.md`의 기존 관례).

## 5. 검증

1. 변경 전에 `npm run lint`와 `npm test` 결과를 기록한다(기존 실패가 있을 수 있다). 변경 후 새로 생긴 실패만 고친다.
2. 새 테스트: Upbit 플래그 꺼짐/켜짐, 과거 Upbit 기록 재현, 골든 해시 불변, 관통 체결·미체결·유효 시간 만료, 비상 시장가 예외, maker/taker 비용 다리, 계정 요율 `max` 동결, 필터 반올림.
3. 실제 읽기 스모크: `scripts/research/binance-read-smoke.ts` 방식으로 계정 요율 엔드포인트 두 개를 GET한다(키 값과 금액은 출력하지 않는다).
4. 화면 확인: `npm run local` → http://127.0.0.1:3000(이미 떠 있으면 그것을 쓴다). CT·T·전략 대시보드·Settings에서 Upbit이 보이지 않는지, 비용 표에 maker/taker와 출처가 보이는지, 현물 지정가에서 수수료가 줄지 않는다는 문구가 있는지 확인한다.
5. 실제 연구 1회: CT 코인 기본값(BTCUSDT, 365일)으로 끝까지 실행해, 새 계약에 비용 프로필 v2·체결 방식·체결률이 기록되는지 확인한다. 결과의 수익성은 판단 대상이 아니다.

## 6. 동시 작업과의 충돌

UI 정리 작업(지시서 B, `docs/prompts/ui-polish-apple-taste.md`)이 같은 화면 파일을 건드린다. 이 작업은 **로직과 서버 거부가 핵심**이므로 화면 쪽 변경은 최소한으로 한다. 선택지를 숨기고 비용 표에 열을 추가하는 정도만 하고, 배치와 스타일 개편은 B에 맡긴다.

## 7. 문서와 보고

- `docs/binance-api.md`의 구현 상태 표, `docs/ct.md`의 비용 프로필 절, `docs/t.md`, `docs/local-runtime.md`를 갱신한다. 수수료는 출처와 확인일을 함께 적는다.
- 완료 보고: 바꾼 파일, 새 프로필·엔진 버전, 테스트 전후 결과, 계정 실제 요율(값은 공개 수수료와 같은지 여부만), 확인하지 못한 것(테스트넷 등).
- 커밋, 푸시, 배포는 하지 않는다. 소유자가 따로 지시한다.
