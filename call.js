/**
 * CallUI Component
 * Handles all UI management, volume analysis, and user interactions inside the call window.
 */

window.CallUI = {
    isReady: false,
    peerId: null,
    nickname: null,
    activeCallState: null,
    volAnalyzer: null,
    volDataArray: null,
    volAnimId: null,

    init(peerId, nickname, initialState) {
        this.log(`Initializing UI context for peer: ${peerId} (${nickname})`);
        this.log(`Initial state: ${JSON.stringify(initialState)}`);
        this.peerId = peerId;
        this.nickname = nickname;
        this.activeCallState = initialState;

        this.setupButtons();
        this.isReady = true;
        this.log('UI context marked as ready', 'info'); // Added verbose log

        // Notify opener that we are ready
        if (window.opener && window.opener.onCallUIReady) {
            this.log('Signaling onCallUIReady to opener', 'info'); // Added verbose log
            window.opener.onCallUIReady(window);
        }
    },

    log(msg, type = 'info') {
        const prefix = '[NEXUS-CALL]';
        const styles = {
            info: 'color: #00f2ff; font-weight: bold;',
            warn: 'color: #ffaa00; font-weight: bold;',
            error: 'color: #ff3b3b; font-weight: bold;',
            signal: 'color: #a855f7; font-weight: bold;',
            media: 'color: #10b981; font-weight: bold;'
        };
        console.log(`%c${prefix} %c${msg}`, styles[type] || styles.info, 'color: inherit;');
    },

    setupButtons() {
        const btnEnd = document.getElementById('end-call-btn');
        const btnMute = document.getElementById('mute-btn');
        const btnAudio = document.getElementById('audio-out-btn');
        const btnShare = document.getElementById('share-screen-btn');

        if (btnEnd) btnEnd.onclick = () => window.opener?.NexusCall?.end();
        if (btnMute) btnMute.onclick = () => this.toggleMute();
        if (btnAudio) btnAudio.onclick = () => this.toggleAudioOutput();
        if (btnShare) btnShare.onclick = () => this.toggleScreenShare();
    },

    updateLayout() {
        this.log('Syncing UI from activeCallState.', 'info');
        const state = this.activeCallState;
        if (!state) return;

        const mainStage = document.getElementById('main-stage');
        const sidePanel = document.getElementById('side-panel');

        if (!mainStage || !sidePanel) {
            this.log('CRITICAL: Main stage or side panel missing from DOM.', 'error');
            return;
        }

        // 1. Ensure Remote Video Element Exists
        let remoteVideo = document.getElementById('remote-video-' + this.peerId);
        if (!remoteVideo) {
            this.log('Creating remote video element.', 'info');
            remoteVideo = document.createElement('video');
            remoteVideo.id = 'remote-video-' + this.peerId;
            remoteVideo.autoplay = true;
            remoteVideo.playsInline = true;
            mainStage.appendChild(remoteVideo);

            // Re-attach srcObject if we just created it and stream exists
            if (state.remoteStream) remoteVideo.srcObject = state.remoteStream;
        }

        // 2. Ensure Audio Placeholder Element Exists
        let placeholder = document.getElementById('audio-placeholder-' + this.peerId);
        if (!placeholder) {
            this.log('Creating audio placeholder element.', 'info');
            placeholder = document.createElement('div');
            placeholder.id = 'audio-placeholder-' + this.peerId;
            placeholder.className = 'audio-avatar';
            placeholder.innerHTML = `<div class="avatar pulse">${(this.nickname || this.peerId).charAt(0).toUpperCase()}</div><h4>${this.nickname || this.peerId}</h4>`;
            mainStage.appendChild(placeholder);
        }

        // 3. Update mute UI
        const muteBtn = document.getElementById('mute-btn');
        if (muteBtn) {
            muteBtn.classList.toggle('active-toggle', !!state.localMuted);
        }

        // 4. Update audio output UI
        const audioBtn = document.getElementById('audio-out-btn');
        if (audioBtn) {
            audioBtn.classList.toggle('active-earpiece', !!state.audioOutputEarpiece);
        }

        // 4b. Update Screen Share/Video UI
        const shareBtn = document.getElementById('share-screen-btn');
        if (shareBtn) {
            shareBtn.classList.toggle('active-toggle', !!state.localVideoActive);
        }

        // 5. Update remote video visibility and Layout Geometry
        const isVideoActive = !!state.remoteVideoActive;
        const isLocalVideoActive = !!state.localVideoActive;

        if (isVideoActive) {
            if (remoteVideo.parentElement !== mainStage) mainStage.appendChild(remoteVideo);
            if (placeholder.parentElement !== sidePanel) sidePanel.appendChild(placeholder);
            remoteVideo.style.display = 'block';
            placeholder.classList.add('pip-mode');
            sidePanel.style.display = 'flex';
        } else {
            if (placeholder.parentElement !== mainStage) mainStage.appendChild(placeholder);
            if (remoteVideo.parentElement !== sidePanel) sidePanel.appendChild(remoteVideo);
            remoteVideo.style.display = 'none';
            placeholder.classList.remove('pip-mode');

            if (!isLocalVideoActive) {
                sidePanel.style.display = 'none';
            } else {
                sidePanel.style.display = 'flex';
            }
        }

        // Ensure placeholder is flex so it shows up
        placeholder.style.display = 'flex';

        // 6. Update call status text
        const statusEl = document.getElementById('call-status');
        if (statusEl) {
            // Treat 'calling' and 'ringing' as connecting, else 'active'
            const isActive = state.status === 'active' || state.status === 'connected';
            statusEl.textContent = isActive ? 'Neural Link Active' : 'Connecting Neural Link...';
        }

        this.log('UI sync complete.', 'info');
    },

    setupVolumeAnalyzer(stream, canvas) {
        if (!stream || !canvas) return;
        this.log('Starting volume analyzer', 'media');
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(stream);
        this.volAnalyzer = audioCtx.createAnalyser();
        this.volAnalyzer.fftSize = 512;
        source.connect(this.volAnalyzer);

        this.volDataArray = new Uint8Array(this.volAnalyzer.frequencyBinCount);
        const ctx = canvas.getContext('2d');

        const draw = () => {
            if (!this.volAnalyzer) return;
            this.volAnimId = requestAnimationFrame(draw);
            this.volAnalyzer.getByteFrequencyData(this.volDataArray);

            let sum = 0;
            for (let i = 0; i < this.volDataArray.length; i++) sum += this.volDataArray[i];
            const volume = sum / this.volDataArray.length;

            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const centerX = canvas.width / 2;
            const centerY = canvas.height / 2;
            const baseRadius = 24;
            const pulseRadius = baseRadius + (volume * 0.15);

            const gradient = ctx.createRadialGradient(centerX, centerY, baseRadius, centerX, centerY, pulseRadius + 5);
            gradient.addColorStop(0, 'rgba(0, 242, 255, 0)');
            gradient.addColorStop(1, `rgba(0, 242, 255, ${volume / 255})`);

            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(centerX, centerY, pulseRadius + 5, 0, Math.PI * 2);
            ctx.fill();
        };
        draw();
    },

    stopVolumeAnalyzer() {
        if (this.volAnimId) cancelAnimationFrame(this.volAnimId);
        if (this.volAnalyzer) this.volAnalyzer.disconnect();
        this.volAnalyzer = null;
        this.volAnimId = null;
    },

    toggleMute() {
        const btn = document.getElementById('mute-btn');
        const isMuted = btn.classList.toggle('active-toggle');
        this.log(`Mute toggled: ${isMuted}`, 'info');
        window.opener?.NexusCall?.toggleMute(isMuted);
    },

    toggleAudioOutput() {
        const btn = document.getElementById('audio-out-btn');
        this.log('Audio output toggle requested', 'info');
        window.opener?.NexusCall?.toggleAudioOutput(btn);
    },

    toggleScreenShare() {
        const btn = document.getElementById('share-screen-btn');
        this.log('Screen share toggle requested', 'info');
        window.opener?.NexusCall?.toggleScreenShare(btn);
    }
};

// Global Toast for Call Window
window.showToast = function (msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    toast.style.background = type === 'error' ? 'rgba(255, 59, 59, 0.9)' : (type === 'warning' ? 'rgba(255, 170, 0, 0.9)' : 'rgba(0, 242, 255, 0.9)');
    toast.style.color = 'white';
    toast.style.padding = '12px 20px';
    toast.style.borderRadius = '8px';
    toast.style.fontFamily = "'Outfit', sans-serif";
    toast.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    toast.style.animation = 'slideIn 0.3s ease-out forwards';
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.5s';
        setTimeout(() => toast.remove(), 500);
    }, 4000);
};

window.showPermissionOverlay = function (msg) {
    const overlay = document.getElementById('permission-overlay');
    const msgEl = document.getElementById('permission-msg');
    if (overlay) {
        overlay.classList.remove('hidden');
        if (msg) msgEl.textContent = msg;
    }
};

// --- MESSAGE BRIDGE (POSTMESSAGE) ---
window.addEventListener('message', (event) => {
    // Relaxed origin check for local context parity
    if (event.origin !== window.location.origin && event.origin !== 'null') return;

    const { type, data } = event.data;

    switch (type) {
        case 'POST_LOG':
            window.CallUI.log(data.msg, data.type);
            break;

        case 'POST_INIT':
            window.CallUI.init(data.peerId, data.nickname, data.initialState);
            break;

        case 'POST_UPDATE':
            if (data.activeCallState) window.CallUI.activeCallState = data.activeCallState;
            window.CallUI.updateLayout(null); // Force layout refresh
            break;

        case 'ATTACH_STREAM':
            // Potential future use for direct stream passing if needed
            break;
    }
});

window.addEventListener('load', () => {
    window.CallUI.log('Handshake Phase 1: Call Window Ready. Signaling Opener.', 'info');
    if (window.opener) {
        window.opener.postMessage({ type: 'UI_READY' }, '*');
    }
});
