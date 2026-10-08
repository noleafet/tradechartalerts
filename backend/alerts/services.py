from datetime import datetime, timezone as dt_timezone
from decimal import Decimal
import logging
import math
import time

import requests
from django.db import transaction
from django.utils import timezone

from .models import Alert, AppConfiguration, Exchange, Notification, TriggerEvent

logger = logging.getLogger(__name__)
TIMEFRAME_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800}
BYBIT_INTERVALS = {"1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D", "1w": "W"}


def _market_request(path, params, exchange):
    if exchange.exchange == Exchange.Name.BYBIT:
        url = f"https://api.bybit.com/v5/market/{path}"
    else:
        url = f"{exchange.exchange_url.rstrip('/')}/{path}"
    response = requests.get(
        url,
        params=params,
        timeout=exchange.exchange_timeout,
    )
    response.raise_for_status()
    payload = response.json()
    if exchange.exchange == Exchange.Name.BYBIT:
        if payload.get("retCode") != 0:
            raise ValueError(payload.get("retMsg") or "Bybit market data request failed.")
        return payload.get("result", {})
    if isinstance(payload, dict) and "code" in payload and "msg" in payload:
        raise ValueError(payload["msg"])
    return payload


def get_market_quote(symbol, exchange):
    if exchange.exchange == Exchange.Name.BYBIT:
        result = _market_request("tickers", {"category": "spot", "symbol": symbol}, exchange)
        item = next(iter(result.get("list", [])), None)
        if item is None:
            raise ValueError(f"{symbol} is not a supported Bybit spot pair.")
        return {"price": float(item["lastPrice"]), "change": float(item["price24hPcnt"]) * 100}
    item = _market_request("ticker/24hr", {"type": "MINI", "symbol": symbol}, exchange)
    price, opening = float(item["lastPrice"]), float(item["openPrice"])
    return {"price": price, "change": (price - opening) / opening * 100 if opening else 0.0}


def _price_for(symbol, exchange):
    return get_market_quote(symbol, exchange)["price"]


def _candles_for(symbol, timeframe, exchange, limit):
    if timeframe not in TIMEFRAME_SECONDS:
        raise ValueError("Unsupported market timeframe.")
    if exchange.exchange == Exchange.Name.BYBIT:
        result = _market_request("kline", {
            "category": "spot", "symbol": symbol,
            "interval": BYBIT_INTERVALS[timeframe], "limit": str(limit),
        }, exchange)
        duration_ms = TIMEFRAME_SECONDS[timeframe] * 1000
        return [
            [int(candle[0]), candle[1], candle[2], candle[3], candle[4], candle[5], int(candle[0]) + duration_ms - 1]
            for candle in reversed(result.get("list", []))
        ]
    return _market_request("klines", {
        "symbol": symbol, "interval": timeframe, "limit": limit,
    }, exchange)


def get_market_candles(symbol, timeframe, exchange, limit=500):
    candles = _candles_for(symbol, timeframe, exchange, limit)
    return [{
        "time": int(candle[0]) // 1000,
        "open": float(candle[1]),
        "high": float(candle[2]),
        "low": float(candle[3]),
        "close": float(candle[4]),
        "volume": float(candle[5]),
    } for candle in candles]


def _ema(values, length):
    result = [None] * len(values)
    seed = []
    start = None
    alpha = 2 / (length + 1)
    for index, value in enumerate(values):
        if value is None:
            continue
        if start is None:
            start = index
        offset = index - start
        if offset < length:
            seed.append(value)
            if offset == length - 1:
                result[index] = sum(seed) / length
        else:
            result[index] = value * alpha + result[index - 1] * (1 - alpha)
    return result


def _macd_signal(symbol, timeframe, exchange):
    candles = _candles_for(symbol, timeframe, exchange, 300)
    now_ms = int(time.time() * 1000)
    closed = [candle for candle in candles if int(candle[6]) < now_ms]
    if len(closed) < 37:
        return None
    closes = [float(candle[4]) for candle in closed]
    fast, slow = _ema(closes, 12), _ema(closes, 26)
    macd_line = [f - s if f is not None and s is not None else None for f, s in zip(fast, slow)]
    signal = _ema(macd_line, 9)
    index = len(closed) - 1
    if any(value is None for value in (macd_line[index - 1], signal[index - 1], macd_line[index], signal[index])):
        return None
    return {
        "bar_time": datetime.fromtimestamp(int(closed[index][0]) / 1000, tz=dt_timezone.utc),
        "previous_diff": macd_line[index - 1] - signal[index - 1],
        "current_diff": macd_line[index] - signal[index],
        "close": closes[index],
        "macd": macd_line[index],
        "signal": signal[index],
    }


def _line_level(alert, at):
    if not alert.line_type or alert.line_price1 is None:
        return float(alert.price) if alert.price is not None else None
    t1 = alert.line_t1.timestamp() if alert.line_t1 else at
    p1 = float(alert.line_price1)
    if alert.line_type in {Alert.LineType.HLINE, Alert.LineType.HRAY}:
        if alert.line_type == Alert.LineType.HRAY and at < t1:
            return None
        return p1
    if not alert.line_t2 or alert.line_price2 is None or at < t1:
        return None
    t2, p2 = alert.line_t2.timestamp(), float(alert.line_price2)
    if t2 == t1:
        return None
    if alert.line_type == Alert.LineType.TREND and not alert.line_extend and at > t2:
        return None
    return p1 + (p2 - p1) * (at - t1) / (t2 - t1)


def _crossed(condition, previous, current):
    if previous is None:
        return False
    up = previous < 0 <= current
    down = previous > 0 >= current
    if condition == Alert.Condition.CROSS_UP:
        return up
    if condition == Alert.Condition.CROSS_DOWN:
        return down
    return up or down


def _may_fire(alert, now):
    if alert.frequency == Alert.Frequency.ONCE:
        return True
    if alert.last_triggered_at is None:
        return True
    return (now - alert.last_triggered_at).total_seconds() >= alert.cooldown_seconds


def telegram_request(notification, method, data=None, *, token=None):
    token = token or notification.telegram_bot_token
    if not token:
        raise ValueError("Configure the Telegram bot token in Django admin first.")
    response = requests.post(
        f"https://api.telegram.org/bot{token}/{method}",
        data=data or {},
        timeout=Exchange.load().exchange_timeout,
    )
    try:
        payload = response.json()
    except ValueError:
        response.raise_for_status()
        raise ValueError("Telegram returned an invalid response.")
    if not payload.get("ok"):
        raise ValueError(payload.get("description") or "Telegram request failed.")
    response.raise_for_status()
    return payload.get("result")


def find_telegram_chat(notification, *, token=None):
    updates = telegram_request(notification, "getUpdates", {"limit": "100"}, token=token)
    for update in reversed(updates or []):
        message = (
            update.get("message") or update.get("edited_message")
            or update.get("channel_post") or update.get("my_chat_member")
        )
        if message and message.get("chat"):
            return message["chat"]
    raise ValueError("No Telegram messages found. Open your bot and press Start, then try again.")


def send_telegram_test(notification, *, token=None, chat_id=None):
    token = token or notification.telegram_bot_token
    chat_id = chat_id or notification.telegram_chat_id
    if not token:
        raise ValueError("Enter a Telegram bot token.")
    if not chat_id:
        raise ValueError("Enter a Telegram chat ID.")
    return telegram_request(notification, "sendMessage", {
        "chat_id": chat_id,
        "text": "TradeChartAlert is connected. Your alerts will arrive here.",
    }, token=token)


def _notify(event, configuration):
    logger.info("ALERT %s | %s", event.title, event.message)
    notification = Notification.load()
    token = notification.telegram_bot_token
    chat_id = notification.telegram_chat_id
    if not configuration.notification_enabled or not token or not chat_id:
        return
    try:
        telegram_request(notification, "sendMessage", {
            "chat_id": chat_id,
            "text": f"🔔 {event.title}\n{event.message}",
        })
    except (requests.RequestException, ValueError):
        logger.exception("Telegram alert delivery failed")


def check_alerts(*, stdout=None):
    """Fetch current market values, persist alert state/events, and notify on hits."""
    configuration = AppConfiguration.load()
    exchange = Exchange.load()
    alerts = list(Alert.objects.filter(active=True).order_by("id"))
    price_symbols = {a.symbol for a in alerts if a.kind == Alert.Kind.PRICE}
    macd_keys = {(a.symbol, a.timeframe) for a in alerts if a.kind == Alert.Kind.MACD}
    prices, macd_values = {}, {}
    for symbol in sorted(price_symbols):
        try:
            prices[symbol] = _price_for(symbol, exchange)
        except (requests.RequestException, KeyError, ValueError) as exc:
            logger.warning("Could not fetch %s price: %s", symbol, exc)
    for symbol, timeframe in sorted(macd_keys):
        try:
            macd_values[(symbol, timeframe)] = _macd_signal(symbol, timeframe, exchange)
        except (requests.RequestException, KeyError, ValueError) as exc:
            logger.warning("Could not fetch %s %s MACD: %s", symbol, timeframe, exc)

    fired = []
    now = timezone.now()
    for snapshot in alerts:
        value = prices.get(snapshot.symbol) if snapshot.kind == Alert.Kind.PRICE else None
        macd = macd_values.get((snapshot.symbol, snapshot.timeframe)) if snapshot.kind == Alert.Kind.MACD else None
        if snapshot.kind == Alert.Kind.PRICE and value is None:
            continue
        if snapshot.kind == Alert.Kind.MACD and macd is None:
            continue
        with transaction.atomic():
            alert = Alert.objects.select_for_update().filter(pk=snapshot.pk, active=True).first()
            if alert is None:
                continue
            event = None
            if alert.kind == Alert.Kind.PRICE:
                level = _line_level(alert, now.timestamp())
                if level is None:
                    continue
                previous_diff = None if alert.last_observed_value is None else alert.last_observed_value - level
                current_diff = value - level
                hit = (
                    value >= level if alert.condition == Alert.Condition.ABOVE else
                    value <= level if alert.condition == Alert.Condition.BELOW else
                    _crossed(alert.condition, previous_diff, current_diff)
                )
                alert.last_observed_value = value
                if hit and _may_fire(alert, now):
                    direction = alert.get_condition_display().lower()
                    event = TriggerEvent.objects.create(
                        alert=alert,
                        symbol=alert.symbol,
                        title=f"{alert.symbol} {direction} {level:g}",
                        message=f"Last price {value:g}; target {level:g}" + (f" — {alert.note}" if alert.note else ""),
                        observed_value=value,
                    )
            else:
                bar_time = macd["bar_time"]
                if alert.last_bar_open_time is None:
                    # Arm at the latest closed candle; never report an old cross on first startup.
                    alert.last_bar_open_time = bar_time
                elif bar_time > alert.last_bar_open_time:
                    hit = _crossed(alert.condition, macd["previous_diff"], macd["current_diff"])
                    alert.last_bar_open_time = bar_time
                    alert.last_observed_value = macd["close"]
                    if hit and _may_fire(alert, now):
                        side = "bullish" if macd["current_diff"] > 0 else "bearish"
                        event = TriggerEvent.objects.create(
                            alert=alert,
                            symbol=alert.symbol,
                            title=f"{alert.symbol} MACD {alert.timeframe} {side} cross",
                            message=f"MACD {macd['macd']:.8g}, signal {macd['signal']:.8g}, close {macd['close']:g}" + (f" — {alert.note}" if alert.note else ""),
                            observed_value=macd["close"],
                        )
            if event is not None:
                alert.last_triggered_at = now
                if alert.frequency == Alert.Frequency.ONCE:
                    alert.active = False
                fired.append(event)
            alert.save(update_fields=[
                "active", "last_triggered_at", "last_observed_value", "last_bar_open_time", "updated_at"
            ])

    for event in fired:
        _notify(event, configuration)
        if stdout is not None:
            stdout.write(f"Triggered: {event.title} — {event.message}")
    return fired
