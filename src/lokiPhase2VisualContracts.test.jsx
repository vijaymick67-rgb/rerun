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

  it('keeps the protected Watching quick-mark control size and neutral surface (shape is now circular)', () => {
    const statusButton = rule('.watching-status-button')
    expect(statusButton).toContain('width: 2.75rem')
    expect(statusButton).toContain('height: 2.75rem')
    // Real-device polish: the visible enclosure changed from a rounded
    // square to a true circle — everything else about the control (size,
    // surface, states) stays exactly as protected below.
    expect(statusButton).toContain('border-radius: 9999px')
    expect(statusButton).toContain('linear-gradient(165deg, #171b18, #0e1310)')

    for (const state of ['available', 'caughtUp', 'accepted', 'notReady']) {
      expect(rule(`.watching-status-button[data-status='${state}']`)).not.toContain('background:')
    }
  })

  it('uses gold quick-mark semantics and a muted upcoming treatment', () => {
    const row = source('./components/WatchingRow.jsx')
    const upcoming = rule('.watching-upcoming-status')

    expect(css).toContain('--color-status-check: var(--color-gold-accent-strong)')
    expect(row).toContain('className="watching-upcoming-status type-caption mt-1"')
    expect(row).not.toContain('watching-countdown-pill')
    expect(upcoming).toContain('var(--color-forest-tonal-surface)')
    expect(upcoming).toContain('var(--color-text-secondary)')
    expect(upcoming).not.toContain('var(--color-warning)')
  })

  it('keeps the Show Detail hero free of a decorative corner pseudo-element', () => {
    expect(css).not.toContain('.show-detail-hero::before')
  })

  it('presents only muted show-level synopsis copy beside the Show Detail poster', () => {
    const showDetail = source('./routes/ShowDetail.jsx')
    const synopsis = rule('.show-detail-hero__synopsis')

    expect(showDetail).toContain('details.overview')
    expect(showDetail).toContain('className="show-detail-hero__synopsis"')
    expect(showDetail).not.toMatch(/Viewing progress|show-detail-hero__seasons|show-detail-hero__progress-copy/)
    expect(synopsis).toContain('var(--color-gold-accent)')
    expect(synopsis).not.toContain('var(--color-gold-accent-strong)')
    expect(synopsis).not.toMatch(/glow|text-shadow/)
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
