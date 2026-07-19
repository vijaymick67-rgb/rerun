import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')

function migration(name) {
  return readFileSync(resolve(repoRoot, 'supabase/migrations', name), 'utf8')
}

describe('20260719140000_add_automatic_episode_notifications.sql', () => {
  const sql = migration('20260719140000_add_automatic_episode_notifications.sql')

  it('adds the activation watermark column to push_subscriptions', () => {
    expect(sql).toMatch(/add column if not exists automatic_notifications_enabled_at timestamptz null/)
  })

  it('scopes notification_deliveries to a subscription with cascade delete', () => {
    expect(sql).toMatch(/push_subscription_id bigint not null references public\.push_subscriptions \(id\) on delete cascade/)
  })

  it('the composite unique constraint includes the subscription, so two installs never share a delivery row', () => {
    expect(sql).toMatch(
      /unique \(push_subscription_id, tmdb_show_id, season_number, episode_number, notification_type\)/,
    )
  })

  it('the claim function reclaim window is documented and matches the ~10-15 minute worker cadence', () => {
    expect(sql).toMatch(/claimed_at < p_claimed_at - interval '10 minutes'/)
    expect(sql).toMatch(/10-15 minute cron/)
  })

  it('the claim function is locked down to service_role only', () => {
    expect(sql).toMatch(/revoke all on function public\.claim_episode_notification_deliveries/)
    expect(sql).toMatch(/grant execute on function public\.claim_episode_notification_deliveries[\s\S]*to service_role/)
  })

  it('documents why the table is replaced outright rather than patched (no production data to migrate)', () => {
    expect(sql).toMatch(/never written to|no production data to migrate/)
  })
})

describe('20260719150000_schedule_episode_notification_worker.sql', () => {
  const sql = migration('20260719150000_schedule_episode_notification_worker.sql')

  it('schedules exactly one clearly named job', () => {
    expect(sql).toMatch(/cron\.schedule\(\s*'rerun-episode-notification-worker'/)
    expect(sql.match(/cron\.schedule\(/g)).toHaveLength(1)
  })

  it('runs on a 15-minute cadence', () => {
    expect(sql).toMatch(/'\*\/15 \* \* \* \*'/)
  })

  it('pulls the endpoint URL and secret from Vault rather than embedding them', () => {
    expect(sql).toMatch(/vault\.decrypted_secrets/)
    expect(sql).toMatch(/rerun_notification_worker_endpoint_url/)
    expect(sql).toMatch(/rerun_notification_worker_secret/)
    // No literal https:// URL or bearer-looking secret ever appears inline.
    expect(sql).not.toMatch(/https:\/\/(?!api\.themoviedb|api\.tvmaze)/)
  })

  it('documents that these are new Vault entries distinct from the removed Phase-1-era ones', () => {
    expect(sql).toMatch(/rerun_notification_endpoint_url \/ rerun_notification_cron_secret/)
  })
})
