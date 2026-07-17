import { useEffect, useRef, useState } from 'react'
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

function sortWatchingShows(shows) {
  const statusRank = { nextUp: 0, countdown: 1, caughtUp: 2, completed: 3 }
  return [...shows].sort((a, b) => {
    const rankDiff = statusRank[a.status.type] - statusRank[b.status.type]
    if (rankDiff !== 0) return rankDiff
    if (a.status.type === 'nextUp') return a.status.air_date < b.status.air_date ? -1 : 1
    if (a.status.type === 'countdown') {
      return Math.max(0, a.status.daysUntil) - Math.max(0, b.status.daysUntil)
    }
    return new Date(b.added_at) - new Date(a.added_at)
  })
}

export function WatchingPartialWarning({ error, onRetry }) {
  if (!error) return null
  return (
    <div className="motion-banner mt-4 flex items-center justify-between gap-3 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
      <span>Some show details couldn’t refresh. <span className="whitespace-nowrap">({error.code})</span></span>
      <button
        type="button"
        onClick={onRetry}
        className="motion-press min-h-11 shrink-0 rounded-md px-3 font-semibold text-amber-200"
      >
        Retry
      </button>
    </div>
  )
}

// v2: shows now carry `status` (nextUp/countdown/caughtUp/completed) instead
// of a bare `nextUp` — bumped so a stale v1 entry doesn't briefly render as
// "Caught up" before the fresh load overwrites it.
// v3: one-time cache-bust so the Settings bulk-mark-watched writes are picked
// up — old v2 entries are simply never matched and a fresh Supabase fetch runs.
export default function Watching({ refreshSignal = 0 }) {
  const [cachedShows] = useState(() => loadWatchingCache()?.filter((show) => !isHiddenShow(show)) ?? null)
  const [shows, setShows] = useState(() => cachedShows ?? [])
  const [loading, setLoading] = useState(() => cachedShows === null)
  const [error, setError] = useState(null)
  const [partialError, setPartialError] = useState(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [removingIds, setRemovingIds] = useState(new Set())
  const [confirmingShow, setConfirmingShow] = useState(null)
  const [openSwipeId, setOpenSwipeId] = useState(null)

  // Latest rendered rows, readable synchronously inside the loader. A background
  // refresh seeds its streaming merge from what's already on screen (not the
  // mount-time cache snapshot), so rows update in place instead of collapsing
  // and re-growing.
  const showsRef = useRef(shows)
  showsRef.current = shows

  // The Watching instance is preserved (not remounted) while a Show/Season
  // detail route is open, so `refreshSignal` — bumped by the router each time we
  // return from a detail route — is how a background refresh is requested. It
  // re-runs the loader WITHOUT flipping `loading` on, so already-rendered rows
  // stay put (no skeleton, no page reconstruction) while newly-marked watched
  // episodes stream in and re-sort in place.
  const seenRefreshSignalRef = useRef(refreshSignal)
  useEffect(() => {
    if (seenRefreshSignalRef.current === refreshSignal) return
    seenRefreshSignalRef.current = refreshSignal
    setLoadAttempt((attempt) => attempt + 1)
  }, [refreshSignal])

  useEffect(() => {
    let ignore = false

    async function load() {
      setError(null)
      setPartialError(null)
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

        const selection = await selectTrackedShowsForWatching(
          trackedShows,
          getShowDetails,
          (tmdbId) => getShowReleaseMap(tmdbId, { getExternalIds }),
          { deferFinished: true },
        )
        const seedShows = showsRef.current?.length ? showsRef.current : (cachedShows ?? [])
        const renderedById = new Map(seedShows.map((show) => [show.tmdb_id, show]))
        const freshById = new Map()
        let renderedAny = renderedById.size > 0
        let partialFailureCount = 0
        let refreshHadFailure = false

        const mergeRenderedShow = (show) => {
          if (ignore) return
          renderedAny = true
          renderedById.set(show.tmdb_id, show)
          freshById.set(show.tmdb_id, show)
          const next = sortWatchingShows([...renderedById.values()])
          setShows(next)
          setLoading(false)
          if (show.loadError) {
            refreshHadFailure = true
            partialFailureCount += 1
            setPartialError({
              code: show.loadDiagnostics?.[0]?.code ?? 'DATA-UNKNOWN',
              count: partialFailureCount,
            })
          }
        }

        const loadCandidateBatch = async (candidates, preloadedById) => {
          if (candidates.length === 0) return []
          const tmdbIds = candidates.map((show) => show.tmdb_id)
          let watchedRows
          try {
            watchedRows = await withTimeout(
              (signal) => fetchWatchedEpisodes(
                supabase,
                'tmdb_show_id, season_number, episode_number',
                tmdbIds,
                { signal },
              ),
              { stage: 'watching-watched-episodes', source: 'supabase' },
            )
          } catch (loadFailure) {
            if (renderedAny) {
              refreshHadFailure = true
              const diagnostic = reportDataError(loadFailure, {
                stage: loadFailure?.stage ?? 'watching-watched-episodes',
                source: loadFailure?.source ?? 'supabase',
              })
              setPartialError({ code: diagnostic.code, count: 1 })
              return []
            }
            throw loadFailure
          }

          const watchedByShowId = new Map()
          for (const row of watchedRows ?? []) {
            if (!watchedByShowId.has(row.tmdb_show_id)) {
              watchedByShowId.set(row.tmdb_show_id, new Set())
            }
            watchedByShowId
              .get(row.tmdb_show_id)
              .add(episodeKey(row.season_number, row.episode_number))
          }

          return enrichTrackedShowsForWatching(
            candidates,
            watchedByShowId,
            preloadedById,
            {
              getShowDetails,
              getSeasonEpisodes,
              getShowReleaseMap: (tmdbId) => getShowReleaseMap(tmdbId, { getExternalIds }),
            },
            { onShowSettled: mergeRenderedShow },
          )
        }

        const initialLoad = loadCandidateBatch(selection.candidates, selection.preloadedById)
        const finishedLoad = selection.pendingFinished.then(async (finishedEntries) => {
          const returning = finishedEntries.filter(Boolean)
          const candidates = returning.map((entry) => entry.show)
          const preloadedById = new Map(
            returning.filter((entry) => entry.details).map((entry) => [entry.show.tmdb_id, {
              details: entry.details,
              releaseMap: entry.releaseMap,
            }]),
          )
          return loadCandidateBatch(candidates, preloadedById)
        })

        const [initialEnriched, finishedEnriched] = await Promise.all([initialLoad, finishedLoad])
        if (!ignore) {
          const enriched = [...initialEnriched, ...finishedEnriched]
          const nextSource = refreshHadFailure
            ? [...renderedById.values()]
            : (enriched.length > 0 ? [...freshById.values()] : [])
          const next = sortWatchingShows(nextSource)
          setShows(next)
          saveWatchingCache(next)
          if (next.length === 0) setLoading(false)
        }
      } catch (loadFailure) {
        const diagnostic = reportDataError(loadFailure, {
          stage: loadFailure?.stage ?? 'watching-load',
          source: loadFailure?.source ?? 'unknown',
        })
        if (!ignore) setError({
          message: (cachedShows || showsRef.current?.length)
            ? 'Couldn’t refresh your shows.'
            : 'Failed to load your shows.',
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

      {!error && (
        <WatchingPartialWarning
          error={partialError}
          onRetry={() => {
            setLoading(cachedShows === null)
            setLoadAttempt((attempt) => attempt + 1)
          }}
        />
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
