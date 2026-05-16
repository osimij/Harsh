# Particle Icons in Particle Forge

Particle Icons are a Particle Forge feature. They let each rendered particle use a tiny SVG sprite instead of the normal round/square particle shape.

This is separate from adding logos to the homepage particle hero. For homepage logo additions, use `docs/adding-logos.md`.

## What the Feature Does

Normally, particles render as soft circles or squares. With Particle Icons enabled, the renderer rasterizes an SVG into a tiny texture and draws that texture at every particle position.

Particle Forge currently supports three assignment types per loaded logo:

- `classic`: normal circle/square particles.
- `self`: use the active logo SVG itself as the tiny particle sprite.
- `icon`: use an uploaded SVG icon from the Particle Icons library.

The UI lives in `particle-forge.html` under the `PARTICLE ICONS` section.

## UI Controls

Controls:

- `Custom Icons`: enables or disables SVG sprites for particles.
- `Upload Icons`: adds SVG files to the in-memory icon library.
- `Logo`: chooses which loaded logo in the sequence is being edited.
- `Icon For Logo`: chooses `Classic`, `Use This Logo`, or an uploaded icon.
- `Apply To All Logos`: copies the current assignment across every logo in the sequence.
- `Icon Rotation`: either spin with each particle or stay still.
- `Icon Colors`: either tint by particle color or use the SVG's original colors.

## Runtime State

Particle icon state lives in `state.particleIcons` from `js/app/core/state.js`:

```js
particleIcons: {
  library: [],
  assignments: []
}
```

`library` contains uploaded SVG sprites:

```js
{
  id: "unique-id",
  name: "uploaded-file-name.svg",
  svg: "<svg>...</svg>"
}
```

`assignments` is one entry per loaded logo:

```js
{ type: "classic" }
{ type: "self" }
{ type: "icon", id: "library-icon-id" }
```

Important methods in `js/app/core/particleForge.js`:

- `ensureParticleIconState()`
- `resetParticleIconAssignments(count)`
- `setParticleIconAssignment(index, assignment)`
- `applyParticleIconToAll(assignment)`
- `getParticleIconSourceForLogoIndex(index)`

The UI wiring is in `js/app/ui/controlsController.js`.

## Rendering Path

Both CPU and GPU render paths pass sprite settings into `Renderer`:

- `sprite`: `{ key, svg }`
- `spriteEnabled`: boolean
- `spriteRotate`: boolean
- `spriteColorMode`: `tint` or `original`

`js/renderer.js` handles the rest:

1. `_getSpriteEntry(sprite)` checks the sprite cache.
2. `_rasterizeSvgToCanvas()` draws the SVG into a small canvas.
3. The canvas becomes a WebGL texture.
4. The particle shader uses that texture instead of the default circle/square shape.

The renderer keeps a sprite cache by `sprite.key`, so if the SVG changes, the key also needs to change or the old texture may be reused.

## Using a Logo as the Particle Icon

When the assignment is `self`, `getParticleIconSourceForLogoIndex()` returns the SVG for the current logo.

Rules:

- Works for SVG logos.
- Does not work for image-only logos.
- In mixed sequences, it only works for SVG items.
- If a sequence is active, it uses that logo's `svgStrings[index]`.
- If there is only one active SVG, it uses `currentSvgString`.

Use this when the desired effect is "the logo is made out of tiny copies of itself."

## Uploaded Icon Rules

Uploaded icons should be SVG files.

Prepare them like particle symbol SVGs:

- Use a clear `viewBox`.
- Convert text to paths.
- Keep the shape centered.
- Avoid external images.
- Avoid unnecessary hidden rectangles.

Very detailed icons can work, but they often look noisy at particle size. Simple filled shapes are easier to read.

## Color Modes

`Tinted By Particle Color` means the SVG alpha is used as a mask and the particle system controls the color.

`Use SVG Colors` means the sprite texture's original RGB colors are used. This can be useful for multicolor icons, but it can fight with chromatic or gradient particle settings.

## Export Behavior

Particle icon settings are included in still-image and video export paths in `js/app/features/exportController.js`.

If an export does not show icons:

1. Confirm `particleIconEnabled` is true.
2. Confirm the active logo has a non-classic assignment.
3. Confirm the SVG sprite rasterized successfully in `js/renderer.js`.
4. Confirm the export path is passing `sprite`, `spriteEnabled`, `spriteRotate`, and `spriteColorMode`.

## Common Mistakes

- Expecting Particle Icons to affect the homepage hero. They only affect Particle Forge unless code is added to homepage `index.html`.
- Assigning `self` to an image-only logo. There is no SVG for the renderer to use as a sprite.
- Uploading an SVG with a huge empty viewBox. The tiny sprite will look invisible.
- Changing an uploaded SVG but reusing the same cache key. The renderer may keep the old rasterized texture.
