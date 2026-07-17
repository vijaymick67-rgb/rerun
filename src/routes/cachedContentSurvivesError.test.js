import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

// Watching and Stats both render cached content stale-while-revalidate: a
// failed refresh must not hide rows that were already on screen. This locks
// in that existing (unmodified) behavior so a future refactor can't
// regress it silently.
describe('cached content survives a failed refresh', () => {
  it('Watching keeps rendering visibleShows regardless of the error banner', () => {
    const watching = source('./Watching.jsx')
    expect(watching).toContain('{!loading && visibleShows.length > 0 && (')
    expect(watching).not.toContain('{!loading && !error && visibleShows.length > 0 && (')
  })

  it('Stats keeps rendering the shows grid regardless of the error banner', () => {
    const stats = source('./Stats.jsx')
    expect(stats).toContain('{!loading && hasData && (')
    expect(stats).not.toContain('{!loading && !error && hasData && (')
  })
})
