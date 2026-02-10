/**
 * RAF loop helper:
 * - Computes deltaTime (seconds)
 * - Updates FPS counter (#fps-counter) at the same cadence as the original inline loop
 * - Calls `onFrame(deltaTime, now)` every frame while running
 */
export function createLoop({ fpsElementId = 'fps-counter' } = {}) {
    let running = false;
    let lastTime = 0;
    let frameCount = 0;
    let fpsTime = 0;
    let onFrame = null;

    const tick = (currentTime) => {
        if (!running) return;

        const deltaTime = (currentTime - lastTime) / 1000;
        lastTime = currentTime;

        // FPS counter (same logic/cadence as the original ParticleForge loop)
        frameCount++;
        fpsTime += deltaTime;
        if (fpsTime >= 0.5) {
            const fps = Math.round(frameCount / fpsTime);
            const el = document.getElementById(fpsElementId);
            if (el) el.textContent = String(fps);
            frameCount = 0;
            fpsTime = 0;
        }

        if (typeof onFrame === 'function') {
            onFrame(deltaTime, currentTime);
        }

        requestAnimationFrame(tick);
    };

    return {
        start(frameHandler) {
            onFrame = frameHandler;
            running = true;
            lastTime = performance.now();
            frameCount = 0;
            fpsTime = 0;
            requestAnimationFrame(tick);
        },
        stop() {
            running = false;
        }
    };
}


