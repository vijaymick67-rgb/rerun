import { useEffect, useRef, useState } from 'react'
import { searchShows, getExternalIds, getShowDetails, POSTER_BASE } from '../lib/tmdb'
import { supabase } from '../lib/supabase'
import { daysUntil, daysUntilRelease, releaseSources } from '../lib/watchHelpers'
import { getShowReleaseMap } from '../lib/tvmaze'
import { attachEpisodeReleaseData } from '../lib/watchingShows'
import { classifyReleasePlatform } from '../lib/releasePlatforms'
import { buildAiredEpisodeRows, upsertWatchedRows } from '../lib/bulkMarkWatched'
import { removeTrackedShow, upsertTrackedShow } from '../lib/finishedShows'
import BrowseDiscover from '../components/BrowseDiscover'
import BrowseResultsSkeleton from '../components/BrowseResultsSkeleton'
import ProgressiveImage from '../components/ProgressiveImage'
import { upsertTrackedShowForNews } from '../lib/news/trackedShows'
import { withTimeout } from '../lib/dataLoading'
import {
  discoverSession,
  isTrackedFetchFresh,
  markTrackedFetched,
  readTrackedContent,
  writeTrackedContent,
} from '../lib/discover/discoverSession'

const DEBOUNCE_MS = 400
const DELAYED_ADD_THRESHOLD_DAYS = 60

function upsertTrackedShowForDiscover(trackedShows, show) {
  return upsertTrackedShowForNews(trackedShows, show).map((item) => (
    item.tmdb_id === show.id
      ? {
          ...item,
          poster_path: show.poster_path ?? item.poster_path ?? null,
          first_air_date: show.first_air_date ?? item.first_air_date ?? null,
        }
      : item
  ))
}

export default function Browse() {
  // Seed the tracked library synchronously from the page-session snapshot so a
  // quick return to Discover paints the last valid feed immediately instead of
  // the tracked-shows-not-ready skeleton. On the first-ever visit the snapshot is
  // null and the original cold-load skeleton path is preserved.
  const initialTracked = readTrackedContent()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [searchAttempt, setSearchAttempt] = useState(0)
  const [searched, setSearched] = useState(false)
  const [trackedIds, setTrackedIds] = useState(() => initialTracked?.ids ?? new Set())
  const [trackedShows, setTrackedShows] = useState(() => initialTracked?.shows ?? [])
  const [trackedShowsReady, setTrackedShowsReady] = useState(() => initialTracked != null)
  const [addingIds, setAddingIds] = useState(new Set())
  const [removingIds, setRemovingIds] = useState(new Set())
  const [trackErrors, setTrackErrors] = useState({})
  const [logErrors, setLogErrors] = useState({})
  const [loggingIds, setLoggingIds] = useState(new Set())
  const [loggedIds, setLoggedIds] = useState(new Set())
  const [delayedAddMessage, setDelayedAddMessage] = useState(null)
  const [undoingId, setUndoingId] = useState(null)
  const [undoError, setUndoError] = useState(null)
  const [notAiredIds, setNotAiredIds] = useState(new Set())
  const knownTrackedIdsRef = useRef(initialTracked ? new Set(initialTracked.knownIds) : new Set())
  const debounceRef = useRef(null)

  // Mirror the live tracked library into the page-session snapshot so the next
  // remount can seed from it. This only copies CONTENT — it never advances the
  // freshness clock (markTrackedFetched does that), so mounting/leaving/returning
  // cannot keep the clock perpetually fresh and starve the background re-read.
  useEffect(() => {
    if (!trackedShowsReady) return
    writeTrackedContent({
      shows: trackedShows,
      ids: trackedIds,
      knownIds: new Set(knownTrackedIdsRef.current),
    })
  }, [trackedShows, trackedIds, trackedShowsReady])

  useEffect(() => {
    // Skip the tracked_shows read on a quick return: the snapshot already seeded
    // state (no skeleton) and the library was authoritatively read within the
    // freshness window. When stale/absent the read runs as a background refresh
    // while the seeded cache stays visible (stale-while-revalidate).
    if (isTrackedFetchFresh(Date.now())) return undefined
    let ignore = false
    withTimeout((signal) => {
      let query = supabase
        .from('tracked_shows')
        .select('tmdb_id, name, poster_path, hidden_at')
      if (signal && typeof query.abortSignal === 'function') query = query.abortSignal(signal)
      return query
    }, { stage: 'browse-tracked-shows', source: 'supabase' })
      .then(({ data, error: fetchError }) => {
        if (ignore) return
        if (!fetchError && data) {
          const active = data.filter((row) => row.hidden_at == null)
          knownTrackedIdsRef.current = new Set(data.map((row) => row.tmdb_id))
          setTrackedShows(active)
          setTrackedIds(new Set(active.map((row) => row.tmdb_id)))
          markTrackedFetched(Date.now())
        }
        setTrackedShowsReady(true)
      })
      .catch(() => {
        if (!ignore) setTrackedShowsReady(true)
      })
    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    let ignore = false
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
        const data = await withTimeout(
          () => searchShows(query.trim()),
          { stage: 'browse-search', source: 'tmdb' },
        )
        if (!ignore) setResults(data)
      } catch {
        if (!ignore) {
          setError('Search failed. Try again.')
          setResults([])
        }
      } finally {
        if (!ignore) {
          setSearched(true)
          setLoading(false)
        }
      }
    }, DEBOUNCE_MS)

    return () => {
      ignore = true
      clearTimeout(debounceRef.current)
    }
  }, [query, searchAttempt])

  async function handleAdd(show) {
    const wasTracked = knownTrackedIdsRef.current.has(show.id)
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
      knownTrackedIdsRef.current.add(show.id)
      setTrackedIds((prev) => new Set(prev).add(show.id))
      setTrackedShows((prev) => upsertTrackedShowForDiscover(prev, show))
    } else {
      setTrackErrors((prev) => ({ ...prev, [show.id]: 'Could not update tracking. Try again.' }))
      return false
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
        setUndoError(null)
        setDelayedAddMessage({
          show,
          undoable: !wasTracked,
          text: "This show premieres in a while! We'll automatically add it to your Watching tab closer to the release date.",
        })
      }
    } catch {
      // best-effort — premiere timing is a nice-to-have, the show is already tracked
    }
    return true
  }

  async function handleTrackToggle(show) {
    const isTracked = trackedIds.has(show.id)
    const pendingSet = isTracked ? setRemovingIds : setAddingIds
    pendingSet((prev) => new Set(prev).add(show.id))
    setTrackErrors((prev) => {
      const next = { ...prev }
      delete next[show.id]
      return next
    })

    try {
      if (isTracked) {
        await removeTrackedShow(supabase, show.id)
        knownTrackedIdsRef.current.delete(show.id)
        setTrackedIds((prev) => {
          const next = new Set(prev)
          next.delete(show.id)
          return next
        })
        setTrackedShows((prev) => prev.filter((item) => item.tmdb_id !== show.id))
        setDelayedAddMessage((pending) => pending?.show.id === show.id ? null : pending)
      } else {
        return await handleAdd(show)
      }
      return true
    } catch {
      setTrackErrors((prev) => ({ ...prev, [show.id]: 'Could not update tracking. Try again.' }))
      return false
    } finally {
      pendingSet((prev) => {
        const next = new Set(prev)
        next.delete(show.id)
        return next
      })
    }
  }

  async function handleUndoDelayedAdd() {
    const pending = delayedAddMessage
    if (!pending?.undoable || undoingId != null) return
    setUndoingId(pending.show.id)
    setUndoError(null)
    const succeeded = await handleTrackToggle(pending.show)
    setUndoingId(null)
    if (succeeded) {
      setUndoError(null)
      setDelayedAddMessage(null)
    } else {
      setUndoError('Could not undo this show. Try again.')
    }
  }

  // "Log as watched" — retroactively log a show finished before using the app,
  // without ticking every episode by hand. Ensures the show is tracked (same
  // UNIQUE_VIOLATION handling as handleAdd), then bulk-marks every already-aired
  // episode watched via the shared bulk-mark routine. Unaired future episodes
  // are skipped — they don't exist yet to mark, even though the user is claiming
  // to have "seen the whole show".
  async function handleLogWatched(show) {
    setLogErrors((prev) => {
      const next = { ...prev }
      delete next[show.id]
      return next
    })
    setLoggingIds((prev) => new Set(prev).add(show.id))

    try {
      const { rows } = await buildAiredEpisodeRows(show.id)
      if (rows.length === 0) {
        setNotAiredIds((prev) => new Set(prev).add(show.id))
        return
      }

      await upsertTrackedShow(supabase, show)
      knownTrackedIdsRef.current.add(show.id)
      setTrackedIds((prev) => new Set(prev).add(show.id))
      setTrackedShows((prev) => upsertTrackedShowForDiscover(prev, show))
      await upsertWatchedRows(rows)

      setNotAiredIds((prev) => {
        const next = new Set(prev)
        next.delete(show.id)
        return next
      })
      setLoggedIds((prev) => new Set(prev).add(show.id))
    } catch {
      setLogErrors((prev) => ({ ...prev, [show.id]: 'Could not log this show. Try again.' }))
    } finally {
      setLoggingIds((prev) => {
        const next = new Set(prev)
        next.delete(show.id)
        return next
      })
    }
  }

  return (
    <div className="app-page px-4 pb-4">
      <header className="route-heading">
        <h1 className="type-page-title text-(--color-text)">Discover</h1>
      </header>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find a show…"
        className="browse-search"
      />

      {loading && (
        <>
          <p role="status" aria-live="polite" className="sr-only">Searching…</p>
          <BrowseResultsSkeleton />
        </>
      )}

      {error && (
        <p role="alert" className="motion-banner mt-4 flex items-center justify-between gap-3 text-sm text-(--color-destructive)">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setSearchAttempt((attempt) => attempt + 1)}
            className="motion-press shrink-0 font-semibold underline"
          >
            Retry
          </button>
        </p>
      )}

      {delayedAddMessage && (
        <div className="motion-banner mt-4 flex items-center justify-between gap-3 rounded-lg border border-(--color-accent)/40 bg-(--color-accent)/10 px-3 py-2 text-sm text-(--color-accent)">
          <span>{delayedAddMessage.text}</span>
          {delayedAddMessage.undoable && (
            <button type="button" onClick={handleUndoDelayedAdd} disabled={undoingId != null} className="motion-press shrink-0 font-medium underline">
              {undoingId != null ? 'Undoing…' : 'Undo'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setDelayedAddMessage(null)}
            aria-label="Dismiss"
            className="motion-press min-h-11 min-w-11 shrink-0 text-(--color-accent)/80 hover:text-(--color-accent)"
          >
            ✕
          </button>
        </div>
      )}

      {undoError && <p role="alert" className="mt-2 text-xs text-(--color-destructive)">{undoError} <button type="button" onClick={handleUndoDelayedAdd} className="motion-press underline">Retry</button></p>}

      {!loading && !error && searched && query.trim() && results.length === 0 && (
        <p className="empty-state">
          No results
        </p>
      )}

      {!loading && !error && results.length > 0 && (
        <section aria-labelledby="search-results-heading" className="mt-5">
          <h2 id="search-results-heading" className="type-section-title text-(--color-text)">
            Search results
          </h2>
          <div className="mt-2 grid grid-cols-2 gap-3">
          {results.map((show) => {
            const isTracked = trackedIds.has(show.id)
            const isAdding = addingIds.has(show.id)
            const isRemoving = removingIds.has(show.id)
            const isLogging = loggingIds.has(show.id)
            const isLogged = loggedIds.has(show.id)
            const year = show.first_air_date
              ? show.first_air_date.slice(0, 4)
              : null

            return (
              <div
                key={show.id}
                className="poster-card"
              >
                <ProgressiveImage
                  src={show.poster_path ? POSTER_BASE + show.poster_path : null}
                  alt={show.name}
                  fallbackLabel="No poster"
                  className="aspect-2/3 w-full"
                />

                <div className="p-2">
                  <p className="type-show-title truncate text-(--color-text)">
                    {show.name}
                  </p>
                  <p className="type-metadata text-(--color-text-muted)">
                    {year ?? 'Unknown year'}
                  </p>

                  <button
                    type="button"
                    onClick={() => handleTrackToggle(show)}
                    disabled={isAdding || isRemoving}
                    className={`motion-press mt-2 min-h-11 w-full rounded-md py-1.5 text-sm font-medium ${
                      isTracked
                        ? 'border border-(--color-border) bg-(--color-surface-interactive) text-(--color-text-secondary)'
                        : 'bg-(--color-gold-accent-strong) text-(--color-canvas-deep) disabled:opacity-60'
                    }`}
                  >
                    {isRemoving ? 'Removing…' : isAdding ? 'Adding…' : isTracked ? 'Added' : 'Add'}
                  </button>
                  {trackErrors[show.id] && (
                    <p role="alert" className="mt-1 text-xs text-(--color-destructive)">
                      {trackErrors[show.id]} <button type="button" onClick={() => handleTrackToggle(show)} className="motion-press underline">Retry</button>
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={() => handleLogWatched(show)}
                    disabled={isLogged || isLogging}
                    className={`motion-press mt-1.5 min-h-11 w-full rounded-md py-1.5 text-xs font-medium border border-(--color-border) ${
                      isLogged
                        ? 'bg-(--color-surface-interactive) text-(--color-text-secondary)'
                        : 'text-(--color-text-secondary) disabled:opacity-60'
                    }`}
                  >
                    {isLogged ? 'Logged ✓' : isLogging ? 'Logging…' : 'Log as watched'}
                  </button>
                  {notAiredIds.has(show.id) && (
                    <p role="status" className="mt-1 text-xs text-(--color-text-muted)">Not aired yet</p>
                  )}
                  {logErrors[show.id] && (
                    <p role="alert" className="mt-1 text-xs text-(--color-destructive)">
                      {logErrors[show.id]} <button type="button" onClick={() => handleLogWatched(show)} className="motion-press ml-1 underline">Retry</button>
                    </p>
                  )}
                </div>
              </div>
            )
          })}
          </div>
        </section>
      )}

      <BrowseDiscover
        trackedShows={trackedShows}
        trackedShowsReady={trackedShowsReady}
        hidden={Boolean(query.trim())}
        session={discoverSession}
      />
    </div>
  )
}
