import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const seasonDetail = readFileSync(new URL('./SeasonDetail.jsx', import.meta.url), 'utf8')
const showDetail = readFileSync(new URL('./ShowDetail.jsx', import.meta.url), 'utf8')

describe('detail watch control structure', () => {
  it('removes the legacy text actions', () => {
    expect(seasonDetail).not.toContain('Mark season watched')
    expect(showDetail).not.toContain('Mark finished')
    expect(showDetail).not.toContain('Restore to Watching')
    expect(showDetail).not.toContain('ConfirmDialog')
  })

  it('makes the season navigation and circular toggle sibling interactions', () => {
    const row = showDetail.slice(showDetail.indexOf('<div\n                  key={season.season_number}'))
    expect(row.indexOf('<Link')).toBeGreaterThan(-1)
    expect(row.indexOf('</Link>')).toBeLessThan(row.indexOf('<WatchedCircle'))
  })

  it('leaves episode row bodies inert and disables unaired controls', () => {
    expect(seasonDetail).toContain('disabled={!episodeHasAired}')
    expect(seasonDetail).not.toContain('active:translate-y-px')
    expect(seasonDetail).not.toMatch(/key=\{ep\.episode_number\}[\s\S]{0,180}onClick=/)
  })
})
