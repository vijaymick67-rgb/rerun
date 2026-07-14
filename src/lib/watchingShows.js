import { computeWatchingStatus, episodeKey } from './watchHelpers.js'
import { isHiddenShow, isPersonallyFinished, shouldFinishedShowReturn } from './finishedShows.js'

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
        return shouldFinishedShowReturn(show, details)
          ? { show, details }
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
      returning.map((entry) => [entry.show.tmdb_id, { details: entry.details }]),
    ),
  }
}

// Stage 2: only candidates fetch seasons. Promise.all at both levels preserves
// the existing parallel loading behavior and avoids a serial waterfall.
export async function enrichTrackedShowsForWatching(
  candidates,
  watchedByShowId,
  preloadedById,
  { getShowDetails, getSeasonEpisodes, getShowAirstamps },
) {
  return Promise.all(
    candidates.map(async (show) => {
      const watched = watchedByShowId.get(show.tmdb_id) ?? new Set()
      let episodesBySeason = {}
      let loadError = false
      let details = preloadedById.get(show.tmdb_id)?.details ?? null

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
        if (getShowAirstamps) {
          const airstamps = await getShowAirstamps(show.tmdb_id)
          if (airstamps && Object.keys(airstamps).length > 0) {
            episodesBySeason = attachAirstamps(episodesBySeason, airstamps)
            details = attachNextEpisodeAirstamp(details, airstamps)
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

// Return a copy of episodesBySeason with each episode's TVmaze `airstamp`
// attached where a season:episode match exists. Episodes without a match are
// left untouched (they keep resolving via the universal anchor).
function attachAirstamps(episodesBySeason, airstamps) {
  const out = {}
  for (const [seasonNumber, episodes] of Object.entries(episodesBySeason)) {
    out[seasonNumber] = (episodes ?? []).map((ep) => {
      const airstamp = airstamps[episodeKey(Number(seasonNumber), ep.episode_number)]
      return airstamp ? { ...ep, airstamp } : ep
    })
  }
  return out
}

// Attach the matching TVmaze airstamp to details.next_episode_to_air, so the
// countdown branch resolves off the true release instant too. No-op when the
// pointer is absent or has no TVmaze match.
function attachNextEpisodeAirstamp(details, airstamps) {
  const next = details?.next_episode_to_air
  if (!next) return details
  const airstamp = airstamps[episodeKey(next.season_number, next.episode_number)]
  if (!airstamp) return details
  return { ...details, next_episode_to_air: { ...next, airstamp } }
}
