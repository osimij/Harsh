import { exportWebMVideo, exportPngZip } from '../../video-exporter.js';
import { GPUParticleSim } from '../../gpu-particle-sim.js';
import { TransitionDirector } from '../../transition-director.js';
import { MAX_PARTICLE_DENSITY } from '../constants.js';
import { parseHexColorToRgb01 } from '../utils/color.js';
import { applyVenomSimParams } from '../utils/venom.js';

/**
 * Export canvas as image
 */
export function exportImage(app, format, scale, { transparentBackground = false } = {}) {
    // Normalize/guard format
    let fmt = String(format || 'png').toLowerCase();
    if (fmt === 'jpeg') fmt = 'jpg';
    if (fmt !== 'png' && fmt !== 'webp' && fmt !== 'jpg') fmt = 'png';

    const wantsTransparentBackground = !!transparentBackground;
    // If the user requests transparency, force a transparency-capable format.
    if (wantsTransparentBackground && fmt === 'jpg') {
        fmt = 'png';
    }
    const formatSupportsAlpha = (fmt === 'png' || fmt === 'webp');
    const useTransparentBackground = wantsTransparentBackground && formatSupportsAlpha;

    // Render at higher resolution (explicit backing-store resize, not CSS resize)
    const originalWidth = app.canvas.width;
    const originalHeight = app.canvas.height;
    const requestedScale = Math.max(1, Number(scale) || 1);
    let exportWidth = Math.max(1, Math.round(originalWidth * requestedScale));
    let exportHeight = Math.max(1, Math.round(originalHeight * requestedScale));

    // Clamp to GPU limits to avoid "cut" (partial viewport / incomplete drawbuffer) at high resolutions.
    // Some devices clamp the drawing buffer silently when exceeding MAX_RENDERBUFFER_SIZE / MAX_VIEWPORT_DIMS.
    const gl = app && app.renderer && app.renderer.gl ? app.renderer.gl : null;
    if (gl) {
        const finitePositive = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : Infinity;
        const maxRB = finitePositive(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
        const maxTex = finitePositive(gl.getParameter(gl.MAX_TEXTURE_SIZE));
        const maxVP = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
        const maxVPW = finitePositive(maxVP && maxVP.length ? maxVP[0] : Infinity);
        const maxVPH = finitePositive(maxVP && maxVP.length ? maxVP[1] : Infinity);

        const limitW = Math.floor(Math.min(maxRB, maxTex, maxVPW));
        const limitH = Math.floor(Math.min(maxRB, maxTex, maxVPH));

        if ((exportWidth > limitW || exportHeight > limitH) && Number.isFinite(limitW) && Number.isFinite(limitH)) {
            const s = Math.min(limitW / exportWidth, limitH / exportHeight);
            const clampedW = Math.max(1, Math.floor(exportWidth * s));
            const clampedH = Math.max(1, Math.floor(exportHeight * s));
            console.warn(`Export size clamped from ${exportWidth}x${exportHeight} to ${clampedW}x${clampedH} (GPU limit ${limitW}x${limitH}).`);
            exportWidth = clampedW;
            exportHeight = clampedH;
        }
    }

    app.renderer.resizeTo(exportWidth, exportHeight);

    const activeLogoIndex = (app.logoSequence && app.logoSequence.active)
        ? (app.logoSequence.index || 0)
        : 0;
    const spriteInfo = (app && typeof app.getParticleIconSourceForLogoIndex === 'function')
        ? app.getParticleIconSourceForLogoIndex(activeLogoIndex)
        : null;
    const spriteEnabled = !!(app.settings.particleIconEnabled && spriteInfo);
    const targets = app.logoSequence && app.logoSequence.gpuTargets;
    const colorTextures = (targets && Array.isArray(targets.colorTextures)) ? targets.colorTextures : [];
    const items = (app.logoSequence && Array.isArray(app.logoSequence.items)) ? app.logoSequence.items : [];
    const activeType = items.length
        ? (items[activeLogoIndex] && items[activeLogoIndex].type) || 'svg'
        : ((app.logoSequence?.sourceType === 'image' || app.currentSourceType === 'image') ? 'image' : 'svg');
    const useColorTex = (activeType === 'image');
    const colorIdx = colorTextures.length ? Math.max(0, Math.min(activeLogoIndex, colorTextures.length - 1)) : 0;
    const colorFromTex = useColorTex ? colorTextures[colorIdx] : null;
    const colorToTex = useColorTex ? colorFromTex : null;
    const countRatio = (() => {
        if (app.logoSequence && Array.isArray(app.logoSequence.countRatios) && app.logoSequence.countRatios.length) {
            const r = app.logoSequence.countRatios[activeLogoIndex];
            return (typeof r === 'number') ? Math.max(0, Math.min(1, r)) : 1;
        }
        if (app.logoSequence && app.logoSequence.sourceType === 'mixed') {
            const pool = app.getDesiredParticleCount({ useMax: true });
            const desired = app.getDensityForType(activeType);
            return pool > 0 ? Math.max(0, Math.min(1, desired / pool)) : 1;
        }
        return 1;
    })();
    const colorTexBlend = activeType === 'image' ? 1 : 0;

    const renderSettings = {
        glowIntensity: app.settings.glowIntensity,
        depthVariance: app.settings.depthVariance,
        zoom: app.settings.zoom,
        rotationX: app.rotationX,
        rotationY: app.rotationY,
        // GPU visual controls (match live view)
        userSize: app.settings.size,
        sizeRandom: app.settings.sizeRandom,
        sizeMin: app.settings.sizeMin,
        sizeMax: app.settings.sizeMax,
        opacityRandom: app.settings.opacityRandom,
        opacityMin: app.settings.opacityMin,
        opacityMax: app.settings.opacityMax,
        squaresEnabled: app.settings.squaresEnabled,
        squareRatio: app.settings.squareRatio,
        realColors: app.settings.realColors,
        colorOverrideRgb: parseHexColorToRgb01(app.settings.colorMode),
        useColorOverride: (app.settings.colorMode && app.settings.colorMode !== 'original'),
        focusEnabled: app.settings.focusEnabled,
        focusCenterX: app.settings.focusCenterX,
        focusCenterY: app.settings.focusCenterY,
        focusRadius: app.settings.focusRadius,
        focusSoftness: app.settings.focusSoftness,
        focusScatter: app.settings.focusScatter,
        // Gradient overlay
        gradientOverlayEnabled: app.settings.gradientOverlayEnabled,
        gradientColorA: app.settings.gradientColorA,
        gradientColorB: app.settings.gradientColorB,
        gradientStrength: app.settings.gradientStrength,
        gradientDirection: app.settings.gradientDirection,
        sprite: spriteInfo,
        spriteEnabled,
        spriteRotate: app.settings.particleIconRotate,
        spriteColorMode: app.settings.particleIconColorMode,
        countRatio,
        colorTexBlend
    };

    // Render using the active engine (GPU if currently enabled + ready)
    if (app.shouldUseGPU() && app.gpu.sim) {
        const sim = app.gpu.sim;
        app.renderer.render({
            mode: 'gpu',
            count: sim.count,
            texWidth: sim.texWidth,
            texHeight: sim.texHeight,
            posTex: sim.getPositionTexture(),
            velTex: sim.getVelocityTexture(),
            randTex: sim.getRandomTexture(),
            time: sim.time,
            colorFromTex,
            colorToTex,
            useColorTex
        }, renderSettings);
    } else {
        app.renderer.render(app.particleSystem.getParticles(), renderSettings);
    }

    // Ensure all GPU commands are complete before reading back (prevents partial/cut captures on some drivers).
    try {
        if (gl) gl.finish();
    } catch (_) { /* ignore */ }

    // Get image data
    const mimeType = fmt === 'png' ? 'image/png' :
        fmt === 'webp' ? 'image/webp' : 'image/jpeg';
    const quality = fmt === 'png' ? 1.0 : 0.95;
    // Important: the app "background" is CSS behind the canvas, not pixels in the canvas.
    // Composite it in so exports match what the user sees.
    const dataUrl = (() => {
        try {
            const out = document.createElement('canvas');
            out.width = exportWidth;
            out.height = exportHeight;
            const ctx = out.getContext('2d');
            if (!ctx) return app.canvas.toDataURL(mimeType, quality);

            if (!useTransparentBackground) {
                // Base background (matches the UI color picker)
                const bg = String(app.settings?.backgroundColor || '#0a0a0f');
                ctx.fillStyle = bg;
                ctx.fillRect(0, 0, exportWidth, exportHeight);
            } else {
                // Ensure an alpha=0 base (explicit for clarity)
                ctx.clearRect(0, 0, exportWidth, exportHeight);
            }

            // Draw the rendered WebGL canvas on top
            ctx.drawImage(app.canvas, 0, 0, exportWidth, exportHeight);
            return out.toDataURL(mimeType, quality);
        } catch (e) {
            console.warn('Export composite failed; exporting raw canvas only.', e);
            return app.canvas.toDataURL(mimeType, quality);
        }
    })();

    // Download
    const link = document.createElement('a');
    link.download = `particle-forge-export${useTransparentBackground ? '-transparent' : ''}.${fmt}`;
    link.href = dataUrl;
    link.click();

    // Restore canvas size
    app.renderer.resizeTo(originalWidth, originalHeight);
    app.handleResize();

    // Close modal
    app.exportModal.classList.remove('active');
}

/**
 * Export a deterministic offline video render (WebCodecs -> WebM), with PNG ZIP fallback.
 * Requires GPU targets (density >= 200k) for the cinematic pipeline.
 */
export async function exportVideo(app, { format = 'webm', scale = 2, fps = 30 } = {}) {
    const desiredCount = app.getDesiredParticleCount();
    const useHighDensity = desiredCount >= 200000;

    if (!useHighDensity) {
        alert(`Video export requires High Density mode (200,000+ particles).\n\nThis build caps Particle Density at ${MAX_PARTICLE_DENSITY.toLocaleString()} for stability/performance. Use image export instead.`);
        return;
    }
    if (!app.gpu.supported || !app.renderer || !app.renderer.gl) {
        alert('GPU export requires WebGL2 + EXT_color_buffer_float (try Chrome).');
        return;
    }
    if (!app.renderer.gpuProgram) {
        alert('GPU rendering shaders failed to compile/link on this device, so video export is unavailable.');
        return;
    }

    // Ensure GPU targets exist (build if needed)
    const isMixedSource = app.logoSequence && app.logoSequence.sourceType === 'mixed';
    const isImageSource = (app.logoSequence && app.logoSequence.sourceType === 'image') || app.currentSourceType === 'image';
    const items = (app.logoSequence && Array.isArray(app.logoSequence.items)) ? app.logoSequence.items : [];
    const hasImageItems = isMixedSource
        ? items.some((item) => item && item.type === 'image')
        : isImageSource;
    const needBuild = !app.logoSequence.gpuTargets ||
        app.logoSequence.gpuTargets.count !== desiredCount ||
        !Array.isArray(app.logoSequence.gpuTargets.textures) ||
        app.logoSequence.gpuTargets.textures.length === 0 ||
        (hasImageItems && (!Array.isArray(app.logoSequence.gpuTargets.colorTextures) || app.logoSequence.gpuTargets.colorTextures.length === 0));

    if (needBuild) {
        try {
            if (isMixedSource) {
                if (app.logoSequence && Array.isArray(app.logoSequence.items) && app.logoSequence.items.length) {
                    await app.buildGPUTargetsForMixedSequence(app.logoSequence.items);
                } else {
                    throw new Error('No mixed items available for export.');
                }
            } else if (isImageSource) {
                if (app.logoSequence && app.logoSequence.active && Array.isArray(app.logoSequence.imageSources) && app.logoSequence.imageSources.length) {
                    await app.buildGPUTargetsForImageSequence(app.logoSequence.imageSources);
                } else {
                    await app.buildGPUTargetsForImage(app.currentImage);
                }
            } else if (app.logoSequence && app.logoSequence.active && app.logoSequence.svgStrings && app.logoSequence.svgStrings.length) {
                await app.buildGPUTargetsForSequence(app.logoSequence.svgStrings);
            } else {
                await app.buildGPUTargetsForSingle(app.currentSvgString);
            }
        } catch (e) {
            console.error(e);
            alert('Failed to build GPU targets for export.');
            return;
        }
    }

    const targets = app.logoSequence.gpuTargets;
    if (!targets || !targets.textures || !targets.textures.length) {
        alert('GPU targets are not ready yet.');
        return;
    }

    // Pause interactive loop
    const wasAnimating = app.isAnimating;
    app.stopAnimation();

    const originalWidth = app.canvas.width;
    const originalHeight = app.canvas.height;
    const exportWidth = Math.max(1, (originalWidth * (scale | 0)) | 0);
    const exportHeight = Math.max(1, (originalHeight * (scale | 0)) | 0);

    try {
        // Force export resolution
        app.renderer.resizeTo(exportWidth, exportHeight);

        const gl = app.renderer.gl;
        const sim = new GPUParticleSim(gl, { count: desiredCount, seed: app.settings.transitionSeed });

        const textures = targets.textures;
        const fieldTextures = (targets && targets.fieldTextures && targets.fieldTextures.length) ? targets.fieldTextures : [];
        const colorTextures = (targets && Array.isArray(targets.colorTextures)) ? targets.colorTextures : [];
        const logoIds = (app.logoSequence && app.logoSequence.logoIds && app.logoSequence.logoIds.length)
            ? app.logoSequence.logoIds
            : textures.map((_, i) => i);
        const poolCount = desiredCount;
        const getTypeForIndex = (idx) => {
            if (items && items.length) {
                const item = items[Math.max(0, Math.min(idx, items.length - 1))];
                return (item && item.type) ? String(item.type) : 'svg';
            }
            return isImageSource ? 'image' : 'svg';
        };
        const getCountRatioForIndex = (idx, type) => {
            if (app.logoSequence && Array.isArray(app.logoSequence.countRatios) && app.logoSequence.countRatios.length) {
                const r = app.logoSequence.countRatios[idx];
                if (typeof r === 'number') return Math.max(0, Math.min(1, r));
            }
            if (isMixedSource) {
                const desired = app.getDensityForType(type);
                return poolCount > 0 ? Math.max(0, Math.min(1, desired / poolCount)) : 1;
            }
            return 1;
        };

        // Export pipeline expects deterministic output for the same settings.
        const director = new TransitionDirector({ userSeed: app.settings.transitionSeed, mode: 'deterministic' });

        const transitionSeconds = Math.max(0.25, Number(app.settings.cycleSeconds) || 2.5);
        const holdSeconds = Math.max(0, Number(app.settings.holdSeconds) || 0);
        const fr = Math.max(1, fps | 0);
        const dt = 1 / fr;

        const sequenceActive = textures.length > 1;
        const transitionsCount = sequenceActive ? textures.length : 1; // loop back to start
        const totalSeconds = transitionsCount * (transitionSeconds + holdSeconds);
        const frameCount = Math.max(1, Math.round(totalSeconds * fr));

	        const renderSettings = {
	            glowIntensity: app.settings.glowIntensity,
	            depthVariance: app.settings.depthVariance,
	            zoom: app.settings.zoom,
	            rotationX: app.rotationX,
	            rotationY: app.rotationY,
	            // GPU visual controls (match live view)
	            userSize: app.settings.size,
	            sizeRandom: app.settings.sizeRandom,
	            sizeMin: app.settings.sizeMin,
	            sizeMax: app.settings.sizeMax,
	            opacityRandom: app.settings.opacityRandom,
	            opacityMin: app.settings.opacityMin,
	            opacityMax: app.settings.opacityMax,
	            squaresEnabled: app.settings.squaresEnabled,
	            squareRatio: app.settings.squareRatio,
	            realColors: app.settings.realColors,
	            colorOverrideRgb: parseHexColorToRgb01(app.settings.colorMode),
	            useColorOverride: (app.settings.colorMode && app.settings.colorMode !== 'original'),
	            focusEnabled: app.settings.focusEnabled,
	            focusCenterX: app.settings.focusCenterX,
	            focusCenterY: app.settings.focusCenterY,
	            focusRadius: app.settings.focusRadius,
	            focusSoftness: app.settings.focusSoftness,
	            focusScatter: app.settings.focusScatter,
	            // Gradient overlay (GPU export path)
	            gradientOverlayEnabled: app.settings.gradientOverlayEnabled,
	            gradientColorA: app.settings.gradientColorA,
	            gradientColorB: app.settings.gradientColorB,
            gradientStrength: app.settings.gradientStrength,
            gradientDirection: app.settings.gradientDirection,
            spriteRotate: app.settings.particleIconRotate,
            spriteColorMode: app.settings.particleIconColorMode
        };

        const stableState = { morphT: 1, scatterT: 0, chaosT: 0, attractT: 1, settleT: 1 };

        let currentIndex = (app.logoSequence && typeof app.logoSequence.index === 'number')
            ? Math.max(0, Math.min(app.logoSequence.index, textures.length - 1))
            : 0;
        let transition = null;
        let holdTimer = 0;

        const startTex = textures[currentIndex];
        sim.setTargets({ fromTex: startTex, toTex: startTex });
        sim.setToFieldTexture(fieldTextures[currentIndex] || null);
        sim.reset();

        const renderFrame = async (_frameIdx, _tSec, _dtSec) => {
            let targetFromTex = null;
            let targetToTex = null;
            let colorFromTex = null;
            let colorToTex = null;
            let useColorTex = false;
            let colorTexBlend = 0;
            let frameCountRatio = 1;
            let fromType = null;
            let toType = null;
            let usedState = stableState;

            const stepSim = (dtSec, baseState) => {
                if (app.settings && app.settings.venomMode) {
                    const simParams = { ...baseState };
                    const morphT = (typeof simParams.morphT === 'number') ? simParams.morphT : 1;
                    const chaosT = (typeof simParams.chaosT === 'number') ? simParams.chaosT : 0;
                    const strength = (typeof app.settings.venomStrength === 'number')
                        ? app.settings.venomStrength
                        : 0.7;
                    applyVenomSimParams(simParams, { time: sim.time + dtSec, morphT, chaosT, strength });
                    sim.step(dtSec, simParams);
                    return;
                }
                sim.step(dtSec, baseState);
            };

            // Determine current state + targets
            if (!sequenceActive) {
                const tex = textures[0];
                sim.setTargets({ fromTex: tex, toTex: tex });
                sim.setToFieldTexture(fieldTextures[0] || null);
                usedState = stableState;
                targetFromTex = tex;
                targetToTex = tex;
                fromType = getTypeForIndex(0);
                toType = fromType;
                frameCountRatio = getCountRatioForIndex(0, fromType);
                useColorTex = fromType === 'image';
                colorTexBlend = useColorTex ? 1 : 0;
                if (useColorTex) {
                    const ctex = colorTextures[0] || null;
                    colorFromTex = ctex;
                    colorToTex = ctex;
                }
                stepSim(_dtSec, usedState);
            } else if (holdTimer > 0) {
                holdTimer = Math.max(0, holdTimer - _dtSec);
                const tex = textures[currentIndex];
                sim.setTargets({ fromTex: tex, toTex: tex });
                sim.setToFieldTexture(fieldTextures[currentIndex] || null);
                usedState = stableState;
                targetFromTex = tex;
                targetToTex = tex;
                fromType = getTypeForIndex(currentIndex);
                toType = fromType;
                frameCountRatio = getCountRatioForIndex(currentIndex, fromType);
                useColorTex = fromType === 'image';
                colorTexBlend = useColorTex ? 1 : 0;
                if (useColorTex) {
                    const ctex = colorTextures[currentIndex] || null;
                    colorFromTex = ctex;
                    colorToTex = ctex;
                }
                stepSim(_dtSec, usedState);
            } else {
                if (!transition) {
                    const fromIndex = currentIndex;
                    const toIndex = (fromIndex + 1) % textures.length;
                    const fromId = logoIds[fromIndex] ?? fromIndex;
                    const toId = logoIds[toIndex] ?? toIndex;
                    transition = director.start({ fromId, toId, durationSeconds: transitionSeconds });
                    transition.fromIndex = fromIndex;
                    transition.toIndex = toIndex;
                    sim.setTargets({ fromTex: textures[fromIndex], toTex: textures[toIndex] });
                    sim.setToFieldTexture(fieldTextures[toIndex] || null);
                }

                transition.elapsed += _dtSec;
                const state = director.evaluate(transition, transition.elapsed);
                usedState = state;
                fromType = getTypeForIndex(transition.fromIndex);
                toType = getTypeForIndex(transition.toIndex);
                const fromRatio = getCountRatioForIndex(transition.fromIndex, fromType);
                const toRatio = getCountRatioForIndex(transition.toIndex, toType);
                const tMorph = (state && typeof state.morphT === 'number')
                    ? Math.max(0, Math.min(1, state.morphT))
                    : 0;
                frameCountRatio = fromRatio + (toRatio - fromRatio) * tMorph;
                useColorTex = (fromType === 'image' || toType === 'image');
                if (fromType === 'image' && toType === 'image') {
                    colorTexBlend = 1;
                } else if (fromType === 'image') {
                    colorTexBlend = 1 - tMorph;
                } else if (toType === 'image') {
                    colorTexBlend = tMorph;
                } else {
                    colorTexBlend = 0;
                }
                targetFromTex = textures[transition.fromIndex] || null;
                targetToTex = textures[transition.toIndex] || targetFromTex;
                if (useColorTex) {
                    colorFromTex = colorTextures[transition.fromIndex] || null;
                    colorToTex = colorTextures[transition.toIndex] || colorFromTex;
                }
                stepSim(_dtSec, usedState);

                if (transition.elapsed >= transition.duration) {
                    currentIndex = transition.toIndex;
                    transition = null;
                    holdTimer = holdSeconds;
                }
            }

            const spriteInfo = (app && typeof app.getParticleIconSourceForLogoIndex === 'function')
                ? app.getParticleIconSourceForLogoIndex(currentIndex)
                : null;
            const spriteEnabled = !!(app.settings.particleIconEnabled && spriteInfo);

            app.renderer.render({
                mode: 'gpu',
                count: sim.count,
                texWidth: sim.texWidth,
                texHeight: sim.texHeight,
                posTex: sim.getPositionTexture(),
                velTex: sim.getVelocityTexture(),
                randTex: sim.getRandomTexture(),
                time: sim.time,
                targetFromTex,
                targetToTex,
                colorFromTex,
                colorToTex,
                useColorTex
            }, {
                ...renderSettings,
                morphT: (usedState && typeof usedState.morphT === 'number') ? usedState.morphT : 1,
                countRatio: frameCountRatio,
                colorTexBlend,
                sprite: spriteInfo,
                spriteEnabled
            });
        };

        let blob;
        let filename;
        try {
            blob = await exportWebMVideo({
                canvas: app.canvas,
                width: exportWidth,
                height: exportHeight,
                fps: fr,
                frameCount,
                renderFrame,
                // VP9 is a good default in Chromium; users can transcode to ProRes later.
                codec: 'vp09.00.10.08',
                bitrate: exportWidth >= 3000 ? 50_000_000 : 25_000_000
            });
            filename = `particle-forge-export.${format || 'webm'}`;
        } catch (e) {
            console.warn('WebCodecs export failed, falling back to PNG ZIP:', e);
            blob = await exportPngZip({
                canvas: app.canvas,
                frameCount,
                renderFrame: async (i) => renderFrame(i, i / fr, dt),
                filePrefix: 'frame'
            });
            filename = 'particle-forge-export-frames.zip';
        } finally {
            try { sim.dispose(); } catch (_) { /* ignore */ }
        }

        downloadBlob(blob, filename);
        app.exportModal.classList.remove('active');
    } catch (err) {
        console.error(err);
        alert('Video export failed.');
    } finally {
        // Restore canvas resolution and resume
        app.renderer.resizeTo(originalWidth, originalHeight);
        app.handleResize();
        if (wasAnimating) app.startAnimation();
    }
}

export function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatTimestampForFilename(d = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

export class ExportController {
    constructor({ appCompat }) {
        this.app = appCompat;
    }

    exportImage(format, scale, opts) {
        return exportImage(this.app, format, scale, opts);
    }

    exportVideo(opts) {
        return exportVideo(this.app, opts);
    }

    downloadBlob(blob, filename) {
        return downloadBlob(blob, filename);
    }

    formatTimestampForFilename(d = new Date()) {
        return formatTimestampForFilename(d);
    }
}
