export const DEFAULT_SETTINGS = Object.freeze({
    // Legacy single-density value (kept for backward compatibility with saved state).
    density: 350000,
    logoDensity: 350000,
    imageDensity: 15000,
    size: 2.0,
    depthVariance: 0.5,
    glowIntensity: 0.4,
    animationSpeed: 0.2,
    zoom: 1.0,
    // Randomization coverage (0..1): fraction of particles affected
    sizeRandom: 1.0,
    opacityRandom: 1.0,
    // Randomization ranges:
    // - sizeMin/sizeMax are multipliers applied to Base Size (e.g. 0.8..1.2)
    // - opacityMin/opacityMax are absolute alpha values (0..1)
    sizeMin: 0.8,
    sizeMax: 1.2,
    opacityMin: 0.68,
    opacityMax: 0.82,
    focusEnabled: false,
    focusCenterX: 0,
    focusCenterY: 0,
    focusRadius: 0.45,
    focusSoftness: 0.35,
    focusScatter: 1.5,
    edgeAuraEnabled: false,
    edgeAuraAmount: 0.12,
    edgeAuraSpread: 0.12,
    edgeAuraOutlier: 0.05,
    // Enable GPU-driven curl-noise flow simulation (fluid, organic motion).
    // Note: when enabled, the app runs a GPU simulation path (some CPU-only features may be limited).
    fluidGPU: true,
    venomMode: false,
    venomStrength: 0.7,
    colorMode: 'original',
    realColors: true,
    gradientOverlayEnabled: true,
    gradientColorA: '#00d4ff',
    gradientColorB: '#a855f7',
    gradientStrength: 0.7,
    gradientDirection: 'diag',
    squaresEnabled: false,
    squareRatio: 0.25,
    particleIconEnabled: false,
    particleIconColorMode: 'tint',
    particleIconRotate: true,
    backgroundMode: 'default',
    backgroundColor: '#0a0a0f',
    dissolveCycle: true,
    cycleSeconds: 12,
    holdSeconds: 0,
    chaos: 0.75,
    transitionStyle: 'chaotic',
    shapeAwareTransitions: true,
    shapeRasterSize: 384,
    transitionSeed: 1
});

/**
 * Return a fresh settings object containing the default values.
 * NOTE: This is a shallow clone, which is sufficient because the settings object is flat.
 */
export function getDefaultSettings() {
    return { ...DEFAULT_SETTINGS };
}
