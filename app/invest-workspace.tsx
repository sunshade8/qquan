"use client";

/**
 * 투자 — the tab that owns everything that puts money to work.
 *
 * The 전략 board used to be a top-level rail item. It is unchanged; it simply
 * lives here now as one feature among several, so the rail stays short as more
 * ways of trading are added. The sub-tab is the only new thing on this screen.
 */

import Layers from "lucide-react/dist/esm/icons/layers";
import Flame from "lucide-react/dist/esm/icons/flame";
import { useEffect, useState } from "react";
import { StrategyWorkspace } from "./strategy-workspace";
import { SurgeWorkspace } from "./surge-workspace";

export type InvestFeature = "strategy" | "surge";

const FEATURES = [
  { id: "strategy" as const, label: "전략", icon: Layers, blurb: "슬롯 릴레이 · 실전/모의 대시보드" },
  { id: "surge" as const, label: "급등주", icon: Flame, blurb: "당일 급등락 이후 패턴 · 손익비 고정" },
];

const STORAGE_KEY = "qquant.invest.feature";

export function InvestWorkspace() {
  const [feature, setFeature] = useState<InvestFeature>("strategy");

  // Remember which feature was open; the 전략 board's own polling makes an
  // accidental reset expensive to look at.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage may be unavailable in private browsing or when the quota is full.
    }
    if (stored === "strategy" || stored === "surge") queueMicrotask(() => setFeature(stored));
  }, []);

  const select = (next: InvestFeature) => {
    setFeature(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not remembering the tab is not worth failing the click over.
    }
  };

  return <div className="invest-shell">
    <nav className="invest-tabs" aria-label="투자 기능">
      {FEATURES.map((item) => (
        <button
          key={item.id}
          className={feature === item.id ? "active" : ""}
          onClick={() => select(item.id)}
          aria-current={feature === item.id ? "page" : undefined}
        >
          <item.icon size={14} strokeWidth={1.9} />
          <span><strong>{item.label}</strong><small>{item.blurb}</small></span>
        </button>
      ))}
    </nav>
    {feature === "strategy" ? <StrategyWorkspace /> : <SurgeWorkspace />}
  </div>;
}
