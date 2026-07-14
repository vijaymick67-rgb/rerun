import { computeWatchingStatus, episodeKey } from './watchHelpers.js'
import { isHiddenShow, isPersonallyFinished, shouldFinishedShowReturn } from './finishedShows.js'

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
        const details = await getShowDetails(show.tmdb_id, { refreshDynamic: true })
        const releaseMap = getShowReleaseMap ? await getShowReleaseMap(show.tmdb_id) : {}
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
        if (!details) {
          details = await getShowDetails(show.tmdb_id)
        }
        const seasons = (details.seasons ?? [])
          .filter((season) => season.season_number > 0)
          .sort((a, b) => a.season_number - b.season_number)
        const episodeArrays = await Promise.all(
          seasons.map((season) =>
            getSeasonEpisodes(show.tmdb_id, season.season_number, { refreshDynamic: true }),
          ),
        )
        seasons.forEach((season, index) => {
          episodesBySeason[season.season_number] = episodeArrays[index].episodes
        })

        // Overlay TVmaze airstamps (a smarter first-choice release source) onto
        // both the season episodes and next_episode_to_air. getShowAirstamps
        // never throws and returns {} when the show has no TVmaze match, so a
        // missing/failed lookup leaves every episode on the universal anchor.
        if (loadReleaseMap) {
          releaseMap ??= await loadReleaseMap(show.tmdb_id)
          if (releaseMap && Object.keys(releaseMap).length > 0) {
            episodesBySeason = attachReleaseData(episodesBySeason, releaseMap)
            details = attachDetailsReleaseData(details, releaseMap)
          }
        }
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
export function attachReleaseData(episodesBySeason, releaseMap) {
  const out = {}
  for (const [seasonNumber, episodes] of Object.entries(episodesBySeason)) {
    out[seasonNumber] = (episodes ?? []).map((ep) => {
      return attachEpisodeReleaseData(ep, releaseMap, Number(seasonNumber))
    })
  }
  return out
}

// Attach the matching TVmaze fields to an episode pointer or season row.
export function attachEpisodeReleaseData(episode, releaseMap, seasonNumber) {
  if (!episode) return episode
  const release = releaseMap?.[episodeKey(seasonNumber ?? episode.season_number, episode.episode_number)]
  if (!release) return episode
  // Accept v1 string maps in tests/in-memory callers, while persisted v1 keys
  // are isolated by the v2 cache prefixes.
  return {
    ...episode,
    ...(typeof release === 'string' ? { airstamp: release } : release),
  }
}

export function attachDetailsReleaseData(details, releaseMap) {
  if (!details) return details
  return {
    ...details,
    next_episode_to_air: attachEpisodeReleaseData(details.next_episode_to_air, releaseMap),
    last_episode_to_air: attachEpisodeReleaseData(details.last_episode_to_air, releaseMap),
  }
}
