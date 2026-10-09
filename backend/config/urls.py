from django.contrib import admin
from django.urls import include, path
from django.views.generic.base import RedirectView

urlpatterns = [
    # Dynamic redirect that resolves the actual admin URL configuration
    path('', RedirectView.as_view(pattern_name='admin:index', permanent=False), name='root-redirect'),
    
    # Your actual admin path
    path('admin/', admin.site.urls),
    path("api/", include("alerts.urls")),
]