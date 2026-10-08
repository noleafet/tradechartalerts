"use client";

import { useEffect, useRef, useState } from "react";
import {
  ColorType, CrosshairMode, createChart,
  type CandlestickData, type HistogramData, type UTCTimestamp,
} from "lightweight-charts";

const intervals = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const;
type Props = { symbol: string; onSymbolChange: (symbol: string) => void; onPriceSelect: (price: string) => void };
type Kline = [number, string, string, string, string, string, ...unknown[]];

export default function MarketChart({ symbol, onSymbolChange, onPriceSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [timeframe, setTimeframe] = useState<(typeof intervals)[number]>("1h");
  const [pairDraft, setPairDraft] = useState(symbol);
  const [quote, setQuote] = useState<number | null>(null);
  const [change, setChange] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => setPairDraft(symbol), [symbol]);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let current = true;
    let socket: WebSocket | null = null;
    const chart = createChart(host, {
      width: host.clientWidth,
      height: host.clientHeight,
      layout: { background: { type: ColorType.Solid, color: "#fbfaf6" }, textColor: "#78817a", fontFamily: "DM Sans, sans-serif" },
      grid: { vertLines: { color: "#eff0ea" }, horzLines: { color: "#eff0ea" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#dfe2da", scaleMargins: { top: 0.1, bottom: 0.22 } },
      timeScale: { borderColor: "#dfe2da", timeVisible: true, rightOffset: 5 },
    });
    const candlesSeries = chart.addCandlestickSeries({
      upColor: "#4d9468", downColor: "#bf6658", wickUpColor: "#4d9468", wickDownColor: "#bf6658",
      borderVisible: false, priceLineVisible: true,
    });
    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" }, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0]?.contentRect ?? { width: 0, height: 0 };
      if (width && height) chart.applyOptions({ width, height });
    });
    observer.observe(host);
    chart.subscribeClick((param) => {
      if (!param.point) return;
      const value = candlesSeries.coordinateToPrice(param.point.y);
      if (value !== null) onPriceSelect(String(Number(value.toPrecision(10))));
    });

    async function load() {
      setMessage("Loading market data…");
      setQuote(null); setChange(null);
      try {
        const response = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${timeframe}&limit=500`);
        if (!response.ok) throw new Error("Unknown Binance spot symbol or data unavailable.");
        const raw = await response.json() as Kline[];
        if (!current) return;
        const bars = raw.map((bar) => ({
          time: (bar[0] / 1000) as UTCTimestamp,
          open: Number(bar[1]), high: Number(bar[2]), low: Number(bar[3]), close: Number(bar[4]),
          volume: Number(bar[5]),
        }));
        const candleData: CandlestickData<UTCTimestamp>[] = bars.map(({ volume: _volume, ...bar }) => bar);
        const volumeData: HistogramData<UTCTimestamp>[] = bars.map((bar) => ({
          time: bar.time, value: bar.volume, color: bar.close >= bar.open ? "rgba(77,148,104,.28)" : "rgba(191,102,88,.28)",
        }));
        candlesSeries.setData(candleData); volumeSeries.setData(volumeData);
        chart.timeScale().fitContent();
        const last = bars.at(-1);
        if (last) {
          setQuote(last.close);
          const dayAgo = bars[Math.max(0, bars.length - Math.ceil(86400 / ({ "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 }[timeframe])))];
          if (dayAgo?.close) setChange((last.close - dayAgo.close) / dayAgo.close * 100);
        }
        setMessage("");
        socket = new WebSocket(`wss://data-stream.binance.vision/ws/${symbol.toLowerCase()}@kline_${timeframe}`);
        socket.onmessage = (event) => {
          if (!current) return;
          try {
            const payload = JSON.parse(event.data) as { k?: { t: number; o: string; h: string; l: string; c: string; v: string } };
            const bar = payload.k;
            if (!bar) return;
            const time = (bar.t / 1000) as UTCTimestamp;
            candlesSeries.update({ time, open: +bar.o, high: +bar.h, low: +bar.l, close: +bar.c });
            volumeSeries.update({ time, value: +bar.v, color: +bar.c >= +bar.o ? "rgba(77,148,104,.28)" : "rgba(191,102,88,.28)" });
            setQuote(+bar.c);
          } catch { /* Ignore malformed market-data messages. */ }
        };
      } catch (error) {
        if (current) setMessage(error instanceof Error ? error.message : "Could not load market data.");
      }
    }
    void load();
    return () => { current = false; socket?.close(); observer.disconnect(); chart.remove(); };
  }, [symbol, timeframe, onPriceSelect]);

  return <section className="market panel w-full">
    <div className="market-head">
      <div className="market-identity"><span className="eyebrow">LIVE MARKET · BINANCE SPOT</span><div><strong>{symbol}</strong>{quote !== null && <b>{quote.toLocaleString(undefined, { maximumFractionDigits: quote < 1 ? 8 : 2 })}</b>}{change !== null && <small className={change >= 0 ? "positive" : "negative"}>{change >= 0 ? "+" : ""}{change.toFixed(2)}% 24H</small>}</div></div>
      <div className="chart-tools"><div className="timeframes">{intervals.map((interval) => <button key={interval} className={timeframe === interval ? "chosen" : ""} onClick={() => setTimeframe(interval)}>{interval}</button>)}</div><form className="chart-symbol" onSubmit={(event) => { event.preventDefault(); if (pairDraft) onSymbolChange(pairDraft.toUpperCase().replace(/[^A-Z0-9]/g, "")); }}><span>PAIR</span><input aria-label="Market symbol" value={pairDraft} maxLength={24} onChange={(event) => setPairDraft(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} /><button type="submit">Go</button></form></div>
    </div>
    <div className="chart-area"><div ref={container} className="chart-container" />{message && <div className="chart-message">{message}</div>}</div>
    <p className="chart-hint">Click a price on the chart to fill the price alert target.</p>
  </section>;
}
