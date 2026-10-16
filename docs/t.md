# T — 무료 모델로 돌리는 CT 연구 공간 (2026-10-16)

사이드바 `T`. CT의 **연구 에이전트 전체**(설계자 도구 루프, 측정 도구, 검정 장부, 독립 검토, 플레이북·교훈, 검증 탭)를
복제해 **freellmapi**(무료 티어 풀링 라우터, <https://github.com/tashfeenahmed/freellmapi>)의 모델로 돌린다. 기존 CT는 건드리지 않았다.

## 무엇이 복제됐고 무엇이 아닌가

- **복제 기준**: 커밋 `1b38143`의 CT(작업 트리의 미커밋 변경은 제외). `lib/ct-*.ts` → `lib/t-*.ts`, `app/ct-*.tsx` → `app/t-*.tsx`,
  `app/api/invest/ct/**` → `app/api/invest/t/**`. 엔진·DSL·게이트·비용 프로필은 그 시점의 CT와 같다. CT가 이후 바뀌어도 T는 따라가지 않는다(의도).
- **저장소 분리**: 모든 테이블이 `t_` 접두사(`t_generation_runs`, `t_session_messages`, `t_playbook` …). CT 연구와 섞이거나 서로 활성 작업 자리를 막지 않는다.
  CT의 연구 플레이북·교훈도 T에서는 보이지 않는다(T 자체의 기록만 쌓임).
- **연구 전용**: 모의·실전 운용(`ct-trading*`, 주문 의도, 운용 탭)은 복제하지 않았다. 주문 엔진이 둘이 되면 안 된다. 등록(`전략 등록`)은 `t_strategies`에만 남는다.
- **공유**: 시세 데이터(로컬 Parquet), 캘린더, `ct.css` 스타일, 데이터 동기 카드(`ct-data-sync`)는 CT와 같은 것을 쓴다.
- **웹 검색 미연결**: freellmapi 화면에는 "검색 키로 제공되는 WebSearch 도구"가 보이지만 이 키로 켜져 있는지 확인하지 못했고 T는 아직 쓰지 않는다. 그래서 CT의 선택 단계 "공개 접근법 검색"은 건너뛰고 "출처 없이 데이터로 설계"로 간다(CT가 검색 실패 때 가던 같은 경로).

## 모델 호출 (`lib/t-generation-llm.ts`)

freellmapi의 Anthropic 호환 `/v1/messages`를 Anthropic SDK(`baseURL`)로 호출한다. 설정은 `.dev.vars`의 `FREELLMAPI_URL`(기본 `http://127.0.0.1:31415`), `FREELLMAPI_KEY`.

- 설계자 턴: 도구 정의·메시지를 그대로 보내되 thinking/output_config/cache_control, 세션에 저장된 effort 전용 system 메시지, 이전 thinking 블록은 뺀다.
- 구조화 응답(총괄·분석·검토·교훈): 무료 모델에는 스키마 강제 디코딩이 없어 JSON Schema를 프롬프트에 싣고, 형식이 틀리면 오류를 알려 주고 최대 2번 고쳐 받는다(zod 검증).
- 실패 시: 역할의 순위 체인(배치 모델 → 차순위 4개 → 라우터 `auto`)을 호출 단위로 순서대로 시도한다. 핀한 모델이 503/404/429로 막혀도 `auto`가 받는다(2026-10-16 실측: `gemini-3.8-flash`가 503, `auto`는 응답).
- 비용: 실제 $0. 연구 예산(`budgetUsd`)은 **가상 단가 입력 $0.15 / 출력 $0.6 per 1M 토큰**으로 환산해 일의 양만 제한한다. `llm_usage`에는 기록하지 않는다.
- 429는 분 단위로 기다린다(최대 15분, 6회). 무료 한도는 UTC 자정에 초기화된다.

## 모델 배치 (`lib/t-free-models.ts`)

> **2026-10-17 변경: 모든 역할이 라우터의 `auto`만 쓴다**(`lib/t-generation-models.ts` `currentPlacements`/`placementChain`). LiveBench로 고른 `gemini-3.8-flash`를 고집하다가 그 모델 하나의 무료 한도가 바닥나 설계 턴이 429로 계속 대기했는데, 같은 시각 `auto`는 다른 모델(gemini-3.5-flash-lite)로 응답했다. 이제 라우터가 호출마다 한도가 남은 모델을 고르고, 실제 사용 모델(`x-routed-via`)이 호출 기록 `calls[].model`에 남는다. 아래 LiveBench 배치 규칙은 참고용으로만 남아 있다. 검토자가 설계자와 같은 모델일 수 있다(화면에 명시).

모델 목록은 매번 라우터의 `/v1/models`에서 읽는다(5분 캐시, 화면의 "모델 다시 불러오기"). 키가 없는 모델(`needsKey`)은 제외한다. 배치는 LiveBench 2.0(2026-10-14) 점수로 한다.

| 역할 | 기준(LiveBench 가중) |
| --- | --- |
| 설계자 (도구 루프, 도구 지원 모델만) | agentic 0.4 · coding 0.25 · reasoning 0.25 · data 0.1 |
| 위험 / 최종 검토 | reasoning 0.5/0.45 · data 0.3/0.4 · research 0.2/0.15 |
| 총괄 | research 0.4 · reasoning 0.3 · data 0.3 |
| 자료 분석 / 교훈 | overall(+data 또는 reasoning) |

규칙: 설계자부터 배정하고, 같은 모델이 여러 역할을 맡을수록 감점해 무료 한도(모델별·일별)를 나눠 쓴다. 검토자는 설계자와 **다른 회사 계열**을 우선하고, 계열이 하나뿐이면 **다른 모델**만 강제한다(같은 모델 자기 검토 금지).
LiveBench에 없는 모델(예: gemini-3.6/3.5)은 점수 없는 모델 뒤로 밀린다.

**지금(2026-10-16) 제공되는 모델은 Google 계열뿐**(262개 중 20개 사용 가능; 나머지는 키 필요). 그래서 검토 독립성은 CT(설계 OpenAI/Anthropic ↔ 검토 반대편)보다 약하다. 화면 "모델 배치" 카드가 이를 명시한다.
DeepSeek V4.1 Flash(agentic 43.8, 코딩 85.4)·Qwen3.8 Flash·GLM-5.3 Flash 키를 freellmapi에 넣으면 다음 연구부터 설계자가 DeepSeek으로, 검토자가 Google로 갈라진다(재시작 불필요).

## 연속 연구 (2026-10-17)

T는 freellmapi 무료 쿼터(월 토큰 한도, 공급자가 끊을 때까지)로 돈다. 그래서 프로젝트 안에서는 한도를 두지 않는다.

- **예산 무제한**: `budgetUsd` 기본값이 `T_UNLIMITED_BUDGET_USD`(가상 $100,000)라 예산으로 끝나는 일은 없다. 한 연구는 여전히 설계 세션 3회·후보·활성 시간 한도(`ct-pattern` 정책)로 끝난다 — 실제로 $8 연구도 예산이 아니라 "설계 세션 한도"로 끝났다.
- **연속 연구**(`lib/t-loop.ts`, 시작 카드 "연구 방식" 기본값): 러너가 실행 중인 T 연구가 없을 때마다 확인해, 끝난 연구(완료·복구 불가 실패)는 1분 뒤 같은 설정으로 다음 연구를 만들고(같은 판 반복 사유는 자동), 중단된 연구(429·라우터 장애·출력 한도)는 10분 뒤 저장된 단계에서 재개한다. 3분 안에 끝난 연구 뒤에는 15분 쉰다.
- **같은 판은 총괄이 판단**: CT와 같은 `ctResolveBoard`(docs/ct.md「판 서명과 재실행 규칙」 2026-10-17). 연속 연구의 다음 실행은 보통 같은 판이므로, 매번 총괄 모델이 플레이북·교훈을 읽고 앞선 실행이 가지 않은 연구 방향을 정한다. 사람이 사유를 적을 일은 없다.
- 최종 구간은 두 번 열 수 없으므로(t_exposure) 같은 종목이 막히면 같은 시장의 다른 종목(코인: BTC/ETH/SOL, 주식: NVDA·TSLA·AMD·AAPL·MSFT·META·AMZN·GOOGL·SPY·QQQ 순)으로 넘어간다. 새 연구를 만들지 못하면 10분 뒤 다시 시도한다(`t_loop.note`에 사유).
- 멈추기: 화면의 "연속 연구 중지"(진행 중 연구는 끝까지), 취소, 또는 일시정지(사용자 일시정지는 자동 재개하지 않음).
- 필요: `npm run local`(앱 + 러너)과 freellmapi가 켜져 있고 Mac이 잠들지 않아야 한다(`caffeinate -dimsu`). CT 코드·테이블·러너는 바뀌지 않았다.

## 실행

- 앱: `npm run local`(러너 포함). 러너(`scripts/trading-runner.mjs`)가 `/api/invest/t`를 CT와 같은 방식으로 한 단계씩 진행한다.
- 필요: freellmapi 서버(`npx freellmapi …`)가 `FREELLMAPI_URL`에서 켜져 있어야 한다.
- 화면: 사이드바 `T` → 상단 "모델 배치" → CT와 같은 연구 시작 카드. 기본 예산 선택지(8/16/24)는 CT와 같지만 가상 달러다.

## 한계 (정직하게)

- 무료 모델의 도구 사용·긴 문맥 추론은 Opus 5.5보다 약하다. LiveBench agentic이 Opus 5.5 85.0 대 Gemini 3.8 Flash 30.1이다. 이 공간은 "같은 판에서 무료 모델이 어디까지 가는가"를 싸게 보는 실험이지, CT 결과의 대체물이 아니다. 통과 전략이 나와도 CT의 독립 검토를 다시 거쳐야 신뢰할 수 있다.
- 설계자 세션은 요약 사고(thinking) 없이 돌아간다(무료 모델은 thinking 블록을 내지 않음).
- freellmapi의 한도·모델은 매일 바뀐다. 같은 연구를 다른 날 돌리면 다른 모델이 설계자일 수 있다. 호출마다 실제 모델이 연구 기록(`calls[].model`)에 남는다.
