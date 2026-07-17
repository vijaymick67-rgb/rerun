# Approved Rerun icon direction

This branch stores the approved source artwork for roadmap task #81.

## Visual identity

- rounded television/viewing-window silhouette
- integrated replay loop
- deep charcoal/navy background
- electric-blue/periwinkle mark
- no text or letters inside the icon

## Source files

- `design/rerun-icon-approved.svg`
- `design/rerun-icon-approved-maskable.svg`

## Implementation instructions

The implementation agent must use these sources as the authoritative artwork. Do not redesign or reinterpret the icon.

On the fresh #81 implementation branch, copy the approved SVG source into the final public asset names and deterministically render:

- `public/favicon.svg`
- `public/rerun-icon.svg`
- `public/apple-touch-icon.png` at 180×180
- `public/icon-192.png` at 192×192
- `public/icon-512.png` at 512×512
- `public/icon-maskable-512.png` at 512×512, using the maskable source

The maskable asset must retain the extra safe-zone breathing room. Verify exact PNG dimensions and representative circular and rounded-square crops.
