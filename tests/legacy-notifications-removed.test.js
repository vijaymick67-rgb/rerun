import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')

const REMOVED_PATHS = [
  '.github/workflows/episode-notifications.yml',
  'api/notification-cron.js',
  'tests/notification-cron.test.js',
  // The old ntfy-era files under src/lib/notifications/ — not the directory
  // itself, which Phase 2 (automatic Web Push episode notifications, PR
  // "Add automatic episode notifications") legitimately reuses for
  // src/lib/notifications/episodeEligibility.js, an unrelated, purely
  // pure/synchronous module with no ntfy/scheduling code in it.
  'src/lib/notifications/execute.js',
  'src/lib/notifications/ntfy.js',
  'src/lib/notifications/ntfy.test.js',
  'src/lib/notifications/plan.js',
  'src/lib/notifications/plan.test.js',
  'src/lib/notifications/reminder.test.js',
  'src/lib/notifications/structure.test.js',
  'src/lib/notifications/worker.test.js',
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

  it('added a forward migration that unschedules the old Supabase Cron jobs by name', () => {
    const path = resolve(repoRoot, 'supabase/migrations/20260719130000_unschedule_legacy_notification_cron.sql')
    expect(existsSync(path)).toBe(true)
    const sql = readFileSync(path, 'utf8')
    expect(sql).toContain('rerun-notification-worker-10pm-ist')
    expect(sql).toContain('rerun-notification-worker-1005pm-ist')
    expect(sql).toContain('rerun-notification-worker-1010pm-ist')
    expect(sql).toContain('cron.unschedule')
    // Deleting the file that scheduled these does not undo the applied
    // database state, so removing 20260715100000 alone isn't enough.
    expect(sql).toMatch(/idempotent|does not undo|safe/i)
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
