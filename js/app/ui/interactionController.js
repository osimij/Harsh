export function setupInteraction({ state: _state, dom, services: _services, appCompat, lifecycle }) {
    const app = appCompat;
    const canvas = (dom && dom.canvas) ? dom.canvas : (app && app.canvas);
    if (!app || !canvas) return;

    let focusPointerDown = false;
    let focusPointerId = null;

    const updateFocusFromClientPoint = (clientX, clientY) => {
        if (!app.settings || !app.settings.focusEnabled) return;
        const rect = canvas.getBoundingClientRect();
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;

        const x = (Number(clientX) - rect.left);
        const y = (Number(clientY) - rect.top);
        const nx = x / rect.width;
        const ny = y / rect.height;
        const clipX = nx * 2 - 1;
        const clipY = 1 - ny * 2;

        const aspectX = rect.width > rect.height ? rect.height / rect.width : 1;
        const aspectY = rect.height > rect.width ? rect.width / rect.height : 1;
        const clipAdjX = clipX / Math.max(1e-6, aspectX);
        const clipAdjY = clipY / Math.max(1e-6, aspectY);

        const zoom = Number(app.settings.zoom) || 1.0;
        const depthScale = (typeof app.settings.depthVariance === 'number') ? app.settings.depthVariance : 0.5;
        const posNorm = 0.985 / (1.0 + Math.max(0, Math.min(1, depthScale)) * 0.3);
        const inv = 1.0 / Math.max(1e-4, zoom * posNorm);

        const fx = clipAdjX * inv;
        const fy = clipAdjY * inv;
        app.settings.focusCenterX = Math.max(-1.5, Math.min(1.5, fx));
        app.settings.focusCenterY = Math.max(-1.5, Math.min(1.5, fy));
    };

    const signal = lifecycle && lifecycle.signal;
    const on = (target, type, handler, options) => {
        if (!target) return;
        const opts = signal ? { ...(options || {}), signal } : options;
        target.addEventListener(type, handler, opts);
    };

    // Keyboard shortcuts for “performance” tools
    on(window, 'keydown', (e) => {
        if (!e) return;
        if (e.repeat) return;

        const key = String(e.key || '').toLowerCase();
        if (!key) return;

        // Toggle MagnetTool
        if (key === 'm') {
            const enabled = app.magnetTool.toggleEnabled();

            // Keep interaction predictable: magnet assumes an unrotated view.
            if (enabled) {
                app.autoRotate = false;
                app.rotationX = 0;
                app.rotationY = 0;
                app.isDragging = false;

                const autoRotateEl = document.getElementById('auto-rotate');
                if (autoRotateEl) autoRotateEl.checked = false;
            }

            // Sync optional UI toggle (added later)
            const magnetToggle = document.getElementById('magnet-enabled');
            if (magnetToggle) magnetToggle.checked = enabled;

            return;
        }

        if (!app.magnetTool || !app.magnetTool.enabled) return;

        // When MagnetTool is enabled, allow quick mode switches.
        if (key === '1') {
            app.magnetTool.setMode('attract');
            const magnetModeValue = document.getElementById('magnet-mode-value');
            const magnetModeAttract = document.getElementById('magnet-mode-attract');
            const magnetModeRepel = document.getElementById('magnet-mode-repel');
            if (magnetModeValue) magnetModeValue.textContent = 'Attract';
            if (magnetModeAttract) magnetModeAttract.classList.add('active');
            if (magnetModeRepel) magnetModeRepel.classList.remove('active');
            return;
        }
        if (key === '2') {
            app.magnetTool.setMode('repel');
            const magnetModeValue = document.getElementById('magnet-mode-value');
            const magnetModeAttract = document.getElementById('magnet-mode-attract');
            const magnetModeRepel = document.getElementById('magnet-mode-repel');
            if (magnetModeValue) magnetModeValue.textContent = 'Repel';
            if (magnetModeAttract) magnetModeAttract.classList.remove('active');
            if (magnetModeRepel) magnetModeRepel.classList.add('active');
            return;
        }
        if (key === 'escape') {
            app.magnetTool.setEnabled(false);
            const magnetToggle = document.getElementById('magnet-enabled');
            if (magnetToggle) magnetToggle.checked = false;
        }
    });

    on(canvas, 'mousedown', (e) => {
        if (app.autoRotate) return;
        if (app.magnetTool && app.magnetTool.enabled) {
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            app.magnetTool.handlePointerDown({ clientX: e.clientX, clientY: e.clientY, pointerId: 'mouse' }, rect);
            app.isDragging = false;
            return;
        }
        if (app.settings && app.settings.focusEnabled) {
            e.preventDefault();
            focusPointerDown = true;
            focusPointerId = 'mouse';
            updateFocusFromClientPoint(e.clientX, e.clientY);
            app.isDragging = false;
            return;
        }
        app.isDragging = true;
        app.dragStart = { x: e.clientX, y: e.clientY };
    });

    on(canvas, 'mousemove', (e) => {
        if (app.magnetTool && app.magnetTool.enabled) {
            const rect = canvas.getBoundingClientRect();
            app.magnetTool.handlePointerMove({ clientX: e.clientX, clientY: e.clientY, pointerId: 'mouse' }, rect);
            return;
        }
        if (app.settings && app.settings.focusEnabled) {
            if (focusPointerDown && focusPointerId === 'mouse') {
                updateFocusFromClientPoint(e.clientX, e.clientY);
            }
            return;
        }
        if (!app.isDragging || app.autoRotate) return;

        const dx = e.clientX - app.dragStart.x;
        const dy = e.clientY - app.dragStart.y;

        app.rotationY += dx * 0.005;
        app.rotationX += dy * 0.005;

        app.dragStart = { x: e.clientX, y: e.clientY };
    });

    on(canvas, 'mouseup', (e) => {
        if (app.magnetTool && app.magnetTool.enabled) {
            app.magnetTool.handlePointerUp({ pointerId: 'mouse', clientX: e.clientX, clientY: e.clientY });
        }
        if (focusPointerDown && focusPointerId === 'mouse') {
            focusPointerDown = false;
            focusPointerId = null;
        }
        app.isDragging = false;
    });

    on(canvas, 'mouseleave', () => {
        if (app.magnetTool && app.magnetTool.enabled) {
            // Ensure we stop dragging the tool if the pointer leaves the canvas.
            app.magnetTool.isPointerDown = false;
            app.magnetTool.pointerId = null;
        }
        focusPointerDown = false;
        focusPointerId = null;
        app.isDragging = false;
    });

    // Mouse wheel zoom
    on(canvas, 'wheel', (e) => {
        e.preventDefault();

        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        const newZoom = Math.max(0.25, Math.min(4, app.settings.zoom + delta));

        app.settings.zoom = newZoom;
        app.renderer.updateSettings({ zoom: newZoom });

        // Update slider
        const zoomPercent = Math.round(newZoom * 100);
        document.getElementById('zoom').value = zoomPercent;
        document.getElementById('zoom-value').textContent = zoomPercent + '%';
    }, { passive: false });

    // Touch support
    on(canvas, 'touchstart', (e) => {
        if (app.autoRotate) return;
        if (app.magnetTool && app.magnetTool.enabled) {
            const t = e.touches && e.touches[0];
            if (!t) return;
            const rect = canvas.getBoundingClientRect();
            app.magnetTool.handlePointerDown({ clientX: t.clientX, clientY: t.clientY, pointerId: 'touch' }, rect);
            app.isDragging = false;
            return;
        }
        if (app.settings && app.settings.focusEnabled) {
            const t = e.touches && e.touches[0];
            if (!t) return;
            focusPointerDown = true;
            focusPointerId = 'touch';
            updateFocusFromClientPoint(t.clientX, t.clientY);
            app.isDragging = false;
            return;
        }
        app.isDragging = true;
        app.dragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    });

    on(canvas, 'touchmove', (e) => {
        if (app.magnetTool && app.magnetTool.enabled) {
            e.preventDefault();
            const t = e.touches && e.touches[0];
            if (!t) return;
            const rect = canvas.getBoundingClientRect();
            app.magnetTool.handlePointerMove({ clientX: t.clientX, clientY: t.clientY, pointerId: 'touch' }, rect);
            return;
        }
        if (app.settings && app.settings.focusEnabled) {
            const t = e.touches && e.touches[0];
            if (!t) return;
            if (focusPointerDown && focusPointerId === 'touch') {
                e.preventDefault();
                updateFocusFromClientPoint(t.clientX, t.clientY);
            }
            return;
        }
        if (!app.isDragging || app.autoRotate) return;
        e.preventDefault();

        const dx = e.touches[0].clientX - app.dragStart.x;
        const dy = e.touches[0].clientY - app.dragStart.y;

        app.rotationY += dx * 0.005;
        app.rotationX += dy * 0.005;

        app.dragStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    });

    on(canvas, 'touchend', () => {
        if (app.magnetTool && app.magnetTool.enabled) {
            app.magnetTool.handlePointerUp({ pointerId: 'touch' });
        }
        if (focusPointerDown && focusPointerId === 'touch') {
            focusPointerDown = false;
            focusPointerId = null;
        }
        app.isDragging = false;
    });

    on(canvas, 'touchcancel', () => {
        if (app.magnetTool && app.magnetTool.enabled) {
            app.magnetTool.isPointerDown = false;
            app.magnetTool.pointerId = null;
        }
        focusPointerDown = false;
        focusPointerId = null;
        app.isDragging = false;
    });
}
