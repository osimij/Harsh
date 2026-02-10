/**
 * transition-presets.js
 * Defines a small set of "signature" chaotic transition styles.
 *
 * Each preset returns a parameter object consumed by the GPU sim (and optionally CPU fallback).
 */

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function range(rng, min, max) {
    return lerp(min, max, rng());
}

function pick2D(rng, min, max) {
    return [range(rng, min, max), range(rng, min, max)];
}

export const TRANSITION_PRESETS = [
    {
        name: 'VortexCollapse',
        buildParams(rng) {
            const noiseOffset = pick2D(rng, 0, 200);
            const vortex1 = pick2D(rng, -0.25, 0.25);
            const vortex2 = pick2D(rng, -0.35, 0.35);
            const vortex3 = pick2D(rng, -0.3, 0.3);
            return {
                noiseOffset,
                noiseScale: range(rng, 2.2, 4.2),
                noiseStrength: range(rng, 0.7, 1.3),
                noiseSpeed: range(rng, 0.10, 0.24),
                vortex1,
                vortex2,
                vortex3,
                vortexStrength: range(rng, 1.25, 2.2),
                vortexRadius: range(rng, 0.45, 0.85),
                repulseStrength: range(rng, 0.8, 1.5),
                attractStrength: range(rng, 2.4, 4.0),
                drag: range(rng, 0.9, 1.4),
                maxSpeed: range(rng, 1.8, 2.8)
            };
        }
    },
    {
        name: 'MurmurationFlow',
        buildParams(rng) {
            const noiseOffset = pick2D(rng, 50, 350);
            // Wider, less-centered vortices, more flow field
            const vortex1 = pick2D(rng, -0.65, 0.65);
            const vortex2 = pick2D(rng, -0.65, 0.65);
            const vortex3 = pick2D(rng, -0.65, 0.65);
            return {
                noiseOffset,
                noiseScale: range(rng, 1.2, 2.2),
                noiseStrength: range(rng, 1.1, 2.0),
                noiseSpeed: range(rng, 0.06, 0.14),
                vortex1,
                vortex2,
                vortex3,
                vortexStrength: range(rng, 0.35, 0.9),
                vortexRadius: range(rng, 0.9, 1.25),
                repulseStrength: range(rng, 0.6, 1.1),
                attractStrength: range(rng, 2.0, 3.2),
                drag: range(rng, 0.8, 1.2),
                maxSpeed: range(rng, 1.6, 2.4)
            };
        }
    },
    {
        name: 'ShockwaveScatter',
        buildParams(rng) {
            const noiseOffset = pick2D(rng, 0, 500);
            const center = pick2D(rng, -0.1, 0.1);
            return {
                noiseOffset,
                noiseScale: range(rng, 2.0, 3.8),
                noiseStrength: range(rng, 0.8, 1.6),
                noiseSpeed: range(rng, 0.14, 0.28),
                vortex1: center,
                vortex2: pick2D(rng, -0.25, 0.25),
                vortex3: pick2D(rng, -0.25, 0.25),
                vortexStrength: range(rng, 0.9, 1.6),
                vortexRadius: range(rng, 0.55, 0.95),
                repulseStrength: range(rng, 1.2, 2.3),
                attractStrength: range(rng, 2.2, 3.8),
                drag: range(rng, 0.95, 1.55),
                maxSpeed: range(rng, 2.2, 3.5),
                // Used by the director to add a timed impulse (GPU v1 uses repulse curve spike)
                shockTime: range(rng, 0.18, 0.32),
                shockStrength: range(rng, 1.2, 2.4)
            };
        }
    },
    {
        name: 'HelixPeel',
        buildParams(rng) {
            const noiseOffset = pick2D(rng, 0, 400);
            return {
                noiseOffset,
                noiseScale: range(rng, 2.8, 5.0),
                noiseStrength: range(rng, 0.55, 1.0),
                noiseSpeed: range(rng, 0.10, 0.22),
                vortex1: pick2D(rng, -0.2, 0.2),
                vortex2: pick2D(rng, -0.2, 0.2),
                vortex3: pick2D(rng, -0.2, 0.2),
                vortexStrength: range(rng, 1.0, 1.8),
                vortexRadius: range(rng, 0.4, 0.75),
                repulseStrength: range(rng, 0.7, 1.2),
                attractStrength: range(rng, 2.8, 4.2),
                drag: range(rng, 0.95, 1.4),
                maxSpeed: range(rng, 1.8, 2.8),
                helixBias: range(rng, 0.4, 1.0)
            };
        }
    },
    {
        name: 'LiquidDripReverse',
        buildParams(rng) {
            const noiseOffset = pick2D(rng, 100, 600);
            return {
                noiseOffset,
                noiseScale: range(rng, 1.6, 2.8),
                noiseStrength: range(rng, 0.6, 1.2),
                noiseSpeed: range(rng, 0.06, 0.16),
                vortex1: pick2D(rng, -0.3, 0.3),
                vortex2: pick2D(rng, -0.3, 0.3),
                vortex3: pick2D(rng, -0.3, 0.3),
                vortexStrength: range(rng, 0.6, 1.3),
                vortexRadius: range(rng, 0.6, 1.1),
                repulseStrength: range(rng, 0.6, 1.1),
                attractStrength: range(rng, 2.6, 3.8),
                drag: range(rng, 1.0, 1.8),
                maxSpeed: range(rng, 1.4, 2.4),
                // Used by director / sim to bias downward drift early then reverse.
                dripBias: range(rng, 0.4, 1.0)
            };
        }
    }
];


