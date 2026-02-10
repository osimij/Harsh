/**
 * shape-transition-strategies.js
 * Strategy library for shape-aware transitions (Clean ↔ Chaotic).
 *
 * v1 focuses on OutlineFirstReveal + a Chaotic variant that reuses the existing director curves.
 */

export const SHAPE_STRATEGIES = {
    OutlineFirstReveal,
    SdfInflow
};

/**
 * Clean/Premium: edges “lock” first, then fills.
 * Works with vector sampling (edge flag) and raster fallback (edge flag).
 */
function OutlineFirstReveal() {
    return {
        name: 'OutlineFirstReveal',
        start({ seed = 1, durationSeconds = 2.5, style = 'clean' } = {}) {
            return {
                seed: seed >>> 0,
                style: style === 'chaotic' ? 'chaotic' : 'clean',
                duration: Math.max(0.25, Number(durationSeconds) || 2.5),
                elapsed: 0
            };
        },
        evaluate(tr, elapsedSeconds) {
            const dur = Math.max(0.001, Number(tr.duration) || 1);
            const t = clamp01((Number(elapsedSeconds) || 0) / dur);

            // Clean: minimal chaos + minimal scatter.
            // Chaotic: allow more scatter/chaos (still staged edge->fill).
            const isChaotic = tr.style === 'chaotic';

            const morphT = t;

            // Scatter curve: a gentle “lift” then settle.
            const scatterPeak = isChaotic ? 0.85 : 0.35;
            const scatterT = scatterPeak * (smoothstep(0.02, 0.22, t) * (1.0 - smoothstep(0.70, 0.92, t)));

            const chaosPeak = isChaotic ? 1.0 : 0.18;
            const chaosT = chaosPeak * (smoothstep(0.08, 0.35, t) * (1.0 - smoothstep(0.60, 0.92, t)));

            const attractT = smoothstep(0.30, 0.82, t);
            const settleT = smoothstep(0.70, 1.0, t);

            // Phase profile: edge first, then fill
            // Phase window controls how quickly each particle “joins”
            const phaseWindow = isChaotic ? 0.22 : 0.28;
            const edgeRange = isChaotic ? [0.06, 0.36] : [0.05, 0.32];
            const fillRange = isChaotic ? [0.30, 0.92] : [0.33, 0.88];

            return {
                t,
                morphT,
                scatterT,
                chaosT,
                attractT,
                settleT,
                phaseMode: 'edgeThenFill',
                phaseParams: {
                    phaseWindow,
                    edgeStart: edgeRange[0],
                    edgeEnd: edgeRange[1],
                    fillStart: fillRange[0],
                    fillEnd: fillRange[1]
                }
            };
        }
    };
}

/**
 * v1 placeholder: SDF-driven “inflow” for filled logos.
 * This strategy is defined now so wiring is stable; actual SDF usage is implemented
 * in the director + ParticleSystem profile phaseMode 'sdfFront'.
 */
function SdfInflow() {
    return {
        name: 'SdfInflow',
        start({ seed = 1, durationSeconds = 2.5, style = 'clean' } = {}) {
            return {
                seed: seed >>> 0,
                style: style === 'chaotic' ? 'chaotic' : 'clean',
                duration: Math.max(0.25, Number(durationSeconds) || 2.5),
                elapsed: 0
            };
        },
        evaluate(tr, elapsedSeconds) {
            const dur = Math.max(0.001, Number(tr.duration) || 1);
            const t = clamp01((Number(elapsedSeconds) || 0) / dur);
            const isChaotic = tr.style === 'chaotic';

            const morphT = t;
            const scatterPeak = isChaotic ? 0.95 : 0.25;
            const scatterT = scatterPeak * (smoothstep(0.02, 0.20, t) * (1.0 - smoothstep(0.65, 0.92, t)));
            const chaosPeak = isChaotic ? 1.0 : 0.12;
            const chaosT = chaosPeak * (smoothstep(0.06, 0.32, t) * (1.0 - smoothstep(0.55, 0.92, t)));
            const attractT = smoothstep(0.32, 0.80, t);
            const settleT = smoothstep(0.70, 1.0, t);

            return {
                t,
                morphT,
                scatterT,
                chaosT,
                attractT,
                settleT,
                phaseMode: 'sdfFront',
                phaseParams: {
                    // Placeholder params; director will translate SDF distances to per-particle phases.
                    phaseWindow: isChaotic ? 0.22 : 0.30,
                    // Controls how far from boundary counts as “early”
                    sdfBias: isChaotic ? 0.45 : 0.65
                }
            };
        }
    };
}

function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function smoothstep(edge0, edge1, x) {
    const t = clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}


