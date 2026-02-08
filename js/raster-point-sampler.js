/**
 * raster-point-sampler.js
 * High-density point sampling via rasterizing the SVG into an alpha mask.
 *
 * This is designed for 200k–2M particles where geometry-based sampling is too slow.
 */
import { createTexture2D } from './gl-utils.js';

export class RasterPointSampler {
    constructor() {
        this._canvas = document.createElement('canvas');
        this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    }

    /**
     * Sample an SVG string into packed RGBA float positions for a W×H texture.
     * Returns { data, width, height } where data.length === width*height*4.
     */
    async samplePacked(svgString, count, {
        rasterSize = 2048,
        alphaThreshold = 8,
        edgeRatio = 0.6,
        seed = 1,
        edgeAuraEnabled = false,
        edgeAuraAmount = 0.12,
        edgeAuraSpread = 0.12,
        edgeAuraOutlier = 0.05
    } = {}) {
        const n = Math.max(1, count | 0);
        const tex = computeTextureSize(n);
        const width = tex.width;
        const height = tex.height;
        const cap = width * height;

        const rng = mulberry32(hash32(`${seed}|${n}|${hash32(svgString)}`));

        // Render SVG to a square canvas at rasterSize
        const size = Math.max(64, rasterSize | 0);
        this._canvas.width = size;
        this._canvas.height = size;
        const ctx = this._ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, size, size);

        await drawSvgToCanvas(ctx, size, size, svgString);

        const img = ctx.getImageData(0, 0, size, size);
        const { fillMask, edgeMask, bounds } = buildMasks(img.data, size, size, alphaThreshold);

        const data = new Float32Array(cap * 4);
        if (!bounds) return { data, width, height };

        const auraFrac = edgeAuraEnabled ? clamp01(edgeAuraAmount) : 0;
        const auraCount = edgeAuraEnabled ? Math.min(n - 1, Math.max(0, Math.round(n * auraFrac))) : 0;
        const coreCount = Math.max(1, n - auraCount);

        const targetEdge = Math.max(0, Math.min(coreCount, Math.round(coreCount * clamp01(edgeRatio))));

        // Sample edge points first
        let outIdx = 0;
        outIdx = rejectionSampleMask({
            data,
            outIdx,
            maxOut: targetEdge,
            mask: edgeMask,
            fillMask,
            bounds,
            size,
            rng,
            edgeFlag: 1
        });

        // Sample interior points
        outIdx = rejectionSampleMask({
            data,
            outIdx,
            maxOut: coreCount,
            mask: fillMask,
            fillMask,
            bounds,
            size,
            rng,
            edgeFlag: 0
        });

        // If sampling failed (thin strokes), fill remaining from any filled pixel
        if (outIdx < coreCount) {
            outIdx = rejectionSampleMask({
                data,
                outIdx,
                maxOut: coreCount,
                mask: fillMask,
                fillMask,
                bounds,
                size,
                rng,
                maxAttemptsFactor: 80,
                edgeFlag: 0
            });
        }

        if (edgeAuraEnabled && auraCount > 0 && bounds) {
            const { minX, minY, maxX, maxY } = bounds;
            const bw = Math.max(1, maxX - minX + 1);
            const bh = Math.max(1, maxY - minY + 1);
            const spreadMul = Number(edgeAuraSpread);
            const spreadFactor = Number.isFinite(spreadMul) ? spreadMul : 0.12;
            const spreadPx = Math.max(1, (spreadFactor * Math.max(bw, bh)) / 2);
            const outlierMul = Number(edgeAuraOutlier);
            const outlierChance = Number.isFinite(outlierMul) ? outlierMul : 0.05;
            const edgeIndices = collectEdgeIndices(edgeMask, bounds, size);
            outIdx = sampleEdgeAura({
                data,
                colorData: null,
                rgba: null,
                outIdx,
                maxOut: Math.min(n, coreCount + auraCount),
                edgeIndices,
                fillMask,
                bounds,
                size,
                rng,
                spreadPx,
                outlierChance
            });
        }

        if (outIdx < n) {
            outIdx = rejectionSampleMask({
                data,
                outIdx,
                maxOut: n,
                mask: fillMask,
                fillMask,
                bounds,
                size,
                rng,
                maxAttemptsFactor: 80,
                edgeFlag: 0
            });
        }

        return { data, width, height };
    }

    /**
     * Convenience: sample and upload to a float target texture (RGBA32F).
     * Returns { texture, width, height }.
     */
    async sampleToTexture(gl, svgString, count, options = {}) {
        const { data, width, height } = await this.samplePacked(svgString, count, options);
        const texture = createTexture2D(gl, {
            width,
            height,
            internalFormat: gl.RGBA32F,
            format: gl.RGBA,
            type: gl.FLOAT,
            data
        });
        return { texture, width, height };
    }

    /**
     * Sample and also build a low-res "next-logo field" texture (RGBA8) that encodes
     * a vector field derived from the sampled target point density.
     *
     * Returns { texture, width, height, fieldTexture, fieldSize }.
     */
    async sampleToTextureWithField(gl, svgString, count, options = {}) {
        const opts = options || {};
        const fieldSize = Math.max(16, (opts.fieldSize ?? 128) | 0);
        // Exclude fieldSize from options passed into samplePacked.
        // eslint-disable-next-line no-unused-vars
        const { fieldSize: _fs, ...packedOpts } = opts;

        const { data, width, height } = await this.samplePacked(svgString, count, packedOpts);
        const texture = createTexture2D(gl, {
            width,
            height,
            internalFormat: gl.RGBA32F,
            format: gl.RGBA,
            type: gl.FLOAT,
            data
        });

        const fieldData = computeVectorFieldBytesFromPackedPositions(data, count, fieldSize);
        const fieldTexture = createTexture2D(gl, {
            width: fieldSize,
            height: fieldSize,
            internalFormat: gl.RGBA8,
            format: gl.RGBA,
            type: gl.UNSIGNED_BYTE,
            data: fieldData,
            minFilter: gl.LINEAR,
            magFilter: gl.LINEAR
        });

        return { texture, width, height, fieldTexture, fieldSize };
    }

    /**
     * CPU convenience: sample to an array of point objects with `edge` flags.
     * Useful for CPU transitions when vector parsing fails and we fall back to raster sampling.
     */
    async samplePoints(svgString, count, {
        rasterSize = 1024,
        alphaThreshold = 8,
        edgeRatio = 0.6,
        seed = 1,
        color = '#d4d4d8'
    } = {}) {
        const n = Math.max(1, count | 0);
        const rng = mulberry32(hash32(`${seed}|${n}|${hash32(svgString)}`));

        const size = Math.max(64, rasterSize | 0);
        this._canvas.width = size;
        this._canvas.height = size;
        const ctx = this._ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, size, size);
        await drawSvgToCanvas(ctx, size, size, svgString);

        const img = ctx.getImageData(0, 0, size, size);
        const { fillMask, edgeMask, bounds } = buildMasks(img.data, size, size, alphaThreshold);
        if (!bounds) return [];

        const { minX, minY, maxX, maxY } = bounds;
        const bw = Math.max(1, maxX - minX + 1);
        const bh = Math.max(1, maxY - minY + 1);
        const scale = 2 / Math.max(bw, bh);
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;

        const targetEdge = Math.max(0, Math.min(n, Math.round(n * clamp01(edgeRatio))));
        const targetFill = n - targetEdge;

        const points = new Array(n);
        let outIdx = 0;

        // Edge first
        outIdx = rejectionSamplePoints({
            points,
            outIdx,
            maxOut: targetEdge,
            mask: edgeMask,
            fillMask,
            bounds,
            size,
            rng,
            cx,
            cy,
            scale,
            edge: true,
            color
        });

        // Fill
        outIdx = rejectionSamplePoints({
            points,
            outIdx,
            maxOut: n,
            mask: fillMask,
            fillMask,
            bounds,
            size,
            rng,
            cx,
            cy,
            scale,
            edge: false,
            color
        });

        // If we still failed (thin strokes), keep sampling from fill with more attempts.
        if (outIdx < n) {
            outIdx = rejectionSamplePoints({
                points,
                outIdx,
                maxOut: n,
                mask: fillMask,
                fillMask,
                bounds,
                size,
                rng,
                cx,
                cy,
                scale,
                edge: false,
                color,
                maxAttemptsFactor: 80
            });
        }

        // If we somehow didn’t fill, truncate.
        if (outIdx < n) {
            return points.slice(0, outIdx).filter(Boolean);
        }
        return points;
    }

    /**
     * Sample packed positions + per-particle colors from a raster image.
     * Returns { data, colorData, width, height } where data is RGBA32F and colorData is RGBA8.
     */
    async sampleImagePacked(imageSource, count, {
        rasterSize = 1024,
        alphaThreshold = 8,
        lumaThreshold = 12,
        edgeRatio = 0.35,
        seed = 1,
        lumaWeightPower = 1.1,
        intensityPower = 1.0,
        edgeAuraEnabled = false,
        edgeAuraAmount = 0.12,
        edgeAuraSpread = 0.12,
        edgeAuraOutlier = 0.05
    } = {}) {
        const n = Math.max(1, count | 0);
        const tex = computeTextureSize(n);
        const width = tex.width;
        const height = tex.height;
        const cap = width * height;

        const rng = mulberry32(hash32(`${seed}|${n}|img`));

        const size = Math.max(64, rasterSize | 0);
        this._canvas.width = size;
        this._canvas.height = size;
        const ctx = this._ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, size, size);

        await drawImageToCanvas(ctx, size, size, imageSource);

        const img = ctx.getImageData(0, 0, size, size);
        const hasAlpha = imageHasTransparency(img.data, alphaThreshold);
        const bgLuma = hasAlpha ? null : estimateBackgroundLuma(img.data, size, size, alphaThreshold);
        const useLumaContrast = Number.isFinite(bgLuma);
        const { fillMask, edgeMask, bounds, weights } = buildMasks(img.data, size, size, alphaThreshold, {
            maskMode: hasAlpha ? 'alpha' : 'luma',
            lumaThreshold,
            weightByLuma: !hasAlpha,
            lumaPower: lumaWeightPower,
            lumaReference: useLumaContrast ? bgLuma : 0,
            lumaContrast: useLumaContrast
        });

        const data = new Float32Array(cap * 4);
        const colorData = new Uint8Array(cap * 4);
        if (!bounds) return { data, colorData, width, height };

        const auraFrac = edgeAuraEnabled ? clamp01(edgeAuraAmount) : 0;
        const auraCount = edgeAuraEnabled ? Math.min(n - 1, Math.max(0, Math.round(n * auraFrac))) : 0;
        const coreCount = Math.max(1, n - auraCount);

        const targetEdge = Math.max(0, Math.min(coreCount, Math.round(coreCount * clamp01(edgeRatio))));
        const targetFill = coreCount - targetEdge;

        let outIdx = 0;
        outIdx = rejectionSampleMask({
            data,
            colorData,
            rgba: img.data,
            intensityPower,
            outIdx,
            maxOut: targetEdge,
            mask: edgeMask,
            fillMask,
            bounds,
            size,
            rng,
            weights,
            edgeFlag: 1
        });

        outIdx = rejectionSampleMask({
            data,
            colorData,
            rgba: img.data,
            intensityPower,
            outIdx,
            maxOut: coreCount,
            mask: fillMask,
            fillMask,
            bounds,
            size,
            rng,
            weights,
            edgeFlag: 0
        });

        if (outIdx < coreCount) {
            outIdx = rejectionSampleMask({
                data,
                colorData,
                rgba: img.data,
                intensityPower,
                outIdx,
                maxOut: coreCount,
                mask: fillMask,
                fillMask,
                bounds,
                size,
                rng,
                maxAttemptsFactor: 90,
                edgeFlag: 0
            });
        }

        if (edgeAuraEnabled && auraCount > 0 && bounds) {
            const { minX, minY, maxX, maxY } = bounds;
            const bw = Math.max(1, maxX - minX + 1);
            const bh = Math.max(1, maxY - minY + 1);
            const spreadMul = Number(edgeAuraSpread);
            const spreadFactor = Number.isFinite(spreadMul) ? spreadMul : 0.12;
            const spreadPx = Math.max(1, (spreadFactor * Math.max(bw, bh)) / 2);
            const outlierMul = Number(edgeAuraOutlier);
            const outlierChance = Number.isFinite(outlierMul) ? outlierMul : 0.05;
            const edgeIndices = collectEdgeIndices(edgeMask, bounds, size);
            outIdx = sampleEdgeAura({
                data,
                colorData,
                rgba: img.data,
                outIdx,
                maxOut: Math.min(n, coreCount + auraCount),
                edgeIndices,
                fillMask,
                bounds,
                size,
                rng,
                spreadPx,
                outlierChance,
                intensityPower
            });
        }

        if (outIdx < n) {
            outIdx = rejectionSampleMask({
                data,
                colorData,
                rgba: img.data,
                intensityPower,
                outIdx,
                maxOut: n,
                mask: fillMask,
                fillMask,
                bounds,
                size,
                rng,
                maxAttemptsFactor: 90,
                edgeFlag: 0
            });
        }

        return { data, colorData, width, height };
    }

    /**
     * CPU convenience: sample to an array of colored point objects from a raster image.
     */
    async sampleImagePoints(imageSource, count, {
        rasterSize = 1024,
        alphaThreshold = 8,
        lumaThreshold = 12,
        edgeRatio = 0.35,
        seed = 1,
        lumaWeightPower = 1.1,
        intensityPower = 1.0,
        edgeAuraEnabled = false,
        edgeAuraAmount = 0.12,
        edgeAuraSpread = 0.12,
        edgeAuraOutlier = 0.05
    } = {}) {
        const n = Math.max(1, count | 0);
        const { data, colorData } = await this.sampleImagePacked(imageSource, n, {
            rasterSize,
            alphaThreshold,
            lumaThreshold,
            edgeRatio,
            seed,
            lumaWeightPower,
            intensityPower,
            edgeAuraEnabled,
            edgeAuraAmount,
            edgeAuraSpread,
            edgeAuraOutlier
        });

        const points = new Array(n);
        for (let i = 0; i < n; i++) {
            const o = i * 4;
            const r = colorData[o + 0] | 0;
            const g = colorData[o + 1] | 0;
            const b = colorData[o + 2] | 0;
            const a = (colorData[o + 3] | 0) / 255;
            const opacityMul = 0.3 + a * 0.9;
            const sizeMul = 0.8 + a * 0.45;

            points[i] = {
                x: data[o + 0],
                y: data[o + 1],
                z: data[o + 2],
                color: rgbToHex(r, g, b),
                edge: data[o + 3] > 0.5,
                opacityMul,
                sizeMul
            };
        }

        return points;
    }

    /**
     * Sample and upload positions + colors + vector field for image-based targets.
     * Returns { texture, colorTexture, width, height, fieldTexture, fieldSize }.
     */
    async sampleImageToTextureWithFieldAndColor(gl, imageSource, count, options = {}) {
        const opts = options || {};
        const fieldSize = Math.max(16, (opts.fieldSize ?? 128) | 0);
        // eslint-disable-next-line no-unused-vars
        const { fieldSize: _fs, ...packedOpts } = opts;

        const { data, colorData, width, height } = await this.sampleImagePacked(imageSource, count, packedOpts);
        const texture = createTexture2D(gl, {
            width,
            height,
            internalFormat: gl.RGBA32F,
            format: gl.RGBA,
            type: gl.FLOAT,
            data
        });

        const colorTexture = createTexture2D(gl, {
            width,
            height,
            internalFormat: gl.RGBA8,
            format: gl.RGBA,
            type: gl.UNSIGNED_BYTE,
            data: colorData,
            minFilter: gl.NEAREST,
            magFilter: gl.NEAREST
        });

        const fieldData = computeVectorFieldBytesFromPackedPositions(data, count, fieldSize);
        const fieldTexture = createTexture2D(gl, {
            width: fieldSize,
            height: fieldSize,
            internalFormat: gl.RGBA8,
            format: gl.RGBA,
            type: gl.UNSIGNED_BYTE,
            data: fieldData,
            minFilter: gl.LINEAR,
            magFilter: gl.LINEAR
        });

        return { texture, colorTexture, width, height, fieldTexture, fieldSize };
    }
}

function computeTextureSize(count) {
    const w = Math.ceil(Math.sqrt(count));
    const h = Math.ceil(count / w);
    return { width: w, height: h };
}

function imageHasTransparency(rgba, alphaThreshold) {
    const threshold = Math.max(0, Math.min(255, Number(alphaThreshold ?? 0)));
    for (let i = 3; i < rgba.length; i += 4) {
        if ((rgba[i] | 0) <= threshold) return true;
    }
    return false;
}

function estimateBackgroundLuma(rgba, w, h, alphaThreshold) {
    const samples = [];
    const minDim = Math.max(1, Math.min(w, h));
    const border = Math.max(1, Math.floor(minDim * 0.04));
    const step = Math.max(1, Math.floor(minDim / 128));

    const pushSample = (x, y) => {
        const o = (y * w + x) * 4;
        const a = rgba[o + 3] | 0;
        if (a <= alphaThreshold) return;
        const r = rgba[o + 0] | 0;
        const g = rgba[o + 1] | 0;
        const b = rgba[o + 2] | 0;
        const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b);
        samples.push(luma);
    };

    for (let y = 0; y < border; y += step) {
        for (let x = 0; x < w; x += step) pushSample(x, y);
    }
    for (let y = Math.max(0, h - border); y < h; y += step) {
        for (let x = 0; x < w; x += step) pushSample(x, y);
    }
    for (let y = border; y < Math.max(border, h - border); y += step) {
        for (let x = 0; x < border; x += step) pushSample(x, y);
        for (let x = Math.max(0, w - border); x < w; x += step) pushSample(x, y);
    }

    if (samples.length < 16) return null;
    samples.sort((a, b) => a - b);
    return samples[samples.length >> 1];
}

function buildMasks(rgba, w, h, alphaThreshold, opts = {}) {
    const fillMask = new Uint8Array(w * h);
    const edgeMask = new Uint8Array(w * h);
    const maskMode = String(opts.maskMode || 'alpha');
    const lumaThreshold = Math.max(0, Math.min(255, Number(opts.lumaThreshold ?? 12)));
    const weightByLuma = !!opts.weightByLuma;
    const lumaPower = Math.max(0.1, Number(opts.lumaPower ?? 1.0));
    const lumaReference = Number(opts.lumaReference ?? 0);
    const lumaContrast = !!opts.lumaContrast;
    const weights = weightByLuma ? new Float32Array(w * h) : null;

    let minX = w, minY = h, maxX = -1, maxY = -1;

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const o = i * 4;
            const a = rgba[o + 3] | 0;
            let filled = false;
            if (maskMode === 'luma') {
                const r = rgba[o + 0] | 0;
                const g = rgba[o + 1] | 0;
                const b = rgba[o + 2] | 0;
                const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b);
                const lumaMetric = lumaContrast ? Math.abs(luma - lumaReference) : luma;
                const aOk = a > alphaThreshold;
                filled = aOk && lumaMetric > lumaThreshold;
                if (weights) {
                    const aN = a / 255;
                    const lN = Math.max(0, Math.min(1, lumaMetric / 255));
                    weights[i] = Math.max(0, Math.min(1, Math.pow(lN, lumaPower) * aN));
                }
            } else {
                filled = a > alphaThreshold;
                if (weights) weights[i] = filled ? 1 : 0;
            }
            fillMask[i] = filled ? 1 : 0;
            if (filled) {
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
    }

    if (maxX < 0 || maxY < 0) return { fillMask, edgeMask, bounds: null };

    // Edge = filled pixel with any non-filled 4-neighbor
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const i = y * w + x;
            if (!fillMask[i]) continue;
            const left = x > 0 ? fillMask[i - 1] : 0;
            const right = x < w - 1 ? fillMask[i + 1] : 0;
            const up = y > 0 ? fillMask[i - w] : 0;
            const down = y < h - 1 ? fillMask[i + w] : 0;
            edgeMask[i] = (left && right && up && down) ? 0 : 1;
        }
    }

    return {
        fillMask,
        edgeMask,
        bounds: { minX, minY, maxX, maxY },
        weights
    };
}

function rejectionSampleMask({
    data,
    colorData,
    rgba,
    intensityPower = 1.0,
    outIdx,
    maxOut,
    mask,
    fillMask,
    bounds,
    size,
    rng,
    weights = null,
    maxAttemptsFactor = 30,
    edgeFlag = 0
}) {
    const { minX, minY, maxX, maxY } = bounds;
    const bw = Math.max(1, maxX - minX + 1);
    const bh = Math.max(1, maxY - minY + 1);
    const scale = 2 / Math.max(bw, bh);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const w = size;
    const h = size;

    const target = maxOut;
    let attempts = 0;
    const maxAttempts = Math.max(target * maxAttemptsFactor, 2000);

    while (outIdx < target && attempts < maxAttempts) {
        attempts++;
        const x = minX + Math.floor(rng() * bw);
        const y = minY + Math.floor(rng() * bh);
        const i = y * w + x;
        if (!mask[i]) continue;
        // avoid sampling points that are outside fill in edge mode (safety)
        if (!fillMask[i]) continue;
        if (weights) {
            const wv = weights[i];
            if (wv <= 1e-5) continue;
            if (rng() > wv) continue;
        }

        const ox = outIdx * 4;
        data[ox + 0] = (x - cx) * scale;
        data[ox + 1] = -(y - cy) * scale;
        data[ox + 2] = (rng() * 2 - 1) * 0.45; // modest depth
        data[ox + 3] = edgeFlag ? 1.0 : 0.0;

        if (colorData && rgba) {
            const ci = i * 4;
            const r = rgba[ci + 0] | 0;
            const g = rgba[ci + 1] | 0;
            const b = rgba[ci + 2] | 0;
            const a = rgba[ci + 3] | 0;
            const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b);
            const aN = a / 255;
            const lN = Math.max(0, Math.min(1, luma / 255));
            const intensity = Math.max(0, Math.min(1, Math.pow(lN, intensityPower) * aN));
            colorData[ox + 0] = r;
            colorData[ox + 1] = g;
            colorData[ox + 2] = b;
            colorData[ox + 3] = clampByte(intensity * 255);
        }
        outIdx++;
    }

    return outIdx;
}

function collectEdgeIndices(edgeMask, bounds, size) {
    if (!edgeMask || !bounds) return [];
    const { minX, minY, maxX, maxY } = bounds;
    const out = [];
    for (let y = minY; y <= maxY; y++) {
        const row = y * size;
        for (let x = minX; x <= maxX; x++) {
            const i = row + x;
            if (edgeMask[i]) out.push(i);
        }
    }
    return out;
}

function sampleEdgeAura({
    data,
    colorData,
    rgba,
    outIdx,
    maxOut,
    edgeIndices,
    fillMask,
    bounds,
    size,
    rng,
    spreadPx,
    outlierChance = 0.05,
    intensityPower = 1.0
}) {
    if (!edgeIndices || edgeIndices.length === 0 || !bounds) return outIdx;

    const { minX, minY, maxX, maxY } = bounds;
    const bw = Math.max(1, maxX - minX + 1);
    const bh = Math.max(1, maxY - minY + 1);
    const scale = 2 / Math.max(bw, bh);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const w = size;
    const h = size;
    const spread = Math.max(1, spreadPx);
    const jitter = Math.max(0.35, spread * 0.08);

    const target = maxOut;
    let attempts = 0;
    const maxAttempts = Math.max((target - outIdx) * 70, 4000);

    while (outIdx < target && attempts < maxAttempts) {
        attempts++;
        const edgeIdx = edgeIndices[(rng() * edgeIndices.length) | 0];
        const x = edgeIdx - ((edgeIdx / w) | 0) * w;
        const y = (edgeIdx / w) | 0;

        const left = x > 0 ? fillMask[edgeIdx - 1] : 0;
        const right = x < w - 1 ? fillMask[edgeIdx + 1] : 0;
        const up = y > 0 ? fillMask[edgeIdx - w] : 0;
        const down = y < h - 1 ? fillMask[edgeIdx + w] : 0;

        let dx = -(right - left);
        let dy = -(down - up);
        let mag = Math.hypot(dx, dy);
        if (mag < 1e-3) {
            dx = rng() * 2 - 1;
            dy = rng() * 2 - 1;
            mag = Math.hypot(dx, dy) || 1;
        }
        dx /= mag;
        dy /= mag;

        const t = Math.pow(rng(), 1.35);
        let r = t * spread;
        if (rng() < outlierChance) {
            r *= 2.0 + rng() * 2.5;
        }

        const fx = x + dx * r + (rng() * 2 - 1) * jitter;
        const fy = y + dy * r + (rng() * 2 - 1) * jitter;
        if (fx < 0 || fx >= w || fy < 0 || fy >= h) continue;

        const ix = fx | 0;
        const iy = fy | 0;
        const fi = iy * w + ix;
        if (fillMask[fi] && rng() > 0.2) continue;

        const ox = outIdx * 4;
        data[ox + 0] = (fx - cx) * scale;
        data[ox + 1] = -(fy - cy) * scale;
        data[ox + 2] = (rng() * 2 - 1) * 0.45;
        data[ox + 3] = 1.0;

        if (colorData && rgba) {
            const ci = edgeIdx * 4;
            const rC = rgba[ci + 0] | 0;
            const gC = rgba[ci + 1] | 0;
            const bC = rgba[ci + 2] | 0;
            const aC = rgba[ci + 3] | 0;
            const luma = (0.2126 * rC + 0.7152 * gC + 0.0722 * bC);
            const aN = aC / 255;
            const lN = Math.max(0, Math.min(1, luma / 255));
            const distN = Math.max(0, Math.min(1, r / spread));
            const fade = 0.08 + 0.92 * Math.pow(1 - distN, 1.45);
            const intensity = Math.max(0, Math.min(1, Math.pow(lN, intensityPower) * aN * fade));
            colorData[ox + 0] = rC;
            colorData[ox + 1] = gC;
            colorData[ox + 2] = bC;
            colorData[ox + 3] = clampByte(intensity * 255);
        }
        outIdx++;
    }

    return outIdx;
}

function rejectionSamplePoints({
    points,
    outIdx,
    maxOut,
    mask,
    fillMask,
    bounds,
    size,
    rng,
    cx,
    cy,
    scale,
    edge,
    color,
    maxAttemptsFactor = 30
}) {
    const { minX, minY, maxX, maxY } = bounds;
    const bw = Math.max(1, maxX - minX + 1);
    const bh = Math.max(1, maxY - minY + 1);
    const w = size;
    const h = size;

    const target = maxOut;
    let attempts = 0;
    const maxAttempts = Math.max((target - outIdx) * maxAttemptsFactor, 2000);

    while (outIdx < target && attempts < maxAttempts) {
        attempts++;
        const x = minX + Math.floor(rng() * bw);
        const y = minY + Math.floor(rng() * bh);
        const i = y * w + x;
        if (!mask[i]) continue;
        if (!fillMask[i]) continue;

        points[outIdx] = {
            x: (x - cx) * scale,
            y: -(y - cy) * scale,
            z: (rng() * 2 - 1) * 0.45,
            color,
            edge: !!edge
        };
        outIdx++;
    }

    return outIdx;
}

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
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(img, dx, dy, drawW, drawH);
    } finally {
        URL.revokeObjectURL(url);
    }
}

async function drawImageToCanvas(ctx, width, height, imageSource) {
    const img = await loadImageSource(imageSource);
    const iw = Math.max(1, img.naturalWidth || img.width || 1);
    const ih = Math.max(1, img.naturalHeight || img.height || 1);
    const scale = Math.min(width / iw, height / ih);
    const drawW = iw * scale;
    const drawH = ih * scale;
    const dx = (width - drawW) * 0.5;
    const dy = (height - drawH) * 0.5;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(img, dx, dy, drawW, drawH);
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
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = url;
    });
}

function loadImageSource(source) {
    if (source && typeof source === 'object') {
        if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) {
            return Promise.resolve(source);
        }
        if (source.image && typeof HTMLImageElement !== 'undefined' && source.image instanceof HTMLImageElement) {
            return Promise.resolve(source.image);
        }
        if (source.src) return loadImage(source.src);
    }
    return loadImage(String(source || ''));
}

function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
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

function mulberry32(seed) {
    let a = seed >>> 0;
    return function rng() {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function computeVectorFieldBytesFromPackedPositions(packedRgba32f, count, fieldSize) {
    const packed = packedRgba32f;
    const n = Math.max(0, count | 0);
    const S = Math.max(16, fieldSize | 0);
    const cells = S * S;
    if (!packed || packed.length < 4 || n <= 0) {
        // Neutral field: zero vector, zero magnitude.
        const out = new Uint8Array(cells * 4);
        for (let i = 0; i < out.length; i += 4) {
            out[i + 0] = 128;
            out[i + 1] = 128;
            out[i + 2] = 0;
            out[i + 3] = 255;
        }
        return out;
    }

    const density = new Float32Array(cells);
    // Use a stride for extremely large counts so build time stays bounded.
    const step = Math.max(1, Math.floor(n / 100000));
    for (let i = 0; i < n; i += step) {
        const o = i * 4;
        const x = packed[o + 0];
        const y = packed[o + 1];
        // Map normalized [-1,1] -> [0,1]
        const u = x * 0.5 + 0.5;
        const v = y * 0.5 + 0.5;
        const xi = clampInt((u * S) | 0, 0, S - 1);
        const yi = clampInt((v * S) | 0, 0, S - 1);
        density[yi * S + xi] += 1;
    }

    // A couple cheap blur passes to reduce speckle.
    const tmp = new Float32Array(cells);
    for (let pass = 0; pass < 2; pass++) {
        // Horizontal
        for (let y = 0; y < S; y++) {
            const row = y * S;
            for (let x = 0; x < S; x++) {
                let sum = density[row + x];
                let w = 1;
                if (x > 0) { sum += density[row + x - 1]; w++; }
                if (x < S - 1) { sum += density[row + x + 1]; w++; }
                tmp[row + x] = sum / w;
            }
        }
        // Vertical back into density
        for (let y = 0; y < S; y++) {
            const row = y * S;
            for (let x = 0; x < S; x++) {
                let sum = tmp[row + x];
                let w = 1;
                if (y > 0) { sum += tmp[row - S + x]; w++; }
                if (y < S - 1) { sum += tmp[row + S + x]; w++; }
                density[row + x] = sum / w;
            }
        }
    }

    // Compute gradient + track max magnitude for normalization.
    const gradX = new Float32Array(cells);
    const gradY = new Float32Array(cells);
    let maxMag = 0;
    for (let y = 0; y < S; y++) {
        const y0 = y > 0 ? y - 1 : y;
        const y1 = y < S - 1 ? y + 1 : y;
        for (let x = 0; x < S; x++) {
            const x0 = x > 0 ? x - 1 : x;
            const x1 = x < S - 1 ? x + 1 : x;
            const i = y * S + x;
            const dx = density[y * S + x1] - density[y * S + x0];
            const dy = density[y1 * S + x] - density[y0 * S + x];
            gradX[i] = dx;
            gradY[i] = dy;
            const m = Math.hypot(dx, dy);
            if (m > maxMag) maxMag = m;
        }
    }
    maxMag = Math.max(1e-6, maxMag);

    const out = new Uint8Array(cells * 4);
    const minFrac = 0.02; // suppress near-zero gradients (prevents noisy directions)
    const minMag = maxMag * minFrac;

    for (let i = 0; i < cells; i++) {
        const gx = gradX[i];
        const gy = gradY[i];
        const m = Math.hypot(gx, gy);
        const o = i * 4;

        if (m <= minMag) {
            out[o + 0] = 128;
            out[o + 1] = 128;
            out[o + 2] = 0;
            out[o + 3] = 255;
            continue;
        }

        const inv = 1.0 / Math.max(1e-8, m);
        const nx = gx * inv;
        const ny = gy * inv;
        // Blend inward pull with a swirl component for a “tornado-ish” feel.
        const sx = -ny;
        const sy = nx;
        let vx = nx * 0.65 + sx * 0.35;
        let vy = ny * 0.65 + sy * 0.35;
        const vm = Math.hypot(vx, vy);
        if (vm > 1e-6) {
            vx /= vm;
            vy /= vm;
        }

        const magN = Math.max(0, Math.min(1, m / maxMag));

        out[o + 0] = clampByte((vx * 0.5 + 0.5) * 255);
        out[o + 1] = clampByte((vy * 0.5 + 0.5) * 255);
        out[o + 2] = clampByte(magN * 255);
        out[o + 3] = 255;
    }

    return out;
}

function clampInt(v, min, max) {
    return Math.max(min, Math.min(max, v | 0));
}

function clampByte(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(255, n | 0));
}

function rgbToHex(r, g, b) {
    const toHex = (n) => {
        const v = Math.max(0, Math.min(255, n | 0));
        return v.toString(16).padStart(2, '0');
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
