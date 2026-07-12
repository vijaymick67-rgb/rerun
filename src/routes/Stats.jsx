import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getShowDetails, getSeasonEpisodes, POSTER_BASE } from '../lib/tmdb'
import { episodeKey, localTodayISO } from '../lib/watchHelpers'

// v1: { shows, totalMinutes, insights }. Stale-while-revalidate, same pattern
// as Watching.jsx — the underlying TMDB season data is already localStorage-
// cached, so a revisit paints instantly and refreshes in the background.
const CACHE_KEY = 'stats_cache:v1'

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

// Local calendar date (YYYY-MM-DD) for a stored watched_at timestamp, so the
// "busiest day" tally groups by the user's day, not UTC.
function localDateFromTimestamp(ts) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
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
function buildInsights({ shows, watchedRows, totalWatchedEpisodes }) {
  const insights = []
  const showCount = shows.length
  if (showCount === 0 || totalWatchedEpisodes === 0) return insights

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

  // Busiest single calendar day — skip unless at least a couple of episodes
  // landed on the same day, otherwise it's not really a "busy" day.
  const perDay = new Map()
  for (const row of watchedRows) {
    const day = localDateFromTimestamp(row.watched_at)
    if (!day) continue
    perDay.set(day, (perDay.get(day) ?? 0) + 1)
  }
  let busiestCount = 0
  for (const count of perDay.values()) {
    if (count > busiestCount) busiestCount = count
  }
  if (busiestCount >= 2) {
    insights.push(`You once watched ${busiestCount} episodes in a single day.`)
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

  return insights
}

export default function Stats() {
  const [cached] = useState(() => loadCache())
  const [shows, setShows] = useState(() => cached?.shows ?? [])
  const [totalMinutes, setTotalMinutes] = useState(() => cached?.totalMinutes ?? 0)
  const [insights, setInsights] = useState(() => cached?.insights ?? [])
  const [loading, setLoading] = useState(() => cached === null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let ignore = false

    async function load() {
      setError(null)
      try {
        // Every distinct show with at least one watched episode ever. A show
        // with zero ticked episodes simply never appears here, which is the
        // whole "only watched shows" filter — no extra logic needed.
        const { data: watchedRows, error: watchedError } = await supabase
          .from('watched_episodes')
          .select('tmdb_show_id, season_number, episode_number, watched_at')
        if (watchedError) throw watchedError

        const rows = watchedRows ?? []
        if (rows.length === 0) {
          if (!ignore) {
            setShows([])
            setTotalMinutes(0)
            setInsights([])
            saveCache({ shows: [], totalMinutes: 0, insights: [] })
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
        const { data: trackedShows, error: trackedError } = await supabase
          .from('tracked_shows')
          .select('tmdb_id, name, poster_path')
          .in('tmdb_id', showIds)
        if (trackedError) throw trackedError

        const trackedById = new Map()
        for (const row of trackedShows ?? []) {
          trackedById.set(row.tmdb_id, row)
        }

        const computed = await Promise.all(
          showIds.map(async (showId) => {
            const showWatchedRows = watchedByShowId.get(showId)
            const tracked = trackedById.get(showId)

            try {
              const details = await getShowDetails(showId)
              const seasons = (details.seasons ?? [])
                .filter((season) => season.season_number > 0)
                .sort((a, b) => a.season_number - b.season_number)

              const episodesArrays = await Promise.all(
                seasons.map((season) => getSeasonEpisodes(showId, season.season_number)),
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
                watched: showWatchedRows.length,
                total: showWatchedRows.length,
                networks: [],
                minutes: showWatchedRows.length * DEFAULT_EPISODE_RUNTIME_MINUTES,
              }
            }
          }),
        )

        if (ignore) return

        const totalRuntimeMinutes = computed.reduce((sum, show) => sum + show.minutes, 0)

        computed.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        )

        const nextInsights = buildInsights({
          shows: computed,
          watchedRows: rows,
          totalWatchedEpisodes: rows.length,
        })

        setShows(computed)
        setTotalMinutes(totalRuntimeMinutes)
        setInsights(nextInsights)
        saveCache({ shows: computed, totalMinutes: totalRuntimeMinutes, insights: nextInsights })
      } catch {
        if (!ignore) setError('Failed to load your stats. Try refreshing.')
      } finally {
        if (!ignore) setLoading(false)
      }
    }

    load()
    return () => {
      ignore = true
    }
  }, [])

  // Pick one insight for the whole day, deterministically from today's date.
  // Deriving it at render (rather than storing the chosen string) means a cache
  // written yesterday still surfaces today's insight without a refetch.
  const insight =
    insights.length > 0 ? insights[hashString(localTodayISO()) % insights.length] : null

  const hasData = shows.length > 0

  return (
    <div className="p-4">
      <h1 className="text-xl font-semibold text-(--color-text)">Stats</h1>

      {loading && (
        <div className="mt-4 flex flex-col gap-3">
          <div className="h-24 animate-pulse rounded-xl bg-(--color-surface-raised)" />
          <div className="h-12 animate-pulse rounded-lg bg-(--color-surface)" />
          <div className="mt-1 h-16 animate-pulse rounded-lg bg-(--color-surface)" />
          <div className="h-16 animate-pulse rounded-lg bg-(--color-surface)" />
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

      {!loading && !error && !hasData && (
        <p className="mt-8 text-center text-(--color-text-muted)">
          No watched episodes yet. Mark some watched, or log a finished show from Browse.
        </p>
      )}

      {!loading && hasData && (
        <>
          <div className="mt-4 rounded-xl border border-(--color-accent)/30 bg-(--color-accent-muted) px-4 py-5">
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

          <div className="mt-6 flex flex-col gap-2">
            {shows.map((show) => (
              <Link
                key={show.tmdb_id}
                to={`/watching/${show.tmdb_id}`}
                className="flex items-center gap-3 rounded-lg border border-(--color-border) bg-(--color-surface) p-3"
              >
                {show.poster_path ? (
                  <img
                    src={POSTER_BASE + show.poster_path}
                    alt={show.name}
                    className="h-16 w-11 shrink-0 rounded-md object-cover"
                  />
                ) : (
                  <div className="flex h-16 w-11 shrink-0 items-center justify-center rounded-md bg-(--color-surface-raised) text-[10px] text-(--color-text-muted)">
                    No poster
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-(--color-text)">{show.name}</p>
                  <p className="text-xs text-(--color-text-muted)">
                    {show.watched}/{show.total} episodes
                  </p>
                </div>

                <span aria-hidden="true" className="shrink-0 text-(--color-text-muted)">
                  ›
                </span>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
