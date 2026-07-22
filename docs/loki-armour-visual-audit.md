# Rerun visual audit — Loki Armour Phase 0A

Audit baseline: `origin/main` at `2981bdec603b15eb219b7020bd399559eb5a3fb3` on 22 July 2026. Repository default branch is `main`; no PR was open at implementation start. This audit covers source, route/component JSX, static HTML, PWA configuration, public/design SVG assets, loading states, and visual tests. Generated `dist/` and third-party `node_modules/` are excluded as authored sources.

## Executive summary

The current visual identity is a cool cinematic midnight system: blue-black canvas, slate-blue surfaces, periwinkle accent, violet Stats atmosphere, cool blue-grey copy, rounded cards, and blue launch glow. Its semantic foundation is mostly centralized, but `--color-accent` currently carries too many meanings: primary action, link, focus, navigation selection, progress, and decorative insight structure. A Loki migration must split those meanings before changing values.

Visual sources are not limited to `src/index.css`. Critical duplication and exceptions exist in:

- `index.html`: first-paint canvas, text, icon gradients, launch glow, theme meta color, radii.
- `vite/pwa-options.js`: manifest theme/background colors.
- `public/*.svg` and `design/*.svg`: cool background/mark gradients, border, blue glow.
- route/component Tailwind classes: semantic CSS-variable utilities, opacity, radius, border, and sizing decisions.
- component-specific JSX: inline progress width, conditional opacity/style, image aspect ratios, animation utilities, disabled semantics.
- screenshots/icons generated from PNG assets: current launch identity remains blue.

## Global foundation

### Color tokens

`src/index.css @theme` defines:

- Canvas: `#080b14`, elevated `#0c1120`.
- Surfaces: `#111827`, raised `#172033`, interactive `#1c2940`, pressed `#202e48`.
- Borders: slate `rgb(148 163 184 / 0.12, 0.18, 0.26)`.
- Text: `#f1f3f8`, secondary `#a9b2c4`, muted `#8f9bb0`.
- Blue accents: `#7297ff`, strong `#8ba8ff`, muted blue at 14% alpha.
- Violet: `rgb(139 120 255 / 0.11)`.
- Semantic states: success `#72c9a4`, warning `#e1ad68`, destructive `#f0808a`, each with a 12% tint.
- Watching status glyphs: idle `#8d93b4`, completed pistachio `#a7e85b`.
- Overlay: `rgb(3 6 14 / 0.76)`.
- Skeleton: `#151e30` and `#202d45`.
- Compatibility aliases: `--color-bg`, `--color-upcoming`, `--color-upcoming-muted`.

The body atmosphere contains blue and violet radial gradients at the upper edges, a dark-blue lower radial field, and a blue-black bottom fade. Shadows consistently use `rgb(3 6 14 / …)`, retaining a cool cast even when surface tokens change.

### Typography

- Local `Manrope Variable`, weights 200–800, `font-display: swap`, one Latin WOFF2.
- System fallbacks: system UI, Apple system, BlinkMacSystemFont, Segoe UI, sans-serif.
- Display: `clamp(36px, 10vw, 48px)`, weight 700, tight `-0.045em` tracking.
- Page/nested titles: 26 px; section 19 px; show/episode/body 15 px; metadata 13 px; caption/navigation 12 px; badge 11 px.
- Weight roles: heading 680, section 650, show/navigation 620, body 450, metadata 500.
- Numeric helpers use tabular numerals; Stats duration deliberately uses proportional numerals.
- Route JSX also contains local `text-sm`, `text-base`, `font-medium`, `font-semibold`, and `font-bold` utilities, so not all type follows role classes.

### Geometry, spacing, elevation, and motion

- Radii: poster/control 12 px; card 14 px; group 16 px; compact 10 px; overlay 18 px; several local `rounded-md/lg/xl/full` utilities and fixed 6 px focus corner.
- Elevation: raised 0 8 px 24 px; interactive 0 4 px 16 px; overlay 0 20 px 60 px; bottom navigation 0 -8 px 28 px plus hairline.
- Spacing tokens: 4, 8, 12, 16, 20, 24, and 32 px. Tailwind route utilities add local variations.
- Press: 140 ms scale to 0.98 plus opacity 0.9, gated by the custom touch-intent attribute; mouse uses native `:active`.
- Route/banner motion: 220–300 ms fades/translations. Progressive images fade in. Auth mark settles over 420 ms.
- Reduced motion globally collapses animation/transition duration, removes press scale/opacity, route animation, and image transition.

### Focus, selection, disabled, and status

- Global focus uses a 2 px `accent-strong` outline with 2 px offset; several components add local focus handling.
- Navigation selection is blue text plus `aria-current` but no separate shape/icon marker.
- Disabled state is usually `disabled:opacity-60`; future episode rows use reduced opacity. Some status controls keep fixed surface and dim only the glyph.
- Success/warning/destructive banners combine tinted background, related border, and colored text.
- Dashed border and muted centered copy define generic empty states.
- Skeletons use cool slate blocks; some route skeletons use Tailwind `animate-pulse` instead of the shared skeleton class.

## Shell and navigation

- `body` owns the blue/violet atmosphere; `.app-shell` is capped at 42 rem and reserves tab-bar plus bottom safe area.
- `.app-page` begins at the larger of 16 px or top safe area. Nested pages use top safe area plus 16 px.
- `GlobalTopScrim` uses fixed, blurred/masked dark treatment to protect the iPhone status bar.
- `TabBar` is fixed, surface-blue, border-topped, and shadowed; four equal text-only targets. Active is blue; inactive is muted cool grey.
- The persistent Watching subtree, route animation ownership, safe-area sizing, and tab routing are behavioral constraints, not styling cleanup opportunities.

## Watching

- Page uses global canvas and stacked rows. Loading uses dedicated Watching row skeletons.
- `.watching-row-front` sits over a red swipe-to-remove surface; compositing and persistent mounting protect against flashes.
- Rows inherit generic content/card language with rounded corners and a cool-surface background.
- Status control is a fixed 44 × 44 rounded square with hard-coded graphite gradient `#171b25 → #11151e`, white/black inset highlights, and cool shadow.
- Available status uses smoky periwinkle `#8d93b4`; accepted/caught-up uses pistachio `#a7e85b` only on the check and close supporting edge. Not-ready dims the muted glyph.
- Countdown pill uses warning border/tint and pill geometry.
- Partial refresh is warning; load/mutation failures are destructive. Empty states cover no tracked shows and caught-up/no-current queue.
- Inline/utility assumptions include right text reserves for status/remove controls, desktop hover-only remove affordance, touch press intent, and conditional opacity.

## Discover / search

- Search input is a rounded interactive slate surface with cool border; focus changes to blue accent and a blue alpha shadow.
- Placeholder uses muted text. Results use poster frames, content surfaces, primary/secondary buttons, and status banners.
- Browse News inherits shared surfaces and type roles but has article-specific hierarchy and link treatment.
- Browse loading skeletons use cool skeleton tokens and rounded blocks.
- Track/add/remove and retry actions rely on `--color-accent`, warning, or destructive variables via Tailwind arbitrary-variable utilities.

## Show Detail

- Nested safe-area header includes a conventional 44 px back target and cool secondary icon.
- Hero is a generic `.content-surface`: 96 × 128 poster, metadata, inline data-driven progress width, blue progress fill.
- Season rows use `.content-row`, simple separators through card gaps, rounded geometry, muted counts, and a chevron character.
- Bulk season watched controls reuse shared watched semantics; unaired seasons are disabled.
- Cached refresh failure is warning while initial failure is destructive; retry and dismiss targets preserve status semantics.
- Loading uses detail-specific skeleton dimensions plus a raised cool title placeholder.

## Season Detail

- Nested title/back treatment matches Show Detail.
- Episode rows use rounded surfaces, metadata, watched controls, future opacity, and release/countdown text.
- Air-date, IST/release eligibility, watched mutation, optimistic overlay, and cache synchronization are protected logic; only presentational classes may migrate later.
- Future episodes combine muted copy, opacity, and disabled controls; this requires contrast review rather than a blanket token swap.

## Insights

- The summary hero is the most route-specific current composition: blue/violet radial fields, blended muted violet surface, blue-accent border, multiple inner/outer shadows, and an inset frame pseudo-element.
- Insight cards use a violet radial wash, blue-accent blend, blue vertical edge, and raised surface.
- Stats loading mixes shared skeleton colors with rounded Tailwind geometry.
- Error and empty states use shared banner/empty patterns.
- The All preview uses poster surfaces and a hard-coded white literal `#fff` for `>>`, black text shadow, and `rgb(8 10 18 / 0.45)` shade.
- Protected preview behavior: exactly three full posters and 52 px partial fourth, clipped flush edge, darkened partial poster, literal `>>`, localized 44 × 44 link, artwork stacking override, no circle/seam/bottom strip, and only `>>` navigation. Style migration must not alter this structure.

## All Shows

- Three-column poster grid uses poster radius and local action buttons.
- Action sheet has a cool overlay/backdrop, raised surface, border, overlay elevation, and safe-area bottom padding.
- Secondary and destructive actions are semantically distinct; busy state uses opacity.
- Restore/remove confirmation, grid continuation, and `/stats/all` routing are behavioral and protected.

## Settings

- Sections are grouped surfaces with borders/radii and row separators.
- Action rows use interactive/pressed surfaces and 44 px height. Secondary, disabled, and busy variants rely on text tone/opacity.
- Status labels split success, warning, and neutral; banners use the global status recipes.
- Form inputs use interactive surface, global focus ring, primary blue filled submit, bordered cancel, and destructive/success messages.
- Notification, backup/import, verification, password, account, and sign-out states introduce many semantic combinations; they must not become uniformly gold/green.

## Dialogs and action sheets

- `ConfirmDialog` and Stats action sheet use overlay, raised surface, strong-ish border, large radius, deep elevation, 44 px actions, and destructive/secondary variants.
- Close/dismiss affordances commonly use muted text until focus/hover.
- Dialog semantics and focus ownership must be preserved when styling changes.

## Authentication

- Static boot, React boot shell, login, OAuth error, owner rejection, and offline-auth-unavailable states are outside the private app route tree.
- React boot shell mirrors `index.html`: 68 px icon, cool blue drop shadow, cool primary wordmark, safe-area centering, and settle animation.
- Login panel uses global content surfaces/actions/status colors.
- Auth gating and Supabase owner checks are protected. The Loki prototype bypasses the provider only at exact `/dev/loki` in development and performs no auth request.

## Loading and boot

- `index.html` repeats canvas/atmosphere literals to avoid a pre-React flash. It contains `rgba()` syntax while authored CSS primarily uses modern `rgb(... / alpha)`.
- Inline launch SVG uses background gradient `#121726 → #0f1320 → #090c14`, mark gradient `#84a7ff → #4f7dff → #1f5cff`, 230 px icon radius, and blue drop shadow.
- Shared skeletons, route-specific skeleton components, Tailwind `animate-pulse`, image placeholders, and progressive-image transitions form multiple loading dialects.
- A production migration must update HTML, CSS, icon assets, and manifest atomically; Phase 0A changes none of them.

## Offline, reload, and PWA

- Manifest and browser theme/background are `#080b14` in `vite/pwa-options.js`; HTML theme meta matches.
- Reload prompt uses shared overlay/surface/action tokens and owns PWA update behavior.
- Offline auth/data recovery uses warning/destructive banners and cached-content fallbacks.
- Public PNG icons and SVG favicon/Rerun icon remain blue; SVGs repeat the cool gradients, `#263149` border, and `#285dff` glow.
- Workbox runtime image caching affects remote TMDB artwork but is not a visual styling source. Reload/update ownership and network recovery are protected.

## Miscellaneous components

- `ProgressiveImage`: cool surface placeholder/fallback, inset hairline, fade-in transition, local aspect/radius from callers.
- `WatchedCircle`: success/accent/disabled assumptions and 44 px interaction semantics.
- `ConfirmDialog`: shared status/action recipes.
- `NotFound`: global muted copy and accent link within normal shell/navigation.
- `GlobalTopScrim`: mask gradients, blur, fixed layering, and safe-area behavior.
- Public/design SVG icons: literal fills/strokes/gradients; PNG versions are generated derivatives.
- Inline styles: route visibility (`display:none`), progress width percentages, swipe transforms/layers, and loading/image behavior. Behavioral inline styles must not be extracted during visual migration.

## Literal and utility classification

### Hard-coded colors outside the main token block

- Static first paint and icon palette in `index.html`.
- Icon palette in `public/favicon.svg`, `public/rerun-icon.svg`, and `design/rerun-icon-approved*.svg`.
- Stats preview `#fff`, black shadow, and dark shade.
- Watching status graphite gradient, inset white/black highlights, shadows, and deep garnet mix base `#2a0a10`.
- Blue/violet atmosphere, Stats hero/insight radial fields, white inset highlights, and dark elevation values throughout `src/index.css`.

### Tailwind color utilities

Routes predominantly use CSS-variable arbitrary utilities such as `text-(--color-text)`, `bg-(--color-accent)`, `border-(--color-border)`, opacity variants, and state modifiers. This is better than independent literals but still binds many meanings to `accent`. Layout utilities also encode visual assumptions through rounding, opacity, aspect ratios, widths, and shadows.

### SVG/icon color behavior

Most component SVGs use `currentColor`, making their parent semantic role migratable. Brand/launch SVGs use literal gradients and must be redesigned as assets, not recolored by global CSS.

## Migration risk summary

- **Low risk after contrast validation:** text-primary, surface-interactive, pressed, warning, destructive, overlay, skeleton role-for-role changes.
- **Medium risk:** base/raised surfaces, borders, muted text, generic cards/groups, poster frames, form fields, empty states.
- **High risk:** `accent` split, body atmosphere, navigation, focus, Stats compositions, static boot/PWA/icon identity, Watching status controls, Insights preview exceptions.
- **Never mechanical:** protected data/release/mutation/cache/navigation/PWA behavior and any inline style that carries state or geometry rather than color.

## Phase 0A isolation confirmation

The prototype adds its own `.loki-prototype` semantic variables, local SVG fixtures, and static presentational components. It does not import Supabase, TMDB, TVmaze, News, notifications, Watching/Detail production components, or mutation helpers. It is absent from `TabBar`, gated by `import.meta.env.DEV` plus exact path matching, and does not change current production tokens or protected logic.
