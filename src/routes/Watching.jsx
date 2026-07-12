import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getShowDetails, getSeasonEpisodes } from '../lib/tmdb'
import { episodeKey, computeWatchingStatus, isHiddenFromWatching } from '../lib/watchHelpers'
import { fetchWatchedEpisodes } from '../lib/watchedEpisodes'
import { dayShiftForNetworks } from '../lib/networkReleaseTiming'
import ConfirmDialog from '../components/ConfirmDialog'
import WatchingRow from '../components/WatchingRow'
import WatchingRowSkeleton from '../components/WatchingRowSkeleton'

// v2: shows now carry `status` (nextUp/countdown/caughtUp/completed) instead
// of a bare `nextUp` — bumped so a stale v1 entry doesn't briefly render as
// "Caught up" before the fresh load overwrites it.
// v3: one-time cache-bust so the Settings bulk-mark-watched writes are picked
// up — old v2 entries are simply never matched and a fresh Supabase fetch runs.
const CACHE_KEY = 'watching_cache:v3'

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
        const watchedRows = await fetchWatchedEpisodes(
          supabase,
          'tmdb_show_id, season_number, episode_number',
          tmdbIds,
        )

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
            let details = null
            try {
              details = await getShowDetails(show.tmdb_id)
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
              status: computeWatchingStatus(episodesBySeason, watched, dayShift, details),
            }
          }),
        )

        if (ignore) return

        const statusRank = { nextUp: 0, countdown: 1, caughtUp: 2, completed: 3 }
        enriched.sort((a, b) => {
          const rankDiff = statusRank[a.status.type] - statusRank[b.status.type]
          if (rankDiff !== 0) return rankDiff
          if (a.status.type === 'nextUp') return a.status.air_date < b.status.air_date ? -1 : 1
          if (a.status.type === 'countdown') return a.status.daysUntil - b.status.daysUntil
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

  const visibleShows = shows.filter((show) => !isHiddenFromWatching(show.status))

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

      {!loading && !error && shows.length > 0 && visibleShows.length === 0 && (
        <p className="mt-8 text-center text-(--color-text-muted)">
          Nothing airing soon.
        </p>
      )}

      {!loading && visibleShows.length > 0 && (
        <div className="mt-4 flex flex-col gap-3">
          {visibleShows.map((show) => (
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
