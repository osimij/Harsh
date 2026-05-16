# AGENTS.md

Guidance for AI agents working in this repo.

## Read First

Before editing particle or logo behavior, read these files:

- `README.md`
- `docs/particle-system.md`
- `docs/adding-logos.md`
- `docs/particle-icons.md` if the task mentions custom particle icons, logo-shaped particles, sprites, or Particle Forge exports.

## Project Shape

This is a static site. There is no normal package install or build step for the main site.

Use:

```bash
python3 scripts/dev-server.py
```

Then test pages at `http://localhost:8000/`.

Core entry points:

- Homepage particle hero: `index.html`
- Work gallery and case studies: `js/work.js`, `work.html`, `work.css`
- Particle editor/export tool: `particle-forge.html`, `js/app/core/particleForge.js`
- Particle rendering primitives: `js/renderer.js`, `js/gpu-particle-sim.js`, `js/particle-system.js`, `js/raster-point-sampler.js`, `js/point-sampler.js`
- Logo manifest: `assets/logos/logos.json`

## Safe-Change Rules

- Do not rename logo files casually. Manifest paths are exact and include spaces/apostrophes.
- Keep full logo assets and symbol assets separate. Full wordmarks go in `assets/logos/full-logos/`; particle-friendly symbols go in `assets/logos/symbol/`.
- If adding a logo to the homepage particles, make sure the manifest entry has `file`, is not `excludeFromHero`, and preferably has a clean `symbolFile`.
- If an SVG uses live text, convert it to paths before adding it. Browser font differences can change particle sampling.
- If a logo uses complex masks, clips, gradients, or `<use>`, test it in the homepage and Particle Forge. The raster sampler handles more SVG features than the simple vector parser, but not every SVG exports cleanly.
- Keep particle settings names in sync between `particle-settings.json`, `js/app/core/defaults.js`, and renderer/particle-system usage when adding a new setting.
- Avoid broad refactors in `index.html` unless the task is specifically about the homepage hero. It contains a self-contained homepage particle implementation.

## Verification Checklist

For logo or particle changes, check at least:

- `index.html`: homepage loads, particle logo appears, logo rail works.
- `work.html`: gallery cards load and project detail opens.
- `particle-forge.html`: upload/demo still renders particles.

Use browser screenshots or manual visual checks for particle work. A code-only check is not enough because many issues are visual: blank canvas, cropped logo, wrong symbol, bad scale, or unreadable particles.
