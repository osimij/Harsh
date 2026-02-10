import { getDefaultSettings } from './defaults.js';

export function createInitialState() {
    return {
        gpu: {
            supported: false,
            sim: null,
            transitionState: null
        },

        // Multi-logo sequencing (particles reform into the next logo)
        logoSequence: {
            active: false,
            sourceType: null,
            items: [],
            svgStrings: [],
            svgDatas: [],
            imageSources: [],
            pointClouds: [],
            logoIds: [],
            countRatios: [],
            gpuTargets: null, // { textures: WebGLTexture[], width, height, count }
            index: 0,
            // New transition-based sequencing
            transition: null,
            holdTimer: 0
        },

        // Custom particle icon (SVG) library + per-logo assignments
        particleIcons: {
            library: [],
            assignments: []
        },

        settings: getDefaultSettings(),

        // Phase B will consolidate these into state-driven runtime.
        runtime: {
            isAnimating: false,
            lastTime: 0,
            isExporting: false
        }
    };
}
