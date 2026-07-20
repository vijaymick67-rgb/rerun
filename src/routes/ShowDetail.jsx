import { useEffect, useRef, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getShowDetails, getSeasonEpisodes, getExternalIds, POSTER_BASE } from '../lib/tmdb'
import { getShowReleaseMap } from '../lib/tvmaze'
import { episodeKey, hasAired } from '../lib/watchHelpers'
import { classifyReleasePlatform } from '../lib/releasePlatforms'
import { attachReleaseData } from '../lib/watchingShows'
import { handleTapNavigateClick } from '../lib/pressIntent'
import {
  showDetailCacheKey,
  seasonDetailCacheKey,
  readDetailCache,
  writeDetailCache,
  clearDetailCache,
} from '../lib/detailCache'
import ShowDetailSkeleton from '../components/ShowDetailSkeleton'
import WatchedCircle from '../components/WatchedCircle'
import ProgressiveImage from '../components/ProgressiveImage'
import { createWatchMutationQueue, toggleSeasonOptimistically } from '../lib/seasonWatchMutations'
import { withTimeout } from '../lib/dataLoading'

// tmdbId changes are handled by remounting (see the keyed wrapper below)
// rather than resetting state in an effect, so the cache-on-mount
// initializers below always read the correct show's cache.
function ShowDetailInner({ tmdbId }) {
  const navigate = useNavigate()
  const numericTmdbId = Number(tmdbId)
  const cacheKey = showDetailCacheKey(numericTmdbId)

  const [cached] = useState(() => readDetailCache(cacheKey))
  const [show, setShow] = useState(() => cached?.show ?? null)
  const [seasons, setSeasons] = useState(() => cached?.seasons ?? [])
  const [episodesBySeason, setEpisodesBySeason] = useState(() => cached?.episodesBySeason ?? {})
  const [watched, setWatched] = useState(() => new Set(cached?.watchedList ?? []))
  const watchedRef = useRef(watched)
  const mutationQueueRef = useRef(createWatchMutationQueue())
  const [loading, setLoading] = useState(() => cached === null)
  const [error, setError] = useState(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const retryingRef = useRef(false)

  useEffect(() => {
    let ignore = false

    async function load() {
      const mutationVersion = mutationQueueRef.current.version
      setError(null)
      try {
        const { data: trackedShow, error: showError } = await withTimeout((signal) => {
          let query = supabase
            .from('tracked_shows')
            .select('*')
            .eq('tmdb_id', numericTmdbId)
            .maybeSingle()
          if (signal && typeof query.abortSignal === 'function') query = query.abortSignal(signal)
          return query
        }, { stage: 'show-detail-tracked-show', source: 'supabase' })
        if (showError) throw showError
        if (!trackedShow) {
          if (!ignore) {
            setShow(null)
            clearDetailCache(cacheKey)
          }
          return
        }

        const { data: watchedRows, error: watchedError } = await withTimeout((signal) => {
          let query = supabase
            .from('watched_episodes')
            .select('season_number, episode_number')
            .eq('tmdb_show_id', numericTmdbId)
          if (signal && typeof query.abortSignal === 'function') query = query.abortSignal(signal)
          return query
        }, { stage: 'show-detail-watched-episodes', source: 'supabase' })
        if (watchedError) throw watchedError

        const [details, releaseMap] = await Promise.all([
          withTimeout(() => getShowDetails(numericTmdbId), {
            stage: 'show-detail-details', source: 'tmdb',
          }),
          withTimeout(() => getShowReleaseMap(numericTmdbId, { getExternalIds }), {
            stage: 'show-detail-release-map', source: 'tvmaze',
          }).catch(() => ({})),
        ])
        const seasonList = (details.seasons ?? [])
          .filter((season) => season.season_number > 0)
          .sort((a, b) => a.season_number - b.season_number)

        const episodesArrays = await Promise.all(
          seasonList.map((season) => withTimeout(
            () => getSeasonEpisodes(numericTmdbId, season.season_number),
            { stage: 'show-detail-season-episodes', source: 'tmdb' },
          )),
        )
        const plainEpisodesBySeason = {}
        seasonList.forEach((season, i) => {
          plainEpisodesBySeason[season.season_number] = episodesArrays[i].episodes
        })
        const bySeason = attachReleaseData(
          plainEpisodesBySeason,
          releaseMap,
          classifyReleasePlatform(details),
        )

        if (ignore) return

        const watchedList = (watchedRows ?? []).map((row) =>
          episodeKey(row.season_number, row.episode_number),
        )

        setShow(trackedShow)
        setSeasons(seasonList)
        setEpisodesBySeason(bySeason)
        const nextWatched = mutationQueueRef.current.version === mutationVersion
          ? new Set(watchedList)
          : watchedRef.current
        watchedRef.current = nextWatched
        setWatched(nextWatched)
        writeDetailCache(cacheKey, {
          show: trackedShow,
          seasons: seasonList,
          episodesBySeason: bySeason,
          watchedList: [...nextWatched],
        })
      } catch {
        if (!ignore) setError(cached
          ? 'Couldn\'t refresh this show. Try again.'
          : 'Failed to load this show. Try again.')
      } finally {
        if (!ignore) {
          setLoading(false)
          setRefreshing(false)
          retryingRef.current = false
        }
      }
    }

    load()
    return () => {
      ignore = true
    }
  }, [numericTmdbId, cacheKey, loadAttempt, cached])

  function retryLoad() {
    if (retryingRef.current) return
    retryingRef.current = true
    setRefreshing(true)
    setLoading(cached === null)
    setLoadAttempt((attempt) => attempt + 1)
  }

  const totalEpisodeCount = seasons.reduce(
    (sum, season) => sum + (episodesBySeason[season.season_number]?.length ?? 0),
    0,
  )
  const totalWatchedCount = seasons.reduce((sum, season) => {
    const episodes = episodesBySeason[season.season_number] ?? []
    return (
      sum +
      episodes.filter((ep) => watched.has(episodeKey(season.season_number, ep.episode_number)))
        .length
    )
  }, 0)

  function commitWatched(nextWatchedSet, seasonNumber) {
    const next = new Set(nextWatchedSet)
    watchedRef.current = next
    setWatched(next)
    const watchedList = [...next]
    writeDetailCache(cacheKey, { show, seasons, episodesBySeason, watchedList })
    const seasonCacheKey = seasonDetailCacheKey(numericTmdbId, seasonNumber)
    const seasonCached = readDetailCache(seasonCacheKey)
    writeDetailCache(seasonCacheKey, {
      showName: seasonCached?.showName ?? show?.name ?? '',
      episodes: seasonCached?.episodes ?? episodesBySeason[seasonNumber] ?? [],
      watchedList: watchedList.filter((key) => key.startsWith(`${seasonNumber}:`)),
    })
  }

  function toggleSeason(seasonNumber) {
    setError(null)
    toggleSeasonOptimistically({
      queue: mutationQueueRef.current,
      supabase,
      episodes: episodesBySeason[seasonNumber] ?? [],
      tmdbShowId: numericTmdbId,
      seasonNumber,
      getWatched: () => watchedRef.current,
      commitWatched: (next) => commitWatched(next, seasonNumber),
    }).catch((err) => setError(err?.message || 'Could not update this season. Try again.'))
  }

  return (
    <div className="nested-page px-4 pb-4">
      <div className="nested-header">
        <Link
          to="/watching"
          aria-label="Back to Watching"
          className="motion-press flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-lg text-(--color-text-muted)"
        >
          ‹
        </Link>
        {loading ? (
          <div className="h-5 w-40 animate-pulse rounded bg-(--color-surface-raised)" />
        ) : (
          <h1 className="min-w-0 truncate text-xl font-semibold text-(--color-text)">
            {show ? show.name : 'Show'}
          </h1>
        )}
      </div>

      {loading && <ShowDetailSkeleton />}

      {error && (
        <div className={`motion-banner mt-4 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${show ? 'border-(--color-upcoming)/40 bg-(--color-upcoming-muted) text-(--color-upcoming)' : 'border-(--color-destructive)/40 bg-(--color-destructive-muted) text-(--color-destructive)'}`} role="alert">
          <span>{error}</span>
          <button type="button" onClick={retryLoad} disabled={refreshing} className="motion-press min-h-11 shrink-0 rounded-md px-2 font-semibold underline disabled:opacity-60">
            {refreshing ? 'Retrying...' : 'Retry'}
          </button>
          {show && (<button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss"
            className="motion-press min-h-11 min-w-11 shrink-0 text-(--color-destructive)/80 hover:text-(--color-destructive)"
          >
            ✕
          </button>)}
        </div>
      )}

      {!loading && !error && show === null && (
        <p className="mt-8 text-center text-(--color-text-muted)">
          Show not found.{' '}
          <Link to="/watching" className="text-(--color-accent)">
            Back to Watching
          </Link>
        </p>
      )}

      {!loading && show && (
        <>
          <div className="content-surface mt-4 flex gap-3 p-3">
            <ProgressiveImage
              src={show.poster_path ? POSTER_BASE + show.poster_path : null}
              alt={show.name}
              fallbackLabel="No poster"
              loading="eager"
              fetchPriority="high"
              className="h-32 w-24 shrink-0 rounded-md"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-(--color-text-muted)">
                {seasons.length} season{seasons.length === 1 ? '' : 's'}
              </p>

              {totalEpisodeCount > 0 && (
                <>
                  <p className="mt-1 text-sm text-(--color-text-muted)">
                    {totalWatchedCount}/{totalEpisodeCount} episodes watched
                  </p>
                  <div className="progress-track mt-3 w-full">
                    <div
                      className="progress-fill"
                      style={{ width: `${(totalWatchedCount / totalEpisodeCount) * 100}%` }}
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2">
            {seasons.length === 0 && (
              <p className="text-sm text-(--color-text-muted)">
                Couldn't load season data for this show.
              </p>
            )}

            {seasons.map((season) => {
              const episodes = episodesBySeason[season.season_number] ?? []
              const watchedCount = episodes.filter((ep) =>
                watched.has(episodeKey(season.season_number, ep.episode_number)),
              ).length
              const eligible = episodes.filter(hasAired)
              const isWatched = eligible.length > 0 && eligible.every((episode) =>
                watched.has(episodeKey(season.season_number, episode.episode_number)),
              )

              return (
                <div
                  key={season.season_number}
                  className="content-row flex items-center pl-3 pr-1"
                >
                  <Link
                    to={`/watching/${numericTmdbId}/season/${season.season_number}`}
                    onClick={(e) => handleTapNavigateClick(
                      e, navigate, `/watching/${numericTmdbId}/season/${season.season_number}`,
                    )}
                    className="motion-press flex min-w-0 flex-1 items-center justify-between py-3 pr-2"
                  >
                    <span className="text-sm font-medium text-(--color-text)">
                      Season {season.season_number}
                    </span>
                    <span className="flex items-center gap-2 text-xs text-(--color-text-muted)">
                      {watchedCount}/{episodes.length}
                      <span aria-hidden="true">›</span>
                    </span>
                  </Link>
                  <WatchedCircle
                    checked={isWatched}
                    disabled={eligible.length === 0}
                    label={`Mark season ${season.season_number} ${isWatched ? 'unwatched' : 'watched'}`}
                    onClick={() => toggleSeason(season.season_number)}
                  />
                </div>
              )
            })}
          </div>

        </>
      )}
    </div>
  )
}

export default function ShowDetail() {
  const { tmdbId } = useParams()
  return <ShowDetailInner key={tmdbId} tmdbId={tmdbId} />
}
