"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import MarketWorkspace, { type Drawing } from "./market-workspace";

type AlertItem = {
  id: number; symbol: string; kind: "price" | "macd"; condition: string;
  price: string | null; timeframe: string; note: string; frequency: "once" | "every";
  active: boolean; created_at: string; last_triggered_at: string | null;
  line_type?: string; line_t1?: string; line_price1?: string; line_t2?: string | null;
  line_price2?: string | null; line_extend?: boolean;
  rsi_period?: number; rsi_oversold?: number; rsi_overbought?: number;
  macd_threshold_5?: boolean; macd_threshold_10?: boolean; rsi_enabled?: boolean;
  trend_enabled?: boolean; trend_period?: number;
};
type EventItem = { id: number; symbol: string; title: string; message: string; triggered_at: string };
type Exchange = "binance" | "bybit";
type ToastItem = { id: number; title: string; message: string };
const API = "/api/proxy";
const conditions: Record<string, string> = {
  cross_up: "crosses above", cross_down: "crosses below", cross: "crosses",
  above: "is above", below: "is below",
};
type MacdCondition = "cross_up" | "cross_down" | "cross";
const timeframes = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] as const;
const macdConditions: MacdCondition[] = ["cross_up", "cross_down", "cross"];
const macdConditionText: Record<MacdCondition, string> = {
  cross_up: "crosses above the signal line",
  cross_down: "crosses below the signal line",
  cross: "crosses the signal line in either direction",
};
const defaultRsiSettings = { period: "14", oversold: "30", overbought: "70" };

/** Turn a DRF validation payload into a short sentence instead of raw JSON. */
function readableError(reason: unknown, fallback: string) {
  if (!(reason instanceof Error)) return fallback;
  const text = reason.message;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const messages = Object.entries(parsed).flatMap(([field, value]) => {
      const label = field === "detail" ? "" : `${field.replace(/_/g, " ")}: `;
      const items = Array.isArray(value) ? value : [value];
      return items
        .map((item) => String(item).trim())
        .filter(Boolean)
        .map((item) => `${label}${item.replace(/\.?$/, ".")}`);
    }).filter(Boolean);
    if (messages.length) return messages.join(" · ");
  } catch { /* The API answered with plain text. */ }
  return text || fallback;
}

/** Mirror the serializer rules so bad combinations fail before the request. */
function macdFieldErrors(input: {
  rsiEnabled: boolean; rsi: { period: string; oversold: string; overbought: string };
  trendEnabled: boolean; trendPeriod: string;
}) {
  const errors: Record<string, string> = {};
  if (input.rsiEnabled) {
    const period = Number(input.rsi.period);
    const oversold = Number(input.rsi.oversold);
    const overbought = Number(input.rsi.overbought);
    if (!Number.isInteger(period) || period < 2 || period > 100) errors.rsi_period = "Use a whole number between 2 and 100.";
    if (!Number.isFinite(oversold) || oversold < 0 || oversold > 100) errors.rsi_oversold = "Use a value between 0 and 100.";
    if (!Number.isFinite(overbought) || overbought < 0 || overbought > 100) errors.rsi_overbought = "Use a value between 0 and 100.";
    if (!errors.rsi_oversold && !errors.rsi_overbought && oversold >= overbought) errors.rsi_oversold = "Oversold must be lower than overbought.";
  }
  if (input.trendEnabled) {
    const period = Number(input.trendPeriod);
    if (!Number.isInteger(period) || period < 2 || period > 500) errors.trend_period = "Use a whole number between 2 and 500.";
  }
  return errors;
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(JSON.stringify(payload) || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export default function Home() {
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [kind, setKind] = useState<"price" | "macd">("price");
  const [marketSymbol, setMarketSymbol] = useState("BTCUSDT");
  const [exchange, setExchange] = useState<Exchange>("binance");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [targetPrice, setTargetPrice] = useState("");
  const [macdTimeframe, setMacdTimeframe] = useState<(typeof timeframes)[number]>("1h");
  const [macdCondition, setMacdCondition] = useState<MacdCondition>("cross_up");
  const [macdThreshold5, setMacdThreshold5] = useState(false);
  const [macdThreshold10, setMacdThreshold10] = useState(false);
  const [rsiEnabled, setRsiEnabled] = useState(false);
  const [rsiSettings, setRsiSettings] = useState(defaultRsiSettings);
  const [trendEnabled, setTrendEnabled] = useState(false);
  const [trendPeriod, setTrendPeriod] = useState("200");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notificationAvailable, setNotificationAvailable] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [clearedThrough, setClearedThrough] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const seenEvents = useRef<Set<number> | null>(null);
  const audioRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    setNotificationAvailable("Notification" in window);
    try {
      localStorage.removeItem("tradechart.telegram");
      localStorage.removeItem("cd.tg");
      setClearedThrough(localStorage.getItem("tradechart.log-cleared-through") ?? "");
    } catch { /* Browser storage is optional. */ }
  }, []);

  useEffect(() => {
    try { if (localStorage.getItem("tradechart.theme") === "dark") setTheme("dark"); } catch { /* Storage can be unavailable. */ }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("tradechart.theme", theme); } catch { /* Storage can be unavailable. */ }
  }, [theme]);

  function toast(title: string, message: string) {
    const item = { id: Date.now() + Math.random(), title, message };
    setToasts((current) => [...current.slice(-3), item]);
    window.setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== item.id)), 8000);
  }
  function playAlertSound() {
    try {
      const context = audioRef.current ?? new AudioContext(); audioRef.current = context;
      if (context.state === "suspended") void context.resume();
      [0, 0.18, 0.36].forEach((delay, index) => {
        const oscillator = context.createOscillator(); const gain = context.createGain();
        oscillator.frequency.value = index === 2 ? 1175 : 880; oscillator.connect(gain); gain.connect(context.destination);
        const start = context.currentTime + delay; gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.15);
        oscillator.start(start); oscillator.stop(start + 0.16);
      });
    } catch { /* Audio may be disabled by the browser. */ }
  }
  function notifyEvent(item: EventItem) {
    toast(item.title, item.message); playAlertSound();
    if ("Notification" in window && Notification.permission === "granted") new Notification(item.title, { body: item.message, tag: `alert-${item.id}` });
  }

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [nextAlerts, nextEvents, nextExchange] = await Promise.all([
        api<AlertItem[]>("/alerts/"), api<EventItem[]>("/events/"), api<{ exchange: Exchange }>("/exchange/"),
      ]);
      if (seenEvents.current) nextEvents.filter((item) => !seenEvents.current?.has(item.id)).forEach(notifyEvent);
      seenEvents.current = new Set(nextEvents.map((item) => item.id));
      setAlerts(nextAlerts); setEvents(nextEvents); setExchange(nextExchange.exchange); setError("");
    } catch (reason) {
      setError(readableError(reason, "Could not reach the API."));
    } finally { setRefreshing(false); }
  }, []);

  async function selectExchange(next: Exchange) {
    try {
      const saved = await api<{ exchange: Exchange }>("/exchange/", { method: "POST", body: JSON.stringify({ exchange: next }) });
      setExchange(saved.exchange);
    } catch (reason) {
      setError(readableError(reason, "Could not change the exchange."));
      void refresh();
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  async function createAlert(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setFieldErrors({});
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const payload: Record<string, string | number | boolean> = {
      symbol: String(form.get("symbol")).trim().toUpperCase(),
      kind, condition: String(form.get("condition")), note: String(form.get("note") ?? "").trim(),
      frequency: String(form.get("frequency")),
    };
    if (kind === "price") payload.price = Number(form.get("price"));
    else {
      payload.timeframe = macdTimeframe;
      payload.condition = macdCondition;
      payload.macd_threshold_5 = macdThreshold5;
      payload.macd_threshold_10 = macdThreshold10;
      payload.rsi_enabled = rsiEnabled;
      if (rsiEnabled) {
        payload.rsi_period = Number(rsiSettings.period);
        payload.rsi_oversold = Number(rsiSettings.oversold);
        payload.rsi_overbought = Number(rsiSettings.overbought);
      }
      payload.trend_enabled = trendEnabled;
      if (trendEnabled) payload.trend_period = Number(trendPeriod);
      const errors = macdFieldErrors({ rsiEnabled, rsi: rsiSettings, trendEnabled, trendPeriod });
      if (Object.keys(errors).length) { setFieldErrors(errors); setBusy(false); return; }
    }
    try {
      await api<AlertItem>("/alerts/", { method: "POST", body: JSON.stringify(payload) });
      formElement.reset(); resetMacdForm(); await refresh(); requestNotifications();
    } catch (reason) {
      setError(readableError(reason, "Could not create alert."));
    } finally { setBusy(false); }
  }

  function resetMacdForm() {
    setTargetPrice(""); setMacdTimeframe("1h"); setMacdCondition("cross_up");
    setMacdThreshold5(false); setMacdThreshold10(false);
    setRsiEnabled(false); setRsiSettings(defaultRsiSettings);
    setTrendEnabled(false); setTrendPeriod("200"); setFieldErrors({});
  }

  async function toggleAlert(item: AlertItem) {
    try { await api<AlertItem>(`/alerts/${item.id}/`, { method: "PATCH", body: JSON.stringify({ active: !item.active }) }); await refresh(); }
    catch (reason) { setError(readableError(reason, "Could not update alert.")); }
  }
  async function deleteAlert(id: number) {
    try { await api<void>(`/alerts/${id}/`, { method: "DELETE" }); await refresh(); }
    catch (reason) { setError(readableError(reason, "Could not delete alert.")); }
  }

  async function createLineAlert(drawing: Drawing, condition: string, frequency: string) {
    const matching = alerts.find((item) => item.line_type === drawing.type && item.symbol === drawing.symbol && item.line_t1 && Math.abs(new Date(item.line_t1).getTime() / 1000 - drawing.t1) < 2 && Number(item.line_price1) === drawing.p1);
    const geometry = {
      line_type: drawing.type, line_t1: new Date(drawing.t1 * 1000).toISOString(), line_price1: drawing.p1,
      line_t2: drawing.t2 === undefined ? null : new Date(drawing.t2 * 1000).toISOString(),
      line_price2: drawing.p2 ?? null, line_extend: !!drawing.extend,
    };
    try {
      if (matching) await api<AlertItem>(`/alerts/${matching.id}/`, { method: "PATCH", body: JSON.stringify({ ...geometry, condition, frequency, active: true }) });
      else await api<AlertItem>("/alerts/", { method: "POST", body: JSON.stringify({ symbol: drawing.symbol, kind: "price", condition, frequency, note: "", ...geometry }) });
      await refresh();
    } catch (reason) { setError(readableError(reason, "Could not create drawing alert.")); }
  }
  async function updateLineAlert(drawing: Drawing) {
    const matching = alerts.find((item) => item.id === Number(drawing.id));
    if (!matching) return;
    try {
      await api<AlertItem>(`/alerts/${matching.id}/`, { method: "PATCH", body: JSON.stringify({
        line_type: drawing.type, line_t1: new Date(drawing.t1 * 1000).toISOString(), line_price1: drawing.p1,
        line_t2: drawing.t2 === undefined ? null : new Date(drawing.t2 * 1000).toISOString(), line_price2: drawing.p2 ?? null,
        line_extend: !!drawing.extend, frequency: drawing.repeat ? "every" : "once",
      }) });
      await refresh();
    } catch (reason) { setError(readableError(reason, "Could not update drawing alert.")); }
  }
  async function deleteLineAlert(drawing: Drawing) {
    const matching = alerts.find((item) => item.symbol === drawing.symbol && item.line_type === drawing.type && item.line_t1 && Math.abs(new Date(item.line_t1).getTime() / 1000 - drawing.t1) < 2 && Number(item.line_price1) === drawing.p1);
    if (matching) await deleteAlert(matching.id);
  }
  function clearLog() {
    const newest = events[0]?.triggered_at ?? new Date().toISOString();
    setClearedThrough(newest);
    try { localStorage.setItem("tradechart.log-cleared-through", newest); } catch { /* Browser storage is optional. */ }
  }
  function requestNotifications() {
    if ("Notification" in window) void Notification.requestPermission();
  }
  const activeCount = alerts.filter((item) => item.active).length;
  const macdSummary = (() => {
    const warnings = [macdThreshold5 ? "5%" : "", macdThreshold10 ? "10%" : ""].filter(Boolean);
    const parts = [`Notify when the ${marketSymbol || "selected pair"} MACD (${macdTimeframe}) ${macdConditionText[macdCondition]}.`];
    parts.push(warnings.length
      ? ` Early warning at ${warnings.join(" and ")} of ATR.`
      : " No early warning.");
    if (rsiEnabled) parts.push(` RSI context: period ${rsiSettings.period || "–"}, ${rsiSettings.oversold || "–"} oversold / ${rsiSettings.overbought || "–"} overbought.`);
    if (trendEnabled) parts.push(` Trend context: ${trendPeriod || "–"} SMA.`);
    return parts.join("");
  })();
  return (
    <main className="shell min-h-screen w-full px-4 sm:px-6 lg:px-10 2xl:px-14">
      <header className="topbar">
        <a className="brand" href="#top"><span>TCAs -Trade Chart Alerts</span></a>
        <button
          type="button"
          className={`theme-switch ${theme === "dark" ? "is-dark" : ""}`}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
        >
          <span className="theme-switch-symbol" aria-hidden="true">{theme === "dark" ? "☾" : "☀"}</span>
          <span className="theme-switch-thumb" aria-hidden="true" />
        </button>
        <a className="api-link" href={`${API}/health/`} target="_blank" rel="noreferrer">API status ↗</a>
      </header>
      <section className="hero" id="top">
        <div><h2>Stay ahead of <em>the next move.</em></h2><p className="eyebrow">MARKET MONITOR . PERSISTENT ALERTS</p></div>
        <div className="hero-status" aria-label="Alert engine status">
          <div className="status-chip engine-chip"><span className="live-dot" /><span>ENGINE</span></div>
          <div className="status-chip alerts-chip"><span className="status-icon" aria-hidden="true"> ⚠️ </span>{activeCount.toString().padStart(2, "0")}<span>ACTIVE ALERTS</span></div>
          <div className="status-chip triggers-chip"><span className="status-icon" aria-hidden="true">⚡</span>{events.length.toString().padStart(2, "0")}<span>TRIGGERS</span></div>
        </div>
              </section>

      <MarketWorkspace symbol={marketSymbol} exchange={exchange} onExchangeChange={(value) => void selectExchange(value)} theme={theme} onSymbolChange={setMarketSymbol} onPriceSelect={setTargetPrice} alerts={alerts} onCreateLineAlert={createLineAlert} onUpdateLineAlert={updateLineAlert} onDeleteLineAlert={deleteLineAlert} />

      {error && <div className="notice" role="alert"><b>Connection or validation issue</b><span>{error}</span><button onClick={() => void refresh()}>Retry</button></div>}

      <div className="content-grid dashboard-grid">
        <section className="panel create-panel">
          <div className="panel-head"><div><p className="eyebrow">CONFIGURE</p><h2>Create an alert</h2></div><span className="step">01 / 02</span></div>
          <div className="kind-switch"><button className={kind === "price" ? "selected" : ""} onClick={() => setKind("price")}>Price level</button><button className={kind === "macd" ? "selected" : ""} onClick={() => setKind("macd")}>MACD cross</button></div>
          <form onSubmit={createAlert} className="alert-form">
            <label>Market symbol<input name="symbol" placeholder="BTCUSDT" required maxLength={24} autoComplete="off" value={marketSymbol} onChange={(event) => setMarketSymbol(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} /></label>
            {kind === "price" ? <label>Target price<input name="price" type="number" step="any" min="0" placeholder="68000.00" required value={targetPrice} onChange={(event) => setTargetPrice(event.target.value)} /></label> : null}
            {kind === "price" && <label>Condition<select name="condition">{["cross_up", "cross_down", "cross", "above", "below"].map((condition) => <option key={condition} value={condition}>{conditions[condition]}</option>)}</select></label>}
            {kind === "macd" && (
              <div className="macd-config">
                <div className="config-row">
                  <label>Timeframe<select name="timeframe" value={macdTimeframe} onChange={(event) => setMacdTimeframe(event.target.value as (typeof timeframes)[number])}>{timeframes.map((tf) => <option key={tf} value={tf}>{tf}</option>)}</select></label>
                  <label>Condition<select name="condition" value={macdCondition} onChange={(event) => setMacdCondition(event.target.value as MacdCondition)}>{macdConditions.map((condition) => <option key={condition} value={condition}>{conditions[condition]}</option>)}</select></label>
                </div>

                <fieldset className="config-block">
                  <legend>Early warning</legend>
                  <p className="config-hint">Also notify while the MACD line is still approaching the signal line, before the cross happens. Distance is measured as a percentage of the 14-period ATR.</p>
                  <div className="checkbox-group">
                    <label className="checkbox-label"><input type="checkbox" name="macd_threshold_5" checked={macdThreshold5} onChange={(event) => setMacdThreshold5(event.target.checked)} /> 5% of ATR away</label>
                    <label className="checkbox-label"><input type="checkbox" name="macd_threshold_10" checked={macdThreshold10} onChange={(event) => setMacdThreshold10(event.target.checked)} /> 10% of ATR away</label>
                  </div>
                  <p className="config-note">Both can be enabled — you get one notice per threshold crossed.</p>
                </fieldset>

                <fieldset className="config-block">
                  <legend>RSI context <span className="legend-note">optional</span></legend>
                  <label className="checkbox-label"><input type="checkbox" name="rsi_enabled" checked={rsiEnabled} onChange={(event) => setRsiEnabled(event.target.checked)} /> Attach an RSI reading to every MACD notification</label>
                  {rsiEnabled && <div className="config-row">
                    <label>Period<input name="rsi_period" type="number" min="2" max="100" value={rsiSettings.period} onChange={(event) => setRsiSettings({ ...rsiSettings, period: event.target.value })} /></label>
                    <label>Oversold<input name="rsi_oversold" type="number" min="0" max="100" value={rsiSettings.oversold} onChange={(event) => setRsiSettings({ ...rsiSettings, oversold: event.target.value })} /></label>
                    <label>Overbought<input name="rsi_overbought" type="number" min="0" max="100" value={rsiSettings.overbought} onChange={(event) => setRsiSettings({ ...rsiSettings, overbought: event.target.value })} /></label>
                  </div>}
                  {fieldErrors.rsi_period && <p className="field-error">{fieldErrors.rsi_period}</p>}
                  {fieldErrors.rsi_oversold && <p className="field-error">{fieldErrors.rsi_oversold}</p>}
                  {fieldErrors.rsi_overbought && <p className="field-error">{fieldErrors.rsi_overbought}</p>}
                  <p className="config-note">Context only — labels momentum as bullish / bearish / balanced and never blocks the cross.</p>
                </fieldset>

                <fieldset className="config-block">
                  <legend>Trend context <span className="legend-note">optional</span></legend>
                  <label className="checkbox-label"><input type="checkbox" name="trend_enabled" checked={trendEnabled} onChange={(event) => setTrendEnabled(event.target.checked)} /> Attach a trend reading to every MACD notification</label>
                  {trendEnabled && <div className="config-row">
                    <label>SMA period<input name="trend_period" type="number" min="2" max="500" value={trendPeriod} onChange={(event) => setTrendPeriod(event.target.value)} /></label>
                  </div>}
                  {fieldErrors.trend_period && <p className="field-error">{fieldErrors.trend_period}</p>}
                  <p className="config-note">Context only — compares the close against the SMA and never blocks the cross.</p>
                </fieldset>

                <div className="macd-summary" aria-live="polite">
                  <b>This alert will</b>
                  <p>{macdSummary}</p>
                </div>
              </div>
            )}
            <label>Trigger frequency<select name="frequency"><option value="once">Once — disable after trigger</option><option value="every">Repeat — 60 second cooldown</option></select></label>
            <label className="wide">Note <span className="optional">OPTIONAL</span><input name="note" maxLength={240} placeholder="Add a reminder for this alert" /></label>
            <button className="submit wide" disabled={busy}>{busy ? "Saving…" : "Save alert"}<span>↗</span></button>
          </form>
        </section>

          <section className="panel list-panel">
            <div className="panel-head"><div><p className="eyebrow">MONITOR</p><h2>Your alerts</h2></div><div className="panel-actions">{notificationAvailable && Notification.permission !== "granted" && alerts.length > 0 && <button className="refresh" onClick={requestNotifications}>Enable notifications</button>}<button className="refresh" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? "Syncing…" : "↻ Refresh"}</button></div></div>
            {alerts.length ? <div className="alert-list">{alerts.map((item) => <article className={`alert-row ${item.active ? "" : "muted"}`} key={item.id}>
              <button aria-label={item.active ? "Pause alert" : "Enable alert"} className={`status-toggle ${item.active ? "enabled" : ""}`} onClick={() => void toggleAlert(item)}><span /></button>
              <div className="alert-details"><div className="alert-title"><b>{item.symbol}</b><span className="tag">{item.kind === "macd" ? `MACD · ${item.timeframe}${item.rsi_enabled ? " + RSI" : ""}${item.trend_enabled ? " + Trend" : ""}` : item.line_type ? "DRAWING" : "PRICE"}</span></div><p>{item.kind === "macd" ? `MACD ${conditions[item.condition]} signal${item.macd_threshold_5 || item.macd_threshold_10 ? ` (thresholds: ${[item.macd_threshold_5 && "5%", item.macd_threshold_10 && "10%"].filter(Boolean).join(", ")})` : ""}${item.rsi_enabled ? " with RSI info" : ""}${item.trend_enabled ? ` with trend info (${item.trend_period || 200} SMA)` : ""}` : item.line_type ? `${conditions[item.condition]} drawing level` : `${conditions[item.condition]} ${Number(item.price).toLocaleString()}`}{item.note ? <span className="note"> · {item.note}</span> : null}</p><small>{item.frequency === "once" ? "ONE SHOT" : "REPEATING"} · CREATED {new Date(item.created_at).toLocaleString()}</small></div>
              <button className="delete" aria-label={`Delete ${item.symbol} alert`} onClick={() => void deleteAlert(item.id)}>×</button>
            </article>)}</div> : <div className="empty"><span>◷</span><b>No alerts yet</b><p>Your active conditions will appear here.</p></div>}
          </section>

          <section className="panel activity-panel">
            <div className="panel-head"><div><p className="eyebrow">ACTIVITY</p><h2>Triggered</h2></div><div className="panel-actions"><span className="count">{events.length} EVENTS</span><button className="refresh" onClick={clearLog}>Clear log</button></div></div>
            {events.filter((event) => !clearedThrough || event.triggered_at > clearedThrough).length ? <div className="event-list">{events.filter((event) => !clearedThrough || event.triggered_at > clearedThrough).slice(0, 20).map((event) => <article className="event-row" key={event.id}><span className="event-spark">✳</span><div><b>{event.title}</b><p>{event.message}</p></div><time>{new Date(event.triggered_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></article>)}</div> : <p className="no-events">Alerts that trigger will appear here.</p>}
          </section>

      </div>
      <footer><span>TCAs @ 2026</span><span>Prices via {exchange === "binance" ? "Binance" : "Bybit"} public market data · UTC timestamps</span></footer>
      <div className="toast-stack" aria-live="polite">{toasts.map((item) => <div className="alert-toast" key={item.id}><button aria-label="Dismiss notification" onClick={() => setToasts((current) => current.filter((entry) => entry.id !== item.id))}>×</button><b>{item.title}</b><span>{item.message}</span></div>)}</div>
    </main>
  );
}
