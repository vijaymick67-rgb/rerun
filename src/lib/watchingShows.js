import { computeWatchingStatus } from './watchHelpers.js'
import { isHiddenShow, isPersonallyFinished, shouldFinishedShowReturn } from './finishedShows.js'
import { releaseRuleForShow } from './networkReleaseTiming.js'

// Stage 1: all unfinished shows remain candidates. Finished shows receive only
// a lightweight show-details request; ineligible archives stop here.
export async function selectTrackedShowsForWatching(trackedShows, getShowDetails) {
  const visibleShows = trackedShows.filter((show) => !isHiddenShow(show))
  const unfinished = visibleShows.filter((show) => !isPersonallyFinished(show))
  const finished = visibleShows.filter(isPersonallyFinished)

  const checkedFinished = await Promise.all(
    finished.map(async (show) => {
      try {
        const details = await getShowDetails(show.tmdb_id, { refreshDynamic: true })
        const releaseRule = releaseRuleForShow(show.tmdb_id, details.networks)
        return shouldFinishedShowReturn(show, details, releaseRule)
          ? { show, details, releaseRule }
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
      returning.map((entry) => [entry.show.tmdb_id, { details: entry.details, releaseRule: entry.releaseRule }]),
    ),
  }
}

// Stage 2: only candidates fetch seasons. Promise.all at both levels preserves
// the existing parallel loading behavior and avoids a serial waterfall.
export async function enrichTrackedShowsForWatching(
  candidates,
  watchedByShowId,
  preloadedById,
  { getShowDetails, getSeasonEpisodes },
) {
  return Promise.all(
    candidates.map(async (show) => {
      const watched = watchedByShowId.get(show.tmdb_id) ?? new Set()
      const episodesBySeason = {}
      let loadError = false
      let details = preloadedById.get(show.tmdb_id)?.details ?? null
      let releaseRule = preloadedById.get(show.tmdb_id)?.releaseRule

      try {
        if (!details) {
          details = await getShowDetails(show.tmdb_id)
          releaseRule = releaseRuleForShow(show.tmdb_id, details.networks)
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
      } catch {
        loadError = true
      }

      return {
        ...show,
        loadError,
        status: computeWatchingStatus(episodesBySeason, watched, releaseRule, details),
      }
    }),
  )
}
