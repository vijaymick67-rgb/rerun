import { computeWatchingStatus, episodeKey } from './watchHelpers.js'
import { isHiddenShow, isPersonallyFinished, shouldFinishedShowReturn } from './finishedShows.js'
import { classifyReleasePlatform } from './releasePlatforms.js'

// Stage 1: all unfinished shows remain candidates. Finished shows receive only
// a lightweight show-details request; ineligible archives stop here.
export async function selectTrackedShowsForWatching(
  trackedShows,
  getShowDetails,
  getShowReleaseMap,
) {
  const visibleShows = trackedShows.filter((show) => !isHiddenShow(show))
  const unfinished = visibleShows.filter((show) => !isPersonallyFinished(show))
  const finished = visibleShows.filter(isPersonallyFinished)

  const checkedFinished = await Promise.all(
    finished.map(async (show) => {
      try {
        const [details, releaseMap] = await Promise.all([
          getShowDetails(show.tmdb_id, { refreshDynamic: true }),
          getShowReleaseMap ? getShowReleaseMap(show.tmdb_id) : {},
        ])
        const enrichedDetails = attachDetailsReleaseData(details, releaseMap)
        return shouldFinishedShowReturn(show, enrichedDetails)
          ? { show, details: enrichedDetails, releaseMap }
          : null
      } catch {
        return null
      }
    }),
  )

  const returning = checkedFinished.filter(Boolean)
  return {
    candidates: [...unfinished, ...returning.map((entry) => entry.show)],
    preloadedById: new Map(
      returning.map((entry) => [entry.show.tmdb_id, {
        details: entry.details,
        releaseMap: entry.releaseMap,
      }]),
    ),
  }
}

// Stage 2: only candidates fetch seasons. Promise.all at both levels preserves
// the existing parallel loading behavior and avoids a serial waterfall.
export async function enrichTrackedShowsForWatching(
  candidates,
  watchedByShowId,
  preloadedById,
  { getShowDetails, getSeasonEpisodes, getShowReleaseMap, getShowAirstamps },
) {
  const loadReleaseMap = getShowReleaseMap ?? getShowAirstamps
  return Promise.all(
    candidates.map(async (show) => {
      const watched = watchedByShowId.get(show.tmdb_id) ?? new Set()
      let episodesBySeason = {}
      let loadError = false
      let details = preloadedById.get(show.tmdb_id)?.details ?? null
      let releaseMap = preloadedById.get(show.tmdb_id)?.releaseMap ?? null

      try {
        const releaseMapPromise = releaseMap !== null
          ? Promise.resolve(releaseMap)
          : loadReleaseMap ? loadReleaseMap(show.tmdb_id) : Promise.resolve({})
        const [loadedDetails, loadedReleaseMap] = await Promise.all([
          details ? Promise.resolve(details) : getShowDetails(show.tmdb_id),
          releaseMapPromise,
        ])
        details = loadedDetails
        releaseMap = loadedReleaseMap
        const seasons = (details.seasons ?? [])
          .filter((season) => season.season_number > 0)
          .sort((a, b) => a.season_number - b.season_number)
        const episodeArrays = await Promise.all(seasons.map((season) =>
            getSeasonEpisodes(show.tmdb_id, season.season_number, { refreshDynamic: true }),
          ))
        seasons.forEach((season, index) => {
          episodesBySeason[season.season_number] = episodeArrays[index].episodes
        })

        // Attach TVmaze date metadata and the derived platform once, then use
        // the same release map for season rows and show-level episode pointers.
        const platformInfo = classifyReleasePlatform(details)
        episodesBySeason = attachReleaseData(episodesBySeason, releaseMap, platformInfo)
        details = attachDetailsReleaseData(details, releaseMap, platformInfo)
      } catch {
        loadError = true
      }

      return {
        ...show,
        loadError,
        status: computeWatchingStatus(episodesBySeason, watched, details),
      }
    }),
  )
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
