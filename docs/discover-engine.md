# Discover engine — Announcements & Trailers (Phase 1)

> Precision-first data engine that replaces the old generic-news model on the
> Discover page with two curated product feeds: **Announcements** and
> **Trailers**. This document covers the data engine only. The Discover UI
> replacement is deferred to Phase 2 — this PR introduces the engine alongside a
> compatibility boundary and does not restyle Discover or remove the legacy
> `BrowseNews` UI.

**Design philosophy: the system is precision-first. Ambiguous candidates are
intentionally omitted rather than guessed.** A missed real event is a smaller
harm than a wrong one shown as fact.

## Module map (`src/lib/discover/`)

| Module | Responsibility |
| --- | --- |
| `textNormalize.js` | Safe Unicode/case/punctuation normalization + bounded whole-word phrase matching. |
| `identities.js` | Normalized tracked-show identity registry + ambiguity classification. |
| `sourceTrust.js` | Tier 1/2/3 source trust model. |
| `eventPatterns.js` | Deterministic accept/reject vocabulary for the four event types. |
| `announcementClassifier.js` | Staged, auditable classifier (entity resolution → event → negation → extraction → freshness → confidence). |
| `announcementNormalizer.js` | Accepted event → stable public model + generated copy + event key. |
| `announcementDedup.js` | Event clustering + documented supersession rule. |
| `announcementStore.js` | Versioned announcements cache (namespace `rerun_discover_announcements:v1`). |
| `trailerFilter.js` | TMDB video accept/reject rules (site/type/name). |
| `trailerRank.js` | Trailer model, dedup, deterministic ranking, per-media selection. |
| `trailerStore.js` | Versioned trailers cache + bootstrap window + seen-state (`rerun_discover_trailers:v1`). |
| `marvelDcCatalogue.js` | Verified-config layer of Marvel/DC company ids + attribution-only membership. |
| `tmdbVideos.js` | TMDB video/discover fetching via the existing keyed proxy, cache + bounded concurrency + failure isolation. |
| `discoverClient.js` | Orchestration + error-isolated feed state (the Phase 2 seam). |

## Tracked-show coverage

Both feeds cover **every tracked show, in any tracked status** — watching,
watchlist, upcoming, paused, finished, and hidden. The engine never filters by
`hidden_at` / `finished_at`; the caller passes the full tracked set and the
identity registry treats them uniformly. (The Phase 2 wiring will read all
tracked rows; this PR's engine is status-agnostic by construction — see the
integration tests.)

## Announcement acceptance pipeline

Exactly four event types are allowed: `renewal`, `season_date`, `cancellation`,
`cast_addition`. Everything else is rejected. Stages (`classifyAnnouncement`):

1. **Normalize** the article (headline + description + source).
2. **Reject disallowed categories** (reviews, recaps, interviews, rankings,
   trailers/teasers, BTS, set photos, anniversaries, retrospectives,
   renewal/cancellation "chances", listicle shapes, …) before any expensive work.
3. **Resolve tracked-show identity** with bounded whole-word matching and an
   ambiguity gate (below). Entity resolution happens *before* event detection —
   a keyword like "renewed" never makes an article an announcement on its own.
4. **Detect event type** from definitive language only (a bare noun like
   "renewal"/"cancellation" is never a positive signal).
5. **Detect negation / speculation** at clause level — the definitive factual
   clause wins ("not cancelled; renewed for Season 3" → renewal).
6. **Extract details** (season number, concrete date/window, named person).
7. **Validate freshness** against a per-event-type max age.
8. **Assign confidence** from source tier + ambiguity + detail richness.
9. **Reject below threshold** (0.6). A Tier 3 outlet cannot clear the bar for a
   non-distinctive title on language alone.

### Ambiguity policy (high-risk titles)

Single-word and pronoun/preposition titles carry false-positive risk and require
escalating evidence:

- **distinct** (multi-word / long): matches directly on a bounded title phrase.
- **weak** (single distinctive word): requires a TV-context signal.
- **high** (single common word — Dark, Industry, Love, Beef, Sugar, Evil, Lost,
  Found, Wednesday, Upload): requires corroborating identity evidence
  (matching network/streamer, first-air year, known lead actor, a season number
  grammatically attached to the title, or explicit series phrasing). A single
  weak corroborator can be insufficient; adjectival compounds ("dark comedy")
  are detected and rejected.
- **ultra** (From, You): requires *structural* proof the word is used as a title
  — a quoted title, a possessive platform construction ("Netflix's You"), or a
  subject-verb reading with a connector ("From renewed for…"). A generic context
  word anywhere in the headline is never enough.

An article-stripped ("the last of us" → "last of us") form is only ever a
*secondary* comparison signal and is treated as `high` (needs corroboration),
never sole proof. Substrings are never treated as aliases.

### Multi-title headlines

Roundups/listicles are rejected by default. When more than one tracked show is
named, the event must be structurally attached (same clause) to the resolved
show, so a date/renewal belonging to another title is not miscredited.

### Rejection philosophy

Every stage records `evidence` and `rejectionReasons` internally (not exposed to
the UI) so a candidate's accept/reject decision is always explainable in tests
and future diagnostics.

## Source trust tiers

- **Tier 1 — official**: network/streamer/studio press hosts and names (HBO,
  Netflix newsroom, Disney/Marvel/DC, Apple, FX, Paramount, Peacock, BBC, …).
- **Tier 2 — trade**: Deadline, Variety, The Hollywood Reporter, TVLine, EW,
  TheWrap, Vulture, Collider, IGN.
- **Tier 3 — other**: everything else — accepted only with very high identity +
  event confidence and definitive language; never establishes an event alone for
  a non-distinctive title.

Trust resolves from the article's registrable domain (dot-boundary match, never a
raw substring — `notdeadline.example.com` does not inherit Deadline's tier) and,
as a fallback, the reported source name. There is no large blacklist.

### Freshness

Announcements are only useful when recent. Default max age: renewal /
cancellation 75 days, season_date 90 days, cast_addition 60 days. Impossible
future-dated articles are rejected. Old events are never resurrected by a fresh
fetch.

## Announcement schema & copy

```js
{
  id, showId, showName, posterPath,
  eventType, headline, detail,
  seasonNumber, premiereDate, releaseWindow, personName,
  sourceName, sourceUrl, publishedAt, confidence,
}
```

Copy is generated from extracted facts, independent of publisher wording
("Renewed — Sugar will return for Season 3"). Unknown season numbers are omitted,
not guessed. Nothing absent from the evidence is invented.

## Announcement deduplication & supersession

Stable event key clusters identical events across publishers:

```
showId + renewal + season
showId + cancellation
showId + season_date + season           (date excluded from the key on purpose)
showId + cast_addition + person + season
```

Within a cluster the representative is chosen by: highest trust → newest report
→ higher confidence → stable URL tiebreak. **Supersession rule:** because the
`season_date` key excludes the specific date, a newer premiere-date report for
the same show+season lands in the same cluster and the newest report wins (a
date change/correction supersedes the older date). Distinct events (different
person, different season, renewal vs cancellation) never merge.

## Trailers

### TMDB video endpoint strategy

Primary source is TMDB structured video metadata (`/tv/{id}/videos`,
`/movie/{id}/videos`), fetched through the **existing** `/api/tmdb/<path>` keyed
proxy so the API key stays server-side. `append_to_response` is intentionally
not used in Phase 1 to keep cache boundaries simple; the direct `videos`
endpoint is sufficient and separately cacheable.

### Filter rules

Accept only `site === 'YouTube'` and `type` of `Trailer` or `Teaser`, preferring
`official === true`. Reject TMDB types Clip / Featurette / Behind the Scenes /
Opening Credits / Bloopers, and reject by normalized name (preview, sneak peek,
promo, clip, featurette, BTS, making of, interview, inside the episode, recap,
explained, reaction, fan/concept trailer, opening credits, title sequence,
bloopers). An **Official Clip mistyped by TMDB as a Trailer is still rejected.**
Unofficial uploads are rejected unless a config flag explicitly enables fallback.

### Ranking & dedup

Dedup by exact YouTube key first, then collapse dubbed/regional reposts of the
same cut (media + season + variant), while keeping genuinely distinct cuts
(teaser vs trailer vs final trailer) separate. Rank by official → media/season
relevance → English/neutral language → freshness → Trailer-before-Teaser when
equally recent → higher resolution → stable key tiebreak. Per media item, expose
at most the latest official Trailer, a distinct latest Teaser, and a Final
Trailer when distinct and newer.

The card's navigation target is `https://www.youtube.com/watch?v=<key>` (never an
embed URL), so a tap can hand off to the YouTube app on iOS. No autoplay.

### Trailer freshness & seen-state

First bootstrap admits only videos published within a configurable window
(default 150 days); undated videos are excluded on bootstrap. After bootstrap the
cache retains seen keys, admits newly discovered qualifying videos, preserves
currently-cached items during background refresh (stale-while-revalidate), and
prunes safely. `fetched`, `displayed`, and `seen` are tracked distinctly; a video
is not marked seen merely because it was fetched. No UI read controls are added
in this PR.

## Marvel/DC catalogue method (the only catalogue exception)

Beyond tracked shows, Trailers additionally include official Marvel/DC TV & movie
trailers — and nothing broader. Membership is decided **only by TMDB's own
production-company attribution** via `/discover/{tv,movie}?with_companies=<ids>`,
never by title keyword or synopsis.

### Configured company ids (isolated, documented)

Marvel: `420` (Marvel Studios), `7505` (Marvel Entertainment), `19551` (Marvel
Studios secondary attribution). DC: `429` (DC Comics), `9993` (DC Entertainment),
`128064` (DC Studios).

Explicitly **excluded** as too broad (never queried): `2` Walt Disney Pictures,
`3` Pixar, `174` Warner Bros. Pictures, `128` Warner Bros. Television, `6704`
The Walt Disney Company.

### Verification status & limitation (honest)

These are the well-known, widely-documented TMDB company ids for these entities,
but they were **not verified against a live TMDB response in this build
environment** (no TMDB key available here). Every configured id ships
`verified: false`, and `assertVerifiedBeforeProduction()` keeps the Marvel/DC
exception **disabled** (`isMarvelDcEnabled()` returns `false`) until each id is
confirmed live. `discoverClient` therefore fetches trailers for tracked shows
only in this build. To enable the exception: verify each id against
`/discover/{tv,movie}?with_companies=<id>` on the live proxy, confirm the result
set is not a broad unrelated catalogue, then flip `verified` to `true`. This is
the "report the limitation rather than guess" path.

## Cache schema & versioning (migration)

Three separate, versioned localStorage namespaces, all distinct from the legacy
`rerun_news_cache:v1`:

- `rerun_discover_announcements:v1`
- `rerun_discover_trailers:v1`
- `rerun_discover_video_cache:v1:` / `rerun_discover_video_time:v1:` (TMDB fetch cache)

Each has robust JSON parsing, an explicit version, a TTL / max-age, bounded
storage, and a clean reset on corruption or version mismatch (no boot crash). The
old news cache is left untouched and can never contaminate the new feeds — old
generic articles are not reinterpreted as announcements.

## Refresh strategy & API efficiency

- Per-show `videos` cached 6h; Marvel/DC discover cached 24h (longer TTL).
- Bounded concurrency (default 4) across tracked-show video fetches.
- Stale-while-revalidate: cached items stay visible during refresh.
- Failure isolation: one show's fetch failing yields an empty list, never
  failing the batch; one feed failing never erases the other's cache.
- The TMDB key is never exposed client-side (all requests go through the proxy).

## Legacy news retirement status

Phase 1 stops extending the generic-news architecture and introduces the new
`announcements`/`trailers` modules with clean boundaries. The legacy
`src/lib/news/*`, `api/news.js`, `BrowseNews.jsx`, and `rerun_news_cache:v1`
remain in place as a temporary compatibility layer so production stays stable.
Phase 2 will switch the Discover page to the new feeds and retire the generic
"Latest from your shows" and "TV headlines" sections and the legacy news modules.

## Known limitations

- Marvel/DC company ids are unverified in this environment; the exception is
  disabled by default (see above).
- Announcements are only as good as the configured article sources
  (`api/news.js` curated feeds: Deadline, TVLine, plus optional GNews). Phase 1
  reuses that candidate pool and applies strict classification on top.
- Person-name extraction for cast additions uses capitalization heuristics on the
  raw headline; ambiguous guest/recurring distinctions default to rejection.
- Live TMDB/API validation was not performed in this build (no key); tests use
  fixtures shaped from official response forms.
