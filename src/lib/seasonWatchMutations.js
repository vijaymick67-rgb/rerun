import { episodeKey, hasAired } from './watchHelpers.js'

export function eligibleAiredEpisodes(episodes) {
  return (episodes ?? []).filter(hasAired)
}

export function buildAiredRows({ episodes, tmdbShowId, seasonNumber, watchedAt }) {
  return eligibleAiredEpisodes(episodes).map((episode) => ({
    tmdb_show_id: tmdbShowId,
    season_number: seasonNumber,
    episode_number: episode.episode_number,
    episode_name: episode.name,
    runtime_minutes: episode.runtime,
    watched_at: watchedAt,
  }))
}

export function createWatchMutationQueue() {
  return { tail: Promise.resolve(), version: 0 }
}

export function runOptimisticWatchMutation({
  queue,
  getWatched,
  commitWatched,
  keys,
  watched,
  persist,
}) {
  const previous = new Set(getWatched())
  const next = new Set(previous)
  for (const key of keys) {
    if (watched) next.add(key)
    else next.delete(key)
  }
  const version = ++queue.version
  commitWatched(next)

  const operation = queue.tail.then(() => persist())
  queue.tail = operation.catch(() => {})
  return operation.catch((error) => {
    if (queue.version === version) commitWatched(previous)
    throw error
  })
}

export function toggleEpisodeOptimistically({
  queue,
  supabase,
  tmdbShowId,
  seasonNumber,
  episode,
  getWatched,
  commitWatched,
}) {
  const key = episodeKey(seasonNumber, episode.episode_number)
  const shouldWatch = !getWatched().has(key)
  return runOptimisticWatchMutation({
    queue,
    getWatched,
    commitWatched,
    keys: [key],
    watched: shouldWatch,
    persist: async () => {
      if (shouldWatch) {
        const { error } = await supabase.from('watched_episodes').upsert({
          tmdb_show_id: tmdbShowId,
          season_number: seasonNumber,
          episode_number: episode.episode_number,
          episode_name: episode.name,
          runtime_minutes: episode.runtime,
          watched_at: new Date().toISOString(),
        }, { onConflict: 'tmdb_show_id,season_number,episode_number' })
        if (error) throw error
        return
      }
      const { error } = await supabase.from('watched_episodes').delete()
        .eq('tmdb_show_id', tmdbShowId)
        .eq('season_number', seasonNumber)
        .eq('episode_number', episode.episode_number)
      if (error) throw error
    },
  })
}

export function toggleSeasonOptimistically({
  queue,
  supabase,
  episodes,
  tmdbShowId,
  seasonNumber,
  getWatched,
  commitWatched,
}) {
  const eligible = eligibleAiredEpisodes(episodes)
  if (eligible.length === 0) return Promise.resolve(getWatched())
  const eligibleKeys = eligible.map((episode) => episodeKey(seasonNumber, episode.episode_number))
  const shouldWatch = !eligibleKeys.every((key) => getWatched().has(key))
  const keys = shouldWatch
    ? eligibleKeys
    : (episodes ?? []).map((episode) => episodeKey(seasonNumber, episode.episode_number))
  return runOptimisticWatchMutation({
    queue,
    getWatched,
    commitWatched,
    keys,
    watched: shouldWatch,
    persist: async () => {
      if (shouldWatch) {
        const rows = buildAiredRows({
          episodes, tmdbShowId, seasonNumber, watchedAt: new Date().toISOString(),
        })
        const { error } = await supabase.from('watched_episodes').upsert(rows, {
          onConflict: 'tmdb_show_id,season_number,episode_number',
        })
        if (error) throw error
        return
      }
      const { error } = await supabase.from('watched_episodes').delete()
        .eq('tmdb_show_id', tmdbShowId)
        .eq('season_number', seasonNumber)
      if (error) throw error
    },
  })
}
