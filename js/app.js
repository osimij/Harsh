/**
 * Particle Forge - Entry
 * (Thin bootstrap; the implementation lives in js/app/core/particleForge.js)
 */

import { createApp } from './app/core/orchestrator.js';

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    try {
        // Internal tool: expose the app instance globally for debugging/inspection.
        window.app = createApp();
    } catch (err) {
        window.appInitError = err;
        console.error('Particle Forge failed to initialize:', err);

        // Visible fallback so failures are not silent for non-technical users.
        const banner = document.createElement('div');
        banner.setAttribute('role', 'alert');
        banner.style.position = 'fixed';
        banner.style.left = '12px';
        banner.style.right = '12px';
        banner.style.bottom = '12px';
        banner.style.zIndex = '99999';
        banner.style.padding = '10px 12px';
        banner.style.border = '1px solid #7f1d1d';
        banner.style.borderRadius = '8px';
        banner.style.background = '#450a0a';
        banner.style.color = '#fee2e2';
        banner.style.font = '14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
        banner.textContent = 'Particle Forge failed to start. Please refresh the page. If it persists, open browser console for details.';
        document.body.appendChild(banner);
    }
});
