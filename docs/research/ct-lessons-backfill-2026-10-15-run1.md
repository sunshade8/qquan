# 소급 증류 실행 · 2026-10-15
DB /Users/woojinpark/.qquan/state/research.sqlite · 소유자 124708b7 · 모델 gpt-6-luna(입력 $0.1/백만 · 출력 $0.5/백만) · 한도 $0.50 · 입력 상한 100,000자

## 코인 · 1분봉 항목 88개
`other` 비율 8.0% (기준 30% 이하)

| 계열 | 항목 | 서로 다른 구조 | 최고 등급 | dead 허용 |
| --- | --- | --- | --- | --- |
| 평균 회귀 · 급락·과매도 반등 (mean_reversion) | 28 | 21 | development_failed | 가능 |
| 돌파 · 범위·고점·저점 (breakout) | 8 | 7 | rejected_in_training | 가능 |
| 추세 추종 · 모멘텀 · 추세 속 눌림 (trend_following) | 17 | 13 | rejected_in_training | 가능 |
| 변동성 수축·확대·국면 (volatility_regime) | 7 | 6 | rejected_in_training | 가능 |
| 시간대 · 요일 계절성 (time_seasonality) | 4 | 4 | development_failed | 가능 |
| 청산 연쇄 (liquidation_cascade) | 3 | 3 | rejected_in_training | 가능 |
| 기준 가격 · 갭 (VWAP·전일 고저·시가 범위) (levels_gaps) | 11 | 11 | rejected_in_training | 가능 |
| 전일 → 다음 날 보유 (holding_overnight) | 3 | 2 | rejected_in_training | 가능 |
| 기타 (other) | 7 | 5 | rejected_in_training | 가능 |

입력 33,124자(약 22,083토큰) · 출력 상한 8,000토큰 · 예상 비용 $0.0037 · 한도 확인용 예약 $0.0116
호출 완료 · 25.2초 · 입력 15021토큰 · 출력 2007토큰 · 비용 $0.0025 (누적 $0.0025)

저장된 교훈 9개 · 거부 0개 · dead를 weak로 낮춤 0개

| 계열 | 판정 | 원인 | 교훈 | 아직 안 본 변형 | 근거 항목 수 |
| --- | --- | --- | --- | --- | --- |
| trend_following | weak | no_edge_after_cost | 추세 지속과 상승 추세 속 눌림 매수는 여러 시간척도와 조건에서 학습 구간의 비용을 넘지 못했으나, 모두 초기에 기각되어 가족 전체의 실패를 확정하진 못한다. | — | 4 |
| mean_reversion | weak | sample_too_small | 투매 반등과 범위·저점 지지 매수는 비용 부담이나 시기 집중, 표본 부족으로 살아남지 못했다; 일부는 초기에 기각되어 평균회귀 가족 전체의 실패를 뜻하진 않는다. | — | 3 |
| breakout | weak | sample_too_small | 고점 돌파와 실패 저점 이탈 반전은 비용 후 성과가 약하거나 시기 집중·표본 부족으로 기각됐지만, 초기 탈락만으로 돌파 가족 전체를 단정할 수 없다. | — | 3 |
| volatility_regime | weak | no_edge_after_cost | 변동성 수축 뒤 돌파와 고변동 과매도 반등은 학습 구간에서 비용 후 우위를 보이지 못했으며, 일부 조건은 표본 부족이나 시기 집중에도 걸렸다. | — | 3 |
| levels_gaps | weak | no_edge_after_cost | VWAP·전일 고저가·오프닝 레인지의 이탈과 회복은 기준선 대비 개선이 없거나 비용 후 음수였고, 일부 변형은 표본도 부족했다. | — | 3 |
| liquidation_cascade | weak | no_edge_after_cost | 거래량 급증 급락 뒤 반등과 추세 국면 필터는 모두 비용을 넘는 결과를 보이지 못해, 청산 꼬리만으로 매수 우위를 설명하기 어렵다. | — | 3 |
| holding_overnight | weak | no_edge_after_cost | 일간 상승 추세 추종과 급락 뒤 반전 보유는 여러 청산 구조에서 비용 후 음수였고 기준선보다도 나빴다. | — | 3 |
| time_seasonality | weak | no_edge_after_cost | 세션 창을 넓힌 모멘텀과 UTC 시간대·펀딩 시각 효과는 비용 후 우위를 보이지 못했고, 개장 모멘텀 후보도 개발 구간에서 실패했다. | — | 3 |
| other | weak | overfit_by_search | 다수 특징으로 큰 움직임이나 방향을 가르는 규칙은 변동성 효과와 불안정한 잎에 의존했고, 비용 차감 후 학습·홀드아웃 우위가 확인되지 않았다. | — | 3 |

### 근거 대조(사람이 확인)
- **trend_following** (weak) · 계열 항목 17개 · 서로 다른 구조 13개 · 최고 등급 rejected_in_training · 근거 id 실존 4/4 · 수치 패턴 없음
- **mean_reversion** (weak) · 계열 항목 28개 · 서로 다른 구조 21개 · 최고 등급 development_failed · 근거 id 실존 3/3 · 수치 패턴 없음
- **breakout** (weak) · 계열 항목 8개 · 서로 다른 구조 7개 · 최고 등급 rejected_in_training · 근거 id 실존 3/3 · 수치 패턴 없음
- **volatility_regime** (weak) · 계열 항목 7개 · 서로 다른 구조 6개 · 최고 등급 rejected_in_training · 근거 id 실존 3/3 · 수치 패턴 없음
- **levels_gaps** (weak) · 계열 항목 11개 · 서로 다른 구조 11개 · 최고 등급 rejected_in_training · 근거 id 실존 3/3 · 수치 패턴 없음
- **liquidation_cascade** (weak) · 계열 항목 3개 · 서로 다른 구조 3개 · 최고 등급 rejected_in_training · 근거 id 실존 3/3 · 수치 패턴 없음
- **holding_overnight** (weak) · 계열 항목 3개 · 서로 다른 구조 2개 · 최고 등급 rejected_in_training · 근거 id 실존 3/3 · 수치 패턴 없음
- **time_seasonality** (weak) · 계열 항목 4개 · 서로 다른 구조 4개 · 최고 등급 development_failed · 근거 id 실존 3/3 · 수치 패턴 없음
- **other** (weak) · 계열 항목 7개 · 서로 다른 구조 5개 · 최고 등급 rejected_in_training · 근거 id 실존 3/3 · 수치 패턴 없음

## 주식 · 1분봉 항목 37개
`other` 비율 0.0% (기준 30% 이하)

| 계열 | 항목 | 서로 다른 구조 | 최고 등급 | dead 허용 |
| --- | --- | --- | --- | --- |
| 평균 회귀 · 급락·과매도 반등 (mean_reversion) | 6 | 5 | rejected_in_training | 가능 |
| 돌파 · 범위·고점·저점 (breakout) | 5 | 4 | development_failed | 가능 |
| 추세 추종 · 모멘텀 · 추세 속 눌림 (trend_following) | 6 | 5 | rejected_in_training | 가능 |
| 변동성 수축·확대·국면 (volatility_regime) | 2 | 2 | rejected_in_training | 불가 |
| 청산 연쇄 (liquidation_cascade) | 1 | 1 | rejected_in_training | 불가 |
| 기준 가격 · 갭 (VWAP·전일 고저·시가 범위) (levels_gaps) | 17 | 16 | development_failed | 가능 |

입력 15,486자(약 10,324토큰) · 출력 상한 8,000토큰 · 예상 비용 $0.0025 · 한도 확인용 예약 $0.0081
호출 완료 · 22.0초 · 입력 6919토큰 · 출력 1567토큰 · 비용 $0.0015 (누적 $0.0040)

저장된 교훈 6개 · 거부 0개 · dead를 weak로 낮춤 0개

| 계열 | 판정 | 원인 | 교훈 | 아직 안 본 변형 | 근거 항목 수 |
| --- | --- | --- | --- | --- | --- |
| trend_following | weak | untestable_here | 추세 추종의 여러 형태가 학습 단계에서 순평균 열위나 이벤트 부족으로 탈락했지만, 대부분 후보 생성 전 제외라 이 보드에서 추세 추종 가족 전체의 실패를 입증하지는 않는다. | — | 4 |
| mean_reversion | weak | untestable_here | 급락 반등과 장중 과매도 매수는 기준선 대비 차이가 없거나 비용 후 음수였지만, 모두 학습 단계에서 탈락해 가족 전체의 실패로 단정할 수 없다. | — | 4 |
| volatility_regime | weak | no_edge_after_cost | 변동성 수축 뒤 돌파와 고변동일 압축 돌파 모두 비용을 넘지 못했지만, 학습 단계의 탈락만으로 변동성 국면 전략 전체의 실패를 확정할 수는 없다. | — | 2 |
| breakout | weak | no_edge_after_cost | 고점 돌파는 추세 필터를 더해도 악화됐고, 개발 구간 후보도 비용·지연·손절 민감도 관문을 넘지 못했지만 학습 단계 탈락은 가족 전체의 확정적 실패가 아니다. | — | 4 |
| liquidation_cascade | weak | sample_too_small | 거래량 동반 급락 뒤 반등은 완화 조건에서 기준선과 비슷했으나 표본이 부족하고 월별 결과도 엇갈려, 청산 연쇄 반전의 유효성을 판단하기 어렵다. | — | 1 |
| levels_gaps | weak | no_edge_after_cost | 시초 범위·갭·VWAP·전일 고점과 저점 기반 아이디어가 대체로 비용 후 열위였고, 개발 단계 후보도 관문을 통과하지 못했지만 학습 탈락만으로 가족 전체를 단정할 수 없다. | — | 4 |

### 근거 대조(사람이 확인)
- **trend_following** (weak) · 계열 항목 6개 · 서로 다른 구조 5개 · 최고 등급 rejected_in_training · 근거 id 실존 4/4 · 수치 패턴 없음
- **mean_reversion** (weak) · 계열 항목 6개 · 서로 다른 구조 5개 · 최고 등급 rejected_in_training · 근거 id 실존 4/4 · 수치 패턴 없음
- **volatility_regime** (weak) · 계열 항목 2개 · 서로 다른 구조 2개 · 최고 등급 rejected_in_training · 근거 id 실존 2/2 · 수치 패턴 없음
- **breakout** (weak) · 계열 항목 5개 · 서로 다른 구조 4개 · 최고 등급 development_failed · 근거 id 실존 4/4 · 수치 패턴 없음
- **liquidation_cascade** (weak) · 계열 항목 1개 · 서로 다른 구조 1개 · 최고 등급 rejected_in_training · 근거 id 실존 1/1 · 수치 패턴 없음
- **levels_gaps** (weak) · 계열 항목 17개 · 서로 다른 구조 16개 · 최고 등급 development_failed · 근거 id 실존 4/4 · 수치 패턴 없음

총 모델 비용 $0.0040 / 한도 $0.50
