import uuid
from django.db import models
from django.contrib.auth.models import User
from django.utils.text import slugify

class ChatRoom(models.Model):
    name = models.CharField(max_length=255, blank=True, null=True)
    description = models.TextField(blank=True, null=True)
    is_group = models.BooleanField(default=False)
    slug = models.SlugField(max_length=100, unique=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, related_name='created_rooms')
    members = models.ManyToManyField(User, related_name='chat_rooms')
    admins = models.ManyToManyField(User, related_name='admin_rooms', blank=True)
    group_avatar = models.ImageField(upload_to='group_avatars/', blank=True, null=True)
    allow_member_messages = models.BooleanField(default=True)  # If False, only admins can send messages

    def save(self, *args, **kwargs):
        if not self.slug:
            # Generate a unique slug using a UUID
            self.slug = str(uuid.uuid4())
        super().save(*args, **kwargs)

    def __str__(self):
        if self.is_group:
            return self.name or f"Group {self.slug[:8]}"
        return f"Private Chat {self.slug[:8]}"

    @property
    def avatar_url(self):
        if self.is_group:
            if self.group_avatar and hasattr(self.group_avatar, 'url'):
                return self.group_avatar.url
            return '/static/images/default-group.svg'
        return None  # For private rooms, we use the other participant's avatar


class Message(models.Model):
    FILE_TYPES = (
        ('text', 'Text'),
        ('image', 'Image'),
        ('video', 'Video'),
        ('file', 'File'),
    )

    room = models.ForeignKey(ChatRoom, on_delete=models.CASCADE, related_name='messages')
    sender = models.ForeignKey(User, on_delete=models.CASCADE, related_name='messages')
    content = models.TextField(blank=True)
    file = models.FileField(upload_to='chat_files/', blank=True, null=True)
    file_type = models.CharField(max_length=10, choices=FILE_TYPES, default='text')
    timestamp = models.DateTimeField(auto_now_add=True)
    is_read = models.BooleanField(default=False)  # Quick tracking (mostly for 1-to-1)
    edited = models.BooleanField(default=False)
    edited_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ['timestamp']

    def __str__(self):
        return f"Message by {self.sender.username} in Room {self.room.slug[:8]} at {self.timestamp}"


class MessageReceipt(models.Model):
    message = models.ForeignKey(Message, on_delete=models.CASCADE, related_name='receipts')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='message_receipts')
    read_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ('message', 'user')

    def __str__(self):
        return f"{self.user.username} read message {self.message.id} at {self.read_at}"


class CallHistory(models.Model):
    CALL_TYPES = (
        ('voice', 'Voice'),
        ('video', 'Video'),
    )
    STATUSES = (
        ('missed', 'Missed'),
        ('completed', 'Completed'),
        ('rejected', 'Rejected'),
    )
    caller = models.ForeignKey(User, on_delete=models.CASCADE, related_name='calls_started')
    receiver = models.ForeignKey(User, on_delete=models.CASCADE, related_name='calls_received')
    call_type = models.CharField(max_length=10, choices=CALL_TYPES)
    start_time = models.DateTimeField(auto_now_add=True)
    end_time = models.DateTimeField(null=True, blank=True)
    duration = models.IntegerField(null=True, blank=True, help_text="Duration in seconds")
    status = models.CharField(max_length=10, choices=STATUSES, default='missed')

    def __str__(self):
        return f"{self.call_type.capitalize()} call from {self.caller.username} to {self.receiver.username} - {self.status}"

