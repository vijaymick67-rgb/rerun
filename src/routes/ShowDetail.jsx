import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getShowDetails, getSeasonEpisodes, POSTER_BASE } from '../lib/tmdb'
import { episodeKey } from '../lib/watchHelpers'

export default function ShowDetail() {
  const { tmdbId } = useParams()
  const numericTmdbId = Number(tmdbId)

  const [show, setShow] = useState(null)
  const [seasons, setSeasons] = useState([])
  const [episodesBySeason, setEpisodesBySeason] = useState({})
  const [watched, setWatched] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let ignore = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const { data: trackedShow, error: showError } = await supabase
          .from('tracked_shows')
          .select('*')
          .eq('tmdb_id', numericTmdbId)
          .maybeSingle()
        if (showError) throw showError
        if (!trackedShow) {
          if (!ignore) setShow(null)
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

        const bySeason = {}
        for (const season of seasonList) {
          const seasonData = await getSeasonEpisodes(numericTmdbId, season.season_number)
          bySeason[season.season_number] = seasonData.episodes
        }

        if (ignore) return
        setShow(trackedShow)
        setSeasons(seasonList)
        setEpisodesBySeason(bySeason)
        setWatched(
          new Set((watchedRows ?? []).map((row) => episodeKey(row.season_number, row.episode_number))),
        )
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
  }, [numericTmdbId])

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

  return (
    <div className="p-4">
      <div className="flex items-center gap-2">
        <Link
          to="/watching"
          aria-label="Back to Watching"
          className="shrink-0 rounded-md p-1 text-lg text-(--color-text-muted)"
        >
          ‹
        </Link>
        <h1 className="min-w-0 truncate text-xl font-semibold text-(--color-text)">
          {show ? show.name : 'Show'}
        </h1>
      </div>

      {loading && <p className="mt-4 text-sm text-(--color-text-muted)">Loading…</p>}

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      {!loading && !error && show === null && (
        <p className="mt-8 text-center text-(--color-text-muted)">
          Show not found.{' '}
          <Link to="/watching" className="text-(--color-accent)">
            Back to Watching
          </Link>
        </p>
      )}

      {!loading && !error && show && (
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
        </>
      )}
    </div>
  )
}
