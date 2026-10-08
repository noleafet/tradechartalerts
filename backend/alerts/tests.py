from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from .models import Alert, AppConfiguration, Exchange, Notification, TriggerEvent, WatchlistSymbol
from .services import _notify, get_market_candles, get_market_quote


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
        notification = Notification.load()
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
        notification = Notification.load()
        notification.telegram_bot_token = "secret-token"
        notification.telegram_chat_id = "123456789"
        event = TriggerEvent(symbol="BTCUSDT", title="BTC alert", message="Target crossed")

        notification.save()
        _notify(event, configuration)
        send_message.assert_not_called()

        configuration.notification_enabled = True
        _notify(event, configuration)
        send_message.assert_called_once()


class TelegramAdminTests(TestCase):
    def setUp(self):
        self.notification = Notification.load()
        self.user = get_user_model().objects.create_superuser("admin", "admin@example.test", "password")
        self.client.force_login(self.user)

    @override_settings(STORAGES={
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    })
    def test_configuration_form_exposes_backend_telegram_actions(self):
        response = self.client.get("/admin/alerts/notification/1/change/")

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Find my Telegram chat ID")
        self.assertContains(response, "Send test Telegram message")

    @patch("alerts.admin.find_telegram_chat")
    def test_admin_chat_lookup_saves_chat_id(self, find_chat):
        find_chat.return_value = {"id": 512345678, "first_name": "Trader"}

        response = self.client.post("/admin/alerts/notification/find-chat/")

        self.notification.refresh_from_db()
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.notification.telegram_chat_id, "512345678")

    def test_non_staff_cannot_use_telegram_admin_actions(self):
        self.client.logout()

        response = self.client.post("/admin/alerts/notification/test-message/")

        self.assertEqual(response.status_code, 302)
        self.assertIn("/admin/login/", response.url)

    @patch("alerts.admin.send_telegram_test")
    def test_admin_test_message_uses_backend_service(self, send_test):
        response = self.client.post("/admin/alerts/notification/test-message/")

        self.assertEqual(response.status_code, 302)
        send_test.assert_called_once_with(self.notification)


class TelegramTestApiTests(TestCase):
    def setUp(self):
        self.notification = Notification.load()
        self.notification.telegram_bot_token = "server-only-token"
        self.notification.telegram_chat_id = "512345678"
        self.notification.save()
        self.client = APIClient(enforce_csrf_checks=True)

    @override_settings(DEBUG=False)
    def test_test_message_requires_staff_session_outside_debug(self):
        response = self.client.post("/api/telegram/test/", {}, format="json")

        self.assertEqual(response.status_code, 403)

    @override_settings(DEBUG=True)
    @patch("alerts.views.send_telegram_test")
    def test_local_debug_can_send_test_message_without_staff_session(self, send_test):
        response = self.client.post(
            "/api/telegram/test/", {"bot_token": "adhoc-token", "chat_id": "987654321"}, format="json",
        )

        self.assertEqual(response.status_code, 200)
        send_test.assert_called_once_with(self.notification, token="adhoc-token", chat_id="987654321")

    @override_settings(DEBUG=True)
    @patch("alerts.services.requests.post")
    def test_test_message_reports_telegram_rejection(self, post):
        post.return_value.json.return_value = {"ok": False, "description": "Unauthorized"}

        response = self.client.post(
            "/api/telegram/test/", {"bot_token": "invalid-token", "chat_id": "987654321"}, format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.data, {"detail": "Unauthorized"})

    @override_settings(DEBUG=True)
    def test_non_loopback_debug_request_still_requires_staff(self):
        response = self.client.post(
            "/api/telegram/test/", {}, format="json", REMOTE_ADDR="203.0.113.10",
        )

        self.assertEqual(response.status_code, 403)

    @override_settings(DEBUG=True)
    @patch("alerts.views.find_telegram_chat")
    def test_local_debug_can_find_chat_without_staff_session(self, find_chat):
        find_chat.return_value = {"id": 987654321, "first_name": "Ad hoc"}

        response = self.client.post(
            "/api/telegram/find-chat/", {"bot_token": "adhoc-token"}, format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, {"chat_id": "987654321", "chat_name": "Ad hoc"})
        find_chat.assert_called_once_with(self.notification, token="adhoc-token")

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
        send_test.assert_called_once_with(self.notification, token="adhoc-token", chat_id="987654321")
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
        find_chat.assert_called_once_with(self.notification, token="adhoc-token")
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
