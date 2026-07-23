// Exceptional franchise overrides (Scope 7).
//
// The dynamic company-attribution pipeline (franchiseCatalogue.js) is the PRIMARY
// and near-exclusive source of Marvel/DC membership. This module is a very small
// escape hatch for the rare cases where live TMDB metadata is demonstrably wrong
// or incomplete:
//   * includeOverrides — admit a verified franchise title that TMDB does not (yet)
//     attribute to a configured company. Bypasses company confirmation BY DESIGN,
//     so each one carries an explanation + verification date and is expected to be
//     removed once TMDB corrects the attribution.
//   * excludeOverrides — drop a confirmed false positive (a title a verified
//     company is attached to but that is not really a franchise trailer target).
//
// These are EXCEPTIONS, not the catalogue. Ordinary future Marvel/DC projects must
// enter through dynamic company attribution, never by being added here. Both lists
// ship EMPTY. Documentation states they should be pruned periodically.

import { fetchTmdbJson } from './tmdbVideos.js'
import { MEDIA_TYPE } from './franchiseSeeds.js'

// Shape of each override (all fields required for auditability):
//   { mediaType, tmdbId, franchise, explanation, verifiedAt, reason }
// `reason` explains why it cannot currently be represented through the dynamic
// company pipeline (e.g. "TMDB has not yet attached Marvel Studios to this id").
export const INCLUDE_OVERRIDES = Object.freeze([])
export const EXCLUDE_OVERRIDES = Object.freeze([])

function overrideKey(mediaType, tmdbId) { return `${mediaType}:${tmdbId}` }

// Remove any member matching an exclude override. Pure.
export function applyExcludeOverrides(members, excludeOverrides = EXCLUDE_OVERRIDES) {
  const blocked = new Set(
    (Array.isArray(excludeOverrides) ? excludeOverrides : [])
      .map((o) => overrideKey(o.mediaType, o.tmdbId)),
  )
  return (Array.isArray(members) ? members : []).filter(
    (m) => !blocked.has(overrideKey(m.mediaType, m.mediaId)),
  )
}

// Resolve include overrides into membership records by fetching each title's
// detail (for poster/date metadata). An include override is a VERIFIED exception,
// so it is admitted without the company-confirmation gate — but it still must
// resolve to a real TMDB title, and it records that it came from an override.
export async function resolveIncludeOverrides({
  includeOverrides = INCLUDE_OVERRIDES, now = Date.now(), fetchOptions = {},
} = {}) {
  const list = Array.isArray(includeOverrides) ? includeOverrides : []
  const members = []
  for (const o of list) {
    if (!o || (o.mediaType !== MEDIA_TYPE.MOVIE && o.mediaType !== MEDIA_TYPE.TV)) continue
    const type = o.mediaType === MEDIA_TYPE.MOVIE ? 'movie' : 'tv'
    const detail = await fetchTmdbJson(`/${type}/${o.tmdbId}`, { ...fetchOptions, ttlMs: fetchOptions.detailTtlMs })
    if (!detail || !Number.isFinite(detail.id)) continue
    members.push(Object.freeze({
      mediaType: o.mediaType,
      mediaId: detail.id,
      title: o.mediaType === MEDIA_TYPE.MOVIE ? (detail.title ?? detail.original_title ?? null)
        : (detail.name ?? detail.original_name ?? null),
      posterPath: detail.poster_path ?? null,
      backdropPath: detail.backdrop_path ?? null,
      releaseDate: o.mediaType === MEDIA_TYPE.MOVIE ? (detail.release_date ?? null) : null,
      firstAirDate: o.mediaType === MEDIA_TYPE.TV ? (detail.first_air_date ?? null) : null,
      franchise: o.franchise,
      matchedCompanyIds: [],
      verifiedAt: new Date(now).toISOString(),
      viaOverride: true,
    }))
  }
  return members
}
