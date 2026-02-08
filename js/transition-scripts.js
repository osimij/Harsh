/**
 * transition-scripts.js
 * Expressive “in-between” motion scripts for chaotic logo transitions.
 *
 * A script controls additional force weights over time (orbit, burst, nextLogoField)
 * and also shapes the existing curves (scatter/chaos/attract/settle).
 */

function clamp01(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function smoothstep(edge0, edge1, x) {
    const t = clamp01((x - edge0) / (edge1 - edge0));
    return t * t * (3 - 2 * t);
}

function range(rng, min, max) {
    return min + (max - min) * rng();
}

function pickWeighted(rng, items) {
    let total = 0;
    for (const it of items) total += Math.max(0, Number(it.weight) || 0);
    if (total <= 0) return items[0];
    let r = rng() * total;
    for (const it of items) {
        r -= Math.max(0, Number(it.weight) || 0);
        if (r <= 0) return it;
    }
    return items[items.length - 1];
}

function bump(t, a, b, fade = 0.06) {
    const f = Math.max(1e-4, fade);
    const inW = smoothstep(a, Math.min(a + f, b), t);
    const outW = 1.0 - smoothstep(Math.max(a, b - f), b, t);
    return clamp01(inW * outW);
}

export function createTransitionScript(rng, {
    style = 'chaotic',
    durationSeconds = 2.5,
    nextFieldChance = 0.75
} = {}) {
    const s = (style === 'clean') ? 'clean' : 'chaotic';
    const dur = Math.max(0.1, Number(durationSeconds) || 2.5);

    if (s === 'clean') {
        return {
            name: 'CleanMorph',
            useNextField: false,
            params: {
                orbitCenter: [0, 0],
                orbitRadius: 0.6,
                orbitOmega: 0,
                orbitGain: 0,
                orbitRingK: 0,
                burstCenter: [0, 0],
                burstStrength: 0,
                nextFieldStrength: 0
            }
        };
    }

    const choice = pickWeighted(rng, [
        { name: 'OrbitLoop', weight: 0.34 },
        { name: 'SmokeNoise', weight: 0.33 },
        { name: 'FireballBurst', weight: 0.33 }
    ]);

    const useNextField = rng() < clamp01(nextFieldChance);

    // Common centers slightly offset so it doesn't feel perfectly symmetrical every time.
    const commonCenter = [range(rng, -0.10, 0.10), range(rng, -0.10, 0.10)];

    if (choice.name === 'OrbitLoop') {
        const orbitCenter = commonCenter;
        const orbitRadius = range(rng, 0.42, 0.88);
        const loops = (rng() < 0.55) ? 1 : 2;
        const orbitWindow = 0.60; // mid-phase portion of the timeline
        const omega = (Math.PI * 2 * loops) / Math.max(0.12, dur * orbitWindow);
        const orbitOmega = omega * (rng() < 0.5 ? -1 : 1);
        return {
            name: 'OrbitLoop',
            useNextField,
            params: {
                orbitCenter,
                orbitRadius,
                orbitOmega,
                orbitGain: range(rng, 2.2, 4.8),
                orbitRingK: range(rng, 4.0, 9.0),
                burstCenter: commonCenter,
                burstStrength: 0,
                nextFieldStrength: useNextField ? range(rng, 0.55, 1.15) : 0,
                // Keep turbulence present but not dominant vs orbit steering.
                noiseStrength: range(rng, 0.65, 1.35),
                noiseScale: range(rng, 1.6, 3.2),
                noiseSpeed: range(rng, 0.08, 0.18),
                vortexStrength: range(rng, 0.10, 0.55),
                vortexRadius: range(rng, 0.70, 1.10)
            }
        };
    }

    if (choice.name === 'SmokeNoise') {
        return {
            name: 'SmokeNoise',
            useNextField,
            params: {
                orbitCenter: commonCenter,
                orbitRadius: 0.65,
                orbitOmega: 0,
                orbitGain: 0,
                orbitRingK: 0,
                burstCenter: commonCenter,
                burstStrength: 0,
                nextFieldStrength: useNextField ? range(rng, 0.75, 1.45) : 0,
                // Smoke = strong curl-noise turbulence, very weak coherent vortices.
                noiseStrength: range(rng, 1.65, 2.85),
                noiseScale: range(rng, 1.25, 2.45),
                noiseSpeed: range(rng, 0.10, 0.22),
                vortexStrength: range(rng, 0.06, 0.28),
                vortexRadius: range(rng, 0.95, 1.35)
            }
        };
    }

    // FireballBurst
    return {
        name: 'FireballBurst',
        useNextField,
        params: {
            orbitCenter: commonCenter,
            orbitRadius: 0.65,
            orbitOmega: 0,
            orbitGain: 0,
            orbitRingK: 0,
            burstCenter: commonCenter,
            burstStrength: range(rng, 1.8, 3.4),
            nextFieldStrength: useNextField ? range(rng, 0.45, 1.10) : 0,
            // Fireball = punchy turbulence + medium vortices (keeps it “alive”).
            noiseStrength: range(rng, 1.15, 2.25),
            noiseScale: range(rng, 1.8, 3.8),
            noiseSpeed: range(rng, 0.14, 0.28),
            vortexStrength: range(rng, 0.55, 1.35),
            vortexRadius: range(rng, 0.55, 0.95)
        }
    };
}

export function evaluateTransitionScript(scriptName, t01) {
    const t = clamp01(t01);
    const name = String(scriptName || '');

    // Defaults (safe): classic scatter → chaos → attract → settle
    let scatterT = bump(t, 0.02, 0.22, 0.07) * (1.0 - smoothstep(0.70, 0.92, t));
    let chaosT = bump(t, 0.08, 0.60, 0.08) * (1.0 - smoothstep(0.62, 0.92, t));
    let attractT = smoothstep(0.35, 0.80, t);
    // Start settling a bit earlier so the "landing" phase has more time
    // (reduces the end-of-transition "magnetic snap" feeling).
    let settleT = smoothstep(0.62, 1.0, t);

    let orbitT = 0;
    let burstT = 0;
    let nextFieldT = 0;

    if (name === 'CleanMorph') {
        scatterT = bump(t, 0.04, 0.16, 0.06) * 0.22;
        chaosT = bump(t, 0.08, 0.48, 0.08) * 0.10;
        attractT = smoothstep(0.22, 0.86, t);
        // Give "clean" transitions a longer, smoother landing.
        settleT = smoothstep(0.52, 1.0, t);
        orbitT = 0;
        burstT = 0;
        nextFieldT = bump(t, 0.18, 0.62, 0.10) * 0.18;
    } else if (name === 'OrbitLoop') {
        scatterT = bump(t, 0.02, 0.18, 0.07) * 0.75;
        chaosT = bump(t, 0.08, 0.82, 0.10) * 0.75;
        orbitT = bump(t, 0.14, 0.74, 0.10);
        nextFieldT = bump(t, 0.18, 0.70, 0.12) * 0.55;
        // Hold off the strong pull so the orbit reads clearly first.
        attractT = smoothstep(0.58, 0.93, t);
        settleT = smoothstep(0.64, 1.0, t);
    } else if (name === 'SmokeNoise') {
        scatterT = bump(t, 0.02, 0.22, 0.08) * 0.85;
        chaosT = bump(t, 0.06, 0.88, 0.10);
        nextFieldT = bump(t, 0.16, 0.84, 0.12) * 0.80;
        orbitT = 0;
        burstT = 0;
        attractT = smoothstep(0.70, 0.96, t);
        settleT = smoothstep(0.66, 1.0, t);
    } else if (name === 'FireballBurst') {
        scatterT = bump(t, 0.02, 0.14, 0.06) * 0.25;
        chaosT = bump(t, 0.05, 0.62, 0.10) * 0.95;
        const outW = bump(t, 0.06, 0.22, 0.06);
        const inW = bump(t, 0.22, 0.44, 0.08);
        // Encode sign in the curve so the shader can use a single radial force.
        burstT = outW - inW * 0.9;
        nextFieldT = bump(t, 0.20, 0.62, 0.12) * 0.55;
        attractT = smoothstep(0.40, 0.90, t);
        settleT = smoothstep(0.62, 1.0, t);
    }

    return {
        morphT: t,
        scatterT: clamp01(scatterT),
        chaosT: clamp01(chaosT),
        attractT: clamp01(attractT),
        settleT: clamp01(settleT),
        orbitT: clamp01(orbitT),
        burstT: Math.max(-1, Math.min(1, Number(burstT) || 0)),
        nextFieldT: clamp01(nextFieldT)
    };
}

