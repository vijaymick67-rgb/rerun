// Pure TMDB response trimming, shared by the browser client (src/lib/tmdb.js,
// which wraps these in localStorage caching) and the server notification
// worker (api/notifications/_tmdbServer.js, which has no localStorage and
// calls TMDB directly). Kept in one place so the two runtimes can never
// silently normalize a show/season differently.

// Cache key bumped across versions so shows cached before a field was added
// here get re-trimmed from the underlying tmdbFetch response (already cached
// raw — TMDB's /tv/{id} always includes these fields — so this is not a new
// network call) instead of silently missing the field forever:
//   :v2 added `networks`
//   :v3 added `episode_run_time` (per-show runtime fallback used by Stats
//       when an individual episode's own runtime is null)
//   :v4 added `last_episode_to_air` for post-air archived-show eligibility
//   :v5 added compact genre names for Stats analytics. Networks and genres are
//       both retained as name arrays; no raw TMDB objects enter localStorage.
export function normalizeShowDetails(data) {
  return {
    id: data.id,
    name: data.name,
    overview: data.overview,
    poster_path: data.poster_path,
    first_air_date: data.first_air_date,
    status: data.status,
    number_of_seasons: data.number_of_seasons,
    number_of_episodes: data.number_of_episodes,
    episode_run_time: data.episode_run_time ?? [],
    next_episode_to_air: data.next_episode_to_air
      ? {
          air_date: data.next_episode_to_air.air_date,
          season_number: data.next_episode_to_air.season_number,
          episode_number: data.next_episode_to_air.episode_number,
          name: data.next_episode_to_air.name,
        }
      : null,
    last_episode_to_air: data.last_episode_to_air
      ? {
          air_date: data.last_episode_to_air.air_date,
          season_number: data.last_episode_to_air.season_number,
          episode_number: data.last_episode_to_air.episode_number,
          name: data.last_episode_to_air.name,
        }
      : null,
    networks: (data.networks ?? []).map((network) => network.name),
    genres: (data.genres ?? [])
      .map((genre) => genre?.name?.trim())
      .filter(Boolean),
    seasons: (data.seasons ?? []).map((season) => ({
      season_number: season.season_number,
      name: season.name,
      episode_count: season.episode_count,
      air_date: season.air_date,
      poster_path: season.poster_path,
    })),
  }
}

export function normalizeSeasonEpisodes(data) {
  return {
    season_number: data.season_number,
    name: data.name,
    episodes: (data.episodes ?? []).map((ep) => ({
      episode_number: ep.episode_number,
      name: ep.name,
      air_date: ep.air_date,
      runtime: ep.runtime,
    })),
  }
}
