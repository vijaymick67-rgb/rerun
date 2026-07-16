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
import WatchedCircle from '../components/WatchedCircle'
import {
  createWatchMutationQueue,
  toggleEpisodeOptimistically,
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
  const mutationQueueRef = useRef(createWatchMutationQueue())

  useEffect(() => {
    let ignore = false

    async function load() {
      const mutationVersion = mutationQueueRef.current.version
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
        const nextWatched = mutationQueueRef.current.version === mutationVersion
          ? new Set(watchedList)
          : watchedRef.current
        watchedRef.current = nextWatched
        setWatched(nextWatched)
        writeDetailCache(cacheKey, {
          showName: nextShowName,
          episodes: seasonEpisodes,
          watchedList: [...nextWatched],
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

  function toggleEpisode(episode) {
    if (!hasAired(episode)) return
    setError(null)
    toggleEpisodeOptimistically({
      queue: mutationQueueRef.current,
      supabase,
      tmdbShowId: numericTmdbId,
      seasonNumber: numericSeasonNumber,
      episode,
      getWatched: () => watchedRef.current,
      commitWatched,
    })
      .catch((err) => setError(err?.message || 'Could not update this episode. Try again.'))
  }

  return (
    <div className="nested-page px-4 pb-4">
      <div className="flex min-h-11 items-center gap-2">
        <Link
          to={`/watching/${numericTmdbId}`}
          aria-label="Back to show"
          className="motion-press flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-lg text-(--color-text-muted)"
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
          {episodes.map((ep) => {
            const epKey = episodeKey(numericSeasonNumber, ep.episode_number)
            const isWatched = watched.has(epKey)
            const episodeHasAired = hasAired(ep)
            const release = episodeReleaseInfo(ep)
            const releaseLabel = release ? formatDate(release.istDate) : null

            return (
              <div
                key={ep.episode_number}
                className={`flex items-center gap-2 rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-1.5 ${episodeHasAired ? '' : 'opacity-50'}`}
              >
                <div className={`min-w-0 flex-1 py-1 ${
                  episodeHasAired
                    ? 'transition-transform duration-75 active:translate-y-px motion-reduce:transform-none'
                    : ''
                }`}>
                  <p className="truncate text-sm text-(--color-text)">
                    {ep.episode_number}. {ep.name || 'Untitled'}
                  </p>
                  <p className="text-xs text-(--color-text-muted)">
                    {releaseLabel
                      ? episodeHasAired ? releaseLabel : `Airs ${releaseLabel}`
                      : 'No air date'}
                  </p>
                </div>

                <WatchedCircle
                  checked={isWatched}
                  disabled={!episodeHasAired}
                  label={`Mark episode ${ep.episode_number} ${isWatched ? 'unwatched' : 'watched'}`}
                  onClick={() => toggleEpisode(ep)}
                />
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
