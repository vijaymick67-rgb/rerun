// One-time cleanup: find (and optionally delete) watched_episodes rows for
// episodes that, per TMDB's real air_date and the network day-shift
// correction (src/lib/networkReleaseTiming.js), have not actually aired yet.
// These are almost certainly rows written before the hasAired() fixes in
// PRs #9 and #10 were live.
//
// Manual-only, forever — this must NOT be wired into CI. It used to run via
// a GitHub Action authenticated with the anon key
// (.github/workflows/cleanup-unaired-watched.yml, removed in the owner-only
// auth PR); once owner-only RLS is applied
// (20260720140000_owner_only_rls_tracked_watched.sql), the anon key can no
// longer read or write these tables at all, so that workflow would only
// ever see zero rows. Rather than hand a GitHub Actions secret the
// Supabase service-role key (which bypasses RLS entirely and would expand
// what a CI credential can do), this script now takes the service-role key
// directly and is meant to be run by hand, from a machine you control, with
// credentials from Vercel's project settings (see CLAUDE.md, "No local dev
// environment") — never stored in CI.
//
//   SUPABASE_SERVICE_ROLE_KEY=... VITE_SUPABASE_URL=... node scripts/cleanup-unaired-watched.js
//
// Dry run by default — only prints what it would delete. Pass --confirm to
// actually delete the rows it finds.
//
// Reads TMDB data from the deployed proxy (rerun-nine.vercel.app/api/tmdb),
// not TMDB directly, so no separate TMDB_API_KEY is needed to run this.

import { createClient } from '@supabase/supabase-js'
import { hasAired } from '../src/lib/watchHelpers.js'
import { dayShiftForNetworks } from '../src/lib/networkReleaseTiming.js'

const PROXY_BASE = 'https://rerun-nine.vercel.app/api/tmdb'
const CONFIRM = process.argv.includes('--confirm')

const supabaseUrl = process.env.VITE_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment before running this.')
  console.error('Run this by hand, from a machine you control — never from CI. See the comment at the top of this file.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function fetchJSON(path) {
  const res = await fetch(`${PROXY_BASE}${path}`)
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.json()
}

async function main() {
  const { data: watchedRows, error: watchedError } = await supabase
    .from('watched_episodes')
    .select('*')
  if (watchedError) throw watchedError

  const { data: trackedShows, error: showsError } = await supabase
    .from('tracked_shows')
    .select('tmdb_id, name')
  if (showsError) throw showsError
  const showNameById = new Map(trackedShows.map((show) => [show.tmdb_id, show.name]))

  const rowsByShow = new Map()
  for (const row of watchedRows ?? []) {
    if (!rowsByShow.has(row.tmdb_show_id)) rowsByShow.set(row.tmdb_show_id, [])
    rowsByShow.get(row.tmdb_show_id).push(row)
  }

  const badRows = []

  for (const [tmdbShowId, rows] of rowsByShow) {
    let networks = []
    try {
      const details = await fetchJSON(`/tv/${tmdbShowId}`)
      networks = (details.networks ?? []).map((network) => network.name)
    } catch (err) {
      console.warn(`Skipping tmdb_id ${tmdbShowId} — could not load show details: ${err.message}`)
      continue
    }
    const dayShift = dayShiftForNetworks(networks)

    const seasonEpisodeCache = new Map()
    for (const row of rows) {
      if (!seasonEpisodeCache.has(row.season_number)) {
        try {
          const seasonData = await fetchJSON(`/tv/${tmdbShowId}/season/${row.season_number}`)
          seasonEpisodeCache.set(row.season_number, seasonData.episodes ?? [])
        } catch (err) {
          console.warn(
            `Could not load season ${row.season_number} for tmdb_id ${tmdbShowId}: ${err.message}`,
          )
          seasonEpisodeCache.set(row.season_number, [])
        }
      }

      const episode = seasonEpisodeCache
        .get(row.season_number)
        .find((ep) => ep.episode_number === row.episode_number)

      if (!episode || !hasAired(episode, dayShift)) {
        badRows.push({
          id: row.id,
          show: showNameById.get(tmdbShowId) ?? tmdbShowId,
          season_number: row.season_number,
          episode_number: row.episode_number,
          air_date: episode?.air_date ?? '(episode not found on TMDB)',
          day_shift: dayShift,
        })
      }
    }
  }

  if (badRows.length === 0) {
    console.log('No watched_episodes rows found for genuinely-unaired episodes. Nothing to clean up.')
    return
  }

  console.log(`Found ${badRows.length} watched_episodes row(s) for episodes that have not actually aired:`)
  console.table(badRows)

  if (!CONFIRM) {
    console.log('\nDry run only — re-run with --confirm to delete these rows.')
    return
  }

  for (const row of badRows) {
    const { error: deleteError } = await supabase.from('watched_episodes').delete().eq('id', row.id)
    if (deleteError) {
      console.error(`Failed to delete row ${row.id}:`, deleteError.message)
    } else {
      console.log(`Deleted row ${row.id} (${row.show} S${row.season_number}E${row.episode_number})`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
