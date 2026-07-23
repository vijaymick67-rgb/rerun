import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Wiring contract for how Browse consumes the Discover session cache. The cache's
// behaviour is covered behaviourally in discoverSession.test.js and
// browseDiscoverSession.test.jsx; this locks the small amount of glue in Browse
// that those mount-free suites can't observe: that the tracked_shows read is
// seeded from and gated by the snapshot, advances the freshness clock, and that
// the shared session is handed to BrowseDiscover.
const browse = readFileSync(new URL('./Browse.jsx', import.meta.url), 'utf8')

describe('Browse tracked-library session wiring', () => {
  it('seeds initial tracked state from the session snapshot so a return skips the skeleton', () => {
    expect(browse).toContain('const initialTracked = readTrackedContent()')
    expect(browse).toContain('useState(() => initialTracked?.ids ?? new Set())')
    expect(browse).toContain('useState(() => initialTracked?.shows ?? [])')
    // Ready is true whenever a snapshot exists — that is what suppresses the
    // not-ready skeleton on a quick return while preserving the cold-load path.
    expect(browse).toContain('useState(() => initialTracked != null)')
  })

  it('gates the tracked_shows Supabase read on the freshness clock and advances it on success', () => {
    expect(browse).toContain('if (isTrackedFetchFresh(Date.now())) return undefined')
    // The exact Supabase selection semantics are unchanged.
    expect(browse).toContain(".select('tmdb_id, name, poster_path, hidden_at')")
    expect(browse).toContain("{ stage: 'browse-tracked-shows', source: 'supabase' }")
    expect(browse).toContain('active.map((row) => row.tmdb_id)')
    // The clock only advances on a genuine authoritative read.
    expect(browse).toContain('markTrackedFetched(Date.now())')
  })

  it('mirrors live tracked content into the snapshot without touching the clock', () => {
    expect(browse).toContain('writeTrackedContent({')
    // The mirror is guarded by readiness and depends on the tracked collections,
    // never on markTrackedFetched — so a remount cannot keep the clock fresh.
    expect(browse).toContain('}, [trackedShows, trackedIds, trackedShowsReady])')
  })

  it('hands the shared Discover session to BrowseDiscover', () => {
    expect(browse).toContain('session={discoverSession}')
  })
})
