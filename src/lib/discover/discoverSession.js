// Discover session cache (memory-only, page-lifetime).
//
// WHY THIS EXISTS
// Discover/Browse lives in the NON-persistent route shell (App.jsx → OtherRoutes,
// keyed by route shell), so leaving Discover for Watching/Insights/Settings
// unmounts it and returning remounts it. On a fresh mount Browse re-runs the
// tracked_shows Supabase read and BrowseDiscover re-runs the full Discover load
// (announcements plan + per-show TMDB videos), and for the brief window while
// tracked_shows is re-loading the feed shows its initial skeleton — so a simple
// tab return feels like a page reload instead of an instant native tab switch.
//
// WHAT THIS DOES (and deliberately does NOT do)
// This is a MEMORY-ONLY cache scoped to a single loaded page. It is NOT a
// persistence layer: the announcement/trailer localStorage caches
// (announcementStore/trailerStore) still own cross-reload persistence, freshness,
// dedup, dismissals, knownKeys/seenKeys and bootstrap. This module only remembers,
// for the lifetime of one page session:
//   1. the last tracked-library snapshot (shows/ids/knownIds) and when it was last
//      authoritatively read from Supabase, so a quick return can seed state
//      synchronously (no skeleton) and skip a duplicate read inside the window;
//   2. when Discover last completed a network refresh for a given tracked-library
//      identity, plus any in-flight refresh promise for that identity, so a quick
//      return (or a tracked_shows re-read that returns the same identity as a new
//      array reference) neither replays the skeleton nor fires duplicate network.
//
// FRESHNESS WINDOW — 60s, and why it is short and safe:
//   * Personal single-user app: the tracked library changes rarely and only via
//     this device's own mutations (add / remove / log-as-watched), which update
//     the snapshot immediately, so the window never hides a change THIS session
//     made.
//   * A cross-session change (another browser) is picked up on the first return
//     after the window expires — 60s is "short-term tab flip", not "indefinitely".
//   * Content the feeds show changes on the order of days (announcement/trailer
//     freshness policies), so a 60s network-refresh coalescing window cannot mask
//     anything the user would otherwise have seen.
//   * When stale, the refresh still runs in the background while the last valid
//     cached content stays on screen (stale-while-revalidate); it never blocks or
//     blanks the surface.
// A longer TTL is intentionally avoided (see the task's "do not choose an
// arbitrary long TTL"): 60s is the smallest window that makes an ordinary
// switch-and-return instant.

export const DISCOVER_SESSION_FRESHNESS_MS = 60_000

// --- Tracked-library snapshot (consumed by Browse) ------------------------
// Content is a mirror of the live tracked-library state; `fetchedAt` is the
// freshness clock and advances ONLY on an authoritative Supabase read (never on
// a mere remount), so flipping between tabs cannot keep the clock perpetually
// fresh and starve the background refresh.
let trackedContent = null // { shows: Array, ids: Set<number>, knownIds: Set<number> }
let trackedFetchedAt = null // epoch ms of the last successful tracked_shows read

export function readTrackedContent() {
  return trackedContent
}

export function writeTrackedContent(content) {
  trackedContent = content
}

export function markTrackedFetched(now = Date.now()) {
  trackedFetchedAt = now
}

export function isTrackedFetchFresh(now = Date.now()) {
  return trackedFetchedAt != null && now - trackedFetchedAt < DISCOVER_SESSION_FRESHNESS_MS
}

// --- Discover refresh gate (consumed by BrowseDiscover) -------------------
// Single-slot: only the CURRENT tracked-library identity matters. When the
// identity changes the previous freshness/in-flight entry is irrelevant and is
// naturally replaced, which also bounds memory.
let discoverRefresh = null // { key, refreshedAt }
let discoverInFlight = null // { key, promise }

export const discoverSession = {
  isDiscoverFresh(key, now = Date.now()) {
    return discoverRefresh != null
      && discoverRefresh.key === key
      && now - discoverRefresh.refreshedAt < DISCOVER_SESSION_FRESHNESS_MS
  },
  markRefreshed(key, now = Date.now()) {
    discoverRefresh = { key, refreshedAt: now }
  },
  getInFlight(key) {
    return discoverInFlight != null && discoverInFlight.key === key
      ? discoverInFlight.promise
      : null
  },
  setInFlight(key, promise) {
    discoverInFlight = { key, promise }
  },
  clearInFlight(key, promise) {
    if (discoverInFlight != null && discoverInFlight.key === key && discoverInFlight.promise === promise) {
      discoverInFlight = null
    }
  },
}

// Cross-route invalidation. Called after any tracked-library mutation (add /
// remove / hide / restore / import), possibly from a route OTHER than Browse
// (e.g. removing a show in Watching). Forces the next Browse visit to re-read
// tracked_shows and lets Discover refresh for the updated identity, so the 60s
// freshness window can never keep showing a stale library after a change made
// elsewhere.
//
// Content is intentionally KEPT: the return still paints instantly from the last
// snapshot while the authoritative re-read runs in the background (the re-read
// updates the tracked-library identity, which in turn drives Discover's own
// refresh). The Discover freshness slot is also cleared so a same-identity edge
// case still re-refreshes; any in-flight request is left to settle and self-clear.
export function invalidateTrackedSession() {
  trackedFetchedAt = null
  discoverRefresh = null
}

// Test-only: restore a clean page-session state.
export function resetDiscoverSession() {
  trackedContent = null
  trackedFetchedAt = null
  discoverRefresh = null
  discoverInFlight = null
}
