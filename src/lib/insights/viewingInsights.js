import {
  buildGenreDistribution,
  UNCLASSIFIED_GENRE,
} from './genreDistribution.js'

export const INSIGHT_HISTORY_VERSION = 1
export const INSIGHT_HISTORY_LIMIT = 21
export const INSIGHT_HISTORY_KEY = 'stats_insight_history:v1'

// Portfolio claims are held back until the sample can support them. The
// thresholds favor plain, defensible observations over premature profiling.
export const INSIGHT_THRESHOLDS = Object.freeze({
  portfolioMinShows: 3,
  portfolioMinEpisodes: 12,
  portfolioMinMinutes: 360,
  concentrationMinShows: 4,
  dominantShowShare: 0.4,
  balancedShowMaxShare: 0.25,
  genreMinEpisodes: 10,
  dominantGenreShare: 0.35,
  dominantGenreLead: 0.08,
  classifiedGenreShare: 0.8,
  diverseGenreCount: 4,
  effectiveGenreCount: 3,
  commitmentEpisodes: 6,
  commitmentSeasons: 2,
  commitmentShare: 0.6,
  completionMinEligibleShows: 3,
  completionMinCompletedShows: 2,
  completionShare: 0.5,
  lengthMinEpisodes: 20,
  shortEpisodeMaxMinutes: 35,
  longEpisodeMinMinutes: 50,
  lengthStrongShare: 0.6,
  shortCountComparisonShare: 0.5,
  lengthMinuteLead: 0.08,
  longEpisodeMinCountShare: 0.3,
  seasonDepthMinShows: 3,
  seasonDepthMinMultiSeasonShows: 2,
  seasonDepthShare: 0.5,
  networkVarietyMinNetworks: 4,
  libraryBalanceMinFinishedShows: 2,
  libraryBalanceMinActiveShows: 2,
  libraryBalanceStrongShare: 0.65,
  crossBucketMinEpisodes: 5,
  crossGenreShare: 0.4,
  crossGenreLead: 0.1,
})

export const NOVELTY_WINDOWS = Object.freeze({
  exactCandidateDays: 7,
  featuredShowDays: 3,
  featuredGenreDays: 2,
})

function stableHash(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function percentage(value) {
  return Math.round(value * 100)
}

function plural(value, singular, pluralForm = `${singular}s`) {
  return `${value} ${value === 1 ? singular : pluralForm}`
}

function formatMinutesCompact(minutes) {
  if (minutes < 60) return `${Math.round(minutes)} minutes`
  const hours = Math.round(minutes / 60)
  return plural(hours, 'hour')
}

function candidate({
  id,
  category,
  factFamily,
  text,
  involvedShowIds = [],
  involvedGenres = [],
  strength,
  scope = 'portfolio',
  evidence = {},
}) {
  return {
    id,
    category,
    factFamily,
    text,
    involvedShowIds: [...new Set(involvedShowIds)],
    involvedGenres: [...new Set(involvedGenres)],
    strength: Math.max(0, Math.min(1, strength)),
    scope,
    evidence,
  }
}

function uniqueLeader(entries, valueSelector) {
  const sorted = [...entries].sort((left, right) => {
    const difference = valueSelector(right) - valueSelector(left)
    if (Math.abs(difference) > Number.EPSILON) return difference
    return String(left.name ?? left.genre ?? left.tmdb_id).localeCompare(
      String(right.name ?? right.genre ?? right.tmdb_id),
    )
  })
  if (sorted.length === 0) return { leader: null, runnerUp: null, tied: false }
  const leader = sorted[0]
  const runnerUp = sorted[1] ?? null
  const tied =
    runnerUp !== null &&
    Math.abs(valueSelector(leader) - valueSelector(runnerUp)) < 0.000001
  return { leader, runnerUp, tied }
}

function effectiveGenreCount(entries, totalMinutes) {
  if (!(totalMinutes > 0)) return 0
  let entropy = 0
  for (const entry of entries) {
    const share = entry.minutes / totalMinutes
    if (share > 0) entropy -= share * Math.log(share)
  }
  return Math.exp(entropy)
}

function genreBucketLeaders(shows, threshold) {
  const buckets = { short: new Map(), long: new Map() }
  const totals = { short: 0, long: 0 }

  for (const show of shows) {
    const genres = (show.genres ?? []).filter(Boolean)
    if (genres.length === 0) continue
    for (const runtime of show.watchedEpisodeRuntimes ?? []) {
      let bucket = null
      if (runtime <= threshold.shortEpisodeMaxMinutes) bucket = 'short'
      if (runtime >= threshold.longEpisodeMinMinutes) bucket = 'long'
      if (!bucket) continue
      totals[bucket] += 1
      for (const genre of genres) {
        buckets[bucket].set(
          genre,
          (buckets[bucket].get(genre) ?? 0) + 1 / genres.length,
        )
      }
    }
  }

  function summarize(bucket) {
    const entries = [...buckets[bucket]].map(([name, value]) => ({ name, value }))
    const result = uniqueLeader(entries, (entry) => entry.value)
    return {
      ...result,
      total: totals[bucket],
      share: result.leader ? result.leader.value / totals[bucket] : 0,
      lead:
        result.leader && result.runnerUp
          ? (result.leader.value - result.runnerUp.value) / totals[bucket]
          : result.leader
            ? 1
            : 0,
    }
  }

  return { short: summarize('short'), long: summarize('long') }
}

export function buildAnalyticsFingerprint(shows) {
  const meaningful = [...(shows ?? [])]
    .sort((left, right) => left.tmdb_id - right.tmdb_id)
    .map((show) => ({
      id: show.tmdb_id,
      minutes: Math.round(show.minutes * 100) / 100,
      watched: show.watchedEpisodeCount,
      total: show.totalKnownEpisodeCount,
      seasons: show.distinctWatchedSeasons,
      finished: show.finished_at != null,
      genres: [...(show.genres ?? [])].sort(),
      networks: [...(show.networks ?? [])].sort(),
      runtimes: show.watchedEpisodeRuntimes,
    }))
  return stableHash(JSON.stringify(meaningful)).toString(36)
}

export function buildViewingInsightCandidates({
  shows,
  totalMinutes,
  genreDistribution = buildGenreDistribution(shows),
  thresholds = INSIGHT_THRESHOLDS,
}) {
  const candidates = []
  const showCount = shows.length
  const episodeCount = shows.reduce(
    (sum, show) => sum + (show.watchedEpisodeCount ?? 0),
    0,
  )
  if (showCount === 0 || episodeCount === 0 || !(totalMinutes > 0)) return candidates

  const portfolioReady =
    showCount >= thresholds.portfolioMinShows &&
    episodeCount >= thresholds.portfolioMinEpisodes &&
    totalMinutes >= thresholds.portfolioMinMinutes

  const showLeader = uniqueLeader(shows, (show) => show.minutes)
  const topShowShare = showLeader.leader?.minutes / totalMinutes
  if (
    portfolioReady &&
    showCount >= thresholds.concentrationMinShows &&
    !showLeader.tied &&
    topShowShare >= thresholds.dominantShowShare
  ) {
    candidates.push(candidate({
      id: `concentration:top-show:${showLeader.leader.tmdb_id}`,
      category: 'viewing-concentration',
      factFamily: 'top-show-runtime-share',
      text: `${showLeader.leader.name} holds ${percentage(topShowShare)}% of your screen time. It is the one concentrated point in an otherwise ${plural(showCount, 'show')} history.`,
      involvedShowIds: [showLeader.leader.tmdb_id],
      strength: Math.min(1, topShowShare + 0.35),
      evidence: { share: topShowShare, totalMinutes },
    }))
  } else if (
    portfolioReady &&
    showCount >= thresholds.concentrationMinShows &&
    topShowShare <= thresholds.balancedShowMaxShare
  ) {
    candidates.push(candidate({
      id: 'concentration:balanced-portfolio',
      category: 'viewing-concentration',
      factFamily: 'portfolio-runtime-balance',
      text: `Your watch history is unusually balanced: no single show owns more than ${percentage(topShowShare)}% of your screen time.`,
      strength: 0.78,
      evidence: { largestShare: topShowShare, showCount },
    }))
  }

  const genreEntries = genreDistribution.entries
  const unclassifiedMinutes =
    genreEntries.find((entry) => entry.genre === UNCLASSIFIED_GENRE)?.minutes ?? 0
  const classifiedShare = 1 - unclassifiedMinutes / totalMinutes
  const classifiedGenres = genreEntries.filter(
    (entry) => entry.genre !== UNCLASSIFIED_GENRE,
  )
  const genreLeader = uniqueLeader(classifiedGenres, (entry) => entry.minutes)
  const genreShare = genreLeader.leader
    ? genreLeader.leader.minutes / totalMinutes
    : 0
  const genreLead =
    genreLeader.leader && genreLeader.runnerUp
      ? (genreLeader.leader.minutes - genreLeader.runnerUp.minutes) / totalMinutes
      : genreShare

  if (
    episodeCount >= thresholds.genreMinEpisodes &&
    classifiedShare >= thresholds.classifiedGenreShare &&
    !genreLeader.tied &&
    genreShare >= thresholds.dominantGenreShare &&
    genreLead >= thresholds.dominantGenreLead
  ) {
    candidates.push(candidate({
      id: `genre:home-base:${genreLeader.leader.genre.toLocaleLowerCase()}`,
      category: 'genre-identity',
      factFamily: 'dominant-genre-runtime-share',
      text: `${genreLeader.leader.genre} is your home base, taking ${percentage(genreShare)}% of the time you have spent with your shows.`,
      involvedGenres: [genreLeader.leader.genre],
      strength: Math.min(1, genreShare + genreLead + 0.25),
      evidence: { share: genreShare, lead: genreLead },
    }))
  }

  const diversity = effectiveGenreCount(classifiedGenres, totalMinutes)
  if (
    portfolioReady &&
    classifiedShare >= thresholds.classifiedGenreShare &&
    classifiedGenres.length >= thresholds.diverseGenreCount &&
    diversity >= thresholds.effectiveGenreCount &&
    genreShare < thresholds.dominantGenreShare
  ) {
    candidates.push(candidate({
      id: 'variety:effective-genre-spread',
      category: 'variety',
      factFamily: 'effective-genre-diversity',
      text: `Your time genuinely travels: ${plural(classifiedGenres.length, 'genre')} are represented, and no single one takes over the orbit.`,
      involvedGenres: classifiedGenres.slice(0, 3).map((entry) => entry.genre),
      strength: Math.min(1, 0.6 + diversity / 10),
      evidence: { genreCount: classifiedGenres.length, effectiveGenreCount: diversity },
    }))
  }

  const deepShows = shows.filter(
    (show) =>
      show.watchedEpisodeCount >= thresholds.commitmentEpisodes ||
      show.distinctWatchedSeasons >= thresholds.commitmentSeasons,
  )
  const commitmentShare = deepShows.length / showCount
  if (
    showCount >= thresholds.portfolioMinShows &&
    episodeCount >= thresholds.portfolioMinEpisodes &&
    commitmentShare >= thresholds.commitmentShare
  ) {
    candidates.push(candidate({
      id: 'commitment:past-sampling',
      category: 'commitment',
      factFamily: 'deep-start-share',
      text: `You rarely stop at a sample: ${percentage(commitmentShare)}% of the shows you start make it past ${plural(thresholds.commitmentEpisodes - 1, 'episode')} or into a second season.`,
      strength: Math.min(1, commitmentShare + 0.2),
      evidence: { deepShows: deepShows.length, showCount, commitmentShare },
    }))
  }

  const completionEligible = shows.filter(
    (show) =>
      show.metadataComplete &&
      show.totalKnownEpisodeCount >= thresholds.commitmentEpisodes,
  )
  const completedShows = completionEligible.filter(
    (show) => show.completionRatio === 1,
  )
  const completionShare =
    completionEligible.length > 0 ? completedShows.length / completionEligible.length : 0
  if (
    completionEligible.length >= thresholds.completionMinEligibleShows &&
    completedShows.length >= thresholds.completionMinCompletedShows &&
    completionShare >= thresholds.completionShare
  ) {
    candidates.push(candidate({
      id: 'completion:finish-rate',
      category: 'completion',
      factFamily: 'known-catalogue-completion-share',
      text: `Finishing is part of your pattern: ${completedShows.length} of ${completionEligible.length} shows with a known episode list are complete.`,
      strength: Math.min(1, completionShare + 0.25),
      evidence: {
        completedShows: completedShows.length,
        eligibleShows: completionEligible.length,
        completionShare,
      },
    }))
  }

  const runtimes = shows.flatMap((show) => show.watchedEpisodeRuntimes ?? [])
  if (runtimes.length >= thresholds.lengthMinEpisodes) {
    const short = runtimes.filter(
      (runtime) => runtime <= thresholds.shortEpisodeMaxMinutes,
    )
    const long = runtimes.filter(
      (runtime) => runtime >= thresholds.longEpisodeMinMinutes,
    )
    const shortCountShare = short.length / runtimes.length
    const longCountShare = long.length / runtimes.length
    const runtimeTotal = runtimes.reduce((sum, runtime) => sum + runtime, 0)
    const shortMinuteShare = short.reduce((sum, runtime) => sum + runtime, 0) / runtimeTotal
    const longMinuteShare = long.reduce((sum, runtime) => sum + runtime, 0) / runtimeTotal

    if (
      shortCountShare >= thresholds.shortCountComparisonShare &&
      longMinuteShare >= shortMinuteShare + thresholds.lengthMinuteLead
    ) {
      candidates.push(candidate({
        id: 'episode-length:short-count-long-time',
        category: 'episode-length',
        factFamily: 'short-count-versus-long-runtime',
        text: `Short episodes win on count, but longer episodes still take the larger slice of your actual viewing time.`,
        strength: Math.min(1, 0.65 + longMinuteShare - shortMinuteShare),
        evidence: { shortCountShare, shortMinuteShare, longMinuteShare },
      }))
    } else if (shortCountShare >= thresholds.lengthStrongShare) {
      candidates.push(candidate({
        id: 'episode-length:short-preference',
        category: 'episode-length',
        factFamily: 'short-episode-count-share',
        text: `Compact episodes set your pace: ${percentage(shortCountShare)}% of your watched episodes run ${thresholds.shortEpisodeMaxMinutes} minutes or less.`,
        strength: Math.min(1, shortCountShare + 0.2),
        evidence: { shortCountShare },
      }))
    } else if (
      longCountShare >= thresholds.longEpisodeMinCountShare &&
      longMinuteShare >= thresholds.lengthStrongShare
    ) {
      candidates.push(candidate({
        id: 'episode-length:long-form-time',
        category: 'episode-length',
        factFamily: 'long-episode-runtime-share',
        text: `Long-form viewing carries the weight: episodes of ${thresholds.longEpisodeMinMinutes}+ minutes account for ${percentage(longMinuteShare)}% of your screen time.`,
        strength: Math.min(1, longMinuteShare + 0.2),
        evidence: { longCountShare, longMinuteShare },
      }))
    }
  }

  const multiSeasonShows = shows.filter(
    (show) => show.distinctWatchedSeasons >= thresholds.commitmentSeasons,
  )
  const seasonDepthShare = multiSeasonShows.length / showCount
  if (
    showCount >= thresholds.seasonDepthMinShows &&
    multiSeasonShows.length >= thresholds.seasonDepthMinMultiSeasonShows &&
    seasonDepthShare >= thresholds.seasonDepthShare
  ) {
    candidates.push(candidate({
      id: 'season-depth:multi-season-portfolio',
      category: 'season-depth',
      factFamily: 'multi-season-show-share',
      text: `Your history has real depth: ${multiSeasonShows.length} of ${showCount} shows stretch across more than one watched season.`,
      strength: Math.min(1, seasonDepthShare + 0.2),
      evidence: { multiSeasonShows: multiSeasonShows.length, showCount, seasonDepthShare },
    }))
  }

  const distinctNetworks = new Set(shows.flatMap((show) => show.networks ?? []))
  if (
    portfolioReady &&
    distinctNetworks.size >= thresholds.networkVarietyMinNetworks
  ) {
    candidates.push(candidate({
      id: 'variety:network-reach',
      category: 'network-variety',
      factFamily: 'distinct-network-reach',
      text: `Your library crosses ${plural(distinctNetworks.size, 'network')}, giving it a broad catalogue footprint.`,
      strength: Math.min(0.9, 0.55 + distinctNetworks.size / 20),
      evidence: { networkCount: distinctNetworks.size },
    }))
  }

  const completedRuntime = shows
    .filter((show) => show.finished_at != null)
    .reduce((sum, show) => sum + show.minutes, 0)
  const finishedCount = shows.filter((show) => show.finished_at != null).length
  const activeCount = showCount - finishedCount
  const completedRuntimeShare = completedRuntime / totalMinutes
  if (
    portfolioReady &&
    finishedCount >= thresholds.libraryBalanceMinFinishedShows &&
    activeCount >= thresholds.libraryBalanceMinActiveShows &&
    (
      completedRuntimeShare >= thresholds.libraryBalanceStrongShare ||
      completedRuntimeShare <= 1 - thresholds.libraryBalanceStrongShare
    )
  ) {
    const mostlyCompleted =
      completedRuntimeShare >= thresholds.libraryBalanceStrongShare
    candidates.push(candidate({
      id: `library-balance:${mostlyCompleted ? 'completed' : 'active'}-runtime`,
      category: 'library-balance',
      factFamily: 'completed-versus-active-runtime',
      text: mostlyCompleted
        ? `${percentage(completedRuntimeShare)}% of your viewing time lives in shows you have already completed.`
        : `Your active watches hold ${percentage(1 - completedRuntimeShare)}% of your viewing time, keeping the library tilted toward what is still in progress.`,
      strength: Math.min(1, Math.abs(completedRuntimeShare - 0.5) + 0.55),
      evidence: { completedRuntimeShare, finishedCount, activeCount },
    }))
  }

  const bucketLeaders = genreBucketLeaders(shows, thresholds)
  if (
    bucketLeaders.short.total >= thresholds.crossBucketMinEpisodes &&
    bucketLeaders.long.total >= thresholds.crossBucketMinEpisodes &&
    !bucketLeaders.short.tied &&
    !bucketLeaders.long.tied &&
    bucketLeaders.short.leader?.name !== bucketLeaders.long.leader?.name &&
    bucketLeaders.short.share >= thresholds.crossGenreShare &&
    bucketLeaders.long.share >= thresholds.crossGenreShare &&
    bucketLeaders.short.lead >= thresholds.crossGenreLead &&
    bucketLeaders.long.lead >= thresholds.crossGenreLead
  ) {
    const shortGenre = bucketLeaders.short.leader.name
    const longGenre = bucketLeaders.long.leader.name
    candidates.push(candidate({
      id: `cross:length-genres:${shortGenre.toLocaleLowerCase()}:${longGenre.toLocaleLowerCase()}`,
      category: 'cross-dimensional',
      factFamily: 'episode-length-by-genre',
      text: `${shortGenre} leads your compact episodes, while ${longGenre} owns the longer watches.`,
      involvedGenres: [shortGenre, longGenre],
      strength: Math.min(
        1,
        0.55 + (bucketLeaders.short.share + bucketLeaders.long.share) / 4,
      ),
      evidence: {
        shortGenre,
        longGenre,
        shortEpisodes: bucketLeaders.short.total,
        longEpisodes: bucketLeaders.long.total,
      },
    }))
  }

  if (candidates.length === 0) {
    const onlyShow = shows.length === 1 ? shows[0] : null
    candidates.push(candidate({
      id: onlyShow ? `overview:first-show:${onlyShow.tmdb_id}` : 'overview:early-portfolio',
      category: 'overview',
      factFamily: 'early-history-summary',
      text: onlyShow
        ? `Your Insights universe starts with ${onlyShow.name}: ${plural(episodeCount, 'episode')} and ${formatMinutesCompact(totalMinutes)} so far.`
        : `Your viewing journal is taking shape across ${plural(showCount, 'show')} and ${plural(episodeCount, 'episode')}.`,
      involvedShowIds: onlyShow ? [onlyShow.tmdb_id] : [],
      strength: 0.35,
      scope: onlyShow ? 'show' : 'portfolio',
      evidence: { showCount, episodeCount, totalMinutes },
    }))
  }

  const seenFamilies = new Set()
  return candidates.filter((entry) => {
    if (seenFamilies.has(entry.factFamily)) return false
    seenFamilies.add(entry.factFamily)
    return true
  })
}

function datesApart(from, to) {
  const fromParts = from.split('-').map(Number)
  const toParts = to.split('-').map(Number)
  if (
    fromParts.length !== 3 ||
    toParts.length !== 3 ||
    !fromParts.every(Number.isFinite) ||
    !toParts.every(Number.isFinite)
  ) {
    return Infinity
  }
  const difference =
    (Date.UTC(toParts[0], toParts[1] - 1, toParts[2]) -
      Date.UTC(fromParts[0], fromParts[1] - 1, fromParts[2])) /
    86400000
  return Number.isFinite(difference) ? Math.abs(Math.round(difference)) : Infinity
}

export function pruneInsightHistory(entries, today) {
  const byDate = new Map()
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== 'object' || typeof entry.date !== 'string') continue
    if (datesApart(entry.date, today) > INSIGHT_HISTORY_LIMIT * 2) continue
    if (!byDate.has(entry.date)) byDate.set(entry.date, entry)
  }
  return [...byDate.values()]
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, INSIGHT_HISTORY_LIMIT)
}

export function parseInsightHistory(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (
      !parsed ||
      parsed.version !== INSIGHT_HISTORY_VERSION ||
      !Array.isArray(parsed.entries)
    ) {
      return []
    }
    return parsed.entries
  } catch {
    return []
  }
}

function overlaps(left, right) {
  const rightSet = new Set(right)
  return left.some((value) => rightSet.has(value))
}

export function selectDailyInsight({
  candidates,
  date,
  fingerprint,
  history = [],
}) {
  if (!candidates?.length) {
    return { insight: null, history: pruneInsightHistory(history, date) }
  }

  const recent = pruneInsightHistory(history, date)
  const sameDay = recent.find((entry) => entry.date === date)
  if (sameDay) {
    const stillValid = candidates.find((entry) => entry.id === sameDay.candidateId)
    if (stillValid) {
      return {
        insight: { ...stillValid, text: sameDay.text || stillValid.text },
        history: recent,
      }
    }
  }

  const prior = recent.filter((entry) => entry.date !== date)
  let eligible = [...candidates]
  const prefer = (predicate) => {
    const preferred = eligible.filter(predicate)
    if (preferred.length > 0) eligible = preferred
  }
  const yesterday = prior.find((entry) => datesApart(entry.date, date) === 1)
  if (yesterday) prefer((entry) => entry.category !== yesterday.category)
  prefer((entry) =>
    !prior.some(
      (used) =>
        datesApart(used.date, date) <= NOVELTY_WINDOWS.exactCandidateDays &&
        used.candidateId === entry.id,
    ),
  )
  prefer((entry) =>
    !prior.some(
      (used) =>
        datesApart(used.date, date) <= NOVELTY_WINDOWS.featuredShowDays &&
        overlaps(entry.involvedShowIds, used.featuredShowIds ?? []),
    ),
  )
  prefer((entry) =>
    !prior.some(
      (used) =>
        datesApart(used.date, date) <= NOVELTY_WINDOWS.featuredGenreDays &&
        overlaps(entry.involvedGenres, used.featuredGenres ?? []),
    ),
  )

  eligible.sort((left, right) => {
    function score(entry) {
      let value = entry.strength * 100 + (entry.scope === 'portfolio' ? 12 : 0)
      for (const used of prior) {
        const age = datesApart(used.date, date)
        if (age > INSIGHT_HISTORY_LIMIT) continue
        if (used.category === entry.category) value -= Math.max(0, 24 - age * 3)
        if (used.factFamily === entry.factFamily) value -= Math.max(0, 45 - age * 4)
        if (overlaps(entry.involvedShowIds, used.featuredShowIds ?? [])) {
          value -= Math.max(0, 36 - age * 6)
        }
        if (overlaps(entry.involvedGenres, used.featuredGenres ?? [])) {
          value -= Math.max(0, 18 - age * 4)
        }
      }
      return value
    }
    const difference = score(right) - score(left)
    if (Math.abs(difference) > 0.000001) return difference
    return (
      stableHash(`${date}|${fingerprint}|${left.id}`) -
      stableHash(`${date}|${fingerprint}|${right.id}`)
    )
  })

  const insight = eligible[0]
  const entry = {
    date,
    fingerprint,
    candidateId: insight.id,
    category: insight.category,
    factFamily: insight.factFamily,
    featuredShowIds: insight.involvedShowIds,
    featuredGenres: insight.involvedGenres,
    text: insight.text,
  }
  return {
    insight,
    history: pruneInsightHistory([entry, ...prior], date),
  }
}

export function selectStoredDailyInsight({
  candidates,
  date,
  fingerprint,
  storage = globalThis.localStorage,
}) {
  let history = []
  try {
    history = parseInsightHistory(storage?.getItem(INSIGHT_HISTORY_KEY))
  } catch {
    history = []
  }
  const selected = selectDailyInsight({ candidates, date, fingerprint, history })
  try {
    storage?.setItem(
      INSIGHT_HISTORY_KEY,
      JSON.stringify({
        version: INSIGHT_HISTORY_VERSION,
        entries: selected.history,
      }),
    )
  } catch {
    // History is best-effort; deterministic selection still works without it.
  }
  return selected.insight
}

export function clearInsightHistory(storage = globalThis.localStorage) {
  try {
    storage?.removeItem(INSIGHT_HISTORY_KEY)
  } catch {
    // ignore unavailable storage
  }
}
