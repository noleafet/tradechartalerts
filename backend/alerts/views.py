import requests
from django.conf import settings
from django.db.models import Max
from django.middleware.csrf import get_token
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import ensure_csrf_cookie
from rest_framework.authentication import SessionAuthentication
from rest_framework import generics, status
from rest_framework.permissions import AllowAny, IsAdminUser
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Alert, AppConfiguration, Exchange, Notification, TriggerEvent, WatchlistSymbol
from .serializers import (
    AlertSerializer, ExchangeSelectionSerializer, TelegramFindChatSerializer,
    TelegramTestSerializer, TriggerEventSerializer, WatchlistSymbolSerializer,
)
from .services import (
    find_telegram_chat, get_market_candles, get_market_quote, send_telegram_test,
)


class IsAdminOrLocalDebug(IsAdminUser):
    def has_permission(self, request, view):
        if settings.DEBUG and request.META.get("REMOTE_ADDR") in {"127.0.0.1", "::1"}:
            return True
        return super().has_permission(request, view)


class AlertListCreateView(generics.ListCreateAPIView):
    queryset = Alert.objects.all()
    serializer_class = AlertSerializer

    def get_queryset(self):
        queryset = super().get_queryset()
        active = self.request.query_params.get("active")
        if active in {"true", "false"}:
            queryset = queryset.filter(active=(active == "true"))
        return queryset


class AlertDetailView(generics.RetrieveUpdateDestroyAPIView):
    queryset = Alert.objects.all()
    serializer_class = AlertSerializer


class AlertEventsView(generics.ListAPIView):
    serializer_class = TriggerEventSerializer
    queryset = TriggerEvent.objects.select_related("alert").all()[:200]


class ExchangeSelectionView(APIView):
    def get(self, request):
        exchange = Exchange.load()
        return Response({"exchange": exchange.exchange, "options": ["binance", "bybit"]})

    def post(self, request):
        serializer = ExchangeSelectionSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        exchange = Exchange.load()
        exchange.exchange = serializer.validated_data["exchange"]
        exchange.save(update_fields=["exchange"])
        return self.get(request)


class WatchlistView(APIView):
    def get(self, request):
        symbols = WatchlistSymbol.objects.all()
        return Response(WatchlistSymbolSerializer(symbols, many=True).data)

    def post(self, request):
        serializer = WatchlistSymbolSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        symbol = serializer.validated_data["symbol"]
        next_position = (WatchlistSymbol.objects.aggregate(value=Max("position"))["value"] or 0) + 1
        entry, _created = WatchlistSymbol.objects.get_or_create(
            symbol=symbol, defaults={"position": next_position},
        )
        return Response(WatchlistSymbolSerializer(entry).data, status=status.HTTP_200_OK)


class WatchlistDetailView(APIView):
    def delete(self, request, symbol):
        deleted, _details = WatchlistSymbol.objects.filter(symbol=symbol.upper()).delete()
        return Response(status=status.HTTP_204_NO_CONTENT if deleted else status.HTTP_404_NOT_FOUND)


class MarketQuoteView(APIView):
    def get(self, request):
        symbol = request.query_params.get("symbol", "").strip().upper()
        if not symbol.isalnum() or len(symbol) > 24:
            return Response({"detail": "A valid market symbol is required."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            return Response(get_market_quote(symbol, Exchange.load()))
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except requests.RequestException:
            return Response({"detail": "The selected exchange could not be reached."}, status=status.HTTP_502_BAD_GATEWAY)


class MarketCandlesView(APIView):
    def get(self, request):
        symbol = request.query_params.get("symbol", "").strip().upper()
        timeframe = request.query_params.get("interval", "1h")
        if not symbol.isalnum() or len(symbol) > 24:
            return Response({"detail": "A valid market symbol is required."}, status=status.HTTP_400_BAD_REQUEST)
        if timeframe not in {"1m", "5m", "15m", "1h", "4h", "1d", "1w"}:
            return Response({"detail": "Unsupported market timeframe."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            limit = max(2, min(int(request.query_params.get("limit", "500")), 1000))
        except ValueError:
            return Response({"detail": "Limit must be an integer."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            candles = get_market_candles(symbol, timeframe, Exchange.load(), limit)
            return Response(candles)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except requests.RequestException:
            return Response({"detail": "The selected exchange could not be reached."}, status=status.HTTP_502_BAD_GATEWAY)


class HealthView(APIView):
    authentication_classes = []
    permission_classes = []

    def get(self, request):
        return Response({"status": "ok"}, status=status.HTTP_200_OK)


class TelegramStatusView(APIView):
    def get(self, request):
        configuration = AppConfiguration.load()
        notification = Notification.load()
        configured = bool(notification.telegram_bot_token and notification.telegram_chat_id)
        return Response({
            "configured": configured,
            "enabled": configured and configuration.notification_enabled,
            "chat_hint": f"...{notification.telegram_chat_id[-4:]}" if notification.telegram_chat_id else "",
        })


class TelegramCsrfView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]

    @method_decorator(ensure_csrf_cookie)
    def get(self, request):
        return Response({"csrf_token": get_token(request)})


class TelegramTestView(APIView):
    authentication_classes = [SessionAuthentication]
    permission_classes = [IsAdminOrLocalDebug]

    def post(self, request):
        serializer = TelegramTestSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        try:
            send_telegram_test(
                Notification.load(),
                token=serializer.validated_data["bot_token"],
                chat_id=serializer.validated_data["chat_id"],
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except requests.RequestException:
            return Response({"detail": "Telegram could not be reached. Check backend logs and try again."}, status=status.HTTP_502_BAD_GATEWAY)
        return Response({"detail": "Test message sent."}, status=status.HTTP_200_OK)


class TelegramFindChatView(APIView):
    authentication_classes = [SessionAuthentication]
    permission_classes = [IsAdminOrLocalDebug]

    def post(self, request):
        serializer = TelegramFindChatSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        try:
            chat = find_telegram_chat(Notification.load(), token=serializer.validated_data["bot_token"])
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except requests.RequestException:
            return Response({"detail": "Telegram could not be reached. Check the token and try again."}, status=status.HTTP_502_BAD_GATEWAY)
        name = chat.get("title") or " ".join(filter(None, [chat.get("first_name"), chat.get("last_name")])) or chat.get("username") or "Telegram chat"
        return Response({"chat_id": str(chat["id"]), "chat_name": name}, status=status.HTTP_200_OK)
