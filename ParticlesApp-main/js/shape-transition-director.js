/**
 * shape-transition-director.js
 * Selects a shape-aware transition strategy per logo pair and evaluates it over time.
 *
 * The director is deterministic: (fromId,toId,userSeed,style) -> same strategy + params.
 */

import { SHAPE_STRATEGIES } from './shape-transition-strategies.js';

export class ShapeTransitionDirector {
    constructor({ userSeed = 1 } = {}) {
        this.userSeed = String(userSeed ?? 1);
    }

    /**
     * Start a transition instance.
     *
     * @param {object} args
     * @param {number|string} args.fromId
     * @param {number|string} args.toId
     * @param {number} args.durationSeconds
     * @param {'clean'|'chaotic'} args.style
     * @param {object} args.fromShape  LogoShape from analyzer (optional for single-logo)
     * @param {object} args.toShape    LogoShape from analyzer (required for shape heuristics)
     */
    start({ fromId, toId, durationSeconds = 2.5, style = 'chaotic', fromShape = null, toShape = null } = {}) {
        const s = (style === 'clean') ? 'clean' : 'chaotic';
        const pairKey = `${String(fromId)}->${String(toId)}|${this.userSeed}|${s}`;
        const seed = fnv1a32(pairKey);

        const strategyName = pickStrategyName({ seed, style: s, fromShape, toShape });
        const factory = SHAPE_STRATEGIES[strategyName] || SHAPE_STRATEGIES.OutlineFirstReveal;
        const strategy = factory();
        const instance = strategy.start({ seed, durationSeconds, style: s, fromShape, toShape });
        instance.fromId = fromId;
        instance.toId = toId;
        instance.seed = seed;
        instance.strategyName = strategy.name;
        instance.fromShape = fromShape;
        instance.toShape = toShape;
        instance.elapsed = 0;

        return { strategy, instance };
    }

    evaluate({ strategy, instance }, elapsedSeconds) {
        const tr = instance;
        tr.elapsed = Number(elapsedSeconds) || 0;
        const state = strategy.evaluate(tr, tr.elapsed);
        return {
            ...state,
            strategyName: tr.strategyName,
            seed: tr.seed
        };
    }
}

function pickStrategyName({ seed, style, toShape }) {
    // Simple heuristics:
    // - Stroke-like shapes should be outline-first
    // - Filled shapes can use SDF inflow (once fully wired)
    const strokeLikely = !!(toShape && toShape.metrics && toShape.metrics.strokeLikely);
    if (strokeLikely) return 'OutlineFirstReveal';

    // Deterministic selection to add variety across filled logos
    // (v1: alternate between OutlineFirstReveal and SdfInflow)
    const pick = seed % 2;
    if (pick === 0) return 'OutlineFirstReveal';
    return 'SdfInflow';
}

function fnv1a32(str) {
    const s = String(str || '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}


