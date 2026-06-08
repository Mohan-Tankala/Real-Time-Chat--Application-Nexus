from django.contrib import admin
from django.urls import path
from django.conf import settings
from django.conf.urls.static import static

# View imports
from accounts.views import signup_view, login_view, logout_view, profile_edit_view, search_users_api
from chat.views import dashboard_view, get_or_create_private_chat, create_group_chat, upload_file_api, remove_member, get_call_history_api
from notifications.views import get_unread_count_api, mark_all_as_read_api

urlpatterns = [
    path('admin/', admin.site.urls),
    
    # Authentication
    path('signup/', signup_view, name='signup'),
    path('login/', login_view, name='login'),
    path('logout/', logout_view, name='logout'),
    path('profile/', profile_edit_view, name='profile'),
    
    # Search API
    path('api/users/search/', search_users_api, name='search_users_api'),
    
    # Chat Application
    path('', dashboard_view, name='dashboard'),
    path('room/<slug:room_slug>/', dashboard_view, name='room'),
    path('chat/private/<int:user_id>/', get_or_create_private_chat, name='get_or_create_private_chat'),
    path('chat/group/create/', create_group_chat, name='create_group_chat'),
    path('chat/group/<slug:room_slug>/remove/<int:user_id>/', remove_member, name='remove_member'),
    path('chat/upload/<slug:room_slug>/', upload_file_api, name='upload_file_api'),
    
    # Notifications API
    path('api/notifications/unread/', get_unread_count_api, name='unread_notifications_count'),
    path('api/notifications/read-all/', mark_all_as_read_api, name='mark_all_notifications_read'),
    
    # Call History API
    path('api/calls/history/', get_call_history_api, name='get_call_history_api'),
]

# Serve media files in development
if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
