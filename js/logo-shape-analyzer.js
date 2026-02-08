/**
 * logo-shape-analyzer.js
 * CPU-side shape analysis (mask + metrics) for shape-aware transitions.
 *
 * This is intentionally cached and only recomputed when a logo changes.
 */

export class LogoShapeAnalyzer {
    constructor() {
        this._canvas = document.createElement('canvas');
        this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
        this._cache = new Map(); // key -> LogoShape
    }

    /**
     * Analyze an SVG into fill/edge masks + simple metrics.
     *
     * @returns {Promise<LogoShape>}
     */
    async analyze(svgString, {
        rasterSize = 384,
        alphaThreshold = 8
    } = {}) {
        const svg = String(svgString || '').trim();
        const size = Math.max(64, rasterSize | 0);
        const thr = Math.max(0, alphaThreshold | 0);
        const id = hash32(svg);
        const key = `${id}|${size}|${thr}`;

        const cached = this._cache.get(key);
        if (cached) return cached;

        // Rasterize SVG into alpha mask
        this._canvas.width = size;
        this._canvas.height = size;
        const ctx = this._ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, size, size);

        await drawSvgToCanvas(ctx, size, size, svg);

        const img = ctx.getImageData(0, 0, size, size);
        const { fillMask, edgeMask, bounds, filledCount, edgeCount } = buildMasks(img.data, size, size, thr);

        const bbox = bounds || { minX: 0, minY: 0, maxX: size - 1, maxY: size - 1 };
        const bboxW = Math.max(1, bbox.maxX - bbox.minX + 1);
        const bboxH = Math.max(1, bbox.maxY - bbox.minY + 1);
        const bboxArea = bboxW * bboxH;

        const fillAreaRatio = filledCount > 0 ? (filledCount / bboxArea) : 0;
        const edgeRatio = filledCount > 0 ? (edgeCount / filledCount) : 0;
        const aspectRatio = bboxW / bboxH;

        // Stroke-likeness heuristic (tune as needed)
        const strokeLikely = (edgeRatio > 0.45 && fillAreaRatio < 0.22);

        // Mapping between raster pixels and normalized [-1,1] particle space (matching RasterPointSampler).
        const scale = 2 / Math.max(bboxW, bboxH);
        const cx = (bbox.minX + bbox.maxX) / 2;
        const cy = (bbox.minY + bbox.maxY) / 2;

        const out = {
            id,
            rasterSize: size,
            width: size,
            height: size,
            bounds: bounds,
            fillMask,
            edgeMask,
            // Derivation helpers for norm<->pixel conversion
            norm: {
                scale,
                cx,
                cy,
                bboxW,
                bboxH
            },
            metrics: {
                fillAreaRatio,
                edgeRatio,
                aspectRatio,
                strokeLikely
            }
        };

        this._cache.set(key, out);
        return out;
    }

    clearCache() {
        this._cache.clear();
    }
}

// --- internal helpers (kept local so we don’t couple to RasterPointSampler internals) ---

async function drawSvgToCanvas(ctx, width, height, svgString) {
    const svg = normalizeSvgForRaster(svgString);
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
        const img = await loadImage(url);
        const iw = Math.max(1, img.naturalWidth || img.width || width);
        const ih = Math.max(1, img.naturalHeight || img.height || height);
        const scale = Math.min(width / iw, height / ih);
        const drawW = iw * scale;
        const drawH = ih * scale;
        const dx = (width - drawW) * 0.5;
        const dy = (height - drawH) * 0.5;
        ctx.drawImage(img, dx, dy, drawW, drawH);
    } finally {
        URL.revokeObjectURL(url);
    }
}

function normalizeSvgForRaster(svgString) {
    const s = String(svgString || '').trim();
    if (!s) return s;
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(s, 'image/svg+xml');
        const svg = doc.querySelector('svg');
        if (!svg || doc.querySelector('parsererror')) return s;
        const aspect = svg.getAttribute('preserveAspectRatio');
        if (!aspect || String(aspect).trim().toLowerCase().startsWith('none')) {
            svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        }
        return new XMLSerializer().serializeToString(svg);
    } catch (_err) {
        return s;
    }
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to rasterize SVG'));
        img.src = url;
    });
}

function buildMasks(rgba, w, h, alphaThreshold) {
    const fillMask = new Uint8Array(w * h);
    const edgeMask = new Uint8Array(w * h);

    let minX = w, minY = h, maxX = -1, maxY = -1;
    let filledCount = 0;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const a = rgba[i * 4 + 3] | 0;
            const filled = a > alphaThreshold;
            fillMask[i] = filled ? 1 : 0;
            if (filled) {
                filledCount++;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
    }

    if (maxX < 0 || maxY < 0) {
        return { fillMask, edgeMask, bounds: null, filledCount: 0, edgeCount: 0 };
    }

    // Edge = filled pixel with any non-filled 4-neighbor
    let edgeCount = 0;
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const i = y * w + x;
            if (!fillMask[i]) continue;
            const left = x > 0 ? fillMask[i - 1] : 0;
            const right = x < w - 1 ? fillMask[i + 1] : 0;
            const up = y > 0 ? fillMask[i - w] : 0;
            const down = y < h - 1 ? fillMask[i + w] : 0;
            const edge = (left && right && up && down) ? 0 : 1;
            edgeMask[i] = edge;
            edgeCount += edge;
        }
    }

    return {
        fillMask,
        edgeMask,
        bounds: { minX, minY, maxX, maxY },
        filledCount,
        edgeCount
    };
}

function hash32(str) {
    const s = String(str || '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

