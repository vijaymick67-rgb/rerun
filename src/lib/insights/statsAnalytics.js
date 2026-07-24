import { episodeKey } from '../watchHelpers.js'

// This remains the final step in Stats' long-standing runtime fallback chain:
// episode runtime -> show average runtime -> 45 minutes.
export const DEFAULT_EPISODE_RUNTIME_MINUTES = 45

export function averageRunTime(episodeRunTime) {
  const values = (episodeRunTime ?? []).filter(
    (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
  )
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function episodeRuntimeMinutes(episodeRuntime, showRunTimeAverage) {
  if (
    typeof episodeRuntime === 'number' &&
    Number.isFinite(episodeRuntime) &&
    episodeRuntime > 0
  ) {
    return episodeRuntime
  }
  if (
    typeof showRunTimeAverage === 'number' &&
    Number.isFinite(showRunTimeAverage) &&
    showRunTimeAverage > 0
  ) {
    return showRunTimeAverage
  }
  return DEFAULT_EPISODE_RUNTIME_MINUTES
}

function uniqueNames(values) {
  const names = []
  const seen = new Set()
  for (const value of values ?? []) {
    const name = typeof value === 'string' ? value.trim() : value?.name?.trim()
    if (!name) continue
    const key = name.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

function watchedTimestampRange(rows) {
  let first = null
  let latest = null
  let firstMs = Infinity
  let latestMs = -Infinity

  for (const row of rows ?? []) {
    const ms = new Date(row.watched_at).getTime()
    if (!Number.isFinite(ms)) continue
    if (ms < firstMs) {
      firstMs = ms
      first = row.watched_at
    }
    if (ms > latestMs) {
      latestMs = ms
      latest = row.watched_at
    }
  }

  return { firstWatchedAt: first, latestWatchedAt: latest }
}

function commonFields({ showId, tracked, watchedRows, episodeRuntimes }) {
  const minutes = episodeRuntimes.reduce((sum, runtime) => sum + runtime, 0)
  const { firstWatchedAt, latestWatchedAt } = watchedTimestampRange(watchedRows)
  const distinctWatchedSeasons = new Set(
    watchedRows
      .map((row) => row.season_number)
      .filter((seasonNumber) => Number.isFinite(seasonNumber)),
  ).size

  return {
    tmdb_id: showId,
    name: tracked?.name ?? 'Unknown show',
    poster_path: tracked?.poster_path ?? null,
    finished_at: tracked?.finished_at ?? null,
    hidden_at: tracked?.hidden_at ?? null,
    watchedEpisodeCount: watchedRows.length,
    watchedEpisodeRuntimes: episodeRuntimes,
    averageWatchedEpisodeRuntime:
      episodeRuntimes.length > 0 ? minutes / episodeRuntimes.length : null,
    distinctWatchedSeasons,
    firstWatchedAt,
    latestWatchedAt,
    minutes,
  }
}

export function buildComputedStatsShow({
  showId,
  tracked,
  details,
  watchedRows,
  seasons,
  episodesArrays,
}) {
  const runtimeByKey = new Map()
  seasons.forEach((season, index) => {
    for (const episode of episodesArrays[index]?.episodes ?? []) {
      runtimeByKey.set(
        episodeKey(season.season_number, episode.episode_number),
        episode.runtime,
      )
    }
  })

  const showRunTimeAverage = averageRunTime(details.episode_run_time)
  const watchedEpisodeRuntimes = watchedRows.map((row) => {
    const key = episodeKey(row.season_number, row.episode_number)
    return episodeRuntimeMinutes(runtimeByKey.get(key), showRunTimeAverage)
  })
  const watched = watchedRows.filter((row) =>
    runtimeByKey.has(episodeKey(row.season_number, row.episode_number)),
  ).length
  const total = runtimeByKey.size

  return {
    ...commonFields({
      showId,
      tracked: {
        ...tracked,
        name: tracked?.name ?? details.name ?? 'Unknown show',
        poster_path: tracked?.poster_path ?? details.poster_path ?? null,
      },
      watchedRows,
      episodeRuntimes: watchedEpisodeRuntimes,
    }),
    watched,
    total,
    totalKnownEpisodeCount: total,
    completionRatio: total > 0 ? Math.min(1, watched / total) : null,
    genres: uniqueNames(details.genres),
    networks: uniqueNames(details.networks),
    numberOfSeasons:
      Number.isFinite(details.number_of_seasons) && details.number_of_seasons > 0
        ? details.number_of_seasons
        : seasons.length,
    status: details.status ?? null,
    metadataComplete: true,
  }
}

export function buildFallbackStatsShow({ showId, tracked, watchedRows }) {
  const watchedEpisodeRuntimes = watchedRows.map(
    () => DEFAULT_EPISODE_RUNTIME_MINUTES,
  )
  return {
    ...commonFields({
      showId,
      tracked,
      watchedRows,
      episodeRuntimes: watchedEpisodeRuntimes,
    }),
    watched: watchedRows.length,
    total: watchedRows.length,
    totalKnownEpisodeCount: 0,
    completionRatio: null,
    genres: [],
    networks: [],
    numberOfSeasons: null,
    status: null,
    metadataComplete: false,
  }
}
