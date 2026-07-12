import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { getShowDetails, getSeasonEpisodes, getLastPruneCount, CACHE_SCHEMA_VERSION } from '../lib/tmdb'
import { episodeKey, hasAired, formatDate } from '../lib/watchHelpers'
import { dayShiftForNetworks } from '../lib/networkReleaseTiming'

// TEMPORARY: on-screen diagnostic banner so the IST air-date fix can be
// verified live from mobile Safari (no dev tools needed). Remove once the
// Sugar S2E4 → "Jul 10" fix is confirmed on production.
const SHOW_DEBUG = true

export default function SeasonDetail() {
  const { tmdbId, seasonNumber } = useParams()
  const numericTmdbId = Number(tmdbId)
  const numericSeasonNumber = Number(seasonNumber)

  const [showName, setShowName] = useState('')
  const [networks, setNetworks] = useState([])
  const [dayShift, setDayShift] = useState(0)
  const [episodes, setEpisodes] = useState(null)
  const [watched, setWatched] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyEpisodes, setBusyEpisodes] = useState(new Set())
  const [isSeasonBusy, setIsSeasonBusy] = useState(false)

  useEffect(() => {
    let ignore = false

    async function load() {
      setLoading(true)
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

        setShowName(details.name ?? '')
        setNetworks(details.networks ?? [])
        setDayShift(dayShiftForNetworks(details.networks))
        setEpisodes(seasonData.episodes)
        setWatched(
          new Set((watchedRows ?? []).map((row) => episodeKey(numericSeasonNumber, row.episode_number))),
        )
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
  }, [numericTmdbId, numericSeasonNumber])

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

      setWatched((prev) => {
        const next = new Set(prev)
        if (wasWatched) next.delete(epKey)
        else next.add(epKey)
        return next
      })
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
    const airedEpisodes = (episodes ?? []).filter((ep) => hasAired(ep, dayShift))
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

      setWatched((prev) => {
        const next = new Set(prev)
        for (const ep of airedEpisodes) next.add(episodeKey(numericSeasonNumber, ep.episode_number))
        return next
      })
    } finally {
      setIsSeasonBusy(false)
    }
  }

  const hasUnwatchedAiredEpisodes = (episodes ?? []).some(
    (ep) => hasAired(ep, dayShift) && !watched.has(episodeKey(numericSeasonNumber, ep.episode_number)),
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

      {SHOW_DEBUG && !loading && !error && (
        <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 font-mono text-[10px] leading-snug text-amber-300">
          <div>debug · cache v{CACHE_SCHEMA_VERSION} · pruned {getLastPruneCount()} stale entries on load</div>
          <div>networks: {JSON.stringify(networks)}</div>
          <div>dayShift: {dayShift}</div>
        </div>
      )}

      {loading && <p className="mt-4 text-sm text-(--color-text-muted)">Loading…</p>}

      {error && <p className="mt-4 text-sm text-red-400">{error}</p>}

      {!loading && !error && episodes && (
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
            const episodeHasAired = hasAired(ep, dayShift)

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
                      ? formatDate(ep.air_date, dayShift)
                      : ep.air_date
                        ? `Airs ${formatDate(ep.air_date, dayShift)}`
                        : 'No air date'}
                    {SHOW_DEBUG && ep.air_date && (
                      <span className="ml-1 font-mono text-amber-400/70">
                        · raw {ep.air_date}
                      </span>
                    )}
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
