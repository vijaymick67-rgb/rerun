import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')

function walkJsFiles(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) walkJsFiles(full, files)
    else if (/\.(js|jsx)$/.test(entry)) files.push(full)
  }
  return files
}

// src/ is exactly what Vite bundles into the client — nothing under here
// should reference the server-only secrets that back push notifications.
// This can't catch every possible leak (dead code elimination, string
// concatenation), but it's a real regression guard, and the final build
// output is separately inspected by hand before merge (see docs/web-push.md).
describe('client bundle never references server-only push secrets', () => {
  const clientFiles = walkJsFiles(resolve(repoRoot, 'src')).filter((f) => !f.endsWith('.test.js') && !f.endsWith('.test.jsx'))

  it('src/ contains no reference to VAPID_PRIVATE_KEY, VAPID_SUBJECT, or SUPABASE_SERVICE_ROLE_KEY', () => {
    for (const file of clientFiles) {
      const content = readFileSync(file, 'utf8')
      expect(content, file).not.toMatch(/VAPID_PRIVATE_KEY/)
      expect(content, file).not.toMatch(/VAPID_SUBJECT/)
      expect(content, file).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/)
    }
  })

  it('only the public VAPID key (VITE_-prefixed) is read client-side', () => {
    const settingsSource = readFileSync(resolve(repoRoot, 'src/routes/Settings.jsx'), 'utf8')
    expect(settingsSource).toContain('VITE_VAPID_PUBLIC_KEY')
  })

  it('the private key and service-role key are only read server-side, in api/push/*.js', () => {
    const testHandlerSource = readFileSync(resolve(repoRoot, 'api/push/test.js'), 'utf8')
    const adminSource = readFileSync(resolve(repoRoot, 'api/push/_supabaseAdmin.js'), 'utf8')
    expect(testHandlerSource).toContain('VAPID_PRIVATE_KEY')
    expect(adminSource).toContain('SUPABASE_SERVICE_ROLE_KEY')
  })
})
