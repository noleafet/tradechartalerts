"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import {
  ColorType, CrosshairMode, createChart,
  type CandlestickData, type IChartApi, type Logical, type UTCTimestamp,
} from "lightweight-charts";

const API = "/api/proxy";
const intervals = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const;
const intervalSeconds: Record<(typeof intervals)[number], number> = {
  "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800,
};
const lineTools = ["trend", "ray", "hline", "hray"] as const;
type Tool = (typeof lineTools)[number];
type Bar = { time: UTCTimestamp; open: number; high: number; low: number; close: number; volume: number };
export type Drawing = {
  id: string; symbol: string; type: Tool; t1: number; p1: number; t2?: number; p2?: number;
  hidden?: boolean; extend?: boolean; width: number; opacity: number; repeat?: boolean;
};
type LineAlert = {
  id: number; symbol: string; kind: "price" | "macd" | "rsi"; price: string | null;
  line_type?: string; line_t1?: string | null; line_price1?: string | null; line_t2?: string | null;
  line_price2?: string | null; line_extend?: boolean; active: boolean; condition: string; frequency: string;
};
type Props = {
  symbol: string;
  exchange?: "binance" | "bybit";
  onExchangeChange?: (exchange: "binance" | "bybit") => void;
  theme?: "light" | "dark";
  onSymbolChange: (symbol: string) => void;
  onPriceSelect: (price: string) => void;
  alerts: LineAlert[];
  onCreateLineAlert: (drawing: Drawing, condition: string, frequency: string) => Promise<void>;
  onUpdateLineAlert: (drawing: Drawing) => void;
  onDeleteLineAlert: (drawing: Drawing) => void;
};
type Preferences = { timeframe: (typeof intervals)[number]; candleType: "candles" | "ha"; indicators: { sma20: boolean; ema50: boolean; vol: boolean; macd: boolean }; drawingsVisible: boolean; alertsVisible: boolean; magnet: boolean };
const defaultPreferences: Preferences = { timeframe: "1h", candleType: "candles", indicators: { sma20: true, ema50: false, vol: true, macd: false }, drawingsVisible: true, alertsVisible: true, magnet: false };
const palettes = {
  light: { bg: "#fbfaf6", grid: "#eff0ea", text: "#78817a", green: "#316c4c", red: "#bd5c4c", amber: "#dfad54", blue: "#4777a8", line: "#dfe2da" },
  dark: { bg: "#121722", grid: "#283044", text: "#7f8aa3", green: "#3ecf9b", red: "#f2686b", amber: "#f5b544", blue: "#7f8aa3", line: "#283044" },
};
const fmt = (value: number | null) => value === null || !Number.isFinite(value) ? "–" : value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : value >= 1 ? 4 : 8 });
const idFor = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function readSaved<T>(key: string, fallback: T): T {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}
function ema(values: number[], length: number): (number | null)[] {
  const result: (number | null)[] = Array(values.length).fill(null);
  const alpha = 2 / (length + 1);
  let seed = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (index < length) {
      seed += values[index];
      if (index === length - 1) result[index] = seed / length;
    } else result[index] = values[index] * alpha + (result[index - 1] ?? values[index]) * (1 - alpha);
  }
  return result;
}
function movingAverage(bars: Bar[], length: number) {
  let sum = 0;
  return bars.flatMap((bar, index) => {
    sum += bar.close;
    if (index >= length) sum -= bars[index - length].close;
    return index < length - 1 ? [] : [{ time: bar.time, value: sum / length }];
  });
}
function heikinAshi(bars: Bar[]): CandlestickData<UTCTimestamp>[] {
  const result: CandlestickData<UTCTimestamp>[] = [];
  bars.forEach((bar) => {
    const close = (bar.open + bar.high + bar.low + bar.close) / 4;
    const previous = result.at(-1);
    const open = previous ? ((previous.open + previous.close) / 2) : ((bar.open + bar.close) / 2);
    result.push({ time: bar.time, open, close, high: Math.max(bar.high, open, close), low: Math.min(bar.low, open, close) });
  });
  return result;
}
function lineValue(line: Drawing, time: number) {
  if (line.type === "hline") return line.p1;
  if (time < line.t1) return null;
  if (line.type === "hray") return line.p1;
  if (line.type === "trend" && !line.extend && time > (line.t2 ?? line.t1)) return null;
  if (line.t2 === undefined || line.p2 === undefined || line.t2 === line.t1) return null;
  return line.p1 + (line.p2 - line.p1) * (time - line.t1) / (line.t2 - line.t1);
}
function drawingCoordinate(chart: IChartApi, time: number, data: Bar[], timeframe: Preferences["timeframe"]) {
  const scale = chart.timeScale();
  const coordinate = scale.timeToCoordinate(time as UTCTimestamp);
  if (coordinate !== null) return coordinate;
  const last = data.at(-1);
  if (!last || time <= Number(last.time)) return null;
  const logical = data.length - 1 + (time - Number(last.time)) / intervalSeconds[timeframe];
  return scale.logicalToCoordinate(logical as Logical);
}

export default function MarketWorkspace({ symbol, exchange = "binance", onExchangeChange, theme = "light", onSymbolChange, onPriceSelect, alerts, onCreateLineAlert, onUpdateLineAlert, onDeleteLineAlert }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const colors = palettes[theme];
  const macdHost = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const chartApi = useRef<ReturnType<typeof createChart> | null>(null);
  const macdApi = useRef<ReturnType<typeof createChart> | null>(null);
  const series = useRef<{ candles: ReturnType<ReturnType<typeof createChart>["addCandlestickSeries"]>; volume: ReturnType<ReturnType<typeof createChart>["addHistogramSeries"]>; sma: ReturnType<ReturnType<typeof createChart>["addLineSeries"]>; ema: ReturnType<ReturnType<typeof createChart>["addLineSeries"]> } | null>(null);
  const macdSeries = useRef<{ histogram: ReturnType<ReturnType<typeof createChart>["addHistogramSeries"]>; line: ReturnType<ReturnType<typeof createChart>["addLineSeries"]>; signal: ReturnType<ReturnType<typeof createChart>["addLineSeries"]> } | null>(null);
  const barsRef = useRef<Bar[]>([]);
  const modeRef = useRef<Tool | null>(null);
  const pendingRef = useRef<{ time: number; price: number } | null>(null);
  const dragRef = useRef<{ id: string; part: "p1" | "p2" | "body"; start: { time: number; price: number }; original: Drawing } | null>(null);
  const modifiers = useRef({ ctrl: false, shift: false });
  const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
  const [bars, setBars] = useState<Bar[]>([]);
  const [quote, setQuote] = useState<number | null>(null);
  const [change, setChange] = useState<number | null>(null);
  const [draft, setDraft] = useState(symbol);
  const [message, setMessage] = useState("");
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [watchQuotes, setWatchQuotes] = useState<Record<string, { price: number; change: number }>>({});
  const [watchDraft, setWatchDraft] = useState("");
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  const [pendingPoint, setPendingPoint] = useState(false);
  const [magnet, setMagnet] = useState(false);
  const [watchlistLoaded, setWatchlistLoaded] = useState(false);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  useEffect(() => setDraft(symbol), [symbol]);
  useEffect(() => {
    const legacyView = readSaved("cd.view", { drawings: true, alerts: true });
    const legacyPreferences: Preferences = {
      ...defaultPreferences,
      timeframe: readSaved("cd.tf", defaultPreferences.timeframe),
      candleType: readSaved("cd.ctype", defaultPreferences.candleType),
      indicators: { ...defaultPreferences.indicators, ...readSaved("cd.ind", {}) },
      drawingsVisible: legacyView.drawings,
      alertsVisible: legacyView.alerts,
      magnet: readSaved("cd.magnet", false),
    };
    setPreferences(readSaved("tradechart.preferences", legacyPreferences));
    setDrawings(readSaved("tradechart.drawings", readSaved("cd.lines", [])));
  }, []);
  useEffect(() => { try { localStorage.setItem("tradechart.preferences", JSON.stringify(preferences)); } catch { /* Storage can be unavailable. */ } }, [preferences]);
  useEffect(() => { try { localStorage.setItem("tradechart.drawings", JSON.stringify(drawings)); } catch { /* Storage can be unavailable. */ } }, [drawings]);
  useEffect(() => {
    let active = true;
    async function loadWatchlist() {
      const legacy = readSaved<string[]>("tradechart.watchlist", readSaved("cd.watch", ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]));
      try {
        let response = await fetch(`${API}/watchlist/`, { cache: "no-store" });
        if (!response.ok) throw new Error("Could not load the database watchlist.");
        let rows = await response.json() as { symbol: string }[];
        const symbols = new Set(rows.map((row) => row.symbol));
        for (const value of legacy) {
          const pair = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
          if (!pair || symbols.has(pair)) continue;
          const added = await fetch(`${API}/watchlist/`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ symbol: pair }), cache: "no-store",
          });
          if (added.ok) symbols.add(pair);
        }
        response = await fetch(`${API}/watchlist/`, { cache: "no-store" });
        if (!response.ok) throw new Error("Could not reload the database watchlist.");
        rows = await response.json() as { symbol: string }[];
        if (!active) return;
        setWatchlist(rows.map((row) => row.symbol));
        try { localStorage.removeItem("tradechart.watchlist"); localStorage.removeItem("cd.watch"); } catch { /* Storage can be unavailable. */ }
      } catch {
        if (active) {
          setWatchlist(legacy);
          setMessage("Could not load the saved watchlist from the backend.");
        }
      } finally {
        if (active) setWatchlistLoaded(true);
      }
    }
    void loadWatchlist();
    return () => { active = false; };
  }, []);
  useEffect(() => { setMagnet(preferences.magnet); }, [preferences.magnet]);
  useEffect(() => {
    const update = (event: KeyboardEvent) => { modifiers.current = { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey }; };
    const clear = () => { modifiers.current = { ctrl: false, shift: false }; };
    window.addEventListener("keydown", update); window.addEventListener("keyup", update); window.addEventListener("blur", clear);
    return () => { window.removeEventListener("keydown", update); window.removeEventListener("keyup", update); window.removeEventListener("blur", clear); };
  }, []);

  const timeframe = preferences.timeframe;
  useEffect(() => {
    const chartElement = host.current;
    const macdElement = macdHost.current;
    if (!chartElement || !macdElement) return;
    let active = true;
    let poller: number | undefined;
    const chart = createChart(chartElement, {
      width: chartElement.clientWidth, height: chartElement.clientHeight,
      layout: { background: { type: ColorType.Solid, color: colors.bg }, textColor: colors.text, fontFamily: "DM Sans, sans-serif" },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } }, crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: colors.line }, timeScale: { borderColor: colors.line, timeVisible: true, rightOffset: 8 },
    });
    const candles = chart.addCandlestickSeries({ upColor: colors.green, downColor: colors.red, wickUpColor: colors.green, wickDownColor: colors.red, borderVisible: false });
    const volume = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const smaSeries = chart.addLineSeries({ color: colors.amber, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const emaSeries = chart.addLineSeries({ color: "#6482a7", lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const macdChart = createChart(macdElement, {
      width: macdElement.clientWidth, height: macdElement.clientHeight,
      layout: { background: { type: ColorType.Solid, color: colors.bg }, textColor: colors.text, fontFamily: "DM Sans, sans-serif" },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } }, crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: colors.line }, timeScale: { borderColor: colors.line, timeVisible: true, rightOffset: 8 },
    });
    const histogram = macdChart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
    const macdLine = macdChart.addLineSeries({ color: colors.blue, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const signalLine = macdChart.addLineSeries({ color: colors.amber, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    chartApi.current = chart; macdApi.current = macdChart;
    series.current = { candles, volume, sma: smaSeries, ema: emaSeries };
    macdSeries.current = { histogram, line: macdLine, signal: signalLine };
    const observer = new ResizeObserver(() => {
      if (chartElement.clientWidth && chartElement.clientHeight) chart.applyOptions({ width: chartElement.clientWidth, height: chartElement.clientHeight });
      if (macdElement.clientWidth && macdElement.clientHeight) macdChart.applyOptions({ width: macdElement.clientWidth, height: macdElement.clientHeight });
    });
    observer.observe(chartElement); observer.observe(macdElement);
    chart.subscribeClick((param) => {
      if (!param.point) return;
      const price = candles.coordinateToPrice(param.point.y);
      const activeTool = modeRef.current;
      if (price !== null && !activeTool && param.time) onPriceSelect(String(Number(price.toPrecision(10))));
      if (!activeTool) return;
      const logical = chart.timeScale().coordinateToLogical(param.point.x);
      if (logical === null) return;
      const data = barsRef.current;
      if (!data.length || price === null) return;
      const logicalIndex = Math.max(0, Math.round(logical));
      const index = Math.min(data.length - 1, logicalIndex);
      const bar = data[index];
      const candle = preferencesRef.current.candleType === "ha" ? heikinAshi(data)[index] : bar;
      const snappedPrice = preferencesRef.current.magnet || modifiers.current.ctrl ? [candle.open, candle.high, candle.low, candle.close].sort((a, b) => Math.abs(a - price) - Math.abs(b - price))[0] : price;
      const finalPrice = modifiers.current.shift && pendingRef.current ? pendingRef.current.price : snappedPrice;
      const last = data.at(-1)!;
      const time = logicalIndex < data.length
        ? Number(data[logicalIndex].time)
        : Number(last.time) + (logicalIndex - data.length + 1) * intervalSeconds[timeframe];
      const point = { time, price: finalPrice };
      if (activeTool === "hline" || activeTool === "hray") {
        const line: Drawing = { id: idFor(), symbol, type: activeTool, t1: point.time, p1: point.price, width: 2, opacity: 1 };
        setDrawings((current) => [...current, line]); setSelected(line.id); setTool(null); modeRef.current = null; pendingRef.current = null; setPendingPoint(false);
      } else if (!pendingRef.current) { pendingRef.current = point; setPendingPoint(true); }
      else {
        const first = pendingRef.current;
        if (first.time === point.time) return;
        const [left, right] = first.time < point.time ? [first, point] : [point, first];
        const line: Drawing = { id: idFor(), symbol, type: activeTool, t1: left.time, p1: left.price, t2: right.time, p2: right.price, width: 2, opacity: 1 };
        setDrawings((current) => [...current, line]); setSelected(line.id); setTool(null); modeRef.current = null; pendingRef.current = null; setPendingPoint(false);
      }
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => { if (range) macdChart.timeScale().setVisibleLogicalRange(range); });
    macdChart.timeScale().subscribeVisibleLogicalRangeChange((range) => { if (range) chart.timeScale().setVisibleLogicalRange(range); });

    async function requestCandles(limit: number): Promise<Bar[]> {
      const response = await fetch(`${API}/market/candles/?symbol=${encodeURIComponent(symbol)}&interval=${timeframe}&limit=${limit}`, { cache: "no-store" });
      const payload = await response.json().catch(() => []) as Bar[] | { detail?: string };
      if (!response.ok || !Array.isArray(payload)) throw new Error((payload as { detail?: string }).detail ?? "Market data is unavailable.");
      return payload.map((bar) => ({ ...bar, time: bar.time as UTCTimestamp }));
    }

    function renderBars(data: Bar[]) {
      barsRef.current = data; setBars(data);
      candles.setData(preferencesRef.current.candleType === "ha" ? heikinAshi(data) : data);
      volume.setData(data.map((bar) => ({ time: bar.time, value: bar.volume, color: bar.close >= bar.open ? "rgba(77,148,104,.28)" : "rgba(191,102,88,.28)" })));
      if (data.at(-1)) setQuote(data.at(-1)!.close);
    }

    async function load() {
      setMessage("Loading market data…"); setQuote(null); setChange(null);
      try {
        const data = await requestCandles(1000);
        if (!active) return;
        renderBars(data);
        chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, data.length - 160), to: data.length + 8 });
        poller = window.setInterval(() => {
          void requestCandles(2).then((latest) => {
            if (!active || !latest.length) return;
            const merged = [...barsRef.current];
            for (const bar of latest) {
              const last = merged.at(-1);
              if (last?.time === bar.time) merged[merged.length - 1] = bar;
              else if (!last || bar.time > last.time) merged.push(bar);
            }
            renderBars(merged);
          }).catch(() => { if (active) setMessage("Live market data is temporarily unavailable."); });
        }, 8000);
        setMessage("");
      } catch (error) { if (active) setMessage(error instanceof Error ? error.message : "Could not load market data."); }
    }
    void load();
    return () => { active = false; if (poller !== undefined) window.clearInterval(poller); observer.disconnect(); chart.remove(); macdChart.remove(); chartApi.current = null; macdApi.current = null; series.current = null; macdSeries.current = null; };
  }, [symbol, exchange, timeframe, theme, onPriceSelect]);

  useEffect(() => {
    const chart = chartApi.current; const macdChart = macdApi.current; const current = series.current; const macd = macdSeries.current;
    if (!chart || !macdChart || !current || !macd) return;
    const data = bars;
    current.candles.setData(preferences.candleType === "ha" ? heikinAshi(data) : data);
    current.volume.setData(preferences.indicators.vol ? data.map((bar) => ({ time: bar.time, value: bar.volume, color: bar.close >= bar.open ? "rgba(77,148,104,.28)" : "rgba(191,102,88,.28)" })) : []);
    current.sma.setData(preferences.indicators.sma20 ? movingAverage(data, 20) : []);
    const closes = data.map((bar) => bar.close); const emaValues = ema(closes, 50);
    current.ema.setData(preferences.indicators.ema50 ? data.flatMap((bar, index) => emaValues[index] === null ? [] : [{ time: bar.time, value: emaValues[index]! }]) : []);
    const enabled = preferences.indicators.macd;
    if (macdHost.current) macdHost.current.hidden = !enabled;
    chart.applyOptions({ timeScale: { visible: !enabled } });
    if (!enabled || data.length < 35) { macd.histogram.setData([]); macd.line.setData([]); macd.signal.setData([]); return; }
    const fast = ema(closes, 12); const slow = ema(closes, 26);
    const values = closes.map((_, index) => fast[index] !== null && slow[index] !== null ? fast[index]! - slow[index]! : null);
    const signal: (number | null)[] = Array(values.length).fill(null);
    const seed: number[] = [];
    for (let index = 25; index < values.length; index += 1) {
      const value = values[index];
      if (value === null) continue;
      if (seed.length < 9) {
        seed.push(value);
        if (seed.length === 9) signal[index] = seed.reduce((sum, item) => sum + item, 0) / 9;
      } else signal[index] = value * (2 / 10) + (signal[index - 1] ?? value) * (8 / 10);
    }
    macd.histogram.setData(data.flatMap((bar, index) => values[index] === null || signal[index] === null ? [] : [{ time: bar.time, value: values[index]! - signal[index]!, color: values[index]! >= signal[index]! ? "rgba(77,148,104,.65)" : "rgba(191,102,88,.65)" }]));
    macd.line.setData(data.flatMap((bar, index) => values[index] === null ? [] : [{ time: bar.time, value: values[index]! }]));
    macd.signal.setData(data.flatMap((bar, index) => signal[index] === null || index < 25 ? [] : [{ time: bar.time, value: signal[index]! }]));
    const range = chart.timeScale().getVisibleLogicalRange(); if (range && enabled) macdChart.timeScale().setVisibleLogicalRange(range);
  }, [bars, preferences]);

  useEffect(() => {
    const candles = series.current?.candles;
    if (!candles) return;
    const lines = preferences.alertsVisible ? alerts.filter((item) => item.kind === "price" && item.symbol === symbol && item.active && !item.line_type && item.price) : [];
    const rendered = lines.map((item) => candles.createPriceLine({ price: Number(item.price), color: colors.amber, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: `Alert · ${item.condition.replaceAll("_", " ")}` }));
    return () => rendered.forEach((line) => candles.removePriceLine(line));
  }, [alerts, symbol, theme, preferences.alertsVisible]);

  useEffect(() => {
    const chart = chartApi.current; const canvasElement = canvas.current; const current = series.current;
    if (!chart || !canvasElement || !current) return;
    let animation = 0;
    const paint = () => {
      const bounds = canvasElement.getBoundingClientRect(); const ratio = window.devicePixelRatio || 1;
      canvasElement.width = Math.round(bounds.width * ratio); canvasElement.height = Math.round(bounds.height * ratio);
      const context = canvasElement.getContext("2d"); if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, bounds.width, bounds.height);
      for (const line of drawings) {
        if (line.symbol !== symbol || line.hidden || !preferences.drawingsVisible) continue;
        const x1 = drawingCoordinate(chart, line.t1, barsRef.current, timeframe); const y1 = current.candles.priceToCoordinate(line.p1);
        if (x1 === null || y1 === null) continue;
        const endX = line.t2 === undefined ? bounds.width : drawingCoordinate(chart, line.t2, barsRef.current, timeframe);
        const endY = line.p2 === undefined ? y1 : current.candles.priceToCoordinate(line.p2);
        if (endX === null || endY === null) continue;
        let x2 = Number(endX); let y2 = Number(endY);
        let drawX1 = Number(x1);
        if (line.type === "hline") drawX1 = 0;
        if (line.type === "hline" || line.type === "hray") { x2 = bounds.width; y2 = Number(y1); }
        if ((line.type === "ray" || (line.type === "trend" && line.extend)) && line.t2 !== undefined && line.p2 !== undefined && x2 !== Number(x1)) {
          y2 = Number(y1) + ((y2 - Number(y1)) * (bounds.width - Number(x1))) / (x2 - Number(x1)); x2 = bounds.width;
        }
        const attached = alerts.find((alert) => alert.line_type === line.type && alert.line_t1 && Math.abs(Number(alert.line_price1) - line.p1) < 1e-10 && Math.abs(new Date(alert.line_t1).getTime() / 1000 - line.t1) < 2);
        context.globalAlpha = line.opacity; context.strokeStyle = attached?.active && preferences.alertsVisible ? colors.amber : colors.blue; context.lineWidth = line.width;
        context.beginPath(); context.moveTo(drawX1, y1); context.lineTo(x2, y2); context.stroke(); context.globalAlpha = 1;
        if (selected === line.id) for (const [x, y] of [[x1, y1], [line.t2 === undefined ? x1 : drawingCoordinate(chart, line.t2, barsRef.current, timeframe) ?? x1, line.p2 === undefined ? y1 : current.candles.priceToCoordinate(line.p2) ?? y1]]) {
          context.fillStyle = colors.bg; context.strokeStyle = colors.blue; context.beginPath(); context.arc(x, y, 4, 0, Math.PI * 2); context.fill(); context.stroke();
        }
      }
      animation = requestAnimationFrame(paint);
    };
    paint(); return () => cancelAnimationFrame(animation);
  }, [bars, drawings, symbol, selected, theme, timeframe, preferences.drawingsVisible, preferences.alertsVisible, alerts]);

  useEffect(() => {
    let valid = true;
    async function updateQuotes() {
      const symbols = [...new Set([...watchlist, symbol])];
      await Promise.all(symbols.map(async (pair) => {
        try {
          const response = await fetch(`${API}/market/quote/?symbol=${encodeURIComponent(pair)}`, { cache: "no-store" });
          if (!response.ok) return;
          const item = await response.json() as { price: number; change: number };
          if (valid) setWatchQuotes((quotes) => ({ ...quotes, [pair]: item }));
        } catch { /* A missing quote does not interrupt the chart. */ }
      }));
    }
    void updateQuotes(); const timer = window.setInterval(() => void updateQuotes(), 8000);
    return () => { valid = false; window.clearInterval(timer); };
  }, [symbol, watchlist, exchange]);

  useEffect(() => {
    if (quote === null) return;
    const seconds = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 }[timeframe];
    const previous = bars[Math.max(0, bars.length - Math.ceil(86400 / seconds))]?.close;
    if (previous) setChange((quote - previous) / previous * 100);
  }, [quote, bars, timeframe]);

  function changePreferences(update: Partial<Preferences>) { setPreferences((current) => ({ ...current, ...update })); }
  function toggleIndicator(key: keyof Preferences["indicators"]) { setPreferences((current) => ({ ...current, indicators: { ...current.indicators, [key]: !current.indicators[key] } })); }
  function submitSymbol(event: FormEvent) { event.preventDefault(); if (draft.trim()) onSymbolChange(draft.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")); }
  async function addWatch(event: FormEvent) {
    event.preventDefault(); const pair = watchDraft.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!pair || watchlist.includes(pair)) return;
    try {
      const quoteResponse = await fetch(`${API}/market/quote/?symbol=${encodeURIComponent(pair)}`, { cache: "no-store" });
      if (!quoteResponse.ok) throw new Error(`${pair} is not available on ${exchange === "binance" ? "Binance" : "Bybit"}.`);
      const response = await fetch(`${API}/watchlist/`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: pair }), cache: "no-store",
      });
      if (!response.ok) throw new Error("Could not save this pair to the database watchlist.");
      setWatchlist((items) => items.includes(pair) ? items : [...items, pair]);
      setWatchDraft(""); setMessage("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not add this pair."); }
  }
  async function removeWatch(pair: string) {
    try {
      const response = await fetch(`${API}/watchlist/${encodeURIComponent(pair)}/`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not remove this pair from the database watchlist.");
      setWatchlist((items) => items.filter((item) => item !== pair));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not remove this pair."); }
  }
  function chooseTool(next: Tool) { const value = tool === next ? null : next; setTool(value); modeRef.current = value; pendingRef.current = null; setPendingPoint(false); }
  function removeDrawing(id: string) {
    const drawing = drawings.find((line) => line.id === id);
    if (drawing) onDeleteLineAlert(drawing);
    setDrawings((items) => items.filter((line) => line.id !== id)); if (selected === id) setSelected(null);
  }
  function pointAt(clientX: number, clientY: number) {
    const chart = chartApi.current; const candleSeries = series.current?.candles; const element = host.current;
    if (!chart || !candleSeries || !element || !barsRef.current.length) return null;
    const bounds = element.getBoundingClientRect(); const x = clientX - bounds.left; const y = clientY - bounds.top;
    const logical = chart.timeScale().coordinateToLogical(x); const price = candleSeries.coordinateToPrice(y);
    if (logical === null || price === null) return null;
    const index = Math.round(logical); const data = barsRef.current;
    const step = intervalSeconds[timeframe];
    const time = index < 0 ? Number(data[0].time) + index * step : index >= data.length ? Number(data.at(-1)!.time) + (index - data.length + 1) * step : Number(data[index].time);
    let value = Number(price);
    if (preferencesRef.current.magnet || modifiers.current.ctrl) {
      const bar = preferencesRef.current.candleType === "ha" ? heikinAshi(data)[Math.max(0, Math.min(data.length - 1, index))] : data[Math.max(0, Math.min(data.length - 1, index))];
      value = [bar.open, bar.high, bar.low, bar.close].sort((a, b) => Math.abs(a - value) - Math.abs(b - value))[0];
    }
    return { time, price: modifiers.current.shift && dragRef.current?.part === "p2" ? dragRef.current.original.p1 : value };
  }
  function handleDrawingPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!selected || tool) return;
    const line = drawings.find((item) => item.id === selected && item.symbol === symbol);
    const chart = chartApi.current; const candleSeries = series.current?.candles; const element = host.current;
    if (!line || !chart || !candleSeries || !element) { setSelected(null); return; }
    const bounds = element.getBoundingClientRect(); const x = event.clientX - bounds.left; const y = event.clientY - bounds.top;
    const x1 = drawingCoordinate(chart, line.t1, barsRef.current, timeframe); const y1 = candleSeries.priceToCoordinate(line.p1);
    const x2 = line.t2 === undefined ? bounds.width : drawingCoordinate(chart, line.t2, barsRef.current, timeframe);
    const y2 = line.p2 === undefined ? y1 : candleSeries.priceToCoordinate(line.p2);
    if (x1 === null || y1 === null || x2 === null || y2 === null) { setSelected(null); return; }
    const distance = (ax: number, ay: number, bx: number, by: number) => {
      const dx = bx - ax; const dy = by - ay; const length = dx * dx + dy * dy;
      const fraction = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
      return Math.hypot(x - (ax + fraction * dx), y - (ay + fraction * dy));
    };
    const firstDistance = Math.hypot(x - Number(x1), y - Number(y1));
    const secondDistance = line.t2 === undefined ? Infinity : Math.hypot(x - Number(x2), y - Number(y2));
    const bodyDistance = distance(Number(x1), Number(y1), Number(x2), Number(y2));
    const part = firstDistance < 11 ? "p1" : secondDistance < 11 ? "p2" : bodyDistance < 8 ? "body" : null;
    if (!part) { setSelected(null); return; }
    const start = pointAt(event.clientX, event.clientY); if (!start) return;
    dragRef.current = { id: line.id, part, start, original: { ...line } };
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
  }
  function handleDrawingPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current; if (!drag) return;
    const point = pointAt(event.clientX, event.clientY); if (!point) return;
    const original = drag.original; const hasSecond = original.t2 !== undefined && original.p2 !== undefined;
    let next: Drawing;
    if (drag.part === "p1") {
      next = { ...original, t1: point.time, p1: point.price };
      if (hasSecond && next.t2 !== undefined && next.p2 !== undefined && next.t1 > next.t2) { [next.t1, next.t2] = [next.t2, next.t1]; [next.p1, next.p2] = [next.p2, next.p1]; }
    } else if (drag.part === "p2" && hasSecond) {
      next = { ...original, t2: point.time, p2: point.price };
      if (next.t2 !== undefined && next.p2 !== undefined && next.t2 < next.t1) { [next.t1, next.t2] = [next.t2, next.t1]; [next.p1, next.p2] = [next.p2, next.p1]; }
    } else {
      const deltaTime = point.time - drag.start.time; const deltaPrice = point.price - drag.start.price;
      next = { ...original, t1: original.type === "hline" ? original.t1 : original.t1 + deltaTime, p1: original.p1 + deltaPrice };
      if (hasSecond) { next.t2 = original.t2! + deltaTime; next.p2 = original.p2! + deltaPrice; }
    }
    setDrawings((items) => items.map((item) => item.id === drag.id ? next : item));
  }
  function handleDrawingPointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragRef.current; if (!drag) return;
    dragRef.current = null;
    const line = drawings.find((item) => item.id === drag.id);
    const linked = alerts.find((item) => item.symbol === drag.original.symbol && item.line_type === drag.original.type && item.line_t1 && Math.abs(new Date(item.line_t1).getTime() / 1000 - drag.original.t1) < 2 && Math.abs(Number(item.line_price1) - drag.original.p1) < 1e-10);
    if (line && linked) onUpdateLineAlert({ ...line, id: linked.id.toString() });
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function updateDrawing(id: string, update: Partial<Drawing>) {
    setDrawings((items) => items.map((line) => {
      if (line.id !== id) return line;
      const next = { ...line, ...update };
      const attached = alerts.find((alert) => alert.line_type === next.type && alert.line_t1 && Math.abs(Number(alert.line_price1) - next.p1) < 1e-10 && Math.abs(new Date(alert.line_t1).getTime() / 1000 - next.t1) < 2);
      if (attached && (update.t1 !== undefined || update.p1 !== undefined || update.t2 !== undefined || update.p2 !== undefined || update.extend !== undefined || update.repeat !== undefined)) onUpdateLineAlert({ ...next, id: attached.id.toString() } as Drawing);
      return next;
    }));
  }

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.target instanceof HTMLElement && event.target.matches("input, select, textarea")) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") { setTool(null); modeRef.current = null; pendingRef.current = null; setPendingPoint(false); setSelected(null); return; }
      if ((event.key === "Delete" || event.key === "Backspace") && selected) { event.preventDefault(); removeDrawing(selected); return; }
      const keyTools: Record<string, Tool> = { t: "trend", r: "ray", h: "hline", j: "hray" };
      const next = keyTools[event.key.toLowerCase()];
      if (next) chooseTool(next);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [selected, tool]);
  const dayChange = watchQuotes[symbol]?.change ?? change;

  return <div className="workspace-grid">
    <section className="market panel">
      <div className="market-head">
        <div className="market-identity"><span className="eyebrow">LIVE MARKET · {exchange.toUpperCase()} SPOT</span><div><strong>{symbol}</strong>{quote !== null && <b>{fmt(quote)}</b>}{dayChange !== null && <small className={dayChange >= 0 ? "positive" : "negative"}>{dayChange >= 0 ? "+" : ""}{dayChange.toFixed(2)}% 24H</small>}</div></div>
        <div className="chart-tools">
          <select aria-label="Exchange" value={exchange} onChange={(event) => onExchangeChange?.(event.target.value as "binance" | "bybit")}><option value="binance">Binance</option><option value="bybit">Bybit</option></select>
          <div className="timeframes">{intervals.map((interval) => <button key={interval} className={timeframe === interval ? "chosen" : ""} onClick={() => changePreferences({ timeframe: interval })}>{interval}</button>)}</div>
          <form className="chart-symbol" onSubmit={submitSymbol}><span>PAIR</span><input aria-label="Market symbol" value={draft} maxLength={24} onChange={(event) => setDraft(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} /><button type="submit">Go</button></form>
        </div>
      </div>
      <div className="workspace-controls">
        <div className="mode-switch"><button aria-pressed={preferences.candleType === "candles"} className={preferences.candleType === "candles" ? "chosen" : ""} onClick={() => changePreferences({ candleType: "candles" })}>Candles</button><button aria-pressed={preferences.candleType === "ha"} className={preferences.candleType === "ha" ? "chosen" : ""} onClick={() => changePreferences({ candleType: "ha" })}>Heikin Ashi</button></div>
        {([ ["sma20", "SMA 20"], ["ema50", "EMA 50"], ["vol", "Volume"], ["macd", "MACD"] ] as const).map(([key, label]) => <button aria-pressed={preferences.indicators[key]} className={`indicator-chip ${preferences.indicators[key] ? "active" : ""}`} key={key} onClick={() => toggleIndicator(key)}>{label}</button>)}
      </div>
      <div className="drawing-toolbar" aria-label="Chart drawing tools">
        {lineTools.map((item) => <button key={item} aria-pressed={tool === item} className={tool === item ? "active" : ""} title={`${item} (${item === "trend" ? "T" : item === "ray" ? "R" : item === "hline" ? "H" : "J"})`} onClick={() => chooseTool(item)}>{item === "trend" ? "╱ Trendline" : item === "ray" ? "↗ Ray" : item === "hline" ? "— Horizontal" : "⊢ Horizontal ray"}</button>)}
        <button className={magnet ? "active" : ""} aria-pressed={magnet} onClick={() => { const next = !magnet; setMagnet(next); changePreferences({ magnet: next }); }}>Magnet</button>
        <button className={preferences.drawingsVisible ? "" : "active"} onClick={() => changePreferences({ drawingsVisible: !preferences.drawingsVisible })}>{preferences.drawingsVisible ? "Hide drawings" : "Show drawings"}</button>
        <button className={preferences.alertsVisible ? "" : "active"} onClick={() => changePreferences({ alertsVisible: !preferences.alertsVisible })}>{preferences.alertsVisible ? "Hide alert lines" : "Show alert lines"}</button>
        {tool && <span className="tool-hint">{tool === "hline" || tool === "hray" ? "Click a price level" : pendingPoint ? "Click the second point" : "Click the first point"}; Esc cancels</span>}
      </div>
      <div className="chart-area workspace-chart-area"><div ref={host} className="chart-container workspace-chart" /><canvas ref={canvas} className={`drawing-overlay ${selected && !tool ? "interactive" : ""}`} onPointerDown={handleDrawingPointerDown} onPointerMove={handleDrawingPointerMove} onPointerUp={handleDrawingPointerUp} onPointerCancel={handleDrawingPointerUp} aria-label="Selected chart drawing; drag to edit" />{message && <div className="chart-message">{message}</div>}</div>
      <div ref={macdHost} className="macd-chart" hidden={!preferences.indicators.macd} />
      <p className="chart-hint">Click the chart to fill a price target. Drawing tools accept one or two points; enable Magnet to snap points to candle OHLC.</p>
    </section>
    <aside className="workspace-side">
      <section className="panel workspace-panel">
        <div className="panel-head"><div><p className="eyebrow">MARKETS</p><h2>Watchlist</h2></div><span className="count">{watchlist.length} PAIRS</span></div>
        <div className="watchlist">{watchlist.map((pair) => <div className={`watch-row ${pair === symbol ? "current" : ""}`} key={pair}>
          <button className="watch-pair" onClick={() => onSymbolChange(pair)}>{pair}</button><span>{fmt(watchQuotes[pair]?.price ?? null)}</span><small className={(watchQuotes[pair]?.change ?? 0) >= 0 ? "positive" : "negative"}>{watchQuotes[pair] ? `${watchQuotes[pair].change >= 0 ? "+" : ""}${watchQuotes[pair].change.toFixed(2)}%` : "–"}</small><button className="remove-watch" disabled={!watchlistLoaded} aria-label={`Remove ${pair}`} onClick={() => void removeWatch(pair)}>×</button>
        </div>)}</div>
        <form className="watch-add" onSubmit={addWatch}><input aria-label="Add symbol to watchlist" value={watchDraft} disabled={!watchlistLoaded} placeholder="Add symbol, e.g. ADAUSDT" onChange={(event) => setWatchDraft(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} /><button type="submit" disabled={!watchlistLoaded}>Add</button></form>
      </section>
      <section className="panel workspace-panel">
        <div className="panel-head"><div><p className="eyebrow">ANNOTATE</p><h2>Drawings</h2></div><span className="count">{drawings.filter((line) => line.symbol === symbol).length} ON {symbol}</span></div>
        {drawings.filter((line) => line.symbol === symbol).length ? <div className="drawing-list">{drawings.filter((line) => line.symbol === symbol).map((line, index) => {
          const attached = alerts.find((alert) => alert.line_type === line.type && alert.line_t1 && Math.abs(Number(alert.line_price1) - line.p1) < 1e-10 && Math.abs(new Date(alert.line_t1).getTime() / 1000 - line.t1) < 2);
          return <article className={`drawing-item ${selected === line.id ? "selected" : ""} ${line.hidden ? "muted" : ""}`} key={line.id} onClick={() => setSelected(line.id)}>
            <div className="drawing-item-head"><b>{line.type === "hline" ? "Horizontal line" : line.type === "hray" ? "Horizontal ray" : line.type === "ray" ? "Ray" : "Trendline"} {index + 1}</b><span>{fmt(lineValue(line, Date.now() / 1000))}</span><button type="button" onClick={(event) => { event.stopPropagation(); updateDrawing(line.id, { hidden: !line.hidden }); }}>{line.hidden ? "Show" : "Hide"}</button><button type="button" aria-label="Delete drawing" onClick={(event) => { event.stopPropagation(); removeDrawing(line.id); }}>×</button></div>
            <div className="drawing-options"><label>Width<select value={line.width} onChange={(event) => updateDrawing(line.id, { width: +event.target.value })}>{[1, 2, 3, 4, 5, 6].map((width) => <option key={width} value={width}>{width}px</option>)}</select></label><label>Opacity<input type="range" min="10" max="100" step="5" value={Math.round(line.opacity * 100)} onChange={(event) => updateDrawing(line.id, { opacity: +event.target.value / 100 })} /></label><label className="check-label"><input type="checkbox" checked={!!line.extend} disabled={line.type !== "trend"} onChange={(event) => updateDrawing(line.id, { extend: event.target.checked })} /> Extend</label></div>
            <div className="drawing-options"><label>Alert<select value={attached?.condition ?? ""} onChange={(event) => { if (event.target.value) void onCreateLineAlert(line, event.target.value, line.repeat ? "every" : "once"); else onDeleteLineAlert(line); }}><option value="">No alert</option><option value="cross">On touch</option><option value="cross_up">Cross above</option><option value="cross_down">Cross below</option></select></label><label className="check-label"><input type="checkbox" checked={!!line.repeat} onChange={(event) => updateDrawing(line.id, { repeat: event.target.checked })} /> Repeat</label>{attached && <span className={attached.active ? "positive" : "negative"}>{attached.active ? "Armed" : "Triggered"}</span>}</div>
          </article>;
        })}</div> : <p className="empty workspace-empty">Choose a drawing tool above, then click the chart to place it.</p>}
      </section>
    </aside>
  </div>;
}