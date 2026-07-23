import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const browseSource = readFileSync(new URL('./Browse.jsx', import.meta.url), 'utf8')

// The search-result card's poster/title/year block was already Loki Armour
// compliant (see docs/loki-armour-design-spec.md). Only the two action
// buttons still carried the legacy blue accent + plain grey outline — this
// suite locks in the gold-primary / neutral-secondary recipe already
// established by ConfirmDialog (.confirm-dialog-confirm / -cancel) without
// pinning incidental class ordering.
describe('Browse search-result card action styling', () => {
  function trackToggleButtonBlock() {
    const start = browseSource.indexOf('onClick={() => handleTrackToggle(show)}')
    const end = browseSource.indexOf('</button>', start)
    return browseSource.slice(start, end)
  }

  function logWatchedButtonBlock() {
    const start = browseSource.indexOf('onClick={() => handleLogWatched(show)}')
    const end = browseSource.indexOf('</button>', start)
    return browseSource.slice(start, end)
  }

  it('gives the untracked Add action the Loki gold-filled primary treatment', () => {
    const block = trackToggleButtonBlock()
    expect(block).toContain('bg-(--color-gold-accent-strong)')
    expect(block).toContain('text-(--color-canvas-deep)')
    expect(block).not.toContain('--color-accent)')
    expect(block).not.toContain('--color-bg)')
  })

  it('gives the Added state a restrained neutral secondary treatment', () => {
    const block = trackToggleButtonBlock()
    expect(block).toContain('bg-(--color-surface-interactive)')
    expect(block).toContain('text-(--color-text-secondary)')
  })

  it('styles "Log as watched" as a restrained Loki secondary action, not a plain grey outline', () => {
    const block = logWatchedButtonBlock()
    expect(block).toContain('border-(--color-border)')
    expect(block).toContain('text-(--color-text-secondary)')
    expect(block).not.toContain('text-(--color-text-muted)')
  })

  it('keeps both search-result actions at the 44px minimum touch target', () => {
    expect(trackToggleButtonBlock()).toContain('min-h-11')
    expect(logWatchedButtonBlock()).toContain('min-h-11')
  })

  it('keeps both actions on the shared motion-press touch/press-intent system', () => {
    expect(trackToggleButtonBlock()).toContain('motion-press')
    expect(logWatchedButtonBlock()).toContain('motion-press')
  })

  it('dims disabled/loading states without introducing a separate disabled style', () => {
    expect(trackToggleButtonBlock()).toContain('disabled:opacity-60')
    expect(logWatchedButtonBlock()).toContain('disabled:opacity-60')
  })

  it('preserves the track-toggle and log-watched behavior wiring untouched', () => {
    expect(browseSource).toContain('disabled={isAdding || isRemoving}')
    expect(browseSource).toContain('disabled={isLogged || isLogging}')
    expect(browseSource).toContain("{isRemoving ? 'Removing…' : isAdding ? 'Adding…' : isTracked ? 'Added' : 'Add'}")
    expect(browseSource).toContain("{isLogged ? 'Logged ✓' : isLogging ? 'Logging…' : 'Log as watched'}")
  })

  it('leaves the already-compliant poster/title/year presentation untouched', () => {
    expect(browseSource).toContain('className="poster-card"')
    expect(browseSource).toContain('className="type-show-title truncate text-(--color-text)"')
    expect(browseSource).toContain('className="type-metadata text-(--color-text-muted)"')
  })
})
