import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260720140000_owner_only_rls_tracked_watched.sql'),
  'utf8',
)

const code = sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

const TABLES = ['tracked_shows', 'watched_episodes']
const OPERATIONS = ['select', 'insert', 'update', 'delete']

describe('20260720140000_owner_only_rls_tracked_watched.sql (structural checks, not a live-DB test)', () => {
  it('drops existing policies by querying pg_policies rather than guessing hardcoded names', () => {
    expect(sql).toMatch(/select policyname from pg_policies/)
    expect(sql).toMatch(/where schemaname = 'public' and tablename = 'tracked_shows'/)
    expect(sql).toMatch(/where schemaname = 'public' and tablename = 'watched_episodes'/)
    expect(sql).toMatch(/drop policy %I on public\.tracked_shows/)
    expect(sql).toMatch(/drop policy %I on public\.watched_episodes/)
  })

  it('creates explicit operation-specific policies scoped to authenticated for every table/operation pair', () => {
    for (const table of TABLES) {
      for (const op of OPERATIONS) {
        const pattern = new RegExp(
          `create policy "Owner ${op} - ${table}" on public\\.${table}\\s+for ${op} to authenticated`,
        )
        expect(sql, `expected a "${op}" policy for ${table}`).toMatch(pattern)
      }
    }
  })

  it('gates every policy on private.is_owner(), with both USING and WITH CHECK on update', () => {
    expect((code.match(/private\.is_owner\(\)/g) ?? []).length).toBeGreaterThanOrEqual(10)

    for (const table of TABLES) {
      const updatePattern = new RegExp(
        `create policy "Owner update - ${table}" on public\\.${table}\\s+for update to authenticated using \\(private\\.is_owner\\(\\)\\) with check \\(private\\.is_owner\\(\\)\\)`,
      )
      expect(sql, `expected using+with check on the ${table} update policy`).toMatch(updatePattern)

      const insertPattern = new RegExp(
        `create policy "Owner insert - ${table}" on public\\.${table}\\s+for insert to authenticated with check \\(private\\.is_owner\\(\\)\\)`,
      )
      expect(sql, `expected with check on the ${table} insert policy`).toMatch(insertPattern)
    }
  })

  it('never uses a bare permissive `using (true)` policy', () => {
    expect(code).not.toMatch(/using \(true\)/)
  })

  it('never grants the anon role directly on these tables', () => {
    expect(code).not.toMatch(/to anon/)
    expect(code).not.toMatch(/,\s*anon\b/)
  })

  it('does not introduce a per-row user_id column', () => {
    expect(code).not.toMatch(/user_id/)
  })

  it('does not touch push_subscriptions, notification_deliveries, or any notification RPC', () => {
    // The design-note comments legitimately explain that these are
    // untouched — only the real SQL matters.
    expect(code).not.toMatch(/push_subscriptions/)
    expect(code).not.toMatch(/notification_deliveries/)
    expect(code).not.toMatch(/claim_episode/)
  })
})
