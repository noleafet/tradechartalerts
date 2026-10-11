from django.contrib import admin
from django.contrib import messages
from django import forms
from django.http import HttpResponseForbidden, HttpResponseNotAllowed
from django.shortcuts import redirect
from django.urls import path, reverse
import requests

from .models import Alert, AppConfiguration, Exchange, Notification, TriggerEvent
from .services import find_telegram_chat, send_telegram_test

admin.site.site_header = "TradeChartAlert administration"
admin.site.site_title = "TradeChartAlert admin"
admin.site.index_title = "Market alert operations"


class AppConfigurationForm(forms.ModelForm):
    class Meta:
        model = AppConfiguration
        fields = "__all__"


class NotificationForm(forms.ModelForm):
    class Meta:
        model = Notification
        fields = "__all__"
        widgets = {"telegram_bot_token": forms.PasswordInput(render_value=False)}

    def clean_telegram_bot_token(self):
        token = self.cleaned_data.get("telegram_bot_token", "")
        if not token and self.instance.pk:
            return Notification.objects.get(pk=self.instance.pk).telegram_bot_token
        return token


@admin.register(AppConfiguration)
class AppConfigurationAdmin(admin.ModelAdmin):
    form = AppConfigurationForm
    fields = ("alert_poll_seconds", "notification_enabled", "updated_at")
    readonly_fields = ("updated_at",)


@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    form = NotificationForm
    fields = ("telegram_bot_token", "telegram_chat_id")
    change_form_template = "admin/alerts/appconfiguration/change_form.html"

    def get_urls(self):
        custom_urls = [
            path("<path:object_id>/find-chat/", self.admin_site.admin_view(self.find_chat), name="alerts_notification_find_chat"),
            path("<path:object_id>/test-message/", self.admin_site.admin_view(self.test_message), name="alerts_notification_test_message"),
        ]
        return custom_urls + super().get_urls()

    def change_view(self, request, object_id, form_url="", extra_context=None):
        extra_context = extra_context or {}
        extra_context.update({
            "telegram_find_chat_url": reverse("admin:alerts_notification_find_chat", args=[object_id]),
            "telegram_test_message_url": reverse("admin:alerts_notification_test_message", args=[object_id]),
        })
        return super().change_view(request, object_id, form_url, extra_context)

    def _configuration_redirect(self, object_id):
        return redirect(reverse("admin:alerts_notification_change", args=[object_id]))

    def find_chat(self, request, object_id):
        if request.method != "POST":
            return HttpResponseNotAllowed(["POST"])
        if not self.has_change_permission(request):
            return HttpResponseForbidden()
        notification = self.get_object(request, object_id)
        if notification is None:
            return HttpResponseForbidden()
        try:
            chat = find_telegram_chat(notification)
            notification.telegram_chat_id = str(chat["id"])
            notification.save(update_fields=["telegram_chat_id"])
            name = chat.get("title") or " ".join(filter(None, [chat.get("first_name"), chat.get("last_name")])) or chat.get("username") or "your chat"
            self.message_user(request, f"Found {name}. Save the configuration to enable backend delivery.", messages.SUCCESS)
        except (requests.RequestException, ValueError, KeyError) as exc:
            self.message_user(request, str(exc), messages.ERROR)
        return self._configuration_redirect(object_id)

    def test_message(self, request, object_id):
        if request.method != "POST":
            return HttpResponseNotAllowed(["POST"])
        if not self.has_change_permission(request):
            return HttpResponseForbidden()
        notification = self.get_object(request, object_id)
        if notification is None:
            return HttpResponseForbidden()
        try:
            send_telegram_test(notification)
            self.message_user(request, "Test message sent. Check Telegram.", messages.SUCCESS)
        except (requests.RequestException, ValueError, KeyError) as exc:
            self.message_user(request, str(exc), messages.ERROR)
        return self._configuration_redirect(object_id)

    list_display = ("telegram_chat_id",)
    search_fields = ("telegram_chat_id",)


@admin.register(Exchange)
class ExchangeAdmin(admin.ModelAdmin):
    fields = ("exchange", "exchange_url", "exchange_timeout")

    def has_add_permission(self, request):
        return not Exchange.objects.filter(pk=1).exists()

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(Alert)
class AlertAdmin(admin.ModelAdmin):
    list_display = ("symbol", "kind", "condition", "price", "rsi_level", "timeframe", "active", "created_at")
    list_filter = ("kind", "condition", "active", "frequency")
    search_fields = ("symbol", "note")


@admin.register(TriggerEvent)
class TriggerEventAdmin(admin.ModelAdmin):
    list_display = ("symbol", "title", "triggered_at")
    list_filter = ("symbol",)
    search_fields = ("title", "message", "symbol")
