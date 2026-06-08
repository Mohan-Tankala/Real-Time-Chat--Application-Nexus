import mimetypes
from django.shortcuts import render, redirect, get_object_or_404
from django.contrib.auth.decorators import login_required
from django.contrib.auth.models import User
from django.contrib import messages
from django.http import JsonResponse, HttpResponseForbidden
from django.db.models import Q, Max, OuterRef, Subquery, Count
from .models import ChatRoom, Message, MessageReceipt, CallHistory
from notifications.models import Notification

@login_required
def dashboard_view(request, room_slug=None):
    # Get all rooms the user is a member of
    rooms = request.user.chat_rooms.all()

    # Annotate rooms with the timestamp of their last message to sort them
    rooms = rooms.annotate(
        last_message_time=Max('messages__timestamp')
    ).order_by('-last_message_time', '-created_at')

    # Prepare chat list details
    chat_list = []
    for room in rooms:
        # Determine room name and avatar for display
        display_name = room.name
        display_avatar = '/static/images/default-group.svg'
        other_user = None

        if not room.is_group:
            # For 1-to-1 private chat, find the other member
            members = room.members.exclude(id=request.user.id)
            if members.exists():
                other_user = members.first()
                display_name = f"{other_user.first_name} {other_user.last_name}".strip() or other_user.username
                display_avatar = other_user.profile.avatar_url
            else:
                display_name = "Saved Messages (You)"
                display_avatar = request.user.profile.avatar_url

        else:
            if room.group_avatar:
                display_avatar = room.group_avatar.url

        # Get last message
        last_msg = room.messages.order_by('-timestamp').first()
        
        # Get unread count of notifications for this room
        unread_count = Notification.objects.filter(
            recipient=request.user,
            room=room,
            is_read=False
        ).count()

        chat_list.append({
            'room': room,
            'display_name': display_name,
            'display_avatar': display_avatar,
            'last_message': last_msg,
            'unread_count': unread_count,
            'other_user': other_user,
        })

    active_room = None
    messages_history = []
    group_members = []
    
    if room_slug:
        active_room = get_object_or_404(ChatRoom, slug=room_slug)
        # Ensure user is a member
        if request.user not in active_room.members.all():
            return HttpResponseForbidden("You are not a member of this chat room.")
        
        # Mark all notifications for this room as read
        Notification.objects.filter(
            recipient=request.user,
            room=active_room,
            is_read=False
        ).update(is_read=True)

        # Get message history
        messages_history = active_room.messages.all().select_related('sender', 'sender__profile')
        
        # If it's a group, get member details
        if active_room.is_group:
            group_members = active_room.members.all().select_related('profile')

    # All users list (for creating new chats)
    all_users = User.objects.exclude(id=request.user.id).select_related('profile')

    context = {
        'chat_list': chat_list,
        'active_room': active_room,
        'messages_history': messages_history,
        'group_members': group_members,
        'all_users': all_users,
    }
    return render(request, 'chat/dashboard.html', context)


@login_required
def get_or_create_private_chat(request, user_id):
    other_user = get_object_or_404(User, id=user_id)
    if other_user == request.user:
        # Check for self room
        rooms = ChatRoom.objects.filter(is_group=False, members=request.user).annotate(num_members=Count('members')).filter(num_members=1)
    else:
        # Check if there is already a 1-to-1 room with both users
        rooms = ChatRoom.objects.filter(is_group=False).filter(members=request.user).filter(members=other_user)

    if rooms.exists():
        room = rooms.first()
    else:
        # Create a new room
        room = ChatRoom.objects.create(is_group=False, created_by=request.user)
        room.members.add(request.user)
        if other_user != request.user:
            room.members.add(other_user)
        room.save()

    return redirect('room', room_slug=room.slug)


@login_required
def create_group_chat(request):
    if request.method == 'POST':
        name = request.POST.get('name')
        description = request.POST.get('description', '')
        member_ids = request.POST.getlist('members')
        group_avatar = request.FILES.get('group_avatar')

        if not name:
            messages.error(request, "Group name is required.")
            return redirect('dashboard')

        room = ChatRoom.objects.create(
            name=name,
            description=description,
            is_group=True,
            created_by=request.user,
            group_avatar=group_avatar
        )
        room.members.add(request.user)
        room.admins.add(request.user)

        for member_id in member_ids:
            try:
                user = User.objects.get(id=member_id)
                room.members.add(user)
            except User.DoesNotExist:
                continue

        room.save()
        messages.success(request, f"Group '{name}' created successfully!")
        return redirect('room', room_slug=room.slug)

    return redirect('dashboard')


@login_required
def remove_member(request, room_slug, user_id):
    """Allow group admins to remove a specific member from the group."""
    if request.method != 'POST':
        return JsonResponse({'error': 'POST method required'}, status=400)

    room = get_object_or_404(ChatRoom, slug=room_slug)

    # Must be a group room
    if not room.is_group:
        return JsonResponse({'error': 'This action is only available for group chats.'}, status=400)

    # Requesting user must be an admin of this group
    if request.user not in room.admins.all():
        return JsonResponse({'error': 'Only group admins can remove members.'}, status=403)

    # Identify the member to remove
    target_user = get_object_or_404(User, id=user_id)

    # Cannot remove yourself
    if target_user == request.user:
        return JsonResponse({'error': 'You cannot remove yourself from the group.'}, status=400)

    # Cannot remove another admin
    if target_user in room.admins.all():
        return JsonResponse({'error': 'You cannot remove another admin from the group.'}, status=400)

    # Ensure the target is actually a member
    if target_user not in room.members.all():
        return JsonResponse({'error': 'This user is not a member of the group.'}, status=400)

    room.members.remove(target_user)

    return JsonResponse({'success': True, 'removed_user_id': target_user.id, 'removed_username': target_user.username})


@login_required
def upload_file_api(request, room_slug):
    if request.method != 'POST':
        return JsonResponse({'error': 'POST method required'}, status=400)
    
    room = get_object_or_404(ChatRoom, slug=room_slug)
    if request.user not in room.members.all():
        return JsonResponse({'error': 'Forbidden'}, status=403)

    uploaded_file = request.FILES.get('file')
    if not uploaded_file:
        return JsonResponse({'error': 'No file uploaded'}, status=400)

    # Determine file type
    content_type, _ = mimetypes.guess_type(uploaded_file.name)
    file_type = 'file'
    if content_type:
        if content_type.startswith('image/'):
            file_type = 'image'
        elif content_type.startswith('video/'):
            file_type = 'video'

    # Save message with file
    message = Message.objects.create(
        room=room,
        sender=request.user,
        file=uploaded_file,
        file_type=file_type,
        content=uploaded_file.name
    )

    # Make notifications for other members
    for member in room.members.exclude(id=request.user.id):
        Notification.objects.create(
            recipient=member,
            sender=request.user,
            room=room,
            message=message
        )

    return JsonResponse({
        'success': True,
        'message_id': message.id,
        'file_url': message.file.url,
        'file_name': uploaded_file.name,
        'file_type': file_type,
        'timestamp': message.timestamp.isoformat(),
        'sender': request.user.username,
        'sender_avatar': request.user.profile.avatar_url
    })


@login_required
def get_call_history_api(request):
    calls = CallHistory.objects.filter(
        Q(caller=request.user) | Q(receiver=request.user)
    ).order_by('-start_time')[:50]
    
    data = []
    for call in calls:
        other_user = call.receiver if call.caller == request.user else call.caller
        data.append({
            'id': call.id,
            'caller': call.caller.username,
            'receiver': call.receiver.username,
            'other_user_id': other_user.id,
            'other_user_username': other_user.username,
            'other_user_display': f"{other_user.first_name} {other_user.last_name}".strip() or other_user.username,
            'other_user_avatar': other_user.profile.avatar_url,
            'call_type': call.call_type,
            'status': call.status,
            'start_time': call.start_time.isoformat(),
            'duration': call.duration,
            'is_caller': call.caller == request.user
        })
    return JsonResponse({'calls': data})

