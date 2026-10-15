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

입력 35,820자(약 23,880토큰) · 출력 상한 8,000토큰 · 예상 비용 $0.0039 · 한도 확인용 예약 $0.0122
호출 완료 · 17.7초 · 입력 14659토큰 · 출력 1323토큰 · 비용 $0.0021 (누적 $0.0021)

저장된 교훈 9개 · 거부 0개 · dead를 weak로 낮춤 0개

| 계열 | 판정 | 원인 | 교훈 | 아직 안 본 변형 | 근거 항목 수 |
| --- | --- | --- | --- | --- | --- |
| mean_reversion | weak | fails_stress | 투매·범위 하단·저점 지지 반등은 여러 구조에서 비용 후 우위를 보이지 못했고, 개발 후보도 표본·시기 집중과 비용·진입 지연 스트레스에 실패했다. | 시간 창을 명시한 투매 반등 변형은 아직 후보에서 확인되지 않았다. | 7 |
| breakout | weak | no_edge_after_cost | 고점 돌파와 실패 저점 이탈 반전은 여러 구조에서 기준선보다 나쁘거나 비용 후 음수였으며, 일부는 표본 부족과 시기 집중으로 판단이 제한됐다. | 특정 시간 창에 한정한 돌파 변형은 아직 후보에서 확인되지 않았다. | 6 |
| trend_following | dead | no_edge_after_cost | 추세 지속과 추세 속 눌림 매수는 모멘텀·상위 추세·저변동 필터 등 서로 다른 구조에서 비용 후 우위를 보이지 못했다. | 관리형 청산을 결합한 추세 추종 변형은 아직 후보로 확인되지 않았다. | 7 |
| volatility_regime | weak | no_edge_after_cost | 변동성 수축 뒤 돌파와 고변동 과매도·모멘텀은 서로 다른 변동성 구조에서도 비용 후 우위를 보이지 못했고, 일부는 표본 부족이나 시기 집중이었다. | 변동성 단위를 사용한 변형은 아직 후보에서 확인되지 않았다. | 5 |
| time_seasonality | weak | fails_stress | 세션 모멘텀과 시간대 계절성은 창 확장과 개발 후보에서 비용 후 우위를 보이지 못했고, 후보는 시기 집중과 실행 스트레스에도 실패했다. | — | 4 |
| liquidation_cascade | weak | no_edge_after_cost | 거래량 급증 급락 뒤 반등은 단일 청산 꼬리와 추세 국면 필터를 포함한 구조에서도 비용 후 우위를 보이지 못했다. | 시간 창을 명시한 청산 캐스케이드 변형은 아직 후보에서 확인되지 않았다. | 3 |
| levels_gaps | weak | no_edge_after_cost | VWAP·전일 고저가·당일 시가와 오프닝 레인지의 이탈·회복 변형은 기준선 대비 개선이 없거나 비용 후 음수였고, 일부는 표본도 부족했다. | 변동성 단위로 수준 이탈을 정의한 변형은 아직 후보에서 확인되지 않았다. | 6 |
| holding_overnight | weak | no_edge_after_cost | 일간 추세 추종과 급락 뒤 반전 보유는 서로 다른 일간 신호에서도 비용 후 우위를 보이지 못했다. | 관리형 청산을 결합한 익일 보유 변형은 아직 후보로 확인되지 않았다. | 3 |
| other | weak | overfit_by_search | 다수 특징으로 큰 움직임이나 방향을 가르는 규칙은 변동성 효과와 불안정한 트리 잎에 의존했고, 비용 차감 후 우위가 확인되지 않았다. | — | 4 |

### 근거 대조(사람이 확인)
- **mean_reversion** (weak) · 계열 항목 28개 · 서로 다른 구조 21개 · 최고 등급 development_failed · 근거 id 실존 7/7 · 수치 패턴 없음
- **breakout** (weak) · 계열 항목 8개 · 서로 다른 구조 7개 · 최고 등급 rejected_in_training · 근거 id 실존 6/6 · 수치 패턴 없음
- **trend_following** (dead) · 계열 항목 17개 · 서로 다른 구조 13개 · 최고 등급 rejected_in_training · 근거 id 실존 7/7 · 수치 패턴 없음
- **volatility_regime** (weak) · 계열 항목 7개 · 서로 다른 구조 6개 · 최고 등급 rejected_in_training · 근거 id 실존 5/5 · 수치 패턴 없음
- **time_seasonality** (weak) · 계열 항목 4개 · 서로 다른 구조 4개 · 최고 등급 development_failed · 근거 id 실존 4/4 · 수치 패턴 없음
- **liquidation_cascade** (weak) · 계열 항목 3개 · 서로 다른 구조 3개 · 최고 등급 rejected_in_training · 근거 id 실존 3/3 · 수치 패턴 없음
- **levels_gaps** (weak) · 계열 항목 11개 · 서로 다른 구조 11개 · 최고 등급 rejected_in_training · 근거 id 실존 6/6 · 수치 패턴 없음
- **holding_overnight** (weak) · 계열 항목 3개 · 서로 다른 구조 2개 · 최고 등급 rejected_in_training · 근거 id 실존 3/3 · 수치 패턴 없음
- **other** (weak) · 계열 항목 7개 · 서로 다른 구조 5개 · 최고 등급 rejected_in_training · 근거 id 실존 4/4 · 수치 패턴 없음

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

입력 18,471자(약 12,314토큰) · 출력 상한 8,000토큰 · 예상 비용 $0.0027 · 한도 확인용 예약 $0.0087
호출 완료 · 14.8초 · 입력 7372토큰 · 출력 1100토큰 · 비용 $0.0013 (누적 $0.0034)

저장된 교훈 6개 · 거부 0개 · dead를 weak로 낮춤 0개

| 계열 | 판정 | 원인 | 교훈 | 아직 안 본 변형 | 근거 항목 수 |
| --- | --- | --- | --- | --- | --- |
| mean_reversion | weak | no_edge_after_cost | 평균회귀 계열은 급락 반등과 장중 과매도 매수에서 기준선 우위가 없거나 비용 후 음수였고, 표본 부족과 홀드아웃 불안정 사례도 있어 근거가 혼재한다. | 관리형 청산을 적용한 평균회귀 변형은 아직 후보에 없다. | 6 |
| trend_following | weak | no_edge_after_cost | 추세 추종 계열의 눌림과 모멘텀 변형에서 순평균 열위가 반복됐고 일부는 이벤트 부족이나 검증 불가로 판단이 제한돼 계열 전체의 실패를 단정하기 어렵다. | 시간 창을 명시한 추세 추종 변형은 아직 후보에 없다. | 6 |
| volatility_regime | weak | no_edge_after_cost | 변동성 수축 뒤 돌파와 고변동 국면의 압축 돌파 모두 비용을 넘지 못했지만 시도 구조가 제한적이어서 계열 전체의 결론으로 보기 어렵다. | 변동성을 ATR 단위로 정규화한 돌파 변형은 아직 후보에 없다. | 2 |
| breakout | dead | no_edge_after_cost | 돌파 계열은 여러 구조에서 비용 후 열위가 반복됐고 개발 단계 후보도 비용·지연·손절 스트레스에 실패해 이 보드에서 우위가 확인되지 않았다. | 시간 창을 제한한 돌파 변형은 아직 후보에 없다. | 5 |
| liquidation_cascade | weak | sample_too_small | 거래량 동반 급락 뒤 반등은 완화 조건에서 기준선과 비슷했지만 끝단 효과의 표본이 부족해 청산 연쇄 반전의 유효성을 판단하기 어렵다. | 관리형 청산을 적용한 급락 반등 변형은 아직 후보에 없다. | 1 |
| levels_gaps | dead | no_edge_after_cost | 시초 범위·갭·VWAP·전일 고저점 변형에서 비용 후 열위가 반복됐고 개발 단계 후보도 비용·지연·손절 스트레스에 실패해 이 보드에서 우위가 확인되지 않았다. | ATR 단위로 정규화한 수준 이탈 조건은 아직 후보에 없다. | 17 |

### 근거 대조(사람이 확인)
- **mean_reversion** (weak) · 계열 항목 6개 · 서로 다른 구조 5개 · 최고 등급 rejected_in_training · 근거 id 실존 6/6 · 수치 패턴 없음
- **trend_following** (weak) · 계열 항목 6개 · 서로 다른 구조 5개 · 최고 등급 rejected_in_training · 근거 id 실존 6/6 · 수치 패턴 없음
- **volatility_regime** (weak) · 계열 항목 2개 · 서로 다른 구조 2개 · 최고 등급 rejected_in_training · 근거 id 실존 2/2 · 수치 패턴 없음
- **breakout** (dead) · 계열 항목 5개 · 서로 다른 구조 4개 · 최고 등급 development_failed · 근거 id 실존 5/5 · 수치 패턴 없음
- **liquidation_cascade** (weak) · 계열 항목 1개 · 서로 다른 구조 1개 · 최고 등급 rejected_in_training · 근거 id 실존 1/1 · 수치 패턴 없음
- **levels_gaps** (dead) · 계열 항목 17개 · 서로 다른 구조 16개 · 최고 등급 development_failed · 근거 id 실존 17/17 · 수치 패턴 없음

총 모델 비용 $0.0034 / 한도 $0.50
