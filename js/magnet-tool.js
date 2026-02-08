/**
 * magnet-tool.js
 * Simple interactive attract/repel circle controller.
 *
 * Stores the tool center in clip-space coordinates (x/y in [-1, 1], y up),
 * so it’s resolution-independent and easy to use for both:
 * - CPU forces (compare against particle clip positions)
 * - WebGL overlay rendering (draw in clip space)
 */
	export class MagnetTool {
	    constructor({
	        enabled = false,
	        mode = 'attract', // 'attract' | 'repel'
	        radiusPx = 140,   // CSS pixels
	        strength = 1.0    // unitless; mapped to a small per-frame displacement
	    } = {}) {
        this.enabled = !!enabled;
	        this.mode = (mode === 'repel') ? 'repel' : 'attract';
	        this.radiusPx = clampNumber(radiusPx, 5, 2000, 140);
	        // Allow extreme values for "black hole" style pulls / strong repulses.
	        this.strength = clampNumber(strength, 0, 50, 1.0);

        // Center in clip-space coordinates (x/y in [-1, 1], y up)
        this.centerX = 0;
        this.centerY = 0;

        // Drag state
        this.isPointerDown = false;
        this.pointerId = null;
    }

    toggleEnabled() {
        this.setEnabled(!this.enabled);
        return this.enabled;
    }

    setEnabled(next) {
        this.enabled = !!next;
        if (!this.enabled) {
            this.isPointerDown = false;
            this.pointerId = null;
        }
    }

    setMode(mode) {
        this.mode = (mode === 'repel') ? 'repel' : 'attract';
    }

    setRadiusPx(px) {
        this.radiusPx = clampNumber(px, 5, 2000, this.radiusPx);
    }

	    setStrength(v) {
	        this.strength = clampNumber(v, 0, 50, this.strength);
	    }

    /**
     * Update center from a pointer/mouse/touch event.
     */
    updateCenterFromClientPoint(clientX, clientY, canvasRect) {
        const rect = canvasRect;
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;

        const x = (Number(clientX) - rect.left);
        const y = (Number(clientY) - rect.top);

        const nx = x / rect.width;
        const ny = y / rect.height;

        // Convert to clip space [-1,1], y up.
        this.centerX = nx * 2 - 1;
        this.centerY = 1 - ny * 2;
    }

    handlePointerDown(e, canvasRect) {
        if (!this.enabled) return false;
        if (!e) return false;

        this.isPointerDown = true;
        this.pointerId = (e.pointerId != null) ? e.pointerId : 'mouse';
        this.updateCenterFromClientPoint(e.clientX, e.clientY, canvasRect);
        return true;
    }

    handlePointerMove(e, canvasRect) {
        if (!this.enabled) return false;
        if (!this.isPointerDown) return false;
        if (!e) return false;
        const pid = (e.pointerId != null) ? e.pointerId : 'mouse';
        if (this.pointerId != null && pid !== this.pointerId) return false;

        this.updateCenterFromClientPoint(e.clientX, e.clientY, canvasRect);
        return true;
    }

    handlePointerUp(e) {
        if (!this.enabled) return false;
        if (!this.isPointerDown) return false;
        if (!e) return false;
        const pid = (e.pointerId != null) ? e.pointerId : 'mouse';
        if (this.pointerId != null && pid !== this.pointerId) return false;

        this.isPointerDown = false;
        this.pointerId = null;
        return true;
    }

    /**
     * Frame params for simulation + overlay.
     *
     * - radius is represented as separate x/y clip radii so the circle stays round in screen pixels.
     */
	    getFrameParams({ canvasRect, zoom = 1.0, depthScale = 0.5, aspectX = 1.0, aspectY = 1.0 } = {}) {
        const rect = canvasRect;
        const w = rect && rect.width > 0 ? rect.width : 1;
        const h = rect && rect.height > 0 ? rect.height : 1;

        const radiusPx = clampNumber(this.radiusPx, 5, 2000, 140);
        const ax = Math.max(1e-6, Number(aspectX) || 1);
        const ay = Math.max(1e-6, Number(aspectY) || 1);
        const radiusClipX = (radiusPx * 2) / w / ax;
        const radiusClipY = (radiusPx * 2) / h / ay;

	        return {
	            enabled: !!this.enabled,
	            mode: this.mode,
	            centerX: (Number(this.centerX) || 0) / ax,
	            centerY: (Number(this.centerY) || 0) / ay,
	            radiusPx,
	            radiusClipX,
	            radiusClipY,
	            strength: clampNumber(this.strength, 0, 50, 1.0),
	            zoom: Number(zoom) || 1.0,
	            depthScale: (typeof depthScale === 'number') ? depthScale : 0.5
	        };
	    }
}

function clampNumber(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}
