import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')

function migration(name) {
  return readFileSync(resolve(repoRoot, 'supabase/migrations', name), 'utf8')
}

describe('20260720080000_add_two_stage_episode_notifications.sql', () => {
  const sql = migration('20260720080000_add_two_stage_episode_notifications.sql')

  it('adds the airtime rollout watermark column to push_subscriptions', () => {
    expect(sql).toMatch(/add column if not exists airtime_notifications_enabled_at timestamptz null/)
  })

  it('backfills existing active subscriptions to a rollout instant, never before their own original activation watermark', () => {
    expect(sql).toMatch(/update public\.push_subscriptions/)
    expect(sql).toMatch(/greatest\(\s*automatic_notifications_enabled_at,\s*now\(\) - interval '30 minutes'\s*\)/)
    expect(sql).toMatch(/where automatic_notifications_enabled_at is not null\s*\n\s*and airtime_notifications_enabled_at is null/)
  })

  it('never sets the airtime watermark from a hard-coded application-level date — it is computed in SQL at migration-apply time', () => {
    expect(sql).not.toMatch(/2026-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('reclassifies only already-delivered legacy episode_available rows to episode_reminder', () => {
    expect(sql).toMatch(/update public\.notification_deliveries/)
    expect(sql).toMatch(/notification_type = 'episode_reminder'/)
    expect(sql).toMatch(/where notification_type = 'episode_available'\s*\n\s*and delivered_at is not null/)
  })

  it('rewrites the identity column consistently with the new notification_type, matching what the claim RPC builds', () => {
    expect(sql).toMatch(
      /identity = push_subscription_id \|\| ':' \|\| tmdb_show_id \|\| ':' \|\| season_number \|\| ':' \|\| episode_number \|\| ':episode_reminder'/,
    )
  })

  it('never synthesizes an episode_airtime row from legacy history', () => {
    expect(sql).not.toMatch(/set\s+notification_type = 'episode_airtime'/)
    expect(sql).not.toMatch(/:episode_airtime'/)
  })

  it('documents the rollout-safety rationale and the legacy-migration rationale', () => {
    expect(sql).toMatch(/backlog/i)
    expect(sql).toMatch(/legacy episode_available/i)
  })
})
