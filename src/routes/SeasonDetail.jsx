import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getShowDetails, getSeasonEpisodes, getExternalIds } from '../lib/tmdb'
import { getShowReleaseMap } from '../lib/tvmaze'
import { episodeKey, hasAired, formatDate, episodeReleaseInfo } from '../lib/watchHelpers'
import { attachEpisodeReleaseData } from '../lib/watchingShows'
import { classifyReleasePlatform } from '../lib/releasePlatforms'
import {
  showDetailCacheKey,
  seasonDetailCacheKey,
  readDetailCache,
  writeDetailCache,
} from '../lib/detailCache'
import SeasonDetailSkeleton from '../components/SeasonDetailSkeleton'
import {
  markSeasonWatchedMutation,
  toggleEpisodeMutation,
} from '../lib/seasonWatchMutations'

// tmdbId/seasonNumber changes are handled by remounting (see the keyed
// wrapper below) rather than resetting state in an effect, so the
// cache-on-mount initializers below always read the correct season's cache.
function SeasonDetailInner({ tmdbId, seasonNumber }) {
  const numericTmdbId = Number(tmdbId)
  const numericSeasonNumber = Number(seasonNumber)
  const cacheKey = seasonDetailCacheKey(numericTmdbId, numericSeasonNumber)

  const [cached] = useState(() => readDetailCache(cacheKey))
  const [showName, setShowName] = useState(() => cached?.showName ?? '')
  const [episodes, setEpisodes] = useState(() => cached?.episodes ?? null)
  const [watched, setWatched] = useState(() => new Set(cached?.watchedList ?? []))
  const watchedRef = useRef(watched)
  const [loading, setLoading] = useState(() => cached === null)
  const [error, setError] = useState(null)
  const [busyEpisodes, setBusyEpisodes] = useState(new Set())
  const busyEpisodesRef = useRef(new Set())
  const [isSeasonBusy, setIsSeasonBusy] = useState(false)
  const isSeasonBusyRef = useRef(false)

  useEffect(() => {
    let ignore = false

    async function load() {
      setError(null)
      try {
        // getShowAirstamps never throws (any failure → {}), so it's safe to
        // resolve alongside the rest without its own guard. Overlaying the
        // TVmaze airstamp lets this screen show the true IST release day rather
        // than the raw TMDB air_date, which sits one IST day early for
        // evening/night US drops (an HBO Sunday episode lands Monday in IST) —
        // the same correction the Watching list already applies.
        const [{ data: watchedRows, error: watchedError }, details, seasonData, airstamps] =
          await Promise.all([
            supabase
              .from('watched_episodes')
              .select('episode_number')
              .eq('tmdb_show_id', numericTmdbId)
              .eq('season_number', numericSeasonNumber),
            getShowDetails(numericTmdbId),
            getSeasonEpisodes(numericTmdbId, numericSeasonNumber),
            getShowReleaseMap(numericTmdbId, { getExternalIds }),
          ])
        if (watchedError) throw watchedError
        if (ignore) return

        const nextShowName = details.name ?? ''
        const platformInfo = classifyReleasePlatform(details)
        const seasonEpisodes = (seasonData.episodes ?? []).map((ep) => {
          return attachEpisodeReleaseData(ep, airstamps, numericSeasonNumber, platformInfo)
        })
        const watchedList = (watchedRows ?? []).map((row) =>
          episodeKey(numericSeasonNumber, row.episode_number),
        )

        setShowName(nextShowName)
        setEpisodes(seasonEpisodes)
        const nextWatched = new Set(watchedList)
        watchedRef.current = nextWatched
        setWatched(nextWatched)
        writeDetailCache(cacheKey, {
          showName: nextShowName,
          episodes: seasonEpisodes,
          watchedList,
        })
      } catch {
        if (!ignore) setError('Failed to load this season. Try refreshing.')
      } finally {
        if (!ignore) setLoading(false)
      }
    }

    load()
    return () => {
      ignore = true
    }
  }, [numericTmdbId, numericSeasonNumber, cacheKey])

  // Writes the season's own cache with the new watched set, and patches the
  // parent ShowDetail cache (if present) so its watched counts don't go
  // stale until its own background refresh runs — same principle as
  // Watching.jsx's confirmRemove updating its cache right after the mutation
  // succeeds, extended across the two related cache entries.
  function syncWatchedCaches(nextWatchedSet) {
    const watchedList = [...nextWatchedSet]
    writeDetailCache(cacheKey, {
      showName,
      episodes,
      watchedList,
    })

    const showCacheKey = showDetailCacheKey(numericTmdbId)
    const showCached = readDetailCache(showCacheKey)
    if (showCached) {
      const otherSeasonsWatched = (showCached.watchedList ?? []).filter(
        (key) => !key.startsWith(`${numericSeasonNumber}:`),
      )
      writeDetailCache(showCacheKey, {
        ...showCached,
        watchedList: [...otherSeasonsWatched, ...watchedList],
      })
    }
  }

  function commitWatched(nextWatchedSet) {
    const next = new Set(nextWatchedSet)
    watchedRef.current = next
    setWatched(next)
    syncWatchedCaches(next)
  }

  async function toggleEpisode(episode) {
    const episodeNumber = episode.episode_number
    if (busyEpisodesRef.current.has(episodeNumber)) return
    busyEpisodesRef.current.add(episodeNumber)
    setBusyEpisodes(new Set(busyEpisodesRef.current))
    setError(null)

    try {
      await toggleEpisodeMutation({
        supabase,
        tmdbShowId: numericTmdbId,
        seasonNumber: numericSeasonNumber,
        episode,
        getWatched: () => watchedRef.current,
        commitWatched,
      })
    } catch (err) {
      setError(err?.message || 'Could not update this episode. Try again.')
    } finally {
      busyEpisodesRef.current.delete(episodeNumber)
      setBusyEpisodes(new Set(busyEpisodesRef.current))
    }
  }

  async function markSeasonWatched() {
    if (isSeasonBusyRef.current) return
    isSeasonBusyRef.current = true
    setIsSeasonBusy(true)
    setError(null)

    try {
      await markSeasonWatchedMutation({
        supabase,
        episodes,
        tmdbShowId: numericTmdbId,
        seasonNumber: numericSeasonNumber,
        getWatched: () => watchedRef.current,
        commitWatched,
      })
    } catch (err) {
      setError(err?.message || 'Could not mark this season watched. Try again.')
    } finally {
      isSeasonBusyRef.current = false
      setIsSeasonBusy(false)
    }
  }

  const hasUnwatchedAiredEpisodes = (episodes ?? []).some(
    (ep) => hasAired(ep) && !watched.has(episodeKey(numericSeasonNumber, ep.episode_number)),
  )

  return (
    <div className="p-4">
      <div className="flex items-center gap-2">
        <Link
          to={`/watching/${numericTmdbId}`}
          aria-label="Back to show"
          className="motion-press shrink-0 rounded-md p-1 text-lg text-(--color-text-muted)"
        >
          ‹
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold text-(--color-text)">
            Season {numericSeasonNumber}
          </h1>
          {showName && (
            <p className="truncate text-xs text-(--color-text-muted)">{showName}</p>
          )}
        </div>
      </div>

      {loading && <SeasonDetailSkeleton />}

      {error && (
        <div
          role="alert"
          className="motion-banner mt-4 flex min-w-0 items-center justify-between gap-3 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-400"
        >
          <span className="min-w-0 break-words">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss"
            className="motion-press shrink-0 text-red-400/80 hover:text-red-400"
          >
            ✕
          </button>
        </div>
      )}

      {!loading && episodes && (
        <div className="mt-4 flex flex-col gap-2">
          {hasUnwatchedAiredEpisodes && (
            <button
              type="button"
              onClick={markSeasonWatched}
              disabled={isSeasonBusy}
              className="motion-press self-start rounded-md bg-(--color-accent-muted) px-3 py-1.5 text-xs font-medium text-(--color-accent) disabled:opacity-60"
            >
              {isSeasonBusy ? 'Marking…' : 'Mark season watched'}
            </button>
          )}

          {episodes.map((ep) => {
            const epKey = episodeKey(numericSeasonNumber, ep.episode_number)
            const isWatched = watched.has(epKey)
            const isBusy = busyEpisodes.has(ep.episode_number)
            const episodeHasAired = hasAired(ep)
            const release = episodeReleaseInfo(ep)
            const releaseLabel = release ? formatDate(release.istDate) : null

            return (
              <div
                key={ep.episode_number}
                className="flex items-center gap-2 rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-(--color-text)">
                    {ep.episode_number}. {ep.name || 'Untitled'}
                  </p>
                  <p className="text-xs text-(--color-text-muted)">
                    {releaseLabel
                      ? episodeHasAired ? releaseLabel : `Airs ${releaseLabel}`
                      : 'No air date'}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => toggleEpisode(ep)}
                  disabled={isBusy || !episodeHasAired}
                  className={`motion-press shrink-0 rounded-md px-3 py-2 text-xs font-medium disabled:opacity-60 ${
                    isWatched
                      ? 'bg-(--color-accent) text-(--color-bg)'
                      : 'bg-(--color-surface-raised) text-(--color-text-muted)'
                  }`}
                >
                  {isWatched ? 'Watched' : 'Mark watched'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function SeasonDetail() {
  const { tmdbId, seasonNumber } = useParams()
  return (
    <SeasonDetailInner
      key={`${tmdbId}:${seasonNumber}`}
      tmdbId={tmdbId}
      seasonNumber={seasonNumber}
    />
  )
}
