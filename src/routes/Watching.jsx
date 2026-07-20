import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { getExternalIds, getShowDetails, getSeasonEpisodes } from '../lib/tmdb'
import { getShowReleaseMap } from '../lib/tvmaze'
import { episodeKey } from '../lib/watchHelpers'
import { fetchWatchedEpisodes } from '../lib/watchedEpisodes'
import { isHiddenShow, isVisibleInWatching } from '../lib/finishedShows'
import {
  deriveWatchingFields,
  enrichTrackedShowsForWatching,
  selectTrackedShowsForWatching,
} from '../lib/watchingShows'
import { createWatchMutationQueue, toggleEpisodeOptimistically } from '../lib/seasonWatchMutations'
import { loadWatchingCache, saveWatchingCache } from '../lib/watchingCache'
import { reportDataError, withTimeout } from '../lib/dataLoading'
import { getWatchingInteractionState } from '../lib/watchingNavigation'
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
    <div className="motion-banner mt-4 flex items-center justify-between gap-3 rounded-lg border border-(--color-upcoming)/40 bg-(--color-upcoming-muted) px-3 py-2 text-sm text-(--color-upcoming)">
      <span>Some show details couldn’t refresh. <span className="whitespace-nowrap">({error.code})</span></span>
      <button
        type="button"
        onClick={onRetry}
        className="motion-press min-h-11 shrink-0 rounded-md px-3 font-semibold text-(--color-upcoming)"
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
export default function Watching({ active = true, refreshSignal = 0 }) {
  const [cachedShows] = useState(() => loadWatchingCache()?.filter((show) => !isHiddenShow(show)) ?? null)
  const [shows, setShows] = useState(() => cachedShows ?? [])
  const [loading, setLoading] = useState(() => cachedShows === null)
  const [error, setError] = useState(null)
  const [partialError, setPartialError] = useState(null)
  const [removeError, setRemoveError] = useState(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [removingIds, setRemovingIds] = useState(new Set())
  const [confirmingShow, setConfirmingShow] = useState(null)
  const [openSwipeId, setOpenSwipeId] = useState(null)
  const [quickMarkingIds, setQuickMarkingIds] = useState(new Set())
  const [quickMarkError, setQuickMarkError] = useState(null)

  // Show IDs (tmdb_id) whose in-memory mutation context (below) is populated
  // and ready. A cached row can render with a `nextReleasedUnwatchedEpisode`
  // long before this load's enrichment for that show has settled — without
  // this gate, a tap in that window would silently no-op (handleQuickMark
  // bails out when the context isn't there yet), which reads as a broken
  // button. WatchingRow hides the quick-mark control entirely until a show's
  // id is in this set.
  const [readyShowIds, setReadyShowIds] = useState(() => new Set())

  // Per-show episode/watched context kept in memory only (never persisted to
  // the cache — see watchingCache.js) so a quick-mark tap can re-derive the
  // row's status/progress/next-up locally, through the exact same
  // deriveWatchingFields() a fresh fetch uses, without a network round-trip
  // or remounting the route. Populated on every enrichment pass.
  const showContextRef = useRef(new Map())
  const quickMarkQueuesRef = useRef(new Map())

  // Per-show (by tracked_shows row id) local-mutation revision counters.
  // Bumped every time a quick mark commits (optimistically or on rollback).
  // A load's final commit stamps the revision it saw when each show settled
  // and, if the live revision has moved on since, keeps the live row instead
  // of overwriting it with that load's now-stale captured snapshot — this is
  // what stops a slow-finishing background refresh from silently reverting a
  // quick mark that landed on an already-settled row while other shows were
  // still loading.
  const localRevisionRef = useRef(new Map())
  function bumpLocalRevision(showId) {
    const next = (localRevisionRef.current.get(showId) ?? 0) + 1
    localRevisionRef.current.set(showId, next)
    return next
  }
  const interactionState = getWatchingInteractionState(
    active,
    openSwipeId,
    confirmingShow,
  )

  // The single Watching instance is mounted for the whole app lifetime, even
  // while another tab is on screen, so the initial data load must not fire until
  // the list is first actually shown. Otherwise a cold start on a different tab
  // would eagerly fetch the hidden list. Once shown, it stays loaded and only
  // refreshes quietly via `refreshSignal` on later returns.
  const [hasActivated, setHasActivated] = useState(active)
  useEffect(() => {
    if (active) setHasActivated(true)
  }, [active])

  // The list stays mounted while detail is open (or another tab is active), but
  // transient destructive UI must not stay armed behind the hidden subtree or
  // reappear on return.
  useEffect(() => {
    if (active) return
    setOpenSwipeId(null)
    setConfirmingShow(null)
  }, [active])

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
    if (!hasActivated) return undefined
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
        // Revision each show's local-mutation counter was at when this load
        // captured it into renderedById/freshById — see localRevisionRef above.
        const capturedRevisionById = new Map()
        let renderedAny = renderedById.size > 0
        let partialFailureCount = 0
        let refreshHadFailure = false

        // If a quick mark commits for `showId` after this load already
        // captured that show, the captured copy in `list` is stale — keep
        // whatever's live in showsRef.current instead of reverting it.
        const reconcileWithLiveMutations = (list) => {
          const currentById = new Map(showsRef.current.map((s) => [s.id, s]))
          return list.map((show) => {
            const capturedRevision = capturedRevisionById.get(show.id) ?? 0
            const liveRevision = localRevisionRef.current.get(show.id) ?? 0
            if (liveRevision !== capturedRevision) return currentById.get(show.id) ?? show
            return show
          })
        }

        const mergeRenderedShow = (show, loaded) => {
          if (ignore) return
          renderedAny = true
          renderedById.set(show.tmdb_id, show)
          freshById.set(show.tmdb_id, show)
          capturedRevisionById.set(show.id, localRevisionRef.current.get(show.id) ?? 0)
          if (loaded?.episodesBySeason) {
            showContextRef.current.set(show.tmdb_id, {
              episodesBySeason: loaded.episodesBySeason,
              details: loaded.details ?? {},
              watched: loaded.watched ?? new Set(),
            })
            setReadyShowIds((prev) => {
              if (prev.has(show.tmdb_id)) return prev
              const next = new Set(prev)
              next.add(show.tmdb_id)
              return next
            })
          }
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
            ? reconcileWithLiveMutations([...renderedById.values()])
            : (enriched.length > 0 ? reconcileWithLiveMutations([...freshById.values()]) : [])
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
  }, [cachedShows, loadAttempt, hasActivated])

  function handleRemove(show) {
    setOpenSwipeId(null)
    setConfirmingShow(show)
  }

  async function confirmRemove() {
    const show = confirmingShow
    if (!show) return
    setConfirmingShow(null)
    setRemoveError(null)

    setRemovingIds((prev) => new Set(prev).add(show.id))
    try {
      const deleteQuery = supabase
        .from('tracked_shows')
        .delete()
        .eq('id', show.id)
      const { error: deleteError } = await withTimeout((signal) => {
        let query = deleteQuery
        if (signal && typeof query.abortSignal === 'function') query = query.abortSignal(signal)
        return query
      }, { stage: 'watching-remove-show', source: 'supabase' })
      if (deleteError) throw deleteError

      setShows((prev) => {
        const next = prev.filter((s) => s.id !== show.id)
        saveWatchingCache(next)
        return next
      })
      showContextRef.current.delete(show.tmdb_id)
      quickMarkQueuesRef.current.delete(show.tmdb_id)
      localRevisionRef.current.delete(show.id)
      setReadyShowIds((prev) => {
        if (!prev.has(show.tmdb_id)) return prev
        const next = new Set(prev)
        next.delete(show.tmdb_id)
        return next
      })
    } catch {
      setRemoveError('Couldn\'t remove this show. Try again.')
    }
    setRemovingIds((prev) => {
      const next = new Set(prev)
      next.delete(show.id)
      return next
    })
  }

  // Applies a locally-derived field set to one row in place: no full-list
  // reconstruction, no remount, re-sorted with the same sortWatchingShows()
  // the network load path uses, and immediately persisted to the cache so a
  // tab switch away and back shows the result without waiting on the network.
  function applyLocalShowFields(showId, fields) {
    bumpLocalRevision(showId)
    setShows((prev) => {
      const next = sortWatchingShows(
        prev.map((s) => (s.id === showId ? { ...s, ...fields } : s)),
      )
      saveWatchingCache(next)
      return next
    })
  }

  async function handleQuickMark(show) {
    if (quickMarkingIds.has(show.id)) return
    const episode = show.nextReleasedUnwatchedEpisode
    const context = showContextRef.current.get(show.tmdb_id)
    if (!episode || !context) return

    setQuickMarkError(null)
    setQuickMarkingIds((prev) => new Set(prev).add(show.id))

    let queue = quickMarkQueuesRef.current.get(show.tmdb_id)
    if (!queue) {
      queue = createWatchMutationQueue()
      quickMarkQueuesRef.current.set(show.tmdb_id, queue)
    }

    try {
      await toggleEpisodeOptimistically({
        queue,
        supabase,
        tmdbShowId: show.tmdb_id,
        seasonNumber: episode.season_number,
        episode: {
          episode_number: episode.episode_number,
          name: episode.name,
          runtime: episode.runtime,
        },
        getWatched: () => context.watched,
        commitWatched: (nextWatched) => {
          context.watched = nextWatched
          applyLocalShowFields(
            show.id,
            deriveWatchingFields(context.episodesBySeason, nextWatched, context.details),
          )
        },
      })
    } catch {
      setQuickMarkError('Couldn\'t mark that episode watched. Try again.')
    } finally {
      setQuickMarkingIds((prev) => {
        const next = new Set(prev)
        next.delete(show.id)
        return next
      })
    }
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
        <div className="motion-banner mt-4 flex items-center justify-between gap-3 rounded-lg border border-(--color-destructive)/40 bg-(--color-destructive-muted) px-3 py-2 text-sm text-(--color-destructive)">
          <span>{error.message} <span className="whitespace-nowrap">({error.code})</span></span>
          <button
            type="button"
            onClick={() => {
              setLoading(cachedShows === null)
              setLoadAttempt((attempt) => attempt + 1)
            }}
            className="motion-press min-h-11 shrink-0 rounded-md px-3 font-semibold text-(--color-destructive)"
          >
            Retry
          </button>
        </div>
      )}

      {removeError && (
        <p role="alert" className="motion-banner mt-4 rounded-lg border border-(--color-destructive)/40 bg-(--color-destructive-muted) px-3 py-2 text-sm text-(--color-destructive)">
          {removeError}
        </p>
      )}

      {quickMarkError && (
        <p role="alert" className="motion-banner mt-4 rounded-lg border border-(--color-destructive)/40 bg-(--color-destructive-muted) px-3 py-2 text-sm text-(--color-destructive)">
          {quickMarkError}
        </p>
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
        <p className="empty-state">
          No shows yet. Add some from Discover.
        </p>
      )}

      {!loading && !error && shows.length > 0 && visibleShows.length === 0 && (
        <p className="empty-state">
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
              isOpen={interactionState.openSwipeId === show.id}
              onOpenChange={setOpenSwipeId}
              onRemove={handleRemove}
              onQuickMark={handleQuickMark}
              isQuickMarking={quickMarkingIds.has(show.id)}
              canQuickMark={readyShowIds.has(show.tmdb_id)}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={interactionState.confirmingShow !== null}
        title="Remove show?"
        message={
          interactionState.confirmingShow
            ? `Remove "${interactionState.confirmingShow.name}" from Watching? Your watch history won't be deleted.`
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
