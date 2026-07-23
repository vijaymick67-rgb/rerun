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
import { fetchMediaVideos, fetchDiscover, mapWithConcurrency, DEFAULT_CONCURRENCY } from './tmdbVideos.js'
import {
  FRANCHISE, buildDiscoverParams, classifyFranchiseMedia, isMarvelDcEnabled,
} from './marvelDcCatalogue.js'

export const NEWS_ENDPOINT = '/api/news?limit=10'

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

// ---- Announcements -------------------------------------------------------
export async function loadAnnouncements({
  trackedShows = [], detailsById = {}, storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch, now = Date.now(),
} = {}) {
  const cached = readAnnouncementsCache(storage, now)
  const registry = buildIdentityRegistry(trackedShows, detailsById)
  try {
    const response = await fetchImpl(NEWS_ENDPOINT, { headers: { Accept: 'application/json' } })
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
  // Guarded: the Marvel/DC exception stays OFF until company ids are verified
  // live (honest default). isMarvelDcEnabled() returns false in this build.
  if (!isMarvelDcEnabled()) return []
  const collected = []
  for (const franchise of [FRANCHISE.MARVEL, FRANCHISE.DC]) {
    for (const mediaType of ['tv', 'movie']) {
      const query = buildDiscoverParams({ franchise, mediaType })
      if (!query) continue
      const items = await fetchDiscover(query.path, query.params, fetchOptions)
      const confirmed = items.map((item) => classifyFranchiseMedia(item, franchise)).filter(Boolean)
      const withVideos = await mapWithConcurrency(confirmed, async (item) => {
        const videos = await fetchMediaVideos(mediaType, item.id, fetchOptions)
        const context = {
          mediaType, mediaId: item.id, trackedShowId: null,
          title: item.name ?? item.title ?? null, posterPath: item.poster_path ?? null, franchise,
        }
        return (Array.isArray(videos) ? videos : [])
          .filter((video) => classifyVideo(video).accepted)
          .map((video) => buildTrailer(video, { ...context, seasonNumber: seasonFromName(video.name) }))
      }, fetchOptions.concurrency ?? DEFAULT_CONCURRENCY)
      for (const list of withVideos) if (Array.isArray(list)) collected.push(...list)
    }
  }
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
