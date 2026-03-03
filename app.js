import CryptoUtils from './crypto.js';

// --- STATE ---
let peer = null;
let myKeyPair = null;
let myPublicKeyData = null;
let activePeers = new Map(); // id -> { conn, sharedKey, secure, name }
let currentPeerId = null;
let currentGroupId = null;
let messages = [];
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
let editor = null;
let beamModels = new Map(); // targetId -> monaco.editor.ITextModel
let isRemoteChange = false;

// --- INITIALIZATION ---
async function init() {
    // 1. Identify Secure Context
    const isSecure = window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

    if (!isSecure) {
        document.getElementById('insecure-protocol-overlay').classList.add('active');
        console.error('HTTPS Enforcement: Execution halted on insecure origin.');
        return; // Halt all initialization
    }

    // 2. Core UI & PeerID generation first
    initPeer();
    setupEventListeners();

    // 3. Security Setup (Hard Enforced)
    try {
        myKeyPair = await CryptoUtils.generateECCKeyPair();
        if (myKeyPair) {
            myPublicKeyData = await CryptoUtils.exportPublicKey(myKeyPair.publicKey);
        }
    } catch (err) {
        console.error('FATAL_CRYPTO_ERROR:', err);
        showToast('FATAL ERROR: Encryption engine failed. Neural Link suspended.', 'error');
        // We'll proceed with Peer initialization so the UI stays up, but communications will fail
    }
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
        console.error('Peer Error:', err);
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

function syncHandshakeGroups(data) {
    if (data.joinedNexus && Array.isArray(data.joinedNexus)) {
        console.log(`[GROUP] Handshake Sync: Processing ${data.joinedNexus.length} shared groups`);
        data.joinedNexus.forEach(g => {
            if (!groups.has(g.groupId)) {
                groups.set(g.groupId, {
                    name: g.name,
                    owner: g.owner,
                    admins: new Set(g.admins || []),
                    members: new Set(g.members || [])
                });
                console.log(`[GROUP] Auto-joined ${g.name} via handshake`);
                showToast(`Nexus Link Established: ${g.name}`, 'info');
            }
        });
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
            console.error('HANDSHAKE_HALTED: Our encryption engine is not initialized.');
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

            // If we are in a call with them, end it automatically
            if (activeCallState.peerId === peerId) {
                endCall();
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
            if (data.nickname) p.nickname = data.nickname;
            syncHandshakeGroups(data); // Process groups from the responder
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
            handleCallSignaling(peerId, data);
            break;
        case 'GROUP_INVITE':
            console.log('RECV: GROUP_INVITE', data);
            handleGroupInvite(peerId, data);
            break;
        case 'GROUP_JOIN_REQ':
            console.log('RECV: GROUP_JOIN_REQ', data);
            handleGroupJoinReq(peerId, data);
            break;
        case 'GROUP_JOIN_RES':
            console.log('RECV: GROUP_JOIN_RES', data);
            handleGroupJoinRes(peerId, data);
            break;
        case 'GROUP_UPDATE':
            console.log('RECV: GROUP_UPDATE', data);
            handleGroupUpdate(peerId, data);
            break;
        case 'GROUP_DELETE':
            console.log('RECV: GROUP_DELETE', data);
            handleGroupDelete(peerId, data);
            break;
        case 'GROUP_KICK':
            console.log('RECV: GROUP_KICK', data);
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
    console.log(`[GROUP] Handling invite for ${groupName} (${groupId}) FROM ${fromId} (Auto: ${!!isCreatorInvite})`);

    // Auto-accept if it's a direct invitation from the creator/admin
    const autoAccept = isCreatorInvite || false;
    const inviterName = activePeers.get(fromId)?.nickname || fromId;

    const proceed = autoAccept || confirm(`You are invited to join "${groupName}" by ${inviterName}. Access Nexus?`);

    if (proceed) {
        const p = activePeers.get(fromId);
        if (p?.secure && p.sharedKey) {
            console.log('[GROUP] Sending GROUP_JOIN_REQ...');
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
            console.error('[GROUP] Insecure or missing connection to inviter');
            if (!autoAccept) showToast('Secure link required to join Nexus', 'error');
        }
    }
}

async function handleGroupJoinReq(fromId, data) {
    const { groupId, requesterId, isInviteAccept } = data;
    console.log(`[GROUP] Join Request for ${groupId} from ${requesterId} (via ${fromId})`);
    const g = groups.get(groupId);
    if (!g) {
        console.error('[GROUP] Unknown group ID in join req');
        return;
    }

    // Check if user is admin or owner
    const isAuthority = g.admins.has(peer.id) || g.owner === peer.id;
    if (!isAuthority) {
        console.warn('[GROUP] Non-authority received join req');
        return;
    }

    // Auto-approve if we were the ones who invited them
    const requesterName = activePeers.get(requesterId)?.nickname || requesterId;
    const approved = isInviteAccept || confirm(`${requesterName} wants to join "${g.name}". Approve entry?`);

    if (approved) {
        console.log(`[GROUP] Approving join for ${requesterId}`);
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
            console.log('[GROUP] Sent approved response');
        } else {
            console.error('[GROUP] Cannot find secure connection for response');
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
    console.log(`[GROUP] Received Join Response FROM ${fromId}:`, data);
    if (data.status === 'approved') {
        const { groupId, groupName, ownerId, adminIds, memberIds } = data;
        if (!groupId || !groupName) {
            console.error('[GROUP] Invalid data in JOIN_RES');
            return;
        }

        groups.set(groupId, {
            name: groupName,
            owner: ownerId,
            admins: new Set(adminIds || []),
            members: new Set(memberIds || [peer.id])
        });

        console.log(`[GROUP] Successfully set group ${groupId}. Total groups:`, groups.size);
        showToast(`Secure Nexus Established: ${groupName}`);
        updateSidebar();
    } else {
        console.warn(`[GROUP] Join denied for ${data.groupId}`);
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
                console.log('Nexus discovery: connecting to peer', mid);
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

async function handleHandshake(peerId, data) {
    const p = activePeers.get(peerId);
    if (!p) return;

    // Hard Security: Guard against uninitialized local node
    if (!myKeyPair || !myPublicKeyData) {
        console.error('HANDSHAKE_REJECTED: Our encryption engine is not initialized.');
        p.conn.close();
        return;
    }

    // Verify peer's identity binding
    const isValid = await CryptoUtils.verifyKeyBinding(data.peerId, data.publicKey, data.timestamp, data.binding);
    if (!isValid) {
        console.error('MITM Detect: Invalid key binding from ' + peerId);
        p.conn.close();
        return;
    }

    try {
        const peerPubKey = await CryptoUtils.importPublicKey(data.publicKey);
        p.sharedKey = await CryptoUtils.deriveEncryptionKey(myKeyPair.privateKey, peerPubKey);

        // Process any group memberships sent in handshake
        syncHandshakeGroups(data);

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
        console.error('HANDSHAKE_FAILED:', err.message);
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
            console.error(err);
            showToast('Encryption failure', 'error');
        }
    } else {
        showToast('Establishing secure link...', 'warning');
    }
}

function addMessage(from, to, text, type, groupId = null) {
    const msg = { from, to, text, time: new Date().toLocaleTimeString(), type, groupId };
    messages.push(msg);
    renderMessages();
}

// --- CALLING (DIALER SYSTEM) ---
let activeCallState = {
    peerId: null,
    status: 'idle', // 'idle', 'calling', 'ringing', 'active'
    direction: null, // 'inbound', 'outbound'
    isAudioOnly: true
};

async function startCall(video = true) {
    if (!currentPeerId) {
        showToast('Select a peer to call', 'warning');
        return;
    }
    const p = activePeers.get(currentPeerId);
    if (!p || !p.secure) {
        showToast('Secure link required for calls', 'error');
        return;
    }

    if (activeCallState.status !== 'idle') {
        showToast('You are already in a call.', 'warning');
        return;
    }

    activeCallState = {
        peerId: currentPeerId,
        status: 'calling',
        direction: 'outbound',
        isAudioOnly: !video
    };

    // Show Outgoing UI
    document.getElementById('outgoing-target-avatar').textContent = (p.nickname || currentPeerId).charAt(0).toUpperCase();
    document.getElementById('outgoing-target-name').textContent = p.nickname || currentPeerId;
    document.getElementById('outgoing-call-status').textContent = `Calling...`;
    document.getElementById('outgoing-call-overlay').classList.add('active');

    // Send Offer Signal
    p.conn.send({ type: 'CALL_OFFER', video });
}

function handleCallSignaling(peerId, data) {
    const p = activePeers.get(peerId);
    if (!p) return;

    switch (data.type) {
        case 'CALL_OFFER':
            if (activeCallState.status !== 'idle') {
                p.conn.send({ type: 'CALL_BUSY' });
                return;
            }
            activeCallState = {
                peerId: peerId,
                status: 'ringing',
                direction: 'inbound',
                isAudioOnly: !data.video
            };
            // Send Ringing Signal
            p.conn.send({ type: 'CALL_RINGING' });

            // Show Incoming UI
            document.getElementById('incoming-caller-avatar').textContent = (p.nickname || peerId).charAt(0).toUpperCase();
            document.getElementById('incoming-caller-name').textContent = p.nickname || peerId;
            document.getElementById('incoming-call-type').textContent = `Incoming ${data.video ? 'Video' : 'Audio'} Link...`;
            document.getElementById('incoming-call-overlay').classList.add('active');
            break;

        case 'CALL_RINGING':
            if (activeCallState.status === 'calling' && activeCallState.peerId === peerId) {
                document.getElementById('outgoing-call-status').textContent = `Ringing...`;
            }
            break;

        case 'CALL_ACCEPT':
            if (activeCallState.status === 'calling' && activeCallState.peerId === peerId) {
                activeCallState.status = 'active';
                document.getElementById('outgoing-call-overlay').classList.remove('active');
                initiateMediaStream(peerId, !activeCallState.isAudioOnly);
            }
            break;

        case 'CALL_REJECT':
        case 'CALL_BUSY':
            if (activeCallState.peerId === peerId) {
                showToast(data.type === 'CALL_BUSY' ? 'User is busy' : 'Call declined', 'error');
                endCall();
            }
            break;

        case 'CALL_END':
            if (activeCallState.peerId === peerId) {
                endCall();
            }
            break;
    }
}

async function initiateMediaStream(targetPeerId, video) {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: video, audio: true });
        document.getElementById('local-video').srcObject = localStream;
        document.getElementById('local-video').style.display = video ? 'block' : 'none';

        const call = peer.call(targetPeerId, localStream, { metadata: { video } });
        setupCallHandlers(call);
        openCallOverlay();
        document.getElementById('call-status').textContent = video ? 'Video Call' : 'Audio Call';
    } catch (err) {
        console.error('Media access error:', err);
        showToast('Camera/Microphone access denied', 'error');
        endCall();
    }
}

function handleIncomingCall(call) {
    // We only accept the stream if we've already transitioned to 'active' via Accept button
    if (activeCallState.status === 'active' && activeCallState.peerId === call.peer) {
        const isVideo = call.options?.metadata?.video;
        navigator.mediaDevices.getUserMedia({ video: isVideo, audio: true }).then(stream => {
            localStream = stream;
            document.getElementById('local-video').srcObject = localStream;
            document.getElementById('local-video').style.display = isVideo ? 'block' : 'none';
            call.answer(stream);
            setupCallHandlers(call);
            openCallOverlay();
            document.getElementById('call-status').textContent = `${isVideo ? 'Video' : 'Audio'} Call in progress`;
        }).catch(err => {
            console.error('Answer media error:', err);
            showToast('Could not access media devices', 'error');
            endCall();
        });
    } else {
        // Unsolicited stream, reject it
        call.close();
    }
}

function setupCallHandlers(call) {
    currentCall = call;
    call.on('stream', (remoteStream) => {
        let remoteVideo = document.getElementById('remote-video-' + call.peer);
        if (!remoteVideo) {
            remoteVideo = document.createElement('video');
            remoteVideo.id = 'remote-video-' + call.peer;
            remoteVideo.autoplay = true;
            remoteVideo.playsInline = true;
            document.getElementById('video-grid').appendChild(remoteVideo);
        }
        remoteVideo.srcObject = remoteStream;
        remoteVideo.style.display = activeCallState.isAudioOnly ? 'none' : 'block';

        if (activeCallState.isAudioOnly) {
            let placeholder = document.getElementById('audio-placeholder-' + call.peer);
            if (!placeholder) {
                placeholder = document.createElement('div');
                placeholder.id = 'audio-placeholder-' + call.peer;
                placeholder.className = 'audio-avatar';
                placeholder.innerHTML = `<div class="avatar pulse" style="width:80px;height:80px;font-size:2rem;">${(activePeers.get(call.peer)?.nickname || call.peer).charAt(0).toUpperCase()}</div><h4 style="margin-top:15px;">${activePeers.get(call.peer)?.nickname || call.peer}</h4>`;
                document.getElementById('video-grid').appendChild(placeholder);
            }
        }
    });

    call.on('close', () => {
        endCall();
    });
}






function playRingtone(type) {
    // Placeholder for actual Web Audio API integration
    console.log(`[Audio Debug] Playing ${type} ringtone...`);
}

function stopRingtone() {
    // Placeholder for actual Web Audio API integration
    console.log(`[Audio Debug] Stopping ringtone.`);
}

function endCall() {
    stopRingtone();

    if (activeCallState.status === 'active' || activeCallState.status === 'calling' || activeCallState.status === 'ringing') {
        const p = activePeers.get(activeCallState.peerId);
        if (p && p.secure && p.sharedKey) {
            p.conn.send({ type: 'CALL_END' });
        }
    }

    if (currentCall) currentCall.close();
    if (localStream) localStream.getTracks().forEach(t => t.stop());

    document.getElementById('call-overlay').classList.remove('active');
    document.getElementById('incoming-call-overlay').classList.remove('active');
    document.getElementById('outgoing-call-overlay').classList.remove('active');

    // Remove remote videos and placeholders
    const remoteVideos = document.querySelectorAll('video[id^="remote-video-"]');
    remoteVideos.forEach(v => v.remove());
    const placeholders = document.querySelectorAll('.audio-avatar');
    placeholders.forEach(p => p.remove());

    document.getElementById('video-grid').innerHTML = '<video id="local-video" autoplay muted playsinline></video>';

    // reset state
    activeCallState = { peerId: null, status: 'idle', direction: null, isAudioOnly: true, groupId: null };
    currentCall = null;
    localStream = null;

    showToast('Call ended');
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
            endCall();
        }
    };

    document.getElementById('cancel-call-btn').onclick = () => {
        if ((activeCallState.status === 'calling' || activeCallState.status === 'ringing') && activeCallState.peerId) {
            const p = activePeers.get(activeCallState.peerId);
            if (p && p.secure) p.conn.send({ type: 'CALL_END' });
            endCall();
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
    document.getElementById('end-call-btn').onclick = endCall;

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
    const list = document.getElementById('peer-list');
    list.innerHTML = '';
    activePeers.forEach((p, id) => {
        const displayName = p.nickname || id;
        const card = document.createElement('div');
        card.className = `peer-card ${currentPeerId === id ? 'active' : ''}`;
        card.innerHTML = `
            <div class="avatar">${displayName[0].toUpperCase()}</div>
            <div class="peer-info" style="flex: 1">
                <strong>${displayName}</strong>
                <small style="color: ${p.secure ? 'var(--accent-cyan)' : 'var(--text-dim)'}">
                    ${p.secure ? '🔒 E2EE Active' : '⌛ Handshake...'}
                </small>
            </div>
        `;
        card.onclick = () => {
            currentPeerId = id;
            currentGroupId = null;
            document.getElementById('active-peer-name').textContent = p.nickname || id;
            document.getElementById('active-peer-status').textContent = p.secure ? 'End-to-End Encrypted' : 'Establishing link...';

            // Sync Beam Target Indicator
            updateBeamTarget();

            updateSidebar();
            renderMessages();
        };
        list.appendChild(card);
    });
}

function updateGroupList() {
    const list = document.getElementById('group-list');
    list.innerHTML = '';

    if (groups.size === 0) {
        list.innerHTML = '<div style="padding: 15px 20px; color: var(--text-dim); font-size: 0.8rem; opacity: 0.5;">No active Nexus links...</div>';
        return;
    }

    groups.forEach((g, id) => {
        const card = document.createElement('div');
        card.className = `peer-card ${currentGroupId === id ? 'active' : ''}`;
        card.style.borderColor = 'var(--accent-purple)';

        // Defensive size check
        const memberCount = g.members ? g.members.size : 0;

        card.innerHTML = `
            <div class="avatar" style="background: var(--accent-purple)">G</div>
            <div class="peer-info" style="flex: 1">
                <strong>${g.name || 'Unknown Nexus'}</strong>
                <small style="color: var(--text-dim)">${memberCount} Nodes</small>
            </div>
            <button class="action-btn" style="padding: 5px; margin: 0; background: transparent; opacity: 0.7;" onclick="event.stopPropagation(); openNexusSettings('${id}')">
                ⚙️
            </button>
        `;
        card.onclick = () => {
            currentGroupId = id;
            currentPeerId = null;
            document.getElementById('active-peer-name').textContent = g.name;
            document.getElementById('active-peer-status').textContent = 'Secure Nexus Network';

            updateBeamTarget();
            updateSidebar();
            renderMessages();
        };
        list.appendChild(card);
    });
}

function renderMessages() {
    const container = document.getElementById('messages-container');
    container.innerHTML = '';

    // Messaging state feedback
    const input = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');

    // Safety check: ensure input is enabled
    input.disabled = false;
    input.removeAttribute('disabled');
    sendBtn.disabled = false;
    sendBtn.removeAttribute('disabled');

    if (!currentPeerId && !currentGroupId) {
        input.placeholder = 'Select a node to begin...';
    } else {
        input.placeholder = 'Type an encrypted message...';
    }

    if (!peer || !peer.id) return; // Prevent filter errors during setup

    const filtered = messages.filter(m => {
        if (currentGroupId) return m.groupId === currentGroupId;
        return (m.from === currentPeerId && m.to === peer.id && !m.groupId) || (m.from === peer.id && m.to === currentPeerId && !m.groupId);
    });

    filtered.forEach(m => {
        const div = document.createElement('div');
        div.className = `message ${m.type}`;

        // Get display name for received group messages
        let fromDisplayName = m.from;
        if (m.type === 'received') {
            const p = activePeers.get(m.from);
            if (p?.nickname) fromDisplayName = p.nickname;
        }

        div.innerHTML = `
            ${currentGroupId && m.type === 'received' ? `<small style="color: var(--accent-cyan); display: block; margin-bottom: 5px;">${fromDisplayName}</small>` : ''}
            <div class="text">${escapeHtml(m.text)}</div>
            <small style="font-size: 0.7rem; opacity: 0.5; display: block; margin-top: 5px;">${m.time}</small>
        `;
        container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
}

function openCallOverlay() {
    document.getElementById('call-overlay').classList.add('active');
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

