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
const easternFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const koreaFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

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

function timeParts(formatter: Intl.DateTimeFormat, date: Date) {
  const parts = formatter.formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

function easternTimeToDate(date: string, time: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const eastern = timeParts(easternFormatter, guess);
  const easternAsUtc = Date.UTC(eastern.year, eastern.month - 1, eastern.day, eastern.hour, eastern.minute);
  return new Date(guess.getTime() - (easternAsUtc - guess.getTime()));
}

type KoreaMarketEvent = MarketEvent & { calendarDate: string; koreaTime: string; easternDate: string };

const KOREA_MARKET_CALENDAR_2026: KoreaMarketEvent[] = MARKET_CALENDAR_2026.map((event) => {
  if (event.time === "종일") return { ...event, calendarDate: event.date, koreaTime: "휴장", easternDate: event.date };
  const korea = timeParts(koreaFormatter, easternTimeToDate(event.date, event.time));
  return {
    ...event,
    calendarDate: `${korea.year}-${String(korea.month).padStart(2, "0")}-${String(korea.day).padStart(2, "0")}`,
    koreaTime: `${String(korea.hour).padStart(2, "0")}:${String(korea.minute).padStart(2, "0")}`,
    easternDate: event.date,
  };
}).sort((a, b) => a.calendarDate.localeCompare(b.calendarDate) || a.koreaTime.localeCompare(b.koreaTime));

function easternDateLabel(value: string) {
  return `${Number(value.slice(5, 7))}.${String(Number(value.slice(8, 10))).padStart(2, "0")}`;
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

  const monthEvents = useMemo(() => KOREA_MARKET_CALENDAR_2026.filter((event) => {
    const matchesMonth = Number(event.calendarDate.slice(5, 7)) === month + 1;
    return matchesMonth && (activeCategory === "all" || event.category === activeCategory);
  }), [activeCategory, month]);

  const eventsByDate = useMemo(() => monthEvents.reduce<Record<string, KoreaMarketEvent[]>>((groups, event) => {
    (groups[event.calendarDate] ??= []).push(event);
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
    const firstEvent = KOREA_MARKET_CALENDAR_2026.find((event) => Number(event.calendarDate.slice(5, 7)) === next + 1);
    setSelectedDate(firstEvent?.calendarDate ?? dateKey(next, 1));
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
          <span>연간 주요 일정 · KST 기준</span>
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
            <small>Korea Standard Time</small>
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
                          <div className="event-time">
                            <span className="event-time-primary"><Clock3 size={11} />{event.koreaTime} KST</span>
                            <small>{easternDateLabel(event.easternDate)} · {event.time} ET · <a href={event.sourceUrl} target="_blank" rel="noreferrer">{event.source}</a></small>
                          </div>
                        </div>
                        {event.importance === "high" && <i className="impact-dot" title="High impact" />}
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
          <footer>날짜·첫 시간은 KST, 아래 원문 일정은 ET입니다.</footer>
        </aside>
      </div>
    </section>
  );
}
