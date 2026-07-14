import { episodeKey, hasAired } from './watchHelpers.js'

export function buildUnwatchedAiredRows({
  episodes,
  watched,
  tmdbShowId,
  seasonNumber,
  watchedAt,
}) {
  return (episodes ?? [])
    .filter(
      (episode) =>
        hasAired(episode) &&
        !watched.has(episodeKey(seasonNumber, episode.episode_number)),
    )
    .map((episode) => ({
      tmdb_show_id: tmdbShowId,
      season_number: seasonNumber,
      episode_number: episode.episode_number,
      episode_name: episode.name,
      runtime_minutes: episode.runtime,
      watched_at: watchedAt,
    }))
}

export async function toggleEpisodeMutation({
  supabase,
  tmdbShowId,
  seasonNumber,
  episode,
  getWatched,
  commitWatched,
}) {
  const epKey = episodeKey(seasonNumber, episode.episode_number)
  const wasWatched = getWatched().has(epKey)

  if (wasWatched) {
    const { error } = await supabase
      .from('watched_episodes')
      .delete()
      .eq('tmdb_show_id', tmdbShowId)
      .eq('season_number', seasonNumber)
      .eq('episode_number', episode.episode_number)
    if (error) throw error
  } else {
    const { error } = await supabase.from('watched_episodes').upsert(
      {
        tmdb_show_id: tmdbShowId,
        season_number: seasonNumber,
        episode_number: episode.episode_number,
        episode_name: episode.name,
        runtime_minutes: episode.runtime,
        watched_at: new Date().toISOString(),
      },
      { onConflict: 'tmdb_show_id,season_number,episode_number' },
    )
    if (error) throw error
  }

  // Read the latest ref-backed state after the write. This merges independent
  // concurrent successes instead of rebuilding from a stale render closure.
  const nextWatched = new Set(getWatched())
  if (wasWatched) nextWatched.delete(epKey)
  else nextWatched.add(epKey)
  commitWatched(nextWatched)
  return nextWatched
}

export async function markSeasonWatchedMutation({
  supabase,
  episodes,
  tmdbShowId,
  seasonNumber,
  getWatched,
  commitWatched,
}) {
  const watchedAt = new Date().toISOString()
  const rows = buildUnwatchedAiredRows({
    episodes,
    watched: getWatched(),
    tmdbShowId,
    seasonNumber,
    watchedAt,
  })

  if (rows.length === 0) return getWatched()

  const { error } = await supabase
    .from('watched_episodes')
    .upsert(rows, {
      onConflict: 'tmdb_show_id,season_number,episode_number',
      ignoreDuplicates: true,
    })
  if (error) throw error

  const nextWatched = new Set(getWatched())
  for (const row of rows) {
    nextWatched.add(episodeKey(row.season_number, row.episode_number))
  }
  commitWatched(nextWatched)
  return nextWatched
}
