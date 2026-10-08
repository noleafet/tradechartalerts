from django.urls import path

from .views import (
    AlertDetailView, AlertEventsView, AlertListCreateView, ExchangeSelectionView, HealthView,
    MarketCandlesView, MarketQuoteView,
    TelegramCsrfView, TelegramFindChatView, TelegramStatusView, TelegramTestView,
    WatchlistDetailView, WatchlistView,
)

urlpatterns = [
    path("health/", HealthView.as_view(), name="health"),
    path("exchange/", ExchangeSelectionView.as_view(), name="exchange-selection"),
    path("watchlist/", WatchlistView.as_view(), name="watchlist"),
    path("watchlist/<str:symbol>/", WatchlistDetailView.as_view(), name="watchlist-detail"),
    path("market/quote/", MarketQuoteView.as_view(), name="market-quote"),
    path("market/candles/", MarketCandlesView.as_view(), name="market-candles"),
    path("telegram/status/", TelegramStatusView.as_view(), name="telegram-status"),
    path("telegram/csrf/", TelegramCsrfView.as_view(), name="telegram-csrf"),
    path("telegram/find-chat/", TelegramFindChatView.as_view(), name="telegram-find-chat"),
    path("telegram/test/", TelegramTestView.as_view(), name="telegram-test"),
    path("alerts/", AlertListCreateView.as_view(), name="alert-list"),
    path("alerts/<int:pk>/", AlertDetailView.as_view(), name="alert-detail"),
    path("events/", AlertEventsView.as_view(), name="event-list"),
]
