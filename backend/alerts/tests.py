from datetime import timedelta
from unittest.mock import ANY, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from .models import Alert, AppConfiguration, Exchange, Notification, TriggerEvent, WatchlistSymbol
from .services import _macd_approach_thresholds, _notify, check_alerts, get_market_candles, get_market_quote


class AlertApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_create_price_alert_normalizes_symbol(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "btcusdt", "kind": "price", "condition": "cross_up",
            "price": "65000", "frequency": "once",
        }, format="json")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["symbol"], "BTCUSDT")
        self.assertEqual(Alert.objects.count(), 1)


    def test_macd_requires_supported_timeframe_and_cross_condition(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "ETHUSDT", "kind": "macd", "condition": "above", "timeframe": "2h",
        }, format="json")
        self.assertEqual(response.status_code, 400)

    def test_alert_can_be_paused_and_deleted(self):
        alert = Alert.objects.create(symbol="BTCUSDT", kind="price", condition="above", price="1")
        response = self.client.patch(f"/api/alerts/{alert.id}/", {"active": False}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data["active"])
        response = self.client.delete(f"/api/alerts/{alert.id}/")
        self.assertEqual(response.status_code, 204)

    def test_telegram_status_never_returns_credentials(self):
        configuration = AppConfiguration.load()
        notification = Notification.objects.create()
        notification.telegram_bot_token = "secret-token"
        notification.telegram_chat_id = "123456789"
        configuration.notification_enabled = True
        configuration.save()
        notification.save()

        response = self.client.get("/api/telegram/status/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"configured": True, "enabled": True, "chat_hint": "...6789"})
        self.assertNotIn("secret-token", str(response.data))

    @patch("alerts.services.telegram_request")
    def test_alert_delivery_requires_backend_telegram_enablement(self, send_message):
        configuration = AppConfiguration.load()
        notification = Notification.objects.create()
        notification.telegram_bot_token = "secret-token"
        notification.telegram_chat_id = "123456789"
        event = TriggerEvent(symbol="BTCUSDT", title="BTC alert", message="Target crossed")

        notification.save()
        _notify(event, configuration)
        send_message.assert_not_called()

        configuration.notification_enabled = True
        _notify(event, configuration)
        send_message.assert_called_once()

    @patch("alerts.services.telegram_request")
    def test_alert_delivery_sends_to_every_configured_destination(self, send_message):
        configuration = AppConfiguration.load()
        configuration.notification_enabled = True
        configuration.save()
        Notification.objects.create(telegram_bot_token="token-one", telegram_chat_id="111")
        Notification.objects.create(telegram_bot_token="token-two", telegram_chat_id="222")
        event = TriggerEvent(symbol="BTCUSDT", title="BTC alert", message="Target crossed")

        _notify(event, configuration)

        self.assertEqual(send_message.call_count, 2)
        self.assertEqual(
            {call.args[2]["chat_id"] for call in send_message.call_args_list},
            {"111", "222"},
        )

    def test_telegram_status_reports_multiple_configured_destinations(self):
        configuration = AppConfiguration.load()
        configuration.notification_enabled = True
        configuration.save()
        Notification.objects.create(telegram_bot_token="token-one", telegram_chat_id="1111")
        Notification.objects.create(telegram_bot_token="token-two", telegram_chat_id="2222")

        response = self.client.get("/api/telegram/status/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {
            "configured": True,
            "enabled": True,
            "chat_hint": "...1111, ...2222",
        })


class MacdApproachTests(TestCase):
    def test_thresholds_are_reported_separately_and_only_once_per_approach(self):
        self.assertEqual(
            _macd_approach_thresholds(-0.2, -0.09, 20, 9, Alert.Condition.CROSS_UP, None),
            ([10], 10),
        )
        self.assertEqual(
            _macd_approach_thresholds(-0.09, -0.04, 9, 4, Alert.Condition.CROSS_UP, 10),
            ([5], 5),
        )
        self.assertEqual(
            _macd_approach_thresholds(-0.04, -0.06, 4, 6, Alert.Condition.CROSS_UP, 5),
            ([], None),
        )

    def test_approach_thresholds_follow_cross_direction(self):
        self.assertEqual(
            _macd_approach_thresholds(-0.2, -0.05, 20, 5, Alert.Condition.CROSS_DOWN, None),
            ([], None),
        )
        self.assertEqual(
            _macd_approach_thresholds(0.2, 0.05, 20, 5, Alert.Condition.CROSS_DOWN, None),
            ([10, 5], 5),
        )

    @patch("alerts.services._macd_signal")
    def test_checker_creates_distinct_events_for_10_and_5_percent(self, macd_signal):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.MACD, condition=Alert.Condition.CROSS_UP,
            timeframe="1m", frequency=Alert.Frequency.EVERY,
            last_bar_open_time=timezone.now() - timedelta(minutes=2),
            last_macd_diff=-0.2,
            last_macd_gap_percent=20,
        )
        bar_time = timezone.now() - timedelta(minutes=1)
        macd_signal.return_value = {
            "bar_time": bar_time, "previous_diff": -0.2, "current_diff": -0.09,
            "close": 100, "macd": 1, "signal": 1.09, "atr": 1,
        }

        check_alerts()

        warning = TriggerEvent.objects.get(alert=alert)
        self.assertIn("10%", warning.title)
        alert.refresh_from_db()
        self.assertEqual(alert.last_macd_warning_threshold, 10)
        self.assertTrue(alert.active)

        macd_signal.return_value = {
            "bar_time": bar_time + timedelta(minutes=1), "previous_diff": -0.09,
            "current_diff": -0.04, "close": 100, "macd": 1, "signal": 1.04, "atr": 1,
        }
        check_alerts()

        warnings = list(TriggerEvent.objects.filter(alert=alert).order_by("id"))
        self.assertEqual(len(warnings), 2)
        self.assertIn("5%", warnings[1].title)
        alert.refresh_from_db()
        self.assertEqual(alert.last_macd_warning_threshold, 5)
        self.assertTrue(alert.active)


class TrendFilterTests(TestCase):
    def test_macd_alert_defaults_trend_period_to_200_sma(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "BTCUSDT", "kind": "macd", "condition": "cross_up", "timeframe": "1h",
            "trend_enabled": True,
        }, format="json")

        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.data["trend_enabled"])
        self.assertEqual(response.data["trend_period"], 200)

    def test_macd_alert_rejects_out_of_range_trend_period(self):
        response = self.client.post("/api/alerts/", {
            "symbol": "BTCUSDT", "kind": "macd", "condition": "cross_up", "timeframe": "1h",
            "trend_enabled": True, "trend_period": 1000,
        }, format="json")

        self.assertEqual(response.status_code, 400)
        self.assertIn("trend_period", response.data)

    @patch("alerts.services._trend_signal")
    @patch("alerts.services._macd_signal")
    def test_trend_confirmation_fires_after_macd_cross(self, macd_signal, trend_signal):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.MACD, condition=Alert.Condition.CROSS_UP,
            timeframe="1m", frequency=Alert.Frequency.EVERY, trend_enabled=True,
            last_bar_open_time=timezone.now() - timedelta(minutes=2),
            last_macd_diff=-0.2,
        )
        self.assertEqual(alert.trend_period, 200)
        bar_time = timezone.now() - timedelta(minutes=1)
        macd_signal.return_value = {
            "bar_time": bar_time, "previous_diff": -0.2, "current_diff": 0.1,
            "close": 100, "macd": 1, "signal": 0.9, "atr": 1,
        }
        trend_signal.return_value = {
            "bar_time": bar_time, "sma": 95, "close": 100, "trend": "uptrend",
        }

        check_alerts()

        titles = [event.title for event in TriggerEvent.objects.filter(alert=alert)]
        self.assertIn("BTCUSDT MACD 1m bullish cross", titles)
        trend_event = TriggerEvent.objects.get(title="BTCUSDT TREND 1m uptrend (MACD confirmation)")
        self.assertIn("200 SMA", trend_event.message)
        trend_signal.assert_called_once_with("BTCUSDT", "1m", ANY, 200)

    @patch("alerts.services._trend_signal")
    @patch("alerts.services._macd_signal")
    def test_trend_confirmation_skipped_when_price_below_sma(self, macd_signal, trend_signal):
        alert = Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.MACD, condition=Alert.Condition.CROSS_UP,
            timeframe="1m", frequency=Alert.Frequency.EVERY, trend_enabled=True,
            last_bar_open_time=timezone.now() - timedelta(minutes=2),
            last_macd_diff=-0.2,
        )
        bar_time = timezone.now() - timedelta(minutes=1)
        macd_signal.return_value = {
            "bar_time": bar_time, "previous_diff": -0.2, "current_diff": 0.1,
            "close": 100, "macd": 1, "signal": 0.9, "atr": 1,
        }
        trend_signal.return_value = {
            "bar_time": bar_time, "sma": 105, "close": 100, "trend": "downtrend",
        }

        check_alerts()

        titles = [event.title for event in TriggerEvent.objects.filter(alert=alert)]
        self.assertIn("BTCUSDT MACD 1m bullish cross", titles)
        self.assertFalse(any("TREND" in title for title in titles))

    @patch("alerts.services._trend_signal")
    @patch("alerts.services._macd_signal")
    def test_trend_failure_skips_alert_cycle(self, macd_signal, trend_signal):
        Alert.objects.create(
            symbol="BTCUSDT", kind=Alert.Kind.MACD, condition=Alert.Condition.CROSS_UP,
            timeframe="1m", frequency=Alert.Frequency.EVERY, trend_enabled=True,
            last_bar_open_time=timezone.now() - timedelta(minutes=2),
            last_macd_diff=-0.2,
        )
        bar_time = timezone.now() - timedelta(minutes=1)
        macd_signal.return_value = {
            "bar_time": bar_time, "previous_diff": -0.2, "current_diff": 0.1,
            "close": 100, "macd": 1, "signal": 0.9, "atr": 1,
        }
        trend_signal.return_value = None

        check_alerts()

        self.assertEqual(TriggerEvent.objects.count(), 0)


class TelegramAdminTests(TestCase):
    def setUp(self):
        self.notification = Notification.objects.create()
        self.user = get_user_model().objects.create_superuser("admin", "admin@example.test", "password")
        self.client.force_login(self.user)

    @override_settings(STORAGES={
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    })
    def test_configuration_form_exposes_backend_telegram_actions(self):
        response = self.client.get(f"/admin/alerts/notification/{self.notification.pk}/change/")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Find my Telegram chat ID")
        self.assertContains(response, "Send test Telegram message")

    @patch("alerts.admin.find_telegram_chat")
    def test_admin_chat_lookup_saves_chat_id(self, find_chat):
        find_chat.return_value = {"id": 512345678, "first_name": "Trader"}

        response = self.client.post(f"/admin/alerts/notification/{self.notification.pk}/find-chat/")

        self.notification.refresh_from_db()
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.notification.telegram_chat_id, "512345678")

    def test_non_staff_cannot_use_telegram_admin_actions(self):
        self.client.logout()

        response = self.client.post(f"/admin/alerts/notification/{self.notification.pk}/test-message/")

        self.assertEqual(response.status_code, 302)
        self.assertIn("/admin/login/", response.url)

    @patch("alerts.admin.send_telegram_test")
    def test_admin_test_message_uses_backend_service(self, send_test):
        response = self.client.post(f"/admin/alerts/notification/{self.notification.pk}/test-message/")

        self.assertEqual(response.status_code, 302)
        send_test.assert_called_once_with(self.notification)


class TelegramTestApiTests(TestCase):
    def setUp(self):
        self.notification = Notification.objects.create()
        self.notification.telegram_bot_token = "server-only-token"
        self.notification.telegram_chat_id = "512345678"
        self.notification.save()
        self.client = APIClient(enforce_csrf_checks=True)

    @override_settings(DEBUG=False, CSRF_TRUSTED_ORIGINS=["https://tca.noleafet.blitz.cloud"])
    @patch("alerts.views.send_telegram_test")
    def test_any_user_can_send_test_message_with_csrf(self, send_test):
        csrf = self.client.get("/api/telegram/csrf/")
        response = self.client.post(
            "/api/telegram/test/", {"bot_token": "adhoc-token", "chat_id": "987654321"}, format="json",
            HTTP_X_CSRFTOKEN=csrf.data["csrf_token"], HTTP_ORIGIN="https://tca.noleafet.blitz.cloud",
        )

        self.assertEqual(csrf.status_code, 200)
        self.assertEqual(response.status_code, 200)
        send_test.assert_called_once()
        self.assertIsInstance(send_test.call_args.args[0], Notification)
        self.assertIsNone(send_test.call_args.args[0].pk)
        self.assertEqual(send_test.call_args.kwargs, {"token": "adhoc-token", "chat_id": "987654321"})
        self.notification.refresh_from_db()
        self.assertEqual(self.notification.telegram_bot_token, "server-only-token")
        self.assertEqual(self.notification.telegram_chat_id, "512345678")

    @override_settings(DEBUG=False)
    @patch("alerts.services.requests.post")
    def test_test_message_reports_telegram_rejection(self, post):
        post.return_value.json.return_value = {"ok": False, "description": "Unauthorized"}
        csrf = self.client.get("/api/telegram/csrf/")

        response = self.client.post(
            "/api/telegram/test/", {"bot_token": "invalid-token", "chat_id": "987654321"}, format="json",
            HTTP_X_CSRFTOKEN=csrf.data["csrf_token"],
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data, {"detail": "Unauthorized"})

    def test_test_message_requires_csrf_without_a_session(self):
        response = self.client.post(
            "/api/telegram/test/", {"bot_token": "adhoc-token", "chat_id": "987654321"}, format="json",
        )

        self.assertEqual(response.status_code, 403)

    @override_settings(DEBUG=False, CSRF_TRUSTED_ORIGINS=["https://tca.noleafet.blitz.cloud"])
    @patch("alerts.views.find_telegram_chat")
    def test_any_user_can_find_chat_without_admin_session(self, find_chat):
        find_chat.return_value = {"id": 987654321, "first_name": "Ad hoc"}
        csrf = self.client.get("/api/telegram/csrf/")

        response = self.client.post(
            "/api/telegram/find-chat/", {"bot_token": "adhoc-token"}, format="json",
            HTTP_X_CSRFTOKEN=csrf.data["csrf_token"], HTTP_ORIGIN="https://tca.noleafet.blitz.cloud",
        )

        self.assertEqual(csrf.status_code, 200)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"chat_id": "987654321", "chat_name": "Ad hoc"})
        find_chat.assert_called_once()
        self.assertIsInstance(find_chat.call_args.args[0], Notification)
        self.assertIsNone(find_chat.call_args.args[0].pk)
        self.assertEqual(find_chat.call_args.kwargs, {"token": "adhoc-token"})

    @patch("alerts.views.send_telegram_test")
    def test_staff_can_send_test_message_with_csrf(self, send_test):
        user = get_user_model().objects.create_superuser("api-admin", "api-admin@example.test", "password")
        self.client.force_login(user)
        csrf = self.client.get("/api/telegram/csrf/")

        response = self.client.post(
            "/api/telegram/test/", {"bot_token": "adhoc-token", "chat_id": "987654321"}, format="json",
            HTTP_X_CSRFTOKEN=csrf.data["csrf_token"],
        )

        self.assertEqual(csrf.status_code, 200)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"detail": "Test message sent."})
        send_test.assert_called_once()
        self.assertIsInstance(send_test.call_args.args[0], Notification)
        self.assertIsNone(send_test.call_args.args[0].pk)
        self.assertEqual(send_test.call_args.kwargs, {"token": "adhoc-token", "chat_id": "987654321"})
        self.notification.refresh_from_db()
        self.assertEqual(self.notification.telegram_bot_token, "server-only-token")
        self.assertEqual(self.notification.telegram_chat_id, "512345678")

    @patch("alerts.views.find_telegram_chat")
    def test_staff_can_find_chat_with_unsaved_token(self, find_chat):
        user = get_user_model().objects.create_superuser("chat-admin", "chat-admin@example.test", "password")
        self.client.force_login(user)
        csrf = self.client.get("/api/telegram/csrf/")
        find_chat.return_value = {"id": 987654321, "first_name": "Ad hoc"}

        response = self.client.post(
            "/api/telegram/find-chat/", {"bot_token": "adhoc-token"}, format="json",
            HTTP_X_CSRFTOKEN=csrf.data["csrf_token"],
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"chat_id": "987654321", "chat_name": "Ad hoc"})
        find_chat.assert_called_once()
        self.assertIsInstance(find_chat.call_args.args[0], Notification)
        self.assertIsNone(find_chat.call_args.args[0].pk)
        self.assertEqual(find_chat.call_args.kwargs, {"token": "adhoc-token"})
        self.notification.refresh_from_db()
        self.assertEqual(self.notification.telegram_bot_token, "server-only-token")


class AppConfigurationTests(TestCase):
    def test_load_uses_database_configuration(self):
        configuration = AppConfiguration.load()
        self.assertEqual(configuration.pk, 1)
        self.assertEqual(configuration.alert_poll_seconds, 5)

        exchange = Exchange.load()
        self.assertEqual(exchange.exchange_url, "https://data-api.binance.vision/api/v3")
        self.assertEqual(exchange.exchange_timeout, 10)
        exchange.exchange_url = "https://example.test/api"
        exchange.exchange_timeout = 4
        configuration.alert_poll_seconds = 2
        exchange.save()
        configuration.save()
        reloaded = AppConfiguration.load()
        reloaded_exchange = Exchange.load()
        self.assertEqual(reloaded_exchange.exchange_url, "https://example.test/api")
        self.assertEqual(reloaded_exchange.exchange_timeout, 4)
        self.assertEqual(reloaded.alert_poll_seconds, 2)


class ExchangeSelectionApiTests(TestCase):
    def test_binance_is_the_default_and_exchange_selection_persists(self):
        response = APIClient().get("/api/exchange/")
        self.assertEqual(response.data, {"exchange": "binance", "options": ["binance", "bybit"]})

        response = APIClient().post("/api/exchange/", {"exchange": "bybit"}, format="json")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["exchange"], "bybit")
        self.assertEqual(Exchange.load().exchange, "bybit")


class WatchlistApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_migration_seeds_current_watchlist_symbols(self):
        response = self.client.get("/api/watchlist/")
        self.assertEqual([item["symbol"] for item in response.data], [
            "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
        ])

    def test_watchlist_symbols_can_be_added_and_removed(self):
        response = self.client.post("/api/watchlist/", {"symbol": "adausdt"}, format="json")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["symbol"], "ADAUSDT")

        response = self.client.delete("/api/watchlist/ADAUSDT/")
        self.assertEqual(response.status_code, 204)
        self.assertFalse(WatchlistSymbol.objects.filter(symbol="ADAUSDT").exists())


class MarketAdapterTests(TestCase):
    def setUp(self):
        self.exchange = Exchange.load()

    @patch("alerts.services.requests.get")
    def test_bybit_quote_is_normalized(self, get):
        self.exchange.exchange = Exchange.Name.BYBIT
        get.return_value.json.return_value = {
            "retCode": 0,
            "result": {"list": [{"lastPrice": "100.5", "price24hPcnt": "0.025"}]},
        }

        quote = get_market_quote("BTCUSDT", self.exchange)

        self.assertEqual(quote, {"price": 100.5, "change": 2.5})

    @patch("alerts.services.requests.get")
    def test_bybit_candles_are_normalized_in_chronological_order(self, get):
        self.exchange.exchange = Exchange.Name.BYBIT
        get.return_value.json.return_value = {
            "retCode": 0,
            "result": {"list": [
                ["2000", "2", "3", "1", "2.5", "20", "5"],
                ["1000", "1", "2", "0.5", "1.5", "10", "3"],
            ]},
        }

        candles = get_market_candles("BTCUSDT", "1m", self.exchange, 2)

        self.assertEqual([candle["time"] for candle in candles], [1, 2])
        self.assertEqual(candles[0]["close"], 1.5)
