/**
 * transition-director.js
 * Picks a (deterministic or random) chaotic transition preset per logo pair and provides a timeline.
 */
import { TRANSITION_PRESETS } from './transition-presets.js';
import { createTransitionScript, evaluateTransitionScript } from './transition-scripts.js';

export class TransitionDirector {
    constructor({ userSeed = 1, mode = 'deterministic' } = {}) {
        this.userSeed = String(userSeed ?? 1);
        this.presets = TRANSITION_PRESETS;
        this.mode = (mode === 'random') ? 'random' : 'deterministic';
        this._presetByName = new Map();
        for (const p of this.presets) this._presetByName.set(p.name, p);
    }

    /**
     * Start a new transition for a given pair.
     * `fromId` / `toId` should be stable per-logo identifiers (e.g. hash of svg string).
     */
    start({ fromId, toId, durationSeconds = 2.5, style = 'chaotic' } = {}) {
        const dur = Math.max(0.1, Number(durationSeconds) || 2.5);

        // Deterministic mode: stable per (from,to,userSeed,style).
        // Random mode: new seed every transition (still stable within a transition).
        const seed = (this.mode === 'random')
            ? randomSeed32()
            : fnv1a32(`${String(fromId)}->${String(toId)}|${this.userSeed}|${String(style || 'chaotic')}`);

        const rng = mulberry32(seed);
        const script = createTransitionScript(rng, { style, durationSeconds: dur });
        const preset = this._pickPresetForScript(rng, script.name);

        return {
            fromId,
            toId,
            seed,
            style: (style === 'clean') ? 'clean' : 'chaotic',
            scriptName: script.name,
            presetName: preset.name,
            duration: dur,
            params: { ...preset.buildParams(rng), ...(script.params || {}) },
            elapsed: 0
        };
    }

    /**
     * Evaluate transition at the given elapsed time.
     * Returns timeline curves + sim params (with small time-based modulation per preset).
     */
    evaluate(transition, elapsedSeconds) {
        const tr = transition || {};
        // Back-compat: if the caller passed a placeholder transition (app.js older flow),
        // auto-start it so downstream code always has params/preset/script.
        if (!tr.params || !tr.presetName) {
            const started = this.start({
                fromId: tr.fromId,
                toId: tr.toId,
                durationSeconds: tr.duration,
                style: tr._style || tr.style || 'chaotic'
            });
            // Preserve any caller-owned metadata (indices, shape analysis flags, etc).
            const preserved = { ...tr };
            Object.assign(tr, started, preserved);
        }

        const dur = Math.max(0.001, Number(tr.duration) || 1);
        const t = clamp01((Number(elapsedSeconds) || 0) / dur);

        // Script-driven curves (0..1) + extra script weights.
        const scriptCurves = evaluateTransitionScript(tr.scriptName, t);
        const morphT = scriptCurves.morphT;
        const scatterT = scriptCurves.scatterT;
        const chaosT = scriptCurves.chaosT;
        const attractT = scriptCurves.attractT;
        const settleT = scriptCurves.settleT;

        // Per-preset micro-behaviors (kept subtle; the signature comes mainly from param ranges)
        const params = { ...tr.params };
        if (tr.presetName === 'ShockwaveScatter') {
            const st = params.shockTime ?? 0.25;
            const s = params.shockStrength ?? 1.8;
            const spike = Math.exp(-Math.pow((t - st) / 0.06, 2));
            params.repulseStrength = (params.repulseStrength ?? 1.4) * (1.0 + spike * s);
        }

        if (tr.presetName === 'LiquidDripReverse') {
            // Bias motion field downward early; in GPU we’ll map this by nudging vortex centers.
            const b = params.dripBias ?? 0.7;
            const down = (1.0 - smoothstep(0.35, 0.75, t)) * b * 0.35;
            params.vortex1 = [params.vortex1[0], params.vortex1[1] - down];
            params.vortex2 = [params.vortex2[0], params.vortex2[1] - down * 0.7];
            params.vortex3 = [params.vortex3[0], params.vortex3[1] - down * 0.5];
        }

        if (tr.presetName === 'HelixPeel') {
            // Slightly tighten vortex radius mid-transition to feel like a peel/coil.
            const k = params.helixBias ?? 0.7;
            const mid = smoothstep(0.20, 0.55, t) * (1.0 - smoothstep(0.60, 0.90, t));
            params.vortexRadius = (params.vortexRadius ?? 0.6) * (1.0 - mid * 0.25 * k);
        }

        return {
            t,
            morphT,
            scatterT,
            chaosT,
            attractT,
            settleT,
            orbitT: scriptCurves.orbitT,
            burstT: scriptCurves.burstT,
            nextFieldT: scriptCurves.nextFieldT,
            ...params
        };
    }

    _pickPresetForScript(rng, scriptName) {
        const name = String(scriptName || '');
        // Intentionally biased mapping so scripts feel distinct without adding lots of new params.
        if (name === 'FireballBurst') {
            return this._presetByName.get('ShockwaveScatter') || this.presets[0];
        }
        if (name === 'OrbitLoop') {
            // HelixPeel tends to read as “circling” already.
            const a = this._presetByName.get('HelixPeel');
            const b = this._presetByName.get('VortexCollapse');
            return (rng() < 0.55 ? a : b) || this.presets[0];
        }
        if (name === 'SmokeNoise') {
            const a = this._presetByName.get('MurmurationFlow');
            const b = this._presetByName.get('VortexCollapse');
            return (rng() < 0.6 ? a : b) || this.presets[0];
        }
        // Fallback: pick any preset.
        return this.presets[(Math.floor(rng() * this.presets.length)) % this.presets.length];
    }
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

function fnv1a32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
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

function randomSeed32() {
    try {
        if (typeof crypto !== 'undefined' && crypto && crypto.getRandomValues) {
            const a = new Uint32Array(1);
            crypto.getRandomValues(a);
            return a[0] >>> 0;
        }
    } catch (_) { /* ignore */ }
    // Fallback
    return ((Math.random() * 4294967296) >>> 0);
}


