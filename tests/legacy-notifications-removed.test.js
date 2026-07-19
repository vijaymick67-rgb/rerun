import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')

const REMOVED_PATHS = [
  '.github/workflows/episode-notifications.yml',
  'api/notification-cron.js',
  'tests/notification-cron.test.js',
  'src/lib/notifications',
  'scripts/notifications',
  'docs/episode-notifications.md',
  'supabase/migrations/20260715100000_schedule_notification_cron.sql',
]

describe('legacy ntfy notification system removal (PRs #52-#56)', () => {
  it('removed files and directories no longer exist', () => {
    for (const path of REMOVED_PATHS) {
      expect(existsSync(resolve(repoRoot, path)), path).toBe(false)
    }
  })

  it('package.json no longer defines the ntfy simulation script', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
    expect(pkg.scripts['notifications:simulate']).toBeUndefined()
  })

  it('vercel.json has no reference to the removed notification-cron endpoint', () => {
    const vercel = readFileSync(resolve(repoRoot, 'vercel.json'), 'utf8')
    expect(vercel).not.toMatch(/notification-cron/)
  })

  it('kept the unused notification_deliveries migration (left in place, not dropped)', () => {
    expect(
      existsSync(resolve(repoRoot, 'supabase/migrations/20260715080000_add_notification_deliveries.sql')),
    ).toBe(true)
  })

  it('kept shared release/timezone/Watching helpers used elsewhere by the app', () => {
    for (const path of [
      'src/lib/tvmaze.js',
      'src/lib/watchHelpers.js',
      'src/lib/finishedShows.js',
      'src/lib/watchingShows.js',
      'src/lib/watchedEpisodes.js',
      'src/lib/releasePlatforms.js',
    ]) {
      expect(existsSync(resolve(repoRoot, path)), path).toBe(true)
    }
  })
})
