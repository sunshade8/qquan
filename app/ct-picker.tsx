"use client";
import "./ct.css";
import { useEffect, useId, useRef, useState } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import History from "lucide-react/dist/esm/icons/history";
import { CT_PHASES, STATUS_LABEL, statusTone, type CTPhaseId } from "./ct-progress";

export type PickerJob = {
  id: string;
  status: string;
  createdAt: string;
  costUsd: number;
  budgetUsd: number;
  ct?: { phase: CTPhaseId };
};
const when = (iso: string) =>
  new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function Status({ status }: { status: string }) {
  const tone = statusTone(status);
  return (
    <span className="ui-badge" data-tone={tone === "accent" ? "accent" : tone === "warn" ? "warn" : tone === "danger" ? "danger" : undefined}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/** 과거 연구 목록: 날짜, 상태, 단계를 한눈에 보이는 팝오버 리스트. */
export function ResearchPicker({ jobs, currentId, onSelect }: { jobs: PickerJob[]; currentId: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const current = jobs.find((j) => j.id === currentId);
  if (!jobs.length) return null;
  return (
    <div className="ct-picker" ref={root}>
      <button className="ui-btn sm" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
        <History size={13} aria-hidden="true" />
        <span>{current ? when(current.createdAt) : "연구 선택"}</span>
        {current ? <Status status={current.status} /> : null}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open ? (
        <ul className="ct-picker-pop" id={listId} aria-label="과거 연구">
          {jobs.map((j) => (
            <li key={j.id}>
              <button
                aria-current={j.id === currentId ? "true" : undefined}
                onClick={() => {
                  onSelect(j.id);
                  setOpen(false);
                }}
              >
                <span className="ct-picker-when ui-num">{when(j.createdAt)}</span>
                <Status status={j.status} />
                <span className="ct-picker-phase">{j.ct ? CT_PHASES[j.ct.phase] : ""}</span>
                <span className="ct-picker-cost ui-num">${j.costUsd.toFixed(2)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
