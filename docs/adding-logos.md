# Adding Logos

The repo uses two logo asset types. This is the most important thing to understand before adding or changing logos.

## The Two Logo Types

### 1. Full Logo / Wordmark

Folder:

```text
assets/logos/full-logos/
```

Used for:

- Work gallery cards.
- Project detail pages.
- Homepage bottom logo rail.
- Fallback particle source when no symbol logo is provided.

This version can include the full brand name, wordmark, and detailed lockup.

### 2. Symbol Logo / Particle Logo

Folder:

```text
assets/logos/symbol/
```

Used for:

- Homepage particle canvas.
- Compact mark fallback in gallery code.

This should be the simpler mark: icon, monogram, badge, or symbol-only version. Particle systems work better with clear silhouettes than long text.

If a manifest entry has `symbolFile`, homepage particles use that file. If it does not, homepage particles fall back to the full wordmark.

## Add a New Logo

1. Add the full logo SVG to:

```text
assets/logos/full-logos/New Brand.svg
```

2. Add a simplified symbol SVG to:

```text
assets/logos/symbol/New Brand.svg
```

3. Add an entry to `assets/logos/logos.json`:

```json
{
  "id": "new-brand",
  "file": "New Brand.svg",
  "symbolFile": "New Brand.svg",
  "name": "New Brand",
  "displayName": "New Brand",
  "tags": ["Logo", "Branding"],
  "description": "Short project description for the work gallery.",
  "year": "2026",
  "thumbnailBg": "#111111",
  "logoColor": "#FFFFFF",
  "galleryLogoScale": 1
}
```

4. Start the dev server and check:

- `index.html`: the symbol appears in homepage particles and the full logo appears in the bottom rail.
- `work.html`: the full logo appears in the gallery.
- `work.html?project=new-brand`: the detail route opens.
- `particle-forge.html`: uploading the SVG still creates a clean particle shape.

## Manifest Fields

Common fields:

- `id`: stable slug used in URLs and DOM attributes. Keep it lowercase with hyphens.
- `file`: full logo file inside `assets/logos/full-logos/`.
- `symbolFile`: symbol logo file inside `assets/logos/symbol/`.
- `name`: internal/project name.
- `displayName`: visible name.
- `tags`: gallery filters and labels.
- `description`: gallery card copy.
- `year`: visible year.
- `thumbnailBg`: gallery tile background color.
- `logoColor`: default recolor target for SVG gallery marks.
- `galleryLogoColor`: optional gallery-specific override.
- `galleryLogoScale`: optional scale adjustment for the gallery mark.
- `useOriginalColors`: set to `true` when the logo should not be recolored.
- `initialActive`: set one logo to `true` if it should be the initial homepage hero logo.
- `excludeFromHero`: set to `true` if the logo should not appear in homepage particles.
- `archived`: set to `true` if the project should be hidden from the visible work gallery.
- `imageFile`: raster image path for gallery-only image logos. Homepage particles skip raster-only entries unless there is also an SVG `file`.

## SVG Preparation Rules

For full logos and symbol logos:

- Include a clean `viewBox`.
- Convert text to outlines/paths.
- Avoid hidden background rectangles unless they are part of the mark.
- Avoid external linked images.
- Prefer filled paths for strong particle silhouettes.
- Keep symbols centered in the viewBox with a little breathing room.
- If using gradients, masks, clips, or `<use>`, test in both homepage and Particle Forge.

For particle symbols specifically:

- Prefer one clear shape over many tiny details.
- Avoid long wordmarks; they become thin particle dust at small sizes.
- Make the symbol wider/taller only if the real mark needs it. The particle system respects the SVG aspect ratio.
- If the homepage particles look too dense or muddy, simplify the symbol SVG first before changing particle code.

## How Homepage Chooses Logos

In `index.html`, `loadLogos()` does this:

1. Fetches `assets/logos/logos.json`.
2. Keeps entries with `file` and without `excludeFromHero`.
3. Loads full logo SVGs from `assets/logos/full-logos/` for the logo rail.
4. Loads `symbolFile` from `assets/logos/symbol/` for the particle canvas.
5. Falls back to the full logo SVG if there is no symbol file or the symbol fetch fails.

So if the rail looks right but the particles look wrong, check `symbolFile` first.

## How Work Gallery Chooses Logos

In `js/work.js`:

- `imageFile` takes precedence for raster-based gallery marks.
- Otherwise the gallery loads `file` from `assets/logos/full-logos/`.
- If the full logo fails and `symbolFile` exists, it tries `assets/logos/symbol/`.
- Archived projects are hidden by `archived: true`.

Gallery recoloring is separate from particle coloring. A logo can look white in the gallery and still be rendered with particle color settings in the hero.

## When to Use `excludeFromHero`

Use `excludeFromHero: true` when:

- The logo has no clean SVG particle source.
- It is text-heavy and looks bad as particles.
- It is a raster-only gallery item.
- It should stay in the work archive but not cycle in the homepage hero.

Do not use `archived: true` just to remove a logo from homepage particles. `archived` affects the work gallery; `excludeFromHero` affects the homepage particle list.

## Quick Troubleshooting

- Missing in homepage: check `file`, `excludeFromHero`, JSON syntax, and network console.
- Full logo shows in rail but not particles: check `symbolFile` path and SVG validity.
- Particles form the wrong shape: remove hidden backgrounds, masks, or accidental large paths from the symbol SVG.
- Particles are cropped: add viewBox breathing room or reduce homepage `zoom` in `particle-settings.json`.
- Gallery color is wrong: check `logoColor`, `galleryLogoColor`, and `useOriginalColors`.
- Detail page does not open: check `id` and the `work.html?project=<id>` URL.
