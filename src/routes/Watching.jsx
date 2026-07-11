import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getShowDetails, getSeasonEpisodes, POSTER_BASE } from '../lib/tmdb'

function episodeKey(seasonNumber, episodeNumber) {
  return `${seasonNumber}:${episodeNumber}`
}

function seasonKey(tmdbId, seasonNumber) {
  return `${tmdbId}:${seasonNumber}`
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

function formatDate(dateString) {
  if (!dateString) return null
  const date = new Date(dateString + 'T00:00:00')
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// First unwatched episode that has already aired, scanning seasons in order.
function computeNextUp(episodesBySeason, watched) {
  const today = todayISO()
  const seasonNumbers = Object.keys(episodesBySeason)
    .map(Number)
    .sort((a, b) => a - b)

  for (const seasonNumber of seasonNumbers) {
    for (const ep of episodesBySeason[seasonNumber]) {
      const key = episodeKey(seasonNumber, ep.episode_number)
      if (!watched.has(key) && ep.air_date && ep.air_date <= today) {
        return {
          season_number: seasonNumber,
          episode_number: ep.episode_number,
          name: ep.name,
          air_date: ep.air_date,
        }
      }
    }
  }
  return null
}

export default function Watching() {
  const [shows, setShows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [expandedSeasons, setExpandedSeasons] = useState(new Set())
  const [busyEpisodes, setBusyEpisodes] = useState(new Set())
  const [busySeasons, setBusySeasons] = useState(new Set())
  const [removingIds, setRemovingIds] = useState(new Set())

  useEffect(() => {
    let ignore = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const { data: trackedShows, error: showsError } = await supabase
          .from('tracked_shows')
          .select('*')
          .order('added_at', { ascending: false })
        if (showsError) throw showsError

        if (!trackedShows || trackedShows.length === 0) {
          if (!ignore) setShows([])
          return
        }

        const tmdbIds = trackedShows.map((show) => show.tmdb_id)
        const { data: watchedRows, error: watchedError } = await supabase
          .from('watched_episodes')
          .select('tmdb_show_id, season_number, episode_number')
          .in('tmdb_show_id', tmdbIds)
        if (watchedError) throw watchedError

        const watchedByShowId = new Map()
        for (const row of watchedRows ?? []) {
          if (!watchedByShowId.has(row.tmdb_show_id)) {
            watchedByShowId.set(row.tmdb_show_id, new Set())
          }
          watchedByShowId
            .get(row.tmdb_show_id)
            .add(episodeKey(row.season_number, row.episode_number))
        }

        const enriched = await Promise.all(
          trackedShows.map(async (show) => {
            const watched = watchedByShowId.get(show.tmdb_id) ?? new Set()
            const episodesBySeason = {}
            let loadError = false

            try {
              const details = await getShowDetails(show.tmdb_id)
              const seasons = (details.seasons ?? [])
                .filter((season) => season.season_number > 0)
                .sort((a, b) => a.season_number - b.season_number)

              for (const season of seasons) {
                const seasonData = await getSeasonEpisodes(show.tmdb_id, season.season_number)
                episodesBySeason[season.season_number] = seasonData.episodes
              }
            } catch {
              loadError = true
            }

            return {
              ...show,
              watched,
              episodesBySeason,
              loadError,
              nextUp: computeNextUp(episodesBySeason, watched),
            }
          }),
        )

        if (ignore) return

        enriched.sort((a, b) => {
          if (a.nextUp && b.nextUp) return a.nextUp.air_date < b.nextUp.air_date ? -1 : 1
          if (a.nextUp) return -1
          if (b.nextUp) return 1
          return new Date(b.added_at) - new Date(a.added_at)
        })

        setShows(enriched)
      } catch {
        if (!ignore) setError('Failed to load your shows. Try refreshing.')
      } finally {
        if (!ignore) setLoading(false)
      }
    }

    load()
    return () => {
      ignore = true
    }
  }, [])

  function updateShowWatched(tmdbId, updater) {
    setShows((prev) =>
      prev.map((show) => {
        if (show.tmdb_id !== tmdbId) return show
        const nextWatched = updater(show.watched)
        return {
          ...show,
          watched: nextWatched,
          nextUp: computeNextUp(show.episodesBySeason, nextWatched),
        }
      }),
    )
  }

  async function toggleEpisode(show, seasonNumber, episode) {
    const key = `${show.tmdb_id}:${seasonNumber}:${episode.episode_number}`
    if (busyEpisodes.has(key)) return
    setBusyEpisodes((prev) => new Set(prev).add(key))

    const wasWatched = show.watched.has(episodeKey(seasonNumber, episode.episode_number))

    try {
      if (wasWatched) {
        const { error: deleteError } = await supabase
          .from('watched_episodes')
          .delete()
          .eq('tmdb_show_id', show.tmdb_id)
          .eq('season_number', seasonNumber)
          .eq('episode_number', episode.episode_number)
        if (deleteError) throw deleteError
      } else {
        const { error: upsertError } = await supabase.from('watched_episodes').upsert(
          {
            tmdb_show_id: show.tmdb_id,
            season_number: seasonNumber,
            episode_number: episode.episode_number,
            episode_name: episode.name,
            runtime_minutes: episode.runtime,
            watched_at: new Date().toISOString(),
          },
          { onConflict: 'tmdb_show_id,season_number,episode_number' },
        )
        if (upsertError) throw upsertError
      }

      updateShowWatched(show.tmdb_id, (watched) => {
        const next = new Set(watched)
        const wKey = episodeKey(seasonNumber, episode.episode_number)
        if (wasWatched) next.delete(wKey)
        else next.add(wKey)
        return next
      })
    } finally {
      setBusyEpisodes((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  async function markSeasonWatched(show, seasonNumber) {
    const key = seasonKey(show.tmdb_id, seasonNumber)
    if (busySeasons.has(key)) return
    setBusySeasons((prev) => new Set(prev).add(key))

    const episodes = show.episodesBySeason[seasonNumber] ?? []
    const now = new Date().toISOString()
    const rows = episodes.map((ep) => ({
      tmdb_show_id: show.tmdb_id,
      season_number: seasonNumber,
      episode_number: ep.episode_number,
      episode_name: ep.name,
      runtime_minutes: ep.runtime,
      watched_at: now,
    }))

    try {
      const { error: upsertError } = await supabase
        .from('watched_episodes')
        .upsert(rows, { onConflict: 'tmdb_show_id,season_number,episode_number' })
      if (upsertError) throw upsertError

      updateShowWatched(show.tmdb_id, (watched) => {
        const next = new Set(watched)
        for (const ep of episodes) next.add(episodeKey(seasonNumber, ep.episode_number))
        return next
      })
    } finally {
      setBusySeasons((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  async function handleRemove(show) {
    const confirmed = window.confirm(
      `Remove "${show.name}" from Watching? Your watch history won't be deleted.`,
    )
    if (!confirmed) return

    setRemovingIds((prev) => new Set(prev).add(show.id))
    const { error: deleteError } = await supabase
      .from('tracked_shows')
      .delete()
      .eq('id', show.id)

    if (!deleteError) {
      setShows((prev) => prev.filter((s) => s.id !== show.id))
      if (expandedId === show.id) setExpandedId(null)
    }
    setRemovingIds((prev) => {
      const next = new Set(prev)
      next.delete(show.id)
      return next
    })
  }

  function toggleExpanded(show) {
    if (expandedId === show.id) {
      setExpandedId(null)
      return
    }
    setExpandedId(show.id)
    const openKey = show.nextUp
      ? seasonKey(show.tmdb_id, show.nextUp.season_number)
      : seasonKey(show.tmdb_id, Object.keys(show.episodesBySeason).map(Number).sort((a, b) => a - b)[0])
    setExpandedSeasons((prev) => new Set(prev).add(openKey))
  }

  function toggleSeason(show, seasonNumber) {
    const key = seasonKey(show.tmdb_id, seasonNumber)
    setExpandedSeasons((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="p-4">
      <h1 className="text-xl font-semibold text-(--color-text)">Watching</h1>

      {loading && <p className="mt-4 text-sm text-(--color-text-muted)">Loading…</p>}

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      {!loading && !error && shows.length === 0 && (
        <p className="mt-8 text-center text-(--color-text-muted)">
          No shows yet. Add some from Browse.
        </p>
      )}

      {!loading && !error && shows.length > 0 && (
        <div className="mt-4 flex flex-col gap-3">
          {shows.map((show) => {
            const isExpanded = expandedId === show.id
            const isRemoving = removingIds.has(show.id)
            const seasonNumbers = Object.keys(show.episodesBySeason)
              .map(Number)
              .sort((a, b) => a - b)

            return (
              <div
                key={show.id}
                className="overflow-hidden rounded-lg bg-(--color-surface)"
              >
                <div className="flex gap-3 p-3">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(show)}
                    className="flex flex-1 gap-3 text-left"
                  >
                    {show.poster_path ? (
                      <img
                        src={POSTER_BASE + show.poster_path}
                        alt={show.name}
                        className="h-24 w-16 shrink-0 rounded-md object-cover"
                      />
                    ) : (
                      <div className="flex h-24 w-16 shrink-0 items-center justify-center rounded-md bg-(--color-surface-raised) text-xs text-(--color-text-muted)">
                        No poster
                      </div>
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-(--color-text)">
                        {show.name}
                      </p>

                      {show.nextUp ? (
                        <p className="mt-1 text-xs text-(--color-accent)">
                          Up next: S{show.nextUp.season_number}E{show.nextUp.episode_number}
                          {show.nextUp.name ? ` · ${show.nextUp.name}` : ''}
                        </p>
                      ) : show.loadError ? (
                        <p className="mt-1 text-xs text-red-400">Couldn't load episodes</p>
                      ) : (
                        <p className="mt-1 text-xs text-(--color-text-muted)">Caught up</p>
                      )}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleRemove(show)}
                    disabled={isRemoving}
                    className="h-fit shrink-0 rounded-md px-2 py-1.5 text-xs font-medium text-(--color-text-muted) disabled:opacity-60"
                  >
                    {isRemoving ? 'Removing…' : 'Remove'}
                  </button>
                </div>

                {isExpanded && (
                  <div className="border-t border-(--color-border) px-3 pb-3">
                    {show.loadError && seasonNumbers.length === 0 && (
                      <p className="pt-3 text-sm text-red-400">
                        Couldn't load episode data for this show.
                      </p>
                    )}

                    {seasonNumbers.map((seasonNumber) => {
                      const episodes = show.episodesBySeason[seasonNumber]
                      const watchedCount = episodes.filter((ep) =>
                        show.watched.has(episodeKey(seasonNumber, ep.episode_number)),
                      ).length
                      const isSeasonExpanded = expandedSeasons.has(
                        seasonKey(show.tmdb_id, seasonNumber),
                      )
                      const isSeasonBusy = busySeasons.has(seasonKey(show.tmdb_id, seasonNumber))
                      const isFullyWatched = watchedCount === episodes.length

                      return (
                        <div key={seasonNumber} className="border-b border-(--color-border) py-2 last:border-b-0">
                          <button
                            type="button"
                            onClick={() => toggleSeason(show, seasonNumber)}
                            className="flex w-full items-center justify-between py-1 text-left"
                          >
                            <span className="text-sm font-medium text-(--color-text)">
                              Season {seasonNumber}
                            </span>
                            <span className="text-xs text-(--color-text-muted)">
                              {watchedCount}/{episodes.length}
                            </span>
                          </button>

                          {isSeasonExpanded && (
                            <div className="mt-2 flex flex-col gap-2">
                              {!isFullyWatched && (
                                <button
                                  type="button"
                                  onClick={() => markSeasonWatched(show, seasonNumber)}
                                  disabled={isSeasonBusy}
                                  className="self-start rounded-md bg-(--color-accent-muted) px-3 py-1.5 text-xs font-medium text-(--color-accent) disabled:opacity-60"
                                >
                                  {isSeasonBusy ? 'Marking…' : 'Mark season watched'}
                                </button>
                              )}

                              {episodes.map((ep) => {
                                const epKey = episodeKey(seasonNumber, ep.episode_number)
                                const isWatched = show.watched.has(epKey)
                                const busyKey = `${show.tmdb_id}:${seasonNumber}:${ep.episode_number}`
                                const isBusy = busyEpisodes.has(busyKey)
                                const hasAired = ep.air_date && ep.air_date <= todayISO()

                                return (
                                  <div
                                    key={ep.episode_number}
                                    className="flex items-center gap-2 rounded-md bg-(--color-surface-raised) px-3 py-2"
                                  >
                                    <div className="min-w-0 flex-1">
                                      <p className="truncate text-sm text-(--color-text)">
                                        {ep.episode_number}. {ep.name || 'Untitled'}
                                      </p>
                                      <p className="text-xs text-(--color-text-muted)">
                                        {hasAired
                                          ? formatDate(ep.air_date)
                                          : ep.air_date
                                            ? `Airs ${formatDate(ep.air_date)}`
                                            : 'No air date'}
                                      </p>
                                    </div>

                                    <button
                                      type="button"
                                      onClick={() => toggleEpisode(show, seasonNumber, ep)}
                                      disabled={isBusy || !hasAired}
                                      className={`shrink-0 rounded-md px-3 py-2 text-xs font-medium disabled:opacity-60 ${
                                        isWatched
                                          ? 'bg-(--color-accent) text-(--color-bg)'
                                          : 'bg-(--color-surface) text-(--color-text-muted)'
                                      }`}
                                    >
                                      {isWatched ? 'Watched' : 'Mark watched'}
                                    </button>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
