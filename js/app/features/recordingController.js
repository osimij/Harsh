import { logger } from '../utils/logger.js';

export function updateRecordingUI(app) {
    const recBtn = document.getElementById('record-btn');
    const stopBtn = document.getElementById('record-stop-btn');
    const status = document.getElementById('record-status');

    if (recBtn) recBtn.disabled = !!app._isRecording;
    if (stopBtn) stopBtn.disabled = !app._isRecording;
    if (status) {
        status.textContent = app._isRecording ? 'REC' : 'IDLE';
        status.classList.toggle('recording', !!app._isRecording);
    }
}

export function updateRecordingTimerUI(app) {
    if (!app._isRecording || !app.liveRecorder) return;
    const el = document.getElementById('record-timer');
    if (!el) return;
    const sec = app.liveRecorder.getElapsedSeconds();
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function startLiveRecording(app, { fps = 60 } = {}) {
    try {
        if (!app.liveRecorder || !app.liveRecorder.isSupported()) {
            alert('Live recording is not supported in this browser. Try Chrome.');
            return;
        }
        if (app._isRecording) return;

        // Bitrate heuristic: scale with resolution + fps, but clamp to keep encoding real-time.
        const w = Math.max(1, app.canvas?.width || 0);
        const h = Math.max(1, app.canvas?.height || 0);
        const fr = Math.max(1, fps | 0);
        // bpp here is bits/(pixel*frame). 0.085–0.11 is a decent live-capture range.
        const bpp = fr >= 50 ? 0.095 : 0.105;
        const estimated = Math.round(w * h * fr * bpp);
        const bitsPerSecond = Math.max(4_000_000, Math.min(40_000_000, estimated));

        const chosen = app.liveRecorder.start({
            fps,
            // Prefer smoothness for live capture (VP8 first); keep quality high via bitrate.
            bitsPerSecond,
            preferSpeed: true,
            // Less frequent slices reduce main-thread overhead vs tiny chunks.
            timesliceMs: 1000
        });
        app._isRecording = true;
        updateRecordingUI(app);
        logger.debug('Recording started:', chosen);
    } catch (e) {
        console.error(e);
        alert('Failed to start recording.');
    }
}

export async function stopLiveRecording(app) {
    try {
        if (!app._isRecording || !app.liveRecorder) return;
        const blob = await app.liveRecorder.stop();
        app._isRecording = false;
        updateRecordingUI(app);
        if (!blob) return;

        const filename = `particle-forge-performance-${app.formatTimestampForFilename()}.webm`;
        app.downloadBlob(blob, filename);
    } catch (e) {
        console.error(e);
        app._isRecording = false;
        updateRecordingUI(app);
        alert('Failed to stop recording.');
    }
}

export class RecordingController {
    constructor({ appCompat }) {
        this.app = appCompat;
    }

    updateRecordingUI() {
        return updateRecordingUI(this.app);
    }

    updateRecordingTimerUI() {
        return updateRecordingTimerUI(this.app);
    }

    startLiveRecording(opts) {
        return startLiveRecording(this.app, opts);
    }

    stopLiveRecording() {
        return stopLiveRecording(this.app);
    }
}


