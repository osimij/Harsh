/**
 * Particle Forge - Entry
 * (Thin bootstrap; the implementation lives in js/app/core/particleForge.js)
 */

import { createApp } from './app/core/orchestrator.js';

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    // Internal tool: expose the app instance globally for debugging/inspection.
    window.app = createApp();
});
