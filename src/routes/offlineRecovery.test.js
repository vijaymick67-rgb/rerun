import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('offline and network recovery contracts', () => {
  it('bounds Show Detail and Season Detail loads and exposes a retry without hiding cached content', () => {
    const show = read('./ShowDetail.jsx')
    const season = read('./SeasonDetail.jsx')

    for (const source of [show, season]) {
      expect(source).toContain("import { withTimeout } from '../lib/dataLoading'")
      expect(source).toContain('const [loadAttempt, setLoadAttempt]')
      expect(source).toContain('function retryLoad()')
      expect(source).toContain('setLoading(cached === null)')
      expect(source).toContain("Try again.")
    }
    expect(show).toContain("Couldn\\'t refresh this show.")
    expect(season).toContain("Couldn\\'t refresh this season.")
  })

  it('keeps supplementary TVmaze failure from replacing valid detail data', () => {
    expect(read('./ShowDetail.jsx')).toContain("}).catch(() => ({})),")
    expect(read('./SeasonDetail.jsx')).toContain("}).catch(() => ({})),")
  })

  it('bounds Browse search, ignores obsolete responses, and offers an explicit retry', () => {
    const browse = read('./Browse.jsx')
    expect(browse).toContain("{ stage: 'browse-search', source: 'tmdb' }")
    expect(browse).toContain('let ignore = false')
    expect(browse).toContain('if (!ignore) setResults(data)')
    expect(browse).toContain('setSearchAttempt((attempt) => attempt + 1)')
  })

  it('does not silently treat Browse mutations as successful', () => {
    const browse = read('./Browse.jsx')
    expect(browse).toContain("Could not update tracking. Try again.")
    expect(browse).toContain("Could not log this show. Try again.")
    expect(browse).toContain('logErrors[show.id]')
  })

  it('reports a failed Watching removal and bounds the mutation', () => {
    const watching = read('./Watching.jsx')
    expect(watching).toContain("{ stage: 'watching-remove-show', source: 'supabase' }")
    expect(watching).toContain("Couldn\\'t remove this show. Try again.")
    expect(watching).toContain('role="alert"')
  })
})
