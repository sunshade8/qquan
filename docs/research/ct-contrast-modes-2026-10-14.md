# contrast_moves 세 대조군 비교 · BTCUSDT 학습 구간 2025-10-13~2026-05-20
라벨 k5 · m2 · 240봉 · 비용 1배(왕복 0.2000%) · 사건 952건 · 음성(손절 먼저) 사건 2976건 · 특징은 3ab2ad6c의 contrast 요청 8개와 같다. 모델 비용 $0.

## 대조군 `time` — 사건 952건 · 대조군 2856개 (사건당 3) · 버린 사건 0건 · 0.8초

| 특징 | 모양 | 하위 20% | 20–40% | 40–60% | 60–80% | 상위 20% |
| --- | --- | --- | --- | --- | --- | --- |
| return_pct(7, 1440m) | **monotone_down** | 1.47 (z 7.23) | 1.05 (z 0.82) | 0.76 (z -3.56) | 0.8 (z -3.05) | 0.9 (z -1.47) |
| range_position(20, 1440m) | **monotone_down** | 1.5 (z 7.47) | 1.01 (z 0.17) | 0.69 (z -4.65) | 0.87 (z -1.93) | 0.93 (z -1.07) |
| atr_percentile(30, 60m) | **monotone_up** | 0.59 (z -6.32) | 0.89 (z -1.67) | 1.01 (z 0.21) | 1.03 (z 0.44) | 1.49 (z 7.46) |
| contraction_ratio(40, 3m) | **monotone_up** | 0.69 (z -4.72) | 0.89 (z -1.72) | 0.86 (z -2.18) | 0.98 (z -0.26) | 1.58 (z 8.89) |
| prev_day_close_distance_pct(2, 1m) | **monotone_down** | 1.63 (z 9.67) | 0.92 (z -1.21) | 0.59 (z -6.38) | 0.69 (z -4.78) | 1.17 (z 2.69) |
| vwap_distance_pct(2, 1m,ATR) | **monotone_down** | 1.43 (z 6.66) | 0.95 (z -0.7) | 0.75 (z -3.81) | 0.72 (z -4.35) | 1.14 (z 2.2) |
| return_pct(4, 60m,ATR) | **two_tailed** | 1.28 (z 4.36) | 0.93 (z -1.13) | 0.8 (z -3.11) | 0.68 (z -5) | 1.32 (z 4.87) |
| volume_ratio(60, 1m) | **monotone_up** | 0.73 (z -4.15) | 0.89 (z -1.64) | 1.13 (z 1.93) | 0.99 (z -0.18) | 1.26 (z 4.04) |

트리(깊이 3, 앞 2/3로 성장·뒤 1/3로 재측정): 학습 행 8572 · 홀드아웃 행 4994 · 잎 8개

| 잎 | 학습 lift | 홀드아웃 lift | 홀드아웃 n | 홀드아웃 순평균(%) |
| --- | ---: | ---: | ---: | ---: |
| return_pct(7, 1440m) ≤ -1.475 & vwap_distance_pct(2, 1m,ATR) > 0.5877 & atr_percentile(30, 60m) ≤ 0.2069 | 2.38 | 0.72 | 87 | -0.3012 |
| return_pct(7, 1440m) > -1.475 & range_position(20, 1440m) ≤ 0.268 & atr_percentile(30, 60m) ≤ 0.3793 | 2.31 | 0 | 49 | -0.0498 |
| return_pct(7, 1440m) ≤ -1.475 & vwap_distance_pct(2, 1m,ATR) ≤ 0.5877 & prev_day_close_distance_pct(2, 1m) ≤ -2.46 | 1.86 | 0.77 | 54 | -0.1416 |
| return_pct(7, 1440m) ≤ -1.475 & vwap_distance_pct(2, 1m,ATR) > 0.5877 & atr_percentile(30, 60m) > 0.2069 | 1.55 | 0.56 | 272 | -0.34 |
| return_pct(7, 1440m) > -1.475 & range_position(20, 1440m) ≤ 0.268 & atr_percentile(30, 60m) > 0.3793 | 0.67 | 1.66 | 88 | -0.0278 |
| return_pct(7, 1440m) > -1.475 & range_position(20, 1440m) > 0.268 & return_pct(7, 1440m) > 3.403 | 0.86 | 0.93 | 1646 | -0.2051 |

## 대조군 `vol_matched` — 사건 950건 · 대조군 2850개 (사건당 3) · 버린 사건 2건 · 0.5초

| 특징 | 모양 | 하위 20% | 20–40% | 40–60% | 60–80% | 상위 20% |
| --- | --- | --- | --- | --- | --- | --- |
| return_pct(7, 1440m) | **flat** | 1.2 (z 3.03) | 1.04 (z 0.66) | 0.91 (z -1.36) | 0.89 (z -1.65) | 0.95 (z -0.69) |
| range_position(20, 1440m) | **monotone_down** | 1.29 (z 4.33) | 0.95 (z -0.69) | 0.88 (z -1.81) | 0.94 (z -0.94) | 0.94 (z -0.92) |
| atr_percentile(30, 60m) | **flat** | 0.9 (z -1.61) | 0.92 (z -1.18) | 1.03 (z 0.43) | 0.99 (z -0.22) | 1.19 (z 2.72) |
| contraction_ratio(40, 3m) | **monotone_up** | 0.79 (z -3.24) | 0.83 (z -2.68) | 0.79 (z -3.16) | 1.08 (z 1.22) | 1.51 (z 7.87) |
| prev_day_close_distance_pct(2, 1m) | **monotone_down** | 1.4 (z 6.09) | 0.9 (z -1.51) | 0.8 (z -3.08) | 0.88 (z -1.83) | 1.02 (z 0.33) |
| vwap_distance_pct(2, 1m,ATR) | **monotone_down** | 1.31 (z 4.71) | 1.03 (z 0.52) | 0.81 (z -3) | 0.78 (z -3.38) | 1.07 (z 1.14) |
| return_pct(4, 60m,ATR) | **flat** | 1.24 (z 3.71) | 0.9 (z -1.48) | 0.83 (z -2.67) | 0.9 (z -1.59) | 1.13 (z 2.03) |
| volume_ratio(60, 1m) | **monotone_up** | 0.86 (z -2.19) | 0.86 (z -2.11) | 1.01 (z 0.16) | 0.91 (z -1.38) | 1.36 (z 5.52) |

트리(깊이 3, 앞 2/3로 성장·뒤 1/3로 재측정): 학습 행 2529 · 홀드아웃 행 988 · 잎 7개

| 잎 | 학습 lift | 홀드아웃 lift | 홀드아웃 n | 홀드아웃 순평균(%) |
| --- | ---: | ---: | ---: | ---: |
| prev_day_close_distance_pct(2, 1m) ≤ -2.453 & return_pct(7, 1440m) ≤ -8.463 | 1.95 | 0 | 0 | 0 |
| prev_day_close_distance_pct(2, 1m) > -2.453 & contraction_ratio(40, 3m) > 1.467 & prev_day_close_distance_pct(2, 1m) > -0.1439 | 1.6 | 1.33 | 119 | 0.1574 |
| prev_day_close_distance_pct(2, 1m) ≤ -2.453 & return_pct(7, 1440m) > -8.463 & contraction_ratio(40, 3m) ≤ 0.9475 | 0.93 | 1.01 | 16 | -0.0162 |
| prev_day_close_distance_pct(2, 1m) ≤ -2.453 & return_pct(7, 1440m) > -8.463 & contraction_ratio(40, 3m) > 0.9475 | 1.3 | 1.01 | 24 | 0.2557 |
| prev_day_close_distance_pct(2, 1m) > -2.453 & contraction_ratio(40, 3m) ≤ 1.467 & return_pct(4, 60m,ATR) > 0.7201 | 1.02 | 0.92 | 185 | -0.0199 |
| prev_day_close_distance_pct(2, 1m) > -2.453 & contraction_ratio(40, 3m) > 1.467 & prev_day_close_distance_pct(2, 1m) ≤ -0.1439 | 0.99 | 1.47 | 58 | 0.2984 |

## 대조군 `losers` — 사건 916건 · 대조군 2527개 (사건당 2.76) · 버린 사건 36건 · 0.4초

| 특징 | 모양 | 하위 20% | 20–40% | 40–60% | 60–80% | 상위 20% |
| --- | --- | --- | --- | --- | --- | --- |
| return_pct(7, 1440m) | **flat** | 0.98 (z -0.24) | 0.97 (z -0.38) | 1.14 (z 2.07) | 0.98 (z -0.29) | 0.92 (z -1.16) |
| range_position(20, 1440m) | **flat** | 1.04 (z 0.61) | 1.02 (z 0.23) | 0.97 (z -0.41) | 1.07 (z 1) | 0.9 (z -1.43) |
| atr_percentile(30, 60m) | **flat** | 0.99 (z -0.12) | 0.92 (z -1.3) | 1 (z 0.03) | 1.05 (z 1.15) | — (z 0) |
| contraction_ratio(40, 3m) | **flat** | 0.86 (z -2.18) | 1.09 (z 1.32) | 0.91 (z -1.41) | 1.17 (z 2.64) | 0.98 (z -0.36) |
| prev_day_close_distance_pct(2, 1m) | **flat** | 1.14 (z 2.06) | 0.91 (z -1.36) | 1.05 (z 0.71) | 1 (z -0.03) | 0.91 (z -1.38) |
| vwap_distance_pct(2, 1m,ATR) | **flat** | 1.01 (z 0.21) | 0.99 (z -0.22) | 1.11 (z 1.73) | 1.04 (z 0.54) | 0.85 (z -2.26) |
| return_pct(4, 60m,ATR) | **flat** | 0.87 (z -1.99) | 0.99 (z -0.12) | 0.93 (z -1.02) | 1.08 (z 1.2) | 1.13 (z 1.93) |
| volume_ratio(60, 1m) | **flat** | 1.03 (z 0.46) | 1.15 (z 2.31) | 0.97 (z -0.5) | 0.9 (z -1.57) | 0.95 (z -0.69) |

트리(깊이 3, 앞 2/3로 성장·뒤 1/3로 재측정): 학습 행 2404 · 홀드아웃 행 816 · 잎 8개

| 잎 | 학습 lift | 홀드아웃 lift | 홀드아웃 n | 홀드아웃 순평균(%) |
| --- | ---: | ---: | ---: | ---: |
| return_pct(4, 60m,ATR) > 0.7899 & vwap_distance_pct(2, 1m,ATR) ≤ 1.316 & contraction_ratio(40, 3m) > 0.9863 | 1.56 | 1.25 | 86 | -0.1115 |
| return_pct(4, 60m,ATR) > 0.7899 & vwap_distance_pct(2, 1m,ATR) ≤ 1.316 & contraction_ratio(40, 3m) ≤ 0.9863 | 1.35 | 0.96 | 56 | -0.2248 |
| return_pct(4, 60m,ATR) ≤ 0.7899 & prev_day_close_distance_pct(2, 1m) ≤ -2.417 & prev_day_close_distance_pct(2, 1m) > -4.033 | 1.29 | 0.95 | 30 | -0.2265 |
| return_pct(4, 60m,ATR) > 0.7899 & vwap_distance_pct(2, 1m,ATR) > 1.316 & volume_ratio(60, 1m) ≤ 0.7838 | 1.19 | 0.8 | 58 | -0.2859 |
| return_pct(4, 60m,ATR) ≤ 0.7899 & prev_day_close_distance_pct(2, 1m) ≤ -2.417 & prev_day_close_distance_pct(2, 1m) ≤ -4.033 | 0.96 | 0.89 | 8 | -0.2498 |
| return_pct(4, 60m,ATR) ≤ 0.7899 & prev_day_close_distance_pct(2, 1m) > -2.417 & return_pct(4, 60m,ATR) > -1.38 | 0.93 | 0.99 | 438 | -0.213 |

## 모양 요약
- time: return_pct:monotone_down range_position:monotone_down atr_percentile:monotone_up contraction_ratio:monotone_up prev_day_close_distance_pct:monotone_down vwap_distance_pct:monotone_down return_pct:two_tailed volume_ratio:monotone_up
- vol_matched: return_pct:flat range_position:monotone_down atr_percentile:flat contraction_ratio:monotone_up prev_day_close_distance_pct:monotone_down vwap_distance_pct:monotone_down return_pct:flat volume_ratio:monotone_up
- losers: return_pct:flat range_position:flat atr_percentile:flat contraction_ratio:flat prev_day_close_distance_pct:flat vwap_distance_pct:flat return_pct:flat volume_ratio:flat
