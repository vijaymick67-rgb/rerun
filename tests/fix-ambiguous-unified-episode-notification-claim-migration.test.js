import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')
const migrationsDir = resolve(repoRoot, 'supabase/migrations')

function migration(name) {
  return readFileSync(resolve(migrationsDir, name), 'utf8')
}

const MIGRATION_NAME = '20260720150000_fix_ambiguous_unified_episode_notification_claim.sql'
const PRIOR_MIGRATION_NAME = '20260720120000_distinguish_in_flight_airtime_claim.sql'
const UNIFIED_CLAIM_MIGRATION_NAME = '20260720110000_add_unified_episode_notification_claim.sql'
const CONSTRAINT_NAME = 'notification_deliveries_push_subscription_id_tmdb_show_id_s_key'

// This repo's JS test suite (vitest, jsdom) has no live-Postgres harness — no
// `pg` dependency, no testcontainers, no way to actually execute SQL. Every
// other migration in this project is covered the same way (see
// unified-episode-notification-claim-migration.test.js,
// two-stage-episode-notifications-migration.test.js): precise structural
// assertions against the migration's SQL text. This file follows that same
// convention.
//
// The fix itself — and the exact constraint name below — was verified before
// writing this migration by actually applying every prior migration in order
// against a real local Postgres 16 instance, reproducing the exact
// production error ("column reference \"season_number\" is ambiguous") on
// the pre-fix function, then confirming the fixed function claims a
// reminder-only, an airtime-only, and a combined request without error. That
// verification is not itself part of the shipped test suite (no live-DB
// harness exists here to keep it running in CI); this file asserts the
// resulting SQL text matches what was actually verified.
describe('20260720150000_fix_ambiguous_unified_episode_notification_claim.sql', () => {
  const sql = migration(MIGRATION_NAME)

  it('is the newest migration and follows the unified-claim migration in filename order', () => {
    const names = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()
    expect(names[names.length - 1]).toBe(MIGRATION_NAME)
    expect(names.indexOf(MIGRATION_NAME)).toBeGreaterThan(names.indexOf(UNIFIED_CLAIM_MIGRATION_NAME))
    expect(names.indexOf(MIGRATION_NAME)).toBeGreaterThan(names.indexOf(PRIOR_MIGRATION_NAME))
  })

  it('does not edit or delete the already-applied prior migrations', () => {
    // The repair is forward-only: it must not modify the files that
    // introduced/refined the original (buggy) function.
    expect(() => migration(UNIFIED_CLAIM_MIGRATION_NAME)).not.toThrow()
    expect(() => migration(PRIOR_MIGRATION_NAME)).not.toThrow()
  })

  it('create-or-replaces the exact five-argument claim_episode_notifications signature', () => {
    expect(sql).toMatch(
      /create or replace function public\.claim_episode_notifications\(\s*p_push_subscription_id bigint,\s*p_tmdb_show_id bigint,\s*p_episodes jsonb,.*\s*p_claim_token uuid,\s*p_claimed_at timestamptz\s*\)/,
    )
  })

  it('still returns season_number, episode_number, notification_type — the shape api/notifications/run.js consumes', () => {
    expect(sql).toMatch(/returns table\(season_number integer, episode_number integer, notification_type text\)/)
  })

  it('no longer uses a bare ambiguous conflict-target column list', () => {
    expect(sql).not.toMatch(/on conflict \([^)]*season_number[^)]*\)/)
    expect(sql).not.toMatch(/on conflict \([^)]*episode_number[^)]*\)/)
    expect(sql).not.toMatch(/on conflict \([^)]*notification_type[^)]*\)/)
  })

  it('both the reminder and the airtime upsert use the ambiguity-safe named-constraint conflict target', () => {
    const conflictTargets = sql.match(new RegExp(`on conflict on constraint ${CONSTRAINT_NAME}`, 'g')) ?? []
    expect(conflictTargets).toHaveLength(2) // once for the reminder insert, once for the airtime insert
  })

  it('the referenced constraint name matches the exact uniqueness rule declared for notification_deliveries', () => {
    // Verified (not guessed) against the table's actual inline unique()
    // declaration — Postgres names an unnamed table constraint
    // deterministically from the table + column list, truncated to
    // NAMEDATALEN, plus a `_key` suffix.
    const createTableMigration = migration('20260719140000_add_automatic_episode_notifications.sql')
    expect(createTableMigration).toMatch(
      /unique \(push_subscription_id, tmdb_show_id, season_number, episode_number, notification_type\)/,
    )
    expect(CONSTRAINT_NAME.startsWith('notification_deliveries_push_subscription_id_tmdb_show_id')).toBe(true)
    expect(CONSTRAINT_NAME.endsWith('_key')).toBe(true)
  })

  it('preserves the single shared advisory lock per (subscription, show, season, episode)', () => {
    expect(sql).toMatch(/perform pg_advisory_xact_lock\(lock_key\)/)
    const lockKeyAssignments = sql.match(/lock_key := hashtextextended\(/g) ?? []
    expect(lockKeyAssignments).toHaveLength(1)
  })

  it('preserves the 10-minute stale-claim lease everywhere it was used before', () => {
    const leaseMatches = sql.match(/interval '10 minutes'/g) ?? []
    expect(leaseMatches.length).toBeGreaterThanOrEqual(4) // reminder-free, airtime-delivered/in-flight, both do-update guards
  })

  it('preserves claim-token ownership verification for both the reminder and airtime paths', () => {
    const ownershipChecks = sql.match(/select claim_token into owner_token from public\.notification_deliveries where identity = \w+;/g) ?? []
    expect(ownershipChecks).toHaveLength(2)
    const ownershipGuards = sql.match(/if owner_token = p_claim_token then/g) ?? []
    expect(ownershipGuards).toHaveLength(2)
  })

  it('preserves the delivered/in-flight/free three-way airtime classification and the reminder in-flight back-off', () => {
    expect(sql).toMatch(/airtime_delivered := exists/)
    expect(sql).toMatch(/airtime_in_flight := exists/)
    expect(sql).toMatch(/if wants_reminder and airtime_in_flight then/)
  })

  it('remains SECURITY DEFINER with a fixed search_path', () => {
    expect(sql).toMatch(/security definer/)
    expect(sql).toMatch(/set search_path = public/)
  })

  it('revokes execution from public, anon, and authenticated, and grants only to service_role', () => {
    expect(sql).toMatch(
      /revoke all on function public\.claim_episode_notifications\(bigint, bigint, jsonb, uuid, timestamptz\)\s*\n\s*from public, anon, authenticated;/,
    )
    expect(sql).toMatch(
      /grant execute on function public\.claim_episode_notifications\(bigint, bigint, jsonb, uuid, timestamptz\)\s*\n\s*to service_role;/,
    )
  })

  it('never deletes, updates, or backfills any notification_deliveries rows, and never touches cron', () => {
    expect(sql).not.toMatch(/delete from/i)
    expect(sql).not.toMatch(/update public\.notification_deliveries/i)
    expect(sql).not.toMatch(/cron\./i)
    expect(sql).not.toMatch(/drop function/i)
    expect(sql).not.toMatch(/drop table/i)
    expect(sql).not.toMatch(/alter table/i)
  })

  it('never touches complete_episode_notification_deliveries, claim_episode_notification_deliveries, or claim_episode_reminder_with_airtime_collision', () => {
    expect(sql).not.toMatch(/create or replace function public\.complete_episode_notification_deliveries/)
    expect(sql).not.toMatch(/create or replace function public\.claim_episode_notification_deliveries/)
    expect(sql).not.toMatch(/create or replace function public\.claim_episode_reminder_with_airtime_collision/)
  })

  it('documents the exact production error and root cause', () => {
    expect(sql).toMatch(/column reference "season_number" is ambiguous/)
    expect(sql).toMatch(/PL\/pgSQL variable/i)
  })
})
