/**
 * live-recorder.js
 * Live in-app video recording for interactive performances.
 *
 * Uses:
 * - canvas.captureStream(fps)
 * - MediaRecorder -> WebM (vp9/vp8) when supported.
 */

export class LiveRecorder {
    constructor(canvas) {
        this.canvas = canvas;
        this.mediaRecorder = null;
        this.stream = null;
        this.chunks = [];
        this.mimeType = '';
        this.startTimeMs = 0;
    }

    isSupported() {
        return typeof MediaRecorder !== 'undefined' && !!(this.canvas && this.canvas.captureStream);
    }

    isRecording() {
        return !!(this.mediaRecorder && this.mediaRecorder.state === 'recording');
    }

    getElapsedSeconds() {
        if (!this.isRecording()) return 0;
        return Math.max(0, (performance.now() - this.startTimeMs) / 1000);
    }

    /**
     * Start recording.
     * Returns the chosen mimeType.
     */
    start({
        fps = 60,
        bitsPerSecond = 12_000_000,
        mimeType = '',
        timesliceMs = 1000,
        preferSpeed = true
    } = {}) {
        if (!this.isSupported()) {
            throw new Error('Live recording is not supported in this browser.');
        }
        if (this.isRecording()) return this.mimeType || '';

        const fr = Math.max(1, fps | 0);
        const stream = this.canvas.captureStream(fr);
        const chosen = mimeType && LiveRecorder.isMimeTypeSupported(mimeType)
            ? mimeType
            : LiveRecorder.pickBestMimeType({ preferSpeed });

        if (!chosen) {
            throw new Error('No supported MediaRecorder mimeType found for this browser.');
        }

        this.stream = stream;
        this.chunks = [];
        this.mimeType = chosen;
        this.startTimeMs = performance.now();

        const bps = Math.max(250_000, Number(bitsPerSecond) || 12_000_000);
        // Prefer videoBitsPerSecond when available; keep bitsPerSecond for broader support.
        const options = {
            mimeType: chosen,
            videoBitsPerSecond: bps,
            bitsPerSecond: bps
        };

        const recorder = new MediaRecorder(stream, options);
        this.mediaRecorder = recorder;

        recorder.ondataavailable = (e) => {
            if (e && e.data && e.data.size > 0) this.chunks.push(e.data);
        };

        // Ask for periodic data so long recordings don't risk giant buffers.
        // Too-frequent slices can add overhead; 1s is a good balance for live capture.
        const slice = Math.max(0, Number(timesliceMs) || 1000);
        if (slice > 0) recorder.start(slice);
        else recorder.start();

        return chosen;
    }

    /**
     * Stop recording and resolve to a Blob.
     */
    stop() {
        if (!this.isRecording()) return Promise.resolve(null);

        return new Promise((resolve, reject) => {
            const recorder = this.mediaRecorder;
            const stream = this.stream;

            const cleanup = () => {
                this.mediaRecorder = null;
                this.stream = null;
            };

            recorder.onstop = () => {
                try {
                    const blob = new Blob(this.chunks, { type: this.mimeType || 'video/webm' });
                    this.chunks = [];

                    if (stream) {
                        try {
                            stream.getTracks().forEach((t) => t.stop());
                        } catch (_) { /* ignore */ }
                    }

                    cleanup();
                    resolve(blob);
                } catch (e) {
                    cleanup();
                    reject(e);
                }
            };

            recorder.onerror = (e) => {
                cleanup();
                reject(e?.error || e || new Error('MediaRecorder error'));
            };

            try {
                recorder.stop();
            } catch (e) {
                cleanup();
                reject(e);
            }
        });
    }

    static isMimeTypeSupported(type) {
        try {
            return typeof MediaRecorder !== 'undefined' &&
                typeof MediaRecorder.isTypeSupported === 'function' &&
                MediaRecorder.isTypeSupported(type);
        } catch (_e) {
            return false;
        }
    }

    static pickBestMimeType({ preferSpeed = true } = {}) {
        // For real-time "performance" capture, VP9 is often too slow and causes dropped frames.
        // Prefer VP8 (or plain WebM) for smoother recordings; VP9 is offered as a later fallback.
        const speedFirst = [
            'video/webm;codecs=vp8',
            'video/webm',
            'video/webm;codecs=vp9'
        ];
        const qualityFirst = [
            'video/webm;codecs=vp9',
            'video/webm;codecs=vp8',
            'video/webm'
        ];
        const candidates = preferSpeed ? speedFirst : qualityFirst;
        for (const t of candidates) {
            if (LiveRecorder.isMimeTypeSupported(t)) return t;
        }
        return '';
    }
}


