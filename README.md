# Harsh Bika Portfolio

This is a static portfolio site for Harsh Bika. There is no app build step: the HTML, CSS, JavaScript, and assets are served directly.

## Quick Start

Run the no-cache local server from the repo root:

```bash
python3 scripts/dev-server.py
```

Then open:

- `http://localhost:8000/index.html` for the homepage particle hero.
- `http://localhost:8000/work.html` for the logo gallery and case-study pages.
- `http://localhost:8000/particle-forge.html` for the particle editor/export tool.
- `http://localhost:8000/prework.html` and `http://localhost:8000/contact.html` for the supporting pages.

The dev server uses no-cache headers because Safari and mobile browsers can otherwise hold onto old SVG, CSS, and JS files.

## Important Files

- `index.html` contains the homepage hero, bottom logo rail, and homepage GPU particle system.
- `work.html`, `work.css`, and `js/work.js` contain the work gallery and project detail route.
- `particle-forge.html` and `js/app/core/particleForge.js` contain the full particle editor.
- `particle-settings.json` controls the homepage particle look.
- `assets/logos/logos.json` is the central logo/project manifest.
- `assets/logos/full-logos/` contains full wordmarks.
- `assets/logos/symbol/` contains simplified symbol-only marks for particles and compact displays.

## Handoff Docs

Start here before changing particle or logo behavior:

- `AGENTS.md` gives AI-agent guardrails for working safely in this repo.
- `docs/particle-system.md` explains how particles are generated, animated, and rendered.
- `docs/adding-logos.md` explains the two logo asset types and how to add a new logo without breaking the hero or gallery.
- `docs/particle-icons.md` explains the Particle Forge feature that turns particles into tiny SVG/logo sprites.

## Deployment

`vercel.json` serves this repo as a static site with the repo root as the output directory. The included `scripts/deploy.sh` is a helper for claimable Vercel preview deployments.
