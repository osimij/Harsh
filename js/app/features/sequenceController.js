import { TransitionDirector } from '../../transition-director.js';
import { ShapeTransitionDirector } from '../../shape-transition-director.js';
import { computeSdf } from '../../sdf.js';
import { clamp01 } from '../utils/color.js';
import { logger } from '../utils/logger.js';

/**
 * Drive multi-logo morphing via deterministic TransitionDirector (continuous 0→1 timeline).
 */
export function tickLogoSequence(app, deltaTime) {
    if (!app.logoSequence || !app.logoSequence.active) return;
    const clouds = app.logoSequence.pointClouds || [];
    const items = Array.isArray(app.logoSequence.items) ? app.logoSequence.items : [];
    const sequenceLength = Math.max(clouds.length, items.length);
    if (sequenceLength < 2) return;

    const sourceType = app.logoSequence && app.logoSequence.sourceType;
    const isImageSequence = sourceType === 'image';
    const isMixedSequence = sourceType === 'mixed';
    const useGPU = app.shouldUseGPU();
    const sim = useGPU ? app.ensureGPUSim() : null;

    // CPU fallback needs initialized particles; GPU mode uses textures + sim.
    if (!useGPU && app.particleSystem.getCount() === 0) return;

    const dt = Math.max(0, deltaTime || 0);

    // Refresh director seed if user changed it via future UI.
    if (!app.transitionDirector || String(app.transitionDirector.userSeed) !== String(app.settings.transitionSeed)) {
        app.transitionDirector = new TransitionDirector({ userSeed: app.settings.transitionSeed, mode: 'random' });
        app.shapeTransitionDirector = new ShapeTransitionDirector({ userSeed: app.settings.transitionSeed });
    }

    // Hold fully formed between transitions (optional).
    if ((app.logoSequence.holdTimer || 0) > 0) {
        app.logoSequence.holdTimer -= dt;
        const holdIndex = Math.max(0, Math.min(app.logoSequence.index || 0, sequenceLength - 1));
        const holdType = isMixedSequence && items[holdIndex] && items[holdIndex].type
            ? items[holdIndex].type
            : (isImageSequence ? 'image' : 'svg');
        const holdRatio = (() => {
            if (app.logoSequence && Array.isArray(app.logoSequence.countRatios) && app.logoSequence.countRatios.length) {
                const r = app.logoSequence.countRatios[holdIndex];
                return (typeof r === 'number') ? clamp01(r) : 1;
            }
            const pool = app.getDesiredParticleCount({ useMax: true });
            const desired = app.getDensityForType(holdType);
            return pool > 0 ? clamp01(desired / pool) : 1;
        })();
        const holdState = {
            morphT: 1,
            scatterT: 0,
            chaosT: 0,
            attractT: 1,
            settleT: 1,
            countRatio: holdRatio
        };

        if (useGPU && sim && app.logoSequence.gpuTargets) {
            const textures = app.logoSequence.gpuTargets.textures || [];
            const idx = Math.max(0, Math.min(app.logoSequence.index, textures.length - 1));
            const tex = textures[idx];
            if (tex) {
                sim.setTargets({ fromTex: tex, toTex: tex });
                const targets = app.logoSequence.gpuTargets;
                const ftex = (targets && targets.fieldTextures && targets.fieldTextures.length)
                    ? targets.fieldTextures[Math.max(0, Math.min(idx, targets.fieldTextures.length - 1))]
                    : null;
                sim.setToFieldTexture(ftex);
            }
            app.gpu.transitionState = holdState;
        } else {
            // Keep CPU particles settled at the to-shape during hold.
            app.particleSystem.setTransitionState?.(holdState);
        }

        if (app.logoSequence.holdTimer <= 0) {
            app.logoSequence.holdTimer = 0;
        }
        return;
    }

    // Start a new deterministic transition when none is running.
    if (!app.logoSequence.transition) {
        const fromIndex = app.logoSequence.index;
        const toIndex = (fromIndex + 1) % sequenceLength;
        const fromId = (app.logoSequence.logoIds && app.logoSequence.logoIds[fromIndex]) || fromIndex;
        const toId = (app.logoSequence.logoIds && app.logoSequence.logoIds[toIndex]) || toIndex;

        const duration = Math.max(0.5, Number(app.settings.cycleSeconds) || 12);
        // Shape-aware director (CPU path). GPU path still uses the old director for now.
        const style = (app.settings && app.settings.transitionStyle === 'clean') ? 'clean' : 'chaotic';
        const fromType = isMixedSequence && items[fromIndex] && items[fromIndex].type
            ? items[fromIndex].type
            : (isImageSequence ? 'image' : 'svg');
        const toType = isMixedSequence && items[toIndex] && items[toIndex].type
            ? items[toIndex].type
            : (isImageSequence ? 'image' : 'svg');
        const fromSvg = (fromType === 'svg' && app.logoSequence.svgStrings && app.logoSequence.svgStrings[fromIndex]) || null;
        const toSvg = (toType === 'svg' && app.logoSequence.svgStrings && app.logoSequence.svgStrings[toIndex]) || null;
        const rasterSize = (app.settings && app.settings.shapeRasterSize) ? app.settings.shapeRasterSize : 384;

        // Start the legacy director immediately so GPU + CPU fallback have stable params.
        // (Shape-aware strategy may override curves later on CPU once analysis is ready.)
        const started = app.transitionDirector.start({
            fromId,
            toId,
            durationSeconds: duration,
            style
        });
        if (typeof window !== 'undefined' && window && window.DEBUG_TRANSITIONS) {
            console.log(`[Transition] script=${started.scriptName} preset=${started.presetName} seed=${started.seed}`);
        }

        const tr = {
            ...started,
            fromIndex,
            toIndex,
            _shapeReady: false,
            _shape: null,
            _profileApplied: false,
            _style: style,
            _rasterSize: rasterSize,
            _fromSvg: fromSvg,
            _toSvg: toSvg,
            _fromType: fromType,
            _toType: toType
        };
        app.logoSequence.transition = tr;

        if (fromType === 'svg') {
            app.svgData = (app.logoSequence.svgDatas && app.logoSequence.svgDatas[fromIndex]) || app.svgData;
        } else {
            app.svgData = null;
        }
        if (useGPU && sim && app.logoSequence.gpuTargets) {
            const textures = app.logoSequence.gpuTargets.textures || [];
            const fromTex = textures[fromIndex];
            const toTex = textures[toIndex];
            if (fromTex && toTex) {
                sim.setTargets({ fromTex, toTex });
                const targets = app.logoSequence.gpuTargets;
                const ftex = (targets && targets.fieldTextures && targets.fieldTextures.length)
                    ? targets.fieldTextures[Math.max(0, Math.min(toIndex, targets.fieldTextures.length - 1))]
                    : null;
                sim.setToFieldTexture(ftex);
            }
        } else {
            // Prepare a continuous morph: CPU fallback uses morph targets + external scatter curve.
            const targetCloud = clouds[toIndex];
            if (targetCloud && targetCloud.length) {
                app.particleSystem.morphTo(targetCloud);
            }
        }

        // Kick off async shape analysis (cached, so usually fast after first run).
        if (!useGPU && fromType === 'svg' && toType === 'svg' && app.settings.shapeAwareTransitions && app.shapeAnalyzer && app.shapeTransitionDirector && toSvg) {
            const currentToken = `${fromId}->${toId}|${style}|${rasterSize}`;
            tr._shapeToken = currentToken;
            Promise.all([
                fromSvg ? app.shapeAnalyzer.analyze(fromSvg, { rasterSize }) : Promise.resolve(null),
                app.shapeAnalyzer.analyze(toSvg, { rasterSize })
            ]).then(([fromShape, toShape]) => {
                if (!app.logoSequence || app.logoSequence.transition !== tr) return;
                if (tr._shapeToken !== currentToken) return;
                const started = app.shapeTransitionDirector.start({
                    fromId,
                    toId,
                    durationSeconds: duration,
                    style,
                    fromShape,
                    toShape
                });
                tr._shape = started;
                tr._shapeReady = true;
                tr._profileApplied = false;
            }).catch((e) => {
                logger.warn('Shape analysis failed, falling back to old transition director:', e);
            });
        }
    }

    const tr = app.logoSequence.transition;
    tr.elapsed = (tr.elapsed || 0) + dt;
    const state = (!useGPU && tr._shapeReady && tr._shape)
        ? app.shapeTransitionDirector.evaluate(tr._shape, tr.elapsed)
        : app.transitionDirector.evaluate(tr, tr.elapsed);
    if (state) {
        const fromType = tr._fromType || (isImageSequence ? 'image' : 'svg');
        const toType = tr._toType || (isImageSequence ? 'image' : 'svg');
        const fromRatio = (() => {
            if (app.logoSequence && Array.isArray(app.logoSequence.countRatios) && app.logoSequence.countRatios.length) {
                const r = app.logoSequence.countRatios[tr.fromIndex];
                return (typeof r === 'number') ? clamp01(r) : 1;
            }
            const pool = app.getDesiredParticleCount({ useMax: true });
            const desired = app.getDensityForType(fromType);
            return pool > 0 ? clamp01(desired / pool) : 1;
        })();
        const toRatio = (() => {
            if (app.logoSequence && Array.isArray(app.logoSequence.countRatios) && app.logoSequence.countRatios.length) {
                const r = app.logoSequence.countRatios[tr.toIndex];
                return (typeof r === 'number') ? clamp01(r) : 1;
            }
            const pool = app.getDesiredParticleCount({ useMax: true });
            const desired = app.getDensityForType(toType);
            return pool > 0 ? clamp01(desired / pool) : 1;
        })();
        const t = (typeof state.morphT === 'number') ? clamp01(state.morphT) : 0;
        state.countRatio = fromRatio + (toRatio - fromRatio) * t;
    }
    if (useGPU) {
        app.gpu.transitionState = state;
    } else {
        app.particleSystem.setTransitionState?.(state);
        // Apply per-particle staging profile when available (shape-aware path).
        if (tr._shapeReady && state && state.phaseMode && !tr._profileApplied) {
            let phaseParams = state.phaseParams || {};
            // For SDF-based staging, attach SDF buffers (cached on the shape object).
            if (state.phaseMode === 'sdfFront' && tr._shape && tr._shape.instance && tr._shape.instance.toShape) {
                const toShape = tr._shape.instance.toShape;
                if (toShape && toShape.fillMask && toShape.width && toShape.height) {
                    if (!toShape._sdfCache) {
                        const computed = computeSdf(toShape.fillMask, toShape.width, toShape.height);
                        // Cache max positive inside distance for normalization
                        let maxInside = 0;
                        const sdfArr = computed.sdf;
                        for (let i = 0; i < sdfArr.length; i++) {
                            const v = sdfArr[i];
                            if (v > maxInside) maxInside = v;
                        }
                        toShape._sdfCache = computed;
                        toShape._sdfMaxInside = maxInside;
                    }

                    const isClean = (app.settings && app.settings.transitionStyle === 'clean');
                    phaseParams = {
                        ...phaseParams,
                        sdf: toShape._sdfCache.sdf,
                        sdfWidth: toShape._sdfCache.width,
                        sdfHeight: toShape._sdfCache.height,
                        norm: toShape.norm,
                        maxInside: toShape._sdfMaxInside || 1,
                        // Staging parameters (tuned)
                        fillStart: isClean ? 0.10 : 0.06,
                        fillEnd: isClean ? 0.92 : 0.96,
                        power: isClean ? 1.7 : 1.05
                    };
                }
            }

            app.particleSystem.setTransitionProfile?.({
                phaseMode: state.phaseMode,
                phaseParams
            });
            tr._profileApplied = true;
        }
    }

    if (tr.elapsed >= tr.duration) {
        // Finalize transition
        app.logoSequence.index = tr.toIndex;
        const finalType = tr._toType || (isImageSequence ? 'image' : 'svg');
        if (finalType === 'svg') {
            app.svgData = (app.logoSequence.svgDatas && app.logoSequence.svgDatas[app.logoSequence.index]) || app.svgData;
            app.currentSvgString = (app.logoSequence.svgStrings && app.logoSequence.svgStrings[app.logoSequence.index]) || app.currentSvgString;
            app.currentImage = null;
            app.currentSourceType = 'svg';
        } else {
            app.svgData = null;
            app.currentSvgString = null;
            app.currentImage = (app.logoSequence.imageSources && app.logoSequence.imageSources[app.logoSequence.index]) || app.currentImage;
            app.currentSourceType = 'image';
        }
        app.logoSequence.transition = null;

        const settleRatio = (() => {
            if (app.logoSequence && Array.isArray(app.logoSequence.countRatios) && app.logoSequence.countRatios.length) {
                const r = app.logoSequence.countRatios[app.logoSequence.index];
                return (typeof r === 'number') ? clamp01(r) : 1;
            }
            const pool = app.getDesiredParticleCount({ useMax: true });
            const desired = app.getDensityForType(finalType);
            return pool > 0 ? clamp01(desired / pool) : 1;
        })();
        const settleState = {
            morphT: 1,
            scatterT: 0,
            chaosT: 0,
            attractT: 1,
            settleT: 1,
            countRatio: settleRatio
        };

        if (useGPU && sim && app.logoSequence.gpuTargets) {
            const textures = app.logoSequence.gpuTargets.textures || [];
            const idx = Math.max(0, Math.min(app.logoSequence.index, textures.length - 1));
            const tex = textures[idx];
            if (tex) {
                sim.setTargets({ fromTex: tex, toTex: tex });
                const targets = app.logoSequence.gpuTargets;
                const ftex = (targets && targets.fieldTextures && targets.fieldTextures.length)
                    ? targets.fieldTextures[Math.max(0, Math.min(idx, targets.fieldTextures.length - 1))]
                    : null;
                sim.setToFieldTexture(ftex);
            }
            app.gpu.transitionState = settleState;
        } else {
            // Commit CPU morph and settle
            app.particleSystem.setTransitionState?.(settleState);
            app.particleSystem.commitMorphTargets?.();
            app.particleSystem.clearTransitionProfile?.();
        }

        const hold = Math.max(0, Number(app.settings.holdSeconds) || 0);
        app.logoSequence.holdTimer = hold;
    }
}

/**
 * Single-logo dissolve/reform cycle driven by the same shape-aware staging system.
 * This runs only when no logo sequence is active (CPU path).
 */
export function tickSingleLogoCycle(app, deltaTime) {
    if (app.logoSequence && app.logoSequence.active) return;
    if (!app.settings || !app.particleSystem) return;
    const hasSource = !!(app.svgData || app.currentImage || (app.logoSequence && app.logoSequence.sourceType === 'image'));
    if (!hasSource || app.particleSystem.getCount() === 0) return;

    const isImageSource = (app.currentSourceType === 'image') || (app.logoSequence && app.logoSequence.sourceType === 'image');

    // If user disabled dissolve cycle, clear external transition control.
    if (!app.settings.dissolveCycle || !app.settings.shapeAwareTransitions) {
        app._singleShapeTransition = null;
        app.particleSystem.clearTransitionState?.();
        app.particleSystem.clearTransitionProfile?.();
        return;
    }

    const dt = Math.max(0, deltaTime || 0);
    const style = (app.settings.transitionStyle === 'clean') ? 'clean' : 'chaotic';
    const rasterSize = app.settings.shapeRasterSize || 384;
    const logoKey = isImageSource
        ? (app.currentImage && (app.currentImage.src || app.currentImage.name)) || ''
        : (app.currentSvgString || '');
    const logoId = app.hashString32(logoKey);

    const cycleSeconds = Math.max(0.25, Number(app.settings.cycleSeconds || 12));
    const holdSeconds = Math.max(0, Number(app.settings.holdSeconds || 0));
    const totalSeconds = holdSeconds + cycleSeconds;

    const key = `${logoId}|${style}|${rasterSize}|${cycleSeconds}|${holdSeconds}|${String(app.settings.transitionSeed)}`;
    if (!app._singleShapeTransition || app._singleShapeTransition.key !== key) {
        app._singleShapeTransition = {
            key,
            time: 0,
            ready: false,
            profileApplied: false,
            shape: null
        };

        const svg = isImageSource ? null : app.currentSvgString;
        if (svg && app.shapeAnalyzer && app.shapeTransitionDirector) {
            app.shapeAnalyzer.analyze(svg, { rasterSize }).then((toShape) => {
                if (!app._singleShapeTransition || app._singleShapeTransition.key !== key) return;
                const started = app.shapeTransitionDirector.start({
                    fromId: logoId,
                    toId: logoId,
                    durationSeconds: cycleSeconds,
                    style,
                    fromShape: toShape,
                    toShape
                });
                app._singleShapeTransition.shape = started;
                app._singleShapeTransition.ready = true;
                app._singleShapeTransition.profileApplied = false;
            }).catch((e) => {
                logger.warn('Single-logo shape analysis failed:', e);
            });
        }
    }

    const st = app._singleShapeTransition;
    st.time = (st.time || 0) + dt;

    // Hold fully formed
    const tMod = (st.time % totalSeconds);
    if (tMod < holdSeconds) {
        const holdState = { morphT: 1, scatterT: 0, chaosT: 0, attractT: 1, settleT: 1 };
        app.particleSystem.setTransitionState?.(holdState);
        // Keep profile (if applied) so the next reform remains staged.
        return;
    }

    const local = tMod - holdSeconds;                 // 0..cycleSeconds
    const phase = clamp01(local / cycleSeconds);      // 0..1
    const scatterT = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2); // 0->1->0

    // Only stage the reform half (scatter decreasing): morphT ramps 0..1 in the second half.
    const reformT = phase <= 0.5 ? 0 : (phase - 0.5) / 0.5;
    const morphT = clamp01(reformT);

    const chaosBase = Math.max(0, Math.min(1, Number(app.settings.chaos ?? 0.75)));
    const chaosT = (style === 'clean') ? Math.min(0.18, chaosBase * 0.25) : chaosBase;

    const state = {
        morphT,
        scatterT,
        chaosT,
        attractT: 1.0 - scatterT,
        settleT: Math.pow(1.0 - scatterT, 1.35)
    };
    app.particleSystem.setTransitionState?.(state);

    // Apply a staging profile once (phases persist across cycles).
    if (st.ready && !st.profileApplied && st.shape) {
        const eval0 = app.shapeTransitionDirector.evaluate(st.shape, 0);
        if (eval0 && eval0.phaseMode) {
            let phaseParams = eval0.phaseParams || {};

            if (eval0.phaseMode === 'sdfFront' && st.shape.instance && st.shape.instance.toShape) {
                const toShape = st.shape.instance.toShape;
                if (toShape && toShape.fillMask && toShape.width && toShape.height) {
                    if (!toShape._sdfCache) {
                        const computed = computeSdf(toShape.fillMask, toShape.width, toShape.height);
                        let maxInside = 0;
                        const sdfArr = computed.sdf;
                        for (let i = 0; i < sdfArr.length; i++) {
                            const v = sdfArr[i];
                            if (v > maxInside) maxInside = v;
                        }
                        toShape._sdfCache = computed;
                        toShape._sdfMaxInside = maxInside;
                    }
                    const isClean = (style === 'clean');
                    phaseParams = {
                        ...phaseParams,
                        sdf: toShape._sdfCache.sdf,
                        sdfWidth: toShape._sdfCache.width,
                        sdfHeight: toShape._sdfCache.height,
                        norm: toShape.norm,
                        maxInside: toShape._sdfMaxInside || 1,
                        fillStart: isClean ? 0.10 : 0.06,
                        fillEnd: isClean ? 0.92 : 0.96,
                        power: isClean ? 1.7 : 1.05
                    };
                }
            }

            app.particleSystem.setTransitionProfile?.({
                phaseMode: eval0.phaseMode,
                phaseParams
            });
            st.profileApplied = true;
        }
    }
}

export class SequenceController {
    constructor({ appCompat }) {
        this.app = appCompat;
    }

    tickLogoSequence(deltaTime) {
        return tickLogoSequence(this.app, deltaTime);
    }

    tickSingleLogoCycle(deltaTime) {
        return tickSingleLogoCycle(this.app, deltaTime);
    }
}
