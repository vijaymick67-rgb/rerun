// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = source('./index.css')

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`))?.[0] ?? ''
}

describe('Loki Armour Phase 2 visual contracts', () => {
  it('keeps the polished route headings compact, dynamic, and accessible', () => {
    const watching = source('./routes/Watching.jsx')
    const showDetail = source('./routes/ShowDetail.jsx')
    const seasonDetail = source('./routes/SeasonDetail.jsx')

    expect(watching).toContain('aria-label={`${visibleShows.length} active shows`}')
    expect(watching).not.toMatch(/Your viewing ledger|Released episodes, upcoming returns/)
    expect(showDetail).toContain('<h2>Seasons ({seasons.length})</h2>')
    expect(showDetail).not.toMatch(/Episode ledger|\{seasons\.length\} total/)
    expect(seasonDetail).toContain('<h2>Episodes ({episodes.length})</h2>')
    expect(seasonDetail).toContain('<strong>{watchedReleasedCount}</strong> of {releasedEpisodes.length} watched')
    expect(seasonDetail).not.toMatch(/Season ledger|Released episodes|\{episodes\.length\} total/)
  })

  it('uses semantic roles for navigation, progress, completion, warning, and danger', () => {
    const nextUp = rule('.watching-status-copy--next')
    const caughtUp = rule('.watching-status-copy--complete')
    const futureEpisode = rule('.season-episode-row--future')
    const destructiveReveal = rule('.watching-remove-surface')
    const progress = rule('.progress-fill')

    expect(nextUp).toContain('var(--color-gold-accent)')
    expect(caughtUp).toContain('var(--color-completion)')
    expect(futureEpisode).toContain('var(--color-warning)')
    expect(destructiveReveal).toContain('var(--color-destructive-surface)')
    expect(progress).toContain('var(--color-progress)')
    expect(progress).not.toMatch(/selection|gold|accent/)
  })

  it('keeps the protected Watching quick-mark control geometry and neutral surface', () => {
    const statusButton = rule('.watching-status-button')
    expect(statusButton).toContain('width: 2.75rem')
    expect(statusButton).toContain('height: 2.75rem')
    expect(statusButton).toContain('border-radius: 0.875rem')
    expect(statusButton).toContain('linear-gradient(175deg, #171b25, #11151e)')

    for (const state of ['available', 'caughtUp', 'accepted', 'notReady']) {
      expect(rule(`.watching-status-button[data-status='${state}']`)).not.toContain('background:')
    }
  })

  it('preserves route ownership, destinations, and future-episode gating', () => {
    const app = source('./App.jsx')
    const row = source('./components/WatchingRow.jsx')
    const showDetail = source('./routes/ShowDetail.jsx')
    const seasonDetail = source('./routes/SeasonDetail.jsx')

    expect(app).toContain('<PersistentWatching hidden={!isWatchingRoute} />')
    expect(app).toContain('<Watching active={showing} refreshSignal={refreshToken} />')
    expect(row).toContain('to={`/watching/${show.tmdb_id}`}')
    expect(showDetail).toContain('to={`/watching/${numericTmdbId}/season/${season.season_number}`}')
    expect(seasonDetail).toContain('to={`/watching/${numericTmdbId}`}')
    expect(seasonDetail).toContain('disabled={!episodeHasAired}')
    expect(seasonDetail).toContain("if (!hasAired(episode)) return")
  })

  it('keeps visual leaf components isolated from product services', () => {
    for (const path of [
      './components/WatchingRowSkeleton.jsx',
      './components/WatchedCircle.jsx',
      './components/ShowDetailSkeleton.jsx',
      './components/SeasonDetailSkeleton.jsx',
    ]) {
      expect(source(path)).not.toMatch(/supabase|tmdb|tvmaze|notification|authcontext/i)
    }
  })
})
