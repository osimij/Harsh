/**
 * Particle Forge - Main Application
 * SVG to Particle Transformer
 */

import { SVGParser } from '../../svg-parser.js';
import { PointSampler } from '../../point-sampler.js';
import { ParticleSystem } from '../../particle-system.js';
import { Renderer } from '../../renderer.js';
import { TransitionDirector } from '../../transition-director.js';
import { RasterPointSampler } from '../../raster-point-sampler.js';
import { MagnetTool } from '../../magnet-tool.js';
import { LiveRecorder } from '../../live-recorder.js';
import { LogoShapeAnalyzer } from '../../logo-shape-analyzer.js';
import { ShapeTransitionDirector } from '../../shape-transition-director.js';

import { MAX_PARTICLE_DENSITY } from '../constants.js';
import { parseHexColorToRgb01, clamp01 } from '../utils/color.js';
import { applyVenomSimParams } from '../utils/venom.js';
import { logger } from '../utils/logger.js';
import { createInitialState } from './state.js';
import { getDefaultSettings } from './defaults.js';
import { createLifecycle } from './lifecycle.js';
import { createLoop } from './loop.js';
import { sanitizeAndParse, sanitizeAndParseMany, hasVectorPaths } from './svgPipeline.js';
import { setupUpload as setupUploadController } from '../ui/uploadController.js';
import { ControlsController, setupSlider as setupSliderController } from '../ui/controlsController.js';
import { setupInteraction as setupInteractionController } from '../ui/interactionController.js';
import { setupExportModal as setupExportModalController } from '../ui/exportModalController.js';
import { SequenceController } from '../features/sequenceController.js';
import { ExportController } from '../features/exportController.js';
import { RecordingController } from '../features/recordingController.js';
import { GPUController } from '../features/gpuController.js';

export class ParticleForge {
    constructor() {
        // Core modules
        this.svgParser = new SVGParser();
        this.pointSampler = new PointSampler();
        this.particleSystem = new ParticleSystem();
        this.renderer = null;
        this.rasterPointSampler = new RasterPointSampler();

        // App state container (Phase A: settings/logoSequence/gpu live here; other properties remain on the class)
        this.state = createInitialState();
        // Back-compat aliases (avoid churn while refactoring)
        this.settings = this.state.settings;
        this.logoSequence = this.state.logoSequence;
        this.gpu = this.state.gpu;
        this.particleIcons = this.state.particleIcons;

        // Lifecycle: used for listener cleanup via `{ signal }`
        this.lifecycle = createLifecycle();
        // RAF loop helper (deltaTime + fps counter)
        this.loop = createLoop();

        // DOM elements
        this.canvas = document.getElementById('particle-canvas');
        this.uploadZone = document.getElementById('upload-zone');
        this.svgInput = document.getElementById('svg-input');
        this.controlPanel = document.getElementById('control-panel');
        this.exportModal = document.getElementById('export-modal');

        // State
        this.svgData = null;
        this.currentSvgString = null;
        this.currentImage = null;
        this.currentSourceType = null;
        this.isAnimating = false;
        this.lastTime = 0;
        this.rotationX = 0;
        this.rotationY = 0;
        this.autoRotate = false;
        this.isDragging = false;
        this.dragStart = { x: 0, y: 0 };

        this._gpuTargetBuildToken = 0;
        this._gpuSingleTime = 0;
        this._rasterRegenToken = 0;
        this._uploadToken = 0;

        // Interactive mode: prefer variety (random scripts per transition).
        this.transitionDirector = new TransitionDirector({ userSeed: this.settings.transitionSeed, mode: 'random' });
        this.shapeTransitionDirector = new ShapeTransitionDirector({ userSeed: this.settings.transitionSeed });
        this.shapeAnalyzer = new LogoShapeAnalyzer();

        // Interactive “performance” tools
        this.magnetTool = new MagnetTool({
            enabled: false,
            mode: 'attract',
            radiusPx: 140,
            strength: 1.0
        });

        this.liveRecorder = new LiveRecorder(this.canvas);
        this._isRecording = false;

        // Single-logo (no-sequence) transition state
        this._singleShapeTransition = null;

        // Controllers (Phase B: start with a small set; others remain as module functions)
        this.controllers = {
            controls: new ControlsController({ appCompat: this }),
            sequence: new SequenceController({ appCompat: this }),
            export: new ExportController({ appCompat: this }),
            recording: new RecordingController({ appCompat: this }),
            gpu: new GPUController({ appCompat: this })
        };

        this.init();
    }

    /**
     * Initialize the application
     */
    init() {
        // Initialize renderer
        this.renderer = new Renderer(this.canvas);

        // Detect GPU simulation support (WebGL2 + EXT_color_buffer_float).
        // We don't enable it yet until the GPU renderer + samplers are in place.
        this.detectGPUSupport();

        // Setup event listeners
        this.setupUpload();
        this.setupControls();
        this.setupInteraction();
        this.setupExport();
        this.updateRecordingUI();

        // Handle resize
        this.handleResize();
        window.addEventListener('resize', () => this.handleResize(), { signal: this.lifecycle.signal });

        // Start render loop
        this.startAnimation();

        // Load preset settings if provided via window globals
        this.loadPresetSettings();

        // Load demo SVG for testing
        this.loadDemoSVG();
    }

    detectGPUSupport() {
        return this.controllers.gpu.detectGPUSupport();
    }

    getDensityForType(type) {
        const fallback = Math.max(100, parseInt(this.settings.density, 10) || 15000);
        const isImage = String(type || '').toLowerCase() === 'image';
        const raw = isImage ? this.settings.imageDensity : this.settings.logoDensity;
        const n = Math.max(100, parseInt(raw, 10) || fallback);
        return Math.min(MAX_PARTICLE_DENSITY, n);
    }

    getCurrentSourceType() {
        if (this.logoSequence && Array.isArray(this.logoSequence.items) && this.logoSequence.items.length) {
            const idx = Math.max(0, Math.min(this.logoSequence.index || 0, this.logoSequence.items.length - 1));
            const item = this.logoSequence.items[idx];
            if (item && item.type) return item.type;
        }
        if (this.logoSequence && this.logoSequence.sourceType) return this.logoSequence.sourceType;
        return this.currentSourceType || 'svg';
    }

    isUploadTokenStale(token) {
        return token !== this._uploadToken;
    }

    getDesiredParticleCount({ type = null, useMax = false } = {}) {
        const logoDensity = this.getDensityForType('svg');
        const imageDensity = this.getDensityForType('image');
        const hasMixed = !!(this.logoSequence && this.logoSequence.sourceType === 'mixed');
        if (useMax) {
            return Math.min(MAX_PARTICLE_DENSITY, Math.max(logoDensity, imageDensity));
        }
        if (type) {
            return this.getDensityForType(type);
        }
        if (hasMixed) {
            return Math.min(MAX_PARTICLE_DENSITY, Math.max(logoDensity, imageDensity));
        }
        const resolved = this.getCurrentSourceType();
        return this.getDensityForType(resolved);
    }

    shouldUseGPU() {
        return this.controllers.gpu.shouldUseGPU();
    }

    ensureGPUSim() {
        return this.controllers.gpu.ensureGPUSim();
    }

    /**
     * Load a demo SVG
     */
    loadDemoSVG() {
        // Simple star logo for demo
        const demoSVG = `
            <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" style="stop-color:#ffffff"/>
                        <stop offset="100%" style="stop-color:#a0a0a0"/>
                    </linearGradient>
                </defs>
                <circle cx="50" cy="50" r="45" fill="#d4d4d8"/>
                <polygon points="50,10 61,40 95,40 68,60 79,90 50,72 21,90 32,60 5,40 39,40" fill="#0a0a0f"/>
            </svg>
        `;

        setTimeout(() => {
            // Don't auto-load, wait for user upload
        }, 500);
    }

    /**
     * Setup file upload functionality
     */
    setupUpload() {
        setupUploadController({
            dom: {
                uploadZone: this.uploadZone,
                svgInput: this.svgInput
            },
            appCompat: this,
            lifecycle: this.lifecycle
        });
    }

    /**
     * Handle uploaded file
     */
    async handleFile(file) {
        return this.handleFiles([file]);
    }

    /**
     * Handle one or more uploaded SVG files.
     * If multiple are provided, we build a logo sequence that morphs between them.
     */
    async handleFiles(files) {
        try {
            const list = Array.from(files || []);
            if (!list.length) return;

            const isSvgFile = (f) => f && (f.type === 'image/svg+xml' || f.name.toLowerCase().endsWith('.svg'));
            const isImageFile = (f) => f && (
                f.type === 'image/png' ||
                f.type === 'image/jpeg' ||
                f.type === 'image/webp' ||
                f.name.toLowerCase().endsWith('.png') ||
                f.name.toLowerCase().endsWith('.jpg') ||
                f.name.toLowerCase().endsWith('.jpeg') ||
                f.name.toLowerCase().endsWith('.webp')
            );

            const items = await Promise.all(list.map(async (f) => {
                if (isImageFile(f)) {
                    const imageInfo = await this.readFileAsImage(f);
                    return { type: 'image', imageInfo };
                }
                if (isSvgFile(f)) {
                    const svgString = await this.readFileAsText(f);
                    return { type: 'svg', svgString };
                }
                return null;
            }));

            const filtered = items.filter(Boolean);
            if (!filtered.length) return;

            const hasSvg = filtered.some((item) => item.type === 'svg');
            const hasImage = filtered.some((item) => item.type === 'image');

            if (filtered.length === 1) {
                const only = filtered[0];
                if (only.type === 'image') {
                    await this.processImage(only.imageInfo);
                } else {
                    this.processSVG(only.svgString);
                }
                if (this.svgInput) this.svgInput.value = '';
                return;
            }

            if (hasSvg && hasImage) {
                await this.processMixedSequence(filtered);
            } else if (hasImage) {
                const images = filtered.map((item) => item.imageInfo);
                await this.processImageSequence(images);
            } else {
                const svgStrings = filtered.map((item) => item.svgString);
                this.processSVGSequence(svgStrings);
            }

            // Allow re-uploading the same file (some browsers won't fire change if value unchanged)
            if (this.svgInput) this.svgInput.value = '';
        } catch (error) {
            console.error('Error reading file:', error);
        }
    }

    /**
     * Read a File as text with a safe fallback for older browsers.
     */
    readFileAsText(file) {
        if (file && typeof file.text === 'function') {
            return file.text();
        }

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
            reader.onload = () => resolve(String(reader.result || ''));
            reader.readAsText(file);
        });
    }

    readFileAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
            reader.onload = () => resolve(String(reader.result || ''));
            reader.readAsDataURL(file);
        });
    }

    loadImageFromSrc(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.decoding = 'async';
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = src;
        });
    }

    async readFileAsImage(file) {
        const src = await this.readFileAsDataURL(file);
        const img = await this.loadImageFromSrc(src);
        return {
            src,
            image: img,
            width: img.naturalWidth || img.width || 0,
            height: img.naturalHeight || img.height || 0,
            name: file && file.name ? file.name : 'image'
        };
    }

    /**
     * Process SVG string and generate particles
     */
    processSVG(svgString) {
        const token = ++this._uploadToken;
        try {
            this.stopLogoSequence();
            this.currentSourceType = 'svg';
            this.currentImage = null;
            if (this.logoSequence) this.logoSequence.sourceType = 'svg';
            const { sanitized, svgData } = sanitizeAndParse(this.svgParser, svgString);
            this.currentSvgString = sanitized;
            this.resetParticleIconAssignments(1);
            if (typeof this.refreshParticleIconUI === 'function') {
                this.refreshParticleIconUI();
            }

            // Parse SVG
            this.svgData = svgData;
            logger.debug('Parsed SVG:', this.svgData);

            const desiredCount = this.getDesiredParticleCount({ type: 'svg' });
            const rendererHasGPU = !!(this.renderer && this.renderer.gpuProgram);

            // High-density path: avoid CPU sampling (too slow). Build GPU targets asynchronously.
            if (desiredCount >= 200000 && this.gpu.supported && rendererHasGPU) {
                // Clear CPU particles (GPU will take over once targets are ready)
                this.particleSystem.initialize([], { ambientCount: 0 });
	                this.particleSystem.updateSettings({
	                    size: this.settings.size,
	                    depthVariance: this.settings.depthVariance,
	                    animationSpeed: this.settings.animationSpeed,
	                    sizeRandom: this.settings.sizeRandom,
	                    sizeMin: this.settings.sizeMin,
	                    sizeMax: this.settings.sizeMax,
	                    opacityRandom: this.settings.opacityRandom,
	                    opacityMin: this.settings.opacityMin,
	                    opacityMax: this.settings.opacityMax,
	                    zoom: this.settings.zoom,
	                    squaresEnabled: this.settings.squaresEnabled,
	                    squareRatio: this.settings.squareRatio,
                    dissolveCycle: false,
                    cycleSeconds: this.settings.cycleSeconds,
                    holdSeconds: this.settings.holdSeconds,
                    chaos: this.settings.chaos
                });
                this.particleSystem.setColorOverride(this.settings.colorMode);
                this.particleSystem.setRealColors(this.settings.realColors);

                // Update UI immediately, then build GPU targets in the background.
                this.uploadZone.classList.add('hidden');
                this.updateParticleCount();
                this.buildGPUTargetsForSingle(sanitized).catch((e) => logger.warn(e));
                return;
            }

            // If the vector parser couldn't extract any paths (common for SVGs that rely on <use>, masks, etc),
            // fall back to raster-based sampling so logos still show up.
            if (!hasVectorPaths(this.svgData)) {
                this.processSVGRasterFallback(sanitized).catch((e) => {
                    console.error(e);
                    alert('Error processing SVG (raster fallback): ' + e.message);
                });
                return;
            }

            // CPU path (low/medium densities)
            const sampled = this.pointSampler.sample(this.svgData, desiredCount);
            const fitted = this.fitPointCount(sampled, desiredCount);
            const points = this.applyEdgeAuraToLogoPoints(fitted, {
                amount: this.settings.edgeAuraAmount,
                spread: this.settings.edgeAuraSpread,
                outlier: this.settings.edgeAuraOutlier
            });
            logger.debug('Generated points:', points.length);

            if (!points.length) {
                this.processSVGRasterFallback(sanitized).catch((e) => {
                    console.error(e);
                    alert('Error processing SVG (raster fallback): ' + e.message);
                });
                return;
            }

            // Initialize particle system
            this.particleSystem.initialize(points, { ambientCount: this.getAmbientCount(desiredCount) });
	            this.particleSystem.updateSettings({
	                size: this.settings.size,
	                depthVariance: this.settings.depthVariance,
	                animationSpeed: this.settings.animationSpeed,
	                sizeRandom: this.settings.sizeRandom,
	                sizeMin: this.settings.sizeMin,
	                sizeMax: this.settings.sizeMax,
	                opacityRandom: this.settings.opacityRandom,
	                opacityMin: this.settings.opacityMin,
	                opacityMax: this.settings.opacityMax,
	                zoom: this.settings.zoom,
	                squaresEnabled: this.settings.squaresEnabled,
	                squareRatio: this.settings.squareRatio,
                dissolveCycle: this.settings.dissolveCycle,
                cycleSeconds: this.settings.cycleSeconds,
                holdSeconds: this.settings.holdSeconds,
                chaos: this.settings.chaos
            });

            // Apply color mode + optional "real colors" palette
            this.particleSystem.setColorOverride(this.settings.colorMode);
            this.particleSystem.setRealColors(this.settings.realColors);

            // Make the first logo "appear" from scattered particles (Apple-like scattered → detailed feel)
            this.particleSystem.scatter(1.0);

            // GPU targets:
            // - Fluid Motion (GPU): build directly from the sampled point cloud (fast)
            // - Otherwise: only build high-density targets for export (async, non-blocking)
            if (this.settings && this.settings.fluidGPU) {
                try {
                    this.controllers.gpu.buildGPUTargetsFromPointClouds([points]);
                } catch (e) {
                    logger.warn(e);
                }
            } else {
                this.buildGPUTargetsForSingle(sanitized).catch((e) => logger.warn(e));
            }

            // Update UI
            this.uploadZone.classList.add('hidden');
            this.updateParticleCount();

        } catch (error) {
            console.error('Error processing SVG:', error);
            alert('Error processing SVG: ' + error.message);
        }
    }

    /**
     * Process a raster image and generate particles with per-pixel color.
     */
    async processImage(imageInfo) {
        const token = ++this._uploadToken;
        try {
            this.stopLogoSequence();
            this.currentSourceType = 'image';
            this.currentSvgString = null;
            this.svgData = null;
            this.currentImage = imageInfo;
            if (this.logoSequence) {
                this.logoSequence.sourceType = 'image';
                this.logoSequence.imageSources = [];
            }

            this.resetParticleIconAssignments(1);
            if (typeof this.refreshParticleIconUI === 'function') {
                this.refreshParticleIconUI();
            }

            // Preserve photo colors by default
            if (this.settings) {
                this.settings.realColors = false;
                this.settings.colorMode = 'original';
                this.settings.gradientOverlayEnabled = false;
            }
            const realColorsToggle = document.getElementById('real-colors');
            if (realColorsToggle) realColorsToggle.checked = !!this.settings.realColors;
            const gradientEnabledToggle = document.getElementById('gradient-enabled');
            if (gradientEnabledToggle) gradientEnabledToggle.checked = !!this.settings.gradientOverlayEnabled;
            document.querySelectorAll('.color-btn[data-color]').forEach(b => b.classList.remove('active'));
            const originalBtn = document.querySelector('.color-btn[data-color="original"]');
            if (originalBtn) originalBtn.classList.add('active');
            const gradientColorAInput = document.getElementById('gradient-color-a');
            const gradientColorBInput = document.getElementById('gradient-color-b');
            const gradientStrengthSlider = document.getElementById('gradient-strength');
            const gradientDirectionSelect = document.getElementById('gradient-direction');
            if (gradientColorAInput) gradientColorAInput.disabled = true;
            if (gradientColorBInput) gradientColorBInput.disabled = true;
            if (gradientStrengthSlider) gradientStrengthSlider.disabled = true;
            if (gradientDirectionSelect) gradientDirectionSelect.disabled = true;

            const desiredCount = this.getDesiredParticleCount({ type: 'svg' });
            const rendererHasGPU = !!(this.renderer && this.renderer.gpuProgram);

            // High-density path: build GPU targets asynchronously.
            if (desiredCount >= 200000 && this.gpu.supported && rendererHasGPU) {
                this.particleSystem.initialize([], { ambientCount: 0 });
                this.particleSystem.updateSettings({
                    size: this.settings.size,
                    depthVariance: this.settings.depthVariance,
                    animationSpeed: this.settings.animationSpeed,
                    sizeRandom: this.settings.sizeRandom,
                    sizeMin: this.settings.sizeMin,
                    sizeMax: this.settings.sizeMax,
                    opacityRandom: this.settings.opacityRandom,
                    opacityMin: this.settings.opacityMin,
                    opacityMax: this.settings.opacityMax,
                    zoom: this.settings.zoom,
                    squaresEnabled: this.settings.squaresEnabled,
                    squareRatio: this.settings.squareRatio,
                    dissolveCycle: false,
                    cycleSeconds: this.settings.cycleSeconds,
                    holdSeconds: this.settings.holdSeconds,
                    chaos: this.settings.chaos
                });
                this.particleSystem.setColorOverride(this.settings.colorMode);
                this.particleSystem.setRealColors(this.settings.realColors);

                this.uploadZone.classList.add('hidden');
                this.updateParticleCount();
                this.buildGPUTargetsForImage(imageInfo).catch((e) => logger.warn(e));
                return;
            }

            const rasterSize = desiredCount >= 60000 ? 2048 : 1024;
            const points = await this.rasterPointSampler.sampleImagePoints(imageInfo, desiredCount, {
                rasterSize,
                seed: this.settings.transitionSeed,
                lumaThreshold: 10,
                lumaWeightPower: 1.15,
                intensityPower: 1.05,
                edgeRatio: 0.3,
                edgeAuraEnabled: this.settings.edgeAuraEnabled,
                edgeAuraAmount: this.settings.edgeAuraAmount,
                edgeAuraSpread: this.settings.edgeAuraSpread,
                edgeAuraOutlier: this.settings.edgeAuraOutlier
            });
            const fitted = this.fitPointCount(points, desiredCount);

            this.particleSystem.initialize(fitted, { ambientCount: 0 });
            this.particleSystem.updateSettings({
                size: this.settings.size,
                depthVariance: this.settings.depthVariance,
                animationSpeed: this.settings.animationSpeed,
                sizeRandom: this.settings.sizeRandom,
                sizeMin: this.settings.sizeMin,
                sizeMax: this.settings.sizeMax,
                opacityRandom: this.settings.opacityRandom,
                opacityMin: this.settings.opacityMin,
                opacityMax: this.settings.opacityMax,
                zoom: this.settings.zoom,
                squaresEnabled: this.settings.squaresEnabled,
                squareRatio: this.settings.squareRatio,
                dissolveCycle: this.settings.dissolveCycle,
                cycleSeconds: this.settings.cycleSeconds,
                holdSeconds: this.settings.holdSeconds,
                chaos: this.settings.chaos
            });

            this.particleSystem.setColorOverride(this.settings.colorMode);
            this.particleSystem.setRealColors(this.settings.realColors);
            this.particleSystem.scatter(1.0);

            if (this.settings && this.settings.fluidGPU) {
                try {
                    this.controllers.gpu.buildGPUTargetsFromPointClouds([fitted]);
                } catch (e) {
                    logger.warn(e);
                }
            } else {
                this.buildGPUTargetsForImage(imageInfo).catch((e) => logger.warn(e));
            }

            this.uploadZone.classList.add('hidden');
            this.updateParticleCount();
        } catch (error) {
            console.error('Error processing image:', error);
            alert('Error processing image: ' + error.message);
        }
    }

    /**
     * Process multiple images and start a morphing sequence.
     */
    async processImageSequence(imageInfos) {
        const token = ++this._uploadToken;
        try {
            this.stopLogoSequence();
            this.currentSourceType = 'image';
            this.currentSvgString = null;
            this.svgData = null;
            this.currentImage = (imageInfos && imageInfos.length) ? imageInfos[0] : null;

            const list = Array.isArray(imageInfos) ? imageInfos : [];
            const logoCount = list.length;
            this.resetParticleIconAssignments(logoCount);
            if (typeof this.refreshParticleIconUI === 'function') {
                this.refreshParticleIconUI();
            }

            if (this.settings) {
                this.settings.realColors = false;
                this.settings.colorMode = 'original';
                this.settings.gradientOverlayEnabled = false;
            }
            const realColorsToggle = document.getElementById('real-colors');
            if (realColorsToggle) realColorsToggle.checked = !!this.settings.realColors;
            const gradientEnabledToggle = document.getElementById('gradient-enabled');
            if (gradientEnabledToggle) gradientEnabledToggle.checked = !!this.settings.gradientOverlayEnabled;
            document.querySelectorAll('.color-btn[data-color]').forEach(b => b.classList.remove('active'));
            const originalBtn = document.querySelector('.color-btn[data-color="original"]');
            if (originalBtn) originalBtn.classList.add('active');
            const gradientColorAInput = document.getElementById('gradient-color-a');
            const gradientColorBInput = document.getElementById('gradient-color-b');
            const gradientStrengthSlider = document.getElementById('gradient-strength');
            const gradientDirectionSelect = document.getElementById('gradient-direction');
            if (gradientColorAInput) gradientColorAInput.disabled = true;
            if (gradientColorBInput) gradientColorBInput.disabled = true;
            if (gradientStrengthSlider) gradientStrengthSlider.disabled = true;
            if (gradientDirectionSelect) gradientDirectionSelect.disabled = true;

            const desiredCount = this.getDesiredParticleCount();
            const rendererHasGPU = !!(this.renderer && this.renderer.gpuProgram);

            if (desiredCount >= 200000 && this.gpu.supported && rendererHasGPU) {
                this.logoSequence = this.state.logoSequence = {
                    active: list.length > 1,
                    sourceType: 'image',
                    svgStrings: [],
                    svgDatas: [],
                    imageSources: [...list],
                    pointClouds: new Array(list.length).fill([]),
                    logoIds: list.map((img) => this.hashString32(img.src || img.name || 'image')),
                    countRatios: new Array(list.length).fill(1),
                    gpuTargets: null,
                    index: 0,
                    transition: null,
                    holdTimer: 0
                };

                this.particleSystem.initialize([], { ambientCount: 0 });
                this.particleSystem.updateSettings({
                    size: this.settings.size,
                    depthVariance: this.settings.depthVariance,
                    animationSpeed: this.settings.animationSpeed,
                    sizeRandom: this.settings.sizeRandom,
                    sizeMin: this.settings.sizeMin,
                    sizeMax: this.settings.sizeMax,
                    opacityRandom: this.settings.opacityRandom,
                    opacityMin: this.settings.opacityMin,
                    opacityMax: this.settings.opacityMax,
                    zoom: this.settings.zoom,
                    squaresEnabled: this.settings.squaresEnabled,
                    squareRatio: this.settings.squareRatio,
                    dissolveCycle: false,
                    cycleSeconds: this.settings.cycleSeconds,
                    holdSeconds: this.settings.holdSeconds,
                    chaos: this.settings.chaos
                });
                this.particleSystem.setColorOverride(this.settings.colorMode);
                this.particleSystem.setRealColors(this.settings.realColors);

                this.uploadZone.classList.add('hidden');
                this.updateParticleCount();
                this.buildGPUTargetsForImageSequence(list).catch((e) => logger.warn(e));
                return;
            }

            const rasterSize = desiredCount >= 60000 ? 2048 : 1024;
            const pointClouds = [];
            for (const info of list) {
                // eslint-disable-next-line no-await-in-loop
                const pts = await this.rasterPointSampler.sampleImagePoints(info, desiredCount, {
                    rasterSize,
                    seed: this.settings.transitionSeed,
                    lumaThreshold: 10,
                    lumaWeightPower: 1.15,
                    intensityPower: 1.05,
                    edgeRatio: 0.3,
                    edgeAuraEnabled: this.settings.edgeAuraEnabled,
                    edgeAuraAmount: this.settings.edgeAuraAmount,
                    edgeAuraSpread: this.settings.edgeAuraSpread,
                    edgeAuraOutlier: this.settings.edgeAuraOutlier
                });
                pointClouds.push(this.fitPointCount(pts, desiredCount));
            }

            if (!pointClouds.length || !pointClouds[0].length) {
                throw new Error('No points generated from the provided images.');
            }

            this.logoSequence = this.state.logoSequence = {
                active: pointClouds.length > 1,
                sourceType: 'image',
                svgStrings: [],
                svgDatas: [],
                imageSources: [...list],
                pointClouds,
                logoIds: list.map((img) => this.hashString32(img.src || img.name || 'image')),
                countRatios: new Array(pointClouds.length).fill(1),
                gpuTargets: null,
                index: 0,
                transition: null,
                holdTimer: 0
            };

            this.particleSystem.initialize(pointClouds[0], { ambientCount: 0 });
            this.particleSystem.updateSettings({
                size: this.settings.size,
                depthVariance: this.settings.depthVariance,
                animationSpeed: this.settings.animationSpeed,
                sizeRandom: this.settings.sizeRandom,
                sizeMin: this.settings.sizeMin,
                sizeMax: this.settings.sizeMax,
                opacityRandom: this.settings.opacityRandom,
                opacityMin: this.settings.opacityMin,
                opacityMax: this.settings.opacityMax,
                zoom: this.settings.zoom,
                squaresEnabled: this.settings.squaresEnabled,
                squareRatio: this.settings.squareRatio,
                dissolveCycle: this.settings.dissolveCycle,
                cycleSeconds: this.settings.cycleSeconds,
                holdSeconds: this.settings.holdSeconds,
                chaos: this.settings.chaos
            });

            this.particleSystem.setColorOverride(this.settings.colorMode);
            this.particleSystem.setRealColors(this.settings.realColors);
            this.particleSystem.scatter(1.0);

            if (this.settings && this.settings.fluidGPU) {
                try {
                    this.controllers.gpu.buildGPUTargetsFromPointClouds(pointClouds);
                } catch (e) {
                    logger.warn(e);
                }
            } else {
                this.buildGPUTargetsForImageSequence(list).catch((e) => logger.warn(e));
            }

            this.uploadZone.classList.add('hidden');
            this.updateParticleCount();
        } catch (error) {
            console.error('Error processing image sequence:', error);
            alert('Error processing images: ' + error.message);
        }
    }

    /**
     * Process a mixed SVG + image sequence (keeps original order).
     */
    async processMixedSequence(items) {
        const token = ++this._uploadToken;
        try {
            this.stopLogoSequence();

            const list = Array.isArray(items) ? items : [];
            if (!list.length) return;

            const hasSvg = list.some((item) => item && item.type === 'svg');
            const hasImage = list.some((item) => item && item.type === 'image');

            this.currentSourceType = list[0] && list[0].type ? list[0].type : 'svg';
            this.currentSvgString = null;
            this.currentImage = null;
            this.svgData = null;

            const logoCount = list.length;
            this.resetParticleIconAssignments(logoCount);
            if (typeof this.refreshParticleIconUI === 'function') {
                this.refreshParticleIconUI();
            }

            if (hasImage && this.settings) {
                this.settings.realColors = false;
                this.settings.colorMode = 'original';
                this.settings.gradientOverlayEnabled = false;
            }
            const realColorsToggle = document.getElementById('real-colors');
            if (realColorsToggle) realColorsToggle.checked = !!this.settings.realColors;
            const gradientEnabledToggle = document.getElementById('gradient-enabled');
            if (gradientEnabledToggle) gradientEnabledToggle.checked = !!this.settings.gradientOverlayEnabled;
            document.querySelectorAll('.color-btn[data-color]').forEach(b => b.classList.remove('active'));
            const originalBtn = document.querySelector('.color-btn[data-color="original"]');
            if (originalBtn) originalBtn.classList.add('active');
            const gradientColorAInput = document.getElementById('gradient-color-a');
            const gradientColorBInput = document.getElementById('gradient-color-b');
            const gradientStrengthSlider = document.getElementById('gradient-strength');
            const gradientDirectionSelect = document.getElementById('gradient-direction');
            if (gradientColorAInput) gradientColorAInput.disabled = true;
            if (gradientColorBInput) gradientColorBInput.disabled = true;
            if (gradientStrengthSlider) gradientStrengthSlider.disabled = true;
            if (gradientDirectionSelect) gradientDirectionSelect.disabled = true;

            const poolCount = this.getDesiredParticleCount({ useMax: true });
            const rendererHasGPU = !!(this.renderer && this.renderer.gpuProgram);

            const svgStrings = new Array(logoCount).fill(null);
            const svgDatas = new Array(logoCount).fill(null);
            const imageSources = new Array(logoCount).fill(null);
            const itemsNormalized = new Array(logoCount);
            const logoIds = new Array(logoCount);
            const countRatios = new Array(logoCount);

            for (let i = 0; i < logoCount; i++) {
                const item = list[i];
                if (item && item.type === 'image') {
                    const info = item.imageInfo;
                    itemsNormalized[i] = { type: 'image', imageInfo: info };
                    imageSources[i] = info;
                    const desired = this.getDesiredParticleCount({ type: 'image' });
                    countRatios[i] = poolCount > 0 ? Math.min(1, desired / poolCount) : 1;
                    logoIds[i] = this.hashString32((info && (info.src || info.name)) || 'image');
                } else {
                    const svgString = item && item.svgString ? item.svgString : '';
                    const { sanitized, svgData } = sanitizeAndParse(this.svgParser, svgString);
                    itemsNormalized[i] = { type: 'svg', svgString: sanitized };
                    svgStrings[i] = sanitized;
                    svgDatas[i] = svgData;
                    const desired = this.getDesiredParticleCount({ type: 'svg' });
                    countRatios[i] = poolCount > 0 ? Math.min(1, desired / poolCount) : 1;
                    logoIds[i] = this.hashString32(sanitized);
                }
            }

            if (poolCount >= 200000 && this.gpu.supported && rendererHasGPU) {
                this.logoSequence = this.state.logoSequence = {
                    active: logoCount > 1,
                    sourceType: 'mixed',
                    items: itemsNormalized,
                    svgStrings,
                    svgDatas,
                    imageSources,
                    pointClouds: new Array(logoCount).fill([]),
                    logoIds,
                    countRatios,
                    gpuTargets: null,
                    index: 0,
                    transition: null,
                    holdTimer: 0
                };

                const first = itemsNormalized[0];
                if (first && first.type === 'image') {
                    this.currentImage = imageSources[0];
                    this.currentSvgString = null;
                    this.svgData = null;
                    this.currentSourceType = 'image';
                } else {
                    this.currentImage = null;
                    this.currentSvgString = svgStrings[0];
                    this.svgData = svgDatas[0];
                    this.currentSourceType = 'svg';
                }

                this.particleSystem.initialize([], { ambientCount: 0 });
                this.particleSystem.updateSettings({
                    size: this.settings.size,
                    depthVariance: this.settings.depthVariance,
                    animationSpeed: this.settings.animationSpeed,
                    sizeRandom: this.settings.sizeRandom,
                    sizeMin: this.settings.sizeMin,
                    sizeMax: this.settings.sizeMax,
                    opacityRandom: this.settings.opacityRandom,
                    opacityMin: this.settings.opacityMin,
                    opacityMax: this.settings.opacityMax,
                    zoom: this.settings.zoom,
                    squaresEnabled: this.settings.squaresEnabled,
                    squareRatio: this.settings.squareRatio,
                    dissolveCycle: false,
                    cycleSeconds: this.settings.cycleSeconds,
                    holdSeconds: this.settings.holdSeconds,
                    chaos: this.settings.chaos
                });
                this.particleSystem.setColorOverride(this.settings.colorMode);
                this.particleSystem.setRealColors(this.settings.realColors);

                this.uploadZone.classList.add('hidden');
                this.updateParticleCount();
                this.buildGPUTargetsForMixedSequence(itemsNormalized).catch((e) => logger.warn(e));
                return;
            }

            const logoDensity = this.getDensityForType('svg');
            const ambientCount = hasSvg ? this.getAmbientCount(logoDensity) : 0;

            const pointClouds = new Array(logoCount);
            for (let i = 0; i < logoCount; i++) {
                const item = itemsNormalized[i];
                if (item.type === 'image') {
                    const desired = this.getDesiredParticleCount({ type: 'image' });
                    const rasterSize = desired >= 60000 ? 2048 : 1024;
                    // eslint-disable-next-line no-await-in-loop
                    const points = await this.rasterPointSampler.sampleImagePoints(item.imageInfo, desired, {
                        rasterSize,
                        seed: this.settings.transitionSeed,
                        lumaThreshold: 10,
                        lumaWeightPower: 1.15,
                        intensityPower: 1.05,
                        edgeRatio: 0.3,
                        edgeAuraEnabled: this.settings.edgeAuraEnabled,
                        edgeAuraAmount: this.settings.edgeAuraAmount,
                        edgeAuraSpread: this.settings.edgeAuraSpread,
                        edgeAuraOutlier: this.settings.edgeAuraOutlier
                    });
                    let fitted = this.fitPointCount(points, desired);
                    fitted = this.fitPointCount(fitted, poolCount);
                    pointClouds[i] = fitted;
                } else {
                    const desired = this.getDesiredParticleCount({ type: 'svg' });
                    const svgData = svgDatas[i];
                    let points = [];
                    if (svgData && hasVectorPaths(svgData)) {
                        const sampled = this.pointSampler.sample(svgData, desired);
                        points = this.fitPointCount(sampled, desired);
                    } else {
                        const rasterSize = desired >= 60000 ? 2048 : 1024;
                        // eslint-disable-next-line no-await-in-loop
                        const sampled = await this.rasterPointSampler.samplePoints(svgStrings[i], desired, {
                            rasterSize,
                            seed: this.settings.transitionSeed,
                            edgeRatio: 0.6
                        });
                        points = this.fitPointCount(sampled, desired);
                    }
                    points = this.applyEdgeAuraToLogoPoints(points, {
                        amount: this.settings.edgeAuraAmount,
                        spread: this.settings.edgeAuraSpread,
                        outlier: this.settings.edgeAuraOutlier
                    });
                    pointClouds[i] = this.fitPointCount(points, poolCount);
                }
            }

            this.logoSequence = this.state.logoSequence = {
                active: logoCount > 1,
                sourceType: 'mixed',
                items: itemsNormalized,
                svgStrings,
                svgDatas,
                imageSources,
                pointClouds,
                logoIds,
                countRatios,
                gpuTargets: null,
                index: 0,
                transition: null,
                holdTimer: 0
            };

            const first = itemsNormalized[0];
            if (first && first.type === 'image') {
                this.currentImage = imageSources[0];
                this.currentSvgString = null;
                this.svgData = null;
                this.currentSourceType = 'image';
            } else {
                this.currentImage = null;
                this.currentSvgString = svgStrings[0];
                this.svgData = svgDatas[0];
                this.currentSourceType = 'svg';
            }

            this.particleSystem.initialize(pointClouds[0], { ambientCount });
            this.particleSystem.updateSettings({
                size: this.settings.size,
                depthVariance: this.settings.depthVariance,
                animationSpeed: this.settings.animationSpeed,
                sizeRandom: this.settings.sizeRandom,
                sizeMin: this.settings.sizeMin,
                sizeMax: this.settings.sizeMax,
                opacityRandom: this.settings.opacityRandom,
                opacityMin: this.settings.opacityMin,
                opacityMax: this.settings.opacityMax,
                zoom: this.settings.zoom,
                squaresEnabled: this.settings.squaresEnabled,
                squareRatio: this.settings.squareRatio,
                dissolveCycle: this.settings.dissolveCycle,
                cycleSeconds: this.settings.cycleSeconds,
                holdSeconds: this.settings.holdSeconds,
                chaos: this.settings.chaos
            });

            this.particleSystem.setColorOverride(this.settings.colorMode);
            this.particleSystem.setRealColors(this.settings.realColors);
            this.particleSystem.scatter(1.0);

            if (this.settings && this.settings.fluidGPU) {
                try {
                    this.controllers.gpu.buildGPUTargetsFromPointClouds(pointClouds);
                } catch (e) {
                    logger.warn(e);
                }
            } else {
                this.buildGPUTargetsForMixedSequence(itemsNormalized).catch((e) => logger.warn(e));
            }

            this.uploadZone.classList.add('hidden');
            this.updateParticleCount();
        } catch (error) {
            console.error('Error processing mixed sequence:', error);
            alert('Error processing mixed sequence: ' + error.message);
        }
    }

    /**
     * Raster fallback: render the SVG into an alpha mask and sample points from pixels.
     * This supports many SVG features that the simple vector parser doesn't (e.g. <use>, clipPath/mask).
     */
    async processSVGRasterFallback(svgString) {
        const desiredCount = this.getDesiredParticleCount({ type: 'svg' });
        const rasterSize = desiredCount >= 60000 ? 2048 : 1024;
        const token = ++this._rasterRegenToken;

        const { data } = await this.rasterPointSampler.samplePacked(svgString, desiredCount, {
            rasterSize,
            seed: this.settings.transitionSeed
        });
        if (token !== this._rasterRegenToken) return;

        const points = [];
        const n = Math.max(0, desiredCount | 0);
        for (let i = 0; i < n; i++) {
            const o = i * 4;
            points.push({
                x: data[o + 0],
                y: data[o + 1],
                z: data[o + 2],
                color: '#d4d4d8',
                edge: data[o + 3] > 0.5
            });
        }

        const auraPoints = this.applyEdgeAuraToLogoPoints(points, {
            amount: this.settings.edgeAuraAmount,
            spread: this.settings.edgeAuraSpread,
            outlier: this.settings.edgeAuraOutlier
        });

        this.particleSystem.initialize(auraPoints, { ambientCount: this.getAmbientCount(desiredCount) });
	        this.particleSystem.updateSettings({
	            size: this.settings.size,
	            depthVariance: this.settings.depthVariance,
	            animationSpeed: this.settings.animationSpeed,
	            sizeRandom: this.settings.sizeRandom,
	            sizeMin: this.settings.sizeMin,
	            sizeMax: this.settings.sizeMax,
	            opacityRandom: this.settings.opacityRandom,
	            opacityMin: this.settings.opacityMin,
	            opacityMax: this.settings.opacityMax,
	            zoom: this.settings.zoom,
	            squaresEnabled: this.settings.squaresEnabled,
	            squareRatio: this.settings.squareRatio,
            dissolveCycle: this.settings.dissolveCycle,
            cycleSeconds: this.settings.cycleSeconds,
            holdSeconds: this.settings.holdSeconds,
            chaos: this.settings.chaos
        });
        this.particleSystem.setColorOverride(this.settings.colorMode);
        this.particleSystem.setRealColors(this.settings.realColors);

        // Make the logo "appear" from scattered particles
        this.particleSystem.scatter(1.0);

        this.uploadZone.classList.add('hidden');
        this.updateParticleCount();

        // GPU targets:
        // - Fluid Motion (GPU): build directly from sampled points (fast)
        // - Otherwise: only build high-density targets for export (async)
        if (this.settings && this.settings.fluidGPU) {
            try {
                this.controllers.gpu.buildGPUTargetsFromPointClouds([auraPoints]);
            } catch (e) {
                logger.warn(e);
            }
        } else {
            this.buildGPUTargetsForSingle(svgString).catch((e) => logger.warn(e));
        }
    }

    /**
     * Process multiple SVG strings and start a morphing sequence.
     */
    processSVGSequence(svgStrings) {
        const token = ++this._uploadToken;
        try {
            this.stopLogoSequence();
            this.currentSourceType = 'svg';
            this.currentImage = null;
            const { sanitizedStrings, svgDatas } = sanitizeAndParseMany(this.svgParser, svgStrings);
            this.currentSvgString = sanitizedStrings && sanitizedStrings.length ? sanitizedStrings[0] : this.currentSvgString;
            const logoCount = Array.isArray(sanitizedStrings) ? sanitizedStrings.length : 0;
            this.resetParticleIconAssignments(logoCount);
            if (typeof this.refreshParticleIconUI === 'function') {
                this.refreshParticleIconUI();
            }

            const desiredCount = this.getDesiredParticleCount();
            const rendererHasGPU = !!(this.renderer && this.renderer.gpuProgram);

            // High-density path: GPU-only sequencing (targets built async, no CPU point clouds)
            if (desiredCount >= 200000 && this.gpu.supported && rendererHasGPU) {
                this.logoSequence = this.state.logoSequence = {
                    active: sanitizedStrings.length > 1,
                    sourceType: 'svg',
                    svgStrings: [...sanitizedStrings],
                    svgDatas,
                    imageSources: [],
                    // Placeholder clouds for length only (GPU sequencing uses textures)
                    pointClouds: new Array(sanitizedStrings.length).fill([]),
                    logoIds: sanitizedStrings.map((s) => this.hashString32(s)),
                    countRatios: new Array(sanitizedStrings.length).fill(1),
                    gpuTargets: null,
                    index: 0,
                    transition: null,
                    holdTimer: 0
                };

                // Clear CPU particles while GPU targets are built.
                this.particleSystem.initialize([], { ambientCount: 0 });
	                this.particleSystem.updateSettings({
	                    size: this.settings.size,
	                    depthVariance: this.settings.depthVariance,
	                    animationSpeed: this.settings.animationSpeed,
	                    sizeRandom: this.settings.sizeRandom,
	                    sizeMin: this.settings.sizeMin,
	                    sizeMax: this.settings.sizeMax,
	                    opacityRandom: this.settings.opacityRandom,
	                    opacityMin: this.settings.opacityMin,
	                    opacityMax: this.settings.opacityMax,
	                    zoom: this.settings.zoom,
	                    squaresEnabled: this.settings.squaresEnabled,
	                    squareRatio: this.settings.squareRatio,
                    dissolveCycle: false,
                    cycleSeconds: this.settings.cycleSeconds,
                    holdSeconds: this.settings.holdSeconds,
                    chaos: this.settings.chaos
                });
                this.particleSystem.setColorOverride(this.settings.colorMode);
                this.particleSystem.setRealColors(this.settings.realColors);

                this.uploadZone.classList.add('hidden');
                this.updateParticleCount();
                this.buildGPUTargetsForSequence(sanitizedStrings).catch((e) => logger.warn(e));
                return;
            }

            const pointClouds = svgDatas.map((data) => {
                const sampled = this.pointSampler.sample(data, desiredCount);
                const fitted = this.fitPointCount(sampled, desiredCount);
                return this.applyEdgeAuraToLogoPoints(fitted, {
                    amount: this.settings.edgeAuraAmount,
                    spread: this.settings.edgeAuraSpread,
                    outlier: this.settings.edgeAuraOutlier
                });
            });

            if (!pointClouds.length || !pointClouds[0].length) {
                throw new Error('No points generated from the provided SVGs.');
            }

            this.logoSequence = this.state.logoSequence = {
                active: pointClouds.length > 1,
                sourceType: 'svg',
                svgStrings: [...sanitizedStrings],
                svgDatas,
                imageSources: [],
                pointClouds,
                logoIds: sanitizedStrings.map((s) => this.hashString32(s)),
                countRatios: new Array(pointClouds.length).fill(1),
                gpuTargets: null,
                index: 0,
                transition: null,
                holdTimer: 0
            };

            // Keep current svgData pointing at the active logo (helps existing UI logic)
            this.svgData = svgDatas[0];

            // Initialize particles with the first logo
            this.particleSystem.initialize(pointClouds[0], { ambientCount: this.getAmbientCount(desiredCount) });
	            this.particleSystem.updateSettings({
	                size: this.settings.size,
	                depthVariance: this.settings.depthVariance,
	                animationSpeed: this.settings.animationSpeed,
	                sizeRandom: this.settings.sizeRandom,
	                sizeMin: this.settings.sizeMin,
	                sizeMax: this.settings.sizeMax,
	                opacityRandom: this.settings.opacityRandom,
	                opacityMin: this.settings.opacityMin,
	                opacityMax: this.settings.opacityMax,
	                zoom: this.settings.zoom,
	                squaresEnabled: this.settings.squaresEnabled,
	                squareRatio: this.settings.squareRatio,
                dissolveCycle: this.settings.dissolveCycle,
                cycleSeconds: this.settings.cycleSeconds,
                holdSeconds: this.settings.holdSeconds,
                chaos: this.settings.chaos
            });

            this.particleSystem.setColorOverride(this.settings.colorMode);
            this.particleSystem.setRealColors(this.settings.realColors);

            // Make the first logo "appear" from scattered particles
            this.particleSystem.scatter(1.0);

            // GPU targets:
            // - Fluid Motion (GPU): build directly from sampled point clouds (fast)
            // - Otherwise: only build high-density targets for export (async, non-blocking)
            if (this.settings && this.settings.fluidGPU) {
                try {
                    this.controllers.gpu.buildGPUTargetsFromPointClouds(pointClouds);
                } catch (e) {
                    logger.warn(e);
                }
            } else {
                this.buildGPUTargetsForSequence(sanitizedStrings).catch((e) => logger.warn(e));
            }

            // Update UI
            this.uploadZone.classList.add('hidden');
            this.updateParticleCount();
        } catch (error) {
            console.error('Error processing SVG sequence:', error);
            alert('Error processing SVGs: ' + error.message);
        }
    }

    stopLogoSequence() {
        this.disposeSequenceGPUTargets();
        this.logoSequence = this.state.logoSequence = {
            active: false,
            sourceType: null,
            items: [],
            svgStrings: [],
            svgDatas: [],
            imageSources: [],
            pointClouds: [],
            logoIds: [],
            countRatios: [],
            gpuTargets: null,
            index: 0,
            transition: null,
            holdTimer: 0
        };

        // Return CPU particles to their built-in dissolve-cycle behavior
        if (this.particleSystem) {
            this.particleSystem.clearTransitionState?.();
        }

        this.resetParticleIconAssignments(0);
        if (typeof this.refreshParticleIconUI === 'function') {
            this.refreshParticleIconUI();
        }
    }

    shuffleInPlace(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    applyEdgeAuraToLogoPoints(points, {
        amount = 0.12,
        spread = 0.12,
        outlier = 0.05
    } = {}) {
        const pts = Array.isArray(points) ? points.slice() : [];
        if (!pts.length) return pts;
        if (!this.settings || !this.settings.edgeAuraEnabled) return pts;

        const auraFrac = clamp01(amount);
        const auraCount = Math.min(pts.length - 1, Math.max(0, Math.round(pts.length * auraFrac)));
        if (auraCount <= 0) return pts;

        const edges = pts.filter((p) => p && p.edge);
        if (!edges.length) return pts;

        const replaceIdx = [];
        for (let i = 0; i < pts.length; i++) {
            if (!pts[i] || pts[i].edge) continue;
            replaceIdx.push(i);
        }
        this.shuffleInPlace(replaceIdx);

        const spreadN = Math.max(0.001, Number(spread) || 0.12);
        const outlierChance = Number.isFinite(outlier) ? Math.max(0, outlier) : 0.05;
        const jitter = Math.max(0.002, spreadN * 0.08);

        const makeAuraPoint = (src) => {
            let dx = Number(src.x) || 0;
            let dy = Number(src.y) || 0;
            let mag = Math.hypot(dx, dy);
            if (mag < 1e-3) {
                dx = Math.random() * 2 - 1;
                dy = Math.random() * 2 - 1;
                mag = Math.hypot(dx, dy) || 1;
            }
            dx /= mag;
            dy /= mag;

            const t = Math.pow(Math.random(), 1.35);
            let r = t * spreadN;
            if (Math.random() < outlierChance) {
                r *= 2.0 + Math.random() * 2.5;
            }

            const fx = (Number(src.x) || 0) + dx * r + (Math.random() * 2 - 1) * jitter;
            const fy = (Number(src.y) || 0) + dy * r + (Math.random() * 2 - 1) * jitter;
            const fz = (Number(src.z) || 0) + (Math.random() * 2 - 1) * 0.12;

            const distN = clamp01(r / spreadN);
            const fade = 0.08 + 0.92 * Math.pow(1 - distN, 1.45);

            return {
                x: fx,
                y: fy,
                z: fz,
                color: src.color,
                edge: true,
                opacityMul: 0.3 + fade * 0.9,
                sizeMul: 0.8 + fade * 0.45
            };
        };

        const count = Math.min(auraCount, replaceIdx.length);
        for (let i = 0; i < count; i++) {
            const src = edges[Math.floor(Math.random() * edges.length)];
            pts[replaceIdx[i]] = makeAuraPoint(src);
        }

        if (count < auraCount) {
            for (let i = count; i < auraCount; i++) {
                const src = edges[Math.floor(Math.random() * edges.length)];
                pts.push(makeAuraPoint(src));
            }
        }

        return pts.slice(0, points.length);
    }

    /**
     * Ensure each logo's point cloud has exactly `targetCount` points so we can reuse the same particles.
     */
    fitPointCount(points, targetCount) {
        const target = Math.max(0, targetCount | 0);
        const src = points || [];
        if (src.length === 0 || target === 0) return [];

        if (src.length === target) return src;

        if (src.length > target) {
            const copy = src.slice();
            this.shuffleInPlace(copy);
            return copy.slice(0, target);
        }

        const out = src.slice();
        while (out.length < target) {
            const p = src[Math.floor(Math.random() * src.length)];
            out.push({
                x: p.x,
                y: p.y,
                z: p.z,
                color: p.color,
                edge: p.edge,
                opacityMul: p.opacityMul,
                sizeMul: p.sizeMul
            });
        }
        return out;
    }

    /**
     * How many always-on "ambient stars" we add around the logo.
     * We cap this so performance remains stable even at very high densities.
     */
    getAmbientCount(logoCount) {
        const n = Math.max(0, Number(logoCount) || 0);
        // Aim for an Apple-like starfield: noticeable background presence without exploding perf.
        // - min keeps small logos from looking empty
        // - cap keeps very high densities from getting too heavy on CPU (we simulate on the CPU)
        return Math.min(20000, Math.max(1000, Math.round(n * 0.6)));
    }

    /**
     * Drive multi-logo morphing via deterministic TransitionDirector (continuous 0→1 timeline).
     */
    tickLogoSequence(deltaTime) {
        return this.controllers.sequence.tickLogoSequence(deltaTime);
    }

    /**
     * Single-logo dissolve/reform cycle driven by the same shape-aware staging system.
     * This runs only when no logo sequence is active (CPU path).
     */
    tickSingleLogoCycle(deltaTime) {
        return this.controllers.sequence.tickSingleLogoCycle(deltaTime);
    }

    advanceLogo() {
        const clouds = this.logoSequence.pointClouds || [];
        if (clouds.length < 2) return;

        const nextIndex = (this.logoSequence.index + 1) % clouds.length;
        this.logoSequence.index = nextIndex;
        const nextCloud = clouds[nextIndex];
        this.svgData = (this.logoSequence.svgDatas && this.logoSequence.svgDatas[nextIndex]) || this.svgData;
        this.particleSystem.morphTo(nextCloud);
    }

    /**
     * Deterministic 32-bit hash (FNV-1a) for stable logo identifiers.
     */
    hashString32(str) {
        const s = String(str || '');
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
    }

    ensureParticleIconState() {
        if (!this.state) this.state = createInitialState();
        if (!this.state.particleIcons) {
            this.state.particleIcons = { library: [], assignments: [] };
        }
        if (!Array.isArray(this.state.particleIcons.library)) {
            this.state.particleIcons.library = [];
        }
        if (!Array.isArray(this.state.particleIcons.assignments)) {
            this.state.particleIcons.assignments = [];
        }
        this.particleIcons = this.state.particleIcons;
        return this.particleIcons;
    }

    getLogoCount() {
        if (this.logoSequence && Array.isArray(this.logoSequence.items) && this.logoSequence.items.length) {
            return this.logoSequence.items.length;
        }
        if (this.logoSequence && this.logoSequence.sourceType === 'image') {
            if (Array.isArray(this.logoSequence.imageSources) && this.logoSequence.imageSources.length) {
                return this.logoSequence.imageSources.length;
            }
            return this.currentImage ? 1 : 0;
        }
        if (this.logoSequence && Array.isArray(this.logoSequence.svgStrings) && this.logoSequence.svgStrings.length) {
            return this.logoSequence.svgStrings.length;
        }
        return this.currentSvgString ? 1 : 0;
    }

    resetParticleIconAssignments(count) {
        const state = this.ensureParticleIconState();
        const n = Math.max(0, count | 0);
        state.assignments = new Array(n).fill(null).map(() => ({ type: 'classic' }));
        this.particleIcons = state;
    }

    setParticleIconAssignment(index, assignment) {
        const state = this.ensureParticleIconState();
        const idx = Math.max(0, index | 0);
        while (state.assignments.length <= idx) {
            state.assignments.push({ type: 'classic' });
        }
        state.assignments[idx] = assignment || { type: 'classic' };
    }

    applyParticleIconToAll(assignment) {
        const state = this.ensureParticleIconState();
        for (let i = 0; i < state.assignments.length; i++) {
            state.assignments[i] = assignment || { type: 'classic' };
        }
    }

    getParticleIconById(id) {
        const state = this.ensureParticleIconState();
        const list = state.library || [];
        const target = String(id);
        return list.find((icon) => icon && String(icon.id) === target) || null;
    }

    getParticleIconSourceForLogoIndex(index) {
        const state = this.ensureParticleIconState();
        const assignments = state.assignments || [];
        const idx = Math.max(0, index | 0);
        const assignment = assignments[idx];
        if (!assignment || assignment.type === 'classic') return null;

        if (assignment.type === 'icon') {
            const icon = this.getParticleIconById(assignment.id);
            if (!icon || !icon.svg) return null;
            return { key: `icon:${icon.id}`, svg: icon.svg };
        }

        if (assignment.type === 'self') {
            if (this.logoSequence && this.logoSequence.sourceType === 'image') return null;
            if (this.logoSequence && this.logoSequence.sourceType === 'mixed') {
                const item = (this.logoSequence.items && this.logoSequence.items[idx]) ? this.logoSequence.items[idx] : null;
                if (!item || item.type !== 'svg') return null;
                const svg = item.svgString || null;
                if (!svg) return null;
                return { key: `self:${this.hashString32(svg)}`, svg };
            }
            let svg = null;
            if (this.logoSequence && Array.isArray(this.logoSequence.svgStrings) && this.logoSequence.svgStrings.length) {
                svg = this.logoSequence.svgStrings[idx] || null;
            } else {
                svg = this.currentSvgString || null;
            }
            if (!svg) return null;
            return { key: `self:${this.hashString32(svg)}`, svg };
        }

        return null;
    }

    /**
     * Setup control panel
     */
    setupControls() {
        return this.controllers.controls.init();
    }

    /**
     * Setup range slider with debounced callback
     */
    setupSlider(id, defaultValue, callback) {
        return setupSliderController(id, defaultValue, callback, { lifecycle: this.lifecycle });
    }

    /**
     * Regenerate particles with current settings
     */
    regenerateParticles() {
        const isMixedSource = (this.logoSequence && this.logoSequence.sourceType === 'mixed');
        if (isMixedSource) {
            const items = (this.logoSequence && Array.isArray(this.logoSequence.items)) ? this.logoSequence.items : [];
            if (!items.length) return;

            const poolCount = this.getDesiredParticleCount({ useMax: true });
            const rendererHasGPU = !!(this.renderer && this.renderer.gpuProgram);

            if (poolCount < 200000 && !(this.settings && this.settings.fluidGPU)) {
                this.disposeSequenceGPUTargets();
            }

            if (poolCount >= 200000 && this.gpu.supported && rendererHasGPU) {
                this.buildGPUTargetsForMixedSequence(items).catch((e) => logger.warn(e));
                this.updateParticleCount();
                return;
            }

            const hasSvg = items.some((item) => item && item.type === 'svg');
            const logoDensity = this.getDensityForType('svg');
            const ambientCount = hasSvg ? this.getAmbientCount(logoDensity) : 0;
            const token = ++this._rasterRegenToken;

            const countRatios = items.map((item) => {
                const type = (item && item.type) ? item.type : 'svg';
                const desired = this.getDesiredParticleCount({ type });
                return poolCount > 0 ? Math.min(1, desired / poolCount) : 1;
            });

            Promise.all(items.map((item, idx) => {
                const type = (item && item.type) ? item.type : 'svg';
                if (type === 'image') {
                    const desired = this.getDesiredParticleCount({ type: 'image' });
                    const rasterSize = desired >= 60000 ? 2048 : 1024;
                    return this.rasterPointSampler.sampleImagePoints(item.imageInfo, desired, {
                        rasterSize,
                        seed: this.settings.transitionSeed,
                        lumaThreshold: 10,
                        lumaWeightPower: 1.15,
                        intensityPower: 1.05,
                        edgeRatio: 0.3,
                        edgeAuraEnabled: this.settings.edgeAuraEnabled,
                        edgeAuraAmount: this.settings.edgeAuraAmount,
                        edgeAuraSpread: this.settings.edgeAuraSpread,
                        edgeAuraOutlier: this.settings.edgeAuraOutlier
                    }).then((points) => {
                        let fitted = this.fitPointCount(points, desired);
                        fitted = this.fitPointCount(fitted, poolCount);
                        return fitted;
                    });
                }

                const desired = this.getDesiredParticleCount({ type: 'svg' });
                const svgData = (this.logoSequence && this.logoSequence.svgDatas && this.logoSequence.svgDatas[idx])
                    ? this.logoSequence.svgDatas[idx]
                    : null;
                if (svgData && hasVectorPaths(svgData)) {
                    const sampled = this.pointSampler.sample(svgData, desired);
                    let fitted = this.fitPointCount(sampled, desired);
                    fitted = this.applyEdgeAuraToLogoPoints(fitted, {
                        amount: this.settings.edgeAuraAmount,
                        spread: this.settings.edgeAuraSpread,
                        outlier: this.settings.edgeAuraOutlier
                    });
                    return Promise.resolve(this.fitPointCount(fitted, poolCount));
                }

                const rasterSize = desired >= 60000 ? 2048 : 1024;
                const svgString = (this.logoSequence && Array.isArray(this.logoSequence.svgStrings))
                    ? this.logoSequence.svgStrings[idx]
                    : (item && item.svgString);
                return this.rasterPointSampler.samplePoints(svgString, desired, {
                    rasterSize,
                    seed: this.settings.transitionSeed,
                    edgeRatio: 0.6
                }).then((points) => {
                    let fitted = this.fitPointCount(points, desired);
                    fitted = this.applyEdgeAuraToLogoPoints(fitted, {
                        amount: this.settings.edgeAuraAmount,
                        spread: this.settings.edgeAuraSpread,
                        outlier: this.settings.edgeAuraOutlier
                    });
                    return this.fitPointCount(fitted, poolCount);
                });
            })).then((clouds) => {
                if (token !== this._rasterRegenToken) return;

                this.logoSequence.pointClouds = clouds;
                this.logoSequence.countRatios = countRatios;
                this.logoSequence.index = Math.max(0, Math.min(this.logoSequence.index || 0, clouds.length - 1));
                this.logoSequence.transition = null;
                this.logoSequence.holdTimer = 0;

                const activeIndex = this.logoSequence.index;
                const activeItem = items[activeIndex];
                if (activeItem && activeItem.type === 'image') {
                    this.currentImage = activeItem.imageInfo;
                    this.currentSvgString = null;
                    this.svgData = null;
                    this.currentSourceType = 'image';
                } else {
                    this.currentImage = null;
                    this.currentSvgString = (this.logoSequence.svgStrings && this.logoSequence.svgStrings[activeIndex]) || null;
                    this.svgData = (this.logoSequence.svgDatas && this.logoSequence.svgDatas[activeIndex]) || null;
                    this.currentSourceType = 'svg';
                }

                const points = clouds[activeIndex] || clouds[0];
                this.particleSystem.initialize(points, { ambientCount });
                this.particleSystem.updateSettings({
                    size: this.settings.size,
                    depthVariance: this.settings.depthVariance,
                    animationSpeed: this.settings.animationSpeed,
                    sizeRandom: this.settings.sizeRandom,
                    sizeMin: this.settings.sizeMin,
                    sizeMax: this.settings.sizeMax,
                    opacityRandom: this.settings.opacityRandom,
                    opacityMin: this.settings.opacityMin,
                    opacityMax: this.settings.opacityMax,
                    zoom: this.settings.zoom,
                    squaresEnabled: this.settings.squaresEnabled,
                    squareRatio: this.settings.squareRatio,
                    dissolveCycle: this.settings.dissolveCycle,
                    cycleSeconds: this.settings.cycleSeconds,
                    holdSeconds: this.settings.holdSeconds,
                    chaos: this.settings.chaos
                });

                this.particleSystem.setColorOverride(this.settings.colorMode);
                this.particleSystem.setRealColors(this.settings.realColors);
                this.particleSystem.scatter(1.0);
                this.updateParticleCount();

                if (this.settings && this.settings.fluidGPU) {
                    try {
                        this.controllers.gpu.buildGPUTargetsFromPointClouds(clouds);
                    } catch (e) {
                        logger.warn(e);
                    }
                } else {
                    this.buildGPUTargetsForMixedSequence(items).catch((e) => logger.warn(e));
                }
            }).catch((e) => logger.warn(e));
            return;
        }

        const isImageSource = (this.logoSequence && this.logoSequence.sourceType === 'image') ||
            this.currentSourceType === 'image';
        if (!isImageSource && !this.svgData) return;

        const desiredCount = this.getDesiredParticleCount();
        const ambientCount = isImageSource ? 0 : this.getAmbientCount(desiredCount);
        const rendererHasGPU = !!(this.renderer && this.renderer.gpuProgram);

        // If we drop below the GPU threshold, proactively free any large GPU targets/sim state.
        if (desiredCount < 200000 && !(this.settings && this.settings.fluidGPU)) {
            this.disposeSequenceGPUTargets();
        }

        // High-density path: rebuild GPU targets only (avoid CPU resampling)
        if (desiredCount >= 200000 && this.gpu.supported && rendererHasGPU) {
            if (isImageSource) {
                if (this.logoSequence && this.logoSequence.active && Array.isArray(this.logoSequence.imageSources) && this.logoSequence.imageSources.length) {
                    this.buildGPUTargetsForImageSequence(this.logoSequence.imageSources).catch((e) => logger.warn(e));
                } else if (this.currentImage) {
                    this.buildGPUTargetsForImage(this.currentImage).catch((e) => logger.warn(e));
                }
            } else if (this.logoSequence && this.logoSequence.active && this.logoSequence.svgStrings && this.logoSequence.svgStrings.length) {
                this.buildGPUTargetsForSequence(this.logoSequence.svgStrings).catch((e) => logger.warn(e));
            } else {
                this.buildGPUTargetsForSingle(this.currentSvgString).catch((e) => logger.warn(e));
            }
            this.updateParticleCount();
            return;
        }

        if (isImageSource) {
            const rasterSize = desiredCount >= 60000 ? 2048 : 1024;
            const token = ++this._rasterRegenToken;
            if (this.logoSequence && this.logoSequence.active && Array.isArray(this.logoSequence.imageSources) && this.logoSequence.imageSources.length) {
                const list = this.logoSequence.imageSources;
                Promise.all(list.map((info) => this.rasterPointSampler.sampleImagePoints(info, desiredCount, {
                    rasterSize,
                    seed: this.settings.transitionSeed,
                    lumaThreshold: 10,
                    lumaWeightPower: 1.15,
                    intensityPower: 1.05,
                    edgeRatio: 0.3,
                    edgeAuraEnabled: this.settings.edgeAuraEnabled,
                    edgeAuraAmount: this.settings.edgeAuraAmount,
                    edgeAuraSpread: this.settings.edgeAuraSpread,
                    edgeAuraOutlier: this.settings.edgeAuraOutlier
                }))).then((clouds) => {
                    if (token !== this._rasterRegenToken) return;
                    const pointClouds = clouds.map((pts) => this.fitPointCount(pts, desiredCount));
                    this.logoSequence.pointClouds = pointClouds;
                    this.logoSequence.index = Math.max(0, Math.min(this.logoSequence.index, pointClouds.length - 1));
                    this.logoSequence.transition = null;
                    this.logoSequence.holdTimer = 0;
                    this.logoSequence.logoIds = list.map((img) => this.hashString32(img.src || img.name || 'image'));

                    const points = pointClouds[this.logoSequence.index] || pointClouds[0];
                    this.particleSystem.initialize(points, { ambientCount: 0 });
                    this.particleSystem.updateSettings({
                        size: this.settings.size,
                        depthVariance: this.settings.depthVariance,
                        animationSpeed: this.settings.animationSpeed,
                        sizeRandom: this.settings.sizeRandom,
                        sizeMin: this.settings.sizeMin,
                        sizeMax: this.settings.sizeMax,
                        opacityRandom: this.settings.opacityRandom,
                        opacityMin: this.settings.opacityMin,
                        opacityMax: this.settings.opacityMax,
                        zoom: this.settings.zoom,
                        squaresEnabled: this.settings.squaresEnabled,
                        squareRatio: this.settings.squareRatio,
                        dissolveCycle: this.settings.dissolveCycle,
                        cycleSeconds: this.settings.cycleSeconds,
                        holdSeconds: this.settings.holdSeconds,
                        chaos: this.settings.chaos
                    });

                    this.particleSystem.setColorOverride(this.settings.colorMode);
                    this.particleSystem.setRealColors(this.settings.realColors);
                    this.particleSystem.scatter(1.0);
                    this.updateParticleCount();

                    if (this.settings && this.settings.fluidGPU) {
                        try {
                            this.controllers.gpu.buildGPUTargetsFromPointClouds(pointClouds);
                        } catch (e) {
                            logger.warn(e);
                        }
                    } else {
                        this.buildGPUTargetsForImageSequence(list).catch((e) => logger.warn(e));
                    }
                }).catch((e) => logger.warn(e));
                return;
            }

            if (this.currentImage) {
                this.rasterPointSampler.sampleImagePoints(this.currentImage, desiredCount, {
                    rasterSize,
                    seed: this.settings.transitionSeed,
                    lumaThreshold: 10,
                    lumaWeightPower: 1.15,
                    intensityPower: 1.05,
                    edgeRatio: 0.3,
                    edgeAuraEnabled: this.settings.edgeAuraEnabled,
                    edgeAuraAmount: this.settings.edgeAuraAmount,
                    edgeAuraSpread: this.settings.edgeAuraSpread,
                    edgeAuraOutlier: this.settings.edgeAuraOutlier
                }).then((points) => {
                    if (token !== this._rasterRegenToken) return;
                    const fitted = this.fitPointCount(points, desiredCount);
                    this.particleSystem.initialize(fitted, { ambientCount: 0 });
                    this.particleSystem.updateSettings({
                        size: this.settings.size,
                        depthVariance: this.settings.depthVariance,
                        animationSpeed: this.settings.animationSpeed,
                        sizeRandom: this.settings.sizeRandom,
                        sizeMin: this.settings.sizeMin,
                        sizeMax: this.settings.sizeMax,
                        opacityRandom: this.settings.opacityRandom,
                        opacityMin: this.settings.opacityMin,
                        opacityMax: this.settings.opacityMax,
                        zoom: this.settings.zoom,
                        squaresEnabled: this.settings.squaresEnabled,
                        squareRatio: this.settings.squareRatio,
                        dissolveCycle: this.settings.dissolveCycle,
                        cycleSeconds: this.settings.cycleSeconds,
                        holdSeconds: this.settings.holdSeconds,
                        chaos: this.settings.chaos
                    });

                    this.particleSystem.setColorOverride(this.settings.colorMode);
                    this.particleSystem.setRealColors(this.settings.realColors);
                    this.updateParticleCount();

                    if (this.settings && this.settings.fluidGPU) {
                        try {
                            this.controllers.gpu.buildGPUTargetsFromPointClouds([fitted]);
                        } catch (e) {
                            logger.warn(e);
                        }
                    } else {
                        this.buildGPUTargetsForImage(this.currentImage).catch((e) => logger.warn(e));
                    }
                }).catch((e) => logger.warn(e));
            }
            return;
        }

        // SVG path
        if (!this.svgData) return;

        // If we're running a logo sequence, resample *all* logos so particle counts stay consistent.
        if (this.logoSequence && this.logoSequence.active && this.logoSequence.svgDatas && this.logoSequence.svgDatas.length) {
            const pointClouds = this.logoSequence.svgDatas.map((data) => {
                const sampled = this.pointSampler.sample(data, desiredCount);
                const fitted = this.fitPointCount(sampled, desiredCount);
                return this.applyEdgeAuraToLogoPoints(fitted, {
                    amount: this.settings.edgeAuraAmount,
                    spread: this.settings.edgeAuraSpread,
                    outlier: this.settings.edgeAuraOutlier
                });
            });

            this.logoSequence.pointClouds = pointClouds;
            this.logoSequence.index = Math.max(0, Math.min(this.logoSequence.index, pointClouds.length - 1));
            this.logoSequence.transition = null;
            this.logoSequence.holdTimer = 0;
            this.logoSequence.logoIds = (this.logoSequence.svgStrings || []).map((s) => this.hashString32(s));
            this.svgData = this.logoSequence.svgDatas[this.logoSequence.index] || this.svgData;

            const points = pointClouds[this.logoSequence.index] || pointClouds[0];
            this.particleSystem.initialize(points, { ambientCount });
            this.particleSystem.updateSettings({
                size: this.settings.size,
                depthVariance: this.settings.depthVariance,
                animationSpeed: this.settings.animationSpeed,
                sizeRandom: this.settings.sizeRandom,
                sizeMin: this.settings.sizeMin,
                sizeMax: this.settings.sizeMax,
                opacityRandom: this.settings.opacityRandom,
                opacityMin: this.settings.opacityMin,
                opacityMax: this.settings.opacityMax,
                zoom: this.settings.zoom,
                squaresEnabled: this.settings.squaresEnabled,
                squareRatio: this.settings.squareRatio,
                dissolveCycle: this.settings.dissolveCycle,
                cycleSeconds: this.settings.cycleSeconds,
                holdSeconds: this.settings.holdSeconds,
                chaos: this.settings.chaos
            });

            this.particleSystem.setColorOverride(this.settings.colorMode);
            this.particleSystem.setRealColors(this.settings.realColors);

            // Reform from scattered so the change feels intentional after a density jump
            this.particleSystem.scatter(1.0);
            this.updateParticleCount();

            // Rebuild GPU targets for the new density (async)
            if (this.settings && this.settings.fluidGPU) {
                try {
                    this.controllers.gpu.buildGPUTargetsFromPointClouds(pointClouds);
                } catch (e) {
                    logger.warn(e);
                }
            } else {
                this.buildGPUTargetsForSequence(this.logoSequence.svgStrings).catch((e) => logger.warn(e));
            }
            return;
        }

        // Raster fallback if we have no parsed paths (common when SVG relies on <use>/masks).
        if (!this.svgData.paths || this.svgData.paths.length === 0) {
            this.processSVGRasterFallback(this.currentSvgString).catch((e) => logger.warn(e));
            this.updateParticleCount();
            return;
        }

        const sampled = this.pointSampler.sample(this.svgData, desiredCount);
        const fitted = this.fitPointCount(sampled, desiredCount);
        const points = this.applyEdgeAuraToLogoPoints(fitted, {
            amount: this.settings.edgeAuraAmount,
            spread: this.settings.edgeAuraSpread,
            outlier: this.settings.edgeAuraOutlier
        });
        if (!points.length) {
            this.processSVGRasterFallback(this.currentSvgString).catch((e) => logger.warn(e));
            this.updateParticleCount();
            return;
        }
        this.particleSystem.initialize(points, { ambientCount });
        this.particleSystem.updateSettings({
            size: this.settings.size,
            depthVariance: this.settings.depthVariance,
            animationSpeed: this.settings.animationSpeed,
            sizeRandom: this.settings.sizeRandom,
            sizeMin: this.settings.sizeMin,
            sizeMax: this.settings.sizeMax,
            opacityRandom: this.settings.opacityRandom,
            opacityMin: this.settings.opacityMin,
            opacityMax: this.settings.opacityMax,
            zoom: this.settings.zoom,
            squaresEnabled: this.settings.squaresEnabled,
            squareRatio: this.settings.squareRatio,
            dissolveCycle: this.settings.dissolveCycle,
            cycleSeconds: this.settings.cycleSeconds,
            holdSeconds: this.settings.holdSeconds,
            chaos: this.settings.chaos
        });

        this.particleSystem.setColorOverride(this.settings.colorMode);
        this.particleSystem.setRealColors(this.settings.realColors);

        this.updateParticleCount();

        // GPU targets for the new density
        if (this.settings && this.settings.fluidGPU) {
            try {
                this.controllers.gpu.buildGPUTargetsFromPointClouds([points]);
            } catch (e) {
                logger.warn(e);
            }
        } else {
            // High-density export targets only (async)
            this.buildGPUTargetsForSingle(this.currentSvgString).catch((e) => logger.warn(e));
        }
    }

    disposeSequenceGPUTargets() {
        return this.controllers.gpu.disposeSequenceGPUTargets();
    }

    async buildGPUTargetsForSingle(svgString) {
        return this.controllers.gpu.buildGPUTargetsForSingle(svgString);
    }

    async buildGPUTargetsForSequence(svgStrings) {
        return this.controllers.gpu.buildGPUTargetsForSequence(svgStrings);
    }

    async buildGPUTargetsForImage(imageInfo) {
        return this.controllers.gpu.buildGPUTargetsForImage(imageInfo);
    }

    async buildGPUTargetsForImageSequence(imageInfos) {
        return this.controllers.gpu.buildGPUTargetsForImageSequence(imageInfos);
    }

    async buildGPUTargetsForMixedSequence(items) {
        return this.controllers.gpu.buildGPUTargetsForMixedSequence(items);
    }

    /**
     * Reset all settings to defaults
     */
    resetSettings() {
        // Important: keep the same settings object identity to avoid stale references
        // in any code that may have captured `app.settings`.
        const defaults = getDefaultSettings();
        if (!this.state) this.state = createInitialState();
        if (!this.state.settings) this.state.settings = getDefaultSettings();
        Object.assign(this.state.settings, defaults);
        this.settings = this.state.settings;

        this.transitionDirector = new TransitionDirector({ userSeed: this.settings.transitionSeed, mode: 'random' });
        this.shapeTransitionDirector = new ShapeTransitionDirector({ userSeed: this.settings.transitionSeed });

        // Update sliders
        const logoDensity = this.getDensityForType('svg');
        const imageDensity = this.getDensityForType('image');
        const logoDensityEl = document.getElementById('logo-density');
        const logoDensityValue = document.getElementById('logo-density-value');
        const imageDensityEl = document.getElementById('image-density');
        const imageDensityValue = document.getElementById('image-density-value');
        if (logoDensityEl) logoDensityEl.value = String(logoDensity);
        if (logoDensityValue) logoDensityValue.textContent = String(logoDensity);
        if (imageDensityEl) imageDensityEl.value = String(imageDensity);
        if (imageDensityValue) imageDensityValue.textContent = String(imageDensity);

        document.getElementById('particle-size').value = String(this.settings.size);
        document.getElementById('size-value').textContent = Number(this.settings.size).toFixed(1);

        const depthPct = Math.round((Number(this.settings.depthVariance) || 0) * 100);
        document.getElementById('depth').value = String(depthPct);
        document.getElementById('depth-value').textContent = depthPct + '%';

        const glowPct = Math.round((Number(this.settings.glowIntensity) || 0) * 100);
        document.getElementById('glow').value = String(glowPct);
        document.getElementById('glow-value').textContent = glowPct + '%';

        const speedPct = Math.round((Number(this.settings.animationSpeed) || 0) * 100);
        document.getElementById('animation-speed').value = String(speedPct);
        document.getElementById('speed-value').textContent = speedPct + '%';

        const zoomPct = Math.round((Number(this.settings.zoom) || 1) * 100);
        document.getElementById('zoom').value = String(zoomPct);
        document.getElementById('zoom-value').textContent = zoomPct + '%';

	        const sizeRandPct = Math.round((Number(this.settings.sizeRandom) || 0) * 100);
	        document.getElementById('size-random').value = String(sizeRandPct);
	        document.getElementById('size-random-value').textContent = sizeRandPct + '%';
	
	        const sizeMin = Number(this.settings.sizeMin);
	        const sizeMax = Number(this.settings.sizeMax);
	        const sizeMinEl = document.getElementById('size-min');
	        const sizeMaxEl = document.getElementById('size-max');
	        const sizeMinValEl = document.getElementById('size-min-value');
	        const sizeMaxValEl = document.getElementById('size-max-value');
	        if (sizeMinEl) sizeMinEl.value = String(Number.isFinite(sizeMin) ? sizeMin : 0.8);
	        if (sizeMaxEl) sizeMaxEl.value = String(Number.isFinite(sizeMax) ? sizeMax : 1.2);
	        if (sizeMinValEl) sizeMinValEl.textContent = (Number.isFinite(sizeMin) ? sizeMin : 0.8).toFixed(2) + '×';
	        if (sizeMaxValEl) sizeMaxValEl.textContent = (Number.isFinite(sizeMax) ? sizeMax : 1.2).toFixed(2) + '×';

	        const opacityRandPct = Math.round((Number(this.settings.opacityRandom) || 0) * 100);
	        document.getElementById('opacity-random').value = String(opacityRandPct);
	        document.getElementById('opacity-random-value').textContent = opacityRandPct + '%';
	
	        const opacityMinPct = Math.round((Number(this.settings.opacityMin) || 0) * 100);
	        const opacityMaxPct = Math.round((Number(this.settings.opacityMax) || 0) * 100);
	        const opacityMinEl = document.getElementById('opacity-min');
	        const opacityMaxEl = document.getElementById('opacity-max');
	        const opacityMinValEl = document.getElementById('opacity-min-value');
	        const opacityMaxValEl = document.getElementById('opacity-max-value');
	        if (opacityMinEl) opacityMinEl.value = String(opacityMinPct);
	        if (opacityMaxEl) opacityMaxEl.value = String(opacityMaxPct);
	        if (opacityMinValEl) opacityMinValEl.textContent = opacityMinPct + '%';
	        if (opacityMaxValEl) opacityMaxValEl.textContent = opacityMaxPct + '%';

        // Shapes
        const squaresEnabledToggle = document.getElementById('squares-enabled');
        if (squaresEnabledToggle) squaresEnabledToggle.checked = !!this.settings.squaresEnabled;
        const squaresRatioSlider = document.getElementById('squares-ratio');
        const squareRatioPct = Math.round((Number(this.settings.squareRatio) || 0) * 100);
        if (squaresRatioSlider) {
            squaresRatioSlider.value = String(squareRatioPct);
            squaresRatioSlider.disabled = !this.settings.squaresEnabled;
        }
        const squaresValue = document.getElementById('squares-value');
        if (squaresValue) squaresValue.textContent = squareRatioPct + '%';
        const edgeAuraToggle = document.getElementById('edge-aura');
        if (edgeAuraToggle) edgeAuraToggle.checked = !!this.settings.edgeAuraEnabled;
        const focusToggle = document.getElementById('focus-enabled');
        if (focusToggle) focusToggle.checked = !!this.settings.focusEnabled;
        const focusRadiusSlider = document.getElementById('focus-radius');
        const focusSoftnessSlider = document.getElementById('focus-softness');
        const focusScatterSlider = document.getElementById('focus-scatter');
        const focusRadiusValue = document.getElementById('focus-radius-value');
        const focusSoftnessValue = document.getElementById('focus-softness-value');
        const focusScatterValue = document.getElementById('focus-scatter-value');
        const focusRadiusPct = Math.round(Math.max(0.1, Math.min(1.2, Number(this.settings.focusRadius ?? 0.45))) * 100);
        const focusSoftnessPct = Math.round(clamp01(this.settings.focusSoftness ?? 0.35) * 100);
        const focusScatterPct = Math.round(Math.max(0, Math.min(2.5, Number(this.settings.focusScatter ?? 1.5))) * 100);
        if (focusRadiusSlider) focusRadiusSlider.value = String(focusRadiusPct);
        if (focusSoftnessSlider) focusSoftnessSlider.value = String(focusSoftnessPct);
        if (focusScatterSlider) focusScatterSlider.value = String(focusScatterPct);
        if (focusRadiusValue) focusRadiusValue.textContent = focusRadiusPct + '%';
        if (focusSoftnessValue) focusSoftnessValue.textContent = focusSoftnessPct + '%';
        if (focusScatterValue) focusScatterValue.textContent = focusScatterPct + '%';
        const focusDisabled = !(this.settings && this.settings.focusEnabled);
        if (focusRadiusSlider) focusRadiusSlider.disabled = focusDisabled;
        if (focusSoftnessSlider) focusSoftnessSlider.disabled = focusDisabled;
        if (focusScatterSlider) focusScatterSlider.disabled = focusDisabled;
        const edgeAuraAmountSlider = document.getElementById('edge-aura-amount');
        const edgeAuraSpreadSlider = document.getElementById('edge-aura-spread');
        const edgeAuraOutlierSlider = document.getElementById('edge-aura-outlier');
        const edgeAuraAmountValue = document.getElementById('edge-aura-amount-value');
        const edgeAuraSpreadValue = document.getElementById('edge-aura-spread-value');
        const edgeAuraOutlierValue = document.getElementById('edge-aura-outlier-value');
        const edgeAuraAmountPct = Math.round(clamp01(this.settings.edgeAuraAmount ?? 0.12) * 100);
        const edgeAuraSpreadPct = Math.round(clamp01(this.settings.edgeAuraSpread ?? 0.12) * 100);
        const edgeAuraOutlierPct = Math.round(clamp01(this.settings.edgeAuraOutlier ?? 0.05) * 100);
        if (edgeAuraAmountSlider) edgeAuraAmountSlider.value = String(edgeAuraAmountPct);
        if (edgeAuraSpreadSlider) edgeAuraSpreadSlider.value = String(edgeAuraSpreadPct);
        if (edgeAuraOutlierSlider) edgeAuraOutlierSlider.value = String(edgeAuraOutlierPct);
        if (edgeAuraAmountValue) edgeAuraAmountValue.textContent = edgeAuraAmountPct + '%';
        if (edgeAuraSpreadValue) edgeAuraSpreadValue.textContent = edgeAuraSpreadPct + '%';
        if (edgeAuraOutlierValue) edgeAuraOutlierValue.textContent = edgeAuraOutlierPct + '%';
        const edgeAuraDisabled = !(this.settings && this.settings.edgeAuraEnabled);
        if (edgeAuraAmountSlider) edgeAuraAmountSlider.disabled = edgeAuraDisabled;
        if (edgeAuraSpreadSlider) edgeAuraSpreadSlider.disabled = edgeAuraDisabled;
        if (edgeAuraOutlierSlider) edgeAuraOutlierSlider.disabled = edgeAuraDisabled;

        // Particle icons
        const particleIconsToggle = document.getElementById('particle-icons-enabled');
        if (particleIconsToggle) particleIconsToggle.checked = !!this.settings.particleIconEnabled;
        const particleIconRotation = document.getElementById('particle-icon-rotation');
        if (particleIconRotation) particleIconRotation.value = this.settings.particleIconRotate ? 'spin' : 'still';
        const particleIconColorMode = document.getElementById('particle-icon-color-mode');
        if (particleIconColorMode) particleIconColorMode.value = String(this.settings.particleIconColorMode || 'tint');
        if (typeof this.refreshParticleIconUI === 'function') {
            this.refreshParticleIconUI();
        }

        // Update toggles
        document.getElementById('auto-rotate').checked = false;
        const fluidGpuToggle = document.getElementById('fluid-gpu');
        if (fluidGpuToggle) fluidGpuToggle.checked = !!this.settings.fluidGPU;
        const venomModeToggle = document.getElementById('venom-mode');
        if (venomModeToggle) venomModeToggle.checked = !!this.settings.venomMode;
        const venomStrengthSlider = document.getElementById('venom-strength');
        const venomStrengthValue = document.getElementById('venom-strength-value');
        const venomPct = Math.round(clamp01(this.settings.venomStrength ?? 0.7) * 100);
        if (venomStrengthSlider) {
            venomStrengthSlider.value = String(venomPct);
            venomStrengthSlider.disabled = !this.settings.venomMode;
        }
        if (venomStrengthValue) venomStrengthValue.textContent = `${venomPct}%`;
        const magnetEnabledToggle = document.getElementById('magnet-enabled');
	        if (magnetEnabledToggle) magnetEnabledToggle.disabled = false;
	        // Keep magnet off by default after reset.
	        if (magnetEnabledToggle) magnetEnabledToggle.checked = false;
	        if (this.magnetTool) this.magnetTool.setEnabled(false);

        // Reset defaults disable Fluid GPU; free any GPU targets/sim state.
        if (!(this.settings && this.settings.fluidGPU)) {
            this.disposeSequenceGPUTargets();
        }

        // Dissolve settings
        const dissolveToggle = document.getElementById('dissolve-cycle');
        if (dissolveToggle) dissolveToggle.checked = !!this.settings.dissolveCycle;
        const cycleSecondsSlider = document.getElementById('cycle-seconds');
        if (cycleSecondsSlider) cycleSecondsSlider.value = String(this.settings.cycleSeconds);
        const holdSecondsSlider = document.getElementById('hold-seconds');
        if (holdSecondsSlider) holdSecondsSlider.value = String(this.settings.holdSeconds);
        const chaosSlider = document.getElementById('chaos');
        const chaosPct = Math.round((Number(this.settings.chaos) || 0) * 100);
        if (chaosSlider) chaosSlider.value = String(chaosPct);
        const cycleValue = document.getElementById('cycle-value');
        if (cycleValue) cycleValue.textContent = String(this.settings.cycleSeconds) + 's';
        const holdValue = document.getElementById('hold-value');
        if (holdValue) holdValue.textContent = String(this.settings.holdSeconds) + 's';
        const chaosValue = document.getElementById('chaos-value');
        if (chaosValue) chaosValue.textContent = chaosPct + '%';

        // Transition style
        const transitionStyleValue = document.getElementById('transition-style-value');
        const isCleanStyle = (this.settings.transitionStyle === 'clean');
        if (transitionStyleValue) transitionStyleValue.textContent = isCleanStyle ? 'Clean' : 'Chaotic';
        const transitionStyleClean = document.getElementById('transition-style-clean');
        const transitionStyleChaotic = document.getElementById('transition-style-chaotic');
        if (transitionStyleClean) transitionStyleClean.classList.toggle('active', isCleanStyle);
        if (transitionStyleChaotic) transitionStyleChaotic.classList.toggle('active', !isCleanStyle);

        // Reset color
        document.querySelectorAll('.color-btn[data-color]').forEach(b => b.classList.remove('active'));
        const mode = String(this.settings.colorMode || 'original');
        const activeColorBtn = document.querySelector(`.color-btn[data-color="${mode}"]`);
        if (activeColorBtn) activeColorBtn.classList.add('active');
        const realColorsToggle = document.getElementById('real-colors');
        if (realColorsToggle) realColorsToggle.checked = !!this.settings.realColors;
        this.particleSystem.setRealColors(!!this.settings.realColors);
        this.particleSystem.setColorOverride(this.settings.colorMode);

        // Reset custom particle color input
        const particleColorInput = document.getElementById('particle-color-custom');
        if (particleColorInput) particleColorInput.value = '#ffffff';

        // Reset gradient overlay controls
        const gradientEnabledToggle = document.getElementById('gradient-enabled');
        if (gradientEnabledToggle) gradientEnabledToggle.checked = !!this.settings.gradientOverlayEnabled;
        const gradientColorAInput = document.getElementById('gradient-color-a');
        if (gradientColorAInput) gradientColorAInput.value = this.settings.gradientColorA || '#00d4ff';
        const gradientColorBInput = document.getElementById('gradient-color-b');
        if (gradientColorBInput) gradientColorBInput.value = this.settings.gradientColorB || '#a855f7';
        const gradientStrengthSlider = document.getElementById('gradient-strength');
        const gradientStrengthValue = document.getElementById('gradient-strength-value');
        if (gradientStrengthSlider) gradientStrengthSlider.value = String(Math.round(clamp01(this.settings.gradientStrength) * 100));
        if (gradientStrengthValue) gradientStrengthValue.textContent = `${Math.round(clamp01(this.settings.gradientStrength) * 100)}%`;
        const gradientDirectionSelect = document.getElementById('gradient-direction');
        if (gradientDirectionSelect) gradientDirectionSelect.value = this.settings.gradientDirection || 'diag';
        const disableGradient = !(this.settings && this.settings.gradientOverlayEnabled);
        if (gradientColorAInput) gradientColorAInput.disabled = disableGradient;
        if (gradientColorBInput) gradientColorBInput.disabled = disableGradient;
        if (gradientStrengthSlider) gradientStrengthSlider.disabled = disableGradient;
        if (gradientDirectionSelect) gradientDirectionSelect.disabled = disableGradient;

        // Reset background color
        this.applyBackgroundColor(null);
        const bgButtons = document.querySelectorAll('.bg-color-btn');
        bgButtons.forEach(b => b.classList.remove('active'));
        const defaultBgBtn = document.querySelector('.bg-color-btn[data-bg="default"]');
        if (defaultBgBtn) defaultBgBtn.classList.add('active');
        const bgColorInput = document.getElementById('bg-color-custom');
        if (bgColorInput) bgColorInput.value = String(this.settings.backgroundColor || '#0a0a0f');

        // Reset rotation
        this.autoRotate = false;
        this.rotationX = 0;
        this.rotationY = 0;

        // Apply settings
	        this.particleSystem.updateSettings({
	            size: this.settings.size,
	            depthVariance: this.settings.depthVariance,
	            animationSpeed: this.settings.animationSpeed,
	            sizeRandom: this.settings.sizeRandom,
	            sizeMin: this.settings.sizeMin,
	            sizeMax: this.settings.sizeMax,
	            opacityRandom: this.settings.opacityRandom,
	            opacityMin: this.settings.opacityMin,
	            opacityMax: this.settings.opacityMax,
	            zoom: this.settings.zoom,
	            squaresEnabled: this.settings.squaresEnabled,
	            squareRatio: this.settings.squareRatio,
            dissolveCycle: this.settings.dissolveCycle,
            cycleSeconds: this.settings.cycleSeconds,
            holdSeconds: this.settings.holdSeconds,
            chaos: this.settings.chaos
        });
        this.renderer.updateSettings({
            glowIntensity: this.settings.glowIntensity,
            zoom: this.settings.zoom,
            colorMode: this.settings.colorMode,
            chromaticShift: this.settings.chromaticShift,
            gradientOverlayEnabled: this.settings.gradientOverlayEnabled,
            gradientColorA: this.settings.gradientColorA,
            gradientColorB: this.settings.gradientColorB,
            gradientStrength: this.settings.gradientStrength,
            gradientDirection: this.settings.gradientDirection
        });

        if (this.svgData || this.currentImage || (this.logoSequence && this.logoSequence.sourceType === 'image')) {
            this.regenerateParticles();
        }
    }

    /**
     * Import settings from a JSON string or object, applying them to the running app.
     * Properties not present in the input are left unchanged.
     */
    importSettings(jsonOrObj) {
        let parsed;
        if (typeof jsonOrObj === 'string') {
            try { parsed = JSON.parse(jsonOrObj); } catch (e) {
                console.error('importSettings: invalid JSON', e);
                return;
            }
        } else {
            parsed = jsonOrObj;
        }
        if (!parsed || typeof parsed !== 'object') return;

        Object.assign(this.settings, parsed);

        // Recreate transition directors with potentially new seed
        this.transitionDirector = new TransitionDirector({ userSeed: this.settings.transitionSeed, mode: 'random' });
        this.shapeTransitionDirector = new ShapeTransitionDirector({ userSeed: this.settings.transitionSeed });

        // Sync particle system
        this.particleSystem.updateSettings({
            size: this.settings.size,
            depthVariance: this.settings.depthVariance,
            animationSpeed: this.settings.animationSpeed,
            sizeRandom: this.settings.sizeRandom,
            sizeMin: this.settings.sizeMin,
            sizeMax: this.settings.sizeMax,
            opacityRandom: this.settings.opacityRandom,
            opacityMin: this.settings.opacityMin,
            opacityMax: this.settings.opacityMax,
            zoom: this.settings.zoom,
            squaresEnabled: this.settings.squaresEnabled,
            squareRatio: this.settings.squareRatio,
            dissolveCycle: this.settings.dissolveCycle,
            cycleSeconds: this.settings.cycleSeconds,
            holdSeconds: this.settings.holdSeconds,
            chaos: this.settings.chaos
        });

        // Sync renderer
        this.renderer.updateSettings({
            glowIntensity: this.settings.glowIntensity,
            zoom: this.settings.zoom,
            colorMode: this.settings.colorMode,
            chromaticShift: this.settings.chromaticShift,
            gradientOverlayEnabled: this.settings.gradientOverlayEnabled,
            gradientColorA: this.settings.gradientColorA,
            gradientColorB: this.settings.gradientColorB,
            gradientStrength: this.settings.gradientStrength,
            gradientDirection: this.settings.gradientDirection
        });

        // Apply background
        if (this.settings.backgroundMode === 'custom' && this.settings.backgroundColor) {
            this.applyBackgroundColor(this.settings.backgroundColor);
        } else {
            this.applyBackgroundColor(null);
        }

        // Regenerate particles if density changed
        if (parsed.density != null || parsed.logoDensity != null || parsed.imageDensity != null) {
            if (this.svgData || this.currentImage || (this.logoSequence && this.logoSequence.sourceType === 'image')) {
                this.regenerateParticles();
            }
        }

        // Apply color mode
        if (parsed.realColors != null) {
            this.particleSystem.setRealColors(!!this.settings.realColors);
        }
        if (parsed.colorMode != null) {
            this.particleSystem.setColorOverride(this.settings.colorMode);
        }

        window.dispatchEvent(new CustomEvent('settings-imported', { detail: this.settings }));
    }

    /**
     * Load preset settings from `window.PARTICLE_PRESET` (object) or
     * `window.PARTICLE_PRESET_URL` (fetch JSON). Called after init if either is set.
     */
    async loadPresetSettings() {
        if (window.PARTICLE_PRESET && typeof window.PARTICLE_PRESET === 'object') {
            this.importSettings(window.PARTICLE_PRESET);
            return;
        }
        if (window.PARTICLE_PRESET_URL) {
            try {
                const resp = await fetch(window.PARTICLE_PRESET_URL);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const json = await resp.json();
                this.importSettings(json);
            } catch (e) {
                console.error('loadPresetSettings: failed to fetch preset', e);
            }
        }
    }

    /**
     * Apply background color by overriding the CSS variable used by the app background.
     * Passing null resets to the CSS default.
     */
    applyBackgroundColor(color) {
        const app = document.getElementById('app');
        if (!app) return;

        if (!color) {
            app.style.removeProperty('--bg-primary');
        } else {
            app.style.setProperty('--bg-primary', color);
        }
    }

    /**
     * Setup mouse/touch interaction for rotation
     */
    setupInteraction() {
        setupInteractionController({
            state: this.state,
            dom: { canvas: this.canvas },
            services: { renderer: this.renderer, magnetTool: this.magnetTool },
            appCompat: this,
            lifecycle: this.lifecycle
        });
    }

    /**
     * Setup export modal
     */
    setupExport() {
        setupExportModalController({
            dom: { exportModal: this.exportModal },
            appCompat: this,
            lifecycle: this.lifecycle
        });
    }

    /**
     * Export canvas as image
     */
    exportImage(format, scale, opts) {
        const rt = this.state && this.state.runtime;
        if (rt && rt.isExporting) return;
        if (rt) rt.isExporting = true;
        try {
            return this.controllers.export.exportImage(format, scale, opts);
        } finally {
            if (rt) rt.isExporting = false;
        }
    }

    /**
     * Export a deterministic offline video render (WebCodecs -> WebM), with PNG ZIP fallback.
     * Requires GPU targets (density >= 200k) for the cinematic pipeline.
     */
    async exportVideo({ format = 'webm', scale = 2, fps = 30 } = {}) {
        const rt = this.state && this.state.runtime;
        if (rt && rt.isExporting) return;
        if (rt) rt.isExporting = true;
        try {
            return await this.controllers.export.exportVideo({ format, scale, fps });
        } finally {
            if (rt) rt.isExporting = false;
        }
    }

    downloadBlob(blob, filename) {
        return this.controllers.export.downloadBlob(blob, filename);
    }

    formatTimestampForFilename(d = new Date()) {
        return this.controllers.export.formatTimestampForFilename(d);
    }

    updateRecordingUI() {
        return this.controllers.recording.updateRecordingUI();
    }

    updateRecordingTimerUI() {
        return this.controllers.recording.updateRecordingTimerUI();
    }

    startLiveRecording({ fps = 60 } = {}) {
        return this.controllers.recording.startLiveRecording({ fps });
    }

    async stopLiveRecording() {
        return this.controllers.recording.stopLiveRecording();
    }

    /**
     * Handle window resize
     */
    handleResize() {
        this.renderer.resize();
    }

    /**
     * Update particle count display
     */
    updateParticleCount() {
        const desiredCount = this.getDesiredParticleCount();
        const gpuTargeted = this.gpu && this.gpu.supported && desiredCount >= 200000;
        const useGPU = this.shouldUseGPU();

        const count = useGPU
            ? ((this.gpu.sim && this.gpu.sim.count) || (this.logoSequence.gpuTargets && this.logoSequence.gpuTargets.count) || desiredCount)
            : (gpuTargeted ? desiredCount : this.particleSystem.getCount());

        document.getElementById('particle-count').textContent = Number(count).toLocaleString();
    }

    getFocusOverlayCircle() {
        if (!this.settings || !this.settings.focusEnabled) return null;
        if (!this.canvas) return null;
        const rect = this.canvas.getBoundingClientRect();
        if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;

        const zoom = Number(this.settings.zoom) || 1.0;
        const depthScale = (typeof this.settings.depthVariance === 'number') ? this.settings.depthVariance : 0.5;
        const depthClamp = Math.max(0, Math.min(1, depthScale));
        const posNorm = 0.985 / (1.0 + depthClamp * 0.3);

        const centerX = (Number(this.settings.focusCenterX) || 0) * zoom * posNorm;
        const centerY = (Number(this.settings.focusCenterY) || 0) * zoom * posNorm;
        const radius = Math.max(0.02, Number(this.settings.focusRadius) || 0.45);
        const radiusClip = radius * zoom * posNorm;
        const radiusPx = radiusClip * 0.5 * Math.min(rect.width, rect.height);

        return {
            enabled: true,
            mode: 'focus',
            centerX,
            centerY,
            radiusClipX: radiusClip,
            radiusClipY: radiusClip,
            radiusPx
        };
    }

    /**
     * Start animation loop
     */
    startAnimation() {
        this.isAnimating = true;
        this.loop.start((deltaTime) => {
            if (!this.isAnimating) return;

            // Recording timer UI (if present)
            if (this._isRecording) {
                this.updateRecordingTimerUI();
            }

            // Auto rotate
            if (this.autoRotate) {
                this.rotationY += deltaTime * 0.5;
            }

            let useGPU = this.shouldUseGPU();

            if (useGPU) {
                try {
                    const sim = this.ensureGPUSim();
                    if (!sim) {
                        throw new Error('GPU sim unavailable (targets not ready).');
                    }

                    // Drive deterministic sequencing (this will set GPU targets + transitionState).
                    this.tickLogoSequence(deltaTime);

                    // If no sequence is active, drive a local dissolve/reform cycle against the same target
                    // so the "Dissolve Cycle" controls still do something in GPU mode.
                    if (!this.logoSequence || !this.logoSequence.active) {
                        this._gpuSingleTime = (this._gpuSingleTime || 0) + deltaTime;
                        const dissolveCycle = !!this.settings.dissolveCycle;
                        const cycleSeconds = Math.max(0.1, Number(this.settings.cycleSeconds || 12));
                        const holdSeconds = Math.max(0, Number(this.settings.holdSeconds || 0));
                        const chaos = Math.max(0, Math.min(1, Number(this.settings.chaos ?? 0.75)));

                        let scatterT = 0;
                        if (dissolveCycle) {
                            const totalSeconds = holdSeconds + cycleSeconds;
                            const t = (this._gpuSingleTime % totalSeconds);
                            const local = Math.max(0, t - holdSeconds);
                            const phase = Math.min(1, local / cycleSeconds);
                            scatterT = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
                            if (t < holdSeconds) scatterT = 0;
                        }

                        this.gpu.transitionState = {
                            morphT: 1,
                            scatterT,
                            chaosT: chaos,
                            attractT: 1.0 - scatterT,
                            settleT: Math.pow(1.0 - scatterT, 1.35)
                        };
                    }

                    const state = this.gpu.transitionState || {
                        morphT: 1,
                        scatterT: 0,
                        chaosT: 0,
                        attractT: 1,
                        settleT: 1
                    };

	                    // Single-logo GPU mode: keep targets pinned to the only logo texture.
	                    if (this.logoSequence && !this.logoSequence.active && this.logoSequence.gpuTargets) {
                        const tex = (this.logoSequence.gpuTargets.textures || [])[0];
                        if (tex) {
                            sim.setTargets({ fromTex: tex, toTex: tex });
                            const targets = this.logoSequence.gpuTargets;
                            const ftex = (targets && targets.fieldTextures && targets.fieldTextures.length)
                                ? targets.fieldTextures[0]
                                : null;
                            sim.setToFieldTexture(ftex);
                        }
                    }

	                    // Step sim and render from textures (no CPU particle arrays).
	                    // Map "Animation Speed" to sim time scale in GPU mode.
	                    const speed = Math.max(0, Math.min(1, Number(this.settings.animationSpeed ?? 0.2)));
	                    const dtSim = deltaTime * (0.25 + speed * 2.75);

	                    // MagnetTool (GPU mode): compute frame params and feed into sim.
	                    const rect = (this.magnetTool && this.magnetTool.enabled)
	                        ? this.canvas.getBoundingClientRect()
	                        : null;
	                    const aspectX = rect && rect.width > rect.height ? rect.height / rect.width : 1;
	                    const aspectY = rect && rect.height > rect.width ? rect.width / rect.height : 1;
	                    const magnet = this.magnetTool
	                        ? this.magnetTool.getFrameParams({
	                            canvasRect: rect,
	                            zoom: this.settings.zoom,
	                            depthScale: this.settings.depthVariance,
	                            aspectX,
	                            aspectY
	                        })
	                        : null;

	                    // Draw the tool overlay inside the canvas so it appears in recordings (GPU path too).
	                    if (this.renderer && typeof this.renderer.setOverlayCircle === 'function') {
	                        const focusCircle = this.getFocusOverlayCircle();
	                        const overlay = focusCircle || (magnet && magnet.enabled ? magnet : null);
	                        this.renderer.setOverlayCircle(overlay);
	                    }

	                    // Interactive GPU mode (Fluid Motion toggle) runs at <=100k particles and should feel snappy.
	                    // We tune sim forces a bit so it forms quickly and dissolves organically (no “boxy rectangle”).
	                    const isInteractiveGpu = !!(this.settings && this.settings.fluidGPU) && sim.count < 200000;
	                    const isSingleLogo = !(this.logoSequence && this.logoSequence.active);
	                    const simParams = { ...(state || {}) };
	                    simParams.magnet = (magnet && magnet.enabled) ? magnet : null;

                    if (isInteractiveGpu && isSingleLogo) {
                        const chaosBase = Math.max(0, Math.min(1, Number(this.settings.chaos ?? 0.75)));
                        // Bigger, smoother swirls (closer to the fbo demo feel)
                        simParams.noiseScale = 2.7;
                        simParams.noiseStrength = 1.05 + chaosBase * 0.95;   // 1.05..2.00
                        simParams.noiseSpeed = 0.14;
                        simParams.vortexStrength = 0.55 + chaosBase * 0.95;  // 0.55..1.50
                        simParams.vortexRadius = 0.85;

                        // Scatter/reform: repulseStrength is used as scatter strength in the sim shader.
                        simParams.repulseStrength = 2.1 + chaosBase * 1.15;  // 2.1..3.25
                        simParams.attractStrength = 4.6;
                        simParams.drag = 1.2;
                        simParams.maxSpeed = 3.1 + chaosBase * 0.7;          // 3.1..3.8
                    }

                    if (this.settings && this.settings.venomMode) {
                        const morphT = (typeof simParams.morphT === 'number') ? simParams.morphT : 1;
                        const chaosT = (typeof simParams.chaosT === 'number') ? simParams.chaosT : 0;
                        const strength = (typeof this.settings.venomStrength === 'number')
                            ? this.settings.venomStrength
                            : 0.7;
                        applyVenomSimParams(simParams, { time: sim.time + dtSim, morphT, chaosT, strength });
                    }

                    sim.step(dtSim, simParams);

                    // Current logo targets (used by GPU renderer for logo-space gradient mapping)
                    let targetFromTex = null;
                    let targetToTex = null;
                    let colorFromTex = null;
                    let colorToTex = null;
                    let useColorTex = false;
                    let colorTexBlend = 0;
                    let fromType = null;
                    let toType = null;
                    const items = (this.logoSequence && Array.isArray(this.logoSequence.items)) ? this.logoSequence.items : [];
                    const getTypeForIndex = (idx, fallback) => {
                        if (items.length) {
                            const item = items[Math.max(0, Math.min(idx, items.length - 1))];
                            if (item && item.type) return String(item.type);
                        }
                        return fallback;
                    };
                    if (this.logoSequence && this.logoSequence.gpuTargets && Array.isArray(this.logoSequence.gpuTargets.textures)) {
                        const textures = this.logoSequence.gpuTargets.textures || [];
                        if (this.logoSequence.active && this.logoSequence.transition) {
                            const tr = this.logoSequence.transition;
                            const fromIdx = Math.max(0, Math.min((tr && tr.fromIndex) || 0, textures.length - 1));
                            const toIdx = Math.max(0, Math.min((tr && tr.toIndex) || 0, textures.length - 1));
                            targetFromTex = textures[fromIdx] || null;
                            targetToTex = textures[toIdx] || targetFromTex;
                            fromType = getTypeForIndex(fromIdx, this.logoSequence.sourceType === 'image' ? 'image' : 'svg');
                            toType = getTypeForIndex(toIdx, this.logoSequence.sourceType === 'image' ? 'image' : 'svg');
                        } else {
                            const idx = (typeof this.logoSequence.index === 'number') ? this.logoSequence.index : 0;
                            const i = Math.max(0, Math.min(idx, textures.length - 1));
                            const tex = textures[i] || textures[0] || null;
                            targetFromTex = tex;
                            targetToTex = tex;
                            fromType = getTypeForIndex(i, this.logoSequence.sourceType === 'image' ? 'image' : 'svg');
                            toType = fromType;
                        }
                    }

                    if (this.logoSequence && this.logoSequence.gpuTargets && Array.isArray(this.logoSequence.gpuTargets.colorTextures)) {
                        const colors = this.logoSequence.gpuTargets.colorTextures || [];
                        if (colors.length) {
                            if (this.logoSequence.active && this.logoSequence.transition) {
                                const tr = this.logoSequence.transition;
                                const fromIdx = Math.max(0, Math.min((tr && tr.fromIndex) || 0, colors.length - 1));
                                const toIdx = Math.max(0, Math.min((tr && tr.toIndex) || 0, colors.length - 1));
                                colorFromTex = colors[fromIdx] || null;
                                colorToTex = colors[toIdx] || colorFromTex;
                            } else {
                                const idx = (typeof this.logoSequence.index === 'number') ? this.logoSequence.index : 0;
                                const i = Math.max(0, Math.min(idx, colors.length - 1));
                                const tex = colors[i] || colors[0] || null;
                                colorFromTex = tex;
                                colorToTex = tex;
                            }
                        }
                    }
                    const isFromImage = fromType === 'image';
                    const isToImage = (toType != null) ? (toType === 'image') : isFromImage;
                    useColorTex = !!(colorFromTex || colorToTex) && (isFromImage || isToImage);
                    const tMorph = (state && typeof state.morphT === 'number') ? Math.max(0, Math.min(1, state.morphT)) : 1;
                    if (isFromImage && isToImage) {
                        colorTexBlend = 1;
                    } else if (isFromImage && !isToImage) {
                        colorTexBlend = 1 - tMorph;
                    } else if (!isFromImage && isToImage) {
                        colorTexBlend = tMorph;
                    } else {
                        colorTexBlend = 0;
                    }

                    const activeLogoIndex = (this.logoSequence && this.logoSequence.active)
                        ? (this.logoSequence.index || 0)
                        : 0;
                    const spriteInfo = this.getParticleIconSourceForLogoIndex(activeLogoIndex);
                    const spriteEnabled = !!(this.settings.particleIconEnabled && spriteInfo);

                    this.renderer.render({
                        mode: 'gpu',
                        count: sim.count,
                        texWidth: sim.texWidth,
                        texHeight: sim.texHeight,
                        posTex: sim.getPositionTexture(),
                        velTex: sim.getVelocityTexture(),
                        randTex: sim.getRandomTexture(),
                        time: sim.time,
                        targetFromTex,
                        targetToTex,
                        colorFromTex,
                        colorToTex,
                        useColorTex
                    }, {
                        glowIntensity: this.settings.glowIntensity,
                        depthVariance: this.settings.depthVariance,
                        zoom: this.settings.zoom,
                        rotationX: this.rotationX,
                        rotationY: this.rotationY,
                        // Transition state (used by GPU renderer for gradient mapping)
                        morphT: state && typeof state.morphT === 'number' ? state.morphT : 1,
                        countRatio: (state && typeof state.countRatio === 'number') ? state.countRatio : 1,
                        colorTexBlend,
                        // GPU performance/feel knobs
                        gpuInteractive: isInteractiveGpu,
                        gpuAdditive: isInteractiveGpu,
	                        // GPU visual controls
	                        userSize: this.settings.size,
	                        sizeRandom: this.settings.sizeRandom,
	                        sizeMin: this.settings.sizeMin,
	                        sizeMax: this.settings.sizeMax,
	                        opacityRandom: this.settings.opacityRandom,
	                        opacityMin: this.settings.opacityMin,
	                        opacityMax: this.settings.opacityMax,
	                        squaresEnabled: this.settings.squaresEnabled,
	                        squareRatio: this.settings.squareRatio,
                        realColors: this.settings.realColors,
                        colorOverrideRgb: parseHexColorToRgb01(this.settings.colorMode),
                        useColorOverride: (this.settings.colorMode && this.settings.colorMode !== 'original'),
                        focusEnabled: this.settings.focusEnabled,
                        focusCenterX: this.settings.focusCenterX,
                        focusCenterY: this.settings.focusCenterY,
                        focusRadius: this.settings.focusRadius,
                        focusSoftness: this.settings.focusSoftness,
                        focusScatter: this.settings.focusScatter,
                        // Gradient overlay (GPU path)
                        gradientOverlayEnabled: this.settings.gradientOverlayEnabled,
                        gradientColorA: this.settings.gradientColorA,
                        gradientColorB: this.settings.gradientColorB,
                        gradientStrength: this.settings.gradientStrength,
                        gradientDirection: this.settings.gradientDirection,
                        sprite: spriteInfo,
                        spriteEnabled,
                        spriteRotate: this.settings.particleIconRotate,
                        spriteColorMode: this.settings.particleIconColorMode,
                        colorMode: this.settings.colorMode,
                        chromaticShift: this.settings.chromaticShift
                    });
                } catch (e) {
                    // If GPU mode fails for any reason, avoid a “black screen” by falling back to CPU mode.
                    console.error('GPU Fluid Motion failed; falling back to CPU mode:', e);
                    useGPU = false;
                    if (this.settings) this.settings.fluidGPU = false;
                    const fluidGpuToggle = document.getElementById('fluid-gpu');
                    if (fluidGpuToggle) fluidGpuToggle.checked = false;
                    const magnetEnabledToggle = document.getElementById('magnet-enabled');
                    if (magnetEnabledToggle) magnetEnabledToggle.disabled = false;
                    try { this.disposeSequenceGPUTargets(); } catch (_) { /* ignore */ }
                    this.gpu.transitionState = null;
                }
            }

            if (!useGPU) {
                // CPU fallback
                this.gpu.transitionState = null;
                const rect = (this.magnetTool && this.magnetTool.enabled)
                    ? this.canvas.getBoundingClientRect()
                    : null;
                const aspectX = rect && rect.width > rect.height ? rect.height / rect.width : 1;
                const aspectY = rect && rect.height > rect.width ? rect.width / rect.height : 1;
                const magnet = this.magnetTool
                    ? this.magnetTool.getFrameParams({
                        canvasRect: rect,
                        zoom: this.settings.zoom,
                        depthScale: this.settings.depthVariance,
                        aspectX,
                        aspectY
                    })
                    : null;

                // Draw the tool overlay inside the canvas so it appears in recordings.
                if (this.renderer && typeof this.renderer.setOverlayCircle === 'function') {
                    const focusCircle = this.getFocusOverlayCircle();
                    const overlay = focusCircle || magnet;
                    this.renderer.setOverlayCircle(overlay);
                }

                this.tickLogoSequence(deltaTime);
                this.tickSingleLogoCycle(deltaTime);
                this.particleSystem.update(deltaTime, { magnet });

                const activeLogoIndex = (this.logoSequence && this.logoSequence.active)
                    ? (this.logoSequence.index || 0)
                    : 0;
                const spriteInfo = this.getParticleIconSourceForLogoIndex(activeLogoIndex);
                const spriteEnabled = !!(this.settings.particleIconEnabled && spriteInfo);

                this.renderer.render(this.particleSystem.getParticles(), {
                    glowIntensity: this.settings.glowIntensity,
                    depthVariance: this.settings.depthVariance,
                    zoom: this.settings.zoom,
                    rotationX: this.rotationX,
                    rotationY: this.rotationY,
                    focusEnabled: this.settings.focusEnabled,
                    focusCenterX: this.settings.focusCenterX,
                    focusCenterY: this.settings.focusCenterY,
                    focusRadius: this.settings.focusRadius,
                    focusSoftness: this.settings.focusSoftness,
                    focusScatter: this.settings.focusScatter,
                    // Gradient overlay (CPU path)
                    gradientOverlayEnabled: this.settings.gradientOverlayEnabled,
                    gradientColorA: this.settings.gradientColorA,
                    gradientColorB: this.settings.gradientColorB,
                    gradientStrength: this.settings.gradientStrength,
                    gradientDirection: this.settings.gradientDirection,
                    sprite: spriteInfo,
                    spriteEnabled,
                    spriteRotate: this.settings.particleIconRotate,
                    spriteColorMode: this.settings.particleIconColorMode,
                    colorMode: this.settings.colorMode,
                    chromaticShift: this.settings.chromaticShift
                });
            }
        });
    }

    /**
     * Stop animation
     */
    stopAnimation() {
        this.isAnimating = false;
        if (this.loop) this.loop.stop();
    }

    /**
     * Dispose the app instance:
     * - stops the RAF loop
     * - aborts all UI listeners registered with the lifecycle
     * - frees GPU targets/sim state and renderer resources
     */
    dispose() {
        try { this.stopAnimation(); } catch (_) { /* ignore */ }

        // Invalidate any in-flight async builds so their results are ignored.
        this._gpuTargetBuildToken = (this._gpuTargetBuildToken || 0) + 1;
        this._rasterRegenToken = (this._rasterRegenToken || 0) + 1;

        try { this.controllers && this.controllers.gpu && this.controllers.gpu.disposeSequenceGPUTargets(); } catch (_) { /* ignore */ }
        try { this.renderer && typeof this.renderer.dispose === 'function' && this.renderer.dispose(); } catch (_) { /* ignore */ }
        try { this.lifecycle && typeof this.lifecycle.dispose === 'function' && this.lifecycle.dispose(); } catch (_) { /* ignore */ }
    }
}
