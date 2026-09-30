# 토스증권 Open API — 능력, 제한, 수수료 (에이전트 필독)

이 문서는 **Claude Code와 Codex가 같은 실수를 반복해서** 만들었다. 토스 API로 무엇이 되고
안 되는지, 요율과 제한이 뭔지는 아래 표를 먼저 확인하고 코드를 짜라. 실제 코드
(`lib/toss-orders.ts`, `lib/toss-order-shapes.ts`, `lib/market-data.ts`, `lib/broker-costs.ts`,
`lib/surge-live.ts`)와 `openapi.tossinvest.com` 스펙을 확인한 결과이며, 추측이나 재조사가
아니라 실측(날짜 표기)이다. 새로 알아낸 게 있으면 여기부터 갱신할 것 — README.md 본문에만
적고 끝내지 말 것.

스펙 원본: `https://openapi.tossinvest.com/openapi-docs/latest/openapi.json`,
`https://developers.tossinvest.com/llms.txt`. **레포의 클라이언트 코드만 보고 "이 엔드포인트는
없다"고 단정하지 말 것** — `lib/market-data.ts`만 보면 시세 조회만 되는 걸로 보이지만, 같은
client-credentials 토큰으로 계좌·주문 API까지 전부 닿는다.

## 1. 자주 반복된 실수 (먼저 읽기)

1. **"토스는 시세 조회만 된다"는 틀렸다.** 실주문 API(`/orders`)가 있고 실제로 쓰고 있다
   (`lib/toss-orders.ts`). `market-data.ts`만 읽고 판단하지 말 것.
2. **"토큰을 새로 발급받아도 기존 토큰은 살아있다"는 틀렸다.** client-credentials 토큰을
   새로 발급하면 **이전 토큰이 즉시 폐기된다.** 스크립트에서 토큰을 함부로 재발급하면 소유자가
   돌려놓은 dev 서버의 세션이 끊긴다(앱은 401을 받으면 자동 재발급하므로 자연 복구되지만,
   불필요한 재발급 자체를 피할 것).
3. **주문 수량/가격은 전부 문자열이다.** 숫자를 그대로 보내면 스펙 위반. `String(quantity)`,
   `usLimitPrice()`처럼 항상 문자열로 변환해서 보낼 것.
4. **계좌·자산·주문 호출에는 전부 `X-Tossinvest-Account` 헤더가 필요하다** (`accountSeq`,
   `/accounts` 응답에서 얻음). 토큰만 있으면 된다고 가정하지 말 것.
5. **배포 환경(Cloudflare Worker)에서 토스 주문이 막히는 가장 흔한 원인은 IP 허용 목록이다.**
   로컬은 되는데 배포는 안 되면 십중팔구 이거다 — 자격증명 문제로 오인하지 말 것 (§5).
6. **Massive의 실시간/EOD 스냅샷으로 토스 랭킹을 대체할 수 없다.** Massive Basic(EOD) 플랜은
   스냅샷에 `NOT_AUTHORIZED`를 반환한다(2026-09-29 실측). 실시간 후보 탐색은 토스
   `/rankings`가 유일한 경로다.
7. **`TOP_GAINERS`/`TOP_LOSERS`는 `realtime` 기간을 지원하지 않는다** (`400
   unsupported-ranking-duration`). 가장 빠른 옵션은 `1d`.
8. **RANKING 레이트리밋은 매우 빡빡하다.** 6개 보드를 한 번에 병렬로 읽으면 걸린다 — 반드시
   순차 호출 + 429 백오프.
9. **`clientOrderId`(멱등키)는 최대 36자, `[A-Za-z0-9_-]`만 허용, 10분간 유효.** UUID가 정확히
   맞는 길이다. 재전송해도 같은 주문이 반환되지, 중복 주문이 나지 않는다 — 이 성질에 의존해서
   재시도 로직을 짜도 된다.
10. **`ACCOUNT` 레이트리밋 그룹은 초당 1회.** `/accounts`를 페이지마다 호출하지 말고 캐시된
    값을 쓸 것 (`tossAccounts()`가 5분 캐시).

## 2. 인증

- `POST /oauth2/token`, client-credentials 그리듯 발급. `TOSS_CLIENT_ID` / `TOSS_CLIENT_SECRET`
  둘 다 필요.
- **새 토큰 발급 = 이전 토큰 즉시 폐기.** 토큰을 아무 때나 재발급하지 말 것.
- 401을 받으면 앱이 알아서 토큰을 무효화하고(`invalidateTossToken()`) 다음 호출에서 재발급한다
  — 수동 개입 불필요.
- `.dev.vars`는 gitignore 대상이라 **로컬 전용**이다. 배포 환경에는 `TOSS_CLIENT_ID` /
  `TOSS_CLIENT_SECRET`을 별도로 시크릿으로 넣어야 한다. 안 넣으면 `tossTradingStatus()`가
  `no_credentials` 원인으로 잡아낸다.
- 2026-09-29 기준 Claude 샌드박스에서 `/oauth2/token`은 200을 반환했다(2026-09-17에는 홍콩
  프록시 경유로 403이었음) — 환경마다 달라질 수 있으니 매번 가정하지 말고 재확인할 것.

## 3. 시세 / 캔들 (`lib/market-data.ts`)

| 엔드포인트 | 용도 | 비고 |
| --- | --- | --- |
| `GET /api/v1/prices` | 현재가 | `symbols` 콤마 구분 |
| `GET /api/v1/orderbook` | 호가창 | |
| `GET /api/v1/trades` | 최근 체결 | `count` |
| `GET /api/v1/candles` | 분봉 | 최대 200개/호출, 최신순(newest first), `before` 커서로 페이지네이션 |
| `GET /api/v1/market-calendar/US` | 정규장/프리/애프터 시간 | 당일·전영업일·다음영업일 |

- **분봉은 과거 조회가 된다 — 실시간 전용이 아니다** (2026-09-30 실측). `before`에 과거 시각을
  주면(`2024-10-15T20:00:00Z`처럼 `Z` 형식도 됨) 그 시점 이전 200개를 바로 돌려준다. 2024-10까지
  확인했다. `MARKET_DATA_CHART` 그룹 한도는 **초당 20회**(`x-ratelimit-limit: 20`,
  `x-ratelimit-reset: 1`) — Massive(분당 5회)의 약 240배라, 과거 분봉 대량 수집은 토스로 한다
  (`lib/surge-library-store.ts`가 초당 15회로 제한해서 급등락일 2년치를 몇 시간에 쌓는다).
- **`adjusted` 기본값은 `true`(수정주가)다.** 과거 세션을 재현할 때는 반드시 `adjusted=false` —
  수정주가는 나중 분할이 과거 가격을 바꾼다. `fetchTossMinuteCandles(..., { adjusted: false })`.
- 타임스탬프는 봉의 **종료** 시각(`16:00` 봉 = 15:59–16:00). 거래가 없는 분은 **빠진다**(소형주는
  200개가 200분보다 긴 구간을 덮음) — 분 수를 세서 시간을 가정하지 말 것.
- 같은 분의 종가는 Massive와 대부분 1틱 이내로 같지만 거래량은 통합 체결의 ~65%다(IPDN 실측).
  종목 코드는 **현재** 기준이라 과거에 같은 티커를 쓰던 다른 회사가 섞일 수 있다 — 과거 분봉을 쓸 때는
  Massive 일봉 종가와 대조해 불일치를 버릴 것(`buildSurgeDay`의 `mismatch`).
- 토스 분봉은 **24시간(데이마켓 포함) 연속**이다. 전일 정규장까지 거슬러 올라가려면 여러 페이지를
  넘겨야 한다 — 정규장만 필요한데 페이지 하나로 끝났다고 가정하지 말 것.
- 토스의 누적 거래량은 Massive(통합 거래소 합산)보다 작다. 같은 절대 임계값(예: 사건 정의의
  $1M 누적 거래대금)을 쓰면 토스 경로가 Massive보다 조건을 늦게 만족한다 — 이건 보수적인
  방향이라 괜찮지만, 두 경로 수치가 똑같이 나올 거라 기대하지 말 것.
- 캘린더는 **세션 시간만** 알려준다. 휴장일 자체나 반장일 여부에 대한 매크로 캘린더는 없다
  (Finnhub 제거 이후 이 앱 전체에서 사라진 기능. `lib/broker-costs.ts` 참고 없음 — 별도 문서
  [[qquan-data-providers]] 참고).

## 4. 랭킹 (`lib/surge-live.ts`, `GET /api/v1/rankings`) — 2026-09-22 실측

| 항목 | 값 |
| --- | --- |
| 타입 | `MARKET_TRADING_AMOUNT`, `MARKET_TRADING_VOLUME`, `TOP_GAINERS`, `TOP_LOSERS`, `TOSS_SECURITIES_TRADING_AMOUNT`, `TOSS_SECURITIES_TRADING_VOLUME` |
| 국가 | `US`, `KR` |
| 기간 | `realtime`, `1d`, `1w`, `1mo`, `3mo`, `6mo`, `1y` |
| 최대 행 수 | 100 |
| `TOP_GAINERS`/`TOP_LOSERS` 제한 | `realtime` 거부 → `unsupported-ranking-duration` (400). `1d`가 최단 |
| as-of 파라미터 | **없음.** `rankedAt` 타임스탬프만 있고 과거 특정 시점 조회 불가 — 실시간 화면이지 히스토리가 아니다 |
| US `tradingAmount` 단위 | **KRW로 환산되어 옴** (USD 아님) |
| 레이트리밋 | RANKING 그룹이 빡빡함 — 6개 보드 동시 호출 시 걸림. 순차 호출 + 429 시 `retry-after` 헤더 기반 백오프(최대 2회 재시도, `fetchRanking` 구현 참고) |
| 개장 전 동작 | `duration=1d`는 프리마켓의 소량 체결만으로 순위가 매겨짐 — 장 시작 전 순위를 신호로 쓰지 말 것 |
| 국가 필터링 | `marketCountry=US` 파라미터가 있어도 KRX 종목이 섞여 나올 수 있어 코드에서 `isUsListing`으로 한 번 더 걸러야 함 (6자리 숫자 또는 5자리+문자 코드는 KRX) |

## 5. 계좌 / 자산 (`lib/toss-orders.ts`)

| 엔드포인트 | 레이트리밋 그룹 | 비고 |
| --- | --- | --- |
| `GET /api/v1/accounts` | `ACCOUNT` — **초당 1회** | 5분 캐시(`tossAccounts()`), `BROKERAGE` 타입만 주문 가능. `TOSS_ACCOUNT_SEQ`로 특정 계좌 고정 가능 |
| `GET /api/v1/holdings` | | 보유 종목, `marketValue.amount.usd` |
| `GET /api/v1/buying-power?currency=USD\|KRW` | | 현금 매수 가능 금액 |
| `GET /api/v1/sellable-quantity?symbol=` | | **매도 가능 수량은 보유 수량과 다를 수 있다** (결제 미완료분 제외) — 매도 주문 전 반드시 확인 |
| `GET /api/v1/commissions` | | `marketCountry`별 수수료율 + `endDate`(프로모션 만료일, null 가능) |

- 모든 계좌/자산/주문 호출은 `X-Tossinvest-Account: {accountSeq}` 헤더 필수.

### IP 허용 목록 — 배포에서 가장 흔한 실패 원인

- WTS 앱 > 설정 > Open API > 허용 IP 관리에 등록된 주소가 아니면 **403**.
- 개발자 로컬 머신은 고정 IP라 등록하면 끝. **Cloudflare Worker는 Cloudflare 공유 IP 대역에서
  나가고 요청마다 달라질 수 있어 한 번 등록해도 durable하게 고치지 못한다.**
- 실질적 해법은 둘 중 하나: (a) 고정 IP를 가진 호스트를 앞에 두고 그걸 통해 토스를 호출, 또는
  (b) 등록된 주소에서 직접 주문 실행 스크립트를 돌리고 배포는 읽기 전용으로 둔다.
- `tossTradingStatus()`가 403을 `ip_allowlist` 원인으로 분류하고 그 요청이 나간 egress IP를
  `https://www.cloudflare.com/cdn-cgi/trace`로 조회해 알려준다 — "안 된다"로 끝내지 말고 이
  함수의 `egressIp`를 확인할 것.
- 원인 분류: `disabled`(킬스위치) / `no_credentials`(배포에 키 없음) / `ip_allowlist` /
  `auth`(401/토큰) / `permission`(403 forbidden) / `no_account`.

## 6. 주문 (`lib/toss-orders.ts`, `lib/toss-order-shapes.ts`)

| 엔드포인트 | 메서드 | 비고 |
| --- | --- | --- |
| `/api/v1/orders` | POST | 주문 생성. body: `clientOrderId`, `symbol`, `side`, `orderType`, `timeInForce`, `quantity`(string), `price`(string, LIMIT만) |
| `/api/v1/orders` | GET | 목록. `status=OPEN\|CLOSED`, `limit`, 커서 페이지네이션(`nextCursor`) |
| `/api/v1/orders/{orderId}` | GET | 단건 조회, 체결 정보 포함 |
| `/api/v1/orders/{orderId}/cancel` | POST | 취소 |

- **`LIMIT` + `timeInForce: "CLS"` = 종가지정가(LOC) 주문, 미국 주식 한정.** 이 앱의 기본 주문
  방식이다 — 백테스트가 다음 세션 종가 체결을 모델링하기 때문에 장중 시장가로 내면 백테스트가
  본 적 없는 가격에 체결된다. `TOSS_ORDER_MODE=market`으로 바꾸면 `MARKET` + `DAY`.
  트레이딩 대시보드(`lib/relay-engine.ts` 경로)는 marketable `LIMIT`/`DAY`를 쓴다(호가 ±
  `TRADING_LIMIT_BAND_PCT`, 기본 1%), 전략 탭의 60세션 백테스트 경로는 LOC/`TOSS_ORDER_MODE`를
  따른다 — **두 경로가 다른 주문 방식을 쓴다는 것을 혼동하지 말 것.**
- LOC 주문의 지정가 밴드(`TOSS_LOC_LIMIT_BAND_PCT`, 기본 3%)는 **체결가를 정하는 게 아니라**
  종가 경매가가 이 범위를 벗어나면 그냥 체결이 안 되게 막는 상한선이다. 너무 좁으면 조용히
  거래가 안 되고, 너무 넓으면 갭 종가에 백테스트가 못 본 가격으로 체결된다.
- 지정가 틱 규칙(`usLimitPrice`): $1 이상은 소수점 2자리, 미만은 4자리, **버림(truncate)** — 반올림 아님.
- `clientOrderId`는 멱등키. 최대 36자, `[A-Za-z0-9_-]`, 10분 유효 — 같은 의도를 재전송해도
  주문이 두 번 나가지 않는다.
- **쓰기(POST) 요청은 429 외에는 절대 재시도하지 않는다.** 애매한 실패 후 POST를 재전송하면
  주문이 두 번 나갈 수 있다 — 멱등키가 10분 동안만 보호해준다는 것도 기억할 것.
- 매도 주문 시 수량은 `sellable-quantity`로 클램프해야 한다(보유량과 다를 수 있음) — 안 하면
  이미 장부에 기록된 주문 의도가 422로 거부되고 상태가 꼬인다.

### 알려진 에러 코드 (`ERROR_HINTS`)

`insufficient-buying-power`, `insufficient-sellable-quantity`, `order-hours-closed`,
`order-type-not-allowed`(LOC 등을 장 마감 시간에 시도), `opposite-pending-order-exists`,
`price-out-of-range`, `prerequisite-required`(약관 동의 등 앱에서 처리 필요),
`account-restricted`, `stock-restricted`, `idempotency-key-conflict`(같은 키로 다른 내용
재전송), `forbidden`, `edge-blocked`(IP 허용 목록 문제 — §5).

## 7. 수수료 / 비용 (`lib/broker-costs.ts`)

**분기·프로모션에 따라 실제 요율이 바뀐다 — 아래 숫자를 그대로 인용하기 전에
`/api/v1/commissions`의 실시간 `commissionRate`와 `endDate`를 확인할 것.** 프로모션 요율은
만료일(`endDate`)이 있고, 만료되면 손익분기 승률이 올라간다.

| 항목 | 값 | 비고 |
| --- | --- | --- |
| 편도 수수료 (`feePerSidePct`) | 0.1% | 매수·매도 양쪽에 부과. `TOSS_FEE_PER_SIDE_PCT`로 재정의 가능 |
| SEC Section 31 수수료 (`secSellFeePct`) | 0.0008% | **매도에만** 부과, 매도 대금 기준 |
| FX 스프레드 (`fxSpreadPct`) | 0.1% | 거래마다가 아니라 **원화↔달러 환전 시에만** — 왕복 비용 계산에서 제외 |
| 가정 슬리피지 (`assumedSlippagePct`) | 0.03% | **추정치, 공시된 숫자 아님.** 유동성 높은 대형주·정규시간 기준. 소형주·개장 직후는 더 나쁨. `ASSUMED_SLIPPAGE_PCT`로 재정의 |
| 왕복 비용 (`roundTripPct`) | 편도×2 + SEC + 슬리피지 | |

- 중요한 건 %가 아니라 **`costInR`**(손절폭 대비 비용): 같은 수수료 체계가 손절 1%에서는
  0.23R, 손절 0.25%에서는 0.92R이 된다. **손절을 좁혀서 크게 베팅하는 전략은 비용 허들을
  조용히 4배로 키운다** — 손절폭을 줄이는 제안을 할 때 이 계산을 항상 같이 보일 것.
- `describeCosts()`가 그대로 인용 가능한 한 줄 요약을 만들어준다 — 숫자를 손으로 다시 계산하지
  말고 이 함수를 쓸 것.

## 8. 트레이딩 안전장치 (되돌리면 안 되는 설계)

- `TOSS_TRADING_DISABLED=true`는 키를 안 끊고도 모든 실주문을 거부하는 킬스위치.
- 전략은 **자신이 산 것만 팔 수 있다** — 실거래 게이트웨이에서 포지션은 (계좌 실보유 ∩ 전략
  유니버스 ∩ 이 전략 자체 장부)의 교집합이고, 그 외 계좌 내 보유분은 절대 건드리지 않는다.
- 주문 제출은 버튼과 별개의 명시적 확인을 요구한다 — 잘못 눌리거나 재생된 요청이 주문이 되지
  않도록.
- 정지 시퀀스는 3단계이며 **체결 확인까지** 끝나야 종료로 본다: 미체결 매수 취소 → 이 대시보드가
  산 수량만 매도 → 매도 체결 대기. 거부된 매도(장 마감 등)는 1분마다 재시도.

## 9. 관련 메모리 (다음 세션에서 참고)

- `[[qquan-data-providers]]` — Massive/Yahoo/Toss/SEC/FRED 역할 분담, IP 허용 목록 원인 분류
- `[[qquan-trading-dashboards]]` — 틱 아키텍처, 정지 시퀀스, 토큰 재발급 주의
- `[[qquan-surge-feature]]` — 랭킹 한계, 사건 정의, Massive 스냅샷 NOT_AUTHORIZED
