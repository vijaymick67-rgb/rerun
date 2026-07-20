import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')

function migration(name) {
  return readFileSync(resolve(repoRoot, 'supabase/migrations', name), 'utf8')
}

describe('20260720090000_add_collision_safe_reminder_claim.sql', () => {
  const sql = migration('20260720090000_add_collision_safe_reminder_claim.sql')

  it('defines claim_episode_reminder_with_airtime_collision with the expected signature', () => {
    expect(sql).toMatch(
      /create or replace function public\.claim_episode_reminder_with_airtime_collision\(\s*p_push_subscription_id bigint,\s*p_tmdb_show_id bigint,\s*p_episodes jsonb,.*\s*p_claim_token uuid,\s*p_claimed_at timestamptz\s*\)/,
    )
    expect(sql).toMatch(/returns table\(season_number integer, episode_number integer, combined boolean\)/)
  })

  it('serializes concurrent callers per episode with a transaction-scoped advisory lock, not an in-memory or process-global mechanism', () => {
    expect(sql).toMatch(/perform pg_advisory_xact_lock\(lock_key\)/)
    expect(sql).toMatch(/hashtextextended\(/)
  })

  it('only reserves the airtime identity alongside the reminder identity when both are genuinely free — never when either is already delivered or freshly claimed by someone else', () => {
    expect(sql).toMatch(/reminder_free := not exists/)
    expect(sql).toMatch(/airtime_free := not exists/)
    expect(sql).toMatch(/delivered_at is not null or claimed_at >= p_claimed_at - interval '10 minutes'/)
  })

  it('reuses the existing 10-minute claim lease window, matching claim_episode_notification_deliveries', () => {
    const leaseMatches = sql.match(/interval '10 minutes'/g) ?? []
    expect(leaseMatches.length).toBeGreaterThanOrEqual(2) // reminder check + airtime check
  })

  it('writes both identities under the same claim_token when combined, so one finalize call can complete both', () => {
    expect(sql).toMatch(/\(reminder_identity, [\s\S]*?'episode_reminder', p_claimed_at, p_claim_token\),\s*\(airtime_identity, [\s\S]*?'episode_airtime', p_claimed_at, p_claim_token\)/)
  })

  it('never touches complete_episode_notification_deliveries — finalize stays a claim-token-scoped, arbitrary-identity-list call', () => {
    expect(sql).not.toMatch(/create or replace function public\.complete_episode_notification_deliveries/)
    expect(sql).not.toMatch(/drop function/i)
  })

  it('restricts execution to service_role only, matching the existing claim/complete RPCs', () => {
    expect(sql).toMatch(
      /revoke all on function public\.claim_episode_reminder_with_airtime_collision\(bigint, bigint, jsonb, uuid, timestamptz\)\s*\n\s*from public, anon, authenticated;/,
    )
    expect(sql).toMatch(
      /grant execute on function public\.claim_episode_reminder_with_airtime_collision\(bigint, bigint, jsonb, uuid, timestamptz\)\s*\n\s*to service_role;/,
    )
  })

  it('documents the cross-invocation race it fixes', () => {
    expect(sql).toMatch(/overlap/i)
    expect(sql).toMatch(/split/i)
  })
})
