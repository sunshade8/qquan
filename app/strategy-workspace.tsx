"use client";

import Coins from "lucide-react/dist/esm/icons/coins";
import Layers from "lucide-react/dist/esm/icons/layers";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert";
import { useCallback, useEffect, useState } from "react";

type Slot = {
  id: string; label: string; rationale: string;
  session: "premarket" | "regular" | "aftermarket";
  liquidity: "high" | "medium" | "low";
  et: { from: string; to: string };
  kst: { from: string; to: string };
  strategy: { id: string; name: string; summary: string; universe: string[] } | null;
};
type SlotTarget = {
  dailyTargetPct: number; slots: number; perSessionNetPct: number; perFireNetPct: number;
  perFireGrossPct: number; requiredEdgeR: number; requiredWinRatePct: number;
};
type Liquidity = { symbol: string; halfSpreadPct: number; dailyRangePct: number; roundTripPct: number; rangeToCost: number | null; measuredAt: string };
type TossCause = "disabled" | "no_credentials" | "ip_allowlist" | "auth" | "permission" | "no_account" | "unknown";
type TossStatus = {
  ready: boolean; reason: string | null; cause: TossCause | null; egressIp: string | null;
  account: { accountNo: string } | null;
  buyingPowerUsd: number | null; usCommissionRate: number | null; usCommissionEndDate: string | null;
  orderMode: "loc" | "market";
};
type RelayBoard = {
  slots: Slot[]; liquidity: Liquidity[]; toss: TossStatus; registered: number;
  targets: SlotTarget[];
  targetAssumptions: { symbol: string; stopPct: number; rewardRisk: number; fireRate: number };
  orderTypes: { limitDay: string; limitOnClose: string; amountOrder: string };
  excludedSession: { label: string; kst: string; et: string; reason: string };
};

const SESSION_LABEL: Record<Slot["session"], string> = { premarket: "프리마켓", regular: "정규장", aftermarket: "애프터마켓" };
const LIQUIDITY_LABEL: Record<Slot["liquidity"], string> = { high: "호가 두꺼움", medium: "보통", low: "얇음" };

const TOSS_FIX: Record<TossCause, { title: string; how: string }> = {
  no_credentials: { title: "이 환경에 토스 키가 없습니다.", how: "`.dev.vars` 는 로컬 전용입니다. 배포 환경에는 TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 을 따로 넣어야 합니다." },
  ip_allowlist: { title: "토스가 이 서버의 IP를 차단했습니다 (403).", how: "토스 WTS > 설정 > Open API > 허용 IP 관리에 등록된 IP에서만 호출됩니다. 배포 서버는 집 IP와 다른 주소로 나갑니다." },
  auth: { title: "토스 인증에 실패했습니다.", how: "Client ID/Secret 을 다시 확인하세요." },
  permission: { title: "이 앱에 필요한 권한이 없습니다.", how: "콘솔에서 계좌·자산·주문 스코프를 확인하세요." },
  no_account: { title: "주문 가능한 계좌를 찾지 못했습니다.", how: "종합매매(BROKERAGE) 계좌 연결을 확인하세요." },
  disabled: { title: "실주문이 잠겨 있습니다.", how: "TOSS_TRADING_DISABLED 를 지우면 풀립니다." },
  unknown: { title: "토스 연결을 확인하지 못했습니다.", how: "아래 원문 메시지를 확인하세요." },
};

function usd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value < 0 ? "−" : ""}$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function StrategyWorkspace() {
  const [board, setBoard] = useState<RelayBoard | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    try {
      setBoard(await (await fetch("/api/relay", { cache: "no-store" })).json() as RelayBoard);
    } catch {
      setBoard(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const toss = board?.toss;
  const fix = toss && !toss.ready ? TOSS_FIX[toss.cause ?? "unknown"] : null;

  return <section className="strategy-board">
    <header className="lab-page-head">
      <div>
        <span>SLOT RELAY · ACCOUNT P&amp;L</span>
        <h1>전략</h1>
        <p>하루를 슬롯으로 나누고, 같은 잔고를 순서대로 물려주는 구조입니다. 평가는 전략별 평균이 아니라 계좌의 일별 손익으로 합니다.</p>
      </div>
      <div className="lab-capabilities">
        <span><Layers size={13} />슬롯 릴레이</span>
        <span><Coins size={13} />전액 회전</span>
        <span><TriangleAlert size={13} />레버리지 제외</span>
      </div>
    </header>

    {fix && <div className="strategy-warning">
      <TriangleAlert size={15} />
      <div>
        <strong>{fix.title}</strong>
        <p>{fix.how}</p>
        {toss?.egressIp && <p className="strategy-egress">이 서버가 토스에 접속하는 IP: <code>{toss.egressIp}</code></p>}
        {toss?.reason && <p className="strategy-raw">토스 응답: {toss.reason}</p>}
      </div>
    </div>}

    {toss?.ready && <div className="strategy-account">
      <span><i />토스증권 계좌 <strong>{toss.account?.accountNo ?? "—"}</strong></span>
      <span>USD 매수가능 <strong className={(toss.buyingPowerUsd ?? 0) > 0 ? "" : "warn"}>{usd(toss.buyingPowerUsd)}</strong></span>
      <span>미국주식 수수료 <strong>{toss.usCommissionRate === null ? "—" : `${(toss.usCommissionRate * 100).toFixed(3)}%`}</strong> / 편도{toss.usCommissionEndDate ? ` (~${toss.usCommissionEndDate})` : ""}</span>
      <span>주문 유형 <strong>{toss.orderMode === "loc" ? "LOC (종가 지정가)" : "시장가"}</strong></span>
    </div>}

    {!ready && <div className="research-empty"><RefreshCw size={16} className="spin" /><strong>불러오는 중</strong></div>}

    {ready && board && <>
      <section className="relay-intro">
        <p><strong>왜 슬롯인가.</strong> 자본을 여러 전략에 나누면 각 전략의 엣지가 그만큼 나뉩니다. $1,000을 12분할하면 거래당 +0.85%짜리 규칙이 계좌를 +0.07% 움직입니다. 대신 같은 $1,000을 하루 안에 순서대로 재사용하면 각 규칙이 매번 전액을 씁니다. 슬롯은 시간이 겹치지 않으므로 자본을 두고 경쟁하지 않습니다.</p>
        <p><strong>왜 계좌 단위 평가인가.</strong> 전략별 평균 수익률은 계좌가 그날 얼마를 벌었는지 말해주지 않습니다. 백테스트는 달력을 하루씩 걸으며 잔고 하나를 굴리고, <em>거래하지 않은 날과 잃은 날을 포함해</em> 일별 수익률을 보고합니다. 목표가 하루 단위이므로 측정도 하루 단위여야 합니다.</p>
      </section>

      <div className="strategy-board-head">
        <strong>슬롯 {board.slots.length}</strong>
        <span className="strategy-board-note">배정된 전략 {board.registered}개 · 시각은 오늘 기준 (미국 서머타임에 따라 이동)</span>
      </div>

      <ol className="relay-timeline">
        {board.slots.map((slot) => <li key={slot.id} className={slot.strategy ? "filled" : "empty"}>
          <div className="relay-clock">
            <strong>{slot.kst.from}–{slot.kst.to}</strong>
            <small>KST</small>
            <em>{slot.et.from}–{slot.et.to} ET</em>
          </div>
          <div className="relay-body">
            <header>
              <b>{slot.label}</b>
              <span className={`relay-session ${slot.session}`}>{SESSION_LABEL[slot.session]}</span>
              <span className={`relay-depth ${slot.liquidity}`}>{LIQUIDITY_LABEL[slot.liquidity]}</span>
              {slot.strategy ? <span className="relay-tag on">배정됨</span> : <span className="relay-tag">미배정</span>}
            </header>
            <p className="relay-rationale">{slot.rationale}</p>
            {slot.strategy
              ? <div className="relay-strategy"><strong>{slot.strategy.name}</strong><p>{slot.strategy.summary}</p><small>{slot.strategy.universe.join(", ")}</small></div>
              : <p className="relay-vacant">아직 계좌 단위 백테스트를 통과한 규칙이 없습니다. 검증 전에는 비워 둡니다.</p>}
          </div>
        </li>)}
      </ol>

      <section className="relay-targets">
        <header><span>TARGET</span><strong>슬롯당 목표수익률 — 하루 목표를 슬롯 수로 나눈 결과</strong></header>
        <p className="strategy-note">
          {board.targetAssumptions.symbol} 기준 왕복 비용, 손절 {board.targetAssumptions.stopPct}%, 손익비 {board.targetAssumptions.rewardRisk}:1,
          발동률 {Math.round(board.targetAssumptions.fireRate * 100)}%(다섯 세션 중 세 번 셋업 발생) 가정입니다.
          슬롯은 나누는 게 아니라 <strong>곱해집니다</strong> — 9슬롯 0.22%가 하루 2%가 됩니다.
        </p>
        <div className="lab-table-wrap"><table className="lab-table">
          <thead><tr><th>하루 목표</th><th>슬롯</th><th>세션당 순%</th><th>발동 시 순%</th><th>발동 시 총%</th><th>필요 엣지</th><th>필요 승률</th></tr></thead>
          <tbody>{board.targets.map((row) => <tr key={`${row.dailyTargetPct}-${row.slots}`}>
            <td><strong>{row.dailyTargetPct}%</strong></td>
            <td>{row.slots}</td>
            <td>{row.perSessionNetPct.toFixed(3)}%</td>
            <td>{row.perFireNetPct.toFixed(3)}%</td>
            <td>{row.perFireGrossPct.toFixed(3)}%</td>
            <td>{row.requiredEdgeR.toFixed(2)}R</td>
            <td className={row.requiredWinRatePct <= 55 ? "positive" : row.requiredWinRatePct <= 65 ? "" : "negative"}>{row.requiredWinRatePct.toFixed(1)}%</td>
          </tr>)}</tbody>
        </table></div>
        <p className="strategy-note">
          읽는 법: <strong>필요 승률이 슬롯을 늘려야 하는 이유</strong>입니다. 하루 2%를 3슬롯으로 만들려면 승률 79%가 필요해 사실상 불가능하고,
          9슬롯으로 늘리면 55%로 내려옵니다. 다만 슬롯 9개는 하루에 왕복 비용을 9번 내므로 마찰이 자본의 2.5%에 달합니다 — 표의 “발동 시 총%”에 이미 반영돼 있습니다.
          또한 이 계산은 슬롯끼리 독립이라고 가정합니다. 나쁜 날은 여러 슬롯이 함께 잃습니다.
        </p>
      </section>

      <section className="relay-sessions">
        <header><span>SESSIONS</span><strong>주문 가능 시간 — 2026-09-09 실측</strong></header>
        <ul>
          <li><strong>일반 지정가(LIMIT+DAY)</strong> — {board.orderTypes.limitDay}. 그래서 프리·애프터 슬롯이 가능합니다.</li>
          <li><strong>LOC(LIMIT+CLS)</strong> — {board.orderTypes.limitOnClose}. 종가 체결을 원하는 규칙은 이 창 안에서만 접수됩니다.</li>
          <li><strong>금액 주문</strong> — {board.orderTypes.amountOrder}.</li>
          <li><strong>{board.excludedSession.label} ({board.excludedSession.kst} KST / {board.excludedSession.et} ET)</strong> — 슬롯에서 제외. {board.excludedSession.reason}</li>
        </ul>
      </section>

      <section className="relay-liquidity">
        <header><span>UNIVERSE</span><strong>종목 후보 — 레인지 대비 비용</strong></header>
        <p className="strategy-note">장중 규칙이 성립하려면 하루 움직임이 왕복 비용보다 충분히 커야 합니다. 레인지만 보면 ASTX가 1등이지만, 스프레드를 넣으면 순위가 바뀝니다. 호가는 {board.liquidity[0]?.measuredAt} 장외 실측이라 정규장에서는 이보다 좁습니다.</p>
        <div className="lab-table-wrap"><table className="lab-table">
          <thead><tr><th>종목</th><th>일중 레인지</th><th>반값 스프레드</th><th>왕복 비용</th><th>레인지 ÷ 비용</th></tr></thead>
          <tbody>{board.liquidity.map((row) => <tr key={row.symbol}>
            <td><strong>{row.symbol}</strong></td>
            <td>{row.dailyRangePct.toFixed(2)}%</td>
            <td>{row.halfSpreadPct.toFixed(3)}%</td>
            <td>{row.roundTripPct.toFixed(3)}%</td>
            <td className={(row.rangeToCost ?? 0) >= 15 ? "positive" : (row.rangeToCost ?? 0) >= 10 ? "" : "negative"}>{row.rangeToCost ?? "—"}배</td>
          </tr>)}</tbody>
        </table></div>
      </section>

      <section className="relay-next">
        <header><span>NEXT</span><strong>슬롯을 채우는 조건</strong></header>
        <ol>
          <li>규칙은 <code>lib/relay-strategies.ts</code>에 <code>SlotStrategy</code>로 등록합니다. 슬롯당 하나만 배정되고, 둘을 넣으면 등록 시점에 실패합니다.</li>
          <li>레버리지·인버스 종목은 <code>lib/trade-slots.ts</code>에서 차단됩니다. 등록 시점에 걸러지므로 새벽에 브로커 앞에서 발견되지 않습니다.</li>
          <li>배정 전에 <code>runRelay</code>로 계좌 단위 백테스트를 돌립니다. 판정 기준은 일평균 수익률, <strong>+1% 이상 달성일 비율</strong>, 최악의 날, 최대 낙폭입니다.</li>
        </ol>
      </section>
    </>}
  </section>;
}
