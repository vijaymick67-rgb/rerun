import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getShowDetails, getSeasonEpisodes, POSTER_BASE } from '../lib/tmdb'
import { episodeKey } from '../lib/watchHelpers'
import { showDetailCacheKey, readDetailCache, writeDetailCache, clearDetailCache } from '../lib/detailCache'
import { markTrackedShowFinished, restoreTrackedShow } from '../lib/finishedShows'
import { clearWatchingCache } from '../lib/watchingCache'
import ShowDetailSkeleton from '../components/ShowDetailSkeleton'
import ConfirmDialog from '../components/ConfirmDialog'

// tmdbId changes are handled by remounting (see the keyed wrapper below)
// rather than resetting state in an effect, so the cache-on-mount
// initializers below always read the correct show's cache.
function ShowDetailInner({ tmdbId }) {
  const numericTmdbId = Number(tmdbId)
  const cacheKey = showDetailCacheKey(numericTmdbId)

  const [cached] = useState(() => readDetailCache(cacheKey))
  const [show, setShow] = useState(() => cached?.show ?? null)
  const [seasons, setSeasons] = useState(() => cached?.seasons ?? [])
  const [episodesBySeason, setEpisodesBySeason] = useState(() => cached?.episodesBySeason ?? {})
  const [watched, setWatched] = useState(() => new Set(cached?.watchedList ?? []))
  const [loading, setLoading] = useState(() => cached === null)
  const [error, setError] = useState(null)
  const [confirmFinish, setConfirmFinish] = useState(false)
  const [savingFinished, setSavingFinished] = useState(false)

  useEffect(() => {
    let ignore = false

    async function load() {
      setError(null)
      try {
        const { data: trackedShow, error: showError } = await supabase
          .from('tracked_shows')
          .select('*')
          .eq('tmdb_id', numericTmdbId)
          .maybeSingle()
        if (showError) throw showError
        if (!trackedShow) {
          if (!ignore) {
            setShow(null)
            clearDetailCache(cacheKey)
          }
          return
        }

        const { data: watchedRows, error: watchedError } = await supabase
          .from('watched_episodes')
          .select('season_number, episode_number')
          .eq('tmdb_show_id', numericTmdbId)
        if (watchedError) throw watchedError

        const details = await getShowDetails(numericTmdbId)
        const seasonList = (details.seasons ?? [])
          .filter((season) => season.season_number > 0)
          .sort((a, b) => a.season_number - b.season_number)

        const episodesArrays = await Promise.all(
          seasonList.map((season) => getSeasonEpisodes(numericTmdbId, season.season_number)),
        )
        const bySeason = {}
        seasonList.forEach((season, i) => {
          bySeason[season.season_number] = episodesArrays[i].episodes
        })

        if (ignore) return

        const watchedList = (watchedRows ?? []).map((row) =>
          episodeKey(row.season_number, row.episode_number),
        )

        setShow(trackedShow)
        setSeasons(seasonList)
        setEpisodesBySeason(bySeason)
        setWatched(new Set(watchedList))
        writeDetailCache(cacheKey, {
          show: trackedShow,
          seasons: seasonList,
          episodesBySeason: bySeason,
          watchedList,
        })
      } catch {
        if (!ignore) setError('Failed to load this show. Try refreshing.')
      } finally {
        if (!ignore) setLoading(false)
      }
    }

    load()
    return () => {
      ignore = true
    }
  }, [numericTmdbId, cacheKey])

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

  async function setFinished(finished) {
    if (!show || savingFinished) return
    setSavingFinished(true)
    try {
      if (finished) {
        const finishedAt = await markTrackedShowFinished(supabase, numericTmdbId)
        const next = { ...show, finished_at: finishedAt }
        setShow(next)
        writeDetailCache(cacheKey, { show: next, seasons, episodesBySeason, watchedList: [...watched] })
      } else {
        await restoreTrackedShow(supabase, numericTmdbId)
        const next = { ...show, finished_at: null, hidden_at: null }
        setShow(next)
        writeDetailCache(cacheKey, { show: next, seasons, episodesBySeason, watchedList: [...watched] })
      }
      clearWatchingCache()
    } catch (err) {
      setError(err.message || 'Could not update this show.')
    } finally {
      setSavingFinished(false)
    }
  }

  return (
    <div className="p-4">
      <div className="flex items-center gap-2">
        <Link
          to="/watching"
          aria-label="Back to Watching"
          className="motion-press shrink-0 rounded-md p-1 text-lg text-(--color-text-muted)"
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
        <div className="motion-banner mt-4 flex items-center justify-between gap-3 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          <span>{error}</span>
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
          <div className="mt-4 flex gap-3">
            {show.poster_path ? (
              <img
                src={POSTER_BASE + show.poster_path}
                alt={show.name}
                className="h-32 w-24 shrink-0 rounded-md object-cover"
              />
            ) : (
              <div className="flex h-32 w-24 shrink-0 items-center justify-center rounded-md bg-(--color-surface-raised) text-xs text-(--color-text-muted)">
                No poster
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-sm text-(--color-text-muted)">
                {seasons.length} season{seasons.length === 1 ? '' : 's'}
              </p>

              {totalEpisodeCount > 0 && (
                <>
                  <p className="mt-1 text-sm text-(--color-text-muted)">
                    {totalWatchedCount}/{totalEpisodeCount} episodes watched
                  </p>
                  <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-(--color-border)">
                    <div
                      className="h-full rounded-full bg-(--color-accent)"
                      style={{ width: `${(totalWatchedCount / totalEpisodeCount) * 100}%` }}
                    />
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => (show.finished_at ? setFinished(false) : setConfirmFinish(true))}
              disabled={savingFinished}
              className="motion-press w-full rounded-md border border-(--color-border) py-2 text-sm font-medium text-(--color-text) disabled:opacity-60"
            >
              {savingFinished
                ? 'Saving…'
                : show.finished_at
                  ? 'Restore to Watching'
                  : 'Mark finished'}
            </button>

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

              return (
                <Link
                  key={season.season_number}
                  to={`/watching/${numericTmdbId}/season/${season.season_number}`}
                  className="flex items-center justify-between rounded-lg border border-(--color-border) bg-(--color-surface) px-3 py-3"
                >
                  <span className="text-sm font-medium text-(--color-text)">
                    Season {season.season_number}
                  </span>
                  <span className="flex items-center gap-2 text-xs text-(--color-text-muted)">
                    {watchedCount}/{episodes.length}
                    <span aria-hidden="true">›</span>
                  </span>
                </Link>
              )
            })}
          </div>

          <ConfirmDialog
            open={confirmFinish}
            title={`Mark ${show.name} finished?`}
            message="This removes the show from Watching but keeps all episode history and Stats data. You can restore it later from this screen."
            confirmLabel="Mark finished"
            cancelLabel="Cancel"
            onConfirm={() => {
              setConfirmFinish(false)
              setFinished(true)
            }}
            onCancel={() => setConfirmFinish(false)}
          />
        </>
      )}
    </div>
  )
}

export default function ShowDetail() {
  const { tmdbId } = useParams()
  return <ShowDetailInner key={tmdbId} tmdbId={tmdbId} />
}
