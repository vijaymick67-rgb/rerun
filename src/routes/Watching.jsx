import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getShowDetails, getSeasonEpisodes } from '../lib/tmdb'
import { episodeKey, computeNextUp } from '../lib/watchHelpers'
import { dayShiftForNetworks } from '../lib/networkReleaseTiming'
import ConfirmDialog from '../components/ConfirmDialog'
import WatchingRow from '../components/WatchingRow'
import WatchingRowSkeleton from '../components/WatchingRowSkeleton'

const CACHE_KEY = 'watching_cache:v1'

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function saveCache(shows) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(shows))
  } catch {
    // ignore quota/serialization errors, cache is best-effort
  }
}

export default function Watching() {
  const [cachedShows] = useState(() => loadCache())
  const [shows, setShows] = useState(() => cachedShows ?? [])
  const [loading, setLoading] = useState(() => cachedShows === null)
  const [error, setError] = useState(null)
  const [removingIds, setRemovingIds] = useState(new Set())
  const [confirmingShow, setConfirmingShow] = useState(null)
  const [openSwipeId, setOpenSwipeId] = useState(null)

  useEffect(() => {
    let ignore = false

    async function load() {
      setError(null)
      try {
        const { data: trackedShows, error: showsError } = await supabase
          .from('tracked_shows')
          .select('*')
          .order('added_at', { ascending: false })
        if (showsError) throw showsError

        if (!trackedShows || trackedShows.length === 0) {
          if (!ignore) {
            setShows([])
            saveCache([])
          }
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

              const episodesArrays = await Promise.all(
                seasons.map((season) => getSeasonEpisodes(show.tmdb_id, season.season_number)),
              )
              seasons.forEach((season, i) => {
                episodesBySeason[season.season_number] = episodesArrays[i].episodes
              })
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
        saveCache(enriched)
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
    setOpenSwipeId(null)
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
      setShows((prev) => {
        const next = prev.filter((s) => s.id !== show.id)
        saveCache(next)
        return next
      })
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

      {loading && (
        <div className="mt-4 flex flex-col gap-3">
          <WatchingRowSkeleton />
          <WatchingRowSkeleton />
          <WatchingRowSkeleton />
        </div>
      )}

      {error && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss"
            className="shrink-0 text-red-400/80 hover:text-red-400"
          >
            ✕
          </button>
        </div>
      )}

      {!loading && !error && shows.length === 0 && (
        <p className="mt-8 text-center text-(--color-text-muted)">
          No shows yet. Add some from Browse.
        </p>
      )}

      {!loading && shows.length > 0 && (
        <div className="mt-4 flex flex-col gap-3">
          {shows.map((show) => (
            <WatchingRow
              key={show.id}
              show={show}
              isRemoving={removingIds.has(show.id)}
              isOpen={openSwipeId === show.id}
              onOpenChange={setOpenSwipeId}
              onRemove={handleRemove}
            />
          ))}
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
