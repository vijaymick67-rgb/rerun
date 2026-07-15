import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const worker = readFileSync(new URL('../../../scripts/notifications/worker.js', import.meta.url), 'utf8')
const workflow = readFileSync(new URL('../../../.github/workflows/episode-notifications.yml', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../../../supabase/migrations/20260715080000_add_notification_deliveries.sql', import.meta.url), 'utf8')

describe('notification architecture', () => {
  it('uses Rerun persisted TMDB IDs and shared Watching enrichment without title search or shows.txt', () => {
    expect(worker).toContain("from('tracked_shows')")
    expect(worker).toContain('selectTrackedShowsForWatching')
    expect(worker).toContain('loadWatchingShowData')
    expect(worker).toContain('getShowReleaseMap')
    expect(worker).not.toContain('shows.txt')
    expect(worker).not.toContain('/search/tv')
  })

  it('is disabled by default, supports dry-run, and prevents overlapping schedules', () => {
    expect(workflow).toContain("cron: '*/15 * * * *'")
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('cancel-in-progress: false')
    expect(workflow).toContain('RERUN_NOTIFICATIONS_ENABLED')
    expect(workflow).toContain('RERUN_NOTIFICATIONS_DRY_RUN')
  })

  it('uses a service-only unique claim before durable successful delivery', () => {
    expect(migration).toContain('unique (tmdb_show_id, season_number, episode_number, notification_type)')
    expect(migration).toContain('on conflict (tmdb_show_id, season_number, episode_number, notification_type)')
    expect(migration).toContain('notification_deliveries.delivered_at is null')
    expect(migration).toContain("interval '30 minutes'")
    expect(migration).toContain('from public, anon, authenticated')
    expect(migration).toContain('to service_role')
  })
})
