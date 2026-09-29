import { describeCosts } from "./broker-costs.ts";

/** The same policy reaches every model, including delegated reviewers. */
export function tradingResearchPolicy() {
  return `QQuant 거래 비용 및 전략 연구 기준 (사용자 확정): ${describeCosts()}
거래수수료의 유일한 출처는 lib/broker-costs.ts다. 종목에 따라 거래수수료를 바꾸지 않는다. 과거 연구 문서의 0.2308%, RKLB 0.2768% 등은 이전의 추가 비용 가정을 포함한 값이며 현재 수수료가 아니다. 과거 결과를 인용할 때 당시 비용 가정과 현재 기준을 구분한다.
스프레드와 슬리피지는 체결가격 차이이며 별도의 확정 수수료로 더하지 않는다. 실거래에서는 실제 체결가격과 기준가격의 차이를 별도 지표로 기록한다. 사용자가 명시적으로 요청한 민감도 분석만 추가 체결비용 가정을 별도로 표시한다.
9개 시간대는 연구 분류이며 채워야 할 할당량이 아니다. 전략 수·승률·발동률을 목표수익에 맞춰 가정한 계산을 검증된 성과로 표현하지 않는다. 미배정 시간대는 그대로 비워 둔다.`;
}

export function withTradingPolicy(system?: string | Array<{ text: string; cache?: boolean }>) {
  const policy = tradingResearchPolicy();
  if (Array.isArray(system)) return [...system, { text: policy, cache: true }];
  return `${system ?? ""}\n\n${policy}`.trim();
}
