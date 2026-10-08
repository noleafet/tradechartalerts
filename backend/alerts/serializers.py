from rest_framework import serializers

from .models import Alert, TriggerEvent, WatchlistSymbol

TIMEFRAMES = {"1m", "5m", "15m", "1h", "4h", "1d", "1w"}
PRICE_CONDITIONS = {"cross_up", "cross_down", "cross", "above", "below"}
MACD_CONDITIONS = {"cross_up", "cross_down", "cross"}


class AlertSerializer(serializers.ModelSerializer):
    class Meta:
        model = Alert
        fields = [
            "id", "symbol", "kind", "condition", "price", "timeframe", "note",
            "frequency", "active", "cooldown_seconds", "line_type", "line_t1",
            "line_price1", "line_t2", "line_price2", "line_extend", "created_at",
            "updated_at", "last_triggered_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at", "last_triggered_at"]

    def validate_symbol(self, value):
        value = value.strip().upper()
        if not value.isalnum() or len(value) > 24:
            raise serializers.ValidationError("Use a valid alphanumeric market symbol, e.g. BTCUSDT.")
        return value

    def validate_price(self, value):
        if value is not None and value <= 0:
            raise serializers.ValidationError("Price must be greater than zero.")
        return value

    def validate(self, attrs):
        kind = attrs.get("kind", getattr(self.instance, "kind", Alert.Kind.PRICE))
        condition = attrs.get("condition", getattr(self.instance, "condition", ""))
        if kind == Alert.Kind.PRICE:
            if condition not in PRICE_CONDITIONS:
                raise serializers.ValidationError({"condition": "Unsupported price condition."})
            if attrs.get("price", getattr(self.instance, "price", None)) is None and not attrs.get("line_type", getattr(self.instance, "line_type", "")):
                raise serializers.ValidationError({"price": "A price or line geometry is required."})
            line_type = attrs.get("line_type", getattr(self.instance, "line_type", ""))
            if line_type:
                if condition not in MACD_CONDITIONS:
                    raise serializers.ValidationError({"condition": "Line alerts support cross_up, cross_down, or cross."})
                t1 = attrs.get("line_t1", getattr(self.instance, "line_t1", None))
                p1 = attrs.get("line_price1", getattr(self.instance, "line_price1", None))
                if t1 is None or p1 is None:
                    raise serializers.ValidationError({"line_t1": "Line alerts require the first time and price point."})
                if line_type in {Alert.LineType.TREND, Alert.LineType.RAY}:
                    t2 = attrs.get("line_t2", getattr(self.instance, "line_t2", None))
                    p2 = attrs.get("line_price2", getattr(self.instance, "line_price2", None))
                    if t2 is None or p2 is None or t1 == t2:
                        raise serializers.ValidationError({"line_t2": "Trendlines and rays require two distinct time/price points."})
        elif kind == Alert.Kind.MACD:
            if condition not in MACD_CONDITIONS:
                raise serializers.ValidationError({"condition": "MACD supports cross_up, cross_down, or cross."})
            timeframe = attrs.get("timeframe", getattr(self.instance, "timeframe", ""))
            if timeframe not in TIMEFRAMES:
                raise serializers.ValidationError({"timeframe": f"Choose one of {', '.join(sorted(TIMEFRAMES))}."})
            if attrs.get("line_type", ""):
                raise serializers.ValidationError({"line_type": "Line alerts are only available for price alerts."})
        return attrs


class TriggerEventSerializer(serializers.ModelSerializer):
    alert_id = serializers.IntegerField(read_only=True)

    class Meta:
        model = TriggerEvent
        fields = ["id", "alert_id", "symbol", "title", "message", "observed_value", "triggered_at"]


class TelegramFindChatSerializer(serializers.Serializer):
    bot_token = serializers.CharField(max_length=255, trim_whitespace=True)


class TelegramTestSerializer(serializers.Serializer):
    bot_token = serializers.CharField(max_length=255, trim_whitespace=True)
    chat_id = serializers.CharField(max_length=128, trim_whitespace=True)


class ExchangeSelectionSerializer(serializers.Serializer):
    exchange = serializers.ChoiceField(choices=[("binance", "Binance"), ("bybit", "Bybit")])


class WatchlistSymbolSerializer(serializers.ModelSerializer):
    class Meta:
        model = WatchlistSymbol
        fields = ["symbol", "position"]
        read_only_fields = ["position"]

    def validate_symbol(self, value):
        value = value.strip().upper()
        if not value.isalnum() or len(value) > 24:
            raise serializers.ValidationError("Use a valid alphanumeric market symbol, e.g. BTCUSDT.")
        return value
