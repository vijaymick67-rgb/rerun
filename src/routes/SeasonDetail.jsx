import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getShowDetails, getSeasonEpisodes } from '../lib/tmdb'
import { episodeKey, hasAired, formatDate } from '../lib/watchHelpers'
import { releaseRuleForShow } from '../lib/networkReleaseTiming'
import {
  showDetailCacheKey,
  seasonDetailCacheKey,
  readDetailCache,
  writeDetailCache,
} from '../lib/detailCache'
import SeasonDetailSkeleton from '../components/SeasonDetailSkeleton'

// tmdbId/seasonNumber changes are handled by remounting (see the keyed
// wrapper below) rather than resetting state in an effect, so the
// cache-on-mount initializers below always read the correct season's cache.
function SeasonDetailInner({ tmdbId, seasonNumber }) {
  const numericTmdbId = Number(tmdbId)
  const numericSeasonNumber = Number(seasonNumber)
  const cacheKey = seasonDetailCacheKey(numericTmdbId, numericSeasonNumber)

  const [cached] = useState(() => readDetailCache(cacheKey))
  const [showName, setShowName] = useState(() => cached?.showName ?? '')
  const [releaseRule, setReleaseRule] = useState(() => cached?.releaseRule)
  const [episodes, setEpisodes] = useState(() => cached?.episodes ?? null)
  const [watched, setWatched] = useState(() => new Set(cached?.watchedList ?? []))
  const [loading, setLoading] = useState(() => cached === null)
  const [error, setError] = useState(null)
  const [busyEpisodes, setBusyEpisodes] = useState(new Set())
  const [isSeasonBusy, setIsSeasonBusy] = useState(false)

  useEffect(() => {
    let ignore = false

    async function load() {
      setError(null)
      try {
        const [{ data: watchedRows, error: watchedError }, details, seasonData] = await Promise.all([
          supabase
            .from('watched_episodes')
            .select('episode_number')
            .eq('tmdb_show_id', numericTmdbId)
            .eq('season_number', numericSeasonNumber),
          getShowDetails(numericTmdbId),
          getSeasonEpisodes(numericTmdbId, numericSeasonNumber),
        ])
        if (watchedError) throw watchedError
        if (ignore) return

        const nextShowName = details.name ?? ''
        const nextReleaseRule = releaseRuleForShow(numericTmdbId, details.networks)
        const watchedList = (watchedRows ?? []).map((row) =>
          episodeKey(numericSeasonNumber, row.episode_number),
        )

        setShowName(nextShowName)
        setReleaseRule(nextReleaseRule)
        setEpisodes(seasonData.episodes)
        setWatched(new Set(watchedList))
        writeDetailCache(cacheKey, {
          showName: nextShowName,
          releaseRule: nextReleaseRule,
          episodes: seasonData.episodes,
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
      releaseRule,
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

  async function toggleEpisode(episode) {
    const epKey = episodeKey(numericSeasonNumber, episode.episode_number)
    if (busyEpisodes.has(episode.episode_number)) return
    setBusyEpisodes((prev) => new Set(prev).add(episode.episode_number))

    const wasWatched = watched.has(epKey)

    try {
      if (wasWatched) {
        const { error: deleteError } = await supabase
          .from('watched_episodes')
          .delete()
          .eq('tmdb_show_id', numericTmdbId)
          .eq('season_number', numericSeasonNumber)
          .eq('episode_number', episode.episode_number)
        if (deleteError) throw deleteError
      } else {
        const { error: upsertError } = await supabase.from('watched_episodes').upsert(
          {
            tmdb_show_id: numericTmdbId,
            season_number: numericSeasonNumber,
            episode_number: episode.episode_number,
            episode_name: episode.name,
            runtime_minutes: episode.runtime,
            watched_at: new Date().toISOString(),
          },
          { onConflict: 'tmdb_show_id,season_number,episode_number' },
        )
        if (upsertError) throw upsertError
      }

      const nextWatched = new Set(watched)
      if (wasWatched) nextWatched.delete(epKey)
      else nextWatched.add(epKey)
      setWatched(nextWatched)
      syncWatchedCaches(nextWatched)
    } finally {
      setBusyEpisodes((prev) => {
        const next = new Set(prev)
        next.delete(episode.episode_number)
        return next
      })
    }
  }

  async function markSeasonWatched() {
    if (isSeasonBusy) return
    setIsSeasonBusy(true)

    // Only aired episodes can be marked watched — same rule the individual
    // per-episode toggle enforces (see hasAired() in lib/watchHelpers.js).
    const airedEpisodes = (episodes ?? []).filter((ep) => hasAired(ep, releaseRule))
    const now = new Date().toISOString()
    const rows = airedEpisodes.map((ep) => ({
      tmdb_show_id: numericTmdbId,
      season_number: numericSeasonNumber,
      episode_number: ep.episode_number,
      episode_name: ep.name,
      runtime_minutes: ep.runtime,
      watched_at: now,
    }))

    try {
      if (rows.length > 0) {
        const { error: upsertError } = await supabase
          .from('watched_episodes')
          .upsert(rows, { onConflict: 'tmdb_show_id,season_number,episode_number' })
        if (upsertError) throw upsertError
      }

      const nextWatched = new Set(watched)
      for (const ep of airedEpisodes) nextWatched.add(episodeKey(numericSeasonNumber, ep.episode_number))
      setWatched(nextWatched)
      syncWatchedCaches(nextWatched)
    } finally {
      setIsSeasonBusy(false)
    }
  }

  const hasUnwatchedAiredEpisodes = (episodes ?? []).some(
    (ep) => hasAired(ep, releaseRule) && !watched.has(episodeKey(numericSeasonNumber, ep.episode_number)),
  )

  return (
    <div className="p-4">
      <div className="flex items-center gap-2">
        <Link
          to={`/watching/${numericTmdbId}`}
          aria-label="Back to show"
          className="shrink-0 rounded-md p-1 text-lg text-(--color-text-muted)"
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

      {!loading && episodes && (
        <div className="mt-4 flex flex-col gap-2">
          {hasUnwatchedAiredEpisodes && (
            <button
              type="button"
              onClick={markSeasonWatched}
              disabled={isSeasonBusy}
              className="self-start rounded-md bg-(--color-accent-muted) px-3 py-1.5 text-xs font-medium text-(--color-accent) disabled:opacity-60"
            >
              {isSeasonBusy ? 'Marking…' : 'Mark season watched'}
            </button>
          )}

          {episodes.map((ep) => {
            const epKey = episodeKey(numericSeasonNumber, ep.episode_number)
            const isWatched = watched.has(epKey)
            const isBusy = busyEpisodes.has(ep.episode_number)
            const episodeHasAired = hasAired(ep, releaseRule)

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
                    {episodeHasAired
                      ? formatDate(ep.air_date, releaseRule)
                      : ep.air_date
                        ? `Airs ${formatDate(ep.air_date, releaseRule)}`
                        : 'No air date'}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => toggleEpisode(ep)}
                  disabled={isBusy || !episodeHasAired}
                  className={`shrink-0 rounded-md px-3 py-2 text-xs font-medium disabled:opacity-60 ${
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
