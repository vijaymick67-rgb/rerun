// Discover engine orchestration (Scope M, N, P) — the compatibility boundary
// between the new precision engine and the (Phase 2) Discover UI.
//
// Two independent product feeds are assembled here: Announcements and Trailers.
// They fail INDEPENDENTLY (Scope P): one feed erroring never erases the other's
// valid cached items, and a background-refresh failure preserves usable cache.
//
// This module intentionally does NOT render anything and does not touch the
// legacy news UI. It is the clean seam a Phase 2 Discover page will consume.

import { buildIdentityRegistry } from './identities.js'
import { classifyAnnouncement } from './announcementClassifier.js'
import { normalizeAnnouncement } from './announcementNormalizer.js'
import { dedupeAnnouncements } from './announcementDedup.js'
import { readAnnouncementsCache, writeAnnouncementsCache, mergeAnnouncements } from './announcementStore.js'
import { classifyVideo } from './trailerFilter.js'
import { buildTrailer, rankTrailers } from './trailerRank.js'
import { readTrailersCache, writeTrailersCache, mergeTrailers } from './trailerStore.js'
import { fetchMediaVideos, mapWithConcurrency, DEFAULT_CONCURRENCY } from './tmdbVideos.js'
import { catalogueTargets, isMarvelDcEnabled } from './marvelDcCatalogue.js'

// Dedicated announcements acquisition endpoint (see api/discover/announcements.js).
// It runs bounded, batched, event-scoped per-show searches — NOT the generic
// /api/news sample — so the classifier gets real per-show candidates.
export const ANNOUNCEMENTS_ENDPOINT = '/api/discover/announcements'
// How many verified alternative titles per show we ask the endpoint to search.
export const MAX_REQUEST_ALIASES = 2

export function emptyFeedState() {
  return { items: [], loading: false, refreshing: false, error: null, lastSuccess: null }
}

export function emptyDiscoverState() {
  return { announcements: emptyFeedState(), trailers: emptyFeedState() }
}

function seasonFromName(name) {
  const match = typeof name === 'string' && name.match(/season (\d{1,2})/i)
  return match ? Number(match[1]) : null
}

// Derive the bounded per-show search terms the acquisition endpoint needs from
// the identity registry: canonical title + a capped number of VERIFIED
// alternative titles (never invented aliases).
function announcementRequestShows(registry) {
  return registry.list.map((identity) => ({
    id: identity.tmdbId,
    title: identity.canonicalTitle,
    aliases: (identity.alternativeTitles ?? []).slice(0, MAX_REQUEST_ALIASES),
  }))
}

// ---- Announcements -------------------------------------------------------
export async function loadAnnouncements({
  trackedShows = [], detailsById = {}, storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch, now = Date.now(),
} = {}) {
  const cached = readAnnouncementsCache(storage, now)
  const registry = buildIdentityRegistry(trackedShows, detailsById)
  try {
    const response = await fetchImpl(ANNOUNCEMENTS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ shows: announcementRequestShows(registry) }),
    })
    if (!response?.ok) throw new Error('announcements_source_unavailable')
    const payload = await response.json()
    const articles = Array.isArray(payload?.articles) ? payload.articles : []
    const normalized = []
    for (const article of articles) {
      const result = classifyAnnouncement(article, registry, { now })
      if (!result.accepted) continue
      const identity = registry.byId.get(result.showId)
      const announcement = normalizeAnnouncement(result, article, identity)
      if (announcement) normalized.push(announcement)
    }
    const deduped = dedupeAnnouncements(normalized)
    const merged = mergeAnnouncements(cached, deduped, now)
    writeAnnouncementsCache(merged, storage, now)
    return { items: merged.items, loading: false, refreshing: false, error: null, lastSuccess: now }
  } catch (error) {
    // Failure isolation: keep whatever valid items the cache already holds.
    return {
      items: cached.items,
      loading: false,
      refreshing: false,
      error: error?.message ?? 'announcements_error',
      lastSuccess: cached.lastSuccess,
    }
  }
}

// ---- Trailers ------------------------------------------------------------
function trailersForShow(show, videos) {
  const context = {
    mediaType: 'tv',
    mediaId: show.tmdb_id ?? show.id,
    trackedShowId: show.tmdb_id ?? show.id,
    title: show.name ?? show.title ?? null,
    posterPath: show.poster_path ?? null,
  }
  const built = []
  for (const video of Array.isArray(videos) ? videos : []) {
    if (!classifyVideo(video).accepted) continue
    built.push(buildTrailer(video, { ...context, seasonNumber: seasonFromName(video.name) }))
  }
  return built
}

async function franchiseTrailers(fetchOptions) {
  // The Marvel/DC exception is an EXPLICIT media-id allowlist (see
  // marvelDcCatalogue.js) — membership is per-title, so it cannot pull unrelated
  // Disney/Warner catalogues. Each target's videos go through the SAME strict
  // trailerFilter (classifyVideo) + trailerRank pipeline as tracked shows.
  if (!isMarvelDcEnabled()) return []
  const targets = catalogueTargets()
  const perTarget = await mapWithConcurrency(targets, async (target) => {
    const videos = await fetchMediaVideos(target.mediaType, target.id, fetchOptions)
    const context = {
      mediaType: target.mediaType, mediaId: target.id, trackedShowId: null,
      title: target.title, posterPath: null, franchise: target.franchise,
    }
    return (Array.isArray(videos) ? videos : [])
      .filter((video) => classifyVideo(video).accepted)
      .map((video) => buildTrailer(video, { ...context, seasonNumber: seasonFromName(video.name) }))
  }, fetchOptions.concurrency ?? DEFAULT_CONCURRENCY)
  const collected = []
  for (const list of perTarget) if (Array.isArray(list)) collected.push(...list)
  return collected
}

export async function loadTrailers({
  trackedShows = [], storage = globalThis.localStorage, fetchImpl = globalThis.fetch,
  now = Date.now(), concurrency = DEFAULT_CONCURRENCY,
} = {}) {
  const cached = readTrailersCache(storage)
  const fetchOptions = { storage, fetchImpl, now, concurrency }
  try {
    const perShow = await mapWithConcurrency(
      trackedShows,
      async (show) => trailersForShow(show, await fetchMediaVideos('tv', show.tmdb_id ?? show.id, fetchOptions)),
      concurrency,
    )
    const collected = []
    for (const list of perShow) if (Array.isArray(list)) collected.push(...list)
    collected.push(...await franchiseTrailers(fetchOptions))

    const ranked = rankTrailers(collected)
    const merged = mergeTrailers(cached, ranked, { now })
    writeTrailersCache(merged, storage)
    return { items: merged.items, loading: false, refreshing: false, error: null, lastSuccess: now }
  } catch (error) {
    return {
      items: cached.items,
      loading: false,
      refreshing: false,
      error: error?.message ?? 'trailers_error',
      lastSuccess: cached.lastSuccess,
    }
  }
}

// Load both feeds with independent error isolation (Scope P). A rejection in one
// never affects the other because each loader already catches internally.
export async function loadDiscover(options = {}) {
  const [announcements, trailers] = await Promise.all([
    loadAnnouncements(options),
    loadTrailers(options),
  ])
  return { announcements, trailers }
}
