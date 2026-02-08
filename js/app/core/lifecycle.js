/**
 * Simple app lifecycle helper:
 * - Owns an AbortController for event listener cleanup via `{ signal }`
 * - Allows registering extra cleanup callbacks (optional)
 */
export function createLifecycle() {
    const controller = new AbortController();
    const cleanups = new Set();
    let disposed = false;

    return {
        signal: controller.signal,
        addCleanup(fn) {
            if (disposed) return;
            if (typeof fn === 'function') cleanups.add(fn);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            try { controller.abort(); } catch (_) { /* ignore */ }
            for (const fn of cleanups) {
                try { fn(); } catch (_) { /* ignore */ }
            }
            cleanups.clear();
        }
    };
}


