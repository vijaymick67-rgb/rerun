export const UNCLASSIFIED_GENRE = 'Unclassified'
export const OTHER_GENRE = 'Other'
export const GENRE_ORBIT_MAX_PRIMARY = 5
export const UNCLASSIFIED_VISIBLE_PERCENT = 5
export const GENRE_COLOR_COUNT = 8

function stableHash(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function genreColorIndex(genre) {
  return stableHash((genre || UNCLASSIFIED_GENRE).trim().toLocaleLowerCase()) %
    GENRE_COLOR_COUNT
}

function compareGenreEntries(left, right) {
  const minuteDifference = right.minutes - left.minutes
  if (Math.abs(minuteDifference) > Number.EPSILON) return minuteDifference
  return left.genre.localeCompare(right.genre, undefined, { sensitivity: 'base' })
}

export function roundGenrePercentages(entries, totalMinutes) {
  if (!(totalMinutes > 0) || entries.length === 0) return []

  const calculated = entries.map((entry) => {
    const percentage = (entry.minutes / totalMinutes) * 100
    return {
      ...entry,
      percentage,
      displayPercentage: Math.floor(percentage),
      remainder: percentage - Math.floor(percentage),
    }
  })
  let remaining = 100 - calculated.reduce(
    (sum, entry) => sum + entry.displayPercentage,
    0,
  )

  const remainderOrder = [...calculated].sort((left, right) => {
    if (Math.abs(right.remainder - left.remainder) > Number.EPSILON) {
      return right.remainder - left.remainder
    }
    return left.genre.localeCompare(right.genre, undefined, { sensitivity: 'base' })
  })
  for (let index = 0; index < remaining; index += 1) {
    remainderOrder[index % remainderOrder.length].displayPercentage += 1
  }

  return calculated.map(({ remainder: _remainder, ...entry }) => entry)
}

function validGenreNames(genres) {
  const result = []
  const seen = new Set()
  for (const value of genres ?? []) {
    const name = typeof value === 'string' ? value.trim() : value?.name?.trim()
    if (!name) continue
    const key = name.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(name)
  }
  return result
}

export function buildGenreDistribution(shows) {
  const byGenre = new Map()
  let totalMinutes = 0
  let totalEpisodeEquivalent = 0

  for (const show of shows ?? []) {
    const runtimes = (show.watchedEpisodeRuntimes ?? []).filter(
      (runtime) => typeof runtime === 'number' && Number.isFinite(runtime) && runtime > 0,
    )
    if (runtimes.length === 0) continue

    const genreNames = validGenreNames(show.genres)
    const allocatedGenres = genreNames.length > 0 ? genreNames : [UNCLASSIFIED_GENRE]
    const genreDivisor = allocatedGenres.length

    for (const runtime of runtimes) {
      totalMinutes += runtime
      totalEpisodeEquivalent += 1
      for (const genre of allocatedGenres) {
        let entry = byGenre.get(genre)
        if (!entry) {
          entry = {
            genre,
            minutes: 0,
            watchedEpisodeEquivalent: 0,
            showIds: new Set(),
          }
          byGenre.set(genre, entry)
        }
        entry.minutes += runtime / genreDivisor
        entry.watchedEpisodeEquivalent += 1 / genreDivisor
        entry.showIds.add(show.tmdb_id)
      }
    }
  }

  if (totalMinutes === 0) {
    return { entries: [], totalMinutes: 0, totalEpisodeEquivalent: 0 }
  }

  const sorted = [...byGenre.values()]
    .map((entry) => ({
      ...entry,
      showIds: [...entry.showIds].sort((left, right) => left - right),
      showCount: entry.showIds.size,
    }))
    .sort(compareGenreEntries)
  const rounded = roundGenrePercentages(sorted, totalMinutes).map((entry, index) => ({
    ...entry,
    rank: index + 1,
    colorIndex: genreColorIndex(entry.genre),
  }))

  return { entries: rounded, totalMinutes, totalEpisodeEquivalent }
}

function aggregateEntries(entries, genre) {
  const showIds = new Set()
  const aggregate = entries.reduce(
    (result, entry) => {
      result.minutes += entry.minutes
      result.watchedEpisodeEquivalent += entry.watchedEpisodeEquivalent
      for (const showId of entry.showIds) showIds.add(showId)
      return result
    },
    { genre, minutes: 0, watchedEpisodeEquivalent: 0 },
  )
  return {
    ...aggregate,
    showIds: [...showIds].sort((left, right) => left - right),
    showCount: showIds.size,
  }
}

export function buildGenreOrbitDistribution(
  distribution,
  {
    maxPrimary = GENRE_ORBIT_MAX_PRIMARY,
    unclassifiedVisiblePercent = UNCLASSIFIED_VISIBLE_PERCENT,
  } = {},
) {
  const entries = distribution?.entries ?? []
  const totalMinutes = distribution?.totalMinutes ?? 0
  if (entries.length === 0 || !(totalMinutes > 0)) {
    return { entries: [], totalMinutes: 0, dominant: null }
  }

  const unclassified = entries.find((entry) => entry.genre === UNCLASSIFIED_GENRE)
  const showUnclassified =
    unclassified && unclassified.percentage >= unclassifiedVisiblePercent
  const named = entries.filter((entry) => entry.genre !== UNCLASSIFIED_GENRE)
  const namedSlots = Math.max(1, maxPrimary - (showUnclassified ? 1 : 0))
  const primaryGenres = new Set(
    named.slice(0, namedSlots).map((entry) => entry.genre),
  )
  if (showUnclassified) primaryGenres.add(UNCLASSIFIED_GENRE)
  const primary = entries.filter((entry) => primaryGenres.has(entry.genre))

  const remaining = entries.filter((entry) => !primaryGenres.has(entry.genre))
  const visible = [...primary]
  if (remaining.length > 0) visible.push(aggregateEntries(remaining, OTHER_GENRE))
  if (visible.length === 0 && unclassified) visible.push(unclassified)

  const rounded = roundGenrePercentages(
    visible,
    totalMinutes,
  ).map((entry, index) => ({
    ...entry,
    rank: index + 1,
    colorIndex: genreColorIndex(entry.genre),
  }))

  return {
    entries: rounded,
    totalMinutes,
    dominant: rounded[0] ?? null,
  }
}

export function formatGenreMinutes(minutes) {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`
  const hours = Math.round(minutes / 6) / 10
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)}h`
}
