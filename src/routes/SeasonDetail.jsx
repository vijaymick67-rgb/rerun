import { useEffect, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getShowDetails, getSeasonEpisodes, getExternalIds } from '../lib/tmdb'
import { getShowReleaseMap } from '../lib/tvmaze'
import { episodeKey, hasAired, formatDate, episodeReleaseInfo } from '../lib/watchHelpers'
import { attachEpisodeReleaseData } from '../lib/watchingShows'
import { classifyReleasePlatform } from '../lib/releasePlatforms'
import {
  seasonDetailCacheKey,
  readDetailCache,
  writeDetailCache,
  patchEpisodeWatchedCaches,
  setOptimisticWatchOverlay,
  clearOptimisticWatchOverlay,
  reconcileWatchedListWithOverlay,
  getOptimisticWatchRevision,
} from '../lib/detailCache'
import SeasonDetailSkeleton from '../components/SeasonDetailSkeleton'
import WatchedCircle from '../components/WatchedCircle'
import {
  createWatchMutationQueue,
  toggleEpisodeOptimistically,
} from '../lib/seasonWatchMutations'
import { withTimeout } from '../lib/dataLoading'

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
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const retryingRef = useRef(false)
  const mutationQueueRef = useRef(createWatchMutationQueue())

  useEffect(() => {
    let ignore = false

    async function load() {
      const mutationVersion = mutationQueueRef.current.version
      const overlayRevision = getOptimisticWatchRevision(numericTmdbId)
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
            withTimeout((signal) => {
              let query = supabase
                .from('watched_episodes')
                .select('episode_number')
                .eq('tmdb_show_id', numericTmdbId)
                .eq('season_number', numericSeasonNumber)
              if (signal && typeof query.abortSignal === 'function') query = query.abortSignal(signal)
              return query
            }, { stage: 'season-detail-watched-episodes', source: 'supabase' }),
            withTimeout(() => getShowDetails(numericTmdbId), {
              stage: 'season-detail-details', source: 'tmdb',
            }),
            withTimeout(() => getSeasonEpisodes(numericTmdbId, numericSeasonNumber), {
              stage: 'season-detail-episodes', source: 'tmdb',
            }),
            withTimeout(() => getShowReleaseMap(numericTmdbId, { getExternalIds }), {
              stage: 'season-detail-release-map', source: 'tvmaze',
            }).catch(() => ({})),
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
        // Trust the fetched rows only if no local mutation happened during the
        // load AND no cross-route optimistic overlay changed while it was in
        // flight; even then, reconcile against any still-pending overlay so a
        // stale snapshot can't drop an unsettled optimistic mark. Otherwise
        // keep the live (optimistic) watched set. See detailCache.js.
        const overlayUnchanged = getOptimisticWatchRevision(numericTmdbId) === overlayRevision
        const nextWatched = mutationQueueRef.current.version === mutationVersion && overlayUnchanged
          ? new Set(reconcileWatchedListWithOverlay(numericTmdbId, watchedList, {
            seasonNumber: numericSeasonNumber,
          }))
          : watchedRef.current
        watchedRef.current = nextWatched
        setWatched(nextWatched)
        writeDetailCache(cacheKey, {
          showName: nextShowName,
          episodes: seasonEpisodes,
          watchedList: [...nextWatched],
        })
      } catch {
        if (!ignore) setError(cached
          ? 'Couldn\'t refresh this season. Try again.'
          : 'Failed to load this season. Try again.')
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
  }, [numericTmdbId, numericSeasonNumber, cacheKey, loadAttempt, cached])

  function retryLoad() {
    if (retryingRef.current) return
    retryingRef.current = true
    setRefreshing(true)
    setLoading(cached === null)
    setLoadAttempt((attempt) => attempt + 1)
  }

  // Updates local state with the new watched set, then patches this exact
  // episode into both this season's own cache and the parent ShowDetail
  // cache (if present) through the shared helper — same principle as
  // Watching.jsx's confirmRemove updating its cache right after the
  // mutation succeeds, extended across the two related cache entries.
  function commitWatchedEpisode(nextWatchedSet, episodeNumber, overlayHolder) {
    const next = new Set(nextWatchedSet)
    watchedRef.current = next
    setWatched(next)
    const watched = next.has(episodeKey(numericSeasonNumber, episodeNumber))
    patchEpisodeWatchedCaches({
      tmdbShowId: numericTmdbId,
      seasonNumber: numericSeasonNumber,
      episodeNumber,
      watched,
    })
    // Hold a cross-route overlay while this toggle's upsert is pending, so the
    // parent Show Detail page opened right after can't revert it from a stale
    // read (see detailCache.js). The token records who owns this entry so a
    // rapid re-toggle's later mutation isn't cleared by this one settling.
    overlayHolder.token = setOptimisticWatchOverlay({
      tmdbShowId: numericTmdbId,
      seasonNumber: numericSeasonNumber,
      episodeNumber,
      watched,
    })
  }

  function toggleEpisode(episode) {
    if (!hasAired(episode)) return
    setError(null)
    // Mutable holder so the latest commit (optimistic set, or rollback set for
    // the last failed tap) records the overlay token this toggle owns; the
    // finally clears only if that token still owns the entry.
    const overlayHolder = { token: null }
    toggleEpisodeOptimistically({
      queue: mutationQueueRef.current,
      supabase,
      tmdbShowId: numericTmdbId,
      seasonNumber: numericSeasonNumber,
      episode,
      getWatched: () => watchedRef.current,
      commitWatched: (next) => commitWatchedEpisode(next, episode.episode_number, overlayHolder),
    })
      .catch((err) => setError(err?.message || 'Could not update this episode. Try again.'))
      .finally(() => clearOptimisticWatchOverlay({
        tmdbShowId: numericTmdbId,
        seasonNumber: numericSeasonNumber,
        episodeNumber: episode.episode_number,
        token: overlayHolder.token,
      }))
  }

  const releasedEpisodes = episodes?.filter(hasAired) ?? []
  const watchedReleasedCount = releasedEpisodes.filter((episode) =>
    watched.has(episodeKey(numericSeasonNumber, episode.episode_number)),
  ).length
  const seasonProgressPercent = releasedEpisodes.length > 0
    ? Math.round((watchedReleasedCount / releasedEpisodes.length) * 100)
    : 0

  return (
    <div className="nested-page px-4 pb-4 season-detail-page">
      <div className="nested-header phase2-nested-header">
        <Link
          to={`/watching/${numericTmdbId}`}
          aria-label="Back to show"
          className="nested-header__back motion-press min-h-11 min-w-11"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m15 5-7 7 7 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <div className="nested-header__copy">
          <h1 className="nested-header__title type-nested-title text-(--color-text)">
            Season {numericSeasonNumber}
          </h1>
          {showName && (
            <p className="nested-header__subtitle">{showName}</p>
          )}
        </div>
      </div>

      {loading && <SeasonDetailSkeleton />}

      {error && (
        <div
          role="alert"
          className={`motion-banner mt-4 flex min-w-0 items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${episodes ? 'border-(--color-upcoming)/40 bg-(--color-upcoming-muted) text-(--color-upcoming)' : 'border-(--color-destructive)/40 bg-(--color-destructive-muted) text-(--color-destructive)'}`}
        >
          <span className="min-w-0 break-words">{error}</span>
          <button type="button" onClick={retryLoad} disabled={refreshing} className="motion-press min-h-11 shrink-0 rounded-md px-2 font-semibold underline disabled:opacity-60">
            {refreshing ? 'Retrying...' : 'Retry'}
          </button>
          {episodes && (<button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss"
            className="motion-press min-h-11 min-w-11 shrink-0 text-(--color-destructive)/80 hover:text-(--color-destructive)"
          >
            ✕
          </button>)}
        </div>
      )}

      {!loading && episodes && (
        <>
          <section className="route-progress-summary season-progress-summary" aria-label={`Season ${numericSeasonNumber} progress`}>
            <div>
              <p className="route-kicker">Released episodes</p>
              <p className="season-progress-summary__copy">
                <strong>{watchedReleasedCount}</strong> of {releasedEpisodes.length} watched
              </p>
            </div>
            <div className="progress-track" role="progressbar" aria-label={`Season ${numericSeasonNumber} watch progress`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={seasonProgressPercent}>
              <div className="progress-fill" style={{ width: `${seasonProgressPercent}%` }} />
            </div>
          </section>

          <div className="route-section-heading season-episode-heading">
            <div>
              <p className="route-kicker">Season ledger</p>
              <h2>Episodes</h2>
            </div>
            <p>{episodes.length} total</p>
          </div>

          <section className="season-episodes" aria-label="Episodes">
          {episodes.map((ep) => {
            const epKey = episodeKey(numericSeasonNumber, ep.episode_number)
            const isWatched = watched.has(epKey)
            const episodeHasAired = hasAired(ep)
            const release = episodeReleaseInfo(ep)
            const releaseLabel = release ? formatDate(release.istDate) : null

            return (
              <div
                key={ep.episode_number}
                className={`loki-record-row content-row season-episode-row flex items-center gap-2 px-3 py-1.5 ${episodeHasAired ? '' : 'season-episode-row--future'}`}
              >
                <div className="season-episode-copy min-w-0 flex-1 py-1">
                  <p className="season-episode-title type-episode-title">
                    {ep.episode_number}. {ep.name || 'Untitled'}
                  </p>
                  <p className="season-episode-meta type-metadata">
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
          </section>
        </>
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
