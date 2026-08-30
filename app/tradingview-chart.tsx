"use client";

import { useEffect, useRef } from "react";

type TradingViewChartProps = {
  symbol: string;
  interval: string;
  studies: string[];
};

export function TradingViewChart({ symbol, interval, studies }: TradingViewChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.replaceChildren();
    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "calc(100% - 28px)";
    widget.style.width = "100%";
    container.appendChild(widget);

    const attribution = document.createElement("div");
    attribution.className = "tradingview-widget-copyright";
    const link = document.createElement("a");
    link.href = `https://www.tradingview.com/symbols/${symbol.replace(":", "-")}/`;
    link.target = "_blank";
    link.rel = "noreferrer nofollow";
    link.textContent = `${symbol} chart by TradingView`;
    attribution.appendChild(link);
    container.appendChild(attribution);

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;
    script.text = JSON.stringify({
      autosize: true,
      symbol,
      interval,
      timezone: "exchange",
      theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      style: "1",
      locale: "en",
      withdateranges: true,
      hide_side_toolbar: false,
      allow_symbol_change: true,
      save_image: false,
      calendar: false,
      studies,
      support_host: "https://www.tradingview.com",
    });
    container.appendChild(script);

    return () => container.replaceChildren();
  }, [interval, studies, symbol]);

  return (
    <div className="tradingview-widget-container" ref={containerRef}>
      <a
        className="tradingview-fallback"
        href={`https://www.tradingview.com/symbols/${symbol.replace(":", "-")}/`}
        rel="noreferrer nofollow"
        target="_blank"
      >
        {symbol} chart by TradingView
      </a>
    </div>
  );
}
