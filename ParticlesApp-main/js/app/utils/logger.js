function isDebugLoggingEnabled() {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('DEBUG_LOGS') === '1';
    } catch (_e) {
        return false;
    }
}

export const logger = {
    debug: (...args) => {
        if (!isDebugLoggingEnabled()) return;
        // eslint-disable-next-line no-console
        console.debug(...args);
    },
    info: (...args) => {
        if (!isDebugLoggingEnabled()) return;
        // eslint-disable-next-line no-console
        console.info(...args);
    },
    warn: (...args) => {
        if (!isDebugLoggingEnabled()) return;
        // eslint-disable-next-line no-console
        console.warn(...args);
    },
    error: (...args) => {
        // Errors should remain visible even when debug logging is off.
        // eslint-disable-next-line no-console
        console.error(...args);
    }
};


