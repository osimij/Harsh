import { GPUParticleSim } from '../../gpu-particle-sim.js';
import { createTexture2D } from '../../gl-utils.js';
import { parseHexColorToRgb01 } from '../utils/color.js';

export function detectGPUSupport(app) {
    try {
        const gl = app.renderer && app.renderer.gl;
        if (!gl || app.renderer.fallbackToCanvas2D) {
            app.gpu.supported = false;
            return;
        }
        // Create a tiny sim to validate required extensions; dispose immediately.
        const probe = new GPUParticleSim(gl, { count: 1, seed: app.settings.transitionSeed });
        probe.dispose();
        app.gpu.supported = true;
    } catch (e) {
        console.warn('GPU sim not supported:', e);
        app.gpu.supported = false;
    }
}

export function shouldUseGPU(app) {
    const desiredCount = app.getDesiredParticleCount();
    const gl = app.renderer && app.renderer.gl;
    const targets = app.logoSequence && app.logoSequence.gpuTargets;
    const rendererHasGPU = !!(app.renderer && app.renderer.gpuProgram);
    const enabled = !!(app && app.settings && app.settings.fluidGPU) || desiredCount >= 200000;
    return !!(app.gpu.supported &&
        gl &&
        rendererHasGPU &&
        enabled &&
        targets &&
        Array.isArray(targets.textures) &&
        targets.textures.length > 0 &&
        targets.count === desiredCount &&
        desiredCount > 0);
}

export function ensureGPUSim(app) {
    if (!shouldUseGPU(app)) return null;
    const gl = app.renderer.gl;
    const desiredCount = app.getDesiredParticleCount();
    const targets = app.logoSequence.gpuTargets;

    if (app.gpu.sim && app.gpu.sim.count === desiredCount) {
        return app.gpu.sim;
    }

    // Recreate for new particle counts
    if (app.gpu.sim) {
        try { app.gpu.sim.dispose(); } catch (_) { /* ignore */ }
    }

    const sim = new GPUParticleSim(gl, { count: desiredCount, seed: app.settings.transitionSeed });
    app.gpu.sim = sim;

    // Default to current logo target (from=to) so it settles into a formed state.
    const idx = (app.logoSequence && app.logoSequence.index) || 0;
    const tex = targets.textures[Math.max(0, Math.min(idx, targets.textures.length - 1))];
    sim.setTargets({ fromTex: tex, toTex: tex });
    const fieldTex = (targets.fieldTextures && targets.fieldTextures.length)
        ? targets.fieldTextures[Math.max(0, Math.min(idx, targets.fieldTextures.length - 1))]
        : null;
    sim.setToFieldTexture(fieldTex);

    // If we have the packed RGBA32F position buffer for this target (built from point clouds),
    // seed the sim from the logo so we don't show the default random cube on startup.
    const packed = (targets.packedPositions && targets.packedPositions.length)
        ? targets.packedPositions[Math.max(0, Math.min(idx, targets.packedPositions.length - 1))]
        : null;
    if (packed && packed.length >= sim.capacity * 4) {
        sim.reset({ posData: packed });
    } else {
        sim.reset();
    }

    return sim;
}

export function disposeSequenceGPUTargets(app) {
    const gl = app.renderer && app.renderer.gl;
    const targets = app.logoSequence && app.logoSequence.gpuTargets;
    if (!gl || !targets || !targets.textures) return;
    for (const t of targets.textures) {
        try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
    }
    if (targets.colorTextures && targets.colorTextures.length) {
        for (const t of targets.colorTextures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
    }
    if (targets.fieldTextures && targets.fieldTextures.length) {
        for (const t of targets.fieldTextures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
    }
    app.logoSequence.gpuTargets = null;

    // If a GPU sim is running, its target references are now invalid.
    if (app.gpu && app.gpu.sim) {
        try { app.gpu.sim.dispose(); } catch (_) { /* ignore */ }
        app.gpu.sim = null;
        app.gpu.transitionState = null;
    }
}

export async function buildGPUTargetsForSingle(app, svgString) {
    const gl = app.renderer && app.renderer.gl;
    if (!app.gpu.supported || !gl) return;
    if (!svgString) return;

    const desiredCount = (typeof app.getDesiredParticleCount === 'function')
        ? app.getDesiredParticleCount({ type: 'svg' })
        : Math.max(100, parseInt(app.settings.density, 10) || 15000);
    // Only build when we're in the “GPU territory” (high-density) OR user explicitly enabled fluid GPU mode.
    if (desiredCount < 200000 && !(app.settings && app.settings.fluidGPU)) return;

    const token = ++app._gpuTargetBuildToken;
    const rasterSize = desiredCount >= 800000 ? 4096 : 2048;

    const { texture, fieldTexture, fieldSize, width, height } = await app.rasterPointSampler.sampleToTextureWithField(gl, svgString, desiredCount, {
        rasterSize,
        seed: app.settings.transitionSeed,
        fieldSize: 128,
        edgeAuraEnabled: app.settings.edgeAuraEnabled,
        edgeAuraAmount: app.settings.edgeAuraAmount,
        edgeAuraSpread: app.settings.edgeAuraSpread,
        edgeAuraOutlier: app.settings.edgeAuraOutlier
    });
    if (token !== app._gpuTargetBuildToken) {
        gl.deleteTexture(texture);
        gl.deleteTexture(fieldTexture);
        return;
    }

    // Store as a “sequence” of one for unified handling later
    disposeSequenceGPUTargets(app);
    app.logoSequence.gpuTargets = {
        textures: [texture],
        colorTextures: null,
        fieldTextures: [fieldTexture],
        fieldSize: fieldSize || 128,
        width,
        height,
        count: desiredCount
    };
}

export async function buildGPUTargetsForSequence(app, svgStrings) {
    const gl = app.renderer && app.renderer.gl;
    if (!app.gpu.supported || !gl) return;
    const list = Array.isArray(svgStrings) ? svgStrings : [];
    if (!list.length) return;

    const desiredCount = (typeof app.getDesiredParticleCount === 'function')
        ? app.getDesiredParticleCount({ type: 'svg' })
        : Math.max(100, parseInt(app.settings.density, 10) || 15000);
    if (desiredCount < 200000 && !(app.settings && app.settings.fluidGPU)) return;

    const token = ++app._gpuTargetBuildToken;
    const rasterSize = desiredCount >= 800000 ? 4096 : 2048;

    const textures = [];
    const fieldTextures = [];
    let fieldSize = 128;
    let texW = 0, texH = 0;
    try {
        for (const s of list) {
            // eslint-disable-next-line no-await-in-loop
            const { texture, fieldTexture, fieldSize: fs, width, height } = await app.rasterPointSampler.sampleToTextureWithField(gl, s, desiredCount, {
                rasterSize,
                seed: app.settings.transitionSeed,
                fieldSize: 128,
                edgeAuraEnabled: app.settings.edgeAuraEnabled,
                edgeAuraAmount: app.settings.edgeAuraAmount,
                edgeAuraSpread: app.settings.edgeAuraSpread,
                edgeAuraOutlier: app.settings.edgeAuraOutlier
            });

            if (token !== app._gpuTargetBuildToken) {
                // A newer build started; stop early and clean up.
                gl.deleteTexture(texture);
                gl.deleteTexture(fieldTexture);
                break;
            }

            texW = width;
            texH = height;
            fieldSize = fs || fieldSize;
            textures.push(texture);
            fieldTextures.push(fieldTexture);
        }
    } catch (e) {
        // Avoid leaking any textures created before the failure.
        for (const t of textures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        for (const t of fieldTextures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        throw e;
    }

    if (token !== app._gpuTargetBuildToken) {
        // A newer build started; clean up what we created
        for (const t of textures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        for (const t of fieldTextures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        return;
    }

    // If we failed to build all textures (e.g. rasterization error), don't leave a partial sequence.
    if (textures.length !== list.length) {
        for (const t of textures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        for (const t of fieldTextures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        throw new Error('Failed to build GPU targets for one or more SVGs.');
    }

    disposeSequenceGPUTargets(app);
    app.logoSequence.gpuTargets = {
        textures,
        colorTextures: null,
        fieldTextures,
        fieldSize,
        width: texW,
        height: texH,
        count: desiredCount
    };
}

export async function buildGPUTargetsForImage(app, imageInfo) {
    const gl = app.renderer && app.renderer.gl;
    if (!app.gpu.supported || !gl) return;
    if (!imageInfo) return;

    const desiredCount = (typeof app.getDesiredParticleCount === 'function')
        ? app.getDesiredParticleCount({ type: 'image' })
        : Math.max(100, parseInt(app.settings.density, 10) || 15000);
    if (desiredCount < 200000 && !(app.settings && app.settings.fluidGPU)) return;

    const token = ++app._gpuTargetBuildToken;
    const rasterSize = desiredCount >= 800000 ? 4096 : 2048;

    const { texture, colorTexture, fieldTexture, fieldSize, width, height } =
        await app.rasterPointSampler.sampleImageToTextureWithFieldAndColor(gl, imageInfo, desiredCount, {
            rasterSize,
            seed: app.settings.transitionSeed,
            fieldSize: 128,
            lumaThreshold: 10,
            lumaWeightPower: 1.15,
            intensityPower: 1.05,
            edgeRatio: 0.3,
            edgeAuraEnabled: app.settings.edgeAuraEnabled,
            edgeAuraAmount: app.settings.edgeAuraAmount,
            edgeAuraSpread: app.settings.edgeAuraSpread,
            edgeAuraOutlier: app.settings.edgeAuraOutlier
        });

    if (token !== app._gpuTargetBuildToken) {
        gl.deleteTexture(texture);
        gl.deleteTexture(colorTexture);
        gl.deleteTexture(fieldTexture);
        return;
    }

    disposeSequenceGPUTargets(app);
    app.logoSequence.gpuTargets = {
        textures: [texture],
        colorTextures: [colorTexture],
        fieldTextures: [fieldTexture],
        fieldSize: fieldSize || 128,
        width,
        height,
        count: desiredCount
    };
}

export async function buildGPUTargetsForImageSequence(app, imageInfos) {
    const gl = app.renderer && app.renderer.gl;
    if (!app.gpu.supported || !gl) return;
    const list = Array.isArray(imageInfos) ? imageInfos : [];
    if (!list.length) return;

    const desiredCount = (typeof app.getDesiredParticleCount === 'function')
        ? app.getDesiredParticleCount({ type: 'image' })
        : Math.max(100, parseInt(app.settings.density, 10) || 15000);
    if (desiredCount < 200000 && !(app.settings && app.settings.fluidGPU)) return;

    const token = ++app._gpuTargetBuildToken;
    const rasterSize = desiredCount >= 800000 ? 4096 : 2048;

    const textures = [];
    const colorTextures = [];
    const fieldTextures = [];
    let fieldSize = 128;
    let texW = 0, texH = 0;

    try {
        for (const info of list) {
            // eslint-disable-next-line no-await-in-loop
            const { texture, colorTexture, fieldTexture, fieldSize: fs, width, height } =
                await app.rasterPointSampler.sampleImageToTextureWithFieldAndColor(gl, info, desiredCount, {
                    rasterSize,
                    seed: app.settings.transitionSeed,
                    fieldSize: 128,
                    lumaThreshold: 10,
                    lumaWeightPower: 1.15,
                    intensityPower: 1.05,
                    edgeRatio: 0.3,
                    edgeAuraEnabled: app.settings.edgeAuraEnabled,
                    edgeAuraAmount: app.settings.edgeAuraAmount,
                    edgeAuraSpread: app.settings.edgeAuraSpread,
                    edgeAuraOutlier: app.settings.edgeAuraOutlier
                });

            if (token !== app._gpuTargetBuildToken) {
                gl.deleteTexture(texture);
                gl.deleteTexture(colorTexture);
                gl.deleteTexture(fieldTexture);
                break;
            }

            texW = width;
            texH = height;
            fieldSize = fs || fieldSize;
            textures.push(texture);
            colorTextures.push(colorTexture);
            fieldTextures.push(fieldTexture);
        }
    } catch (e) {
        for (const t of textures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        for (const t of colorTextures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        for (const t of fieldTextures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        throw e;
    }

    if (token !== app._gpuTargetBuildToken) {
        for (const t of textures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        for (const t of colorTextures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        for (const t of fieldTextures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        return;
    }

    if (textures.length !== list.length) {
        for (const t of textures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        for (const t of colorTextures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        for (const t of fieldTextures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        throw new Error('Failed to build GPU targets for one or more images.');
    }

    disposeSequenceGPUTargets(app);
    app.logoSequence.gpuTargets = {
        textures,
        colorTextures,
        fieldTextures,
        fieldSize,
        width: texW,
        height: texH,
        count: desiredCount
    };
}

export async function buildGPUTargetsForMixedSequence(app, items) {
    const gl = app.renderer && app.renderer.gl;
    if (!app.gpu.supported || !gl) return;
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return;

    const desiredCount = (typeof app.getDesiredParticleCount === 'function')
        ? app.getDesiredParticleCount({ useMax: true })
        : Math.max(100, parseInt(app.settings.density, 10) || 15000);
    if (desiredCount < 200000 && !(app.settings && app.settings.fluidGPU)) return;

    const token = ++app._gpuTargetBuildToken;
    const rasterSize = desiredCount >= 800000 ? 4096 : 2048;

    const textures = [];
    const colorTextures = [];
    const fieldTextures = [];
    let fieldSize = 128;
    let texW = 0, texH = 0;

    try {
        for (const item of list) {
            const type = item && item.type ? String(item.type) : 'svg';
            if (type === 'image') {
                const info = item.imageInfo || item.image || item;
                // eslint-disable-next-line no-await-in-loop
                const { texture, colorTexture, fieldTexture, fieldSize: fs, width, height } =
                    await app.rasterPointSampler.sampleImageToTextureWithFieldAndColor(gl, info, desiredCount, {
                        rasterSize,
                        seed: app.settings.transitionSeed,
                        fieldSize: 128,
                        lumaThreshold: 10,
                        lumaWeightPower: 1.15,
                        intensityPower: 1.05,
                        edgeRatio: 0.3,
                        edgeAuraEnabled: app.settings.edgeAuraEnabled,
                        edgeAuraAmount: app.settings.edgeAuraAmount,
                        edgeAuraSpread: app.settings.edgeAuraSpread,
                        edgeAuraOutlier: app.settings.edgeAuraOutlier
                    });

                if (token !== app._gpuTargetBuildToken) {
                    gl.deleteTexture(texture);
                    gl.deleteTexture(colorTexture);
                    gl.deleteTexture(fieldTexture);
                    break;
                }

                texW = width;
                texH = height;
                fieldSize = fs || fieldSize;
                textures.push(texture);
                colorTextures.push(colorTexture);
                fieldTextures.push(fieldTexture);
            } else {
                const svgString = item.svgString || item.svg || item;
                // eslint-disable-next-line no-await-in-loop
                const { texture, fieldTexture, fieldSize: fs, width, height } =
                    await app.rasterPointSampler.sampleToTextureWithField(gl, svgString, desiredCount, {
                        rasterSize,
                        seed: app.settings.transitionSeed,
                        fieldSize: 128,
                        edgeAuraEnabled: app.settings.edgeAuraEnabled,
                        edgeAuraAmount: app.settings.edgeAuraAmount,
                        edgeAuraSpread: app.settings.edgeAuraSpread,
                        edgeAuraOutlier: app.settings.edgeAuraOutlier
                    });

                if (token !== app._gpuTargetBuildToken) {
                    gl.deleteTexture(texture);
                    gl.deleteTexture(fieldTexture);
                    break;
                }

                texW = width;
                texH = height;
                fieldSize = fs || fieldSize;
                textures.push(texture);
                colorTextures.push(null);
                fieldTextures.push(fieldTexture);
            }
        }
    } catch (e) {
        for (const t of textures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        for (const t of colorTextures) {
            try { if (t) gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        for (const t of fieldTextures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        throw e;
    }

    if (token !== app._gpuTargetBuildToken) {
        for (const t of textures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        for (const t of colorTextures) {
            try { if (t) gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        for (const t of fieldTextures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        return;
    }

    if (textures.length !== list.length) {
        for (const t of textures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        for (const t of colorTextures) {
            try { if (t) gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        for (const t of fieldTextures) {
            try { gl.deleteTexture(t); } catch (_) { /* ignore */ }
        }
        throw new Error('Failed to build GPU targets for one or more mixed items.');
    }

    disposeSequenceGPUTargets(app);
    app.logoSequence.gpuTargets = {
        textures,
        colorTextures,
        fieldTextures,
        fieldSize,
        width: texW,
        height: texH,
        count: desiredCount
    };
}

export class GPUController {
    constructor({ appCompat }) {
        this.app = appCompat;
    }

    detectGPUSupport() {
        return detectGPUSupport(this.app);
    }

    shouldUseGPU() {
        return shouldUseGPU(this.app);
    }

    ensureGPUSim() {
        return ensureGPUSim(this.app);
    }

    disposeSequenceGPUTargets() {
        return disposeSequenceGPUTargets(this.app);
    }

    buildGPUTargetsForSingle(svgString) {
        return buildGPUTargetsForSingle(this.app, svgString);
    }

    buildGPUTargetsForSequence(svgStrings) {
        return buildGPUTargetsForSequence(this.app, svgStrings);
    }

    buildGPUTargetsForImage(imageInfo) {
        return buildGPUTargetsForImage(this.app, imageInfo);
    }

    buildGPUTargetsForImageSequence(imageInfos) {
        return buildGPUTargetsForImageSequence(this.app, imageInfos);
    }

    buildGPUTargetsForMixedSequence(items) {
        return buildGPUTargetsForMixedSequence(this.app, items);
    }

    /**
     * Build GPU target textures directly from already-sampled point clouds (fast; avoids rasterizing).
     * This is used by the "Fluid Motion (GPU)" toggle for normal interactive densities.
     */
    buildGPUTargetsFromPointClouds(pointClouds, { fieldSize = 128 } = {}) {
        return buildGPUTargetsFromPointClouds(this.app, pointClouds, { fieldSize });
    }
}

export function buildGPUTargetsFromPointClouds(app, pointClouds, { fieldSize = 128 } = {}) {
    const gl = app.renderer && app.renderer.gl;
    if (!app || !app.gpu || !app.gpu.supported || !gl) return;
    const rendererHasGPU = !!(app.renderer && app.renderer.gpuProgram);
    if (!rendererHasGPU) return;

    const clouds = Array.isArray(pointClouds) ? pointClouds : [];
    if (!clouds.length) return;

    const desiredCount = (typeof app.getDesiredParticleCount === 'function')
        ? app.getDesiredParticleCount()
        : Math.max(100, parseInt(app.settings?.density, 10) || 15000);

    // Allocate textures sized for this count (must match sim tex size).
    const { width, height } = computeTextureSize(desiredCount);
    const cap = width * height;

    // Replace any previous targets first (frees VRAM and invalidates any sim).
    disposeSequenceGPUTargets(app);

    const textures = [];
    const colorTextures = [];
    const fieldTextures = [];
    const packedPositions = [];
    const packedColors = [];
    const fs = Math.max(16, fieldSize | 0);

    for (const cloud of clouds) {
        const packed = packPointCloudToRGBA32F(cloud, desiredCount, cap);
        const texture = createTexture2D(gl, {
            width,
            height,
            internalFormat: gl.RGBA32F,
            format: gl.RGBA,
            type: gl.FLOAT,
            data: packed,
            minFilter: gl.NEAREST,
            magFilter: gl.NEAREST
        });
        textures.push(texture);
        packedPositions.push(packed);

        const packedColor = packPointCloudToRGBA8Colors(cloud, desiredCount, cap);
        const colorTexture = createTexture2D(gl, {
            width,
            height,
            internalFormat: gl.RGBA8,
            format: gl.RGBA,
            type: gl.UNSIGNED_BYTE,
            data: packedColor,
            minFilter: gl.NEAREST,
            magFilter: gl.NEAREST
        });
        colorTextures.push(colorTexture);
        packedColors.push(packedColor);

        // Optional: build a low-res “next-logo field” texture for more organic pulls.
        const fieldData = computeVectorFieldBytesFromPackedPositions(packed, desiredCount, fs);
        const fieldTexture = createTexture2D(gl, {
            width: fs,
            height: fs,
            internalFormat: gl.RGBA8,
            format: gl.RGBA,
            type: gl.UNSIGNED_BYTE,
            data: fieldData,
            minFilter: gl.LINEAR,
            magFilter: gl.LINEAR
        });
        fieldTextures.push(fieldTexture);
    }

    // Store for unified handling (even for a single logo).
    if (!app.logoSequence) app.logoSequence = {};
    app.logoSequence.gpuTargets = {
        textures,
        colorTextures,
        fieldTextures,
        packedPositions,
        packedColors,
        fieldSize: fs,
        width,
        height,
        count: desiredCount
    };
}

function computeTextureSize(count) {
    const n = Math.max(1, count | 0);
    const w = Math.ceil(Math.sqrt(n));
    const h = Math.ceil(n / w);
    return { width: w, height: h };
}

function packPointCloudToRGBA32F(points, count, capacity) {
    const cap = Math.max(1, capacity | 0);
    const out = new Float32Array(cap * 4);
    const src = Array.isArray(points) ? points : [];
    const n = src.length;
    const target = Math.max(0, count | 0);
    const safeN = Math.max(1, n);

    for (let i = 0; i < target && i < cap; i++) {
        const p = src[n ? i % safeN : 0];
        const o = i * 4;
        out[o + 0] = (p && Number.isFinite(p.x)) ? p.x : 0;
        out[o + 1] = (p && Number.isFinite(p.y)) ? p.y : 0;
        out[o + 2] = (p && Number.isFinite(p.z)) ? p.z : 0;
        out[o + 3] = (p && p.edge) ? 1.0 : 0.0;
    }
    return out;
}

function packPointCloudToRGBA8Colors(points, count, capacity) {
    const cap = Math.max(1, capacity | 0);
    const out = new Uint8Array(cap * 4);
    const src = Array.isArray(points) ? points : [];
    const n = src.length;
    const target = Math.max(0, count | 0);
    const safeN = Math.max(1, n);

    for (let i = 0; i < target && i < cap; i++) {
        const p = src[n ? i % safeN : 0] || {};
        const color = parseHexColorToRgb01(p.color || '#d4d4d8');
        const o = i * 4;
        out[o + 0] = clampByte((color[0] || 0) * 255);
        out[o + 1] = clampByte((color[1] || 0) * 255);
        out[o + 2] = clampByte((color[2] || 0) * 255);
        const alpha = Number.isFinite(p.opacityMul) ? p.opacityMul : 1.0;
        out[o + 3] = clampByte(Math.max(0, Math.min(1, alpha)) * 255);
    }
    return out;
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
