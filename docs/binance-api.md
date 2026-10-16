# Binance API — CT 구현용 조사 기록

확인일: 2026-10-16 (Asia/Seoul). 이 문서는 구현 지침과 조사 결과이며, 아래 기능이 이미 앱에 구현되었다는 뜻은 아니다. 사용자 결정은 **새 코인 연구·리플레이·모의·실전의 거래소를 Binance로 통일하고, 롱/숏·레버리지·상품/마진/포지션 모드를 지원 범위 안에서 선택**하는 것이다. 현물·롱 전용으로 제한하지 않는다.

## 앱 구현 상태 (2026-10-16 CT 통합 구현 기준)

| 기능/상품 | 구현 | 데이터 | 계정 권한 | 자동 테스트 | 실제 읽기 | 모의/테스트넷 | 실전 | 남은 제약 |
|---|---|---|---|---|---|---|---|---|
| 서명·필터·백오프 (`lib/binance-api.ts`) | 됨 | — | — | HMAC 벡터, Decimal 필터, µs kline, depth gap, 429/418 | 됨 | — | — | — |
| Spot 연구·리플레이 | 됨 | 1분 snapshot | 읽기 OK | 됨 | 됨 | 모의: Binance 호가 가상 체결 | 잠금(`BINANCE_TRADING_DISABLED`) | 테스트넷 키 없음 → 실체결·user stream 미검증 |
| Spot 실주문 어댑터 (`lib/binance-broker.ts`) | 어댑터(기존 대시보드 주문 장부·clientOrderId 경유). 상품별 주문 의도 장부 `lib/ct-order-intents-store.ts`는 작성만 됐고 호출처·테스트 없음 | — | `enableSpotAndMarginTrading=true` | fixture(잠금 시 네트워크 전 거부) | — | 미확인 | 잠금 | 테스트넷 자격증명 |
| Cross/Isolated Margin | 회계(차입·이자) 단위 | 없음 | `enableMargin=false` | 단위 | 계좌 읽기 OK | — | 차단 | 권한·역사 차입 자료 |
| USDⓈ-M | 회계·positionSide 파라미터·mark 위험 차단 | 없음(mark/funding 이력 미수집) | `enableFutures=true` | 단위 | 계좌·bracket·mark·funding 읽기 OK | — | 차단 | 상품 데이터·리플레이 연결 |
| COIN-M | inverse PnL 단위 | 없음 | 읽기 OK | 단위 | 계좌·bracket 읽기 OK | — | 차단 | 상품 데이터·리플레이 연결 |
| Options | premium·정산 단위 | 없음 | 계좌 401 | 단위 | 공개만 | — | 차단 | 권한·chain 이력 |
| Portfolio Margin/Pro | 없음 | 없음 | 401/400 | — | 실패 | — | 차단 | 계좌 모드·권한 |

"차단"은 연구 시작과 실전 모두 서버가 거부한다는 뜻이다(`assertCTCapability`). 읽기 스모크: `scripts/research/binance-read-smoke.ts`(키 값·금액은 출력하지 않음, 금융 변경 0건). 아래 절의 "기존 실행기에 아직 Binance 어댑터가 없다"는 조사 시점 기록이며, 지금은 Spot 어댑터가 있고 기본 잠금이다.

## 자격증명과 현재 확인 범위

- 프로젝트의 Git 제외 파일 `.dev.vars`에 `BINANCE_API_KEY`, `BINANCE_API_SECRET`을 저장했다. 파일 권한 0600, Git 추적 안 됨. 값은 이 문서에 없다.
- `BINANCE_TRADING_DISABLED=true`, `BINANCE_NETWORK=mainnet`. **저장/조회 성공은 실거래 활성화를 의미하지 않는다.** 기존 실행기에 아직 Binance 어댑터가 없으므로 새 코드가 이 잠금을 실제로 강제해야 한다.
- 로컬에서 GET만 호출했다. Spot 시간·계좌·API 권한, USDⓈ-M 시간·계좌 v3·BTCUSDT leverageBracket·commissionRate가 HTTP 200이었다. COIN-M 시간과 공개 시세용 호스트 시간도 HTTP 200이었다.
- API 권한 응답: `enableReading=true`, `enableSpotAndMarginTrading=true`, `enableFutures=true`, `ipRestrict=true`, `enableMargin=false`, `enablePortfolioMarginTrading=false`. 플래그 하나로 모든 주문 기능을 허용하지 말 것. 조회 시점·상품별 계좌 접근·종목 상태를 함께 확인한다.
- COIN-M의 서명 계좌 조회, Options, Portfolio Margin/Pro 실행 가능성은 이 작업에서 확인하지 않았다. 권한 미확인과 기능 미구현을 구분한다. Spot 계좌의 `canWithdraw`는 API 키의 출금 권한 증거가 아니다.
- 주문·차입·상환·자금 이체·레버리지 변경·마진 모드 변경·권한 변경은 호출하지 않았다. 키는 프롬프트, 브라우저, 오류 로그, URL 로그, 패키지, Sites 소스 번들에 넣지 않는다.
- 호스팅에는 키를 복제하지 않았다. 실제 주문은 승인된 IP의 로컬 실행기가 맡도록 구현한다. Sites는 인증된 제어·상태 표시 경로를 사용한다.

권한 조회 근거: [Wallet Account/API restrictions](https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/account).

## 공식 문서와 최신 변경

구현 직전에 변경 기록과 개별 엔드포인트를 다시 읽는다. 오래된 URL이 통합 API 페이지로 이동할 수 있다. `binance` GitHub 조직의 API 문서도 공식 원문이다.

| 대상 | 문서 |
|---|---|
| Spot REST·서명·오류·레이트리밋 | [General REST API](https://developers.binance.com/en/docs/products/spot/rest-api), [공식 REST 원문](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md) |
| Spot 주문 필터 | [Filters](https://github.com/binance/binance-spot-api-docs/blob/master/filters.md) |
| Spot 공개 스트림 | [WebSocket streams](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md) |
| Spot 계좌 스트림·인증 | [WebSocket API](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-api.md), [User data events](https://github.com/binance/binance-spot-api-docs/blob/master/user-data-stream.md) |
| Spot 수수료 | [Commission FAQ](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/commission_faq.md) |
| 과거 공개 데이터 | [Binance Public Data](https://github.com/binance/binance-public-data) |
| USDⓈ-M | [General info](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info), [시장 데이터](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data), [계좌](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account), [주문](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade) |
| COIN-M | [General info](https://developers.binance.com/en/docs/products/derivatives-trading-coin-futures/general-info), [공식 기능 색인](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/binance/references/futures-coin.md) |
| Margin | [Introduction](https://developers.binance.com/en/docs/products/margin-trading/Introduction), [차입·상환](https://developers.binance.com/en/docs/catalog/core-trading-margin-trading/api/rest-api/borrow-repay), [공식 기능 색인](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/binance/references/margin-trading.md) |
| Options | [시장 데이터](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-options/api/rest-api/market-data), [주문](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-options/api/rest-api/trade), [공식 기능 색인](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/binance/references/derivatives-options.md) |
| Portfolio Margin/Pro | [General info](https://developers.binance.com/en/docs/products/derivatives-trading-portfolio-margin/general-info), [PM 기능 색인](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/binance/references/derivatives-portfolio-margin.md), [Pro 색인](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/binance/references/derivatives-portfolio-margin-pro.md) |
| 선물·옵션 변경 기록 | [Changelog](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/change-log) |

2026-10-16 확인한 변경 중 특히 중요한 것:

- USDⓈ-M 레버리지 상한을 125로 고정하지 않는다. 2026-10-09 문서 수정에 따라 종목별 bracket의 `initialLeverage`와 실제 명목금액 구간을 읽는다.
- 2026-10-16부터 `/fapi/v1/income`, `/dapi/v1/income`의 `page`는 지원하지 않는다. 시간 범위와 중복 제거로 수집한다.
- 선물 체결 이력 조회 기간에는 보존 한도가 있다. 장기 복기를 위해 자체 이벤트 저장이 필요하다.

출처: [선물 변경 기록](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/change-log).

## 상품별 기능 지도

아래는 **호출·검증해야 할 기능**이다. Spot API 경로를 다른 상품에 문자열 치환해 재사용하지 않는다. 모든 상품에 같은 파라미터·주문 유형·TIF가 있다고 가정하지 않는다.

### Spot

- 메타데이터: `/api/v3/time`, `/api/v3/exchangeInfo`.
- 가격/봉/체결/호가: `/api/v3/klines`, `/api/v3/aggTrades`, `/api/v3/depth`, `/api/v3/ticker/bookTicker` 및 공개 스트림.
- 계좌/주문 대사: `/api/v3/account`, `/api/v3/order`, `/api/v3/openOrders`, `/api/v3/allOrders`, `/api/v3/myTrades`.
- 주문 제출/취소/테스트, 지원되는 주문 목록(OCO 등)을 별도 메서드로 구현한다. `/api/v3/order/test`는 체결 증거가 아니다.
- 현물 SELL은 보유 자산 처분이다. 빌리지 않은 자산을 음수 수량으로 만들어 숏을 흉내 내지 않는다.

근거: [Spot REST 원문](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md).

### USDⓈ-M Futures

- `fapi.binance.com`: exchangeInfo, 거래 가격 봉, mark/index 봉, premium index, funding 이력/정산 정보, OI, depth/체결, 계약 상태를 수집한다.
- 계좌 v3, positionRisk v3, leverageBracket, commissionRate, accountConfig, positionSide/dual, multiAssetsMargin, 주문·일반/조건부 미체결·체결·income·강제청산/ADL 기록을 대사한다. GET/POST 구분을 유지한다.
- 일반 주문은 `/fapi/v1/order`; 현재 조건부 SL/TP·trailing은 `/fapi/v1/algoOrder`의 별도 수명주기를 구현한다. algo 식별자와 실제 생성 주문 식별자를 연결한다.
- `side`, `positionSide`, `reduceOnly`, `closePosition`, 수량의 조합은 One-way/Hedge별 공식 제약을 검증한다. `reduceOnly`를 모든 모드에 일괄 첨부하지 않는다.
- leverage/marginType/position mode 변경은 계좌 상태를 바꾸는 별도 동작이다. 연구 화면 선택만으로 호출하지 않는다.

근거: [시장 데이터](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data), [계좌](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account), [주문·Algo](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade).

### COIN-M Futures

- `dapi.binance.com`의 해당 메타데이터·시세·mark/index·funding·계좌·주문·포지션·bracket·수수료·스트림 기능을 사용한다.
- 계약 수량, 계약 액면, 코인 증거금/결제, inverse 손익, 담보 평가를 별도로 모델링한다. USDⓈ-M의 수량 단위와 선형 손익 공식을 쓰지 않는다.
- 무기한/만기 계약, 계약 만료·정산·롤오버 정책을 구분한다. 연속선물 차트를 실제 주문할 계약으로 취급하지 않는다.

근거: [COIN-M general info](https://developers.binance.com/en/docs/products/derivatives-trading-coin-futures/general-info), [공식 COIN-M 기능 색인](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/binance/references/futures-coin.md).

### Margin

- 현물 기반 가격과 cross/isolated margin 계좌, 사용 가능 담보, 차입 가능 수량·한도, 부채·이자 이력, 수수료·주문 상태를 연결한다.
- `/sapi/v1/margin/borrow-repay`, `maxBorrowable` 및 현재 주문 API의 side-effect 옵션을 공식 명세에 맞게 사용한다. 자동 차입·상환은 주문 실패·부분체결·취소 뒤에도 부채가 남을 수 있는 상태로 모델링한다.
- 차입 가능 재고 없음, 권한 없음, 담보 부족을 별도로 보고한다. API 키 플래그만으로 숏 가능을 단정하지 않는다.

근거: [Margin 차입·상환](https://developers.binance.com/en/docs/catalog/core-trading-margin-trading/api/rest-api/borrow-repay), [공식 Margin 기능 색인](https://github.com/binance/binance-skills-hub/blob/main/skills/binance/binance/references/margin-trading.md).

### Options·Portfolio Margin

- Options는 계약 목록·만기·행사가·CALL/PUT·승수·mark/호가/봉·계좌·포지션·주문·체결·행사/정산·수수료를 연결한다. 매수/매도 권한을 따로 확인한다. 기초자산 방향과 옵션 계약의 매수/매도는 서로 다른 축이다.
- 옵션의 고정 레버리지 숫자를 선물처럼 만들지 않는다. 프리미엄, 계약 수, 증거금, delta/gamma/vega 등 상품에 맞는 노출과 위험을 표시한다.
- PM/Pro는 별도 계좌·위험 모드다. 이름만 cross로 바꾸어 지원했다고 보고하지 않는다. 계좌 전체 담보/부채/위험 조회와 상품별 라우팅, 다른 전략 노출을 포함한 위험 모델이 필요하다.
- 권한 또는 과거 데이터가 없는 기능은 `권한 필요`/`데이터 필요`로 표시한다. 어댑터·계산기 미구현은 `구현 미완료`이며 이를 외부 제약으로 위장하지 않는다.

근거: [Options market](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-options/api/rest-api/market-data), [Options trade](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-options/api/rest-api/trade), [Portfolio Margin](https://developers.binance.com/en/docs/products/derivatives-trading-portfolio-margin/general-info).

## 공통 구현 규칙

### 서명·네트워크·복구

현재 제공 키는 HMAC 방식으로 REST 서명 조회가 성공했다. 서버에서 인코딩한 요청 파라미터를 HMAC-SHA256으로 서명하고 `X-MBX-APIKEY`, 서버 시간 보정, 제한된 recvWindow를 사용한다. 상품별 mainnet/testnet 자격증명을 분리하고 공식 호스트 allowlist를 둔다. 임의 base URL에 비밀 헤더를 보내지 않는다.

동일 client id를 영구 멱등성 보장으로 가정하지 않는다. 자체 주문 의도 장부를 먼저 저장하고, 타임아웃·불명확한 5xx는 주문 상태 조회·스트림 대사로 해결한다. 미확인 상태에서는 새 노출을 막고 같은 주문을 맹목적으로 재전송하지 않는다. rateLimits/weight 헤더와 Retry-After로 속도를 제어하고 429/418에서 백오프한다.

근거: [Spot REST](https://developers.binance.com/en/docs/products/spot/rest-api), [Futures 일반 정보·503 처리](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info).

### 스트림

공개 시세와 개인 계좌 이벤트를 구분한다. Spot의 HMAC 키는 현재 `userDataStream.subscribe.signature` 경로를 검토하고, Ed25519 인증 세션이 필요한 `userDataStream.subscribe`와 혼동하지 않는다. 상품별 스트림 인증·갱신 방식을 독립적으로 구현한다. 오래된 Spot listenKey 구현을 그대로 이식하지 않는다.

공개 Spot 스트림은 연결 수명, ping/pong, 메시지/연결 한도가 있다. 로컬 depth는 REST snapshot과 diff update id 연속성을 확인하고 틈이 나면 재동기화한다. 재연결 후 계좌/주문 REST 대사도 한다. 이벤트 중복·역순·유실을 허용하는 저장 구조와 stale 차단을 둔다. WebSocket이 끊겼는데 최신 호가로 표시하지 않는다.

근거: [Spot WebSocket API](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-api.md), [Spot streams](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md), [계좌 이벤트](https://github.com/binance/binance-spot-api-docs/blob/master/user-data-stream.md).

### 비용·정밀도·데이터

Spot은 계좌/종목 commission의 standard/tax/special 및 할인 적용 여부를 읽고, 실제 체결의 수수료 자산을 장부에 남긴다. 선물·마진·옵션 수수료를 Spot 요율로 대신하지 않는다. 현재 요율을 과거에 실제 적용된 요율이라고 주장하지 말고 측정 시점과 가정을 기록한다.

가격/수량은 Decimal과 상품별 filters로 검증한다. PRICE_FILTER, LOT_SIZE, MARKET_LOT_SIZE, MIN_NOTIONAL/NOTIONAL, 가격 밴드, 계좌 제한 등 적용되는 필터를 처리한다. quantityPrecision은 stepSize의 대체물이 아니다. 반올림으로 주문 위험 한도를 넘기지 않는다.

과거 공개 데이터는 checksum을 확인하고 불변 snapshot으로 고정한다. Spot archive의 2025-01-01 이후 timestamp는 마이크로초다. REST/stream/archive 단위와 봉 끝 시각의 포함 여부를 정규화한다. Spot/futures, 거래 가격/mark/index, 결제 통화가 다른 데이터는 같은 symbol 문자열로 합치지 않는다. 연구 중 빠진 과거 값을 live API로 조용히 보충하지 않는다.

근거: [Commission FAQ](https://github.com/binance/binance-spot-api-docs/blob/master/faqs/commission_faq.md), [Filters](https://github.com/binance/binance-spot-api-docs/blob/master/filters.md), [Public Data](https://github.com/binance/binance-public-data).

## 구현 완료의 증거

상품/기능마다 공식 근거, 어댑터, 데이터 경로, 회계/리플레이, UI, 계약 테스트, 실제 읽기 확인 여부를 표로 남긴다. 테스트넷 체결은 운영환경 체결 품질의 증명이 아니며, 읽기 인증 성공은 주문 성공의 증명이 아니다. 실거래를 보내지 않고도 도달 가능한 검증을 모두 완료하고 외부 권한·데이터 제약은 정확히 보고한다.
