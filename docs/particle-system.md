# Particle System Guide

This project has two particle experiences:

1. The homepage particle hero in `index.html`.
2. The full editor/export tool in `particle-forge.html`.

They share rendering modules, but they are not the same app. When changing behavior, first decide which experience you are touching.

## Core Idea

A logo becomes particles in three steps:

1. Read an SVG or image.
2. Sample it into many points in normalized canvas space, roughly `-1` to `1`.
3. Render those points as glowing particles and animate them toward, away from, or between logo shapes.

Think of the logo as a cloud of target positions. The animation system moves particles around, but the target positions define the logo shape.

## Homepage Hero

The homepage particle system lives mostly inside `index.html`.

Data flow:

1. `assets/logos/logos.json` is fetched.
2. Logos with `file` and without `excludeFromHero` are included.
3. Full wordmark SVGs are loaded from `assets/logos/full-logos/` for the bottom logo rail.
4. Symbol SVGs are loaded from `assets/logos/symbol/` for the particle canvas when `symbolFile` exists.
5. If `symbolFile` is missing or fails to load, the full wordmark is used as the particle source.
6. `RasterPointSampler` turns each particle SVG into a GPU target texture.
7. `GPUParticleSim` moves particles between the active logo and the next logo.
8. `Renderer` draws the final WebGL particles.

Important homepage files:

- `index.html`: homepage-specific orchestration, logo loading, rail interaction, hover repel, and transition timing.
- `particle-settings.json`: homepage particle settings loaded at runtime.
- `js/raster-point-sampler.js`: converts SVG pixels into packed target points.
- `js/gpu-particle-sim.js`: GPU simulation for motion.
- `js/renderer.js`: WebGL particle drawing.

The homepage uses the GPU path because the default density is high (`350000` particles). If WebGL2 or float textures are unavailable, it falls back to a static/failure state instead of the full particle animation.

## Particle Forge

Particle Forge is the editor at `particle-forge.html`.

Main flow:

1. `js/app.js` starts `ParticleForge`.
2. `js/app/core/particleForge.js` owns the main app state and delegates UI/features to controllers.
3. Uploads come from `js/app/ui/uploadController.js`.
4. SVGs are sanitized in `js/app/core/svgPipeline.js`.
5. SVGs are parsed by `js/svg-parser.js`.
6. Vector SVGs are sampled by `js/point-sampler.js`.
7. Complex SVGs or high-density GPU exports use `js/raster-point-sampler.js`.
8. CPU particles live in `js/particle-system.js`.
9. GPU particles live in `js/gpu-particle-sim.js`.
10. Both paths render through `js/renderer.js`.

Particle Forge supports SVG sequences, image sequences, and mixed SVG/image sequences. Multi-logo sequences are stored in `state.logoSequence`.

## CPU vs GPU Paths

There are two engines because different tasks need different tradeoffs.

### CPU Path

Used for lower-density interactive editing and fallback behavior.

Key file: `js/particle-system.js`

The CPU path stores an array of particle objects. Each particle has:

- `x`, `y`, `z`: current position.
- `baseX`, `baseY`, `baseZ`: formed logo position.
- `_scatterX`, `_scatterY`, `_scatterZ`: scattered position.
- `color`, `displayColor`, `size`, `opacity`: visual values.
- `_shape`, `_angle`, `_aspect`: circle/square/sprite drawing controls.
- `_isAmbient` and `_layer`: whether it belongs to the logo or background starfield.

CPU is easier to reason about and supports detailed per-particle staging such as edge-first and SDF-front transitions.

### GPU Path

Used for high-density particles, homepage hero, fluid motion, and video export.

Key files:

- `js/gpu-particle-sim.js`
- `js/raster-point-sampler.js`
- `js/renderer.js`

The GPU path stores particle state in float textures instead of JavaScript objects. The simulation runs in shaders using ping-pong framebuffers. This is much faster for hundreds of thousands of particles, but it is harder to debug because particle data is packed into textures.

## Logo Sequences

Particle Forge stores sequences in `state.logoSequence`:

- `active`: whether more than one logo/image is cycling.
- `sourceType`: `svg`, `image`, or `mixed`.
- `svgStrings`: sanitized SVG strings.
- `svgDatas`: parsed SVG data.
- `imageSources`: loaded image metadata.
- `pointClouds`: CPU point clouds.
- `gpuTargets`: GPU textures for high-density rendering/export.
- `index`: active logo index.
- `transition`: current transition state.
- `holdTimer`: pause time between transitions.

Transitions are driven by:

- `js/transition-director.js` for general deterministic transition scripts.
- `js/shape-transition-director.js` and `js/logo-shape-analyzer.js` for shape-aware CPU transitions.

## Settings

Default Particle Forge settings live in `js/app/core/defaults.js`.

Homepage runtime settings live in `particle-settings.json`.

Common settings:

- `logoDensity`: number of particles for SVG logos.
- `imageDensity`: number of particles for raster images.
- `size`: base particle size.
- `depthVariance`: how much 3D depth/parallax exists.
- `glowIntensity`: bloom/glow strength.
- `zoom`: visual scale.
- `sizeRandom`, `sizeMin`, `sizeMax`: particle size variation.
- `opacityRandom`, `opacityMin`, `opacityMax`: particle opacity variation.
- `squaresEnabled`, `squareRatio`: mix square particles with round particles.
- `colorMode`, `realColors`, `chromaticShift`: color behavior.
- `cycleSeconds`, `holdSeconds`, `chaos`: transition timing and motion.
- `transitionStyle`: `clean` or `chaotic`.

When adding a new setting, update all places that need to know about it: defaults, JSON preset if needed, UI controls, import/export settings, renderer settings, CPU particle settings, and GPU render/sim settings.

## Common Failure Modes

- Blank homepage canvas: WebGL2 or `EXT_color_buffer_float` failed, or target textures did not build.
- Logo appears as a rectangle/cloud: SVG rasterization sampled the whole viewBox or a hidden background shape.
- Logo is cropped: SVG viewBox is too tight, scale is too high, or particle depth/zoom pushes it outside clip space.
- Logo has wrong shape: the particle canvas is using `symbolFile`; update the symbol asset, not only the full wordmark.
- Logo color looks wrong: gallery recoloring and particle color overrides are separate systems.
- Particle Forge works but homepage does not: Particle Forge can use vector and raster fallback paths; homepage relies on its own GPU target loading in `index.html`.

## Safe Debug Path

1. Start the no-cache server: `python3 scripts/dev-server.py`.
2. Check `index.html` for homepage particle behavior.
3. Check `work.html` for manifest/gallery behavior.
4. Check `particle-forge.html` with the demo sequence or a direct upload.
5. If the issue is only homepage particles, inspect `index.html`, `particle-settings.json`, and `assets/logos/logos.json`.
6. If the issue is only Particle Forge, inspect `js/app/core/particleForge.js` and the relevant controller/module.
