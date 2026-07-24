import { useEffect, useRef, useState } from 'react'
import { Route, Routes } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getShowDetails, getSeasonEpisodes } from '../lib/tmdb'
import { localTodayISO } from '../lib/watchHelpers'
import { fetchWatchedEpisodes } from '../lib/watchedEpisodes'
import {
  hideTrackedShow,
  isRepresentedInStats,
  restoreTrackedShow,
} from '../lib/finishedShows'
import { patchShowDetailState } from '../lib/detailCache'
import { clearWatchingCache, removeWatchingShow } from '../lib/watchingCache'
import { reportDataError, withTimeout } from '../lib/dataLoading'
import StatsAllPreview from '../components/StatsAllPreview'
import GenreOrbit from '../components/GenreOrbit'
import StatsAllShows from './StatsAllShows'
import {
  filterVisibleStatsRows,
  removeShowFromStatsState,
  toggleStatsActionSheet,
} from '../lib/showState'
import {
  buildComputedStatsShow,
  buildFallbackStatsShow,
} from '../lib/insights/statsAnalytics'
import { buildGenreDistribution } from '../lib/insights/genreDistribution'
import {
  buildAnalyticsFingerprint,
  buildViewingInsightCandidates,
  clearInsightHistory,
  selectStoredDailyInsight,
} from '../lib/insights/viewingInsights'

// v1: { shows, totalMinutes, insights }. Stale-while-revalidate, same pattern
// as Watching.jsx — the underlying TMDB season data is already localStorage-
// cached, so a revisit paints instantly and refreshes in the background.
// v2/v3 were one-time data refreshes. v4 retains compact per-show analytics
// for Genre Orbit and structured insights. Generated copy and distributions
// are derived from the cached shows rather than persisted.
export const STATS_CACHE_KEY = 'stats_cache:v4'
const STATS_CACHE_VERSION = 4
const LEGACY_STATS_CACHE_KEYS = ['stats_cache:v3']

const MINUTES_PER_HOUR = 60
const MINUTES_PER_DAY = 60 * 24
// A "month" here is a flat 30 days — a deliberate approximation that keeps the
// banner a friendly round figure rather than a precise calendar computation.
const DAYS_PER_MONTH = 30

function loadCache() {
  try {
    const raw = localStorage.getItem(STATS_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (
      !parsed ||
      parsed.version !== STATS_CACHE_VERSION ||
      !Array.isArray(parsed.shows) ||
      !Array.isArray(parsed.watchedRows) ||
      !Number.isFinite(parsed.totalMinutes) ||
      !parsed.shows.every((show) => Array.isArray(show.watchedEpisodeRuntimes))
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function saveCache(payload) {
  try {
    localStorage.setItem(
      STATS_CACHE_KEY,
      JSON.stringify({ version: STATS_CACHE_VERSION, ...payload }),
    )
  } catch {
    // ignore quota/serialization errors, cache is best-effort
  }
}

// Watch-history-derived data (totals, hours, per-show breakdowns) — cleared
// on sign-out by Settings' Account section so it can't be read back before
// the next owner signs in and repopulates it from Supabase.
export function clearStatsCache() {
  try {
    localStorage.removeItem(STATS_CACHE_KEY)
    for (const key of LEGACY_STATS_CACHE_KEYS) localStorage.removeItem(key)
  } catch {
    // ignore
  }
  clearInsightHistory()
}

// Total watched minutes → a "X months Y days" style human string.
function formatWatchTime(totalMinutes) {
  if (totalMinutes < MINUTES_PER_HOUR) return 'under an hour'
  if (totalMinutes < MINUTES_PER_DAY) {
    const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR)
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  const totalDays = Math.floor(totalMinutes / MINUTES_PER_DAY)
  if (totalDays < DAYS_PER_MONTH) {
    return `${totalDays} day${totalDays === 1 ? '' : 's'}`
  }
  const months = Math.floor(totalDays / DAYS_PER_MONTH)
  const days = totalDays - months * DAYS_PER_MONTH
  const monthPart = `${months} month${months === 1 ? '' : 's'}`
  if (days === 0) return monthPart
  return `${monthPart} ${days} day${days === 1 ? '' : 's'}`
}

function buildVisibleStatsState(shows, watchedRows) {
  const totalMinutes = shows.reduce((sum, show) => sum + show.minutes, 0)
  const genreDistribution = buildGenreDistribution(shows)
  const candidates = buildViewingInsightCandidates({
    shows,
    totalMinutes,
    genreDistribution,
  })
  const fingerprint = buildAnalyticsFingerprint(shows)
  const insight = selectStoredDailyInsight({
    candidates,
    date: localTodayISO(),
    fingerprint,
  })
  return { shows, watchedRows, totalMinutes, genreDistribution, insight }
}

export default function Stats() {
  const [cached] = useState(() => loadCache())
  const [statsState, setStatsState] = useState(() =>
    buildVisibleStatsState(cached?.shows ?? [], cached?.watchedRows ?? []),
  )
  const {
    shows,
    watchedRows,
    totalMinutes,
    genreDistribution,
    insight,
  } = statsState
  const [loading, setLoading] = useState(() => cached === null)
  const [error, setError] = useState(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [actionError, setActionError] = useState(null)
  const [actionSuccess, setActionSuccess] = useState(null)
  const [openActionId, setOpenActionId] = useState(null)
  const [busyIds, setBusyIds] = useState(new Set())
  const busyIdsRef = useRef(new Set())
  const [confirmingShow, setConfirmingShow] = useState(null)

  useEffect(() => {
    let ignore = false

    async function load() {
      setError(null)
      try {
        // Every distinct show with at least one watched episode ever. A show
        // with zero ticked episodes simply never appears here, which is the
        // whole "only watched shows" filter — no extra logic needed.
        const watchedRows = await withTimeout(
          (signal) => fetchWatchedEpisodes(
            supabase,
            'tmdb_show_id, season_number, episode_number, watched_at',
            null,
            { signal },
          ),
          { stage: 'stats-watched-episodes', source: 'supabase' },
        )

        const rows = watchedRows ?? []
        if (rows.length === 0) {
          if (!ignore) {
            const next = buildVisibleStatsState([], [])
            setStatsState(next)
            saveCache({ shows: [], watchedRows: [], totalMinutes: 0 })
          }
          return
        }

        // Group watched rows by show.
        const watchedByShowId = new Map()
        for (const row of rows) {
          if (!watchedByShowId.has(row.tmdb_show_id)) {
            watchedByShowId.set(row.tmdb_show_id, [])
          }
          watchedByShowId.get(row.tmdb_show_id).push(row)
        }
        const showIds = [...watchedByShowId.keys()]

        // Names/posters — every watched show is guaranteed a tracked_shows row.
        const { data: trackedShows, error: trackedError } = await withTimeout((signal) => {
          let query = supabase
            .from('tracked_shows')
            .select('tmdb_id, name, poster_path, finished_at, hidden_at')
            .in('tmdb_id', showIds)
            .is('hidden_at', null)
          if (signal && typeof query.abortSignal === 'function') query = query.abortSignal(signal)
          return query
        }, { stage: 'stats-tracked-shows', source: 'supabase' })
        if (trackedError) throw trackedError

        const trackedById = new Map()
        for (const row of trackedShows ?? []) {
          trackedById.set(row.tmdb_id, row)
        }

        const visibleRows = filterVisibleStatsRows(trackedShows, rows)
        const visibleWatchedByShowId = new Map()
        for (const row of visibleRows) {
          if (!visibleWatchedByShowId.has(row.tmdb_show_id)) {
            visibleWatchedByShowId.set(row.tmdb_show_id, [])
          }
          visibleWatchedByShowId.get(row.tmdb_show_id).push(row)
        }
        const visibleShowIds = [...visibleWatchedByShowId.keys()]

        const computed = await Promise.all(
          visibleShowIds.map(async (showId) => {
            const showWatchedRows = visibleWatchedByShowId.get(showId)
            const tracked = trackedById.get(showId)

            try {
              const details = await withTimeout(
                () => getShowDetails(showId),
                { stage: 'stats-show-details', source: 'tmdb' },
              )
              const seasons = (details.seasons ?? [])
                .filter((season) => season.season_number > 0)
                .sort((a, b) => a.season_number - b.season_number)

              const episodesArrays = await Promise.all(
                seasons.map((season) => withTimeout(
                  () => getSeasonEpisodes(showId, season.season_number),
                  { stage: 'stats-season-episodes', source: 'tmdb' },
                )),
              )

              // Map every real episode (seasons > 0) → its runtime, matching
              // ShowDetail's header which counts across the loaded seasons.
              return buildComputedStatsShow({
                showId,
                tracked,
                details,
                watchedRows: showWatchedRows,
                seasons,
                episodesArrays,
              })
            } catch {
              // TMDB fetch failed for this show — degrade gracefully rather than
              // dropping it: count each watched row at the flat default runtime.
              return buildFallbackStatsShow({
                showId,
                tracked,
                watchedRows: showWatchedRows,
              })
            }
          }),
        )

        if (ignore) return

        // Personal finished_at is deliberately not a filter here: Stats is a
        // record of watched history, including archived shows.
        const represented = computed.filter((show) =>
          isRepresentedInStats(show, visibleWatchedByShowId.get(show.tmdb_id)),
        )

        represented.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        )

        const next = buildVisibleStatsState(represented, visibleRows)
        setStatsState(next)
        saveCache({
          shows: represented,
          watchedRows: visibleRows,
          totalMinutes: next.totalMinutes,
        })
      } catch (loadFailure) {
        const diagnostic = reportDataError(loadFailure, {
          stage: loadFailure?.stage ?? 'stats-load',
          source: loadFailure?.source ?? 'unknown',
        })
        if (!ignore) setError({
          message: cached ? 'Couldn’t refresh your stats.' : 'Failed to load your stats.',
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
  }, [cached, loadAttempt])

  function commitStatsState(nextShows, nextWatchedRows) {
    const next = buildVisibleStatsState(nextShows, nextWatchedRows)
    setStatsState(next)
    saveCache({
      shows: next.shows,
      watchedRows: next.watchedRows,
      totalMinutes: next.totalMinutes,
    })
  }

  function setShowBusy(tmdbId, busy) {
    if (busy) busyIdsRef.current.add(tmdbId)
    else busyIdsRef.current.delete(tmdbId)
    setBusyIds((prev) => {
      const next = new Set(prev)
      if (busy) next.add(tmdbId)
      else next.delete(tmdbId)
      return next
    })
  }

  async function restoreShow(show) {
    if (busyIdsRef.current.has(show.tmdb_id)) return
    setActionError(null)
    setActionSuccess(null)
    setShowBusy(show.tmdb_id, true)
    try {
      await restoreTrackedShow(supabase, show.tmdb_id)
      const nextShows = shows.map((current) =>
        current.tmdb_id === show.tmdb_id
          ? { ...current, finished_at: null, hidden_at: null }
          : current,
      )
      commitStatsState(nextShows, watchedRows)
      patchShowDetailState(show.tmdb_id, { finished_at: null, hidden_at: null })
      clearWatchingCache()
      setOpenActionId(null)
      setActionSuccess(`${show.name} is active in Watching again.`)
    } catch (err) {
      setActionError(err?.message || 'Could not restore this show. Try again.')
    } finally {
      setShowBusy(show.tmdb_id, false)
    }
  }

  async function removeShow(show) {
    if (busyIdsRef.current.has(show.tmdb_id)) return
    setConfirmingShow(null)
    setActionError(null)
    setActionSuccess(null)
    setShowBusy(show.tmdb_id, true)
    try {
      const hiddenAt = await hideTrackedShow(supabase, show.tmdb_id)
      const nextState = removeShowFromStatsState(shows, watchedRows, show.tmdb_id)
      commitStatsState(nextState.shows, nextState.watchedRows)
      patchShowDetailState(show.tmdb_id, { hidden_at: hiddenAt })
      removeWatchingShow(show.tmdb_id)
      setOpenActionId(null)
    } catch (err) {
      setActionError(err?.message || 'Could not remove this show. Try again.')
    } finally {
      setShowBusy(show.tmdb_id, false)
    }
  }

  const hasData = shows.length > 0

  function handleRetry() {
    setLoading(cached === null)
    setLoadAttempt((attempt) => attempt + 1)
  }

  function handleOpenActions(tmdbId) {
    setActionError(null)
    setActionSuccess(null)
    setOpenActionId(toggleStatsActionSheet(openActionId, tmdbId))
  }

  return (
    <Routes>
      <Route
        index
        element={
          <StatsMainView
            loading={loading}
            error={error}
            hasData={hasData}
            totalMinutes={totalMinutes}
            insight={insight}
            genreDistribution={genreDistribution}
            shows={shows}
            onRetry={handleRetry}
          />
        }
      />
      <Route
        path="all"
        element={
          <StatsAllShows
            loading={loading}
            error={error}
            shows={shows}
            busyIds={busyIds}
            openActionId={openActionId}
            actionError={actionError}
            actionSuccess={actionSuccess}
            confirmingShow={confirmingShow}
            onOpenActions={handleOpenActions}
            onCloseActions={() => setOpenActionId(null)}
            onRestore={restoreShow}
            onRequestRemove={setConfirmingShow}
            onConfirmRemove={() => confirmingShow && removeShow(confirmingShow)}
            onCancelRemove={() => setConfirmingShow(null)}
            onRetry={handleRetry}
          />
        }
      />
    </Routes>
  )
}

// The main compact Insights view — summary, personal insight, and the
// All(n) collection preview. Kept inline (rather than split into its own
// file) so this file still visibly owns the "app-page" main-tab layout.
function StatsMainView({
  loading,
  error,
  hasData,
  totalMinutes,
  insight,
  genreDistribution,
  shows,
  onRetry,
}) {
  return (
    <div className="stats-page app-page px-4 pb-4">
      <header className="stats-page__header">
        <h1 className="type-page-title text-(--color-text)">Insights</h1>
      </header>

      {loading && (
        <div className="stats-loading" aria-label="Loading insights" role="status">
          <div className="stats-loading__summary skeleton-block" />
          <div className="stats-loading__insight skeleton-block" />
          <div className="stats-loading__orbit skeleton-block" />
          <div className="stats-loading__label skeleton-block" />
          <div className="stats-loading__archive skeleton-block" />
        </div>
      )}

      {error && (
        <div className="status-banner status-banner--destructive motion-banner mt-4 flex items-center justify-between gap-3 text-sm">
          <span>{error.message} <span className="whitespace-nowrap">({error.code})</span></span>
          <button
            type="button"
            onClick={onRetry}
            className="focus-ring motion-press min-h-11 shrink-0 rounded-md px-3 font-semibold text-(--color-destructive)"
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && !hasData && (
        <div className="empty-state">
          <h2 className="type-section-title text-(--color-text)">Your viewing journal is empty</h2>
          <p className="type-body mt-2">No watched episodes yet. Mark some watched, or log a finished show from Discover.</p>
        </div>
      )}

      {!loading && hasData && (
        <>
          <section className="stats-summary content-surface" aria-labelledby="stats-summary-title">
            <p id="stats-summary-title" className="type-badge text-(--color-gold-accent-strong)">
              Time with your shows
            </p>
            <p className="stats-summary__duration type-display mt-1 text-(--color-text)">
              {formatWatchTime(totalMinutes)}
            </p>
          </section>

          {insight && (
            <section className="stats-insight content-surface" aria-label="Personal insight">
              <p className="stats-insight__copy type-body text-(--color-text-secondary)">
                {insight.text}
              </p>
            </section>
          )}

          <GenreOrbit distribution={genreDistribution} />

          <StatsAllPreview shows={shows} />
        </>
      )}
    </div>
  )
}
