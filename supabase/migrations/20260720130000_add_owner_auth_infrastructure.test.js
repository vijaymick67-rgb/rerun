import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Structural regression guard only — there is no live Postgres instance in
// this environment (see docs/AUTH_SETUP.md for the manual verification that
// must be run against a real Supabase project before/at each rollout step).
// This fails loudly if someone edits the file and accidentally weakens the
// owner-only design it documents.
const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260720130000_add_owner_auth_infrastructure.sql'),
  'utf8',
)

const code = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

describe('20260720130000_add_owner_auth_infrastructure.sql (structural checks, not a live-DB test)', () => {
  it('creates the private schema and a singleton owner_config table with RLS but no policies', () => {
    expect(sql).toMatch(/create schema if not exists private/)
    expect(sql).toMatch(/create table private\.owner_config/)
    expect(sql).toMatch(/owner_id uuid not null/)
    expect(sql).toMatch(/alter table private\.owner_config enable row level security/)
    expect(sql).not.toMatch(/create policy[^;]*on (private\.)?owner_config/)
  })

  it('defines private.is_owner() as a schema-qualified SECURITY DEFINER function with a fixed search_path', () => {
    expect(sql).toMatch(/create or replace function private\.is_owner\(\)/)
    expect(sql).toMatch(/security definer/)
    expect(sql).toMatch(/set search_path = private, pg_temp/)
    expect(sql).toMatch(/auth\.uid\(\) is not null/)
    expect(sql).toMatch(/from private\.owner_config/)
  })

  it('grants private.is_owner() to anon and authenticated (required for RLS evaluation, not for direct REST calls)', () => {
    expect(sql).toMatch(/grant usage on schema private to anon, authenticated/)
    expect(sql).toMatch(/grant execute on function private\.is_owner\(\) to anon, authenticated/)
  })

  it('defines public.current_user_is_owner() as a boolean-only wrapper that delegates to the private helper', () => {
    expect(sql).toMatch(/create or replace function public\.current_user_is_owner\(\)/)
    const wrapperMatch = code.match(
      /create or replace function public\.current_user_is_owner\(\)[\s\S]*?\$\$([\s\S]*?)\$\$/,
    )
    expect(wrapperMatch).not.toBeNull()
    expect(wrapperMatch[1]).toMatch(/select private\.is_owner\(\)/)
    // The wrapper's body must not itself query owner_config or expose owner_id.
    expect(wrapperMatch[1]).not.toMatch(/owner_config/)
    expect(wrapperMatch[1]).not.toMatch(/owner_id/)

    expect(sql).toMatch(/grant execute on function public\.current_user_is_owner\(\) to anon, authenticated/)
  })

  it('returns boolean from both functions (never the owner UUID/email)', () => {
    expect((code.match(/returns boolean/g) ?? []).length).toBe(2)
  })

  it('does not touch tracked_shows or watched_episodes at all', () => {
    // The design-note comments legitimately explain that this migration
    // deliberately avoids touching these tables — only the real SQL matters.
    expect(code).not.toMatch(/tracked_shows/)
    expect(code).not.toMatch(/watched_episodes/)
  })

  it('does not introduce a per-row user_id column', () => {
    expect(code).not.toMatch(/user_id/)
  })
})
