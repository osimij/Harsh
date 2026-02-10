/**
 * sdf.js
 * Approximate Signed Distance Field (SDF) from a binary fill mask.
 *
 * - fillMask: Uint8Array (1 = filled/inside, 0 = empty/outside)
 * - Output sdf: Float32Array in pixel units (positive inside, negative outside)
 *
 * This is computed on-demand (logo change) and should be cached by the caller.
 */

export function computeSdf(fillMask, width, height) {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    const n = w * h;
    const mask = fillMask || new Uint8Array(n);

    // distToEmpty: for filled pixels, distance to nearest empty (boundary outward)
    // distToFill: for empty pixels, distance to nearest filled (boundary inward)
    const distToEmpty = distanceTransform(mask, w, h, { targetValue: 0 });
    const distToFill = distanceTransform(mask, w, h, { targetValue: 1 });

    const sdf = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const inside = mask[i] ? 1 : 0;
        sdf[i] = inside ? distToEmpty[i] : -distToFill[i];
    }

    return { sdf, width: w, height: h };
}

/**
 * Bilinear sample of the SDF at pixel-space coordinates.
 * x,y can be fractional; coordinates are clamped to the image bounds.
 */
export function sampleSdfAtPixel(sdf, width, height, x, y) {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    const a = sdf;
    if (!a || a.length < w * h) return 0;

    const fx = clampNumber(x, 0, w - 1);
    const fy = clampNumber(y, 0, h - 1);

    const x0 = fx | 0;
    const y0 = fy | 0;
    const x1 = Math.min(w - 1, x0 + 1);
    const y1 = Math.min(h - 1, y0 + 1);

    const tx = fx - x0;
    const ty = fy - y0;

    const i00 = y0 * w + x0;
    const i10 = y0 * w + x1;
    const i01 = y1 * w + x0;
    const i11 = y1 * w + x1;

    const v00 = a[i00];
    const v10 = a[i10];
    const v01 = a[i01];
    const v11 = a[i11];

    const vx0 = v00 + (v10 - v00) * tx;
    const vx1 = v01 + (v11 - v01) * tx;
    return vx0 + (vx1 - vx0) * ty;
}

/**
 * Finite-difference gradient sample in pixel space.
 * Returns { gx, gy } in pixel units (positive gx means sdf increases to the right).
 */
export function sampleSdfGradAtPixel(sdf, width, height, x, y) {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    const a = sdf;
    if (!a || a.length < w * h) return { gx: 0, gy: 0 };

    const eps = 1.0;
    const vL = sampleSdfAtPixel(a, w, h, x - eps, y);
    const vR = sampleSdfAtPixel(a, w, h, x + eps, y);
    const vU = sampleSdfAtPixel(a, w, h, x, y - eps);
    const vD = sampleSdfAtPixel(a, w, h, x, y + eps);
    return {
        gx: (vR - vL) * 0.5,
        gy: (vD - vU) * 0.5
    };
}

/**
 * Sample SDF in normalized logo coordinates (xN,yN in [-1,1]) using the same
 * bounding-box normalization as RasterPointSampler / LogoShapeAnalyzer.
 *
 * norm must include: { scale, cx, cy } where:
 * - xN = (xPx - cx) * scale
 * - yN = -(yPx - cy) * scale
 */
export function sampleSdfAtNormalizedXY(sdf, width, height, norm, xN, yN) {
    if (!norm) return 0;
    const scale = Number(norm.scale) || 1;
    const cx = Number(norm.cx) || 0;
    const cy = Number(norm.cy) || 0;
    const inv = 1.0 / Math.max(1e-8, scale);
    const xPx = cx + (Number(xN) || 0) * inv;
    const yPx = cy - (Number(yN) || 0) * inv;
    return sampleSdfAtPixel(sdf, width, height, xPx, yPx);
}

export function sampleSdfGradAtNormalizedXY(sdf, width, height, norm, xN, yN) {
    if (!norm) return { gx: 0, gy: 0 };
    const scale = Number(norm.scale) || 1;
    const cx = Number(norm.cx) || 0;
    const cy = Number(norm.cy) || 0;
    const inv = 1.0 / Math.max(1e-8, scale);
    const xPx = cx + (Number(xN) || 0) * inv;
    const yPx = cy - (Number(yN) || 0) * inv;
    return sampleSdfGradAtPixel(sdf, width, height, xPx, yPx);
}

// --- internal: chamfer distance transform ---

function distanceTransform(fillMask, w, h, { targetValue } = {}) {
    const n = w * h;
    const mask = fillMask;
    const tgt = (targetValue ? 1 : 0);

    // Initialize: 0 for target pixels, INF for others
    const INF = 1e9;
    const dist = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        dist[i] = (mask[i] === tgt) ? 0 : INF;
    }

    // Chamfer weights (approx Euclidean)
    const w1 = 1.0;
    const w2 = 1.41421356237;

    // Forward pass
    for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
            const i = row + x;
            let d = dist[i];
            if (d === 0) continue;

            // left
            if (x > 0) d = Math.min(d, dist[i - 1] + w1);
            // up
            if (y > 0) d = Math.min(d, dist[i - w] + w1);
            // up-left
            if (x > 0 && y > 0) d = Math.min(d, dist[i - w - 1] + w2);
            // up-right
            if (x < w - 1 && y > 0) d = Math.min(d, dist[i - w + 1] + w2);

            dist[i] = d;
        }
    }

    // Backward pass
    for (let y = h - 1; y >= 0; y--) {
        const row = y * w;
        for (let x = w - 1; x >= 0; x--) {
            const i = row + x;
            let d = dist[i];
            if (d === 0) continue;

            // right
            if (x < w - 1) d = Math.min(d, dist[i + 1] + w1);
            // down
            if (y < h - 1) d = Math.min(d, dist[i + w] + w1);
            // down-right
            if (x < w - 1 && y < h - 1) d = Math.min(d, dist[i + w + 1] + w2);
            // down-left
            if (x > 0 && y < h - 1) d = Math.min(d, dist[i + w - 1] + w2);

            dist[i] = d;
        }
    }

    return dist;
}

function clampNumber(v, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
}


