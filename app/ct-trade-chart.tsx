"use client";
import "./ct.css";
import { useEffect, useState } from "react";
import type { CTTradeEvidence } from "@/lib/ct-trade-evidence";
import type { CTTrade } from "@/lib/ct-engine";
import { CTEvidenceChart } from "./ct-evidence-chart";
export function CTTradeChart({
  id,
  mode,
  book,
}: {
  id: string;
  mode: "paper" | "live";
  book: "ct-stock" | "ct-crypto";
}) {
  const [packet, setPacket] = useState<CTTradeEvidence | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(
      `/api/invest/ct?tradeChart=${encodeURIComponent(id)}&mode=${mode}&market=${book === "ct-crypto" ? "crypto" : "stock"}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (r) => {
        const body = (await r.json()) as CTTradeEvidence & { error?: string };
        if (!r.ok) throw new Error(body.error ?? "차트 조회 실패");
        if (!controller.signal.aborted) setPacket(body);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [id, mode, book]);
  if (error) return <p role="alert">{error}</p>;
  if (!packet) return <p>저장된 거래 근거를 불러오는 중…</p>;
  const t = packet.trade,
    signal = t.ctSignal!;
  const trade: CTTrade = {
    symbol: t.symbol,
    signal,
    entryAt: t.entryAt ? Date.parse(t.entryAt) : Infinity,
    exitAt: t.exitAt ? Date.parse(t.exitAt) : Infinity,
    entry: t.entryPrice ?? signal.reference,
    exit: t.exitPrice ?? t.markPrice ?? signal.reference,
    quantity: t.boughtQuantity,
    fees: t.commissionUsd,
    pnl: t.pnlUsd ?? 0,
    reason: t.ctExitReason ?? t.exit ?? t.status,
    specHash: t.ctHash!,
    compliant: t.compliant ?? false,
    ...(t.ctPosition && "stop" in packet.rule.spec.exit
      ? { management: { initialStop: t.ctPosition.initialStop, target: t.ctPosition.targetLevel, initialRisk: t.ctPosition.initialRisk, moves: t.ctPosition.moves } }
      : {}),
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(packet, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `ct-${mode}-${id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div>
      <p>
        {mode === "paper" ? "모의" : "실전"} · {t.symbol} · {t.status} · 동결{" "}
        {packet.rule.hash.slice(0, 16)}
      </p>
      <CTEvidenceChart
        key={id}
        bars={packet.bars}
        trade={trade}
        spec={packet.rule.spec}
        currency={packet.rule.contract.currency}
        observedAt={packet.savedAt}
        outcome={t.status === "closed" ? undefined : "운용 거래 · " + t.status}
      />
      <p>
        저장 시점 {new Date(packet.savedAt).toLocaleString("ko-KR")} · 엔진이
        관측한 완성봉만 보존합니다. 주문·체결 시각은 실제 장부 기록입니다.
      </p>
      <button className="ghost" onClick={download}>
        거래 근거 다운로드
      </button>
    </div>
  );
}
