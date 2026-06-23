// Real-time Chat WebSocket and AJAX Handler
let chatSocket = null;
let reconnectDelay = 2000;
let isEditing = false;
let editMessageId = null;
let typingTimeout = null;
let isTyping = false;

// DOM Elements
const msgListPane = document.getElementById('messages-list-pane');
const chatInput = document.getElementById('chat-input-field');
const sendBtn = document.getElementById('send-message-btn');
const fileUploader = document.getElementById('file-uploader');
const editToolbar = document.getElementById('edit-message-toolbar');
const editOriginalText = document.getElementById('edit-message-original-text');

// Connect to Channels WebSocket
function connectWebSocket() {
    console.log("Connecting WebSocket to URL:", wsUrl);
    chatSocket = new WebSocket(wsUrl);

    chatSocket.onopen = function(e) {
        console.log("WebSocket connection established!");
        reconnectDelay = 2000; // Reset reconnect delay on successful connection
        scrollToBottom();
        markAllActiveMessagesAsRead();
    };

    chatSocket.onmessage = function(e) {
        const data = json_parse_or_null(e.data);
        if (!data) return;

        const eventType = data.type;

        if (eventType === 'chat_message') {
            handleIncomingMessage(data.message);
        } else if (eventType === 'typing') {
            handleTypingIndicator(data.username, data.status);
        } else if (eventType === 'user_status') {
            handleUserStatusChange(data.username, data.is_online, data.last_seen);
        } else if (eventType === 'message_edited') {
            handleMessageEdit(data.message_id, data.content);
        } else if (eventType === 'message_deleted') {
            handleMessageDelete(data.message_id);
        } else if (eventType === 'message_read') {
            handleMessageReadReceipt(data.message_id, data.username);
        } else if (eventType === 'incoming_call') {
            handleIncomingCall(data);
        } else if (eventType === 'call_initiated') {
            callId = data.call_id;
            console.log("CALL INITIATED. Call ID set to:", callId);
        } else if (eventType === 'call_accepted') {
            handleCallAccepted(data);
        } else if (eventType === 'call_rejected') {
            handleCallRejected(data);
        } else if (eventType === 'call_ended') {
            handleCallEnded(data);
        } else if (eventType === 'offer') {
            handleOffer(data.offer);
        } else if (eventType === 'answer') {
            handleAnswer(data.answer);
        } else if (eventType === 'ice_candidate') {
            handleIceCandidate(data.candidate);
        } else if (eventType === 'screen_share_started') {
            handleRemoteScreenShareStarted();
        } else if (eventType === 'screen_share_stopped') {
            handleRemoteScreenShareStopped();
        }
    };

    chatSocket.onclose = function(e) {
        console.warn("WebSocket closed unexpectedly. Reconnecting in " + reconnectDelay + "ms...", e.reason);
        setTimeout(function() {
            reconnectDelay = Math.min(reconnectDelay * 1.5, 30000); // Exponential backoff capped at 30s
            connectWebSocket();
        }, reconnectDelay);
    };

    chatSocket.onerror = function(err) {
        console.error("WebSocket error observed:", err);
    };
}

// Safely parse JSON
function json_parse_or_null(str) {
    try {
        return JSON.parse(str);
    } catch (e) {
        return null;
    }
}

// Format ISO date to simple timestamp
function formatTime(isoString) {
    const date = new Date(isoString);
    let hours = date.getHours();
    let minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    minutes = minutes < 10 ? '0' + minutes : minutes;
    return hours + ':' + minutes + ' ' + ampm;
}

// Append new message to messages container
function handleIncomingMessage(msg) {
    const isMe = msg.sender === currentUsername;
    
    // Check if message is already in DOM to prevent duplication
    if (document.getElementById(`msg-wrapper-${msg.id}`)) {
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.id = `msg-wrapper-${msg.id}`;
    wrapper.className = `message-wrapper d-flex mb-3 ${isMe ? 'justify-content-end' : ''}`;

    let avatarHtml = '';
    if (!isMe) {
        avatarHtml = `<img src="${msg.sender_avatar}" alt="Avatar" class="rounded-circle border border-secondary border-opacity-25 me-2 mt-auto" style="width: 32px; height: 32px; object-fit: cover;">`;
    }

    let mediaHtml = '';
    if (msg.file_type === 'image') {
        mediaHtml = `
            <div class="message-image-container mb-1">
                <img src="${msg.file_url}" alt="Upload" class="img-fluid rounded border border-secondary border-opacity-25 cursor-pointer max-w-250 shadow-sm" style="max-height: 250px; object-fit: cover;" onclick="openImageModal('${msg.file_url}')">
            </div>`;
    } else if (msg.file_type === 'video') {
        mediaHtml = `
            <div class="message-video-container mb-1">
                <video src="${msg.file_url}" controls class="rounded border border-secondary border-opacity-25 shadow-sm" style="max-width: 250px; max-height: 200px;"></video>
            </div>`;
    } else if (msg.file_type === 'file') {
        mediaHtml = `
            <div class="message-file-container mb-1 d-flex align-items-center gap-2 p-2 bg-dark bg-opacity-25 rounded border border-secondary border-opacity-10">
                <i class="fa-solid fa-file-arrow-down text-primary fs-4"></i>
                <div class="overflow-hidden">
                    <a href="${msg.file_url}" download class="text-light small text-decoration-none fw-medium text-truncate d-block" style="max-width: 150px;">${msg.content}</a>
                    <span class="text-secondary" style="font-size: 0.65rem;">Download Document</span>
                </div>
            </div>`;
    } else {
        mediaHtml = `<span class="message-text" id="msg-text-${msg.id}">${escapeHTML(msg.content)}</span>`;
    }

    const editDeleteHtml = isMe ? `
        <div class="message-actions-trigger position-absolute top-50 translate-middle-y d-none" id="actions-trigger-${msg.id}">
            <div class="dropdown">
                <button class="btn btn-sm text-secondary hover-primary border-0 bg-transparent p-1" data-bs-toggle="dropdown"><i class="fa-solid fa-ellipsis-vertical"></i></button>
                <ul class="dropdown-menu dropdown-menu-dark border-secondary border-opacity-25 shadow">
                    ${msg.file_type === 'text' ? `<li><button class="dropdown-item text-light py-1.5" onclick="enterEditMode(${msg.id}, '${escapeJS(msg.content)}')"><i class="fa-solid fa-pen-to-square me-2 fs-7"></i>Edit</button></li>` : ''}
                    <li><button class="dropdown-item text-danger py-1.5" onclick="deleteMessage(${msg.id})"><i class="fa-solid fa-trash-can me-2 fs-7"></i>Delete</button></li>
                </ul>
            </div>
        </div>` : '';

    const ticksHtml = isMe ? `
        <span class="read-receipt" id="receipt-${msg.id}">
            ${msg.is_read ? '<i class="fa-solid fa-check-double text-success"></i>' : '<i class="fa-solid fa-check text-secondary"></i>'}
        </span>` : '';

    wrapper.innerHTML = `
        ${avatarHtml}
        <div class="message-bubble-container position-relative">
            <div class="message-bubble ${isMe ? 'message-sent' : 'message-received'} p-2.5 px-3 rounded shadow-sm" id="msg-bubble-${msg.id}">
                ${mediaHtml}
                <div class="message-meta d-flex justify-content-end align-items-center gap-1.5 mt-1" style="font-size: 0.68rem;">
                    <span class="text-secondary-opacity" id="msg-edited-${msg.id}"></span>
                    <span class="text-secondary-opacity">${formatTime(msg.timestamp)}</span>
                    ${ticksHtml}
                </div>
            </div>
            ${editDeleteHtml}
        </div>
    `;

    // Append to DOM before typing indicator
    const typingIndicator = document.getElementById('typing-indicator');
    if (msgListPane) {
        msgListPane.insertBefore(wrapper, typingIndicator);
    }
    
    scrollToBottom();

    // Mark as read immediately if window is active and message is from someone else
    if (!isMe) {
        sendMarkReadNotification(msg.id);
        triggerPushNotification(msg);
    }

    // Update Sidebar details
    updateSidebarPreview(roomSlug, msg.content, msg.timestamp, isMe);
}

// Send read indicator to websocket
function sendMarkReadNotification(messageId) {
    if (chatSocket && chatSocket.readyState === WebSocket.OPEN) {
        chatSocket.send(JSON.stringify({
            'type': 'mark_read',
            'message_id': messageId
        }));
    }
}

// Mark all active visible messages as read
function markAllActiveMessagesAsRead() {
    const unreadReceivedMessages = document.querySelectorAll('.message-received');
    unreadReceivedMessages.forEach(bubble => {
        const id = bubble.id.replace('msg-bubble-', '');
        sendMarkReadNotification(id);
    });
}

// Push notification generator
function triggerPushNotification(msg) {
    if ('Notification' in window && Notification.permission === 'granted') {
        // Only trigger if document is hidden or user in different focus
        if (document.hidden) {
            new Notification(`New message from ${msg.sender}`, {
                body: msg.file_type !== 'text' ? `Shared a ${msg.file_type}` : msg.content,
                icon: msg.sender_avatar
            });
        }
    }
}

// Update Sidebar room details dynamically
function updateSidebarPreview(slug, text, timestamp, isMe) {
    const previewEl = document.getElementById(`preview-${slug}`);
    const timeEl = document.getElementById(`time-${slug}`);
    const roomItem = document.querySelector(`[data-room-slug="${slug}"]`);

    if (previewEl) {
        previewEl.innerText = isMe ? `You: ${text}` : text;
    }
    if (timeEl) {
        timeEl.innerText = formatTime(timestamp);
    }
    if (roomItem) {
        // Move chat item to top of sidebar
        const parent = roomItem.parentElement;
        parent.insertBefore(roomItem, parent.firstChild);
    }
}

// Live typing indicator handler
function handleTypingIndicator(username, status) {
    if (username === currentUsername) return;

    const typingBubble = document.getElementById('typing-indicator');
    const typingText = document.getElementById('typing-indicator-text');

    if (status) {
        typingText.innerText = `${username} is typing...`;
        typingBubble.classList.remove('d-none');
        typingBubble.classList.add('d-flex');
        scrollToBottom();
    } else {
        typingBubble.classList.add('d-none');
        typingBubble.classList.remove('d-flex');
    }
}

// Live user status tracker
function handleUserStatusChange(username, isOnline, lastSeen) {
    const statusDot = document.getElementById(`status-dot-${username}`);
    const statusMember = document.getElementById(`status-member-${username}`);
    
    // Update sidebar dots
    if (statusDot) {
        if (isOnline) {
            statusDot.className = 'status-indicator position-absolute bottom-0 end-0 rounded-circle border border-dark bg-success';
        } else {
            statusDot.className = 'status-indicator position-absolute bottom-0 end-0 rounded-circle border border-dark bg-secondary';
        }
    }

    // Update group members dots
    if (statusMember) {
        if (isOnline) {
            statusMember.className = 'status-indicator position-absolute bottom-0 end-0 rounded-circle border border-dark bg-success';
        } else {
            statusMember.className = 'status-indicator position-absolute bottom-0 end-0 rounded-circle border border-dark bg-secondary';
        }
    }

    // Update header status if talking to this user in private room
    const statusText = document.getElementById('active-room-status-text');
    const headerDisplay = document.getElementById('active-room-display-name');
    if (statusText && headerDisplay && headerDisplay.innerText.trim() === username) {
        statusText.innerHTML = isOnline ? '<span class="text-success">Online</span>' : 'Offline';
    }
}

// Edit text message handler
function handleMessageEdit(messageId, newContent) {
    const textEl = document.getElementById(`msg-text-${messageId}`);
    const editedEl = document.getElementById(`msg-edited-${messageId}`);
    
    if (textEl) {
        textEl.innerText = newContent;
    }
    if (editedEl) {
        editedEl.innerText = 'edited ';
    }
}

// Delete message handler
function handleMessageDelete(messageId) {
    const wrapper = document.getElementById(`msg-wrapper-${messageId}`);
    if (wrapper) {
        wrapper.style.transition = 'all 0.3s ease';
        wrapper.style.opacity = '0';
        wrapper.style.height = '0';
        wrapper.style.margin = '0';
        wrapper.style.padding = '0';
        setTimeout(() => {
            wrapper.remove();
        }, 300);
    }
}

// Mark ticks blue on receipts
function handleMessageReadReceipt(messageId, username) {
    if (username === currentUsername) return;
    const receiptEl = document.getElementById(`receipt-${messageId}`);
    if (receiptEl) {
        receiptEl.innerHTML = '<i class="fa-solid fa-check-double text-success"></i>';
    }
}

// Auto scroll messages container
function scrollToBottom() {
    if (msgListPane) {
        msgListPane.scrollTop = msgListPane.scrollHeight;
    }
}

// Enter inline edit message mode
window.enterEditMode = function(messageId, originalText) {
    isEditing = true;
    editMessageId = messageId;
    
    editOriginalText.innerText = originalText;
    editToolbar.classList.remove('d-none');
    chatInput.value = originalText;
    chatInput.focus();
};

// Exit edit mode
window.cancelEditMode = function() {
    isEditing = false;
    editMessageId = null;
    editToolbar.classList.add('d-none');
    chatInput.value = '';
};

// Send / Submit Message
function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    if (isEditing) {
        // Send edit update request
        chatSocket.send(JSON.stringify({
            'type': 'edit_message',
            'message_id': editMessageId,
            'message': text
        }));
        cancelEditMode();
    } else {
        // Send normal chat message
        chatSocket.send(JSON.stringify({
            'type': 'chat_message',
            'message': text
        }));
        chatInput.value = '';
        sendStopTypingEvent();
    }
}

// Delete Message API WebSocket call
window.deleteMessage = function(messageId) {
    if (confirm("Are you sure you want to delete this message?")) {
        chatSocket.send(JSON.stringify({
            'type': 'delete_message',
            'message_id': messageId
        }));
    }
};

// Broadcast Typing state
function sendTypingEvent(status) {
    if (chatSocket && chatSocket.readyState === WebSocket.OPEN) {
        chatSocket.send(JSON.stringify({
            'type': 'typing',
            'status': status
        }));
    }
}

function sendStopTypingEvent() {
    isTyping = false;
    sendTypingEvent(false);
}

// Keyboard typing listeners
if (chatInput) {
    chatInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            sendMessage();
            return;
        }

        if (!isTyping) {
            isTyping = true;
            sendTypingEvent(true);
        }

        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(sendStopTypingEvent, 3000);
    });
}

if (sendBtn) {
    sendBtn.addEventListener('click', sendMessage);
}

// File uploads triggers
window.triggerFileUpload = function() {
    if (fileUploader) fileUploader.click();
};

window.handleFileUpload = function(input) {
    if (!input.files || input.files.length === 0) return;
    
    const file = input.files[0];
    const formData = new FormData();
    formData.append('file', file);

    const csrfToken = getCookie('csrftoken');
    
    // UI state attachment upload start
    const attachBtn = document.getElementById('attach-btn');
    if (attachBtn) {
        attachBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-primary"></i>';
        attachBtn.disabled = true;
    }

    fetch(fileUploadUrl, {
        method: 'POST',
        headers: {
            'X-CSRFToken': csrfToken
        },
        body: formData
    })
    .then(res => res.json())
    .then(data => {
        if (attachBtn) {
            attachBtn.innerHTML = '<i class="fa-solid fa-paperclip"></i>';
            attachBtn.disabled = false;
        }
        
        if (data.success) {
            // File uploaded via HTTP. Now broadcast its details via websocket to alert the consumer
            chatSocket.send(JSON.stringify({
                'type': 'chat_message',
                'file_id': data.message_id,
                'message': data.file_name
            }));
            
            // Clear input uploader field
            if (fileUploader) fileUploader.value = '';
        } else {
            alert("File upload failed: " + (data.error || "Unknown error"));
        }
    })
    .catch(err => {
        console.error("Upload error details:", err);
        if (attachBtn) {
            attachBtn.innerHTML = '<i class="fa-solid fa-paperclip"></i>';
            attachBtn.disabled = false;
        }
        alert("An error occurred during file upload.");
    });
};

// Fetch Cookie Utility (for CSRF token headers)
function getCookie(name) {
    let cookieValue = null;
    if (document.cookie && document.cookie !== '') {
        const cookies = document.cookie.split(';');
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i].trim();
            if (cookie.substring(0, name.length + 1) === (name + '=')) {
                cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
                break;
            }
        }
    }
    return cookieValue;
}

// Escape HTML entities to prevent DOM XSS
function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
}

// Escape inline JS escape characters
function escapeJS(str) {
    return str.replace(/\\/g, '\\\\')
              .replace(/'/g, "\\'")
              .replace(/"/g, '\\"')
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r');
}


// =========================================================================
// WEBRTC SIGNALING AND AUDIO/VIDEO CALL LOGIC
// =========================================================================

let peerConnection = null;
let localStream = null;
let screenStream = null;
let screenSender = null;
let callId = null;
let callType = null; // 'voice' or 'video'
let isCallActive = false;
let callTimerInterval = null;
let callStartTime = null;
let isMuted = false;
let isCamOff = false;
let callerUsername = null;
let incomingCallModalInstance = null;
let savedOffer = null;
let remoteIceCandidatesQueue = [];

const iceServersConfig = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun3.l.google.com:19302" },
        { urls: "stun:stun4.l.google.com:19302" }
    ]
};

function processQueuedIceCandidates() {
    console.log("Processing queued ICE candidates:", remoteIceCandidatesQueue.length);
    while (remoteIceCandidatesQueue.length > 0) {
        const candidate = remoteIceCandidatesQueue.shift();
        if (peerConnection) {
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(err => console.error("Failed to add queued ICE candidate:", err));
        }
    }
}

// Start WebRTC Call (Voice or Video)
function startCall(type) {
    if (!targetUsername) {
        alert("No participant found to call.");
        return;
    }
    console.log("CALL INITIATED");
    
    callType = type;
    isMuted = false;
    isCamOff = false;
    
    // UI updates: show call screen overlay, configure controls
    const activeCallScreen = document.getElementById('active-call-screen');
    const callAvatar = document.getElementById('call-avatar');
    const callDisplayName = document.getElementById('call-display-name');
    const callStatusText = document.getElementById('call-status-text');
    const callTimer = document.getElementById('call-timer');
    const videoGrid = document.getElementById('video-grid');
    const localVideo = document.getElementById('local-video');
    
    const toggleCamBtn = document.getElementById('toggle-cam-btn');
    const shareScreenBtn = document.getElementById('share-screen-btn');
    const micBtn = document.getElementById('toggle-mic-btn');
    
    // Reset call overlay controls
    if (micBtn) {
        micBtn.classList.remove('control-off');
        micBtn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
    }
    
    if (toggleCamBtn) {
        toggleCamBtn.classList.remove('control-off');
        toggleCamBtn.innerHTML = '<i class="fa-solid fa-video"></i>';
    }
    
    if (callStatusText) callStatusText.innerText = "Calling...";
    if (callTimer) {
        callTimer.classList.add('d-none');
        callTimer.innerText = "00:00";
    }
    if (activeCallScreen) activeCallScreen.classList.remove('d-none');
    
    // Configure icons/animations for voice vs video
    if (type === 'voice') {
        if (videoGrid) videoGrid.classList.add('d-none');
        if (callAvatar) callAvatar.classList.remove('d-none');
        if (toggleCamBtn) toggleCamBtn.classList.add('d-none');
        if (shareScreenBtn) shareScreenBtn.classList.add('d-none');
    } else {
        if (videoGrid) videoGrid.classList.remove('d-none');
        if (callAvatar) callAvatar.classList.add('d-none');
        if (toggleCamBtn) toggleCamBtn.classList.remove('d-none');
        if (shareScreenBtn) shareScreenBtn.classList.remove('d-none');
    }

    // Try finding display avatar of target user in sidebar
    const targetAvatarImg = document.getElementById(`avatar-${roomSlug}`);
    if (callAvatar && targetAvatarImg) {
        callAvatar.src = targetAvatarImg.src;
    }
    
    const activeRoomNameEl = document.getElementById('active-room-display-name');
    if (callDisplayName && activeRoomNameEl) {
        callDisplayName.innerText = activeRoomNameEl.innerText.trim();
    }

    // Access local microphone/camera
    const constraints = {
        audio: true,
        video: type === 'video'
    };
    
    navigator.mediaDevices.getUserMedia(constraints)
        .catch(err => {
            console.warn("Local media capture failed with initial constraints, trying fallback...", err);
            if (constraints.video) {
                // Video failed, try audio-only
                callType = 'voice';
                if (videoGrid) videoGrid.classList.add('d-none');
                if (callAvatar) callAvatar.classList.remove('d-none');
                if (toggleCamBtn) toggleCamBtn.classList.add('d-none');
                if (shareScreenBtn) shareScreenBtn.classList.add('d-none');
                return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            }
            throw err;
        })
        .then(stream => {
            localStream = stream;
            if (callType === 'video' && localVideo) {
                localVideo.srcObject = stream;
            }
            console.log("LOCAL STREAM READY");
            console.log("STREAM ADDED (Local stream initialized)");
            
            // Create Peer Connection and attach tracks
            createPeerConnection(targetUsername);
            
            localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, localStream);
                console.log("TRACK ADDED:", track.kind);
            });
            
            // Create offer
            return peerConnection.createOffer();
        })
        .then(offer => {
            console.log("OFFER CREATED", offer);
            return peerConnection.setLocalDescription(offer).then(() => offer);
        })
        .then(offer => {
            // Broadcast call initiation message to target user via channels (including offer!)
            chatSocket.send(JSON.stringify({
                'type': 'call_user',
                'target_username': targetUsername,
                'call_type': callType,
                'room_slug': roomSlug,
                'offer': offer
            }));
            console.log("OFFER SENT");
            
            isCallActive = true;
        })
        .catch(err => {
            console.error("Local media capture failed:", err);
            alert("Could not access camera/microphone. Check permissions.");
            endCall(false);
        });
}

// // Handle Incoming Call
function handleIncomingCall(data) {
    console.log("CALL RECEIVED", data);
    if (data.offer) {
        console.log("OFFER RECEIVED", data.offer);
    }
    if (isCallActive) {
        // Automatically reject if busy in another call
        chatSocket.send(JSON.stringify({
            'type': 'reject_call',
            'caller_username': data.caller_username,
            'call_id': data.call_id
        }));
        return;
    }
    
    callId = data.call_id;
    callType = data.call_type;
    callerUsername = data.caller_username;
    savedOffer = data.offer; // Save offer for setRemoteDescription later!
    isMuted = false;
    isCamOff = false;
    
    const incomingCallAvatar = document.getElementById('incoming-call-avatar');
    const incomingCallDisplayName = document.getElementById('incoming-call-display-name');
    const incomingCallTypeText = document.getElementById('incoming-call-type-text');
    
    if (incomingCallAvatar) incomingCallAvatar.src = data.caller_avatar;
    if (incomingCallDisplayName) incomingCallDisplayName.innerText = data.caller_display;
    if (incomingCallTypeText) {
        incomingCallTypeText.innerText = `Incoming ${data.call_type.charAt(0).toUpperCase() + data.call_type.slice(1)} Call...`;
    }
    
    const modalEl = document.getElementById('incomingCallModal');
    if (modalEl) {
        incomingCallModalInstance = new bootstrap.Modal(modalEl);
        incomingCallModalInstance.show();
    }
}

// Accept call
function acceptCall() {
    console.log("CALL ACCEPTED (by clicking Accept)");
    if (incomingCallModalInstance) {
        incomingCallModalInstance.hide();
    }
    
    // UI configuration
    const activeCallScreen = document.getElementById('active-call-screen');
    const callAvatar = document.getElementById('call-avatar');
    const callDisplayName = document.getElementById('call-display-name');
    const callStatusText = document.getElementById('call-status-text');
    const callTimer = document.getElementById('call-timer');
    const videoGrid = document.getElementById('video-grid');
    const localVideo = document.getElementById('local-video');
    
    const toggleCamBtn = document.getElementById('toggle-cam-btn');
    const shareScreenBtn = document.getElementById('share-screen-btn');
    const micBtn = document.getElementById('toggle-mic-btn');
    
    if (micBtn) {
        micBtn.classList.remove('control-off');
        micBtn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
    }
    if (toggleCamBtn) {
        toggleCamBtn.classList.remove('control-off');
        toggleCamBtn.innerHTML = '<i class="fa-solid fa-video"></i>';
    }
    
    if (callStatusText) callStatusText.innerText = "Connecting...";
    if (callTimer) {
        callTimer.classList.add('d-none');
        callTimer.innerText = "00:00";
    }
    if (activeCallScreen) activeCallScreen.classList.remove('d-none');
    
    if (callType === 'voice') {
        if (videoGrid) videoGrid.classList.add('d-none');
        if (callAvatar) callAvatar.classList.remove('d-none');
        if (toggleCamBtn) toggleCamBtn.classList.add('d-none');
        if (shareScreenBtn) shareScreenBtn.classList.add('d-none');
    } else {
        if (videoGrid) videoGrid.classList.remove('d-none');
        if (callAvatar) callAvatar.classList.add('d-none');
        if (toggleCamBtn) toggleCamBtn.classList.remove('d-none');
        if (shareScreenBtn) shareScreenBtn.classList.remove('d-none');
    }
    
    if (callDisplayName) callDisplayName.innerText = callerUsername;
    
    // Access local media
    const constraints = {
        audio: true,
        video: callType === 'video'
    };
    
    navigator.mediaDevices.getUserMedia(constraints)
        .catch(err => {
            console.warn("Local media capture failed with initial constraints, trying fallback...", err);
            if (constraints.video) {
                // Video failed, try audio-only
                callType = 'voice';
                
                const videoGrid = document.getElementById('video-grid');
                const callAvatar = document.getElementById('call-avatar');
                const toggleCamBtn = document.getElementById('toggle-cam-btn');
                const shareScreenBtn = document.getElementById('share-screen-btn');
                
                if (videoGrid) videoGrid.classList.add('d-none');
                if (callAvatar) callAvatar.classList.remove('d-none');
                if (toggleCamBtn) toggleCamBtn.classList.add('d-none');
                if (shareScreenBtn) shareScreenBtn.classList.add('d-none');
                
                return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            }
            throw err;
        })
        .then(stream => {
            localStream = stream;
            if (callType === 'video' && localVideo) {
                localVideo.srcObject = stream;
            }
            console.log("LOCAL STREAM READY");
            console.log("STREAM ADDED (Local stream initialized)");
            
            // Create Peer Connection and attach tracks
            createPeerConnection(callerUsername);
            
            localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, localStream);
                console.log("TRACK ADDED:", track.kind);
            });
            
            // Notify caller that call was accepted
            chatSocket.send(JSON.stringify({
                'type': 'accept_call',
                'caller_username': callerUsername,
                'call_id': callId
            }));
            
            isCallActive = true;
            
            if (savedOffer) {
                console.log("Setting remote description with saved offer...");
                return peerConnection.setRemoteDescription(new RTCSessionDescription(savedOffer))
                    .then(() => {
                        console.log("Remote description set. Creating answer...");
                        processQueuedIceCandidates();
                        return peerConnection.createAnswer();
                    })
                    .then(answer => {
                        console.log("ANSWER CREATED", answer);
                        return peerConnection.setLocalDescription(answer).then(() => answer);
                    })
                    .then(answer => {
                        chatSocket.send(JSON.stringify({
                            'type': 'answer',
                            'answer': answer,
                            'target_username': callerUsername
                        }));
                        console.log("ANSWER SENT");
                    });
            } else {
                console.error("No saved offer found when accepting call.");
            }
        })
        .catch(err => {
            console.error("Local media capture failed:", err);
            alert("Could not access camera/microphone.");
            rejectCall();
        });
}

// Reject call
function rejectCall() {
    if (incomingCallModalInstance) {
        incomingCallModalInstance.hide();
    }
    
    chatSocket.send(JSON.stringify({
        'type': 'reject_call',
        'caller_username': callerUsername,
        'call_id': callId
    }));
    
    resetCallState();
}

// Handle Call Accepted on Caller end
function handleCallAccepted(data) {
    console.log("CALL ACCEPTED", data);
    const callStatusText = document.getElementById('call-status-text');
    if (callStatusText) callStatusText.innerText = "Connecting...";
    // No need to create and send offer here, it was already sent in startCall
}

// Handle Call Rejected on Caller end
function handleCallRejected(data) {
    console.log("CALL REJECTED", data);
    const callStatusText = document.getElementById('call-status-text');
    if (callStatusText) callStatusText.innerText = "Call Busy / Rejected";
    
    setTimeout(() => {
        endCall(false);
    }, 2000);
}

// Handle Call Ended
function handleCallEnded(data) {
    console.log("CALL ENDED", data);
    const callStatusText = document.getElementById('call-status-text');
    if (callStatusText) callStatusText.innerText = "Call Ended";
    
    setTimeout(() => {
        endCall(false);
    }, 1000);
}

// Create RTCPeerConnection
function createPeerConnection(targetUser) {
    peerConnection = new RTCPeerConnection(iceServersConfig);
    console.log("PEER CONNECTION CREATED");
    
    // Send ICE candidates to target user
    peerConnection.onicecandidate = function(event) {
        if (event.candidate) {
            console.log("ICE GENERATED", event.candidate);
            console.log("ICE CANDIDATE SENT/RECEIVED (Sent candidate)", event.candidate);
            chatSocket.send(JSON.stringify({
                'type': 'ice_candidate',
                'candidate': event.candidate,
                'target_username': targetUser
            }));
        }
    };
    
    // Handle remote media stream arrival
    peerConnection.ontrack = function(event) {
        console.log("REMOTE STREAM RECEIVED");
        console.log("STREAM ADDED (Remote stream track received)");
        const remoteVideo = document.getElementById('remote-video');
        if (remoteVideo) {
            if (event.streams && event.streams[0]) {
                if (remoteVideo.srcObject !== event.streams[0]) {
                    remoteVideo.srcObject = event.streams[0];
                    console.log("Attached event.streams[0] to remote-video");
                }
            } else {
                if (!remoteVideo.srcObject) {
                    remoteVideo.srcObject = new MediaStream();
                    console.log("Created new MediaStream for remote-video");
                }
                remoteVideo.srcObject.addTrack(event.track);
                console.log("Added track to remote-video MediaStream:", event.track.kind);
            }
        }
    };
    
    // Handle connection state changes
    peerConnection.onconnectionstatechange = function() {
        const callStatusText = document.getElementById('call-status-text');
        const callTimer = document.getElementById('call-timer');
        
        switch (peerConnection.connectionState) {
            case "connected":
                console.log("CALL CONNECTED");
                if (callStatusText) callStatusText.innerText = "Connected";
                if (callTimer) callTimer.classList.remove('d-none');
                startCallTimer();
                break;
            case "disconnected":
            case "failed":
                if (callStatusText) callStatusText.innerText = "Connection lost";
                endCall(true);
                break;
            case "closed":
                break;
        }
    };
}

// Handle Offer
function handleOffer(offer) {
    console.log("OFFER RECEIVED", offer);
    if (!peerConnection) {
        createPeerConnection(callerUsername || targetUsername);
    }
    peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
        .then(() => {
            console.log("Remote description set via offer event. Creating answer...");
            processQueuedIceCandidates();
            return peerConnection.createAnswer();
        })
        .then(answer => {
            console.log("ANSWER CREATED", answer);
            return peerConnection.setLocalDescription(answer).then(() => answer);
        })
        .then(answer => {
            chatSocket.send(JSON.stringify({
                'type': 'answer',
                'answer': answer,
                'target_username': callerUsername || targetUsername
            }));
        })
        .catch(err => console.error("WebRTC Offer event handling failed:", err));
}

// Handle Answer
function handleAnswer(answer) {
    console.log("ANSWER RECEIVED", answer);
    if (peerConnection) {
        peerConnection.setRemoteDescription(new RTCSessionDescription(answer))
            .then(() => {
                console.log("Remote description set via answer event. Processing queued ICE candidates...");
                processQueuedIceCandidates();
            })
            .catch(err => console.error("Failed to set remote description via answer event:", err));
    }
}

// Handle ICE Candidate
function handleIceCandidate(candidate) {
    console.log("ICE RECEIVED", candidate);
    console.log("ICE CANDIDATE SENT/RECEIVED (Received candidate)", candidate);
    if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
        peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
            .catch(err => console.error("Failed to add ICE candidate:", err));
    } else {
        console.log("Queueing remote ICE candidate as remoteDescription is not set yet");
        remoteIceCandidatesQueue.push(candidate);
    }
}

// End Call
function endCall(notifyOther = true) {
    if (notifyOther && isCallActive) {
        const target = targetUsername || callerUsername;
        const duration = callStartTime ? Math.round((Date.now() - callStartTime) / 1000) : 0;
        if (target) {
            chatSocket.send(JSON.stringify({
                'type': 'end_call',
                'target_username': target,
                'call_id': callId,
                'duration': duration
            }));
        }
    }
    
    resetCallState();
    
    const activeCallScreen = document.getElementById('active-call-screen');
    if (activeCallScreen) activeCallScreen.classList.add('d-none');
}

// Reset Local WebRTC Session Variables
function resetCallState() {
    stopCallTimer();
    
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
    }
    
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    const localVideo = document.getElementById('local-video');
    const remoteVideo = document.getElementById('remote-video');
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;
    
    callId = null;
    callType = null;
    isCallActive = false;
    callerUsername = null;
    savedOffer = null;
    remoteIceCandidatesQueue = [];
}

// Microphone Toggle
function toggleMic() {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            isMuted = !isMuted;
            audioTrack.enabled = !isMuted;
            
            const micBtn = document.getElementById('toggle-mic-btn');
            if (micBtn) {
                if (isMuted) {
                    micBtn.classList.add('control-off');
                    micBtn.innerHTML = '<i class="fa-solid fa-microphone-slash"></i>';
                } else {
                    micBtn.classList.remove('control-off');
                    micBtn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
                }
            }
        }
    }
}

// Camera Toggle
function toggleCam() {
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            isCamOff = !isCamOff;
            videoTrack.enabled = !isCamOff;
            
            const camBtn = document.getElementById('toggle-cam-btn');
            if (camBtn) {
                if (isCamOff) {
                    camBtn.classList.add('control-off');
                    camBtn.innerHTML = '<i class="fa-solid fa-video-slash"></i>';
                } else {
                    camBtn.classList.remove('control-off');
                    camBtn.innerHTML = '<i class="fa-solid fa-video"></i>';
                }
            }
        }
    }
}

// Screen Sharing
function shareScreen() {
    if (!localStream || !peerConnection) return;
    
    navigator.mediaDevices.getDisplayMedia({ video: true })
        .then(stream => {
            screenStream = stream;
            
            const screenTrack = screenStream.getVideoTracks()[0];
            const videoSender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
            
            if (videoSender) {
                videoSender.replaceTrack(screenTrack);
            } else {
                screenSender = peerConnection.addTrack(screenTrack, screenStream);
            }
            
            // Show local preview of screen sharing
            const localVideo = document.getElementById('local-video');
            const videoGrid = document.getElementById('video-grid');
            if (videoGrid) {
                videoGrid.classList.remove('d-none');
            }
            if (localVideo) {
                localVideo.srcObject = screenStream;
            }
            
            // Notify remote user screen sharing started
            const target = targetUsername || callerUsername;
            if (target) {
                chatSocket.send(JSON.stringify({
                    'type': 'screen_share_started',
                    'target_username': target
                }));
            }
            
            // Swap Screen button state
            const shareBtn = document.getElementById('share-screen-btn');
            if (shareBtn) {
                shareBtn.classList.add('control-off');
                shareBtn.title = "Stop Screen Share";
            }
            
            // Listen for user stopping sharing from browser overlay bar
            screenTrack.onended = function() {
                stopScreenShare();
            };
        })
        .catch(err => console.error("Screen sharing activation failed:", err));
}

// Stop Screen Share
function stopScreenShare() {
    if (!screenStream || !peerConnection) return;
    
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
    
    const camTrack = localStream.getVideoTracks()[0];
    const videoSender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
    
    if (videoSender && camTrack) {
        videoSender.replaceTrack(camTrack);
    } else if (screenSender) {
        try {
            peerConnection.removeTrack(screenSender);
        } catch (e) {
            console.error("Error removing screen share track:", e);
        }
        screenSender = null;
    }
    
    const localVideo = document.getElementById('local-video');
    if (localVideo) {
        localVideo.srcObject = callType === 'video' ? localStream : null;
    }
    
    const videoGrid = document.getElementById('video-grid');
    if (callType === 'voice' && videoGrid) {
        videoGrid.classList.add('d-none');
    }
    
    // Notify remote user screen sharing stopped
    const target = targetUsername || callerUsername;
    if (target) {
        chatSocket.send(JSON.stringify({
            'type': 'screen_share_stopped',
            'target_username': target
        }));
    }
    
    const shareBtn = document.getElementById('share-screen-btn');
    if (shareBtn) {
        shareBtn.classList.remove('control-off');
        shareBtn.title = "Share Screen";
    }
}

// Remote Screen Sharing UI events updates
function handleRemoteScreenShareStarted() {
    console.log("Remote peer started sharing screen.");
    const remoteVideo = document.getElementById('remote-video');
    if (remoteVideo) {
        remoteVideo.style.border = '2px solid var(--primary)';
    }
}

function handleRemoteScreenShareStopped() {
    console.log("Remote peer stopped sharing screen.");
    const remoteVideo = document.getElementById('remote-video');
    if (remoteVideo) {
        remoteVideo.style.border = '1px solid var(--border-glass)';
    }
}

// Call Duration Timer
function startCallTimer() {
    if (callTimerInterval) clearInterval(callTimerInterval);
    
    callStartTime = Date.now();
    const callTimer = document.getElementById('call-timer');
    
    callTimerInterval = setInterval(() => {
        const diffMs = Date.now() - callStartTime;
        const totalSecs = Math.floor(diffMs / 1000);
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        
        const formatted = (mins < 10 ? '0' + mins : mins) + ':' + (secs < 10 ? '0' + secs : secs);
        if (callTimer) callTimer.innerText = formatted;
    }, 1000);
}

// Stop Call Timer
function stopCallTimer() {
    if (callTimerInterval) {
        clearInterval(callTimerInterval);
        callTimerInterval = null;
    }
    callStartTime = null;
}


// =========================================================================
// CALL HISTORY AND SIDEBAR TAB SWITCHING
// =========================================================================

// Switch Sidebar Tabs
window.switchSidebarTab = function(tab) {
    const tabChats = document.getElementById('tab-chats');
    const tabCalls = document.getElementById('tab-calls');
    const chatsPane = document.getElementById('chats-list-pane');
    const callsPane = document.getElementById('calls-list-pane');
    
    if (tab === 'chats') {
        if (tabChats) tabChats.classList.add('active');
        if (tabCalls) tabCalls.classList.remove('active');
        if (chatsPane) chatsPane.classList.remove('d-none');
        if (callsPane) callsPane.classList.add('d-none');
    } else {
        if (tabChats) tabChats.classList.remove('active');
        if (tabCalls) tabCalls.classList.add('active');
        if (chatsPane) chatsPane.classList.add('d-none');
        if (callsPane) callsPane.classList.remove('d-none');
        loadCallHistory();
    }
};

// Fetch call history from API and render it
function loadCallHistory() {
    const listContainer = document.getElementById('calls-history-list');
    const emptyState = document.getElementById('calls-empty-state');
    
    if (!listContainer) return;
    
    fetch('/api/calls/history/')
        .then(res => res.json())
        .then(data => {
            listContainer.innerHTML = '';
            
            if (data.calls && data.calls.length > 0) {
                if (emptyState) emptyState.classList.add('d-none');
                
                data.calls.forEach(call => {
                    const durationText = call.duration ? formatDuration(call.duration) : '';
                    const timeFormatted = formatCallTime(call.start_time);
                    
                    let statusHtml = '';
                    if (call.status === 'completed') {
                        statusHtml = `<span class="text-success small d-flex align-items-center gap-1"><i class="fa-solid fa-phone-arrow-up-right text-success" style="font-size:0.75rem;"></i>Completed ${durationText}</span>`;
                    } else if (call.status === 'rejected') {
                        statusHtml = `<span class="text-secondary small d-flex align-items-center gap-1"><i class="fa-solid fa-phone-slash text-secondary" style="font-size:0.75rem;"></i>Declined</span>`;
                    } else {
                        statusHtml = `<span class="text-danger small d-flex align-items-center gap-1"><i class="fa-solid fa-phone-arrow-down-left text-danger" style="font-size:0.75rem;"></i>Missed</span>`;
                    }
                    
                    const iconClass = call.call_type === 'video' ? 'fa-video call-history-icon-video' : 'fa-phone call-history-icon-voice';
                    
                    const item = document.createElement('div');
                    item.className = 'call-history-item d-flex align-items-center justify-content-between p-2 rounded mb-1';
                    item.innerHTML = `
                        <div class="d-flex align-items-center gap-3">
                            <div class="position-relative">
                                <img src="${call.other_user_avatar}" alt="${call.other_user_display}" class="rounded-circle" style="width: 42px; height: 42px; object-fit: cover;">
                                <span class="position-absolute bottom-0 end-0 call-history-icon-wrapper rounded-circle p-0.5 d-flex align-items-center justify-content-center" style="width: 18px; height: 18px; font-size: 0.6rem; background: #090d16; border: 1px solid var(--border-glass);">
                                    <i class="fa-solid ${call.call_type === 'video' ? 'fa-video text-primary' : 'fa-phone text-primary'}"></i>
                                </span>
                            </div>
                            <div>
                                <h6 class="text-light mb-0 fw-semibold text-truncate small" style="max-width: 140px;">${call.other_user_display}</h6>
                                <div class="d-flex flex-column" style="gap: 1px;">
                                    ${statusHtml}
                                    <span class="text-muted" style="font-size: 0.68rem;">${timeFormatted}</span>
                                </div>
                            </div>
                        </div>
                        <a href="/chat/private/${call.other_user_id}/" class="btn btn-icon text-success hover-success" title="Chat & Callback">
                            <i class="fa-solid fa-phone"></i>
                        </a>
                    `;
                    listContainer.appendChild(item);
                });
            } else {
                if (emptyState) emptyState.classList.remove('d-none');
            }
        })
        .catch(err => {
            console.error("Failed to load call history:", err);
            listContainer.innerHTML = '<div class="text-center text-danger small py-3">Could not load call history.</div>';
        });
}

// Helper formats duration
function formatDuration(secs) {
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${s}s`;
}

// Helper formats ISO date for call items
function formatCallTime(isoString) {
    const d = new Date(isoString);
    const options = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    return d.toLocaleDateString([], options);
}




// Attach UI Event Listeners for Call Controls
function initCallEventListeners() {
    const startVoiceBtn = document.getElementById('start-voice-call');
    const startVideoBtn = document.getElementById('start-video-call');
    const acceptCallBtn = document.getElementById('accept-call-btn');
    const declineCallBtn = document.getElementById('decline-call-btn');
    const endCallBtn = document.getElementById('end-call-btn');
    const toggleMicBtn = document.getElementById('toggle-mic-btn');
    const toggleCamBtn = document.getElementById('toggle-cam-btn');
    const shareScreenBtn = document.getElementById('share-screen-btn');
    
    if (startVoiceBtn) {
        startVoiceBtn.addEventListener('click', () => startCall('voice'));
    }
    if (startVideoBtn) {
        startVideoBtn.addEventListener('click', () => startCall('video'));
    }
    if (acceptCallBtn) {
        acceptCallBtn.addEventListener('click', acceptCall);
    }
    if (declineCallBtn) {
        declineCallBtn.addEventListener('click', rejectCall);
    }
    if (endCallBtn) {
        endCallBtn.addEventListener('click', () => endCall(true));
    }
    if (toggleMicBtn) {
        toggleMicBtn.addEventListener('click', toggleMic);
    }
    if (toggleCamBtn) {
        toggleCamBtn.addEventListener('click', toggleCam);
    }
    if (shareScreenBtn) {
        shareScreenBtn.addEventListener('click', () => {
            if (screenStream) {
                stopScreenShare();
            } else {
                shareScreen();
            }
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCallEventListeners);
} else {
    initCallEventListeners();
}

// Initialize WebRTC and sockets on page load
connectWebSocket();
markAllActiveMessagesAsRead();
window.addEventListener('focus', markAllActiveMessagesAsRead);

