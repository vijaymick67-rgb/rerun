import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The two tracked_shows mutation owners that write raw Supabase (bypassing the
// shared finishedShows helpers) must also invalidate the Discover session. The
// helper-based owners are covered behaviourally in
// discover/trackedMutationInvalidation.test.js; these raw-write sites are inside
// large components / internal functions that are impractical to mount here, so
// this locks the wiring that closes the cross-route staleness gap.
const watching = readFileSync(new URL('./Watching.jsx', import.meta.url), 'utf8')
const importer = readFileSync(new URL('../lib/importWatchHistory.js', import.meta.url), 'utf8')

describe('raw tracked_shows mutation owners invalidate the Discover session', () => {
  it('Watching removal invalidates after a successful delete', () => {
    expect(watching).toContain("import { invalidateTrackedSession } from '../lib/discover/discoverSession'")
    const deleteIdx = watching.indexOf('if (deleteError) throw deleteError')
    const invalidateIdx = watching.indexOf('invalidateTrackedSession()', deleteIdx)
    // Invalidation must come only after the delete is confirmed to have succeeded.
    expect(deleteIdx).toBeGreaterThan(-1)
    expect(invalidateIdx).toBeGreaterThan(deleteIdx)
  })

  it('the importer invalidates only when tracked shows were actually inserted', () => {
    expect(importer).toContain("import { invalidateTrackedSession } from './discover/discoverSession.js'")
    expect(importer).toContain('if (inserted > 0) invalidateTrackedSession()')
  })
})
