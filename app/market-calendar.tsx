"use client";

import BriefcaseBusiness from "lucide-react/dist/esm/icons/briefcase-business";
import Building2 from "lucide-react/dist/esm/icons/building-2";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import Clock3 from "lucide-react/dist/esm/icons/clock-3";
import Factory from "lucide-react/dist/esm/icons/factory";
import Landmark from "lucide-react/dist/esm/icons/landmark";
import Percent from "lucide-react/dist/esm/icons/percent";
import TrendingUp from "lucide-react/dist/esm/icons/trending-up";
import { useEffect, useMemo, useState } from "react";
import {
  MARKET_CALENDAR_2026,
  MARKET_EVENT_CATEGORY_LABELS,
  type MarketEvent,
  type MarketEventCategory,
} from "./market-calendar-data";

const YEAR = 2026;
const monthNames = ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"];
const weekNames = ["일", "월", "화", "수", "목", "금", "토"];
const categoryOrder: MarketEventCategory[] = ["fed", "inflation", "labor", "growth", "business", "market"];

const icons = {
  fed: Landmark,
  inflation: Percent,
  labor: BriefcaseBusiness,
  growth: TrendingUp,
  business: Factory,
  market: Building2,
};

function dateKey(month: number, day: number) {
  return `${YEAR}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dayLabel(value: string) {
  const date = new Date(`${value}T12:00:00`);
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${weekNames[date.getDay()]}요일`;
}

export function MarketCalendar() {
  const [today, setToday] = useState("");
  const [month, setMonth] = useState(7);
  const [selectedDate, setSelectedDate] = useState("2026-08-31");
  const [activeCategory, setActiveCategory] = useState<MarketEventCategory | "all">("all");

  useEffect(() => {
    const current = new Date();
    if (current.getFullYear() !== YEAR) return;
    const currentDate = dateKey(current.getMonth(), current.getDate());
    setToday(currentDate);
    setMonth(current.getMonth());
    setSelectedDate(currentDate);
  }, []);

  const monthEvents = useMemo(() => MARKET_CALENDAR_2026.filter((event) => {
    const matchesMonth = Number(event.date.slice(5, 7)) === month + 1;
    return matchesMonth && (activeCategory === "all" || event.category === activeCategory);
  }), [activeCategory, month]);

  const eventsByDate = useMemo(() => monthEvents.reduce<Record<string, MarketEvent[]>>((groups, event) => {
    (groups[event.date] ??= []).push(event);
    return groups;
  }, {}), [monthEvents]);

  const calendarDays = useMemo(() => {
    const firstWeekday = new Date(YEAR, month, 1).getDay();
    const daysInMonth = new Date(YEAR, month + 1, 0).getDate();
    const previousMonthDays = new Date(YEAR, month, 0).getDate();
    return Array.from({ length: 42 }, (_, index) => {
      const offset = index - firstWeekday + 1;
      if (offset < 1) return { day: previousMonthDays + offset, current: false };
      if (offset > daysInMonth) return { day: offset - daysInMonth, current: false };
      return { day: offset, current: true };
    });
  }, [month]);

  const groupedDays = Object.entries(eventsByDate).sort(([a], [b]) => a.localeCompare(b));
  const selectedEvents = eventsByDate[selectedDate] ?? [];
  const highImpactCount = monthEvents.filter((event) => event.importance === "high").length;

  function moveMonth(next: number) {
    if (next < 0 || next > 11) return;
    setMonth(next);
    const firstEvent = MARKET_CALENDAR_2026.find((event) => Number(event.date.slice(5, 7)) === next + 1);
    setSelectedDate(firstEvent?.date ?? dateKey(next, 1));
  }

  return (
    <section className="calendar-view">
      <header className="calendar-page-head">
        <div>
          <span>2026 · US MARKET</span>
          <h1>Market Calendar</h1>
        </div>
        <div className="calendar-meta">
          <strong>{MARKET_CALENDAR_2026.length}</strong>
          <span>연간 주요 일정 · ET</span>
        </div>
      </header>

      <div className="calendar-workspace">
        <article className="calendar-surface">
          <div className="calendar-toolbar">
            <div className="month-stepper">
              <button onClick={() => moveMonth(month - 1)} disabled={month === 0} aria-label="이전 달"><ChevronLeft size={16} /></button>
              <strong>2026년 {monthNames[month]}</strong>
              <button onClick={() => moveMonth(month + 1)} disabled={month === 11} aria-label="다음 달"><ChevronRight size={16} /></button>
            </div>
            <div className="month-stats"><span>{monthEvents.length} events</span><span>{highImpactCount} high impact</span></div>
          </div>

          <div className="category-filters" aria-label="일정 필터">
            <button className={activeCategory === "all" ? "active" : ""} onClick={() => setActiveCategory("all")}>전체</button>
            {categoryOrder.map((category) => <button key={category} className={activeCategory === category ? `active ${category}` : category} onClick={() => setActiveCategory(category)}><i />{MARKET_EVENT_CATEGORY_LABELS[category]}</button>)}
          </div>

          <div className="calendar-grid" role="grid" aria-label={`2026년 ${month + 1}월`}>
            {weekNames.map((day) => <span className="weekday" key={day}>{day}</span>)}
            {calendarDays.map((cell, index) => {
              const key = cell.current ? dateKey(month, cell.day) : "";
              const events = key ? eventsByDate[key] ?? [] : [];
              return (
                <button
                  className={`calendar-day ${cell.current ? "" : "outside"} ${key === today ? "today" : ""} ${key === selectedDate ? "selected" : ""}`}
                  disabled={!cell.current}
                  key={`${index}-${cell.day}`}
                  onClick={() => setSelectedDate(key)}
                  aria-label={cell.current ? `${dayLabel(key)}, 일정 ${events.length}개` : undefined}
                >
                  <span>{cell.day}</span>
                  <div className="event-dots" aria-hidden="true">
                    {events.slice(0, 4).map((event) => <i className={event.category} key={event.id} />)}
                    {events.length > 4 && <small>+{events.length - 4}</small>}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="selected-day-summary">
            <div><span>선택한 날짜</span><strong>{dayLabel(selectedDate)}</strong></div>
            <span>{selectedEvents.length ? `${selectedEvents.length}개 일정` : "일정 없음"}</span>
          </div>
        </article>

        <aside className="calendar-agenda">
          <div className="agenda-head">
            <div><span>{monthNames[month]}</span><strong>주요 일정</strong></div>
            <small>Eastern Time</small>
          </div>
          <div className="agenda-scroll">
            {!groupedDays.length && <div className="agenda-empty">이 필터에 해당하는 일정이 없습니다.</div>}
            {groupedDays.map(([date, events]) => (
              <section className={`agenda-day ${date === selectedDate ? "selected" : ""}`} key={date} onClick={() => setSelectedDate(date)}>
                <div className="agenda-date"><strong>{new Date(`${date}T12:00:00`).getDate()}</strong><span>{weekNames[new Date(`${date}T12:00:00`).getDay()]}</span></div>
                <div className="agenda-events">
                  {events.map((event) => {
                    const Icon = icons[event.category];
                    return (
                      <article className={`agenda-event ${event.category}`} key={event.id}>
                        <span className="event-icon"><Icon size={15} strokeWidth={1.8} /></span>
                        <div>
                          <strong>{event.title}</strong>
                          <p>{event.note}</p>
                          <span><Clock3 size={11} />{event.time} ET · <a href={event.sourceUrl} target="_blank" rel="noreferrer">{event.source}</a></span>
                        </div>
                        {event.importance === "high" && <i className="impact-dot" title="High impact" />}
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
          <footer>발표 일정은 기관 사정에 따라 변경될 수 있습니다.</footer>
        </aside>
      </div>
    </section>
  );
}
