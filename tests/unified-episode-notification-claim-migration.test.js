import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')

function migration(name) {
  return readFileSync(resolve(repoRoot, 'supabase/migrations', name), 'utf8')
}

describe('20260720110000_add_unified_episode_notification_claim.sql', () => {
  const sql = migration('20260720110000_add_unified_episode_notification_claim.sql')

  it('defines claim_episode_notifications with the expected signature', () => {
    expect(sql).toMatch(
      /create or replace function public\.claim_episode_notifications\(\s*p_push_subscription_id bigint,\s*p_tmdb_show_id bigint,\s*p_episodes jsonb,.*\s*p_claim_token uuid,\s*p_claimed_at timestamptz\s*\)/,
    )
    expect(sql).toMatch(/returns table\(season_number integer, episode_number integer, notification_type text\)/)
  })

  it('serializes every claim type — airtime-only, reminder-only, and combined — under the same advisory lock key', () => {
    expect(sql).toMatch(/perform pg_advisory_xact_lock\(lock_key\)/)
    expect(sql).toMatch(/hashtextextended\(/)
    // Only one lock_key expression in the whole function: every request
    // shape computes the identical key for a given episode, so no caller
    // can bypass another caller's lock by asking for a different type.
    const lockKeyAssignments = sql.match(/lock_key := hashtextextended\(/g) ?? []
    expect(lockKeyAssignments).toHaveLength(1)
  })

  it('determines wants_reminder/wants_airtime from the requested notification_types array', () => {
    expect(sql).toMatch(/wants_reminder := ep\.notification_types \? 'episode_reminder'/)
    expect(sql).toMatch(/wants_airtime := ep\.notification_types \? 'episode_airtime'/)
  })

  it('never reserves the reminder identity unless it is genuinely free, and drops the whole episode if not', () => {
    expect(sql).toMatch(/reminder_free := not exists/)
    expect(sql).toMatch(/if not reminder_free then[\s\S]*?continue;/)
    expect(sql).toMatch(/delivered_at is not null or claimed_at >= p_claimed_at - interval '10 minutes'/)
  })

  it('only attempts the airtime identity when it is independently free, regardless of whether it was requested alone or alongside a reminder', () => {
    expect(sql).toMatch(/attempt_airtime := not exists/)
  })

  it('reuses the existing 10-minute claim lease window', () => {
    const leaseMatches = sql.match(/interval '10 minutes'/g) ?? []
    expect(leaseMatches.length).toBeGreaterThanOrEqual(2) // reminder check + airtime check
  })

  it('never reports a win merely because an INSERT ran — reads the row back and checks claim_token ownership before returning it', () => {
    const ownershipChecks = sql.match(/select claim_token into owner_token from public\.notification_deliveries where identity = \w+;/g) ?? []
    expect(ownershipChecks).toHaveLength(2) // once for the reminder identity, once for the airtime identity
    const ownershipGuards = sql.match(/if owner_token = p_claim_token then/g) ?? []
    expect(ownershipGuards).toHaveLength(2)
  })

  it('never touches complete_episode_notification_deliveries, claim_episode_notification_deliveries, or claim_episode_reminder_with_airtime_collision', () => {
    expect(sql).not.toMatch(/create or replace function public\.complete_episode_notification_deliveries/)
    expect(sql).not.toMatch(/create or replace function public\.claim_episode_notification_deliveries/)
    expect(sql).not.toMatch(/create or replace function public\.claim_episode_reminder_with_airtime_collision/)
    expect(sql).not.toMatch(/drop function/i)
  })

  it('restricts execution to service_role only, matching the existing claim/complete RPCs', () => {
    expect(sql).toMatch(
      /revoke all on function public\.claim_episode_notifications\(bigint, bigint, jsonb, uuid, timestamptz\)\s*\n\s*from public, anon, authenticated;/,
    )
    expect(sql).toMatch(
      /grant execute on function public\.claim_episode_notifications\(bigint, bigint, jsonb, uuid, timestamptz\)\s*\n\s*to service_role;/,
    )
  })

  it('documents the cross-path race it fixes (a lock-free airtime claim racing a lock-protected collision claim)', () => {
    expect(sql).toMatch(/lock-free/i)
    expect(sql).toMatch(/advisory lock/i)
  })
})
