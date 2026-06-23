import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.contrib.auth.models import User
from django.utils import timezone
from django.db import close_old_connections
from .models import ChatRoom, Message, MessageReceipt, CallHistory
from notifications.models import Notification
from accounts.models import UserProfile

class ChatConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.user = self.scope["user"]
        self.room_slug = self.scope["url_route"]["kwargs"]["room_slug"]
        self.room_group_name = f"chat_{self.room_slug}"

        # Reject unauthenticated users
        if not self.user.is_authenticated:
            await self.close()
            return

        # Verify membership
        if self.room_slug != 'global':
            is_member = await self.verify_room_membership(self.user, self.room_slug)
            if not is_member:
                await self.close()
                return

        # Join room group
        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )

        # Join user-specific group for real-time signaling/calls
        self.user_group_name = f"user_{self.user.username.lower()}"
        await self.channel_layer.group_add(
            self.user_group_name,
            self.channel_name
        )

        await self.accept()

        # Update status to online and broadcast
        await self.update_user_status(self.user, True)
        await self.broadcast_user_status(True)

    async def disconnect(self, close_code):
        if hasattr(self, 'room_group_name'):
            # Update status to offline and broadcast
            try:
                await self.update_user_status(self.user, False)
                await self.broadcast_user_status(False)
            except Exception as e:
                print(f"Error updating user status on disconnect: {e}")

            # Leave room group
            try:
                await self.channel_layer.group_discard(
                    self.room_group_name,
                    self.channel_name
                )
            except Exception as e:
                print(f"Error leaving room group on disconnect: {e}")

        if hasattr(self, 'user_group_name'):
            # Leave user-specific group
            try:
                await self.channel_layer.group_discard(
                    self.user_group_name,
                    self.channel_name
                )
            except Exception as e:
                print(f"Error leaving user group on disconnect: {e}")


    async def receive(self, text_data):
        data = json.loads(text_data)
        event_type = data.get('type')

        if event_type == 'chat_message':
            content = data.get('message', '').strip()
            file_id = data.get('file_id')  # If sent from HTTP upload

            if content or file_id:
                # Save message
                msg_data = await self.save_message(self.user, self.room_slug, content, file_id)
                
                # Send message to room group
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'broadcast_message',
                        'message': msg_data
                    }
                )

        elif event_type == 'typing':
            status = data.get('status', False)
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'broadcast_typing',
                    'username': self.user.username,
                    'status': status
                }
            )

        elif event_type == 'edit_message':
            message_id = data.get('message_id')
            new_content = data.get('message', '').strip()
            
            success = await self.edit_message(self.user, message_id, new_content)
            if success:
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'broadcast_message_edited',
                        'message_id': message_id,
                        'content': new_content
                    }
                )

        elif event_type == 'delete_message':
            message_id = data.get('message_id')
            success = await self.delete_message(self.user, message_id)
            if success:
                await self.channel_layer.group_send(
                    self.room_group_name,
                    {
                        'type': 'broadcast_message_deleted',
                        'message_id': message_id
                    }
                )

        elif event_type == 'mark_read':
            message_id = data.get('message_id')
            await self.mark_message_as_read(self.user, message_id)
            await self.channel_layer.group_send(
                self.room_group_name,
                {
                    'type': 'broadcast_message_read',
                    'message_id': message_id,
                    'username': self.user.username
                }
            )

        elif event_type == 'call_user':
            target_username = data.get('target_username')
            call_type = data.get('call_type', 'voice')
            room_slug = data.get('room_slug')
            call_id = await self.create_call_history(self.user, target_username, call_type)
            await self.channel_layer.group_send(
                f"user_{target_username.lower()}",
                {
                    'type': 'user_call_event',
                    'payload': {
                        'type': 'incoming_call',
                        'caller_username': self.user.username,
                        'caller_avatar': self.user.profile.avatar_url,
                        'caller_display': f"{self.user.first_name} {self.user.last_name}".strip() or self.user.username,
                        'room_slug': room_slug,
                        'call_type': call_type,
                        'call_id': call_id,
                        'offer': data.get('offer')
                    }
                }
            )
            await self.send(text_data=json.dumps({
                'type': 'call_initiated',
                'call_id': call_id
            }))

        elif event_type in ['accept_call', 'call_accepted']:
            caller_username = data.get('caller_username')
            call_id = data.get('call_id')
            await self.channel_layer.group_send(
                f"user_{caller_username.lower()}",
                {
                    'type': 'user_call_event',
                    'payload': {
                        'type': 'call_accepted',
                        'receiver_username': self.user.username,
                        'call_id': call_id
                    }
                }
            )

        elif event_type in ['reject_call', 'call_rejected']:
            caller_username = data.get('caller_username')
            call_id = data.get('call_id')
            await self.update_call_status(call_id, 'rejected')
            await self.channel_layer.group_send(
                f"user_{caller_username.lower()}",
                {
                    'type': 'user_call_event',
                    'payload': {
                        'type': 'call_rejected',
                        'receiver_username': self.user.username,
                        'call_id': call_id
                    }
                }
            )

        elif event_type in ['end_call', 'call_ended']:
            target_username = data.get('target_username')
            call_id = data.get('call_id')
            duration = data.get('duration', 0)
            await self.update_call_status(call_id, 'completed', duration)
            await self.channel_layer.group_send(
                f"user_{target_username.lower()}",
                {
                    'type': 'user_call_event',
                    'payload': {
                        'type': 'call_ended',
                        'call_id': call_id
                    }
                }
            )

        elif event_type in ['offer', 'answer', 'ice_candidate', 'incoming_call', 'screen_share_started', 'screen_share_stopped']:
            target_username = data.get('target_username')
            await self.channel_layer.group_send(
                f"user_{target_username.lower()}",
                {
                    'type': 'user_call_event',
                    'payload': data
                }
            )


    # Broadcast handlers (called when channel layer sends to groups)
    async def broadcast_message(self, event):
        await self.send(text_data=json.dumps({
            'type': 'chat_message',
            'message': event['message']
        }))

    async def broadcast_typing(self, event):
        await self.send(text_data=json.dumps({
            'type': 'typing',
            'username': event['username'],
            'status': event['status']
        }))

    async def broadcast_user_status(self, event_or_bool):
        # Can be called directly on connect or via group
        if isinstance(event_or_bool, dict):
            is_online = event_or_bool['is_online']
            username = event_or_bool['username']
            last_seen = event_or_bool['last_seen']
        else:
            is_online = event_or_bool
            username = self.user.username
            last_seen = timezone.now().isoformat()

        await self.send(text_data=json.dumps({
            'type': 'user_status',
            'username': username,
            'is_online': is_online,
            'last_seen': last_seen
        }))

    async def broadcast_message_edited(self, event):
        await self.send(text_data=json.dumps({
            'type': 'message_edited',
            'message_id': event['message_id'],
            'content': event['content']
        }))

    async def broadcast_message_deleted(self, event):
        await self.send(text_data=json.dumps({
            'type': 'message_deleted',
            'message_id': event['message_id']
        }))

    async def broadcast_message_read(self, event):
        await self.send(text_data=json.dumps({
            'type': 'message_read',
            'message_id': event['message_id'],
            'username': event['username']
        }))

    # Helper method to broadcast status to all active rooms for this user
    async def broadcast_user_status(self, is_online):
        rooms = await self.get_user_rooms(self.user)
        for r_slug in rooms:
            await self.channel_layer.group_send(
                f"chat_{r_slug}",
                {
                    'type': 'user_status_group_event',
                    'username': self.user.username,
                    'is_online': is_online,
                    'last_seen': timezone.now().isoformat()
                }
            )

    async def user_status_group_event(self, event):
        await self.send(text_data=json.dumps({
            'type': 'user_status',
            'username': event['username'],
            'is_online': event['is_online'],
            'last_seen': event['last_seen']
        }))

    async def user_call_event(self, event):
        await self.send(text_data=json.dumps(event['payload']))


    # Database sync wrappers
    @database_sync_to_async
    def verify_room_membership(self, user, slug):
        close_old_connections()
        try:
            room = ChatRoom.objects.get(slug=slug)
            return room.members.filter(id=user.id).exists()
        except ChatRoom.DoesNotExist:
            return False

    @database_sync_to_async
    def get_user_rooms(self, user):
        close_old_connections()
        return list(user.chat_rooms.values_list('slug', flat=True))

    @database_sync_to_async
    def update_user_status(self, user, is_online):
        close_old_connections()
        profile = user.profile
        profile.is_online = is_online
        profile.last_seen = timezone.now()
        profile.save()

    @database_sync_to_async
    def save_message(self, sender, room_slug, content, file_id=None):
        close_old_connections()
        room = ChatRoom.objects.get(slug=room_slug)
        
        if file_id:
            # Message is already created via file upload HTTP view, get it and update content if needed
            msg = Message.objects.get(id=file_id)
            if content:
                msg.content = content
                msg.save()
        else:
            # Create a brand new text message
            msg = Message.objects.create(
                room=room,
                sender=sender,
                content=content,
                file_type='text'
            )

        # Create notifications for all other members in the room
        for member in room.members.exclude(id=sender.id):
            Notification.objects.create(
                recipient=member,
                sender=sender,
                room=room,
                message=msg
            )

        return {
            'id': msg.id,
            'content': msg.content,
            'file_url': msg.file.url if msg.file else None,
            'file_type': msg.file_type,
            'timestamp': msg.timestamp.isoformat(),
            'sender': sender.username,
            'sender_avatar': sender.profile.avatar_url,
            'is_read': msg.is_read
        }

    @database_sync_to_async
    def edit_message(self, user, message_id, new_content):
        """
        Allow a user to edit *their most recent* message within 5 minutes.
        Returns True on success, False otherwise.
        """
        close_old_connections()
        from datetime import timedelta
        # Retrieve the message the user wants to edit
        try:
            msg = Message.objects.get(id=message_id, sender=user)
        except Message.DoesNotExist:
            return False

        # Ensure this is the latest message sent by the user
        latest_msg = Message.objects.filter(sender=user).order_by('-timestamp').first()
        if not latest_msg or latest_msg.id != msg.id:
            return False

        # Enforce 5‑minute edit window
        if timezone.now() - msg.timestamp > timedelta(minutes=5):
            return False

        # Apply the edit
        msg.content = new_content
        msg.edited = True
        msg.edited_at = timezone.now()
        msg.save()
        return True

    @database_sync_to_async
    def delete_message(self, user, message_id):
        close_old_connections()
        try:
            msg = Message.objects.get(id=message_id, sender=user)
            msg.delete()
            return True
        except Message.DoesNotExist:
            return False

    @database_sync_to_async
    def mark_message_as_read(self, user, message_id):
        close_old_connections()
        try:
            msg = Message.objects.get(id=message_id)
            if msg.sender != user:
                # Mark is_read to true on the message itself
                msg.is_read = True
                msg.save()
                
                # Log receipt
                MessageReceipt.objects.get_or_create(message=msg, user=user)
                
                # Delete any associated notification for this user
                Notification.objects.filter(recipient=user, message=msg).update(is_read=True)
        except Message.DoesNotExist:
            pass

    @database_sync_to_async
    def create_call_history(self, caller, receiver_username, call_type):
        close_old_connections()
        try:
            receiver = User.objects.get(username=receiver_username)
            call = CallHistory.objects.create(
                caller=caller,
                receiver=receiver,
                call_type=call_type,
                status='missed'
            )
            return call.id
        except User.DoesNotExist:
            return None

    @database_sync_to_async
    def update_call_status(self, call_id, status, duration=None):
        close_old_connections()
        if not call_id:
            return
        try:
            call = CallHistory.objects.get(id=call_id)
            call.status = status
            call.end_time = timezone.now()
            if duration is not None:
                call.duration = duration
            call.save()
        except CallHistory.DoesNotExist:
            pass

