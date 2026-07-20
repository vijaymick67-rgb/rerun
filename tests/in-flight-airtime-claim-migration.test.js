import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')

function migration(name) {
  return readFileSync(resolve(repoRoot, 'supabase/migrations', name), 'utf8')
}

describe('20260720120000_distinguish_in_flight_airtime_claim.sql', () => {
  const sql = migration('20260720120000_distinguish_in_flight_airtime_claim.sql')

  it('replaces claim_episode_notifications in place with the same signature', () => {
    expect(sql).toMatch(
      /create or replace function public\.claim_episode_notifications\(\s*p_push_subscription_id bigint,\s*p_tmdb_show_id bigint,\s*p_episodes jsonb,.*\s*p_claim_token uuid,\s*p_claimed_at timestamptz\s*\)/,
    )
    expect(sql).toMatch(/returns table\(season_number integer, episode_number integer, notification_type text\)/)
  })

  it('keeps the single shared advisory lock key — every claim type still serializes together', () => {
    const lockKeyAssignments = sql.match(/lock_key := hashtextextended\(/g) ?? []
    expect(lockKeyAssignments).toHaveLength(1)
    expect(sql).toMatch(/perform pg_advisory_xact_lock\(lock_key\)/)
  })

  it('classifies airtime into distinct delivered and in-flight states rather than one "not free" bucket', () => {
    expect(sql).toMatch(/airtime_delivered := exists \([\s\S]*?delivered_at is not null\s*\)/)
    expect(sql).toMatch(/airtime_in_flight := exists \([\s\S]*?delivered_at is null\s*and claimed_at >= p_claimed_at - interval '10 minutes'\s*\)/)
  })

  it('backs off entirely — claims nothing — when a both-types request meets an in-flight airtime claim', () => {
    expect(sql).toMatch(/if wants_reminder and airtime_in_flight then[\s\S]*?continue;/)
  })

  it('only (re)claims airtime when it is neither delivered nor in-flight (free or stale)', () => {
    expect(sql).toMatch(/attempt_airtime := not airtime_delivered and not airtime_in_flight;/)
  })

  it('preserves reminder-only claiming when airtime was already delivered on an earlier run', () => {
    // A both-types request whose airtime is delivered must not `continue`:
    // the in-flight back-off is guarded specifically on airtime_in_flight,
    // never on airtime_delivered.
    expect(sql).not.toMatch(/if wants_reminder and airtime_delivered then[\s\S]*?continue;/)
  })

  it('still verifies claim_token ownership after each upsert before reporting a win', () => {
    const ownershipChecks = sql.match(/select claim_token into owner_token from public\.notification_deliveries where identity = \w+;/g) ?? []
    expect(ownershipChecks).toHaveLength(2)
    const ownershipGuards = sql.match(/if owner_token = p_claim_token then/g) ?? []
    expect(ownershipGuards).toHaveLength(2)
  })

  it('keeps the 10-minute lease window for both the reminder and airtime freedom checks and the upserts', () => {
    const leaseMatches = sql.match(/interval '10 minutes'/g) ?? []
    expect(leaseMatches.length).toBeGreaterThanOrEqual(4) // reminder check + airtime delivered/in-flight + two upsert WHEREs
  })

  it('never drops or rewrites the finalize or superseded claim RPCs', () => {
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

  it('documents the transaction-scoped-lock / post-commit send window it closes', () => {
    expect(sql).toMatch(/transaction lock/i)
    expect(sql).toMatch(/in-flight/i)
  })
})
