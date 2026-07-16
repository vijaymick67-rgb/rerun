import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getExternalIds, getShowDetails, getSeasonEpisodes } from '../lib/tmdb'
import { getShowReleaseMap } from '../lib/tvmaze'
import { episodeKey } from '../lib/watchHelpers'
import { fetchWatchedEpisodes } from '../lib/watchedEpisodes'
import { isHiddenShow, isVisibleInWatching } from '../lib/finishedShows'
import {
  enrichTrackedShowsForWatching,
  selectTrackedShowsForWatching,
} from '../lib/watchingShows'
import { loadWatchingCache, saveWatchingCache } from '../lib/watchingCache'
import { reportDataError, withTimeout } from '../lib/dataLoading'
import ConfirmDialog from '../components/ConfirmDialog'
import WatchingRow from '../components/WatchingRow'
import WatchingRowSkeleton from '../components/WatchingRowSkeleton'

// v2: shows now carry `status` (nextUp/countdown/caughtUp/completed) instead
// of a bare `nextUp` — bumped so a stale v1 entry doesn't briefly render as
// "Caught up" before the fresh load overwrites it.
// v3: one-time cache-bust so the Settings bulk-mark-watched writes are picked
// up — old v2 entries are simply never matched and a fresh Supabase fetch runs.
export default function Watching() {
  const [cachedShows] = useState(() => loadWatchingCache()?.filter((show) => !isHiddenShow(show)) ?? null)
  const [shows, setShows] = useState(() => cachedShows ?? [])
  const [loading, setLoading] = useState(() => cachedShows === null)
  const [error, setError] = useState(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [removingIds, setRemovingIds] = useState(new Set())
  const [confirmingShow, setConfirmingShow] = useState(null)
  const [openSwipeId, setOpenSwipeId] = useState(null)

  useEffect(() => {
    let ignore = false

    async function load() {
      setError(null)
      try {
        const { data: trackedShows, error: showsError } = await withTimeout((signal) => {
          let query = supabase.from('tracked_shows').select('*').order('added_at', { ascending: false })
          if (signal && typeof query.abortSignal === 'function') query = query.abortSignal(signal)
          return query
        }, { stage: 'watching-tracked-shows', source: 'supabase' })
        if (showsError) throw showsError

        if (!trackedShows || trackedShows.length === 0) {
          if (!ignore) {
            setShows([])
            saveWatchingCache([])
          }
          return
        }

        const { candidates, preloadedById } = await withTimeout(
          () => selectTrackedShowsForWatching(
            trackedShows,
            getShowDetails,
            (tmdbId) => getShowReleaseMap(tmdbId, { getExternalIds }),
          ),
          { stage: 'watching-selection', source: 'tmdb' },
        )

        if (candidates.length === 0) {
          if (!ignore) {
            setShows([])
            saveWatchingCache([])
          }
          return
        }

        const tmdbIds = candidates.map((show) => show.tmdb_id)
        const watchedRows = await withTimeout(
          (signal) => fetchWatchedEpisodes(
            supabase,
            'tmdb_show_id, season_number, episode_number',
            tmdbIds,
            { signal },
          ),
          { stage: 'watching-watched-episodes', source: 'supabase' },
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

        const enriched = await withTimeout(
          () => enrichTrackedShowsForWatching(
            candidates,
            watchedByShowId,
            preloadedById,
            {
              getShowDetails,
              getSeasonEpisodes,
              getShowReleaseMap: (tmdbId) => getShowReleaseMap(tmdbId, { getExternalIds }),
            },
          ),
          { stage: 'watching-enrichment', source: 'tmdb' },
        )

        if (ignore) return

        const statusRank = { nextUp: 0, countdown: 1, caughtUp: 2, completed: 3 }
        enriched.sort((a, b) => {
          const rankDiff = statusRank[a.status.type] - statusRank[b.status.type]
          if (rankDiff !== 0) return rankDiff
          if (a.status.type === 'nextUp') return a.status.air_date < b.status.air_date ? -1 : 1
          // Clamp at 0: after computeWatchingStatus only emits a countdown for
          // still-future releases this can't go negative, but guard so a stale
          // date can never sort ahead of a genuine soonest-first ordering.
          if (a.status.type === 'countdown') {
            return Math.max(0, a.status.daysUntil) - Math.max(0, b.status.daysUntil)
          }
          return new Date(b.added_at) - new Date(a.added_at)
        })

        setShows(enriched)
        saveWatchingCache(enriched)
      } catch (loadFailure) {
        const diagnostic = reportDataError(loadFailure, {
          stage: loadFailure?.stage ?? 'watching-load',
          source: loadFailure?.source ?? 'unknown',
        })
        if (!ignore) setError({
          message: cachedShows ? 'Couldn’t refresh your shows.' : 'Failed to load your shows.',
          code: diagnostic.code,
        })
      } finally {
        if (!ignore) setLoading(false)
      }
    }

    load()
    return () => {
      ignore = true
    }
  }, [cachedShows, loadAttempt])

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
        saveWatchingCache(next)
        return next
      })
    }
    setRemovingIds((prev) => {
      const next = new Set(prev)
      next.delete(show.id)
      return next
    })
  }

  const visibleShows = shows.filter((show) => isVisibleInWatching(show, show.status))

  return (
    <div className="app-page px-4 pb-4">
      {loading && (
        <div className="flex flex-col gap-3">
          <WatchingRowSkeleton />
          <WatchingRowSkeleton />
          <WatchingRowSkeleton />
        </div>
      )}

      {error && (
        <div className="motion-banner mt-4 flex items-center justify-between gap-3 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <span>{error.message} <span className="whitespace-nowrap">({error.code})</span></span>
          <button
            type="button"
            onClick={() => {
              setLoading(cachedShows === null)
              setLoadAttempt((attempt) => attempt + 1)
            }}
            className="motion-press min-h-11 shrink-0 rounded-md px-3 font-semibold text-red-300"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && shows.length === 0 && (
        <p className="mt-8 text-center text-(--color-text-muted)">
          No shows yet. Add some from Discover.
        </p>
      )}

      {!loading && !error && shows.length > 0 && visibleShows.length === 0 && (
        <p className="mt-8 text-center text-(--color-text-muted)">
          Nothing airing soon.
        </p>
      )}

      {!loading && visibleShows.length > 0 && (
        <div className="flex flex-col gap-3">
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
