// Runtime, server-side franchise seed verification (Blocker 1).
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The previous model required a maintainer to hand-edit `verified: true` /
// `enabled: true` onto a seed in franchiseSeeds.js after running a script. In a
// normal deployment nobody does that, so every candidate ships disabled and the
// production Marvel/DC catalogue is permanently EMPTY. That is the bug.
//
// This module removes the manual source-flag workflow entirely. In the
// key-holding SERVER environment it verifies each candidate seed live, at
// runtime, using the protected TMDB key, and returns only the seeds that pass —
// with `verified/enabled` set IN MEMORY as a consequence of live evidence, never
// as a committed source edit. No `verified: true` ever needs to be written to a
// source file for the feature to work in production.
//
// A seed passes ONLY when verifySeed (franchiseSeeds.js) confirms:
//   * it is not a rejected broad parent-studio id;
//   * the live /company/{id} name matches the expected candidate name exactly;
//   * BOTH the movie and tv discover samples are narrow (franchise-scale, not a
//     studio slate).
//
// GUARANTEES
//   * Unverified seeds are NEVER returned, so they are never queried for
//     catalogue membership (preserves the core safety rule).
//   * One seed failing (network error, renamed company, gone broad) never
//     disables the others — each seed is verified independently and isolated.
//   * Successful verification EVIDENCE is cached for a long TTL so the expensive
//     live checks run at most once per TTL per warm server, not on every build.
//   * Verification failures produce honest, inspectable metadata (reason codes),
//     never a silent guess.
//   * The TMDB key is only ever used by the injected server fetchJson; it is
//     never returned, logged, or exposed to the client.

import { FRANCHISE_COMPANY_SEEDS, isRejectedBroadCompany, verifySeed } from './franchiseSeeds.js'

// Long TTL: a company's identity + franchise-scale narrowness change very rarely,
// so re-verifying more often than weekly is pure waste. The catalogue response is
// itself CDN-cached (24h), so in practice verification runs at most about once a
// day per cold server, and this cache collapses even that within a warm server.
export const SEED_VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
export const SEED_VERIFICATION_MAX_ENTRIES = 64

// Bounded, corruption-safe cache of SUCCESSFUL verification evidence, keyed by
// company id. Injected so it is testable; the module default is per-process. It
// is an optimisation only — losing it just means re-verifying live, never a wrong
// answer — so a plain in-process Map is appropriate here (unlike the announcement
// plan store, whose correctness depends on durability).
export function createSeedVerificationCache({ max = SEED_VERIFICATION_MAX_ENTRIES } = {}) {
  const map = new Map()
  return {
    read(companyId, now, ttlMs) {
      try {
        const entry = map.get(companyId)
        if (!entry || !Number.isFinite(entry.storedAt)) return null
        if (now - entry.storedAt > ttlMs) return null
        return entry.evidence
      } catch {
        return null
      }
    },
    write(companyId, evidence, now) {
      try {
        if (map.size >= max && !map.has(companyId)) map.delete(map.keys().next().value)
        map.set(companyId, { evidence, storedAt: now })
      } catch {
        // best effort — a cache write failure must never break verification
      }
    },
  }
}

const defaultCache = createSeedVerificationCache()

// Resolve which candidate seeds are live-verified in THIS environment.
//
// Returns { activeSeeds, evidence, summary }:
//   * activeSeeds — the verified subset, each cloned with verified/enabled true so
//     the existing enabledSeeds()/verifiedCompanyIdsFor() pipeline admits it. Only
//     these participate in discovery.
//   * evidence — one honest record per candidate (ok + reason + samples + whether
//     the result came from cache), for response metadata / logging.
//   * summary — compact counts for meta.
//
// Every candidate is verified INDEPENDENTLY; a thrown error or a failed seed is
// captured as that seed's evidence and does not affect any other seed.
export async function resolveVerifiedSeeds({
  seeds = FRANCHISE_COMPANY_SEEDS, fetchJson, cache = defaultCache,
  now = Date.now(), ttlMs = SEED_VERIFICATION_TTL_MS,
} = {}) {
  const list = Array.isArray(seeds) ? seeds : []
  const results = await Promise.all(list.map((seed) => verifyOne(seed, { fetchJson, cache, now, ttlMs })))

  const activeSeeds = []
  const evidence = []
  for (const { seed, record } of results) {
    evidence.push(record)
    if (record.ok) activeSeeds.push(Object.freeze({ ...seed, verified: true, enabled: true }))
  }
  // Deterministic ordering so the config key / metadata are stable.
  activeSeeds.sort((a, b) => a.companyId - b.companyId)
  evidence.sort((a, b) => (a.companyId ?? 0) - (b.companyId ?? 0))

  return {
    activeSeeds,
    evidence,
    summary: {
      candidates: list.length,
      verified: activeSeeds.length,
      fromCache: evidence.filter((e) => e.cached).length,
      failed: evidence.filter((e) => !e.ok).length,
    },
  }
}

async function verifyOne(seed, { fetchJson, cache, now, ttlMs }) {
  try {
    // Reject broad parent studios up front — never worth a live call, never cached.
    if (isRejectedBroadCompany(seed.companyId)) {
      return { seed, record: { companyId: seed.companyId, ok: false, reason: 'rejected_broad_company', cached: false } }
    }
    // Fast path: a fresh, previously-successful verification.
    const cached = cache.read(seed.companyId, now, ttlMs)
    if (cached && cached.ok) {
      return { seed, record: { ...cached, cached: true } }
    }
    const result = await verifySeed(seed, { fetchJson })
    // Cache SUCCESSES only, so a transient failure is retried next time rather
    // than pinned for a week.
    if (result.ok) cache.write(seed.companyId, result, now)
    return { seed, record: { ...result, cached: false } }
  } catch {
    // Isolation: this seed's failure is captured, the others are unaffected.
    return { seed, record: { companyId: seed?.companyId ?? null, ok: false, reason: 'verification_error', cached: false } }
  }
}
