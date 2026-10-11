from django.db import models
from django.core.validators import MinValueValidator


class AppConfiguration(models.Model):
    """Singleton site configuration editable by trusted Django staff users."""

    alert_poll_seconds = models.PositiveIntegerField(
        default=5,
        validators=[MinValueValidator(1)],
        help_text="Seconds between alert evaluation cycles.",
    )
    notification_enabled = models.BooleanField(default=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Alert configuration"
        verbose_name_plural = "Alert configuration"

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    def __str__(self):
        return "Alert configuration"

    @classmethod
    def load(cls):
        configuration, _created = cls.objects.get_or_create(pk=1)
        return configuration


class Notification(models.Model):
    telegram_bot_token = models.CharField(max_length=255, blank=True, default="")
    telegram_chat_id = models.CharField(max_length=128, blank=True, default="")

    def __str__(self):
        return self.telegram_chat_id or "Telegram notification"


class Exchange(models.Model):
    class Name(models.TextChoices):
        BINANCE = "binance", "Binance"
        BYBIT = "bybit", "Bybit"

    exchange = models.CharField(max_length=12, choices=Name.choices, default=Name.BINANCE)
    exchange_url = models.URLField(
        default="https://data-api.binance.vision/api/v3",
        help_text="Base REST API URL for market data (without a trailing slash).",
    )
    exchange_timeout = models.PositiveIntegerField(
        default=10,
        validators=[MinValueValidator(1)],
        help_text="Timeout in seconds for exchange and Telegram HTTP requests.",
    )

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    def __str__(self):
        return self.get_exchange_display()

    @classmethod
    def load(cls):
        exchange, _created = cls.objects.get_or_create(pk=1)
        return exchange


class WatchlistSymbol(models.Model):
    symbol = models.CharField(max_length=24, unique=True)
    position = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["position", "id"]

    def __str__(self):
        return self.symbol


class Alert(models.Model):
    class Kind(models.TextChoices):
        PRICE = "price", "Price"
        MACD = "macd", "MACD cross"
        RSI = "rsi", "RSI level"

    class Condition(models.TextChoices):
        CROSS_UP = "cross_up", "Crosses above"
        CROSS_DOWN = "cross_down", "Crosses below"
        CROSS = "cross", "Crosses either way"
        ABOVE = "above", "Is above"
        BELOW = "below", "Is below"

    class Frequency(models.TextChoices):
        ONCE = "once", "Once"
        EVERY = "every", "Every time"

    class LineType(models.TextChoices):
        TREND = "trend", "Trendline"
        RAY = "ray", "Ray"
        HLINE = "hline", "Horizontal line"
        HRAY = "hray", "Horizontal ray"

    symbol = models.CharField(max_length=24, db_index=True)
    kind = models.CharField(max_length=8, choices=Kind.choices, default=Kind.PRICE)
    condition = models.CharField(max_length=12, choices=Condition.choices)
    price = models.DecimalField(max_digits=30, decimal_places=12, null=True, blank=True)
    timeframe = models.CharField(max_length=3, blank=True, default="")
    note = models.CharField(max_length=240, blank=True, default="")
    frequency = models.CharField(max_length=8, choices=Frequency.choices, default=Frequency.ONCE)
    active = models.BooleanField(default=True, db_index=True)
    last_triggered_at = models.DateTimeField(null=True, blank=True)
    last_observed_value = models.FloatField(null=True, blank=True)
    last_bar_open_time = models.DateTimeField(null=True, blank=True)
    last_macd_diff = models.FloatField(null=True, blank=True)
    last_macd_gap_percent = models.FloatField(null=True, blank=True)
    last_macd_warning_threshold = models.PositiveSmallIntegerField(null=True, blank=True)
    cooldown_seconds = models.PositiveIntegerField(default=60)

    # RSI alerts: 14-period Wilder RSI evaluated on closed candles of `timeframe`.
    rsi_level = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    last_rsi = models.FloatField(null=True, blank=True)

    # Optional line-based price alert, preserving the drawing alert semantics of TradeChartAlert.
    line_type = models.CharField(max_length=8, choices=LineType.choices, blank=True, default="")
    line_t1 = models.DateTimeField(null=True, blank=True)
    line_price1 = models.DecimalField(max_digits=30, decimal_places=12, null=True, blank=True)
    line_t2 = models.DateTimeField(null=True, blank=True)
    line_price2 = models.DecimalField(max_digits=30, decimal_places=12, null=True, blank=True)
    line_extend = models.BooleanField(default=False)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        if self.kind == self.Kind.MACD:
            target = f"MACD {self.timeframe}"
        elif self.kind == self.Kind.RSI:
            target = f"RSI {self.timeframe} {self.rsi_level}"
        else:
            target = str(self.price or "line")
        return f"{self.symbol} {self.condition} {target}"


class TriggerEvent(models.Model):
    alert = models.ForeignKey(Alert, related_name="events", on_delete=models.SET_NULL, null=True, blank=True)
    symbol = models.CharField(max_length=24, db_index=True)
    title = models.CharField(max_length=180)
    message = models.TextField()
    observed_value = models.FloatField(null=True, blank=True)
    triggered_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-triggered_at"]

    def __str__(self):
        return f"{self.symbol}: {self.title}"
