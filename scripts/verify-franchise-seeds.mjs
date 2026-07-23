#!/usr/bin/env node
// OPTIONAL diagnostic for the dynamic Marvel/DC franchise company SEEDS (Scope J).
//
// Verification is now AUTOMATIC at runtime: api/discover/franchise-catalogue.js
// verifies each candidate seed live on the server (franchiseSeedVerifier.js) using
// the protected TMDB key, and only verified seeds participate in discovery. NO
// manual `verified: true` source edit is required for a normal deployment.
//
// This script simply lets a maintainer PREVIEW that same verification from the
// command line — e.g. to sanity-check a candidate id after TMDB reorganises a
// company. It changes nothing; it just prints each candidate's live evidence.
//
//   TMDB_API_KEY=... node scripts/verify-franchise-seeds.mjs
//
// It calls api.themoviedb.org directly with the server-side key (the same key the
// api/tmdb proxy uses); it never exposes the key and makes only read requests.
// Exit code is non-zero if any candidate fails, so it can gate a manual check.

import { FRANCHISE_COMPANY_SEEDS } from '../src/lib/discover/franchiseSeeds.js'
import { resolveVerifiedSeeds } from '../src/lib/discover/franchiseSeedVerifier.js'

const API_KEY = process.env.TMDB_API_KEY
if (!API_KEY) {
  console.error('TMDB_API_KEY is not set — cannot perform live seed verification.')
  process.exit(2)
}

const BASE = 'https://api.themoviedb.org/3'

// fetchJson matching the shape verifySeed expects: (path, params) -> JSON | null.
async function fetchJson(path, params = {}) {
  const url = new URL(`${BASE}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  url.searchParams.set('api_key', API_KEY)
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) return null
  return res.json()
}

// Run the exact runtime verification the endpoint uses.
const { evidence, summary } = await resolveVerifiedSeeds({ fetchJson })
const byId = new Map(evidence.map((e) => [e.companyId, e]))

let failures = 0
for (const seed of FRANCHISE_COMPANY_SEEDS) {
  const e = byId.get(seed.companyId) ?? { ok: false, reason: 'no_evidence' }
  if (!e.ok) failures += 1
  console.log(
    `${e.ok ? 'OK  ' : 'FAIL'} ${seed.franchise.toUpperCase().padEnd(6)} id=${String(seed.companyId).padEnd(8)} ` +
    `candidate="${seed.candidateName}" live="${e.resolvedName ?? '-'}" ` +
    `movieResults=${e.movieResults ?? '-'} tvResults=${e.tvResults ?? '-'} ` +
    `narrow=${e.narrow ?? '-'} reason=${e.reason}`,
  )
}

console.log(
  `\n${summary.verified}/${summary.candidates} seeds verify live. ` +
  `${failures ? `${failures} did NOT — those stay out of the catalogue automatically.` : 'All candidates resolved narrow.'}`,
)
process.exit(failures ? 1 : 0)
