import { useEffect, useRef, useState } from 'react'
import { searchShows, getExternalIds, getShowDetails, POSTER_BASE } from '../lib/tmdb'
import { supabase } from '../lib/supabase'
import { daysUntil, daysUntilRelease, releaseSources } from '../lib/watchHelpers'
import { getShowReleaseMap } from '../lib/tvmaze'
import { attachEpisodeReleaseData } from '../lib/watchingShows'
import { classifyReleasePlatform } from '../lib/releasePlatforms'
import { buildAiredEpisodeRows, upsertWatchedRows } from '../lib/bulkMarkWatched'
import { upsertTrackedShow } from '../lib/finishedShows'

const DEBOUNCE_MS = 400
const DELAYED_ADD_THRESHOLD_DAYS = 60

export default function Browse() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [searched, setSearched] = useState(false)
  const [trackedIds, setTrackedIds] = useState(new Set())
  const [addingIds, setAddingIds] = useState(new Set())
  const [loggingIds, setLoggingIds] = useState(new Set())
  const [loggedIds, setLoggedIds] = useState(new Set())
  const [delayedAddMessage, setDelayedAddMessage] = useState(null)
  const debounceRef = useRef(null)

  useEffect(() => {
    let ignore = false
    supabase
      .from('tracked_shows')
      .select('tmdb_id, hidden_at')
      .then(({ data, error: fetchError }) => {
        if (ignore || fetchError || !data) return
        setTrackedIds(new Set(data.filter((row) => row.hidden_at == null).map((row) => row.tmdb_id)))
      })
    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    clearTimeout(debounceRef.current)

    if (!query.trim()) {
      setResults([])
      setSearched(false)
      setError(null)
      setLoading(false)
      return
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const data = await searchShows(query.trim())
        setResults(data)
      } catch {
        setError('Search failed. Try again.')
        setResults([])
      } finally {
        setSearched(true)
        setLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(debounceRef.current)
  }, [query])

  async function handleAdd(show) {
    setAddingIds((prev) => new Set(prev).add(show.id))

    let insertError = null
    try {
      await upsertTrackedShow(supabase, show)
    } catch (err) {
      insertError = err
    }

    setAddingIds((prev) => {
      const next = new Set(prev)
      next.delete(show.id)
      return next
    })

    if (!insertError) {
      setTrackedIds((prev) => new Set(prev).add(show.id))
    } else {
      return
    }

    try {
      const details = await getShowDetails(show.id)
      const releaseMap = await getShowReleaseMap(show.id, { getExternalIds })
      const platformInfo = classifyReleasePlatform(details)
      const nextEpisode = attachEpisodeReleaseData(
        details.next_episode_to_air, releaseMap, undefined, platformInfo,
      )
      const premiereDate = nextEpisode?.air_date ?? details.first_air_date ?? null
      const daysAway = nextEpisode
        ? daysUntilRelease(premiereDate, releaseSources(nextEpisode), platformInfo)
        : daysUntil(premiereDate)
      if (daysAway !== null && daysAway > DELAYED_ADD_THRESHOLD_DAYS) {
        setDelayedAddMessage(
          "This show premieres in a while! We'll automatically add it to your Watching tab closer to the release date.",
        )
      }
    } catch {
      // best-effort — premiere timing is a nice-to-have, the show is already tracked
    }
  }

  // "Log as watched" — retroactively log a show finished before using the app,
  // without ticking every episode by hand. Ensures the show is tracked (same
  // UNIQUE_VIOLATION handling as handleAdd), then bulk-marks every already-aired
  // episode watched via the shared bulk-mark routine. Unaired future episodes
  // are skipped — they don't exist yet to mark, even though the user is claiming
  // to have "seen the whole show".
  async function handleLogWatched(show) {
    setLoggingIds((prev) => new Set(prev).add(show.id))

    try {
      await upsertTrackedShow(supabase, show)
      setTrackedIds((prev) => new Set(prev).add(show.id))

      const { rows } = await buildAiredEpisodeRows(show.id)
      await upsertWatchedRows(rows)

      setLoggedIds((prev) => new Set(prev).add(show.id))
    } catch {
      // best-effort — leave the button in its default state so the user can retry
    } finally {
      setLoggingIds((prev) => {
        const next = new Set(prev)
        next.delete(show.id)
        return next
      })
    }
  }

  return (
    <div className="p-4">
      <h1 className="text-xl font-semibold text-(--color-text)">Browse</h1>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search for a show…"
        className="mt-3 w-full rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-2 text-(--color-text) placeholder:text-(--color-text-muted) focus:outline-none focus:border-(--color-accent)"
      />

      {loading && (
        <p className="mt-4 text-sm text-(--color-text-muted)">Searching…</p>
      )}

      {error && <p className="motion-banner mt-4 text-sm text-red-400">{error}</p>}

      {delayedAddMessage && (
        <div className="motion-banner mt-4 flex items-center justify-between gap-3 rounded-lg border border-(--color-accent)/40 bg-(--color-accent)/10 px-3 py-2 text-sm text-(--color-accent)">
          <span>{delayedAddMessage}</span>
          <button
            type="button"
            onClick={() => setDelayedAddMessage(null)}
            aria-label="Dismiss"
            className="motion-press shrink-0 text-(--color-accent)/80 hover:text-(--color-accent)"
          >
            ✕
          </button>
        </div>
      )}

      {!loading && !error && !query.trim() && (
        <p className="mt-8 text-center text-(--color-text-muted)">
          Search for a show
        </p>
      )}

      {!loading && !error && searched && query.trim() && results.length === 0 && (
        <p className="mt-8 text-center text-(--color-text-muted)">
          No results
        </p>
      )}

      {!loading && !error && results.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-3">
          {results.map((show) => {
            const isTracked = trackedIds.has(show.id)
            const isAdding = addingIds.has(show.id)
            const isLogging = loggingIds.has(show.id)
            const isLogged = loggedIds.has(show.id)
            const year = show.first_air_date
              ? show.first_air_date.slice(0, 4)
              : null

            return (
              <div
                key={show.id}
                className="overflow-hidden rounded-lg bg-(--color-surface)"
              >
                {show.poster_path ? (
                  <img
                    src={POSTER_BASE + show.poster_path}
                    alt={show.name}
                    className="aspect-2/3 w-full object-cover"
                  />
                ) : (
                  <div className="flex aspect-2/3 w-full items-center justify-center bg-(--color-surface-raised) text-xs text-(--color-text-muted)">
                    No poster
                  </div>
                )}

                <div className="p-2">
                  <p className="truncate text-sm font-medium text-(--color-text)">
                    {show.name}
                  </p>
                  <p className="text-xs text-(--color-text-muted)">
                    {year ?? 'Unknown year'}
                  </p>

                  <button
                    type="button"
                    onClick={() => handleAdd(show)}
                    disabled={isTracked || isAdding}
                    className={`motion-press mt-2 w-full rounded-md py-1.5 text-sm font-medium ${
                      isTracked
                        ? 'bg-(--color-surface-raised) text-(--color-text-muted)'
                        : 'bg-(--color-accent) text-(--color-bg) disabled:opacity-60'
                    }`}
                  >
                    {isTracked ? 'Added' : isAdding ? 'Adding…' : 'Add'}
                  </button>

                  <button
                    type="button"
                    onClick={() => handleLogWatched(show)}
                    disabled={isLogged || isLogging}
                    className={`motion-press mt-1.5 w-full rounded-md py-1.5 text-xs font-medium ${
                      isLogged
                        ? 'bg-(--color-surface-raised) text-(--color-text-muted)'
                        : 'border border-(--color-border) text-(--color-text-muted) disabled:opacity-60'
                    }`}
                  >
                    {isLogged ? 'Logged ✓' : isLogging ? 'Logging…' : 'Log as watched'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
