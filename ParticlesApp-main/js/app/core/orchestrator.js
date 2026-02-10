import { ParticleForge } from './particleForge.js';

/**
 * Phase B orchestrator (initial version):
 * - Keeps initialization + RAF loop semantics unchanged by delegating to ParticleForge.
 * - Provides a stable factory for a thin `js/app.js` entrypoint.
 */
export function createApp() {
    return new ParticleForge();
}


