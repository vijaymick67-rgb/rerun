import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

const stats = read('./Stats.jsx')
const settings = read('./Settings.jsx')
const confirmDialog = read('../components/ConfirmDialog.jsx')
const reloadPrompt = read('../components/ReloadPrompt.jsx')
const notFound = read('../components/NotFound.jsx')
const css = read('../index.css')

describe('cinematic secondary surfaces', () => {
  it('keeps Stats hierarchy and action behavior while using semantic surfaces', () => {
    expect(stats).toContain('Insights')
    expect(stats).toContain('Total time watched')
    expect(stats).toContain('Daily insight')
    expect(stats).toContain('Show history')
    expect(stats).toContain('className="stats-summary content-surface')
    expect(stats).toContain('className="progress-track')
    expect(stats).toContain('to={`/watching/${show.tmdb_id}`}')
    expect(stats).toContain('role="dialog"')
    expect(stats).toContain('aria-modal="true"')
    expect(stats).toContain("if (event.key === 'Escape') onClose()")
    expect(stats).toContain('onClick={(event) => event.stopPropagation()}')
    expect(stats).toContain('onRestore')
    expect(stats).toContain('onRemove')
    expect(stats).not.toContain('bg-black/60')
    expect(stats).not.toContain('text-red-400')
  })

  it('keeps Settings controls and backup workflows while using grouped semantic roles', () => {
    expect(settings).toContain('className="settings-group surface-group')
    expect(settings).toContain('surface-interactive')
    expect(settings).toContain('type="file"')
    expect(settings).toContain('className="hidden"')
    expect(settings).toContain('<select')
    expect(settings).toContain('PREFERRED_HOUR_OPTIONS')
    expect(settings).toContain('status-banner--destructive')
    expect(settings).toContain('aria-live={live ? \'polite\' : undefined}')
    expect(settings).not.toContain('border-red-400')
    expect(settings).not.toContain('bg-red-400')
  })

  it('keeps system UI semantics and recovery actions intact', () => {
    expect(confirmDialog).toContain('role="alertdialog"')
    expect(confirmDialog).toContain('aria-modal="true"')
    expect(confirmDialog).toContain('onClick={onConfirm}')
    expect(confirmDialog).toContain("if (e.key === 'Escape') onCancel()")
    expect(reloadPrompt).toContain('role="status" aria-live="polite"')
    expect(reloadPrompt).toContain('onClick={onUpdate}')
    expect(reloadPrompt).toContain('onClick={onDismiss}')
    expect(notFound).toContain('to="/"')
    expect(css).toContain('background: var(--color-overlay);')
    expect(css).toContain('border-radius: var(--radius-overlay);')
    expect(css).toContain('box-shadow: var(--elevation-overlay);')
  })
})
