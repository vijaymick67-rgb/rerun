#!/usr/bin/env node
// Live verification for the dynamic Marvel/DC franchise company SEEDS (Scope J).
//
// Franchise membership is discovered dynamically from a small set of narrow,
// franchise-specific TMDB production companies (src/lib/discover/franchiseSeeds.js).
// Every seed ships `verified: false, enabled: false` because the build sandbox has
// no TMDB key. Run this script in an environment that DOES have the key to:
//   1. resolve each candidate company id -> confirm its live name;
//   2. inspect a discover sample -> confirm it is NARROW (a franchise entity, not a
//      whole parent-studio slate);
// then flip `verified`/`enabled` in franchiseSeeds.js for the seeds that pass.
//
//   TMDB_API_KEY=... node scripts/verify-franchise-seeds.mjs
//
// It calls api.themoviedb.org directly with the server-side key (the same key the
// api/tmdb proxy uses); it never exposes the key and makes only read requests.
// Exit code is non-zero if any candidate fails, so it can gate a manual step.
// Nothing here runs in the app; it is a maintainer tool. A seed that cannot be
// verified stays DISABLED — we never fall back to a static title list.

import { FRANCHISE_COMPANY_SEEDS, verifySeed, MEDIA_TYPE } from '../src/lib/discover/franchiseSeeds.js'

const API_KEY = process.env.TMDB_API_KEY
if (!API_KEY) {
  console.error('TMDB_API_KEY is not set — cannot perform live seed verification. Seeds stay disabled.')
  process.exit(2)
}

const BASE = 'https://api.themoviedb.org/3'

// fetchJson matching the shape franchiseSeeds.verifySeed expects: (path, params).
async function fetchJson(path, params = {}) {
  const url = new URL(`${BASE}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  url.searchParams.set('api_key', API_KEY)
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) return null
  return res.json()
}

let failures = 0
for (const seed of FRANCHISE_COMPANY_SEEDS) {
  // Verify against BOTH movie and TV discover so a TV-only franchise entity is not
  // wrongly rejected for an empty movie sample.
  const movie = await verifySeed(seed, { fetchJson, sampleMediaType: MEDIA_TYPE.MOVIE })
  const tv = await verifySeed(seed, { fetchJson, sampleMediaType: MEDIA_TYPE.TV })
  const nameMatch = movie.nameMatch || tv.nameMatch
  const narrow = movie.narrow || tv.narrow
  const ok = Boolean(nameMatch && narrow)
  if (!ok) failures += 1
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${seed.franchise.toUpperCase().padEnd(6)} id=${String(seed.companyId).padEnd(8)} ` +
    `candidate="${seed.candidateName}" live="${movie.resolvedName ?? tv.resolvedName ?? '-'}" ` +
    `movieResults=${movie.totalResults ?? '-'} tvResults=${tv.totalResults ?? '-'} ` +
    `nameMatch=${nameMatch} narrow=${narrow}`,
  )
}

console.log(
  `\n${FRANCHISE_COMPANY_SEEDS.length - failures}/${FRANCHISE_COMPANY_SEEDS.length} seeds verifiable. ` +
  `${failures ? `${failures} FAILED — keep those disabled.` : 'All candidates resolved narrow — safe to enable.'}`,
)
process.exit(failures ? 1 : 0)
