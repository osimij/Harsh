import { MAX_PARTICLE_DENSITY } from '../constants.js';
import { clamp01 } from '../utils/color.js';
import { sanitizeSvgForLogo } from '../utils/svgSanitize.js';

export function setupControls({ appCompat, lifecycle }) {
    const app = appCompat;
    if (!app) return;

    const signal = lifecycle && lifecycle.signal;
    const on = (target, type, handler, options) => {
        if (!target) return;
        const opts = signal ? { ...(options || {}), signal } : options;
        target.addEventListener(type, handler, opts);
    };

    // --- UI: Control panel (sidebar) toggle + state (desktop: collapse, mobile: slide in/out) ---
    const PANEL_OPEN_STORAGE_KEY = 'PF_UI_PANEL_OPEN';
    const SECTIONS_OPEN_STORAGE_KEY = 'PF_UI_SECTIONS_OPEN';

    const safeStorageGet = (key) => {
        try {
            return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
        } catch (_e) {
            return null;
        }
    };

    const safeStorageSet = (key, value) => {
        try {
            if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
        } catch (_e) {
            // ignore storage errors (private mode / disabled storage)
        }
    };

    const appRoot = document.getElementById('app');
    const controlPanel = app.controlPanel || document.getElementById('control-panel');

    const panelToggle = document.getElementById('panel-toggle');
    const headerPanelToggle = document.getElementById('header-panel-toggle');

    const mq = (typeof window !== 'undefined' && typeof window.matchMedia === 'function')
        ? window.matchMedia('(max-width: 768px)')
        : null;

    const getDefaultPanelOpen = () => {
        // On small screens, keep the panel closed by default to avoid covering the canvas.
        if (mq && mq.matches) return false;
        return true;
    };

    let panelOpen = (() => {
        const stored = safeStorageGet(PANEL_OPEN_STORAGE_KEY);
        if (stored === '1') return true;
        if (stored === '0') return false;
        return getDefaultPanelOpen();
    })();

    const updatePanelToggleButtons = () => {
        const expanded = !!panelOpen;
        const title = expanded ? 'Hide controls' : 'Show controls';
        [panelToggle, headerPanelToggle].forEach((btn) => {
            if (!btn) return;
            btn.setAttribute('aria-expanded', String(expanded));
            btn.setAttribute('title', title);
        });
    };

    const applyPanelState = () => {
        if (!controlPanel) return;

        const isMobile = !!(mq && mq.matches);
        if (isMobile) {
            controlPanel.classList.toggle('open', panelOpen);
            // On mobile, the panel slides in/out. Make sure "collapsed" layout isn't applied.
            controlPanel.classList.remove('collapsed');
            if (appRoot) appRoot.classList.remove('panel-collapsed');
        } else {
            controlPanel.classList.toggle('collapsed', !panelOpen);
            if (appRoot) appRoot.classList.toggle('panel-collapsed', !panelOpen);
            controlPanel.classList.remove('open');
        }

        updatePanelToggleButtons();
    };

    const setPanelOpen = (open, { persist = true } = {}) => {
        panelOpen = !!open;
        applyPanelState();
        if (persist) safeStorageSet(PANEL_OPEN_STORAGE_KEY, panelOpen ? '1' : '0');
    };

    const togglePanel = () => setPanelOpen(!panelOpen);

    on(panelToggle, 'click', togglePanel);
    on(headerPanelToggle, 'click', togglePanel);

    // Sidebar toggle shortcut
    on(window, 'keydown', (e) => {
        // Toggle sidebar with "\" key
        if (e.key === '\\') {
            e.preventDefault();
            togglePanel();
        }
        
        // Close the panel on mobile with Escape
        if (mq && mq.matches && panelOpen && e.key === 'Escape') {
            setPanelOpen(false);
        }
    });

    // React to breakpoint changes (desktop ↔ mobile)
    if (mq) {
        const onBreakpointChange = () => applyPanelState();
        if (typeof mq.addEventListener === 'function') {
            mq.addEventListener('change', onBreakpointChange, signal ? { signal } : undefined);
        } else if (typeof mq.addListener === 'function') {
            mq.addListener(onBreakpointChange);
            if (lifecycle && typeof lifecycle.addCleanup === 'function') {
                lifecycle.addCleanup(() => mq.removeListener(onBreakpointChange));
            }
        }
    }

    // Apply initial UI state
    applyPanelState();

    // --- UI: Collapsible control groups (remember open/closed state) ---
    const sections = document.querySelectorAll('details.control-section[data-section]');
    if (sections && sections.length) {
        let storedMap = {};
        const raw = safeStorageGet(SECTIONS_OPEN_STORAGE_KEY);
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') storedMap = parsed;
            } catch (_e) {
                storedMap = {};
            }
        }

        sections.forEach((details) => {
            const key = details?.dataset?.section;
            if (!key) return;
            if (typeof storedMap[key] === 'boolean') {
                details.open = storedMap[key];
            }
        });

        sections.forEach((details) => {
            on(details, 'toggle', () => {
                const key = details?.dataset?.section;
                if (!key) return;
                storedMap[key] = !!details.open;
                safeStorageSet(SECTIONS_OPEN_STORAGE_KEY, JSON.stringify(storedMap));
            });
        });

        const expandAllBtn = document.getElementById('expand-all');
        const collapseAllBtn = document.getElementById('collapse-all');

        if (expandAllBtn) {
            on(expandAllBtn, 'click', () => {
                sections.forEach(s => { s.open = true; });
                // Storage is updated via the 'toggle' event listeners already attached
            });
        }
        if (collapseAllBtn) {
            on(collapseAllBtn, 'click', () => {
                sections.forEach(s => { s.open = false; });
            });
        }
    }

    // Enforce density cap at the UI level (in case the HTML slider max is edited externally).
    const logoDensityEl = document.getElementById('logo-density');
    const imageDensityEl = document.getElementById('image-density');
    const clampDensity = (value) => Math.min(MAX_PARTICLE_DENSITY, Math.max(100, parseInt(value, 10) || 15000));
    const syncLegacyDensity = () => {
        app.settings.density = Math.max(
            clampDensity(app.settings.logoDensity),
            clampDensity(app.settings.imageDensity)
        );
    };

    [logoDensityEl, imageDensityEl].forEach((el) => {
        if (!el) return;
        el.max = String(MAX_PARTICLE_DENSITY);
        el.step = '1000';
        const current = parseInt(el.value, 10);
        if (Number.isFinite(current) && current > MAX_PARTICLE_DENSITY) {
            el.value = String(MAX_PARTICLE_DENSITY);
        }
    });

    // Logo density slider
    setupSlider('logo-density', 15000, (value) => {
        const capped = clampDensity(value);
        app.settings.logoDensity = capped;
        if (logoDensityEl && String(logoDensityEl.value) !== String(capped)) {
            logoDensityEl.value = String(capped);
        }
        syncLegacyDensity();
        if (app.svgData || app.currentImage || (app.logoSequence && app.logoSequence.sourceType)) {
            app.regenerateParticles();
        }
    }, {
        lifecycle,
        onInput: (value) => {
            const dv = document.getElementById('logo-density-value');
            if (dv) dv.textContent = String(value);
        }
    });

    // Image density slider
    setupSlider('image-density', 15000, (value) => {
        const capped = clampDensity(value);
        app.settings.imageDensity = capped;
        if (imageDensityEl && String(imageDensityEl.value) !== String(capped)) {
            imageDensityEl.value = String(capped);
        }
        syncLegacyDensity();
        if (app.svgData || app.currentImage || (app.logoSequence && app.logoSequence.sourceType)) {
            app.regenerateParticles();
        }
    }, {
        lifecycle,
        onInput: (value) => {
            const dv = document.getElementById('image-density-value');
            if (dv) dv.textContent = String(value);
        }
    });

    // Size slider
    setupSlider('particle-size', 2.0, (value) => {
        app.settings.size = parseFloat(value);
        app.particleSystem.updateSettings({ size: app.settings.size });
    }, { 
        lifecycle,
        onInput: (value) => {
            document.getElementById('size-value').textContent = parseFloat(value).toFixed(1);
        }
    });

    // Depth slider
    setupSlider('depth', 50, (value) => {
        app.settings.depthVariance = value / 100;
        app.particleSystem.updateSettings({ depthVariance: app.settings.depthVariance });
    }, { 
        lifecycle,
        onInput: (value) => {
            document.getElementById('depth-value').textContent = value + '%';
        }
    });

    const focusToggle = document.getElementById('focus-enabled');
    const focusRadiusSlider = document.getElementById('focus-radius');
    const focusSoftnessSlider = document.getElementById('focus-softness');
    const focusScatterSlider = document.getElementById('focus-scatter');
    const focusRadiusValue = document.getElementById('focus-radius-value');
    const focusSoftnessValue = document.getElementById('focus-softness-value');
    const focusScatterValue = document.getElementById('focus-scatter-value');

    const setFocusControlsDisabled = (disabled) => {
        if (focusRadiusSlider) focusRadiusSlider.disabled = disabled;
        if (focusSoftnessSlider) focusSoftnessSlider.disabled = disabled;
        if (focusScatterSlider) focusScatterSlider.disabled = disabled;
    };

    if (focusToggle) {
        focusToggle.checked = !!app.settings.focusEnabled;
        on(focusToggle, 'change', (e) => {
            app.settings.focusEnabled = !!e.target.checked;
            setFocusControlsDisabled(!app.settings.focusEnabled);
            if (app.settings.focusEnabled) {
                app.autoRotate = false;
                app.rotationX = 0;
                app.rotationY = 0;
                const autoRotateToggle = document.getElementById('auto-rotate');
                if (autoRotateToggle) autoRotateToggle.checked = false;
            }
        });
    }

    if (focusRadiusSlider) {
        const pct = Math.round(Math.max(0.1, Math.min(1.2, Number(app.settings.focusRadius ?? 0.45))) * 100);
        focusRadiusSlider.value = String(pct);
        if (focusRadiusValue) focusRadiusValue.textContent = `${pct}%`;
    }
    if (focusSoftnessSlider) {
        const pct = Math.round(clamp01(app.settings.focusSoftness ?? 0.35) * 100);
        focusSoftnessSlider.value = String(pct);
        if (focusSoftnessValue) focusSoftnessValue.textContent = `${pct}%`;
    }
    if (focusScatterSlider) {
        const pct = Math.round(Math.max(0, Math.min(2.5, Number(app.settings.focusScatter ?? 1.5))) * 100);
        focusScatterSlider.value = String(pct);
        if (focusScatterValue) focusScatterValue.textContent = `${pct}%`;
    }

    setFocusControlsDisabled(!(app.settings && app.settings.focusEnabled));

    setupSlider('focus-radius', 45, (value) => {
        const pct = Math.max(10, Math.min(120, parseInt(value, 10) || 0));
        app.settings.focusRadius = pct / 100;
    }, {
        lifecycle,
        onInput: (value) => {
            const pct = Math.max(10, Math.min(120, parseInt(value, 10) || 0));
            if (focusRadiusValue) focusRadiusValue.textContent = `${pct}%`;
        }
    });

    setupSlider('focus-softness', 35, (value) => {
        const pct = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
        app.settings.focusSoftness = pct / 100;
    }, {
        lifecycle,
        onInput: (value) => {
            const pct = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
            if (focusSoftnessValue) focusSoftnessValue.textContent = `${pct}%`;
        }
    });

    setupSlider('focus-scatter', 150, (value) => {
        const pct = Math.max(0, Math.min(250, parseInt(value, 10) || 0));
        app.settings.focusScatter = pct / 100;
    }, {
        lifecycle,
        onInput: (value) => {
            const pct = Math.max(0, Math.min(250, parseInt(value, 10) || 0));
            if (focusScatterValue) focusScatterValue.textContent = `${pct}%`;
        }
    });

    // Glow slider
    setupSlider('glow', 40, (value) => {
        app.settings.glowIntensity = value / 100;
        app.renderer.updateSettings({ glowIntensity: app.settings.glowIntensity });
    }, { 
        lifecycle,
        onInput: (value) => {
            document.getElementById('glow-value').textContent = value + '%';
        }
    });

    const edgeAuraToggle = document.getElementById('edge-aura');
    if (edgeAuraToggle) {
        edgeAuraToggle.checked = !!app.settings.edgeAuraEnabled;
        on(edgeAuraToggle, 'change', (e) => {
            app.settings.edgeAuraEnabled = !!e.target.checked;
            if (app.svgData || app.currentImage || (app.logoSequence && app.logoSequence.sourceType === 'image')) {
                app.regenerateParticles();
            }
        });
    }

    const edgeAuraAmountSlider = document.getElementById('edge-aura-amount');
    const edgeAuraSpreadSlider = document.getElementById('edge-aura-spread');
    const edgeAuraOutlierSlider = document.getElementById('edge-aura-outlier');
    const edgeAuraAmountValue = document.getElementById('edge-aura-amount-value');
    const edgeAuraSpreadValue = document.getElementById('edge-aura-spread-value');
    const edgeAuraOutlierValue = document.getElementById('edge-aura-outlier-value');

    const setEdgeAuraControlsDisabled = (disabled) => {
        if (edgeAuraAmountSlider) edgeAuraAmountSlider.disabled = disabled;
        if (edgeAuraSpreadSlider) edgeAuraSpreadSlider.disabled = disabled;
        if (edgeAuraOutlierSlider) edgeAuraOutlierSlider.disabled = disabled;
    };

    if (edgeAuraAmountSlider && typeof app.settings.edgeAuraAmount === 'number') {
        const pct = Math.round(clamp01(app.settings.edgeAuraAmount) * 100);
        edgeAuraAmountSlider.value = String(pct);
        if (edgeAuraAmountValue) edgeAuraAmountValue.textContent = `${pct}%`;
    }
    if (edgeAuraSpreadSlider && typeof app.settings.edgeAuraSpread === 'number') {
        const pct = Math.round(clamp01(app.settings.edgeAuraSpread) * 100);
        edgeAuraSpreadSlider.value = String(pct);
        if (edgeAuraSpreadValue) edgeAuraSpreadValue.textContent = `${pct}%`;
    }
    if (edgeAuraOutlierSlider && typeof app.settings.edgeAuraOutlier === 'number') {
        const pct = Math.round(clamp01(app.settings.edgeAuraOutlier) * 100);
        edgeAuraOutlierSlider.value = String(pct);
        if (edgeAuraOutlierValue) edgeAuraOutlierValue.textContent = `${pct}%`;
    }

    setEdgeAuraControlsDisabled(!(app.settings && app.settings.edgeAuraEnabled));

    if (edgeAuraToggle) {
        on(edgeAuraToggle, 'change', (e) => {
            const enabled = !!e.target.checked;
            setEdgeAuraControlsDisabled(!enabled);
        });
    }

    setupSlider('edge-aura-amount', 12, (value) => {
        const pct = Math.max(0, Math.min(40, parseInt(value, 10) || 0));
        app.settings.edgeAuraAmount = pct / 100;
        if (app.svgData || app.currentImage || (app.logoSequence && app.logoSequence.sourceType === 'image')) {
            app.regenerateParticles();
        }
    }, {
        lifecycle,
        onInput: (value) => {
            const pct = Math.max(0, Math.min(40, parseInt(value, 10) || 0));
            if (edgeAuraAmountValue) edgeAuraAmountValue.textContent = `${pct}%`;
        }
    });

    setupSlider('edge-aura-spread', 12, (value) => {
        const pct = Math.max(0, Math.min(40, parseInt(value, 10) || 0));
        app.settings.edgeAuraSpread = pct / 100;
        if (app.svgData || app.currentImage || (app.logoSequence && app.logoSequence.sourceType === 'image')) {
            app.regenerateParticles();
        }
    }, {
        lifecycle,
        onInput: (value) => {
            const pct = Math.max(0, Math.min(40, parseInt(value, 10) || 0));
            if (edgeAuraSpreadValue) edgeAuraSpreadValue.textContent = `${pct}%`;
        }
    });

    setupSlider('edge-aura-outlier', 5, (value) => {
        const pct = Math.max(0, Math.min(20, parseInt(value, 10) || 0));
        app.settings.edgeAuraOutlier = pct / 100;
        if (app.svgData || app.currentImage || (app.logoSequence && app.logoSequence.sourceType === 'image')) {
            app.regenerateParticles();
        }
    }, {
        lifecycle,
        onInput: (value) => {
            const pct = Math.max(0, Math.min(20, parseInt(value, 10) || 0));
            if (edgeAuraOutlierValue) edgeAuraOutlierValue.textContent = `${pct}%`;
        }
    });

    // Speed slider
    setupSlider('animation-speed', 20, (value) => {
        app.settings.animationSpeed = value / 100;
        app.particleSystem.updateSettings({ animationSpeed: app.settings.animationSpeed });
    }, { 
        lifecycle,
        onInput: (value) => {
            document.getElementById('speed-value').textContent = value + '%';
        }
    });

    // Dissolve/Reform toggle
    const dissolveToggle = document.getElementById('dissolve-cycle');
    if (dissolveToggle) {
        on(dissolveToggle, 'change', (e) => {
            app.settings.dissolveCycle = e.target.checked;
            app.particleSystem.updateSettings({ dissolveCycle: app.settings.dissolveCycle });
        });
    }

    // Cycle duration
    setupSlider('cycle-seconds', 12, (value) => {
        const seconds = Math.max(1, parseInt(value, 10) || 12);
        app.settings.cycleSeconds = seconds;
        app.particleSystem.updateSettings({ cycleSeconds: seconds });
    }, { 
        lifecycle,
        onInput: (value) => {
            document.getElementById('cycle-value').textContent = value + 's';
        }
    });

    // Hold time (how long the logo stays fully formed before starting the next cycle)
    setupSlider('hold-seconds', 0, (value) => {
        const seconds = Math.max(0, parseInt(value, 10) || 0);
        app.settings.holdSeconds = seconds;
        app.particleSystem.updateSettings({ holdSeconds: seconds });
    }, { 
        lifecycle,
        onInput: (value) => {
            const label = document.getElementById('hold-value');
            if (label) label.textContent = value + 's';
        }
    });

    // Chaos amount
    setupSlider('chaos', 75, (value) => {
        const v = parseInt(value, 10);
        app.settings.chaos = v / 100;
        app.particleSystem.updateSettings({ chaos: app.settings.chaos });
    }, { 
        lifecycle,
        onInput: (value) => {
            document.getElementById('chaos-value').textContent = value + '%';
        }
    });

    // Transition Style (Clean ↔ Chaotic)
    const transitionStyleValue = document.getElementById('transition-style-value');
    const transitionStyleClean = document.getElementById('transition-style-clean');
    const transitionStyleChaotic = document.getElementById('transition-style-chaotic');
    const applyTransitionStyleUI = (style) => {
        const s = (style === 'clean') ? 'clean' : 'chaotic';
        app.settings.transitionStyle = s;
        if (transitionStyleValue) transitionStyleValue.textContent = (s === 'clean') ? 'Clean' : 'Chaotic';
        if (transitionStyleClean) transitionStyleClean.classList.toggle('active', s === 'clean');
        if (transitionStyleChaotic) transitionStyleChaotic.classList.toggle('active', s === 'chaotic');
    };
    if (transitionStyleClean) {
        on(transitionStyleClean, 'click', () => applyTransitionStyleUI('clean'));
    }
    if (transitionStyleChaotic) {
        on(transitionStyleChaotic, 'click', () => applyTransitionStyleUI('chaotic'));
    }
    applyTransitionStyleUI(app.settings.transitionStyle);

    // Zoom slider
    setupSlider('zoom', 100, (value) => {
        app.settings.zoom = value / 100;
        app.renderer.updateSettings({ zoom: app.settings.zoom });
    }, { 
        lifecycle,
        onInput: (value) => {
            document.getElementById('zoom-value').textContent = value + '%';
        }
    });

    // Random size coverage slider (percentage of particles affected)
    setupSlider('size-random', 100, (value) => {
        app.settings.sizeRandom = value / 100;
        app.particleSystem.updateSettings({ sizeRandom: app.settings.sizeRandom });
    }, { 
        lifecycle,
        onInput: (value) => {
            document.getElementById('size-random-value').textContent = value + '%';
        }
    });

    // Random opacity coverage slider (percentage of particles affected)
    setupSlider('opacity-random', 100, (value) => {
        app.settings.opacityRandom = value / 100;
        app.particleSystem.updateSettings({ opacityRandom: app.settings.opacityRandom });
    }, { 
        lifecycle,
        onInput: (value) => {
            document.getElementById('opacity-random-value').textContent = value + '%';
        }
    });

    // Random size range (min/max) as multipliers applied to "Base Size"
    setupSlider('size-min', 0.8, (value) => {
        app.settings.sizeMin = parseFloat(value);
        app.particleSystem.updateSettings({ sizeMin: app.settings.sizeMin });
    }, {
        lifecycle,
        onInput: (value) => {
            const el = document.getElementById('size-min-value');
            if (el) el.textContent = parseFloat(value).toFixed(2) + '×';
        }
    });

    setupSlider('size-max', 1.2, (value) => {
        app.settings.sizeMax = parseFloat(value);
        app.particleSystem.updateSettings({ sizeMax: app.settings.sizeMax });
    }, {
        lifecycle,
        onInput: (value) => {
            const el = document.getElementById('size-max-value');
            if (el) el.textContent = parseFloat(value).toFixed(2) + '×';
        }
    });

    // Random opacity range (min/max) as percentages (0..100)
    setupSlider('opacity-min', 68, (value) => {
        const v = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
        app.settings.opacityMin = v / 100;
        app.particleSystem.updateSettings({ opacityMin: app.settings.opacityMin });
    }, {
        lifecycle,
        onInput: (value) => {
            const el = document.getElementById('opacity-min-value');
            if (el) el.textContent = value + '%';
        }
    });

    setupSlider('opacity-max', 82, (value) => {
        const v = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
        app.settings.opacityMax = v / 100;
        app.particleSystem.updateSettings({ opacityMax: app.settings.opacityMax });
    }, {
        lifecycle,
        onInput: (value) => {
            const el = document.getElementById('opacity-max-value');
            if (el) el.textContent = value + '%';
        }
    });

    // Shapes: Squares toggle + mix ratio (controls circle/square distribution)
    const squaresEnabledToggle = document.getElementById('squares-enabled');
    const squaresRatioSlider = document.getElementById('squares-ratio');
    const squaresValueLabel = document.getElementById('squares-value');
    const applySquaresRatioLabel = (ratio01) => {
        if (!squaresValueLabel) return;
        const pct = Math.round((ratio01 || 0) * 100);
        squaresValueLabel.textContent = pct + '%';
    };

    if (squaresEnabledToggle) {
        on(squaresEnabledToggle, 'change', (e) => {
            app.settings.squaresEnabled = !!e.target.checked;
            if (squaresRatioSlider) squaresRatioSlider.disabled = !app.settings.squaresEnabled;
            app.particleSystem.updateSettings({ squaresEnabled: app.settings.squaresEnabled });
        });
    }

    if (squaresRatioSlider) {
        setupSlider('squares-ratio', 25, (value) => {
            const v = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
            const ratio = v / 100;
            app.settings.squareRatio = ratio;
            app.particleSystem.updateSettings({ squareRatio: ratio });
        }, { 
            lifecycle,
            onInput: (value) => {
                applySquaresRatioLabel(value / 100);
            }
        });
        // Init label + enabled state
        applySquaresRatioLabel(app.settings.squareRatio);
        squaresRatioSlider.disabled = !app.settings.squaresEnabled;
    }

    // Particle icons (custom SVG sprites)
    const particleIconsToggle = document.getElementById('particle-icons-enabled');
    const particleIconUploadBtn = document.getElementById('particle-icon-upload-btn');
    const particleIconInput = document.getElementById('particle-icon-input');
    const particleIconCount = document.getElementById('particle-icon-count');
    const particleIconLogoSelect = document.getElementById('particle-icon-logo');
    const particleIconSelect = document.getElementById('particle-icon-select');
    const particleIconApplyAll = document.getElementById('particle-icon-apply-all');
    const particleIconRotation = document.getElementById('particle-icon-rotation');
    const particleIconColorMode = document.getElementById('particle-icon-color-mode');

    const ensureParticleIconState = () => {
        if (app && typeof app.ensureParticleIconState === 'function') {
            return app.ensureParticleIconState();
        }
        if (app && app.state) {
            if (!app.state.particleIcons) {
                app.state.particleIcons = { library: [], assignments: [] };
            }
            if (!app.state.particleIcons.library) app.state.particleIcons.library = [];
            if (!app.state.particleIcons.assignments) app.state.particleIcons.assignments = [];
            return app.state.particleIcons;
        }
        return null;
    };

    const getLogoCount = () => {
        const seq = app.logoSequence;
        if (seq && Array.isArray(seq.items) && seq.items.length) return seq.items.length;
        if (seq && Array.isArray(seq.svgStrings) && seq.svgStrings.length) return seq.svgStrings.length;
        if (seq && Array.isArray(seq.imageSources) && seq.imageSources.length) return seq.imageSources.length;
        if (app.currentSvgString) return 1;
        if (app.currentImage) return 1;
        return 0;
    };

    const getIconLibrary = () => {
        const state = ensureParticleIconState();
        return state && Array.isArray(state.library) ? state.library : [];
    };

    const getAssignments = () => {
        const state = ensureParticleIconState();
        return state && Array.isArray(state.assignments) ? state.assignments : [];
    };

    const setAssignmentForLogo = (index, assignment) => {
        if (app && typeof app.setParticleIconAssignment === 'function') {
            app.setParticleIconAssignment(index, assignment);
            return;
        }
        const list = getAssignments();
        list[index] = assignment;
    };

    const applyAssignmentToAll = (assignment) => {
        if (app && typeof app.applyParticleIconToAll === 'function') {
            app.applyParticleIconToAll(assignment);
            return;
        }
        const list = getAssignments();
        for (let i = 0; i < list.length; i++) list[i] = assignment;
    };

    const encodeAssignment = (assignment) => {
        if (!assignment || assignment.type === 'classic') return 'classic';
        if (assignment.type === 'self') return 'self';
        if (assignment.type === 'icon' && assignment.id != null) return `icon:${assignment.id}`;
        return 'classic';
    };

    const decodeAssignment = (value) => {
        const v = String(value || '');
        if (v === 'self') return { type: 'self' };
        if (v.startsWith('icon:')) return { type: 'icon', id: v.slice(5) };
        return { type: 'classic' };
    };

    let selectedLogoIndex = 0;

    const refreshParticleIconUI = () => {
        const logoCount = getLogoCount();
        const library = getIconLibrary();
        const assignments = getAssignments();

        if (particleIconCount) particleIconCount.textContent = String(library.length || 0);

        if (particleIconsToggle) {
            particleIconsToggle.checked = !!app.settings.particleIconEnabled;
        }
        if (particleIconRotation) {
            particleIconRotation.value = app.settings.particleIconRotate ? 'spin' : 'still';
        }
        if (particleIconColorMode) {
            particleIconColorMode.value = String(app.settings.particleIconColorMode || 'tint');
        }

        if (particleIconLogoSelect) {
            particleIconLogoSelect.innerHTML = '';
            if (logoCount <= 0) {
                const opt = document.createElement('option');
                opt.value = '0';
                opt.textContent = 'No logos loaded';
                particleIconLogoSelect.appendChild(opt);
                particleIconLogoSelect.disabled = true;
            } else {
                particleIconLogoSelect.disabled = false;
                for (let i = 0; i < logoCount; i++) {
                    const opt = document.createElement('option');
                    opt.value = String(i);
                    opt.textContent = `Logo ${i + 1}`;
                    particleIconLogoSelect.appendChild(opt);
                }
                selectedLogoIndex = Math.max(0, Math.min(selectedLogoIndex, logoCount - 1));
                particleIconLogoSelect.value = String(selectedLogoIndex);
            }
        }

        if (particleIconSelect) {
            particleIconSelect.innerHTML = '';
            const optClassic = document.createElement('option');
            optClassic.value = 'classic';
            optClassic.textContent = 'Classic (circles/squares)';
            particleIconSelect.appendChild(optClassic);

            const optSelf = document.createElement('option');
            optSelf.value = 'self';
            optSelf.textContent = 'Use This Logo';
            particleIconSelect.appendChild(optSelf);

            library.forEach((icon, idx) => {
                const opt = document.createElement('option');
                const label = icon && icon.name ? icon.name : `Icon ${idx + 1}`;
                opt.value = `icon:${icon.id}`;
                opt.textContent = `Icon ${idx + 1} - ${label}`;
                particleIconSelect.appendChild(opt);
            });

            if (logoCount > 0) {
                const assignment = assignments[selectedLogoIndex] || { type: 'classic' };
                const value = encodeAssignment(assignment);
                particleIconSelect.value = value;
                if (particleIconSelect.value !== value) {
                    particleIconSelect.value = 'classic';
                }
                particleIconSelect.disabled = false;
            } else {
                particleIconSelect.disabled = true;
            }
        }

        if (particleIconApplyAll) {
            particleIconApplyAll.disabled = logoCount <= 0;
        }
    };

    if (particleIconsToggle) {
        on(particleIconsToggle, 'change', (e) => {
            app.settings.particleIconEnabled = !!e.target.checked;
        });
    }

    if (particleIconRotation) {
        on(particleIconRotation, 'change', (e) => {
            const mode = String(e.target.value || 'spin');
            app.settings.particleIconRotate = (mode !== 'still');
        });
    }

    if (particleIconColorMode) {
        on(particleIconColorMode, 'change', (e) => {
            app.settings.particleIconColorMode = String(e.target.value || 'tint');
        });
    }

    if (particleIconUploadBtn && particleIconInput) {
        on(particleIconUploadBtn, 'click', () => {
            particleIconInput.click();
        });
        on(particleIconInput, 'change', async (e) => {
            const files = Array.from(e.target.files || []).filter(
                (f) => f && (f.type === 'image/svg+xml' || f.name.toLowerCase().endsWith('.svg'))
            );
            if (!files.length) return;
            const state = ensureParticleIconState();
            if (!state) return;

            try {
                const svgStrings = await Promise.all(files.map((f) => app.readFileAsText(f)));
                const now = Date.now();
                svgStrings.forEach((raw, i) => {
                    const sanitized = sanitizeSvgForLogo(raw);
                    const name = files[i] && files[i].name ? files[i].name : `Icon ${i + 1}`;
                    const baseId = (app && typeof app.hashString32 === 'function')
                        ? app.hashString32(sanitized)
                        : Math.floor(Math.random() * 1e9);
                    const id = `${baseId}-${now}-${i}`;
                    state.library.push({ id, name, svg: sanitized });
                });
            } catch (err) {
                console.error('Failed to read particle icon SVGs:', err);
                alert('Could not read one or more icon SVG files.');
            } finally {
                particleIconInput.value = '';
                refreshParticleIconUI();
            }
        });
    }

    if (particleIconLogoSelect) {
        on(particleIconLogoSelect, 'change', (e) => {
            const idx = Math.max(0, parseInt(e.target.value, 10) || 0);
            selectedLogoIndex = idx;
            refreshParticleIconUI();
        });
    }

    if (particleIconSelect) {
        on(particleIconSelect, 'change', (e) => {
            const logoCount = getLogoCount();
            if (logoCount <= 0) return;
            const assignment = decodeAssignment(e.target.value);
            setAssignmentForLogo(selectedLogoIndex, assignment);
        });
    }

    if (particleIconApplyAll && particleIconSelect) {
        on(particleIconApplyAll, 'click', () => {
            const assignment = decodeAssignment(particleIconSelect.value);
            applyAssignmentToAll(assignment);
            refreshParticleIconUI();
        });
    }

    refreshParticleIconUI();
    if (app) app.refreshParticleIconUI = refreshParticleIconUI;

    // Toggles
    on(document.getElementById('auto-rotate'), 'change', (e) => {
        app.autoRotate = e.target.checked;
        if (!e.target.checked) {
            app.rotationX = 0;
            app.rotationY = 0;
        }
    });

    // Real colors toggle (Apple-like cool/warm whites)
    const realColorsToggle = document.getElementById('real-colors');
    if (realColorsToggle) {
        on(realColorsToggle, 'change', (e) => {
            app.settings.realColors = !!e.target.checked;
            app.particleSystem.setRealColors(app.settings.realColors);
        });
    }

    // Color buttons
    document.querySelectorAll('.color-btn[data-color]').forEach(btn => {
        on(btn, 'click', () => {
            document.querySelectorAll('.color-btn[data-color]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const color = btn.dataset.color;
            app.settings.colorMode = color;
            app.particleSystem.setColorOverride(color);
        });
    });

    // Custom particle color
    const particleColorInput = document.getElementById('particle-color-custom');
    const particleColorApply = document.getElementById('particle-color-apply');
    const applyParticleCustom = () => {
        if (!particleColorInput) return;
        const color = particleColorInput.value;
        app.settings.colorMode = color;
        app.particleSystem.setColorOverride(color);
        document.querySelectorAll('.color-btn[data-color]').forEach(b => b.classList.remove('active'));
    };
    if (particleColorInput) {
        on(particleColorInput, 'change', applyParticleCustom);
    }
    if (particleColorApply) {
        on(particleColorApply, 'click', applyParticleCustom);
    }

    // Gradient overlay (logo-wide)
    const gradientEnabledToggle = document.getElementById('gradient-enabled');
    const gradientColorAInput = document.getElementById('gradient-color-a');
    const gradientColorBInput = document.getElementById('gradient-color-b');
    const gradientStrengthSlider = document.getElementById('gradient-strength');
    const gradientStrengthValue = document.getElementById('gradient-strength-value');
    const gradientDirectionSelect = document.getElementById('gradient-direction');

    const setGradientControlsDisabled = (disabled) => {
        if (gradientColorAInput) gradientColorAInput.disabled = disabled;
        if (gradientColorBInput) gradientColorBInput.disabled = disabled;
        if (gradientStrengthSlider) gradientStrengthSlider.disabled = disabled;
        if (gradientDirectionSelect) gradientDirectionSelect.disabled = disabled;
    };

    const applyGradientStrengthLabel = (strength01) => {
        if (!gradientStrengthValue) return;
        const pct = Math.round(clamp01(strength01) * 100);
        gradientStrengthValue.textContent = `${pct}%`;
    };

    // Init UI from settings
    if (gradientEnabledToggle) gradientEnabledToggle.checked = !!app.settings.gradientOverlayEnabled;
    if (gradientColorAInput && typeof app.settings.gradientColorA === 'string') gradientColorAInput.value = app.settings.gradientColorA;
    if (gradientColorBInput && typeof app.settings.gradientColorB === 'string') gradientColorBInput.value = app.settings.gradientColorB;
    if (gradientStrengthSlider) gradientStrengthSlider.value = String(Math.round(clamp01(app.settings.gradientStrength) * 100));
    applyGradientStrengthLabel(app.settings.gradientStrength);
    if (gradientDirectionSelect && typeof app.settings.gradientDirection === 'string') {
        gradientDirectionSelect.value = app.settings.gradientDirection;
    }
    setGradientControlsDisabled(!(app.settings && app.settings.gradientOverlayEnabled));

    if (gradientEnabledToggle) {
        on(gradientEnabledToggle, 'change', (e) => {
            app.settings.gradientOverlayEnabled = !!e.target.checked;
            setGradientControlsDisabled(!app.settings.gradientOverlayEnabled);
        });
    }

    if (gradientColorAInput) {
        on(gradientColorAInput, 'change', () => {
            app.settings.gradientColorA = gradientColorAInput.value;
        });
    }

    if (gradientColorBInput) {
        on(gradientColorBInput, 'change', () => {
            app.settings.gradientColorB = gradientColorBInput.value;
        });
    }

    if (gradientStrengthSlider) {
        setupSlider('gradient-strength', 70, (value) => {
            const v = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
            const strength = v / 100;
            app.settings.gradientStrength = strength;
        }, { 
            lifecycle,
            onInput: (value) => {
                applyGradientStrengthLabel(value / 100);
            }
        });
    }

    if (gradientDirectionSelect) {
        on(gradientDirectionSelect, 'change', () => {
            const v = String(gradientDirectionSelect.value || 'diag');
            const allowed = new Set(['ltr', 'ttb', 'diag', 'radial']);
            app.settings.gradientDirection = allowed.has(v) ? v : 'diag';
        });
    }

    // Background color palette
    const bgButtons = document.querySelectorAll('.bg-color-btn');
    bgButtons.forEach(btn => {
        on(btn, 'click', () => {
            bgButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const bg = btn.dataset.bg;
            if (bg === 'default') {
                app.settings.backgroundMode = 'default';
                app.settings.backgroundColor = '#0a0a0f';
                app.applyBackgroundColor(null);
            } else {
                app.settings.backgroundMode = 'custom';
                app.settings.backgroundColor = bg;
                app.applyBackgroundColor(bg);
            }
        });
    });

    // Custom background color
    const bgColorInput = document.getElementById('bg-color-custom');
    const bgColorApply = document.getElementById('bg-color-apply');
    const applyBgCustom = () => {
        if (!bgColorInput) return;
        const color = bgColorInput.value;
        app.settings.backgroundMode = 'custom';
        app.settings.backgroundColor = color;
        app.applyBackgroundColor(color);
        bgButtons.forEach(b => b.classList.remove('active'));
    };
    if (bgColorInput) {
        on(bgColorInput, 'change', applyBgCustom);
    }
    if (bgColorApply) {
        on(bgColorApply, 'click', applyBgCustom);
    }

    // Reset button
    on(document.getElementById('reset-btn'), 'click', () => {
        app.resetSettings();
    });

    // Export button
    on(document.getElementById('export-btn'), 'click', () => {
        app.exportModal.classList.add('active');
    });

    // --- Performance Tools (Magnet + Live Recording) ---
    const fluidGpuToggle = document.getElementById('fluid-gpu');
    const venomModeToggle = document.getElementById('venom-mode');
    const venomStrengthSlider = document.getElementById('venom-strength');
    const venomStrengthValue = document.getElementById('venom-strength-value');
    const magnetEnabledToggle = document.getElementById('magnet-enabled');
    const autoRotateToggle = document.getElementById('auto-rotate');

    // Fluid GPU simulation toggle
    if (fluidGpuToggle) {
        fluidGpuToggle.checked = !!(app.settings && app.settings.fluidGPU);
    }

    const applyVenomStrengthLabel = (strength01) => {
        if (!venomStrengthValue) return;
        const pct = Math.round(clamp01(strength01) * 100);
        venomStrengthValue.textContent = `${pct}%`;
    };

    if (venomModeToggle) {
        venomModeToggle.checked = !!(app.settings && app.settings.venomMode);
        on(venomModeToggle, 'change', (e) => {
            app.settings.venomMode = !!e.target.checked;
            if (venomStrengthSlider) {
                venomStrengthSlider.disabled = !app.settings.venomMode;
            }
        });
    }

    if (venomStrengthSlider) {
        const strength01 = clamp01(app.settings.venomStrength ?? 0.7);
        venomStrengthSlider.value = String(Math.round(strength01 * 100));
        venomStrengthSlider.disabled = !app.settings.venomMode;
        applyVenomStrengthLabel(strength01);
    }

    setupSlider('venom-strength', 70, (value) => {
        const v = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
        app.settings.venomStrength = v / 100;
    }, {
        lifecycle,
        onInput: (value) => {
            applyVenomStrengthLabel((parseInt(value, 10) || 0) / 100);
        }
    });

    const applyFluidGpuMode = (enabled) => {
        if (!app || !app.settings) return;
        const want = !!enabled;
        const gpuOk = !!(app.gpu && app.gpu.supported && app.renderer && app.renderer.gl && app.renderer.gpuProgram && !app.renderer.fallbackToCanvas2D);
        if (want && !gpuOk) {
            // GPU sim isn't available on this device; keep the app in CPU mode.
            app.settings.fluidGPU = false;
            if (fluidGpuToggle) fluidGpuToggle.checked = false;
            if (magnetEnabledToggle) magnetEnabledToggle.disabled = false;
            return;
        }

        app.settings.fluidGPU = want;

        // Magnet also works in GPU mode now; keep the current state and leave the toggle enabled.
        if (magnetEnabledToggle) {
            magnetEnabledToggle.disabled = false;
        }

        // Free GPU targets when disabling; build them on demand when enabling.
        if (!want) {
            if (typeof app.disposeSequenceGPUTargets === 'function') app.disposeSequenceGPUTargets();
            return;
        }

        // Build targets from the current logo(s) so the sim can start immediately.
        if ((app.svgData || app.currentImage || (app.logoSequence && app.logoSequence.sourceType === 'image')) &&
            typeof app.regenerateParticles === 'function') {
            app.regenerateParticles();
        }
    };

    if (fluidGpuToggle) {
        on(fluidGpuToggle, 'change', (e) => {
            applyFluidGpuMode(!!e.target.checked);
        });
    }

    if (magnetEnabledToggle) {
        magnetEnabledToggle.checked = !!(app.magnetTool && app.magnetTool.enabled);
        on(magnetEnabledToggle, 'change', (e) => {
            const enabled = !!e.target.checked;
            if (app.magnetTool) app.magnetTool.setEnabled(enabled);

            if (enabled) {
                // Keep magnet predictable (same rule as keyboard toggle).
                app.autoRotate = false;
                app.rotationX = 0;
                app.rotationY = 0;
                app.isDragging = false;
                if (autoRotateToggle) autoRotateToggle.checked = false;
            }
        });
    }

    // Apply initial state (keeps Magnet available in both CPU and GPU modes).
    applyFluidGpuMode(!!(app.settings && app.settings.fluidGPU));

    const magnetModeValue = document.getElementById('magnet-mode-value');
    const magnetModeAttract = document.getElementById('magnet-mode-attract');
    const magnetModeRepel = document.getElementById('magnet-mode-repel');
    const applyMagnetModeUI = (mode) => {
        const m = (mode === 'repel') ? 'repel' : 'attract';
        if (magnetModeValue) magnetModeValue.textContent = (m === 'repel') ? 'Repel' : 'Attract';
        if (magnetModeAttract) magnetModeAttract.classList.toggle('active', m === 'attract');
        if (magnetModeRepel) magnetModeRepel.classList.toggle('active', m === 'repel');
    };

    if (magnetModeAttract) {
        on(magnetModeAttract, 'click', () => {
            if (app.magnetTool) app.magnetTool.setMode('attract');
            applyMagnetModeUI('attract');
        });
    }
    if (magnetModeRepel) {
        on(magnetModeRepel, 'click', () => {
            if (app.magnetTool) app.magnetTool.setMode('repel');
            applyMagnetModeUI('repel');
        });
    }
    applyMagnetModeUI(app.magnetTool ? app.magnetTool.mode : 'attract');

    const magnetRadiusValue = document.getElementById('magnet-radius-value');
    const magnetRadiusSlider = document.getElementById('magnet-radius');
    if (magnetRadiusSlider && app.magnetTool) {
        magnetRadiusSlider.value = String(Math.round(app.magnetTool.radiusPx));
        if (magnetRadiusValue) magnetRadiusValue.textContent = `${Math.round(app.magnetTool.radiusPx)}px`;
    }
    setupSlider('magnet-radius', 140, (value) => {
        const px = Math.max(5, parseInt(value, 10) || 140);
        if (app.magnetTool) app.magnetTool.setRadiusPx(px);
    }, { 
        lifecycle,
        onInput: (value) => {
            if (magnetRadiusValue) magnetRadiusValue.textContent = `${value}px`;
        }
    });

    const magnetStrengthValue = document.getElementById('magnet-strength-value');
    const magnetStrengthSlider = document.getElementById('magnet-strength');
    if (magnetStrengthSlider && app.magnetTool) {
        const v = Math.round((app.magnetTool.strength || 0) * 100);
        magnetStrengthSlider.value = String(v);
        if (magnetStrengthValue) magnetStrengthValue.textContent = (v / 100).toFixed(2);
    }
    setupSlider('magnet-strength', 100, (value) => {
        const v = Math.max(0, parseInt(value, 10) || 0);
        const s = v / 100;
        if (app.magnetTool) app.magnetTool.setStrength(s);
    }, { 
        lifecycle,
        onInput: (value) => {
            if (magnetStrengthValue) magnetStrengthValue.textContent = (value / 100).toFixed(2);
        }
    });

    const recordBtn = document.getElementById('record-btn');
    const stopBtn = document.getElementById('record-stop-btn');
    const recordFps = document.getElementById('record-fps');
    if (recordBtn) {
        on(recordBtn, 'click', () => {
            const fps = Math.max(1, parseInt(recordFps?.value, 10) || 60);
            app.startLiveRecording({ fps });
        });
    }
    if (stopBtn) {
        on(stopBtn, 'click', () => {
            app.stopLiveRecording();
        });
    }
    app.updateRecordingUI();
}

/**
 * Setup range slider with debounced callback and immediate label updates
 */
export function setupSlider(id, defaultValue, callback, { lifecycle, onInput } = {}) {
    const slider = document.getElementById(id);
    if (!slider) return;

    let timeout;
    if (lifecycle && typeof lifecycle.addCleanup === 'function') {
        lifecycle.addCleanup(() => clearTimeout(timeout));
    }
    const signal = lifecycle && lifecycle.signal;

    slider.addEventListener('input', (e) => {
        const value = e.target.value;
        
        // Immediate update for UI labels
        if (typeof onInput === 'function') {
            onInput(value);
        }

        // Debounced update for heavy logic
        clearTimeout(timeout);
        timeout = setTimeout(() => callback(value), 50);
    }, signal ? { signal } : undefined);
}

export class ControlsController {
    constructor({ appCompat }) {
        this.app = appCompat;
    }

    init() {
        return setupControls({ appCompat: this.app, lifecycle: this.app && this.app.lifecycle });
    }
}
