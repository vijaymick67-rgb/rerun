import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getShowDetails, getSeasonEpisodes, POSTER_BASE } from '../lib/tmdb'
import { episodeKey, computeNextUp } from '../lib/watchHelpers'
import { dayShiftForNetworks } from '../lib/networkReleaseTiming'
import ConfirmDialog from '../components/ConfirmDialog'

export default function Watching() {
  const [shows, setShows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [removingIds, setRemovingIds] = useState(new Set())
  const [confirmingShow, setConfirmingShow] = useState(null)

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

            let dayShift = 0
            try {
              const details = await getShowDetails(show.tmdb_id)
              dayShift = dayShiftForNetworks(details.networks)
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
              loadError,
              nextUp: computeNextUp(episodesBySeason, watched, dayShift),
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

  function handleRemove(show) {
    setConfirmingShow(show)
  }

  async function confirmRemove() {
    const show = confirmingShow
    if (!show) return
    setConfirmingShow(null)

    setRemovingIds((prev) => new Set(prev).add(show.id))
    const { error: deleteError } = await supabase
      .from('tracked_shows')
      .delete()
      .eq('id', show.id)

    if (!deleteError) {
      setShows((prev) => prev.filter((s) => s.id !== show.id))
    }
    setRemovingIds((prev) => {
      const next = new Set(prev)
      next.delete(show.id)
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
            const isRemoving = removingIds.has(show.id)

            return (
              <div
                key={show.id}
                className="flex gap-3 overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface) p-3"
              >
                <Link
                  to={`/watching/${show.tmdb_id}`}
                  className="flex flex-1 items-center gap-3 text-left"
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

                  <span aria-hidden="true" className="shrink-0 text-(--color-text-muted)">
                    ›
                  </span>
                </Link>

                <button
                  type="button"
                  onClick={() => handleRemove(show)}
                  disabled={isRemoving}
                  className="h-fit shrink-0 rounded-md px-2 py-1.5 text-xs font-medium text-(--color-text-muted) disabled:opacity-60"
                >
                  {isRemoving ? 'Removing…' : 'Remove'}
                </button>
              </div>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        open={confirmingShow !== null}
        title="Remove show?"
        message={
          confirmingShow
            ? `Remove "${confirmingShow.name}" from Watching? Your watch history won't be deleted.`
            : ''
        }
        confirmLabel="Remove"
        cancelLabel="Cancel"
        danger
        onConfirm={confirmRemove}
        onCancel={() => setConfirmingShow(null)}
      />
    </div>
  )
}
