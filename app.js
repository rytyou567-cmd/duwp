import CryptoUtils from './crypto.js';

// --- LOGGING REDIRECTION ---
// Explicitly attached to window for cross-module/cross-context access
window.NexusLog = function (prefix, msg, type = 'info') {
    const targetWin = window.callWindow;

    // MIRRORING STRATEGY: 
    // If the window exists but isn't confirmed "ready" by the handshake,
    // we send to the bridge BUT ALSO fall through to the main console.
    let redirected = false;
    if (targetWin && !targetWin.closed) {
        try {
            targetWin.postMessage({
                type: 'POST_LOG',
                data: { msg: `[${prefix}] ${msg}`, type }
            }, '*');
            redirected = true;
        } catch (e) { }
    }

    // Only stop here if we are SURE the bridge is ready and handling it
    if (redirected && window.isCallWindowReady) return;

    // Default: Main window console
    const styles = {
        CALL: 'color: #00f2ff; font-weight: bold;',
        SIGNAL: 'color: #a855f7; font-weight: bold;',
        MEDIA: 'color: #10b981; font-weight: bold;',
        UI: 'color: #ffaa00; font-weight: bold;',
        GROUP: 'color: #4ade80; font-weight: bold;'
    };
    console.log(`%c[${prefix}] %c${msg}`, styles[prefix] || 'color: inherit', 'color: inherit');
};

// Internal alias for module-level calls
const NexusLog = window.NexusLog;

// --- STATE ---
let peer = null;
let myKeyPair = null;
let myPublicKeyData = null;
let activePeers = new Map(); // id -> { conn, sharedKey, secure, name }
let currentPeerId = null;
let currentGroupId = null;
const messageStore = new Map(); // targetId -> Array of messages

let groups = new Map();
let localNickname = localStorage.getItem('nexus_nickname') || '';
let localStream = null;

// Debug exports
window.Nexus = {
    getGroups: () => groups,
    getPeers: () => activePeers,
    getMe: () => peer.id
};
let localHub = [];
let remoteHub = [];

let editor;
let isRemoteChange = false;
const beamModels = new Map(); // targetId -> monaco model

// Call State
let currentCall = null;
window.callWindow = null; // Ensure global definition

// --- INITIALIZATION ---
async function init() {
    // 1. Identify Secure Context
    const isSecure = window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

    if (!isSecure) {
        document.getElementById('insecure-protocol-overlay').classList.add('active');
        NexusLog('INIT', 'HTTPS Enforcement: Execution halted on insecure origin.', 'error');
        return; // Halt all initialization
    }

    // 2. Core UI & PeerID generation first
    // 2. Security Setup (Hard Enforced)
    try {
        myKeyPair = await CryptoUtils.generateECCKeyPair();
        if (myKeyPair) {
            myPublicKeyData = await CryptoUtils.exportPublicKey(myKeyPair.publicKey);
        }
    } catch (err) {
        NexusLog('CRYPTO', 'FATAL_CRYPTO_ERROR: ' + err, 'error');
        showToast('FATAL ERROR: Encryption engine failed. Neural Link suspended.', 'error');
        // We'll proceed with Peer initialization so the UI stays up, but communications will fail
    }

    // 3. Core UI & PeerID generation last
    initPeer();
    setupEventListeners();
}

function initPeer() {
    const id = generateShortId();
    peer = new Peer(id);

    peer.on('open', (id) => {
        document.getElementById('my-peer-id').textContent = id;

        // Initialize my-name UI with nickname if exists
        if (localNickname) {
            document.getElementById('my-name').textContent = localNickname;
            document.getElementById('my-avatar').textContent = localNickname.charAt(0).toUpperCase();
        }

        showToast('Neural Link Established: ' + id);
    });

    peer.on('connection', (conn) => {
        setupConnection(conn);
    });

    peer.on('call', (call) => {
        handleIncomingCall(call);
    });

    peer.on('error', (err) => {
        NexusLog('PEER', 'Peer Error: ' + err, 'error');
        showToast(`Mesh Error: ${err.type}`, 'error');
    });
}

// Helper to find groups where the target peer is a member (to sync state on handshake)
function getSharedGroups(targetPeerId) {
    const shared = [];
    groups.forEach((g, id) => {
        if (g.members.has(targetPeerId)) {
            shared.push({
                groupId: id,
                name: g.name,
                owner: g.owner,
                admins: Array.from(g.admins),
                members: Array.from(g.members)
            });
        }
    });
    return shared;
}

function syncHandshakeGroups(data, peerId) {
    const p = activePeers.get(peerId);
    if (data.joinedNexus && Array.isArray(data.joinedNexus)) {
        if (p && p.groupsProcessed) return; // Deduplicate

        NexusLog('GROUP', `Handshake Sync: Processing ${data.joinedNexus.length} shared groups`);
        data.joinedNexus.forEach(g => {
            if (!groups.has(g.groupId)) {
                groups.set(g.groupId, {
                    name: g.name,
                    owner: g.owner,
                    admins: new Set(g.admins || []),
                    members: new Set(g.members || [])
                });
                NexusLog('GROUP', `Auto-joined ${g.name} via handshake`);
                showToast(`Nexus Link Established: ${g.name}`, 'info');
            }
        });
        if (p) p.groupsProcessed = true;
    }
}

// --- CONNECTION LOGIC ---
async function setupConnection(conn) {
    const peerId = conn.peer;

    conn.on('open', async () => {
        activePeers.set(peerId, { conn, sharedKey: null, secure: false, nickname: null });

        // Auto-select if it's the first peer
        if (!currentPeerId && !currentGroupId) {
            currentPeerId = peerId;
            document.getElementById('active-peer-name').textContent = peerId;
            document.getElementById('active-peer-status').textContent = 'Establishing link...';
            renderMessages();
        }

        updatePeerList();

        // Start Handshake (Only if our own identity is secure)
        if (!myPublicKeyData) {
            NexusLog('HANDSHAKE', 'HANDSHAKE_HALTED: Our encryption engine is not initialized.', 'error');
            return;
        }

        const timestamp = Date.now();
        const binding = await CryptoUtils.createKeyBinding(peer.id, myPublicKeyData, timestamp);

        // Find groups we share with this peer to auto-sync them
        const sharedGroups = getSharedGroups(peerId);

        conn.send({
            type: 'HANDSHAKE_INIT',
            publicKey: myPublicKeyData,
            peerId: peer.id,
            nickname: localNickname,
            timestamp,
            binding,
            joinedNexus: sharedGroups
        });
    });

    conn.on('data', async (data) => {
        await handleIncomingData(peerId, data);
    });

    conn.on('close', () => {
        activePeers.delete(peerId);
        updatePeerList();

        // Update UI if the disconnected peer is the currently active one
        if (currentPeerId === peerId) {
            document.getElementById('active-peer-status').textContent = 'Offline (Disconnected)';
            document.getElementById('active-peer-status').style.color = 'var(--accent-red, #ff4444)';
            document.getElementById('active-peer-name').style.color = 'var(--text-muted)';
            const input = document.getElementById('message-input');
            input.placeholder = 'Node offline...';
            input.disabled = true;
            document.getElementById('send-btn').disabled = true;

            // If we are in a call with them, show on UI then end after a delay
            if (activeCallState.peerId === peerId) {
                const callStatus = document.getElementById('call-status');
                if (callStatus) {
                    callStatus.textContent = 'Connection Lost...';
                    callStatus.style.color = '#ff4444';
                }
                setTimeout(() => endCall(), 1500);
            }
        }

        showToast(`${peerId} disconnected`, 'info');
    });
}


async function handleIncomingData(peerId, data) {
    const p = activePeers.get(peerId);
    if (!p) return;

    switch (data.type) {
        case 'HANDSHAKE_INIT':
            await handleHandshake(peerId, data);
            break;
        case 'HANDSHAKE_READY':
            p.secure = true;
            if (data.publicKey) p.publicKey = data.publicKey;
            if (data.nickname) p.nickname = data.nickname;
            syncHandshakeGroups(data, peerId); // Process groups from the responder
            showToast(`Secure link with ${p.nickname || peerId} established`);
            if (currentPeerId === peerId) {
                document.getElementById('active-peer-name').textContent = p.nickname || peerId;
            }
            updatePeerList();
            document.getElementById('active-peer-status').textContent = 'End-to-End Encrypted';
            document.getElementById('message-input').focus();
            break;
        case 'MSG':
            if (p.secure && p.sharedKey) {
                const text = await CryptoUtils.decryptChunk(data.payload, p.sharedKey, data.iv);
                addMessage(peerId, peer.id, text, 'received');
            }
            break;
        case 'CALL_OFFER':
        case 'CALL_RINGING':
        case 'CALL_ACCEPT':
        case 'CALL_REJECT':
        case 'CALL_BUSY':
        case 'CALL_END':
        case 'CALL_VIDEO_STATE':
            handleCallSignaling(peerId, data);
            break;
        case 'GROUP_INVITE':
            NexusLog('GROUP', `RECV: GROUP_INVITE for ${data.groupId} from ${peerId}`);
            handleGroupInvite(peerId, data);
            break;
        case 'GROUP_JOIN_REQ':
            NexusLog('GROUP', `RECV: GROUP_JOIN_REQ for ${data.groupId} from ${peerId}`);
            handleGroupJoinReq(peerId, data);
            break;
        case 'GROUP_JOIN_RES':
            NexusLog('GROUP', `RECV: GROUP_JOIN_RES for ${data.groupId} from ${peerId}`);
            handleGroupJoinRes(peerId, data);
            break;
        case 'GROUP_UPDATE':
            NexusLog('GROUP', `RECV: GROUP_UPDATE for ${data.groupId} from ${peerId}`);
            handleGroupUpdate(peerId, data);
            break;
        case 'GROUP_DELETE':
            NexusLog('GROUP', `RECV: GROUP_DELETE for ${data.groupId} from ${peerId}`);
            handleGroupDelete(peerId, data);
            break;
        case 'GROUP_KICK':
            NexusLog('GROUP', `RECV: GROUP_KICK for ${data.groupId} from ${peerId}`);
            handleGroupKick(peerId, data);
            break;
        case 'GROUP_MSG':
            if (p.secure && p.sharedKey) {
                const text = await CryptoUtils.decryptChunk(data.payload, p.sharedKey, data.iv);
                addMessage(peerId, peer.id, text, 'received', data.groupId);
            }
            break;
        case 'HUB_SHARE':
            handleIncomingShare(peerId, data);
            break;
        case 'HUB_RETRACT':
            handleIncomingRetract(peerId, data);
            break;
        case 'BEAM_DELTA':
            handleIncomingBeamDelta(peerId, data);
            break;
        case 'BEAM_SYNC':
            handleIncomingBeamSync(peerId, data);
            break;
        case 'BEAM_SYNC_REQ':
            handleBeamSyncReq(peerId, data);
            break;
    }
}

async function handleBeamSyncReq(peerId, data) {
    const p = activePeers.get(peerId);
    const targetId = data.targetId || peer.id; // If peer requests my local model for 1-to-1
    if (p?.secure && p.sharedKey) {
        const model = beamModels.get(targetId);
        if (model) {
            const content = model.getValue();
            const { encryptedData, iv } = await CryptoUtils.encryptChunk(content, p.sharedKey);
            p.conn.send({ type: 'BEAM_SYNC', targetId, payload: encryptedData, iv });
        }
    }
}

// --- GROUP LOGIC (NEXUS) ---
function createGroup(existingGroupId = null) {
    const modal = document.getElementById('group-modal');
    const overlay = document.getElementById('modal-overlay');
    const list = document.getElementById('peer-selection-list');
    const title = modal.querySelector('h3');
    const nameInput = document.getElementById('group-name-input');

    // Clear old state
    list.innerHTML = '';

    if (existingGroupId) {
        const g = groups.get(existingGroupId);
        title.textContent = `EXPAND ${g.name}`;
        nameInput.value = g.name;
        nameInput.disabled = true;
    } else {
        title.textContent = 'CREATE NEW NEXUS';
        nameInput.value = '';
        nameInput.disabled = false;
    }

    // Populate with active peers NOT already in group
    const currentMembers = existingGroupId ? groups.get(existingGroupId).members : new Set([peer.id]);

    let peerCount = 0;
    activePeers.forEach((p, id) => {
        if (!p.secure || currentMembers.has(id)) return;
        peerCount++;

        const displayName = p.nickname || id;
        const item = document.createElement('div');
        item.className = 'member-item';
        item.style.cursor = 'pointer';
        item.innerHTML = `
            <div class="avatar" style="width: 32px; height: 32px; font-size: 0.8rem; background: var(--chat-bg);">${displayName.charAt(0).toUpperCase()}</div>
            <div style="flex: 1;">
                <div style="font-size: 0.95rem; font-weight: 600;">${displayName}</div>
                <span style="font-size: 0.7rem; color: var(--accent-cyan);">${id}</span>
            </div>
            <input type="checkbox" id="invite-${id}" value="${id}" class="nexus-checkbox" style="width: 18px; height: 18px; cursor: pointer;">
        `;

        item.onclick = (e) => {
            if (e.target.tagName !== 'INPUT') {
                const cb = item.querySelector('input');
                cb.checked = !cb.checked;
            }
        };
        list.appendChild(item);
    });

    if (peerCount === 0) {
        list.innerHTML = `<div style="color:var(--text-dim); text-align:center; padding:20px; font-size: 0.9rem;">${existingGroupId ? 'All active nodes are already in this Nexus' : 'No active secure nodes detected...'}</div>`;
    }

    overlay.classList.add('active');
    modal.classList.add('active');

    document.getElementById('confirm-group-btn').onclick = async () => {
        const selected = Array.from(document.querySelectorAll('.nexus-checkbox:checked')).map(cb => cb.value);
        if (selected.length === 0) {
            closeModals();
            return;
        }

        let groupId, groupName;

        if (existingGroupId) {
            groupId = existingGroupId;
            const g = groups.get(groupId);
            groupName = g.name;
        } else {
            groupName = nameInput.value.trim() || 'Untitled Nexus';
            groupId = 'nexus-' + generateShortId();
            groups.set(groupId, {
                name: groupName,
                members: new Set([peer.id]),
                owner: peer.id,
                admins: new Set([peer.id])
            });
        }

        // Send invites to selected peers
        selected.forEach(pid => {
            const p = activePeers.get(pid);
            if (p?.secure && p.sharedKey) {
                p.conn.send({
                    type: 'GROUP_INVITE',
                    groupId,
                    groupName,
                    ownerId: groups.get(groupId).owner,
                    isCreatorInvite: true // Flag to skip double-confirm on owner side
                });
            }
        });

        closeModals();
        showToast(existingGroupId ? 'Invitations dispatched' : `Nexus "${groupName}" initialized`);
        updateSidebar();
    };
}

async function handleGroupInvite(fromId, data) {
    const { groupId, groupName, ownerId, isCreatorInvite } = data;
    NexusLog('GROUP', `Handling invite for ${groupName} (${groupId}) FROM ${fromId} (Auto: ${!!isCreatorInvite})`);

    // Auto-accept if it's a direct invitation from the creator/admin
    const autoAccept = isCreatorInvite || false;
    const inviterName = activePeers.get(fromId)?.nickname || fromId;

    const proceed = autoAccept || confirm(`You are invited to join "${groupName}" by ${inviterName}. Access Nexus?`);

    if (proceed) {
        const p = activePeers.get(fromId);
        if (p?.secure && p.sharedKey) {
            NexusLog('GROUP', 'Sending GROUP_JOIN_REQ...');
            p.conn.send({
                type: 'GROUP_JOIN_REQ',
                groupId,
                requesterId: peer.id,
                isInviteAccept: isCreatorInvite
            });
            if (autoAccept) {
                showToast(`Nexus Request Sent: ${groupName}`, 'info');
            } else {
                showToast('Acknowledging invite...');
            }
        } else {
            NexusLog('GROUP', 'Insecure or missing connection to inviter', 'error');
            if (!autoAccept) showToast('Secure link required to join Nexus', 'error');
        }
    }
}

async function handleGroupJoinReq(fromId, data) {
    const { groupId, requesterId, isInviteAccept } = data;
    NexusLog('GROUP', `Join Request for ${groupId} from ${requesterId} (via ${fromId})`);
    const g = groups.get(groupId);
    if (!g) {
        NexusLog('GROUP', 'Unknown group ID in join req', 'error');
        return;
    }

    // Check if user is admin or owner
    const isAuthority = g.admins.has(peer.id) || g.owner === peer.id;
    if (!isAuthority) {
        NexusLog('GROUP', 'Non-authority received join req', 'warn');
        return;
    }

    // Auto-approve if we were the ones who invited them
    const requesterName = activePeers.get(requesterId)?.nickname || requesterId;
    const approved = isInviteAccept || confirm(`${requesterName} wants to join "${g.name}". Approve entry?`);

    if (approved) {
        NexusLog('GROUP', `Approving join for ${requesterId}`);
        g.members.add(requesterId);

        // Notify the requester FIRST
        const p = activePeers.get(requesterId) || activePeers.get(fromId);
        if (p?.secure && p.sharedKey) {
            p.conn.send({
                type: 'GROUP_JOIN_RES',
                status: 'approved',
                groupId,
                groupName: g.name,
                ownerId: g.owner,
                adminIds: Array.from(g.admins),
                memberIds: Array.from(g.members)
            });
            NexusLog('GROUP', 'Sent approved response');
        } else {
            NexusLog('GROUP', 'Cannot find secure connection for response', 'error');
        }

        // THEN Sync updated group state to all current members
        broadcastGroupUpdate(groupId);
        showToast(`${requesterId} joined the Nexus`);
    } else {
        const p = activePeers.get(fromId);
        if (p?.secure && p.sharedKey) {
            p.conn.send({ type: 'GROUP_JOIN_RES', status: 'denied', groupId });
        }
    }
}

function handleGroupJoinRes(fromId, data) {
    NexusLog('GROUP', `Received Join Response FROM ${fromId}: ${JSON.stringify(data)}`);
    if (data.status === 'approved') {
        const { groupId, groupName, ownerId, adminIds, memberIds } = data;
        if (!groupId || !groupName) {
            NexusLog('GROUP', 'Invalid data in JOIN_RES', 'error');
            return;
        }

        groups.set(groupId, {
            name: groupName,
            owner: ownerId,
            admins: new Set(adminIds || []),
            members: new Set(memberIds || [peer.id])
        });

        NexusLog('GROUP', `Successfully set group ${groupId}. Total groups: ${groups.size}`);
        showToast(`Secure Nexus Established: ${groupName}`);
        updateSidebar();
    } else {
        NexusLog('GROUP', `Join denied for ${data.groupId}`, 'warn');
        showToast(`Nexus authorization denied by Authority`, 'error');
    }
}

function broadcastGroupUpdate(groupId) {
    const g = groups.get(groupId);
    if (!g) return;

    const payload = {
        type: 'GROUP_UPDATE',
        groupId,
        groupName: g.name,
        members: Array.from(g.members),
        admins: Array.from(g.admins),
        owner: g.owner
    };

    g.members.forEach(mid => {
        if (mid === peer.id) return;
        const p = activePeers.get(mid);
        if (p?.secure && p.sharedKey) {
            p.conn.send(payload);
        }
    });
    updateSidebar();
}

function handleGroupUpdate(fromId, data) {
    const { groupId, groupName, members, admins, owner } = data;
    if (!groupId) return;

    const g = groups.get(groupId);
    const oldMembers = g ? g.members : new Set();
    const incomingMembers = new Set(members || []);

    // Notify if I am newly added
    if (!g && incomingMembers.has(peer.id)) {
        showToast(`Authorized Access: Added to "${groupName || 'Nexus'}"`, 'info');
    }

    // Notify about other new members
    incomingMembers.forEach(mid => {
        if (mid !== peer.id && !oldMembers.has(mid)) {
            showToast(`${mid} joined "${groupName || 'Nexus'}"`, 'info');
        }
    });

    groups.set(groupId, {
        name: groupName || ('Nexus ' + groupId.split('-')[1]),
        members: incomingMembers,
        admins: new Set(admins || []),
        owner: owner
    });

    // Auto-connect to new members if secure
    if (members) {
        members.forEach(mid => {
            if (mid !== peer.id && !activePeers.has(mid)) {
                NexusLog('PEER', 'Nexus discovery: connecting to peer ' + mid);
                const conn = peer.connect(mid);
                setupConnection(conn);
            }
        });
    }
    updateSidebar();
    if (currentGroupId === groupId) renderMessages();
}

function handleGroupKick(fromId, data) {
    const { groupId } = data;
    if (groups.has(groupId)) {
        groups.delete(groupId);
        if (currentGroupId === groupId) {
            currentGroupId = null;
            document.getElementById('active-peer-name').textContent = 'Access Revoked';
        }
        showToast('You have been removed from the Nexus by an admin', 'error');
        updateSidebar();
        renderMessages();
    }
}

function handleGroupDelete(fromId, data) {
    const { groupId } = data;
    if (groups.has(groupId)) {
        groups.delete(groupId);
        if (currentGroupId === groupId) {
            currentGroupId = null;
            document.getElementById('active-peer-name').textContent = 'Transmission Interrupted';
        }
        showToast('Nexus has been dissolved by the creator', 'warning');
        updateSidebar();
        renderMessages();
    }
}

function broadcastGroupMessage(groupId, text) {
    const group = groups.get(groupId);
    if (!group) return;

    group.members.forEach(async (memberId) => {
        if (memberId === peer.id) return;
        const p = activePeers.get(memberId);
        if (p?.secure && p.sharedKey) {
            const { encryptedData, iv } = await CryptoUtils.encryptChunk(text, p.sharedKey);
            p.conn.send({ type: 'GROUP_MSG', payload: encryptedData, iv, groupId });
        }
    });
}

// Administrative Actions
window.promoteMember = (groupId, peerId) => {
    const g = groups.get(groupId);
    if (!g || g.owner !== peer.id) return;

    g.admins.add(peerId);
    broadcastGroupUpdate(groupId);
    showToast(`${peerId} promoted to Admin`);
    openNexusSettings(groupId);
};

window.leaveGroup = (groupId) => {
    if (!confirm('Leave this Nexus?')) return;
    const g = groups.get(groupId);
    if (!g) return;

    g.members.delete(peer.id);
    broadcastGroupUpdate(groupId);
    groups.delete(groupId);
    if (currentGroupId === groupId) currentGroupId = null;
    closeModals();
    updateSidebar();
    renderMessages();
    showToast('You left the Nexus');
};

window.deleteGroup = (groupId) => {
    if (!confirm('Nuke this Nexus? All members will be disconnected.')) return;
    const g = groups.get(groupId);
    if (!g) return;

    // Only creator/admin can delete
    if (!g.admins.has(peer.id) && g.owner !== peer.id) {
        showToast('Insufficient authority', 'error');
        return;
    }

    const payload = { type: 'GROUP_DELETE', groupId };
    g.members.forEach(mid => {
        if (mid === peer.id) return;
        const p = activePeers.get(mid);
        if (p?.secure && p.sharedKey) {
            p.conn.send(payload);
        }
    });

    groups.delete(groupId);
    if (currentGroupId === groupId) currentGroupId = null;
    closeModals();
    updateSidebar();
    renderMessages();
    showToast('Nexus Dissolved');
};

// Nexus Settings Modal Actions
window.kickMember = (groupId, peerId) => {
    const g = groups.get(groupId);
    if (!g) return;

    if (!confirm(`Are you sure you want to remove ${peerId} from the group?`)) return;

    const p = activePeers.get(peerId);
    if (p?.secure && p.sharedKey) {
        p.conn.send({ type: 'GROUP_KICK', groupId });
    }

    g.members.delete(peerId);
    g.admins.delete(peerId);
    broadcastGroupUpdate(groupId);
    showToast(`${peerId} removed from Nexus`);
    openNexusSettings(groupId);
};

window.openNexusSettings = (groupId) => {
    const g = groups.get(groupId);
    if (!g) return;

    const modal = document.getElementById('member-modal');
    const overlay = document.getElementById('modal-overlay');
    const list = document.getElementById('group-member-list');
    const title = document.getElementById('member-modal-title');
    const deleteBtn = document.getElementById('delete-group-btn');
    const leaveBtn = document.getElementById('leave-group-btn');
    const inviteMoreBtn = document.getElementById('invite-more-btn');
    const copyIdBtn = document.getElementById('copy-nexus-id-btn');

    const myId = peer.id;
    const isMeOwner = g.owner === myId;
    const isMeAdmin = g.admins.has(myId);

    title.textContent = g.name.toUpperCase();
    list.innerHTML = '';

    g.members.forEach(mid => {
        const isOwner = mid === g.owner;
        const isAdmin = g.admins.has(mid);
        const isMe = mid === myId;

        const p = activePeers.get(mid);
        const displayName = isMe ? (localNickname || 'You') : (p?.nickname || mid);

        const item = document.createElement('div');
        item.className = 'member-item';

        const roleClass = isOwner ? 'role-owner' : (isAdmin ? 'role-admin' : 'role-member');
        const roleLabel = isOwner ? 'Owner' : (isAdmin ? 'Admin' : 'Member');

        const canPromote = isMeOwner && !isAdmin && !isMe;
        const canKick = !isOwner && !isMe && (isMeOwner || (isMeAdmin && !isAdmin));

        item.innerHTML = `
            <div class="avatar" style="width: 32px; height: 32px; font-size: 0.8rem; background: var(--chat-bg);">${displayName.charAt(0).toUpperCase()}</div>
            <div style="flex: 1;">
                <div style="font-size: 0.95rem; font-weight: 600;">${displayName}${isMe && localNickname ? ' (You)' : ''}</div>
                <span class="member-role-badge ${roleClass}">${roleLabel}</span> ${!isMe ? `<small style="color:var(--text-dim); font-size: 0.65rem; margin-left: 5px;">${mid}</small>` : ''}
            </div>
            <div class="member-actions">
                ${canPromote ? `<div class="action-dot promote" onclick="promoteMember('${groupId}', '${mid}')" title="Appoint Admin">⚡</div>` : ''}
                ${canKick ? `<div class="action-dot retract" onclick="kickMember('${groupId}', '${mid}')" title="Kick Node">✕</div>` : ''}
            </div>
        `;
        list.appendChild(item);
    });

    // Control button visibility
    deleteBtn.style.display = isMeOwner ? 'block' : 'none';
    inviteMoreBtn.style.display = 'block';

    copyIdBtn.onclick = () => {
        const inviteString = `${groupId} gateway:${peer.id}`;
        navigator.clipboard.writeText(inviteString);
        showToast('Nexus ID & Gateway Link copied');
    };

    inviteMoreBtn.onclick = () => {
        closeModals();
        createGroup(groupId);
    };

    deleteBtn.onclick = () => deleteGroup(groupId);
    leaveBtn.onclick = () => leaveGroup(groupId);

    overlay.classList.add('active');
    modal.classList.add('active');
};

function renderHeaderDropdown() {
    const list = document.getElementById('header-member-list');
    const title = document.querySelector('#header-member-dropdown h4');
    if (!list || !title) return;
    list.innerHTML = '';

    if (currentGroupId) {
        title.textContent = 'Nexus Members';
        const g = groups.get(currentGroupId);
        if (g) {
            // Sort: Owner first, then Admins, then Members
            const sortedMembers = Array.from(g.members).sort((a, b) => {
                if (a === g.owner) return -1;
                if (b === g.owner) return 1;
                const aAdmin = g.admins.has(a);
                const bAdmin = g.admins.has(b);
                if (aAdmin && !bAdmin) return -1;
                if (!aAdmin && bAdmin) return 1;
                return a.localeCompare(b);
            });

            sortedMembers.forEach(mid => {
                const item = document.createElement('div');
                item.className = 'dropdown-member-item';

                const isOwner = g.owner === mid;
                const isAdmin = g.admins.has(mid);
                const roleClass = isOwner ? 'role-owner' : (isAdmin ? 'role-admin' : 'role-member');
                const roleText = isOwner ? 'Owner' : (isAdmin ? 'Admin' : 'Member');

                const p = activePeers.get(mid);
                const displayName = mid === peer.id ? (localNickname || mid) : (p?.nickname || mid);

                item.innerHTML = `
                    <div class="avatar" style="background: var(--chat-bg); color: var(--accent-cyan); border: 1px solid rgba(255,255,255,0.1); font-weight: bold; display: flex; align-items: center; justify-content: center; border-radius: 50%;">${displayName.charAt(0).toUpperCase()}</div>
                    <div style="flex:1">
                        <div class="name">${mid === peer.id ? displayName + ' (You)' : displayName}</div>
                        <div style="display: flex; align-items: center; gap: 5px; margin-top: 2px;">
                            <span class="member-role-badge ${roleClass}" style="font-size: 8px; padding: 2px 5px; height: auto; border-radius: 4px;">${roleText}</span>
                            <span style="font-size: 0.65rem; color: var(--text-dim);">${mid}</span>
                        </div>
                    </div>
                `;
                list.appendChild(item);
            });
        }
    } else if (currentPeerId) {
        title.textContent = 'Peer Node Detail';
        const p = activePeers.get(currentPeerId);
        list.innerHTML = `
            <div class="dropdown-member-item" style="flex-direction: column; align-items: flex-start; gap: 8px; padding: 12px;">
                <div style="display: flex; align-items: center; gap: 10px; width: 100%;">
                    <div class="avatar" style="background: var(--chat-bg); color: var(--accent-cyan); border: 1px solid rgba(255,255,255,0.1); font-weight: bold; display: flex; align-items: center; justify-content: center; border-radius: 50%; width: 36px; height: 36px;">${(p?.nickname || currentPeerId).charAt(0).toUpperCase()}</div>
                    <div style="flex:1">
                        <div class="name" style="word-break: break-all; font-size: 0.95rem; font-weight: 600;">${p?.nickname || currentPeerId}</div>
                        <div style="font-size: 0.7rem; color: var(--text-dim);">${currentPeerId}</div>
                    </div>
                </div>
                
                <div style="display: flex; gap: 8px; width: 100%; margin-top: 5px;">
                    <button onclick="navigator.clipboard.writeText('${currentPeerId}'); showToast('Peer ID Copied')" 
                            style="flex: 1; background: rgba(0, 242, 255, 0.05); border: 1px solid rgba(0, 242, 255, 0.1); color: var(--accent-cyan); padding: 8px; border-radius: 8px; font-size: 0.75rem; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
                        Copy Peer ID
                    </button>
                </div>

                <div style="margin-top: 10px; width: 100%; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.05);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                        <span style="font-size: 0.7rem; color: var(--text-dim);">Status</span>
                        <span style="font-size: 0.7rem; color: var(--accent-cyan); font-weight: bold;">CONNECTED</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-size: 0.7rem; color: var(--text-dim);">Security</span>
                        <span style="font-size: 0.7rem; color: var(--accent-cyan);">${p?.secure ? 'E2EE SECURE' : 'UNSECURED'}</span>
                    </div>
                </div>
            </div>
        `;
    }
    else {
        title.textContent = 'System Status';
        list.innerHTML = `
            <div class="dropdown-member-item">
                <div class="avatar" style="background: var(--chat-bg); color: var(--accent-cyan); border: 1px solid rgba(255,255,255,0.1); font-weight: bold; display: flex; align-items: center; justify-content: center; border-radius: 50%;">S</div>
                <div style="flex:1">
                    <div class="name">Nebula Protocol</div>
                    <span class="member-role-badge role-member" style="font-size: 8px; padding: 2px 5px; height: auto; border-radius: 4px; color: var(--accent-cyan); background: rgba(0, 242, 255, 0.1);">ACTIVE</span>
                </div>
            </div>
        `;
    }
}

// Wire up the header click toggle
document.getElementById('chat-header-info').onclick = (e) => {
    e.stopPropagation();
    const dropdown = document.getElementById('header-member-dropdown');
    const isActive = dropdown.classList.contains('active');

    // Close other potential dropdowns/modals
    document.querySelectorAll('.header-dropdown').forEach(d => d.classList.remove('active'));

    if (!isActive) {
        renderHeaderDropdown();
        dropdown.classList.add('active');
    }
};

// Global click to close dropdowns
document.addEventListener('click', (e) => {
    if (!e.target.closest('#chat-header-info')) {
        document.getElementById('header-member-dropdown')?.classList.remove('active');
    }
});

// Initialization signal moved to call.html to ensure execution order

async function handleHandshake(peerId, data) {
    const p = activePeers.get(peerId);
    if (!p) return;

    // Hard Security: Guard against uninitialized local node
    if (!myKeyPair || !myPublicKeyData) {
        NexusLog('HANDSHAKE', 'HANDSHAKE_REJECTED: Our encryption engine is not initialized.', 'error');
        p.conn.close();
        return;
    }

    // Verify peer's identity binding
    const isValid = await CryptoUtils.verifyKeyBinding(data.peerId, data.publicKey, data.timestamp, data.binding);
    if (!isValid) {
        NexusLog('HANDSHAKE', 'MITM Detect: Invalid key binding from ' + peerId, 'error');
        p.conn.close();
        return;
    }

    try {
        const peerPubKey = await CryptoUtils.importPublicKey(data.publicKey);
        p.sharedKey = await CryptoUtils.deriveEncryptionKey(myKeyPair.privateKey, peerPubKey);
        p.publicKey = data.publicKey;

        // Process any group memberships sent in handshake
        syncHandshakeGroups(data, peerId);

        // Store remote nickname
        if (data.nickname) p.nickname = data.nickname;

        // Responder Path: If we receive an INIT, we must reply with our own identity
        if (data.type === 'HANDSHAKE_INIT') {
            const timestamp = Date.now();
            const binding = await CryptoUtils.createKeyBinding(peer.id, myPublicKeyData, timestamp);
            const sharedGroups = getSharedGroups(peerId);

            p.conn.send({
                type: 'HANDSHAKE_READY',
                publicKey: myPublicKeyData,
                peerId: peer.id,
                timestamp,
                binding,
                joinedNexus: sharedGroups,
                nickname: localNickname
            });
        }

        p.secure = true;
        showToast(`Secure link with ${p.nickname || peerId} established`);
        if (currentPeerId === peerId) {
            document.getElementById('active-peer-status').textContent = 'End-to-End Encrypted';
            updatePeerList();
        }
    } catch (err) {
        NexusLog('HANDSHAKE', 'HANDSHAKE_FAILED: ' + err.message, 'error');
        p.conn.close();
        showToast('Secure Handshake Failed: Integrity mismatch', 'error');
    }
}

// --- MESSAGING ---
async function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text) return;

    if (currentGroupId) {
        broadcastGroupMessage(currentGroupId, text);
        addMessage(peer.id, null, text, 'sent', currentGroupId);
        input.value = '';
        return;
    }

    if (!currentPeerId) {
        showToast('Select a peer or group to start chatting', 'warning');
        return;
    }

    const p = activePeers.get(currentPeerId);
    if (p && p.secure && p.sharedKey) {
        try {
            const { encryptedData, iv } = await CryptoUtils.encryptChunk(text, p.sharedKey);
            p.conn.send({ type: 'MSG', payload: encryptedData, iv });
            addMessage(peer.id, currentPeerId, text, 'sent');
            input.value = '';
        } catch (err) {
            NexusLog('MESSAGE', 'Encryption failure: ' + err, 'error');
            showToast('Encryption failure', 'error');
        }
    } else {
        showToast('Establishing secure link...', 'warning');
    }
}

function addMessage(from, to, text, type, groupId = null) {
    const targetId = groupId || (type === 'sent' ? to : from);
    const msg = { from, to, text, time: new Date().toLocaleTimeString(), type, groupId };

    if (!messageStore.has(targetId)) {
        messageStore.set(targetId, []);
    }
    messageStore.get(targetId).push(msg);

    // If this is the active conversation, append to UI immediately
    if (targetId === (currentGroupId || currentPeerId)) {
        appendMessageToUI(msg);
    }
}

function appendMessageToUI(m) {
    const container = document.getElementById('messages-container');
    if (!container) return;

    const div = document.createElement('div');
    div.className = `message ${m.type}`;

    let fromDisplayName = m.from;
    if (m.type === 'received') {
        const p = activePeers.get(m.from);
        if (p?.nickname) fromDisplayName = p.nickname;
    }

    div.innerHTML = `
        ${m.groupId && m.type === 'received' ? `<small style="color: var(--accent-cyan); display: block; margin-bottom: 5px;">${fromDisplayName}</small>` : ''}
        <div class="text">${escapeHtml(m.text)}</div>
        <small style="font-size: 0.7rem; opacity: 0.5; display: block; margin-top: 5px;">${m.time}</small>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

// --- CALLING (DIALER SYSTEM) ---
let activeCallState = {
    peerId: null,
    status: 'idle', // 'idle', 'calling', 'ringing', 'active'
    direction: null, // 'inbound', 'outbound'
    isAudioOnly: true
};

async function startCall(video = false) { // Default to audio-only as requested
    NexusLog('CALL', `Step 1: Initiating ${video ? 'Video' : 'Audio'} call to: ${currentPeerId}`);
    if (!currentPeerId) {
        showToast('Select a peer to call', 'warning');
        return;
    }
    const p = activePeers.get(currentPeerId);
    if (!p || !p.secure) {
        NexusLog('CALL', 'Step 1.1: Verification FAILED - Secure link required.', 'error');
        showToast('Secure link required for calls', 'error');
        return;
    }

    if (activeCallState.status !== 'idle') {
        NexusLog('CALL', `Step 1.1: Verification FAILED - State is [${activeCallState.status}]. Ignoring startCall.`, 'warn');
        showToast('You are already in a call.', 'warning');
        return;
    }

    activeCallState = {
        peerId: currentPeerId,
        status: 'calling',
        direction: 'outbound',
        isAudioOnly: !video,
        uiFinalized: false,
        localVideoActive: false,
        remoteVideoActive: video
    };
    if (p.fingerprint) activeCallState.fingerprint = p.fingerprint;

    NexusLog('CALL', 'Step 2: Transitioned state to [calling]. Preparing Popup Context.');
    document.getElementById('outgoing-call-overlay').classList.add('active');

    // Synchronous Tab Opening
    if (!window.callWindow || window.callWindow.closed) {
        NexusLog('CALL', 'Step 3: Opening call window popup (window.open)');
        isCallWindowReady = false;
        window.callWindow = window.open('call.html', '_blank');

        if (!window.callWindow) {
            NexusLog('CALL', 'FATAL: Popup was blocked by browser. Please allow popups.', 'error');
            showToast('Popup blocked! Please allow popups for calls.', 'error');
            return;
        }
        NexusLog('CALL', 'Step 3.1: window.open executed. Bridge initialized.');
    } else {
        NexusLog('CALL', 'Step 3: Reusing existing call window.');
    }

    playRingtone('dialing');

    NexusLog('CALL', 'Step 4: Sending CALL_OFFER signal to peer.');
    p.conn.send({
        type: 'CALL_OFFER',
        video: video
    });
}

async function handleCallSignaling(peerId, data) {
    const p = activePeers.get(peerId);
    if (!p) return;

    NexusLog('SIGNAL', `Incoming ${data.type} from ${peerId}`);

    switch (data.type) {
        case 'CALL_OFFER':
            if (activeCallState.status !== 'idle') {
                NexusLog('SIGNAL', 'Busy, rejecting incoming offer', 'warn');
                p.conn.send({ type: 'CALL_BUSY' });
                return;
            }
            activeCallState = {
                peerId: peerId,
                status: 'ringing',
                direction: 'inbound',
                isAudioOnly: !data.video,
                uiFinalized: false,
                localVideoActive: false,
                remoteVideoActive: data.video
            };
            // Send Ringing Signal
            p.conn.send({ type: 'CALL_RINGING' });
            playRingtone('ringing');

            // Show Incoming UI
            document.getElementById('incoming-caller-avatar').textContent = (p.nickname || peerId).charAt(0).toUpperCase();
            document.getElementById('incoming-caller-name').textContent = p.nickname || peerId;
            document.getElementById('incoming-call-type').textContent = `Incoming ${data.video ? 'Video' : 'Audio'} Link...`;
            document.getElementById('incoming-call-overlay').classList.add('active');

            if (p.fingerprint) activeCallState.fingerprint = p.fingerprint;
            break;

        case 'CALL_READY':
            NexusLog('SIGNAL', `Step 1: Received CALL_READY (Handshake peer-side verified) from ${peerId}`);
            activeCallState.remoteReady = true;
            if (activeCallState.localReady) {
                NexusLog('SIGNAL', 'Step 2: Local and Remote are both READY. Finalizing UI.');
                finalizeCallUI();
            } else {
                NexusLog('SIGNAL', 'Step 2: Remote is READY, awaiting local readiness signal.');
            }
            break;

        case 'CALL_MUTE_STATE':
            NexusLog('SIGNAL', `Peer ${peerId} mute state: ${data.isMuted}`);
            if (window.callWindow && !window.callWindow.closed) {
                const ind = window.callWindow.document.getElementById('remote-mute-indicator');
                if (ind) ind.classList.toggle('hidden', !data.isMuted);
            }
            break;

        case 'CALL_RINGING':
            NexusLog('SIGNAL', `Step 1: Received CALL_RINGING signal from ${peerId}`);
            if (activeCallState.status === 'calling' && activeCallState.peerId === peerId) {
                NexusLog('SIGNAL', 'Step 2: Transitioned state to [Ringing]. Updating UI.');
                document.getElementById('outgoing-call-status').textContent = `Ringing...`;
            }
            break;

        case 'CALL_ACCEPT':
            NexusLog('SIGNAL', `Step 1.1: Received CALL_ACCEPT from ${peerId}`);
            if (activeCallState.status === 'calling' && activeCallState.peerId === peerId) {
                NexusLog('SIGNAL', 'Step 1.2: Valid Outgoing Call accepted. Transitioning UI.');
                activeCallState.status = 'active';
                document.getElementById('outgoing-call-overlay').classList.remove('active');
                NexusLog('SIGNAL', 'Step 1.3: Outgoing call UI hidden. Initiating media stream.');
                initiateMediaStream(peerId, !activeCallState.isAudioOnly);
            } else {
                NexusLog('SIGNAL', `Step 1.2: CALL_ACCEPT received from ${peerId} but not in 'calling' state for this peer. Current state: ${activeCallState.status}. Ignoring.`, 'warn');
            }
            break;

        case 'CALL_REJECT':
        case 'CALL_BUSY':
            NexusLog('SIGNAL', `Step 1.1: Received ${data.type} from ${peerId}.`);
            if (activeCallState.peerId === peerId) {
                NexusLog('SIGNAL', `Step 1.2: Call failed: ${data.type}. Ending call.`);
                showToast(data.type === 'CALL_BUSY' ? 'User is busy' : 'Call declined', 'error');
                endCall(false);
            } else {
                NexusLog('SIGNAL', `Step 1.2: ${data.type} received from ${peerId} but not for the active call. Ignoring.`, 'warn');
            }
            break;

        case 'CALL_END':
            NexusLog('SIGNAL', `Step 1.1: Received CALL_END signal from ${peerId}.`);
            if (activeCallState.peerId === peerId) {
                NexusLog('SIGNAL', 'Step 1.2: Call termination signal for active call. Ending call locally.');
                endCall(false);
            } else {
                NexusLog('SIGNAL', `Step 1.2: CALL_END received from ${peerId} but not for the active call. Ignoring.`, 'warn');
            }
            break;

        case 'CALL_VIDEO_STATE':
            NexusLog('SIGNAL', `Step 1.1: Received CALL_VIDEO_STATE from ${peerId}: hasVideo=${data.hasVideo}.`);
            if (activeCallState.peerId === peerId) {
                activeCallState.remoteVideoActive = !!data.hasVideo;
                const win = await waitForCallWindow();
                if (win) updateCallLayout(peerId, null, win.document);
            }
            break;
    }
}

let callWindowReadyResolver = null;
let isCallWindowReady = false;

// Message Listener for Call Handshake
window.addEventListener('message', (event) => {
    // Relaxed origin check for local context parity
    if (event.origin !== window.location.origin && event.origin !== 'null') {
        // console.warn('Blocked message from unknown origin:', event.origin);
        return;
    }

    if (event.data.type === 'UI_READY') {
        const popup = event.source;
        window.callWindow = popup;
        isCallWindowReady = true;

        NexusLog('CALL', 'Step 2: Received UI_READY via message event. Triggering POST_INIT.');

        const targetPeer = activePeers.get(activeCallState.peerId);

        // Sanitize state to avoid DataCloneError with MediaStreams
        const sanitizedState = { ...activeCallState };
        delete sanitizedState.localStream;
        delete sanitizedState.remoteStream;

        popup.postMessage({
            type: 'POST_INIT',
            data: {
                peerId: activeCallState.peerId,
                nickname: targetPeer?.nickname || activeCallState.peerId,
                initialState: sanitizedState
            }
        }, '*');

        // Provision security fingerprint
        if (activeCallState.fingerprint) {
            const fpEl = popup.document.getElementById('fingerprint-display');
            if (fpEl) fpEl.textContent = activeCallState.fingerprint;
        }
    }
});

window.onCallWindowLoaded = (popup) => {
    window.callWindow = popup; // Set immediately to enable logging bridge
    isCallWindowReady = true; // Fallback: Assume ready if DOM loaded hook fires
    NexusLog('CALL', 'Step 4: Popup window.opener hook executed. Bridge available.');

    // Fallback: If UI_READY message was missed, initialize anyway
    setTimeout(() => {
        if (activeCallState.peerId) {
            NexusLog('CALL', 'Step 5: Firing POST_INIT fallback from opener hook.');
            const targetPeer = activePeers.get(activeCallState.peerId);

            // Sanitize state to avoid DataCloneError with MediaStreams
            const sanitizedState = { ...activeCallState };
            delete sanitizedState.localStream;
            delete sanitizedState.remoteStream;

            popup.postMessage({
                type: 'POST_INIT',
                data: {
                    peerId: activeCallState.peerId,
                    nickname: targetPeer?.nickname || activeCallState.peerId,
                    initialState: sanitizedState
                }
            }, '*');
        }
    }, 500); // Give popup scripts a moment to attach listeners
};

window.onCallUIReady = (popup) => {
    NexusLog('CALL', 'CallUI initialized and ready');
    isCallWindowReady = true;

    if (callWindowReadyResolver) {
        callWindowReadyResolver(popup);
        callWindowReadyResolver = null;
    }

    // Trigger any pending layout update
    if (activeCallState.peerId) {
        updateCallLayout(activeCallState.peerId);
    }
};

window.onCallWindowClosed = () => {
    callWindow = null;
    isCallWindowReady = false;
    endCall(false);
};

function finalizeCallUI() {
    if (activeCallState.uiFinalized) return;
    NexusLog('UI', 'Finalizing call UI - Transitioning to active state');

    if (callWindow && !callWindow.closed) {
        const status = callWindow.document.getElementById('call-status');
        if (status) {
            status.textContent = activeCallState.isAudioOnly ? "Secure Audio Link" : "Secure Neural Link";
            status.style.opacity = '1';
            setTimeout(() => {
                status.style.opacity = '0.5';
            }, 3000);
        }
        activeCallState.uiFinalized = true;
    }
}


async function waitForCallWindow() {
    if (callWindow && !callWindow.closed && isCallWindowReady) {
        return callWindow;
    }
    return new Promise(resolve => {
        callWindowReadyResolver = resolve;
    });
}

async function optimizeTrackQuality(track, type = 'camera') {
    if (!track || track.kind !== 'video') return;

    // 1. Set Content Hint for specialized encoding
    if ('contentHint' in track) {
        track.contentHint = (type === 'screen') ? 'detail' : 'motion';
    }

    // 2. Adjust Bitrate if sender exists
    if (currentCall && currentCall.peerConnection) {
        const senders = currentCall.peerConnection.getSenders();
        const sender = senders.find(s => s.track === track);
        if (sender && sender.getParameters) {
            try {
                const parameters = sender.getParameters();
                if (!parameters.encodings) parameters.encodings = [{}];

                // Target: 5Mbps for screen, 2Mbps for camera
                parameters.encodings[0].maxBitrate = (type === 'screen') ? 5000000 : 2000000;
                await sender.setParameters(parameters);
            } catch (e) {
                NexusLog('MEDIA', `Bitrate optimization failed: ${e}`, 'warn');
            }
        }
    }
}

async function updateCallLayout(peerId) {
    const popup = window.callWindow;
    if (popup && !popup.closed) {
        NexusLog('UI', `Syncing state to Call Window via Message Bridge (Peer: ${peerId})`);

        // Remove non-clonable MediaStream objects from the state
        const sanitizedState = { ...activeCallState };
        delete sanitizedState.localStream;
        delete sanitizedState.remoteStream;

        try {
            popup.postMessage({
                type: 'POST_UPDATE',
                data: {
                    activeCallState: sanitizedState
                }
            }, '*');
        } catch (e) {
            NexusLog('UI', `Failed to sync state via POST_UPDATE: ${e}`, 'warn');
        }
    } else {
        NexusLog('UI', 'Cannot update layout: CallUI not ready', 'warn');
    }
}

function createBlackVideoTrack() {
    const canvas = document.createElement('canvas');
    canvas.width = 1280; // Higher res black track for easier swap
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(1);
    const track = stream.getVideoTracks()[0];
    track.enabled = false;
    return track;
}

async function initiateMediaStream(targetPeerId, video) {
    NexusLog('MEDIA', `Initiating media stream flow for peer: ${targetPeerId} (Video Requested: ${video})`);
    const popup = await waitForCallWindow();
    const isVideo = video;

    try {
        const constraints = { video: isVideo, audio: true };
        NexusLog('MEDIA', `Step 1: Requesting user permissions (Video: ${isVideo}, Audio: true) via popup navigator`);
        localStream = await popup.navigator.mediaDevices.getUserMedia(constraints);
        NexusLog('MEDIA', 'Step 2: Permissions granted successfully. Local stream acquired.');

        // If audio-only, we didn't request video tracks, so we don't need to disable them.
        if (activeCallState.isAudioOnly && localStream.getVideoTracks().length > 0) {
            NexusLog('MEDIA', 'Audio-only mode active: Disabling local video tracks.');
            localStream.getVideoTracks().forEach(t => {
                t.enabled = false;
                NexusLog('MEDIA', `Disabled track: ${t.label}`);
            });
        }

        if (activeCallState.status === 'idle') {
            NexusLog('MEDIA', 'Call aborted during permission flow. Cleaning up tracks.');
            localStream.getTracks().forEach(t => t.stop());
            popup.close();
            return;
        }
    } catch (err) {
        NexusLog('MEDIA', `Initial media access error: ${err}. Attempting fallback to audio-only.`, 'warn');
        try {
            const audioStream = await popup.navigator.mediaDevices.getUserMedia({ audio: true });
            NexusLog('MEDIA', 'Fallback: Audio-only permissions granted.');
            const blackTrack = createBlackVideoTrack();
            audioStream.addTrack(blackTrack);
            localStream = audioStream;
            showToast('Camera access blocked.', 'warning');
        } catch (e2) {
            NexusLog('MEDIA', `Total media denial: ${e2}`, 'error');
            if (popup.showPermissionOverlay) {
                popup.showPermissionOverlay("Your microphone is blocked. Please allow access in browser settings and retry.");
            }
            showToast('Media access denied.', 'error');
            endCall();
            return;
        }
    }

    const localVid = popup.document.getElementById('local-video');
    if (localVid) {
        localVid.srcObject = localStream;
        localVid.style.display = isVideo && localStream.getVideoTracks().length > 0 ? 'block' : 'none';
        localVid.muted = true;
    }

    const visualizerCanvas = popup.document.getElementById('volume-visualizer');
    if (visualizerCanvas && localStream.getAudioTracks().length > 0) {
        NexusLog('MEDIA', 'Initializing volume visualizer on popup canvas.');
        setupVolumeAnalyzer(localStream, visualizerCanvas);
    }

    NexusLog('MEDIA', 'Step 3: Establishing P2P Media Connection via PeerJS');
    const callTimestamp = Date.now();
    let callToken = "unencrypted";
    if (myPublicKeyData) {
        callToken = await CryptoUtils.createKeyBinding(peer.id, myPublicKeyData, callTimestamp);
    }
    const call = peer.call(targetPeerId, localStream, {
        metadata: { video: isVideo, secureToken: callToken, timestamp: callTimestamp }
    });

    NexusLog('MEDIA', `Outbound call object created (ID: ${call.connectionId})`);
    setupCallHandlers(call);
    attachCallWindowListeners(popup);

    // The popup UI will now update based on POST_UPDATE messages
    // popup.document.getElementById('call-status').textContent = isVideo ? 'Video Call' : 'Audio Call';
    document.getElementById('outgoing-call-overlay').classList.remove('active');
    updateCallLayout(targetPeerId); // Sync state to popup
}

let pendingIncomingCall = null;

async function handleIncomingCall(call) {
    NexusLog('MEDIA', `Step 1: Received incoming call offer from: ${call.peer}`);
    if (!call.options || !call.options.metadata || !call.options.metadata.secureToken) {
        NexusLog('MEDIA', 'FATAL: Rejected stream: Missing encryption metadata.', 'error');
        call.close();
        return;
    }

    const secureToken = call.options.metadata.secureToken;
    const callTimestamp = call.options.metadata.timestamp;
    const callerPeer = activePeers.get(call.peer);

    if (!callerPeer || !callerPeer.secure || !callerPeer.publicKey) {
        NexusLog('MEDIA', 'FATAL: Rejected stream: Caller is not trusted or link not secure.', 'error');
        call.close();
        return;
    }

    NexusLog('MEDIA', 'Step 2: Verifying cryptographic signature of the call token...');
    const isValidCall = await CryptoUtils.verifyKeyBinding(call.peer, callerPeer.publicKey, callTimestamp, secureToken);
    if (!isValidCall || secureToken === "unencrypted") {
        NexusLog('MEDIA', 'FATAL: Rejected stream: Signature verification FAILED. MITM potential.', 'error');
        showToast('Blocked unauthorized media stream.', 'error');
        call.close();
        return;
    }
    NexusLog('MEDIA', 'Step 3: Call signature verified. Proceeding to answer.');

    if (activeCallState.status === 'active' && activeCallState.peerId === call.peer) {
        NexusLog('MEDIA', 'Answering call - Awaiting call window availability...');
        const popup = await waitForCallWindow();
        NexusLog('MEDIA', 'Call window available. Requesting user permissions for answer.');

        try {
            const incomingIsVideo = call.options.metadata && call.options.metadata.video;
            const constraints = { video: incomingIsVideo, audio: true };
            NexusLog('MEDIA', `Requesting permissions for answer (Video: ${incomingIsVideo}, Audio: true)`);
            localStream = await popup.navigator.mediaDevices.getUserMedia(constraints);
            NexusLog('MEDIA', `Permissions granted for answer (Audio-only: ${!incomingIsVideo})`);

            if (activeCallState.status === 'idle') {
                NexusLog('MEDIA', 'Call aborted during answer flow. Closing tracks.');
                localStream.getTracks().forEach(t => t.stop());
                popup.close();
                return;
            }
        } catch (err) {
            NexusLog('MEDIA', `Answer media fallback error: ${err}. Trying audio-only fallback.`);
            try {
                const audioStream = await popup.navigator.mediaDevices.getUserMedia({ audio: true });
                NexusLog('MEDIA', 'Fallback: Audio permissions granted for answer.');
                const blackTrack = createBlackVideoTrack();
                audioStream.addTrack(blackTrack);
                localStream = audioStream;
                showToast('Camera access blocked.', 'warning');
            } catch (e2) {
                NexusLog('MEDIA', `Critical answer media failure: ${e2}`, 'error');
                if (popup.showPermissionOverlay) {
                    popup.showPermissionOverlay("Media access denied. Please ensure your camera/mic are not in use by another app.");
                }
                showToast('Media access denied.', 'error');
                endCall();
                return;
            }
        }

        const localVid = popup.document.getElementById('local-video');
        if (localVid) {
            localVid.srcObject = localStream;
            const hasRealCamera = localStream.getVideoTracks().some(t => t.label && !t.label.includes('canvas'));
            localVid.style.display = (hasRealCamera) ? 'block' : 'none';
            localVid.muted = true;
            NexusLog('UI', `Attached local stream to popup video element (Display: ${localVid.style.display})`);
        }

        const visualizerCanvas = popup.document.getElementById('volume-visualizer');
        if (visualizerCanvas && localStream.getAudioTracks().length > 0) {
            NexusLog('MEDIA', 'Setting up volume visualizer for local audio.');
            setupVolumeAnalyzer(localStream, visualizerCanvas);
        }

        NexusLog('MEDIA', 'Step 4: Finalizing P2P answer via PeerJS.');
        call.answer(localStream);
        setupCallHandlers(call);
        attachCallWindowListeners(popup);

        // The popup UI will now update based on POST_UPDATE messages
        // popup.document.getElementById('call-status').textContent = `Call in progress`;
        updateCallLayout(call.peer); // Sync state to popup
    } else {
        NexusLog('MEDIA', `Rejecting incoming stream: Active state mismatch (Status: ${activeCallState.status})`, 'warn');
        call.close();
    }
}

function setupCallHandlers(call) {
    currentCall = call;
    NexusLog('UI', `Setting up signaling handlers for peer: ${call.peer}`);

    // Guard against duplicate stream events (PeerJS quirk)
    let streamProcessed = false;

    call.on('stream', async (remoteStream) => {
        NexusLog('MEDIA', `Base 'stream' event fired for peer: ${call.peer}`);
        if (streamProcessed) {
            NexusLog('MEDIA', `Ignoring duplicate stream event for: ${call.peer}`);
            return;
        }
        streamProcessed = true;

        NexusLog('MEDIA', `Processing remote stream (Tracks: ${remoteStream.getTracks().length})`);
        // The popup UI will now update based on POST_UPDATE messages
        // const targetDoc = await waitForCallWindow().then(win => win.document);
        // if (!targetDoc) {
        //     NexusLog('MEDIA', 'ABORT: Call window document not available for stream attachment', 'error');
        //     return;
        // }

        // updateCallLayout(call.peer, remoteStream, targetDoc); // No longer passing remoteStream directly

        // Listen for track changes locally
        remoteStream.getTracks().forEach(track => {
            NexusLog('MEDIA', `Inspecting track: Kind=${track.kind}, Label=${track.label}, ReadyState=${track.readyState}`);
            track.onmute = () => {
                NexusLog('MEDIA', `Remote ${track.kind} track MUTE detected for ${call.peer}`, 'media');
                updateCallLayout(call.peer);
            };
            track.onunmute = () => {
                NexusLog('MEDIA', `Remote ${track.kind} track UNMUTE detected for ${call.peer}`, 'media');
                updateCallLayout(call.peer);
            };
            track.onended = () => {
                NexusLog('MEDIA', `Remote ${track.kind} track ENDED for ${call.peer}`, 'media');
                updateCallLayout(call.peer);
            };
        });

        activeCallState.localReady = true;
        activeCallState.remoteStream = remoteStream; // Store remote stream for popup to access

        // Deduplicate CALL_READY signal
        if (!activeCallState.readySent) {
            NexusLog('SIGNAL', 'Sending CALL_READY to peer');
            const p = activePeers.get(activeCallState.peerId);
            if (p?.secure) p.conn.send({ type: 'CALL_READY' });
            activeCallState.readySent = true;
        }

        if (activeCallState.remoteReady) finalizeCallUI();
        updateCallLayout(call.peer); // Sync state to popup after stream is processed
    });

    call.on('close', () => {
        NexusLog('MEDIA', 'Remote media connection closed');
        endCall(false);
    });
}





function openCallOverlay() {
    document.getElementById('call-overlay').classList.add('active');
}

let audioCtx = null;
let ringtoneOsc = null;
let ringtoneGain = null;

function playRingtone(type) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    stopRingtone();

    ringtoneOsc = audioCtx.createOscillator();
    ringtoneGain = audioCtx.createGain();

    if (type === 'dialing') {
        ringtoneOsc.type = 'sine';
        ringtoneOsc.frequency.setValueAtTime(440, audioCtx.currentTime);
        // Intermittent beeps for dialing
        ringtoneGain.gain.setValueAtTime(0, audioCtx.currentTime);
        for (let i = 0; i < 60; i += 2) {
            ringtoneGain.gain.setValueAtTime(0.05, audioCtx.currentTime + i);
            ringtoneGain.gain.setValueAtTime(0, audioCtx.currentTime + i + 1.2);
        }
    } else {
        ringtoneOsc.type = 'triangle';
        ringtoneOsc.frequency.setValueAtTime(550, audioCtx.currentTime);
        // Warbling effect for ringing
        for (let i = 0; i < 60; i += 0.5) {
            ringtoneOsc.frequency.linearRampToValueAtTime(650, audioCtx.currentTime + i + 0.25);
            ringtoneOsc.frequency.linearRampToValueAtTime(550, audioCtx.currentTime + i + 0.5);
        }
        ringtoneGain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    }

    ringtoneOsc.connect(ringtoneGain);
    ringtoneGain.connect(audioCtx.destination);
    ringtoneOsc.start();
}

function stopRingtone() {
    if (ringtoneOsc) {
        try { ringtoneOsc.stop(); } catch (e) { }
        ringtoneOsc.disconnect();
        ringtoneOsc = null;
    }
    if (ringtoneGain) {
        ringtoneGain.disconnect();
        ringtoneGain = null;
    }
}

let volAnalyzer = null;
let volDataArray = null;
let volAnimId = null;

function setupVolumeAnalyzer(stream, canvas) {
    if (callWindow && !callWindow.closed && callWindow.CallUI?.isReady) {
        callWindow.CallUI.setupVolumeAnalyzer(stream, canvas);
    }
}

function stopVolumeAnalyzer() {
    if (callWindow && !callWindow.closed && callWindow.CallUI?.isReady) {
        callWindow.CallUI.stopVolumeAnalyzer();
    }
}


function endCall(sendSignal = true) {
    if (activeCallState.status === 'idle') return;
    NexusLog('CALL', `Terminating call. Sending signal: ${sendSignal}`);

    // reset state first to prevent duplicate entries
    const prevPeerId = activeCallState.peerId;
    activeCallState = {
        peerId: null,
        status: 'idle',
        direction: null,
        isAudioOnly: true,
        groupId: null,
        uiFinalized: false,
        remoteVideoActive: false,
        localMuted: false, // Reset mute state
        remoteMuted: false, // Reset remote mute state
        screenSharing: false, // Reset screen sharing state
        remoteStream: null, // Clear remote stream reference
        localStream: null // Clear local stream reference
    };

    stopRingtone();
    stopVolumeAnalyzer();

    if (sendSignal && prevPeerId) {
        const p = activePeers.get(prevPeerId);
        if (p?.secure && p.sharedKey) {
            p.conn.send({ type: 'CALL_END' });
        }
    }

    if (currentCall) {
        try { currentCall.close(); } catch (e) { }
        currentCall = null;
    }

    if (localStream) {
        localStream.getTracks().forEach(t => {
            t.stop();
            t.enabled = false;
        });
        localStream = null;
    }

    if (callWindow && !callWindow.closed) {
        callWindow.close();
    }
    callWindow = null;

    document.getElementById('incoming-call-overlay').classList.remove('active');
    document.getElementById('outgoing-call-overlay').classList.remove('active');

    showToast('Call ended');
}

async function toggleMute(forceState = null) {
    const isMuted = forceState !== null ? forceState : !localStream.getAudioTracks()[0].enabled;
    localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);

    NexusLog('MEDIA', `Microphone ${isMuted ? 'MUTED' : 'UNMUTED'}`);

    // Sync to peer
    const p = activePeers.get(activeCallState.peerId);
    if (p && p.secure) {
        p.conn.send({ type: 'CALL_MUTE_STATE', isMuted: isMuted });
    }

    // Update activeCallState and sync to popup
    activeCallState.localMuted = isMuted;
    updateCallLayout(activeCallState.peerId);
}

// --- NEXUS CALL API for POPUP ---
window.NexusCall = {
    end: () => endCall(),
    toggleMute: toggleMute, // Reference the new standalone function
    toggleAudioOutput: async (btn) => {
        const popup = callWindow;
        if (!popup) return;
        const videos = popup.document.querySelectorAll('video');
        try {
            const devices = await popup.navigator.mediaDevices.enumerateDevices();
            const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
            if (audioOutputs.length > 1) {
                const isEarpiece = btn.classList.toggle('active-toggle');
                const targetDevice = isEarpiece ? audioOutputs[1].deviceId : audioOutputs[0].deviceId;
                for (let video of videos) {
                    if (typeof video.setSinkId === 'function') await video.setSinkId(targetDevice);
                }
                popup.showToast(isEarpiece ? 'Switched to Earpiece' : 'Switched to Speaker');
                activeCallState.audioOutputEarpiece = isEarpiece; // Update state
            } else {
                popup.showToast('Secondary audio output not found.', 'error');
            }
        } catch (err) {
            NexusLog('UI', `Audio routing error: ${err}`, 'error');
            popup.showToast('Audio routing not supported on this browser.', 'error');
        }
        updateCallLayout(activeCallState.peerId); // Sync state to popup
    },
    toggleScreenShare: async (btn) => {
        const popup = callWindow;
        if (!popup) return;

        if (btn.classList.contains('active-screen')) {
            try {
                btn.disabled = true;
                let newStream = await popup.navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                replaceCallStream(newStream, popup);
                btn.classList.remove('active-screen');

                // const muteBtn = popup.document.getElementById('mute-btn'); // No longer needed, use activeCallState
                // const isMuted = muteBtn.classList.contains('active-toggle');
                newStream.getAudioTracks().forEach(t => t.enabled = !activeCallState.localMuted); // Use activeCallState.localMuted

                const p = activePeers.get(activeCallState.peerId);
                if (p?.conn) p.conn.send({ type: 'CALL_VIDEO_STATE', hasVideo: false });
                activeCallState.screenSharing = false; // Update state
                popup.showToast('Screen sharing stopped');
            } catch (err) {
                NexusLog('UI', `Revert to camera failed: ${err}`, 'error');
                popup.showToast('Failed to access camera', 'error');
            } finally {
                btn.disabled = false;
            }
            return;
        }

        try {
            btn.disabled = true;
            const screenStream = await popup.navigator.mediaDevices.getDisplayMedia({
                video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
            });

            const audioTracks = localStream ? localStream.getAudioTracks() : [];
            if (audioTracks.length > 0) screenStream.addTrack(audioTracks[0]);

            replaceCallStream(screenStream, popup);
            const vTrack = screenStream.getVideoTracks()[0];
            await optimizeTrackQuality(vTrack, 'screen');
            btn.classList.add('active-screen');
            popup.showToast('High-Def screen sharing active');

            const p = activePeers.get(activeCallState.peerId);
            if (p?.conn) p.conn.send({ type: 'CALL_VIDEO_STATE', hasVideo: true });

            vTrack.onended = () => {
                if (btn.classList.contains('active-screen')) {
                    NexusCall.toggleScreenShare(btn);
                }
            };
        } catch (err) {
            NexusLog('UI', `Screen sharing failed: ${err}`, 'error');
            popup.showToast('Could not share screen', 'error');
        } finally {
            btn.disabled = false;
        }
    }
};

function attachCallWindowListeners(popup) {
    // Legacy support: Now handled by CallUI.init()
    NexusLog('CALL', 'attachCallWindowListeners - Redundant but kept for safety');
}

function replaceCallStream(newStream, popup) {
    if (!currentCall || !currentCall.peerConnection) return;

    // Stop old video tracks to release the camera immediately
    if (localStream) {
        localStream.getVideoTracks().forEach(t => t.stop());
    }

    // Update local video element in the popup
    const localVid = popup ? popup.document.getElementById('local-video') : null;
    if (localVid) {
        localVid.srcObject = newStream;
        localVid.style.display = newStream.getVideoTracks().length > 0 ? 'block' : 'none';
        localVid.muted = true;
    }

    // Update Visualizer if we have audio and a canvas
    if (popup) {
        const visualizerCanvas = popup.document.getElementById('volume-visualizer');
        if (visualizerCanvas) {
            stopVolumeAnalyzer();
            if (newStream.getAudioTracks().length > 0) {
                setupVolumeAnalyzer(newStream, visualizerCanvas);
            }
        }
    }

    // Replace tracks in the WebRTC peer connection
    const senders = currentCall.peerConnection.getSenders();
    const videoTrack = newStream.getVideoTracks()[0];
    const audioTrack = newStream.getAudioTracks()[0];

    // Priority 1: Replace existing video sender (SHOULD always exist now due to Black Track strategy)
    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
    if (videoSender && videoTrack) {
        NexusLog('MEDIA', "Video sender found, replacing track...");
        videoSender.replaceTrack(videoTrack).catch(e => NexusLog('MEDIA', `Replace video track error: ${e}`, 'error'));
    } else if (videoTrack) {
        NexusLog('MEDIA', "No video sender found! Attempting addTrack fallback...", 'warn');
        currentCall.peerConnection.addTrack(videoTrack, newStream);
    }

    // Replace audio track as well to ensure continuity
    const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
    if (audioSender && audioTrack) {
        audioSender.replaceTrack(audioTrack).catch(e => NexusLog('MEDIA', `Replace audio track error: ${e}`, 'error'));
    }

    localStream = newStream;

    // Signal the remote side about the video state change
    const p = activePeers.get(activeCallState.peerId);
    if (p && p.secure && p.sharedKey) {
        const hasVideo = newStream.getVideoTracks().some(t => t.enabled);
        p.conn.send({ type: 'CALL_VIDEO_STATE', hasVideo: hasVideo });
    }
}


// --- UI HELPERS ---
function setupEventListeners() {
    const peerInput = document.getElementById('peer-id-input');
    const connectBtn = document.getElementById('connect-btn');

    // Dialer Buttons
    document.getElementById('accept-call-btn').onclick = () => {
        if (activeCallState.status === 'ringing' && activeCallState.peerId) {
            const p = activePeers.get(activeCallState.peerId);
            if (p && p.secure) {
                // Synchronous Tab Opening
                if (!callWindow || callWindow.closed) {
                    isCallWindowReady = false;
                    callWindow = window.open('call.html', '_blank');
                }

                activeCallState.status = 'active';
                document.getElementById('incoming-call-overlay').classList.remove('active');
                p.conn.send({ type: 'CALL_ACCEPT' });
                // We don't start media here; the Outbound caller initiates the stream upon receiving ACCEPT.
            }
        }
    };

    document.getElementById('reject-call-btn').onclick = () => {
        if (activeCallState.status === 'ringing' && activeCallState.peerId) {
            const p = activePeers.get(activeCallState.peerId);
            if (p && p.secure) p.conn.send({ type: 'CALL_REJECT' });
            endCall(false);
        }
    };

    document.getElementById('cancel-call-btn').onclick = () => {
        if ((activeCallState.status === 'calling' || activeCallState.status === 'ringing') && activeCallState.peerId) {
            const p = activePeers.get(activeCallState.peerId);
            if (p && p.secure) p.conn.send({ type: 'CALL_END' });
            endCall(false);
        }
    };

    connectBtn.onclick = () => {
        const id = peerInput.value.trim();
        if (id && id !== peer.id) {
            setupConnection(peer.connect(id));
            // Optimistic select
            currentPeerId = id;
            currentGroupId = null;
            document.getElementById('active-peer-name').textContent = id;
            document.getElementById('active-peer-status').textContent = 'Connecting...';
            renderMessages();
        }
        peerInput.value = '';
    };

    peerInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') connectBtn.click();
    });
    const msgInput = document.getElementById('message-input');
    msgInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    document.getElementById('send-btn').onclick = sendMessage;

    // Explicitly handle focus to bypass any potential overlay issues
    document.querySelector('.chat-input-area').onclick = () => msgInput.focus();

    document.getElementById('video-call-btn').onclick = () => startCall(true);
    document.getElementById('voice-call-btn').onclick = () => startCall(false);

    document.getElementById('copy-my-id').onclick = () => {
        navigator.clipboard.writeText(peer.id);
        showToast('Peer ID copied to clipboard');
    };

    document.getElementById('edit-nickname-btn').onclick = () => {
        const newName = prompt('Enter your transmission Nickname:', localNickname);
        if (newName !== null) {
            localNickname = newName.trim();
            localStorage.setItem('nexus_nickname', localNickname);
            document.getElementById('my-name').textContent = localNickname || 'Me';
            document.getElementById('my-avatar').textContent = (localNickname || 'Me').charAt(0).toUpperCase();
            showToast('Self-Identity Updated');
        }
    };

    document.getElementById('init-group-btn').onclick = () => {
        createGroup();
    };

    document.getElementById('join-group-btn').onclick = () => {
        document.getElementById('join-modal').classList.add('active');
        document.getElementById('modal-overlay').classList.add('active');
    };

    const joinGidInput = document.getElementById('join-group-id');
    const joinTidInput = document.getElementById('join-target-peer');
    const confirmJoinBtn = document.getElementById('confirm-join-btn');

    confirmJoinBtn.onclick = () => {
        let gid = joinGidInput.value.trim();
        let tid = joinTidInput.value.trim();

        // Handle combined invite strings
        if (gid.includes(' gateway:')) {
            const parts = gid.split(' gateway:');
            gid = parts[0].trim();
            tid = parts[1].trim();
        }

        if (gid && tid) {
            let p = activePeers.get(tid);

            const requestJoin = (peerObj) => {
                if (peerObj.secure && peerObj.sharedKey) {
                    peerObj.conn.send({ type: 'GROUP_JOIN_REQ', groupId: gid, requesterId: peer.id });
                    showToast('Join request transmitted to gateway');
                    closeModals();
                } else {
                    showToast('Establishing secure link to gateway...', 'warning');
                    // We'll wait for HANDSHAKE_READY to retry or just let the user click again
                }
            };

            if (!p) {
                showToast(`Connecting to Gateway: ${tid}...`);
                const conn = peer.connect(tid);
                setupConnection(conn);
                // The user might need to click again once secure, or we could set a callback
            } else {
                requestJoin(p);
            }
        }
    };

    // Tab Switching
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.onclick = () => {
            const view = btn.dataset.view;
            document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            document.querySelectorAll('.view-container').forEach(v => v.classList.remove('active'));
            document.getElementById(`${view}-view`).classList.add('active');

            if (view === 'hub') renderHubs();
        };
    });

    // Sidebar Delegation
    document.getElementById('peer-list').onclick = (e) => {
        const card = e.target.closest('.peer-card');
        if (!card) return;
        const id = card.dataset.id;
        const p = activePeers.get(id);
        if (!p) return;

        currentPeerId = id;
        currentGroupId = null;
        document.getElementById('active-peer-name').textContent = p.nickname || id;
        document.getElementById('active-peer-status').textContent = p.secure ? 'End-to-End Encrypted' : 'Establishing link...';

        updateBeamTarget();
        updateSidebar();
        renderMessages();
    };

    document.getElementById('group-list').onclick = (e) => {
        const card = e.target.closest('.peer-card');
        const settingsBtn = e.target.closest('.settings-trigger');

        if (settingsBtn) {
            const gid = card.dataset.id;
            openNexusSettings(gid);
            return;
        }

        if (card) {
            const id = card.dataset.id;
            const g = groups.get(id);
            if (!g) return;

            currentGroupId = id;
            currentPeerId = null;
            document.getElementById('active-peer-name').textContent = g.name;
            document.getElementById('active-peer-status').textContent = 'Secure Nexus Network';

            updateBeamTarget();
            updateSidebar();
            renderMessages();
        }
    };

    // Call Actions
    document.getElementById('voice-call-btn').onclick = () => startCall(false);
    document.getElementById('video-call-btn').onclick = () => startCall(true);
    // The duplicate buttons were removed from here to prevent event overwriting and stream splitting.
    // Manual Hub Entry
    document.getElementById('add-manual-btn').onclick = () => {
        const input = document.getElementById('manual-hub-input');
        const value = input.value.trim();
        if (value) {
            localHub.unshift({
                id: Date.now().toString(),
                key: 'Manual',
                value,
                time: new Date().toLocaleTimeString(),
                broadcastedTo: []
            });
            input.value = '';
            renderHubs();
            showToast('Manual slot added');
        }
    };

    document.getElementById('clear-local-hub').onclick = () => {
        if (confirm('Clear local buffer?')) {
            localHub = [];
            renderHubs();
        }
    };

    document.getElementById('clear-remote-hub').onclick = () => {
        if (confirm('Clear inbound assets?')) {
            remoteHub = [];
            renderHubs();
        }
    };

    // Hub Sub-Navigation
    document.querySelectorAll('.hub-nav-item').forEach(btn => {
        btn.onclick = () => {
            const subview = btn.dataset.subview;
            document.querySelectorAll('.hub-nav-item').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            document.querySelectorAll('.subview-container').forEach(v => v.classList.remove('active'));
            document.getElementById(`${subview}-view`).classList.add('active');

            if (subview === 'beam' && !editor) initMonaco();
        };
    });

    document.querySelectorAll('.close-modal, .modal-overlay').forEach(el => {
        el.onclick = closeModals;
    });
}

function closeModals() {
    document.getElementById('modal-overlay').classList.remove('active');
    const modals = ['group-modal', 'member-modal', 'join-modal'];
    modals.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active');
    });
}

async function broadcastHubItem(item, p) {
    if (p.secure && p.sharedKey) {
        const payload = JSON.stringify(item);
        const { encryptedData, iv } = await CryptoUtils.encryptChunk(payload, p.sharedKey);
        p.conn.send({ type: 'HUB_SHARE', payload: encryptedData, iv });
    }
}

async function handleIncomingShare(peerId, data) {
    const p = activePeers.get(peerId);
    if (!p?.sharedKey) return;
    try {
        const raw = await CryptoUtils.decryptChunk(data.payload, p.sharedKey, data.iv);
        const item = JSON.parse(raw);
        remoteHub.unshift({ ...item, from: peerId });
        if (remoteHub.length > 50) remoteHub.pop();
        renderHubs();
        showToast('New asset received from mesh');
    } catch (e) { console.error(e); }
}

async function handleIncomingRetract(peerId, data) {
    const p = activePeers.get(peerId);
    if (!p?.sharedKey) return;
    try {
        const raw = await CryptoUtils.decryptChunk(data.payload, p.sharedKey, data.iv);
        const { id } = JSON.parse(raw);
        remoteHub = remoteHub.filter(i => i.id !== id);
        renderHubs();
        showToast('An asset was retracted by peer');
    } catch (e) { console.error(e); }
}

function renderHubs() {
    const localContainer = document.getElementById('local-slots');
    const remoteContainer = document.getElementById('remote-slots');

    localContainer.innerHTML = localHub.length ? localHub.map(i => `
        <div class="hub-card" id="slot-${i.id}">
            <div class="card-head">
                <strong>${i.key}</strong> 
                <span>${i.time}</span>
            </div>
            <div class="val" id="val-${i.id}">${escapeHtml(i.value)}</div>
            <div class="card-actions">
                <button class="mini-action-btn" onclick="copyHubText('${i.id}', true)">📋 Copy</button>
                <button class="mini-action-btn" onclick="editHubItem('${i.id}')">✏️ Edit</button>
                <button class="mini-action-btn" onclick="broadcastHubItem('${i.id}')">📡 Broadcast</button>
                ${i.broadcastedTo && i.broadcastedTo.length > 0 ? `<button class="mini-action-btn retract" onclick="retractHubItem('${i.id}')">🛑 Retract</button>` : ''}
                <button class="mini-action-btn" onclick="deleteHubItem('${i.id}', true)">🗑️ Delete</button>
            </div>
        </div>
    `).join('') : '<div class="empty-state">Buffer is empty</div>';

    remoteContainer.innerHTML = remoteHub.length ? remoteHub.map(i => {
        const p = activePeers.get(i.from);
        const fromDisplayName = p?.nickname || i.from;
        return `
        <div class="hub-card" style="border-left: 4px solid var(--accent-purple)">
            <div class="card-head">
                <strong>${i.key}</strong>
                <span>from ${fromDisplayName} • ${i.time || ''}</span>
            </div>
            <div class="val">${escapeHtml(i.value)}</div>
            <div class="card-actions">
                <button class="mini-action-btn" onclick="copyHubText('${i.id}', false)">📋 Copy</button>
                <button class="mini-action-btn" onclick="deleteHubItem('${i.id}', false)">🗑️ Delete</button>
            </div>
        </div>
        `;
    }).join('') : '<div class="empty-state">No inbound assets</div>';
}

window.broadcastHubItem = async (id) => {
    const item = localHub.find(i => i.id === id);
    if (!item) return;

    let targetCount = 0;
    const targets = [];

    if (currentGroupId) {
        const g = groups.get(currentGroupId);
        if (g) {
            for (const memberId of g.members) {
                if (memberId === peer.id) continue;
                const p = activePeers.get(memberId);
                if (p?.secure && p.sharedKey) {
                    await broadcastHubItemToPeer(item, p);
                    targets.push(memberId);
                    targetCount++;
                }
            }
        }
    } else if (currentPeerId) {
        const p = activePeers.get(currentPeerId);
        if (p?.secure && p.sharedKey) {
            await broadcastHubItemToPeer(item, p);
            targets.push(currentPeerId);
            targetCount++;
        }
    }

    if (targetCount > 0) {
        item.broadcastedTo = Array.from(new Set([...(item.broadcastedTo || []), ...targets]));
        renderHubs();
        showToast(`Beamed to ${targetCount} node(s)`);
    } else {
        showToast('No active secure link to broadcast', 'error');
    }
};

async function broadcastHubItemToPeer(item, p) {
    const payload = JSON.stringify({
        id: item.id,
        key: item.key,
        value: item.value,
        time: item.time
    });
    const { encryptedData, iv } = await CryptoUtils.encryptChunk(payload, p.sharedKey);
    p.conn.send({ type: 'HUB_SHARE', payload: encryptedData, iv });
}

window.retractHubItem = async (id) => {
    const item = localHub.find(i => i.id === id);
    if (!item || !item.broadcastedTo || item.broadcastedTo.length === 0) return;

    if (!confirm('Retract this asset from all broadcasted nodes?')) return;

    let retractCount = 0;
    for (const peerId of item.broadcastedTo) {
        const p = activePeers.get(peerId);
        if (p?.secure && p.sharedKey) {
            const payload = JSON.stringify({ id: item.id });
            const { encryptedData, iv } = await CryptoUtils.encryptChunk(payload, p.sharedKey);
            p.conn.send({ type: 'HUB_RETRACT', payload: encryptedData, iv });
            retractCount++;
        }
    }

    item.broadcastedTo = [];
    renderHubs();
    showToast(`Retracted from ${retractCount} node(s)`);
};

window.editHubItem = (id) => {
    const item = localHub.find(i => i.id === id);
    if (!item) return;

    const valEl = document.getElementById(`val-${id}`);
    const originalValue = item.value;

    valEl.innerHTML = `
        <textarea class="slot-edit-input" id="edit-input-${id}">${originalValue}</textarea>
        <div style="display:flex; gap:5px;">
            <button class="mini-btn" style="padding:4px 8px; font-size:0.7rem;" onclick="saveHubEdit('${id}')">Save</button>
            <button class="mini-btn" style="padding:4px 8px; font-size:0.7rem; background:rgba(255,255,255,0.1);" onclick="renderHubs()">Cancel</button>
        </div>
    `;
    document.getElementById(`edit-input-${id}`).focus();
};

window.saveHubEdit = (id) => {
    const item = localHub.find(i => i.id === id);
    if (!item) return;

    const newValue = document.getElementById(`edit-input-${id}`).value;
    item.value = newValue;
    renderHubs();
    showToast('Entry updated');
};

window.deleteHubItem = (id, isLocal) => {
    if (isLocal) {
        localHub = localHub.filter(i => i.id !== id);
    } else {
        remoteHub = remoteHub.filter(i => i.id !== id);
    }
    renderHubs();
    showToast('Slot removed');
};

window.copyHubText = (id, isLocal) => {
    const hub = isLocal ? localHub : remoteHub;
    const item = hub.find(i => i.id == id);
    if (item) {
        navigator.clipboard.writeText(item.value);
        showToast('Copied to clipboard');
    }
};

window.deleteHubItem = (id, isLocal) => {
    if (isLocal) {
        localHub = localHub.filter(i => i.id != id);
    } else {
        remoteHub = remoteHub.filter(i => i.id != id);
    }
    renderHubs();
};

function updateSidebar() {
    updatePeerList();
    updateGroupList();
}

function updatePeerList() {
    const container = document.getElementById('peer-list');
    if (!container) return;

    // Remove orphaned cards
    Array.from(container.children).forEach(child => {
        if (!activePeers.has(child.dataset.id)) child.remove();
    });

    activePeers.forEach((p, id) => {
        let card = container.querySelector(`[data-id="${id}"]`);
        const displayName = p.nickname || id;
        const isActive = currentPeerId === id;
        const statusText = p.secure ? '🔒 E2EE Active' : '⌛ Handshake...';
        const statusColor = p.secure ? 'var(--accent-cyan)' : 'var(--text-dim)';

        if (!card) {
            card = document.createElement('div');
            card.dataset.id = id;
            container.appendChild(card);
        }

        card.className = `peer-card ${isActive ? 'active' : ''}`;
        card.innerHTML = `
            <div class="avatar">${displayName[0].toUpperCase()}</div>
            <div class="peer-info" style="flex: 1">
                <strong>${displayName}</strong>
                <small style="color: ${statusColor}">${statusText}</small>
            </div>
        `;
    });
}

function updateGroupList() {
    const container = document.getElementById('group-list');
    if (!container) return;

    if (groups.size === 0) {
        container.innerHTML = '<div style="padding: 15px 20px; color: var(--text-dim); font-size: 0.8rem; opacity: 0.5;">No active Nexus links...</div>';
        return;
    }

    // Clean up empty state if it exists
    if (container.querySelector('div[style*="opacity: 0.5"]')) container.innerHTML = '';

    // Remove orphaned cards
    Array.from(container.children).forEach(child => {
        if (child.dataset.id && !groups.has(child.dataset.id)) child.remove();
    });

    groups.forEach((g, id) => {
        let card = container.querySelector(`[data-id="${id}"]`);
        const isActive = currentGroupId === id;
        const memberCount = g.members ? g.members.size : 0;

        if (!card) {
            card = document.createElement('div');
            card.dataset.id = id;
            container.appendChild(card);
        }

        card.className = `peer-card ${isActive ? 'active' : ''}`;
        card.style.borderColor = 'var(--accent-purple)';
        card.innerHTML = `
            <div class="avatar" style="background: var(--accent-purple)">G</div>
            <div class="peer-info" style="flex: 1">
                <strong>${g.name || 'Unknown Nexus'}</strong>
                <small style="color: var(--text-dim)">${memberCount} Nodes</small>
            </div>
            <button class="action-btn settings-trigger" style="padding: 5px; margin: 0; background: transparent; opacity: 0.7;">
                ⚙️
            </button>
        `;
    });
}

function renderMessages() {
    const container = document.getElementById('messages-container');
    container.innerHTML = '';

    const input = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');

    input.disabled = false;
    input.removeAttribute('disabled');
    sendBtn.disabled = false;
    sendBtn.removeAttribute('disabled');

    if (!currentPeerId && !currentGroupId) {
        input.placeholder = 'Select a node to begin...';
        return;
    } else {
        input.placeholder = 'Type an encrypted message...';
    }

    const targetId = currentGroupId || currentPeerId;
    const history = messageStore.get(targetId) || [];

    history.forEach(m => {
        const div = document.createElement('div');
        div.className = `message ${m.type}`;

        let fromDisplayName = m.from;
        if (m.type === 'received') {
            const p = activePeers.get(m.from);
            if (p?.nickname) fromDisplayName = p.nickname;
        }

        div.innerHTML = `
            ${m.groupId && m.type === 'received' ? `<small style="color: var(--accent-cyan); display: block; margin-bottom: 5px;">${fromDisplayName}</small>` : ''}
            <div class="text">${escapeHtml(m.text)}</div>
            <small style="font-size: 0.7rem; opacity: 0.5; display: block; margin-top: 5px;">${m.time}</small>
        `;
        container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
}

function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 500);
    }, 4000);
}

function generateShortId() {
    return Math.random().toString(36).substring(2, 8);
}

function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

init();

// --- LIVE BEAM (MONACO) ---
function initMonaco() {
    require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
    require(['vs/editor/editor.main'], () => {
        editor = monaco.editor.create(document.getElementById('monaco-container'), {
            theme: 'vs-dark',
            automaticLayout: true,
            fontSize: 14,
            fontFamily: "'Space Grotesk', monospace",
            minimap: { enabled: false },
            padding: { top: 20 }
        });

        // Initialize with correct model for current target
        updateBeamTarget();
    });
}

function getOrCreateModel(targetId) {
    if (beamModels.has(targetId)) return beamModels.get(targetId);

    // Create new model
    const newModel = monaco.editor.createModel(
        "// Live Beam Console: " + targetId + "\n// Start typing to sync with collaborators...",
        'javascript'
    );

    newModel.onDidChangeContent((event) => {
        if (isRemoteChange) return;
        broadcastBeamDelta(targetId, event.changes);
    });

    beamModels.set(targetId, newModel);
    return newModel;
}

function updateBeamTarget() {
    const targetEl = document.getElementById('active-beam-target');
    if (!targetEl) return;

    const targetId = currentGroupId || currentPeerId || 'global';

    if (currentGroupId) {
        const g = groups.get(currentGroupId);
        targetEl.textContent = g ? g.name : 'Unknown Nexus';
    } else if (currentPeerId) {
        targetEl.textContent = currentPeerId;
    } else {
        targetEl.textContent = 'Global Console';
    }

    if (editor) {
        const model = getOrCreateModel(targetId);
        editor.setModel(model);
        requestBeamSync(targetId);
    }
}

function requestBeamSync(targetId) {
    if (currentGroupId) {
        const g = groups.get(currentGroupId);
        if (g) {
            const other = Array.from(g.members).find(id => id !== peer.id);
            if (other) {
                const p = activePeers.get(other);
                if (p?.secure) p.conn.send({ type: 'BEAM_SYNC_REQ', targetId });
            }
        }
    } else if (currentPeerId) {
        const p = activePeers.get(currentPeerId);
        if (p?.secure) p.conn.send({ type: 'BEAM_SYNC_REQ', targetId: peer.id }); // Request their view of our 1-1
    }
}

async function broadcastBeamDelta(targetId, changes) {
    const payload = JSON.stringify(changes);

    if (currentGroupId) {
        const g = groups.get(currentGroupId);
        if (g) {
            g.members.forEach(async (memberId) => {
                if (memberId === peer.id) return;
                const p = activePeers.get(memberId);
                if (p?.secure && p.sharedKey) {
                    const { encryptedData, iv } = await CryptoUtils.encryptChunk(payload, p.sharedKey);
                    p.conn.send({ type: 'BEAM_DELTA', targetId, payload: encryptedData, iv });
                }
            });
        }
    } else if (currentPeerId) {
        const p = activePeers.get(currentPeerId);
        if (p?.secure && p.sharedKey) {
            const { encryptedData, iv } = await CryptoUtils.encryptChunk(payload, p.sharedKey);
            p.conn.send({ type: 'BEAM_DELTA', targetId: peer.id, payload: encryptedData, iv });
        }
    }
}

async function handleIncomingBeamDelta(peerId, data) {
    const p = activePeers.get(peerId);
    if (!p?.sharedKey) return;
    try {
        const raw = await CryptoUtils.decryptChunk(data.payload, p.sharedKey, data.iv);
        const changes = JSON.parse(raw);

        // Target is either a group ID or the sender's peer ID (for 1-to-1)
        const targetId = data.targetId || peerId;
        const model = getOrCreateModel(targetId);

        isRemoteChange = true;
        model.applyEdits(changes.map(c => ({
            range: new monaco.Range(c.range.startLineNumber, c.range.startColumn, c.range.endLineNumber, c.range.endColumn),
            text: c.text
        })));
        isRemoteChange = false;
    } catch (e) { console.error(e); }
}

async function handleIncomingBeamSync(peerId, data) {
    const p = activePeers.get(peerId);
    if (!p?.sharedKey) return;
    try {
        const raw = await CryptoUtils.decryptChunk(data.payload, p.sharedKey, data.iv);
        const targetId = data.targetId || peerId;
        const model = getOrCreateModel(targetId);

        isRemoteChange = true;
        model.setValue(raw);
        isRemoteChange = false;
    } catch (e) { console.error(e); }
}
