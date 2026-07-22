# Loki Armour visual system — Phase 0A

Status: proposal and isolated prototype foundation. This document does not authorize a production-wide retheme. Candidate values live only under `.loki-prototype`; production `@theme`, first-paint shell, PWA metadata, icons, and route behavior remain unchanged in Phase 0A.

## A. Design principles

### Material translation

1. **Blackened leather is the foundation.** Canvas and ordinary surfaces should be warm near-black rather than blue-black. Leather is expressed through narrow tonal shifts, an inner top highlight, soft deep shadow, and very low-contrast irregular light — never a photographic texture or noisy filter.
2. **Forest fabric is atmosphere.** Deep forest and restrained emerald create environmental depth, passive tonal panels, progress, and completion. Forest is not a universal success color and should not replace every neutral surface.
3. **Aged gold and bronze are structure.** Gold identifies primary action, navigation selection, small labels, focus, and rare hero trim. Bronze handles quieter borders and structural edges. Neither should flood full cards or become flat yellow.
4. **Warm ivory carries content.** Primary copy is warm ivory, with stone-beige secondary and muted text. This counters the cool blue-grey cast of the current system and preserves low-light comfort.
5. **Asgardian geometry is restrained.** A clipped secondary corner, short corner strokes, narrow armour edges, and occasional angular separators provide identity. Controls keep conventional, usable geometry where a decorative silhouette would weaken touch behavior.
6. **Luxury comes from hierarchy, not effects.** Use one atmosphere, a small number of material recipes, deliberate spacing, and selective edge contrast. Avoid continuous glows, animated filters, ornamental frames, literal iconography, and cosplay motifs.
7. **Meaning outranks theme.** Completion, warning, destructive, disabled, focus, and selection remain distinct semantic states. Color supports labels, icons, shape, and copy; it never becomes the only signal.

### Tone targets

- Dense but breathable: compact metadata and rows, with 12–16 px internal rhythm and 20–24 px section separation.
- Tactile but modern: layered gradients no stronger than necessary to reveal material.
- Dark but readable: primary copy remains visually dominant; gold labels remain small and tracked rather than body copy.
- Distinctive but durable: details must survive a 390 × 844 installed-PWA viewport and inexpensive iPhone compositing.

## B. Semantic token proposal

Candidate values are tuned starting coordinates. Validate on physical iPhone hardware and with contrast tooling before production migration.

| Semantic role | Candidate | Intended use |
| --- | --- | --- |
| `canvas` | `#080d09` | Primary app background. Warm green-black, never a card fill. |
| `canvas-deep` | `#050806` | Status-bar/edge depth and atmosphere anchor. |
| `canvas-atmosphere` | forest radial fields over `canvas` | One page-level ambient background, not repeated per card. |
| `surface-base` | `#101511` | Ordinary leather cards, rows, groups. |
| `surface-raised` | `#171d17` | Elevated panels, dialogs, hero interiors. |
| `surface-interactive` | `#1d251d` | Resting buttons, inputs, tappable rows. |
| `surface-pressed` | `#252d24` | Short press feedback; pair with opacity/scale policy. |
| `leather-highlight` | `rgb(242 238 226 / 0.055)` | One-pixel inner top edge or faint diagonal lift. |
| `leather-shadow` | `rgb(0 0 0 / 0.58)` | Deep ambient shadow under leather surfaces. |
| `forest-tonal-surface` | `#10291b` | Passive contextual panel; it does not mean success. |
| `forest-active-surface` | `#17482d` | Active green control background, e.g. an on toggle. |
| `border-subtle` | `rgb(182 154 87 / 0.14)` | Ordinary card and row separation. |
| `border-standard` | `rgb(182 154 87 / 0.26)` | Interactive controls, groups, poster frames. |
| `border-strong` | `rgb(209 184 111 / 0.43)` | Dialog/hero emphasis and focus-adjacent structure. |
| `armour-edge` | `#79633a` | Bronze structural stroke and quiet bevel. |
| `armour-edge-strong` | `#b69a57` | Short corner stroke or selected structural edge. |
| `text-primary` | `#f2eee2` | Headings and body copy. |
| `text-secondary` | `#c5c0b2` | Metadata with real reading importance. |
| `text-muted` | `#969487` | Captions and supporting labels; not disabled text. |
| `gold-accent` | `#b69a57` | Structural accent and secondary gold label. |
| `gold-accent-strong` | `#d1b86f` | Primary action, selected navigation text, important label. |
| `gold-muted` | `#79633a` | Decorative trim and subdued numbering. |
| `emerald` | `#237046` | Progress and active green structures. |
| `emerald-strong` | `#3b9561` | Completion icon/text with a non-color cue. |
| `emerald-muted` | `#244a34` | Low-intensity completion border or background. |
| `warning` | `#d0a65f` | Upcoming countdowns, partial refresh warning. Warmer/oranger than selection gold. |
| `destructive` | `#dc7e79` | Remove, sign-out warning, error icon/text. |
| `destructive-surface` | `#321616` | Destructive action sheet/button background. |
| `overlay` | `rgb(3 6 4 / 0.82)` | Modal/action-sheet backdrop. |
| `skeleton` | `#172019` | Static loading base. |
| `skeleton-highlight` | `#263128` | Low-contrast shimmer; disabled under reduced motion. |
| `focus-ring` | `#e0c77d` | Two-pixel keyboard focus ring with offset. |
| `selection` | `#d1b86f` | Current navigation marker and selected tab text. |
| `disabled` | `#6f7168` | Disabled icon/border. Text must remain independently legible. |

### State semantics

- **Navigation selection:** gold text plus a small geometric marker and `aria-current`; it is location, not success.
- **Primary action:** aged-gold filled control with dark text. Reserve for the single strongest immediate action.
- **Completion/success:** emerald check/icon, completion copy, and accessible label. A completion surface may remain neutral leather.
- **Warning:** amber-gold with explanatory text/icon. It must not resemble selected navigation or armour trim.
- **Decorative armour trim:** bronze/gold hairlines with no state meaning. Never use it alone to imply selection.
- **Passive forest tonality:** environmental/contextual grouping. It must not imply “complete” without completion language or iconography.
- **Destructive:** muted red plus explicit destructive copy and, where relevant, confirmation. Do not encode it as dark forest with gold.
- **Disabled:** reduced contrast and disabled semantics, but do not drop critical copy below readable contrast.

## C. Material recipes

### Leather card

- Background: `surface-base` plus a faint diagonal `leather-highlight` fading by 30%.
- Border: `border-subtle`.
- Inner highlight: one-pixel top edge only.
- Shadow: 0 8 px 22 px `rgb(0 0 0 / 0.32–0.42)`.
- Gradient: quiet tonal lift, never a visible green wash.
- Corner: 14 px primary radius with one 8–9 px secondary corner.
- Suitable: normal cards, Watching rows, empty/loading containers.
- Unsuitable: selected navigation, destructive confirmation, primary hero emphasis.

### Raised leather panel

- Background: shallow gradient from `#1a211a` to `surface-raised`.
- Border: `border-subtle` or `border-standard` for interactive panels.
- Inner highlight: warm ivory at 5–6% alpha.
- Shadow: 0 12 px 28 px deep black.
- Corner: same family as leather card; do not add more clipping.
- Suitable: grouped settings, season rows, secondary hero copy.
- Unsuitable: every row in a dense list; overuse destroys elevation hierarchy.

### Forest tonal panel

- Background: `forest-tonal-surface` with a restrained emerald radial/linear lift.
- Border: emerald at roughly 25% alpha, not gold.
- Inner highlight: cool-green ivory at no more than 8% alpha.
- Shadow: slightly lower than raised leather.
- Corner: card geometry.
- Suitable: contextual summary, personal insight, “next in line” atmosphere.
- Unsuitable: generic success banners, destructive states, every card on a screen.

### Armour-trimmed control/card

- Background: raised leather.
- Border: `border-standard`.
- Inner highlight: warm top edge.
- Shadow: raised leather shadow.
- Gradient: at most 7–8% gold tint near the emphasized corner.
- Corner treatment: two short 1 px strokes (about 44 px maximum) at one corner; optional clipped secondary corner.
- Suitable: hero summary, primary design signature, rare premium control.
- Unsuitable: repeated list rows, dense metadata, all four corners, disabled control.

### Selected tab

- Background: transparent or an extremely faint gold wash.
- Border/marker: a small diamond or short underline in `selection`.
- Text: `gold-accent-strong`; icon/marker repeats the state.
- Shadow: only a very restrained marker glow, if any.
- Corner: conventional hit area; visible marker may be angular.
- Suitable: current bottom tab or prototype view switcher.
- Unsuitable: completion state or primary action.

### Progress bar

- Track: near-black inset trough with a bronze-alpha border.
- Fill: `emerald` to `emerald-strong` gradient.
- Inner/shadow: inset track depth; fill glow no more than 22% alpha.
- Corner: pill radius is appropriate because the fill is quantitative, not ornamental.
- Suitable: released-episode progress.
- Unsuitable: using gold fill, which would confuse progress with selection/action.

### Dialog/action sheet

- Background: raised leather with a faint armour tint.
- Border: `border-strong`.
- Inner highlight: warm 5% edge.
- Shadow: 0 22 px 60 px black.
- Overlay: `overlay`, no expensive background filter required.
- Corner: 16–18 px upper corners; one restrained clipped corner permitted.
- Suitable: confirmation and actions.
- Unsuitable: full-screen page content or nested decorative frames.

### Poster frame

- Background: `surface-raised` fallback.
- Border: `border-standard`.
- Inner highlight: none over artwork; optional inset hairline must not create seams in clipped rails.
- Shadow: compact deep shadow.
- Corner: 10–12 px primary with 5 px secondary corner.
- Suitable: all poster art, including local placeholders.
- Unsuitable: gold frame thicker than 1 px or elaborate corner ornaments.

### Skeleton

- Background: `skeleton`.
- Highlight: a low-contrast `skeleton-highlight` sweep.
- Border/shadow: none, unless skeleton stands in for an entire card.
- Corner: match the element being represented.
- Suitable: layout-preserving loading state.
- Unsuitable: high-luminance shimmer; animation must collapse under reduced motion.

### Destructive surface

- Background: `destructive-surface`, optionally with an 8% red lift.
- Border: `destructive` at 35–40% alpha.
- Text/icon: light muted red; explicit verb.
- Shadow: neutral black, never red glow.
- Corner: conventional control/card geometry.
- Suitable: Remove, irreversible confirmation, critical error.
- Unsuitable: warning, offline status, sign-out row before the action is invoked.

## D. Geometry system

The existing 10–18 px rounded-card system is usable and coherent, but visually generic. Keep its ergonomic foundation while changing the signature:

- Cards: 14 px main corners, with one or two secondary corners reduced to 8–9 px.
- Compact controls: 11–12 px main corner and a 5–6 px secondary corner.
- Dialogs: 16–18 px; action sheets keep familiar top-corner softness.
- Posters: 10–12 px main radius with a restrained 4–5 px opposing corner.
- Pills: allowed only for chips, countdowns, and progress tracks where the capsule shape has established meaning.
- Armour strokes: one pair of short horizontal/vertical 1 px strokes on hero surfaces. Do not draw a full ornate frame.
- Internal separators: a subtle straight border by default; a single angled end cap may be explored later, but not with CSS clip-path in dense rows.
- Touch controls: the hit box remains rectangular and at least 44 × 44 px regardless of visible corner detail.

Avoid multi-point `clip-path`, SVG masks for ordinary cards, pseudo-element stacks on every row, and bevel effects that require background filters. They are fragile under scrolling, can complicate hit testing, and increase iPhone compositing cost.

## E. Typography direction

Retain **Manrope Variable** as the only font in Phase 0 and likely through the production migration.

Reasons:

- The 24.8 kB local WOFF2 is already packaged and cached by the PWA; there is no network font dependency.
- Manrope remains highly readable at 12–15 px mobile metadata and supports the current 200–800 variable weight range.
- Its clean numerals support large stat totals without introducing a display face.
- Compact headings can gain identity through weight, tighter tracking, warm color, and geometry rather than a fantasy font.
- Small gold labels should use Manrope at 10.5–11 px, weight 700–730, and about `0.12–0.15em` tracking. Do not use them for paragraphs.

Recommended hierarchy:

- Page title: 26–29 px, weight 680–700, `-0.035em` to `-0.045em`.
- Nested title: 24–26 px, weight 680–700.
- Section title: 16–19 px, weight 650–680.
- Show/episode title: 14–15 px, weight 620–650.
- Body: 14–15 px, weight 450–500, line-height 1.5–1.6.
- Metadata: 11.5–13 px, weight 500–560, line-height at least 1.4.
- Large stats: responsive 44–64 px, weight 700, tight tracking, proportional numerals when natural duration rhythm is desired.
- Gold label: 10.5–11 px, weight 720, uppercase, tracked.

No new font dependency is justified for the isolated prototype. Reconsider only if later device testing proves Manrope cannot deliver sufficient editorial contrast without harming compact readability.

## F. Accessibility requirements

- Target WCAG 2.2 AA: at least 4.5:1 for ordinary text and 3:1 for large/bold text and meaningful UI boundaries. Verify alpha-composited values against their actual surfaces.
- Keep primary and secondary text warm and legible; `text-muted` is for truly optional context. Disabled instructions and errors must not use the lowest-contrast token.
- Every keyboard-operable element receives a 2 px `focus-ring` with at least 2 px offset. Focus must remain visible against leather, forest, gold, and destructive surfaces.
- Interactive targets are at least 44 × 44 CSS px. Small visible icons sit inside that hit box.
- Under `prefers-reduced-motion: reduce`, remove decorative transitions, convert shimmer/spinner motion to effectively static states, and preserve all state information.
- Gold versus green cannot be the sole distinction: navigation uses `aria-current` and a marker; completion uses a check and label; progress uses `role="progressbar"` and a value.
- Warning uses warning copy/iconography; destructive uses explicit verbs, red family, and confirmation where impact is material.
- Disabled controls use native `disabled` or `aria-disabled`, suppress interaction, and retain readable adjacent labels.
- Dialogs require `role="dialog"`, `aria-modal`, a labelled title, visible close/cancel controls, focus trapping, and focus return when productionized. The prototype demonstrates semantics, not the final focus-management implementation.
- Status, loading, empty, and error surfaces use appropriate `role="status"`/`role="alert"` and meaningful text. Decorative geometry and icons are hidden from assistive technology.
- Safe-area padding must honor all four `env(safe-area-inset-*)` values; no content-only status should live under the iPhone sensor area or home indicator.

## G. Migration map

| Existing production role/class | Proposed Loki role | Migration posture |
| --- | --- | --- |
| `--color-canvas`, `--color-bg` | `canvas` | Safe direct semantic replacement only after boot/PWA colors migrate atomically. |
| `--canvas-atmosphere` | `canvas-atmosphere` | Visual review required; shared by body and static first paint. |
| `--color-canvas-elevated` | `canvas-deep` or `surface-base` | Review each use; current name mixes elevation and canvas. |
| `--color-surface` | `surface-base` | Broad candidate, but validate poster fallbacks, tab bar, and rows separately. |
| `--color-surface-raised` | `surface-raised` | Broad candidate; skeleton/detail placeholders need contrast review. |
| `--color-surface-interactive` | `surface-interactive` | Safe role mapping. |
| `--color-surface-pressed` | `surface-pressed` | Safe role mapping; preserve touch-intent behavior. |
| `--color-border-subtle/border/border-strong` | matching border roles | Direct semantic mapping after contrast/device review. |
| `--color-text` | `text-primary` | Safe role mapping. |
| `--color-text-secondary` | `text-secondary` | Review compact metadata contrast. |
| `--color-text-muted` | `text-muted` | Review disabled, placeholders, and future episode rows; do not migrate mechanically. |
| `--color-accent` | split among `gold-accent`, `selection`, `emerald` | High risk. Current blue handles navigation, links, progress, focus, and insights structure. Split by meaning. |
| `--color-accent-strong` | `gold-accent-strong` or `focus-ring` | High risk; inspect every focus/link/label use. |
| `--color-accent-muted` | gold wash or forest tonal lift | No mechanical replacement. |
| `--color-violet-muted` | forest atmosphere | Remove only after Insights and canvas recipes are rebuilt. |
| `--color-success` | `emerald-strong` | Semantically close, but banner/background and completion control differ. |
| `--color-status-check-done` | completion glyph token | Preserve its glyph-only behavior; do not turn the whole status control green. |
| `--color-status-check-idle` | neutral status icon | Map to readable stone/bronze-neutral, not gold selection. |
| `--color-warning`, `--color-upcoming` | `warning` | Safe role mapping; keep compatibility alias during migration. |
| `--color-destructive` | `destructive` | Safe role mapping with contrast review. |
| `--color-overlay` | `overlay` | Direct role mapping. |
| `--color-skeleton*` | `skeleton*` | Direct role mapping; reduced-motion behavior remains protected. |
| `.content-surface`, `.surface-card` | leather card | Shared/risky: routes may need raised, forest, or armour recipe instead. |
| `.content-row`, `.surface-group` | base/raised leather group | Review density and separator ownership. |
| `.poster-card`, `.progressive-image` | poster frame | Preserve image loading and Insights seam exceptions. |
| `.progress-track/.progress-fill` | progress recipe | Fill should become emerald, not selection gold. |
| `.app-tab-bar` and active Tailwind color | selected tab | Preserve routing, mounted subtree, bottom safe area, and 44 px targets. |
| `.stats-summary` | armour hero | Candidate for rare structural trim; do not copy its current violet gradients mechanically. |
| `.stats-insight` | forest tonal panel | Good semantic fit after contrast review. |
| `.stats-all-preview*` | Loki-styled poster rail | Style only. Protected 3-full + partial-fourth geometry, 52 px reveal, literal `>>`, target, stacking, and routing are immutable. |
| `.watching-status-button*` | neutral leather status control | Preserve fixed graphite-like body and glyph-only state changes. |
| `.watching-remove-surface` | destructive surface | Direct recipe candidate; preserve swipe behavior and compositing. |
| `.settings-status*`, `.status-banner*` | semantic status surfaces | Split success/warning/destructive; never inherit forest tonality without status cues. |
| `.focus-ring` and global `:focus-visible` | `focus-ring` | Direct semantic mapping; verify on every surface. |
| `index.html` literals, PWA theme/background, icons | launch identity migration | Must move together in a dedicated later phase to prevent blue/green launch flashes. |

### Compatibility aliases

Keep `--color-bg`, `--color-upcoming`, and `--color-upcoming-muted` until every consumer is migrated. Introduce Loki semantics alongside existing variables, then redirect aliases only after route-by-route review. Avoid assigning a new gold value directly to `--color-accent`; that one operation would silently recolor links, focus, progress, navigation, Stats, and unrelated actions.

### Places that must not migrate mechanically

- Watching quick-mark status button, accepted-green dwell, swipe surfaces, and press-intent behavior.
- Insights compact All preview geometry and interaction contract.
- Static boot/auth shell, PWA theme color, generated manifest, and public icons.
- Inline progress widths (behavioral data); only the class recipe may change.
- Future/unreleased episode opacity and disabled controls.
- Action sheets, reload prompts, offline states, and auth screens where status semantics differ.
- Any protected release, timezone, mutation, cache, navigation, notification, or mounted-state logic.

## Prototype acceptance questions for Vijay

1. Is the canvas warm/green enough, or should the forest atmosphere recede further toward neutral black?
2. Does the asymmetrical 14 px/8 px corner family feel distinctive without reading as decorative fantasy UI?
3. Should primary action remain gold-filled, or should it use forest fill with a gold armour edge?
4. Is emerald progress sufficiently separate from completion and from passive forest panels?
5. Is the amount of gold on hero cards appropriate, especially the short corner strokes?
6. Does Manrope gain enough identity through tracking, weight, and material styling, or should a later isolated study evaluate a second locally hosted display face?
