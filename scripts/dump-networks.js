// One-time dump: list every tracked show with its TMDB network name(s), so the
// SHOW_RELEASE_OVERRIDES map in src/lib/networkReleaseTiming.js can be built
// from real data instead of guesswork. Networks are NOT stored in Supabase —
// they come from TMDB's /tv/{id} response at runtime — so this script joins the
// two: tracked_shows (for the id + name) and the TMDB proxy (for networks).
//
// This can't be run inside a sandboxed Claude Code session — it needs the real
// Supabase credentials, which only exist in Vercel's project settings (see
// CLAUDE.md, "No local dev environment"). Run it yourself wherever you have
// those values, e.g.:
//
//   VITE_SUPABASE_URL=... VITE_SUPABASE_ANON_KEY=... node scripts/dump-networks.js
//
// Reads TMDB data from the deployed proxy (rerun-nine.vercel.app/api/tmdb), not
// TMDB directly, so no separate TMDB_API_KEY is needed to run this.
//
// Output is one pipe-delimited line per show: `tmdb_id | name | networks`.
// Paste the whole block back into the chat and I'll bucket each show into the
// confirmed override tiers (Disney+ prestige live-action, FX-branded Hulu
// simulcasts, Peacock reality/linear) — leaving everything else on its network
// default and flagging anything ambiguous instead of guessing.

import { createClient } from '@supabase/supabase-js'

const PROXY_BASE = 'https://rerun-nine.vercel.app/api/tmdb'

const supabaseUrl = process.env.VITE_SUPABASE_URL
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the environment before running this.')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseAnonKey)

async function fetchJSON(path) {
  const res = await fetch(`${PROXY_BASE}${path}`)
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.json()
}

async function main() {
  const { data: trackedShows, error: showsError } = await supabase
    .from('tracked_shows')
    .select('tmdb_id, name, finished_at, hidden_at')
  if (showsError) throw showsError

  if (!trackedShows || trackedShows.length === 0) {
    console.log('No tracked shows found.')
    return
  }

  const sorted = [...trackedShows].sort((a, b) =>
    (a.name ?? '').localeCompare(b.name ?? ''),
  )

  const rows = []
  for (const show of sorted) {
    let networks = []
    let note = ''
    try {
      const details = await fetchJSON(`/tv/${show.tmdb_id}`)
      networks = (details.networks ?? []).map((network) => network.name)
    } catch (err) {
      note = ` (could not load TMDB details: ${err.message})`
    }
    // Flag archived/hidden shows so a network dump for something you're no
    // longer watching doesn't get mistaken for an active Watching-list entry.
    const flags = [
      show.finished_at ? 'finished' : null,
      show.hidden_at ? 'hidden' : null,
    ].filter(Boolean)
    const flagStr = flags.length ? ` [${flags.join(', ')}]` : ''
    rows.push(
      `${show.tmdb_id} | ${show.name}${flagStr} | ${networks.join(', ') || '(no networks)'}${note}`,
    )
  }

  console.log(`tmdb_id | name | networks   (${rows.length} tracked shows)`)
  console.log('-'.repeat(60))
  console.log(rows.join('\n'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
