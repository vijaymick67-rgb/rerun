// Trailer normalization, deduplication and ranking (Scope J + K).
//
// After trailerFilter accepts individual videos, this module:
//   - builds the stable public trailer model (with a watch?v= YouTube URL, never
//     an embed URL, so a card tap can hand off to the YouTube app on iOS),
//   - deduplicates (exact YouTube key first, then obvious dubbed/regional
//     reposts), while keeping genuinely distinct cuts (teaser vs trailer vs
//     final trailer) separate,
//   - ranks deterministically,
//   - selects at most a handful of the most relevant videos per media item so
//     the feed is not flooded.

export function youtubeUrl(key) {
  return key ? `https://www.youtube.com/watch?v=${key}` : null
}

function normalizeName(name) {
  return typeof name === 'string' ? name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ') : ''
}

// Which distinct cut a video represents. Distinct cuts are NOT collapsed
// together; everything within one cut for one media/season is a duplicate.
export function trailerVariant(video) {
  const name = normalizeName(video.name)
  if (/\bfinal\b/.test(name)) return 'final'
  if (video.type === 'Teaser' || /\bteaser\b/.test(name)) return 'teaser'
  return 'trailer'
}

// Build the public trailer model from a TMDB video record plus its media
// context (the tracked show / franchise item it was fetched for).
export function buildTrailer(video, context = {}) {
  return {
    id: `trailer:${video.key}`,
    mediaType: context.mediaType ?? 'tv',
    mediaId: context.mediaId ?? null,
    trackedShowId: context.trackedShowId ?? null,
    title: context.title ?? null,
    seasonNumber: context.seasonNumber ?? null,
    posterPath: context.posterPath ?? null,
    backdropPath: context.backdropPath ?? null,
    videoKey: video.key,
    youtubeUrl: youtubeUrl(video.key),
    videoType: video.type ?? null,
    videoName: video.name ?? null,
    official: video.official === true,
    language: video.iso_639_1 ?? null,
    publishedAt: video.published_at ?? null,
    releaseDate: context.releaseDate ?? context.firstAirDate ?? null,
    franchise: context.franchise ?? null,
    variant: trailerVariant(video),
    size: Number.isFinite(video.size) ? video.size : 0,
  }
}

function publishedMs(trailer) {
  const value = Date.parse(trailer.publishedAt)
  return Number.isFinite(value) ? value : 0
}

function languageRank(trailer) {
  // English or language-neutral first, then everything else.
  return trailer.language === 'en' || trailer.language == null || trailer.language === '' ? 0 : 1
}

// Deterministic best-first comparison for two trailers of the same media item.
export function compareTrailers(a, b) {
  if (a.official !== b.official) return a.official ? -1 : 1
  const lang = languageRank(a) - languageRank(b)
  if (lang) return lang
  const published = publishedMs(b) - publishedMs(a)
  if (published) return published
  // Trailer before Teaser only when equally recent/relevant (reached here).
  const variantRank = (v) => (v === 'trailer' ? 0 : v === 'final' ? 1 : 2)
  const variantDelta = variantRank(a.variant) - variantRank(b.variant)
  if (variantDelta) return variantDelta
  if (a.size !== b.size) return b.size - a.size // higher resolution
  return String(a.videoKey).localeCompare(String(b.videoKey)) // stable
}

// A cluster is one distinct cut of one media/season. Dubbed/regional reposts of
// the same cut share a cluster key and collapse to the best-ranked one.
function clusterKey(trailer) {
  return [trailer.mediaType, trailer.mediaId, trailer.seasonNumber ?? '-', trailer.variant].join('|')
}

export function dedupeTrailers(trailers) {
  // 1) exact YouTube key.
  const byKey = new Map()
  for (const trailer of Array.isArray(trailers) ? trailers : []) {
    if (!trailer?.videoKey) continue
    if (!byKey.has(trailer.videoKey)) byKey.set(trailer.videoKey, trailer)
  }
  // 2) same cut / media / season -> keep best-ranked (collapses dubbed +
  //    regional reposts, keeps distinct cuts).
  const byCluster = new Map()
  for (const trailer of byKey.values()) {
    const key = clusterKey(trailer)
    const existing = byCluster.get(key)
    if (!existing || compareTrailers(trailer, existing) < 0) byCluster.set(key, trailer)
  }
  return [...byCluster.values()]
}

// Per media item, expose at most: the latest official Trailer, a meaningfully
// distinct latest Teaser, and a Final Trailer when it is distinct and newer than
// the main trailer.
export function selectPerMedia(trailers) {
  const groups = new Map()
  for (const trailer of dedupeTrailers(trailers)) {
    const groupKey = [trailer.mediaType, trailer.mediaId, trailer.seasonNumber ?? '-'].join('|')
    if (!groups.has(groupKey)) groups.set(groupKey, [])
    groups.get(groupKey).push(trailer)
  }
  const selected = []
  for (const group of groups.values()) {
    group.sort(compareTrailers)
    const trailer = group.find((t) => t.variant === 'trailer')
    const teaser = group.find((t) => t.variant === 'teaser')
    const finalTrailer = group.find((t) => t.variant === 'final')
    if (trailer) selected.push(trailer)
    if (teaser) selected.push(teaser)
    // Final trailer only when distinct and newer than the main trailer.
    if (finalTrailer && (!trailer || publishedMs(finalTrailer) > publishedMs(trailer))) {
      selected.push(finalTrailer)
    }
  }
  return selected
}

// Full pipeline: build models, filter is applied upstream, then dedupe+select,
// then a final global ranking (freshest, most relevant first).
export function rankTrailers(trailers) {
  return selectPerMedia(trailers).sort((a, b) => {
    if (a.official !== b.official) return a.official ? -1 : 1
    const published = publishedMs(b) - publishedMs(a)
    if (published) return published
    return String(a.videoKey).localeCompare(String(b.videoKey))
  })
}
