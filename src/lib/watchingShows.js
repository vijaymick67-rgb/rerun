import { computeWatchingStatus, episodeKey } from './watchHelpers.js'
import { isHiddenShow, isPersonallyFinished, shouldFinishedShowReturn } from './finishedShows.js'
import { classifyReleasePlatform } from './releasePlatforms.js'
import { reportDataError, withTimeout } from './dataLoading.js'

// Stage 1: all unfinished shows remain candidates. Finished shows receive only
// a lightweight show-details request; ineligible archives stop here.
async function selectFinishedShowsForWatching(finished, getShowDetails, getShowReleaseMap) {
  return Promise.all(
    finished.map(async (show) => {
      const detailRequest = withTimeout(
        () => getShowDetails(show.tmdb_id, { refreshDynamic: true }),
        { stage: 'watching-finished-show-details', source: 'tmdb' },
      ).then((value) => ({ value })).catch((error) => ({ error }))
      const releaseRequest = getShowReleaseMap
        ? withTimeout(
          () => getShowReleaseMap(show.tmdb_id),
          { stage: 'watching-finished-show-release-map', source: 'tvmaze' },
        ).then((value) => ({ value })).catch((error) => ({ error }))
        : Promise.resolve({ value: {} })
      const [detailResult, releaseResult] = await Promise.all([detailRequest, releaseRequest])
      const details = detailResult.value
      const releaseMap = releaseResult.value ?? {}
      const failures = []

      if (detailResult.error) {
        failures.push(reportDataError(detailResult.error, {
          stage: detailResult.error?.stage ?? 'watching-finished-show-details',
          source: detailResult.error?.source ?? 'tmdb',
          tmdbShowId: show.tmdb_id,
        }))
      }
      if (releaseResult.error) {
        failures.push(reportDataError(releaseResult.error, {
          stage: releaseResult.error?.stage ?? 'watching-finished-show-release-map',
          source: releaseResult.error?.source ?? 'tvmaze',
          tmdbShowId: show.tmdb_id,
        }))
      }

      // Missing metadata must never make an archived show disappear. It stays
      // a candidate and is retried by the normal per-show enrichment path.
      if (failures.length > 0 || !details) {
        return { show, failures, selectionLoadError: true }
      }

      const enrichedDetails = attachDetailsReleaseData(details, releaseMap)
      return shouldFinishedShowReturn(show, enrichedDetails)
        ? { show, details: enrichedDetails, releaseMap, failures }
        : null
    }),
  )
}

export async function selectTrackedShowsForWatching(
  trackedShows,
  getShowDetails,
  getShowReleaseMap,
  { deferFinished = false } = {},
) {
  const visibleShows = trackedShows.filter((show) => !isHiddenShow(show))
  const unfinished = visibleShows.filter((show) => !isPersonallyFinished(show))
  const finished = visibleShows.filter(isPersonallyFinished)

  if (deferFinished) {
    return {
      candidates: unfinished,
      preloadedById: new Map(),
      pendingFinished: selectFinishedShowsForWatching(finished, getShowDetails, getShowReleaseMap),
    }
  }

  const checkedFinished = await selectFinishedShowsForWatching(
    finished, getShowDetails, getShowReleaseMap,
  )

  const returning = checkedFinished.filter(Boolean)
  const result = {
    candidates: [...unfinished, ...returning.map((entry) => entry.show)],
    preloadedById: new Map(
      returning.filter((entry) => entry.details).map((entry) => [entry.show.tmdb_id, {
        details: entry.details,
        releaseMap: entry.releaseMap,
      }]),
    ),
  }
  result.failures = returning.flatMap((entry) => entry.failures ?? [])
  return result
}

// Stage 2: only candidates fetch seasons. Promise.all at both levels preserves
// the existing parallel loading behavior and avoids a serial waterfall.
export async function enrichTrackedShowsForWatching(
  candidates,
  watchedByShowId,
  preloadedById,
  { getShowDetails, getSeasonEpisodes, getShowReleaseMap, getShowAirstamps },
  { onShowSettled } = {},
) {
  const loadReleaseMap = getShowReleaseMap ?? getShowAirstamps
  const failures = []
  const result = await Promise.all(
    candidates.map(async (show) => {
      const watched = watchedByShowId.get(show.tmdb_id) ?? new Set()
      let loaded
      try {
        loaded = await loadWatchingShowData(show, watched, preloadedById.get(show.tmdb_id), {
          getShowDetails, getSeasonEpisodes, getShowReleaseMap: loadReleaseMap,
        })
      } catch (error) {
        const diagnostic = reportDataError(error, {
          stage: error?.stage ?? 'watching-show-enrichment',
          source: error?.source ?? 'unknown',
          tmdbShowId: show.tmdb_id,
        })
        loaded = {
          loadError: true,
          failures: [diagnostic],
          status: computeWatchingStatus(
            {},
            watched,
            preloadedById.get(show.tmdb_id)?.details ?? {},
          ),
        }
      }
      const enriched = {
        ...show,
        loadError: loaded.loadError,
        status: loaded.status,
        loadDiagnostics: loaded.failures ?? [],
      }
      for (const failure of loaded.failures ?? []) failures.push(failure)
      onShowSettled?.(enriched)
      return enriched
    }),
  )
  Object.defineProperty(result, 'failures', { value: failures, enumerable: false })
  return result
}

export async function loadWatchingShowData(
  show,
  watched,
  preloaded,
  { getShowDetails, getSeasonEpisodes, getShowReleaseMap },
) {
  let episodesBySeason = {}
  let details = preloaded?.details ?? null
  let releaseMap = preloaded?.releaseMap ?? null
  const failures = []

  const detailsRequest = details
    ? Promise.resolve({ value: details })
    : withTimeout(
      () => getShowDetails(show.tmdb_id),
      { stage: 'watching-show-details', source: 'tmdb' },
    ).then((value) => ({ value })).catch((error) => ({ error }))
  const releaseRequest = releaseMap !== null
    ? Promise.resolve({ value: releaseMap })
    : getShowReleaseMap
      ? withTimeout(
        () => getShowReleaseMap(show.tmdb_id),
        { stage: 'watching-show-release-map', source: 'tvmaze' },
      ).then((value) => ({ value })).catch((error) => ({ error }))
      : Promise.resolve({ value: {} })
  const [detailsResult, releaseResult] = await Promise.all([detailsRequest, releaseRequest])
  if (detailsResult.error) {
    failures.push(reportDataError(detailsResult.error, {
      stage: detailsResult.error?.stage ?? 'watching-show-details',
      source: detailsResult.error?.source ?? 'tmdb',
      tmdbShowId: show.tmdb_id,
    }))
    details = {}
  } else {
    details = detailsResult.value ?? {}
  }
  if (releaseResult.error) {
    failures.push(reportDataError(releaseResult.error, {
      stage: releaseResult.error?.stage ?? 'watching-show-release-map',
      source: releaseResult.error?.source ?? 'tvmaze',
      tmdbShowId: show.tmdb_id,
    }))
    releaseMap = {}
  } else {
    releaseMap = releaseResult.value ?? {}
  }

  const seasons = (details?.seasons ?? [])
    .filter((season) => season.season_number > 0)
    .sort((a, b) => a.season_number - b.season_number)
  const episodeResults = await Promise.all(seasons.map(async (season) => {
    try {
      const episodes = await withTimeout(
        () => getSeasonEpisodes(show.tmdb_id, season.season_number, { refreshDynamic: true }),
        { stage: 'watching-season-episodes', source: 'tmdb' },
      )
      return { season, episodes: episodes.episodes ?? [] }
    } catch (error) {
      failures.push(reportDataError(error, {
        stage: error?.stage ?? 'watching-season-episodes',
        source: error?.source ?? 'tmdb',
        tmdbShowId: show.tmdb_id,
      }))
      return null
    }
  }))
  for (const result of episodeResults) {
    if (result) episodesBySeason[result.season.season_number] = result.episodes
  }

  const platformInfo = classifyReleasePlatform(details)
  episodesBySeason = attachReleaseData(episodesBySeason, releaseMap, platformInfo)
  details = attachDetailsReleaseData(details, releaseMap, platformInfo)
  return {
    loadError: failures.length > 0,
    details,
    releaseMap,
    episodesBySeason,
    failures,
    status: computeWatchingStatus(episodesBySeason, watched, details),
  }
}

// Return a copy with each episode's structured TVmaze release record attached.
export function attachReleaseData(episodesBySeason, releaseMap, platformInfo) {
  const out = {}
  for (const [seasonNumber, episodes] of Object.entries(episodesBySeason)) {
    out[seasonNumber] = (episodes ?? []).map((ep) => {
      return attachEpisodeReleaseData(ep, releaseMap, Number(seasonNumber), platformInfo)
    })
  }
  return out
}

// Attach the matching TVmaze fields to an episode pointer or season row.
export function attachEpisodeReleaseData(episode, releaseMap, seasonNumber, platformInfo) {
  if (!episode) return episode
  const release = releaseMap?.[episodeKey(seasonNumber ?? episode.season_number, episode.episode_number)]
  if (!release) return { ...episode, releasePlatform: platformInfo ?? episode.releasePlatform }
  // Accept v1 string maps in tests/in-memory callers, while persisted v1 keys
  // are isolated by the v2 cache prefixes.
  return {
    ...episode,
    releasePlatform: platformInfo ?? episode.releasePlatform,
    ...(typeof release === 'string' ? { airstamp: release } : release),
  }
}

export function attachDetailsReleaseData(details, releaseMap, platformInfo = classifyReleasePlatform(details)) {
  if (!details) return details
  return {
    ...details,
    releasePlatform: platformInfo,
    next_episode_to_air: attachEpisodeReleaseData(details.next_episode_to_air, releaseMap, undefined, platformInfo),
    last_episode_to_air: attachEpisodeReleaseData(details.last_episode_to_air, releaseMap, undefined, platformInfo),
  }
}
