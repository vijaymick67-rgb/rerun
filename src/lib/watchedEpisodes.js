// Supabase returns at most 1,000 rows from a select by default. Watch history
// can grow beyond that, so readers must use this helper instead of a one-shot
// watched_episodes select.
export const WATCHED_EPISODES_PAGE_SIZE = 1000

export async function fetchWatchedEpisodes(supabase, columns, tmdbShowIds = null) {
  const rows = []
  let from = 0

  while (true) {
    let query = supabase.from('watched_episodes').select(columns)
    if (tmdbShowIds) query = query.in('tmdb_show_id', tmdbShowIds)

    const { data, error } = await query
      .order('tmdb_show_id', { ascending: true })
      .order('season_number', { ascending: true })
      .order('episode_number', { ascending: true })
      .range(from, from + WATCHED_EPISODES_PAGE_SIZE - 1)
    if (error) throw error

    const page = data ?? []
    rows.push(...page)
    if (page.length < WATCHED_EPISODES_PAGE_SIZE) return rows
    from += WATCHED_EPISODES_PAGE_SIZE
  }
}

// An exact read-back used immediately after the one-time bulk operation. This
// reports what the app's current Supabase credentials can actually see, not a
// count inferred from the upsert response.
export async function countWatchedEpisodes(supabase, tmdbShowIds) {
  let query = supabase
    .from('watched_episodes')
    .select('*', { count: 'exact', head: true })
  if (tmdbShowIds) query = query.in('tmdb_show_id', tmdbShowIds)

  const { count, error } = await query
  if (error) throw error
  return count ?? 0
}
