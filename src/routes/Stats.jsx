import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getShowDetails, getSeasonEpisodes, POSTER_BASE } from '../lib/tmdb'
import { episodeKey, localTodayISO } from '../lib/watchHelpers'
import { fetchWatchedEpisodes } from '../lib/watchedEpisodes'
import {
  hideTrackedShow,
  isRepresentedInStats,
  restoreTrackedShow,
} from '../lib/finishedShows'
import { patchShowDetailState } from '../lib/detailCache'
import { clearWatchingCache, removeWatchingShow } from '../lib/watchingCache'
import { reportDataError, withTimeout } from '../lib/dataLoading'
import ConfirmDialog from '../components/ConfirmDialog'
import ProgressiveImage from '../components/ProgressiveImage'
import {
  filterVisibleStatsRows,
  isStatsShowBusy,
  removeShowFromStatsState,
  statsActionItems,
  toggleStatsActionSheet,
} from '../lib/showState'

// v1: { shows, totalMinutes, insights }. Stale-while-revalidate, same pattern
// as Watching.jsx — the underlying TMDB season data is already localStorage-
// cached, so a revisit paints instantly and refreshes in the background.
// v2: one-time cache-bust so the Settings bulk-mark-watched writes are picked
// up — old v1 entries are simply never matched and a fresh Supabase fetch runs.
const CACHE_KEY = 'stats_cache:v3'

// When neither an episode's own runtime nor the show's average typical runtime
// is known, assume this many minutes per episode. This is the single flat
// fallback for the time banner — search DEFAULT_EPISODE_RUNTIME_MINUTES to
// adjust it if it ever proves too rough.
const DEFAULT_EPISODE_RUNTIME_MINUTES = 45

const MINUTES_PER_HOUR = 60
const MINUTES_PER_DAY = 60 * 24
// A "month" here is a flat 30 days — a deliberate approximation that keeps the
// banner a friendly round figure rather than a precise calendar computation.
const DAYS_PER_MONTH = 30

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function saveCache(payload) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload))
  } catch {
    // ignore quota/serialization errors, cache is best-effort
  }
}

// Runtime in minutes for a single watched episode, applying the documented
// fallback chain: the episode's own runtime → the show's average typical
// runtime → a flat default.
function episodeRuntimeMinutes(ownRuntime, showRunTimeAvg) {
  if (typeof ownRuntime === 'number' && ownRuntime > 0) return ownRuntime
  if (showRunTimeAvg != null) return showRunTimeAvg
  return DEFAULT_EPISODE_RUNTIME_MINUTES
}

// Average of TMDB's episode_run_time array (a show can list a few typical
// runtimes), or null if the show has none.
function averageRunTime(episodeRunTime) {
  const values = (episodeRunTime ?? []).filter((n) => typeof n === 'number' && n > 0)
  if (values.length === 0) return null
  return values.reduce((sum, n) => sum + n, 0) / values.length
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

// Small deterministic string hash — used to turn today's date into a stable
// index so the insight is the same all day and rotates the next.
function hashString(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

// Build the pool of eligible insight sentences. Only insights whose data is
// substantial enough to read sensibly are included, so the daily pick never
// lands on something empty or nonsensical.
function buildInsights({ shows, watchedRows, totalWatchedEpisodes, totalMinutes }) {
  const insights = []
  const showCount = shows.length
  if (showCount === 0 || totalWatchedEpisodes === 0) return insights

  const showById = new Map(shows.map((show) => [show.tmdb_id, show]))

  // Per-show rollups derived once from the raw watched rows: which distinct
  // seasons were touched, and the most recent watch timestamp.
  const seasonsByShow = new Map()
  const latestWatchByShow = new Map()
  for (const row of watchedRows) {
    if (!seasonsByShow.has(row.tmdb_show_id)) {
      seasonsByShow.set(row.tmdb_show_id, new Set())
    }
    seasonsByShow.get(row.tmdb_show_id).add(row.season_number)

    const ts = new Date(row.watched_at).getTime()
    if (!Number.isNaN(ts) && ts > (latestWatchByShow.get(row.tmdb_show_id) ?? -Infinity)) {
      latestWatchByShow.set(row.tmdb_show_id, ts)
    }
  }

  // A simple summary — always valid once anything's been watched.
  insights.push(
    `You've watched ${totalWatchedEpisodes} episode${totalWatchedEpisodes === 1 ? '' : 's'} across ${showCount} show${showCount === 1 ? '' : 's'}.`,
  )

  // Total distinct shows — only interesting once there's more than one.
  if (showCount >= 2) {
    insights.push(`You've dipped into ${showCount} different shows so far.`)
  }

  // Most-watched network — tally each show's watched count against its primary
  // (first-listed) network to avoid double-counting sibling networks.
  const networkTotals = new Map()
  for (const show of shows) {
    const primary = show.networks?.[0]
    if (!primary) continue
    networkTotals.set(primary, (networkTotals.get(primary) ?? 0) + show.watched)
  }
  let topNetwork = null
  let topNetworkCount = 0
  for (const [name, count] of networkTotals) {
    if (count > topNetworkCount) {
      topNetwork = name
      topNetworkCount = count
    }
  }
  if (topNetwork && topNetworkCount > 0) {
    insights.push(`${topNetwork} has been your most-watched network lately.`)
  }

  // Distinct networks watched across — only reads as an insight once there's
  // real spread, so gate on at least a couple of different primary networks.
  const distinctNetworks = networkTotals.size
  if (distinctNetworks >= 2) {
    insights.push(`Your watching spans ${distinctNetworks} different networks.`)
  }

  // Biggest watch by episode count — needs a few episodes to be worth calling out.
  let biggest = null
  for (const show of shows) {
    if (!biggest || show.watched > biggest.watched) biggest = show
  }
  if (biggest && biggest.watched >= 3) {
    insights.push(
      `You're ${biggest.watched} episodes deep into ${biggest.name} — your biggest watch yet.`,
    )
  }

  // Show spanning the most seasons — skip unless the leader is genuinely
  // multi-season, otherwise "most seasons" is a meaningless tie at one apiece.
  let mostSeasonsShowId = null
  let mostSeasonsCount = 0
  for (const [showId, seasons] of seasonsByShow) {
    if (seasons.size > mostSeasonsCount) {
      mostSeasonsShowId = showId
      mostSeasonsCount = seasons.size
    }
  }
  const mostSeasonsShow = showById.get(mostSeasonsShowId)
  if (mostSeasonsShow && mostSeasonsCount >= 2) {
    insights.push(
      `You've watched ${mostSeasonsCount} seasons of ${mostSeasonsShow.name} — more than any other show.`,
    )
  }

  // Most recently finished show — a show counts as finished only when every
  // episode we know about is watched. Needs at least one such show.
  let latestFinishedShow = null
  let latestFinishedAt = -Infinity
  for (const show of shows) {
    if (show.total <= 0 || show.watched < show.total) continue
    const finishedAt = latestWatchByShow.get(show.tmdb_id) ?? -Infinity
    if (finishedAt > latestFinishedAt) {
      latestFinishedAt = finishedAt
      latestFinishedShow = show
    }
  }
  if (latestFinishedShow) {
    insights.push(`${latestFinishedShow.name} was the last show you finished off.`)
  }

  // Average episode runtime across everything watched — a friendly round
  // figure, only worth showing once there's a decent sample of episodes.
  if (totalWatchedEpisodes >= 5 && totalMinutes > 0) {
    const avgMinutes = Math.round(totalMinutes / totalWatchedEpisodes)
    insights.push(`Your average episode runs about ${avgMinutes} minutes.`)
  }

  return insights
}

function buildVisibleStatsState(shows, watchedRows) {
  const totalMinutes = shows.reduce((sum, show) => sum + show.minutes, 0)
  const insights = buildInsights({
    shows,
    watchedRows,
    totalWatchedEpisodes: watchedRows.length,
    totalMinutes,
  })
  return { shows, watchedRows, totalMinutes, insights }
}

function StatsActionSheet({ show, busy, onClose, onRestore, onRemove }) {
  useEffect(() => {
    if (!show) return undefined
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, show])

  if (!show) return null

  const titleId = `stats-actions-title-${show.tmdb_id}`

  return (
    <div
      className="safe-area-overlay fixed inset-0 z-40 flex items-end justify-center bg-black/60 px-4"
      onClick={onClose}
    >
      <div
        id="stats-actions-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[calc(100dvh-6rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-(--color-border) bg-(--color-surface) p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="min-w-0 break-words text-base font-semibold text-(--color-text)">
            Actions for {show.name}
          </h2>
          <button
            type="button"
            aria-label="Close actions"
            onClick={onClose}
            className="motion-press min-h-11 min-w-11 shrink-0 rounded-lg text-xl leading-none text-(--color-text-muted)"
          >
            ×
          </button>
        </div>

        <div className="mt-3 flex flex-col gap-2">
          {statsActionItems(show).map((item) => {
            if (item.id === 'details') {
              return (
                <Link
                  key={item.id}
                  to={`/watching/${show.tmdb_id}`}
                  aria-disabled={busy}
                  onClick={(event) => {
                    if (busy) {
                      event.preventDefault()
                      return
                    }
                    onClose()
                  }}
                  className="motion-press flex min-h-11 w-full items-center rounded-lg border border-(--color-border) px-3 text-left text-sm font-medium text-(--color-text)"
                >
                  {item.label}
                </Link>
              )
            }

            if (item.id === 'cancel') {
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={onClose}
                  className="motion-press min-h-11 w-full rounded-lg px-3 text-left text-sm font-medium text-(--color-text-muted)"
                >
                  {item.label}
                </button>
              )
            }

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onClose()
                  if (item.id === 'restore') onRestore()
                  if (item.id === 'remove') onRemove()
                }}
                disabled={busy}
                className={`motion-press min-h-11 w-full rounded-lg px-3 text-left text-sm font-medium disabled:opacity-60 ${
                  item.destructive ? 'text-red-400' : 'text-(--color-text-muted)'
                }`}
              >
                {busy && item.id === 'restore' ? 'Restoring…' : item.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default function Stats() {
  const [cached] = useState(() => loadCache())
  const [shows, setShows] = useState(() => cached?.shows ?? [])
  const [watchedRows, setWatchedRows] = useState(() => cached?.watchedRows ?? [])
  const [totalMinutes, setTotalMinutes] = useState(() => cached?.totalMinutes ?? 0)
  const [insights, setInsights] = useState(() => cached?.insights ?? [])
  const [loading, setLoading] = useState(() => cached === null)
  const [error, setError] = useState(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [actionError, setActionError] = useState(null)
  const [actionSuccess, setActionSuccess] = useState(null)
  const [openActionId, setOpenActionId] = useState(null)
  const [busyIds, setBusyIds] = useState(new Set())
  const busyIdsRef = useRef(new Set())
  const [confirmingShow, setConfirmingShow] = useState(null)

  const actionShow = openActionId === null
    ? null
    : shows.find((show) => show.tmdb_id === openActionId) ?? null

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
            setShows([])
            setWatchedRows([])
            setTotalMinutes(0)
            setInsights([])
            saveCache({ shows: [], watchedRows: [], totalMinutes: 0, insights: [] })
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
              const runtimeByKey = new Map()
              seasons.forEach((season, i) => {
                for (const ep of episodesArrays[i].episodes) {
                  runtimeByKey.set(episodeKey(season.season_number, ep.episode_number), ep.runtime)
                }
              })

              const showRunTimeAvg = averageRunTime(details.episode_run_time)

              // Sum runtime over every watched episode of this show.
              let minutes = 0
              for (const row of showWatchedRows) {
                const key = episodeKey(row.season_number, row.episode_number)
                minutes += episodeRuntimeMinutes(runtimeByKey.get(key), showRunTimeAvg)
              }

              const total = runtimeByKey.size
              const watched = showWatchedRows.filter((row) =>
                runtimeByKey.has(episodeKey(row.season_number, row.episode_number)),
              ).length

              return {
                tmdb_id: showId,
                name: tracked?.name ?? details.name ?? 'Unknown show',
                poster_path: tracked?.poster_path ?? details.poster_path ?? null,
                finished_at: tracked?.finished_at ?? null,
                hidden_at: tracked?.hidden_at ?? null,
                watched,
                total,
                networks: details.networks ?? [],
                minutes,
              }
            } catch {
              // TMDB fetch failed for this show — degrade gracefully rather than
              // dropping it: count each watched row at the flat default runtime.
              return {
                tmdb_id: showId,
                name: tracked?.name ?? 'Unknown show',
                poster_path: tracked?.poster_path ?? null,
                finished_at: tracked?.finished_at ?? null,
                hidden_at: tracked?.hidden_at ?? null,
                watched: showWatchedRows.length,
                total: showWatchedRows.length,
                networks: [],
                minutes: showWatchedRows.length * DEFAULT_EPISODE_RUNTIME_MINUTES,
              }
            }
          }),
        )

        if (ignore) return

        // Personal finished_at is deliberately not a filter here: Stats is a
        // record of watched history, including archived shows.
        const represented = computed.filter((show) =>
          isRepresentedInStats(show, visibleWatchedByShowId.get(show.tmdb_id)),
        )

        const totalRuntimeMinutes = represented.reduce((sum, show) => sum + show.minutes, 0)

        represented.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        )

        const nextInsights = buildInsights({
          shows: represented,
          watchedRows: visibleRows,
          totalWatchedEpisodes: visibleRows.length,
          totalMinutes: totalRuntimeMinutes,
        })

        setShows(represented)
        setWatchedRows(visibleRows)
        setTotalMinutes(totalRuntimeMinutes)
        setInsights(nextInsights)
        saveCache({
          shows: represented,
          watchedRows: visibleRows,
          totalMinutes: totalRuntimeMinutes,
          insights: nextInsights,
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
    setShows(next.shows)
    setWatchedRows(next.watchedRows)
    setTotalMinutes(next.totalMinutes)
    setInsights(next.insights)
    saveCache({
      shows: next.shows,
      watchedRows: next.watchedRows,
      totalMinutes: next.totalMinutes,
      insights: next.insights,
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

  // Pick one insight for the whole day, deterministically from today's date.
  // Deriving it at render (rather than storing the chosen string) means a cache
  // written yesterday still surfaces today's insight without a refetch.
  const insight =
    insights.length > 0 ? insights[hashString(localTodayISO()) % insights.length] : null

  const hasData = shows.length > 0

  return (
    <div className="app-page px-4 pb-4">
      {loading && (
        <div className="flex flex-col gap-3">
          <div className="h-24 animate-pulse rounded-xl bg-(--color-surface-raised)" />
          <div className="h-12 animate-pulse rounded-lg bg-(--color-surface)" />
          <div className="mt-1 h-16 animate-pulse rounded-lg bg-(--color-surface)" />
          <div className="h-16 animate-pulse rounded-lg bg-(--color-surface)" />
        </div>
      )}

      {error && (
        <div className="motion-banner mt-4 flex items-center justify-between gap-3 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <span>{error.message} <span className="whitespace-nowrap">({error.code})</span></span>
          <button
            type="button"
            onClick={() => {
              setLoading(cached === null)
              setLoadAttempt((attempt) => attempt + 1)
            }}
            className="motion-press min-h-11 shrink-0 rounded-md px-3 font-semibold text-red-300"
          >
            Retry
          </button>
        </div>
      )}

      {actionError && (
        <div role="alert" className="motion-banner mt-4 min-w-0 break-words rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {actionError}
        </div>
      )}

      {actionSuccess && (
        <div role="status" className="motion-banner mt-4 min-w-0 break-words rounded-lg border border-(--color-accent)/30 bg-(--color-accent-muted) px-3 py-2 text-sm text-(--color-accent)">
          {actionSuccess}
        </div>
      )}

      {!loading && !error && !hasData && (
        <p className="mt-8 text-center text-(--color-text-muted)">
          No watched episodes yet. Mark some watched, or log a finished show from Discover.
        </p>
      )}

      {!loading && hasData && (
        <>
          <div className="rounded-xl border border-(--color-accent)/30 bg-(--color-accent-muted) px-4 py-5">
            <p className="text-xs font-medium uppercase tracking-wide text-(--color-accent)">
              Total time watched
            </p>
            <p className="mt-1 text-3xl font-semibold text-(--color-text)">
              {formatWatchTime(totalMinutes)}
            </p>
          </div>

          {insight && (
            <div className="mt-3 rounded-lg border border-(--color-border) bg-(--color-surface) px-4 py-3">
              <p className="text-sm text-(--color-text-muted)">{insight}</p>
            </div>
          )}

          <div className="mt-6 grid grid-cols-3 gap-3">
            {shows.map((show) => {
              const isBusy = isStatsShowBusy(busyIds, show.tmdb_id)
              const actionsOpen = openActionId === show.tmdb_id

              return (
                <div key={show.tmdb_id} className="min-w-0">
                  <div className="relative">
                    <Link to={`/watching/${show.tmdb_id}`} className="motion-press block">
                      <ProgressiveImage
                        src={show.poster_path ? POSTER_BASE + show.poster_path : null}
                        alt={show.name}
                        fallbackLabel="No poster"
                        className="aspect-[2/3] w-full rounded-lg border border-(--color-border)"
                      />
                    </Link>

                    <button
                      type="button"
                      aria-label={`Actions for ${show.name}`}
                      aria-expanded={actionsOpen}
                      aria-controls="stats-actions-sheet"
                      onClick={() => {
                        setActionError(null)
                        setActionSuccess(null)
                        setOpenActionId(toggleStatsActionSheet(openActionId, show.tmdb_id))
                      }}
                      disabled={isBusy}
                      className="motion-press absolute right-0.5 top-0.5 flex h-11 w-11 items-center justify-center rounded-full text-white/80 active:text-white active:opacity-100 disabled:opacity-60"
                    >
                      <svg
                        viewBox="0 0 14 4"
                        className="h-1 w-3.5"
                        fill="currentColor"
                        aria-hidden="true"
                        style={{ filter: 'drop-shadow(0 1px 1px rgba(0, 0, 0, 0.65))' }}
                      >
                        <circle cx="2" cy="2" r="1.25" />
                        <circle cx="7" cy="2" r="1.25" />
                        <circle cx="12" cy="2" r="1.25" />
                      </svg>
                    </button>
                  </div>

                  <p className="mt-1.5 truncate text-xs font-medium text-(--color-text)">
                    {show.name}
                  </p>

                </div>
              )
            })}
          </div>
        </>
      )}

      <StatsActionSheet
        show={actionShow}
        busy={actionShow ? isStatsShowBusy(busyIds, actionShow.tmdb_id) : false}
        onClose={() => setOpenActionId(null)}
        onRestore={() => actionShow && restoreShow(actionShow)}
        onRemove={() => actionShow && setConfirmingShow(actionShow)}
      />

      <ConfirmDialog
        open={confirmingShow !== null}
        title={confirmingShow ? `Remove ${confirmingShow.name} from Rerun?` : 'Remove show?'}
        message={
          confirmingShow
            ? `It will disappear from Insights and Watching, but your watched episodes and watch dates will be preserved. Adding it again later will restore your progress.`
            : ''
        }
        confirmLabel="Remove from Insights"
        cancelLabel="Cancel"
        danger
        onConfirm={() => confirmingShow && removeShow(confirmingShow)}
        onCancel={() => setConfirmingShow(null)}
      />
    </div>
  )
}
