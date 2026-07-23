#!/usr/bin/env node
// Live verification for the Marvel/DC trailer catalogue (Scope J).
//
// Membership in src/lib/discover/marvelDcCatalogue.js is an explicit allowlist of
// specific TMDB media ids. Those ids were curated from TMDB's public catalogue
// but are shipped `liveVerified: false` because the build sandbox has no TMDB
// key. Run this script in an environment that DOES have the key to confirm each
// id resolves to the expected title and media type, then flip the flags.
//
//   TMDB_API_KEY=... node scripts/verify-marvel-dc.mjs
//
// It calls api.themoviedb.org directly with the server-side key (the same key the
// api/tmdb proxy uses) — it never exposes the key and makes only read requests.
// Exit code is non-zero if any id fails to resolve, so it can gate a manual
// verification step. Nothing here runs in the app; it is a maintainer tool.

import { MARVEL_DC_CATALOGUE } from '../src/lib/discover/marvelDcCatalogue.js'

const API_KEY = process.env.TMDB_API_KEY
if (!API_KEY) {
  console.error('TMDB_API_KEY is not set — cannot perform live verification.')
  process.exit(2)
}

const BASE = 'https://api.themoviedb.org/3'

function titleOf(mediaType, body) {
  return mediaType === 'movie' ? (body.title ?? body.original_title) : (body.name ?? body.original_name)
}

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

async function verifyEntry(entry) {
  const url = new URL(`${BASE}/${entry.mediaType}/${entry.id}`)
  url.searchParams.set('api_key', API_KEY)
  try {
    const res = await fetch(url)
    if (!res.ok) return { ...entry, ok: false, reason: `HTTP ${res.status}` }
    const body = await res.json()
    const liveTitle = titleOf(entry.mediaType, body)
    // A loose containment check tolerates punctuation/edition differences while
    // still catching a wrong id (which would resolve to an unrelated title).
    const a = normalize(liveTitle)
    const b = normalize(entry.title)
    const matches = a && b && (a.includes(b) || b.includes(a))
    return { ...entry, ok: Boolean(matches), liveTitle, reason: matches ? 'match' : 'TITLE MISMATCH' }
  } catch (error) {
    return { ...entry, ok: false, reason: error.message }
  }
}

const results = []
for (const entry of MARVEL_DC_CATALOGUE) {
  // Sequential + gentle to stay well under TMDB rate limits.
  results.push(await verifyEntry(entry))
}

let failures = 0
for (const r of results) {
  const status = r.ok ? 'OK  ' : 'FAIL'
  if (!r.ok) failures += 1
  console.log(`${status} ${r.franchise.toUpperCase().padEnd(6)} ${r.mediaType.padEnd(5)} ${String(r.id).padEnd(8)} expected="${r.title}" live="${r.liveTitle ?? '-'}" (${r.reason})`)
}

console.log(`\n${results.length - failures}/${results.length} verified. ${failures ? `${failures} FAILED — do not flip liveVerified for those.` : 'All ids resolved — safe to set liveVerified: true.'}`)
process.exit(failures ? 1 : 0)
