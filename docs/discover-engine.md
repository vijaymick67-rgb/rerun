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
| `trailerStore.js` | Versioned trailers cache + bootstrap baseline + seen-state (`rerun_discover_trailers:v1`). |
| `marvelDcCatalogue.js` | Explicit media-id allowlist of Marvel/DC TV & movies (membership by TMDB media id, never keyword) with status/release metadata + poll cadence/retirement + per-entry enable gate. |
| `tmdbVideos.js` | TMDB `videos` fetching via the existing keyed proxy, cache + bounded concurrency + failure isolation. |
| `discoverClient.js` | Orchestration + error-isolated feed state (the Phase 2 seam). |

Server-side, `api/discover/announcements.js` is the announcements **acquisition**
endpoint (bounded, batched, event-scoped per-show search), and
`scripts/verify-marvel-dc.mjs` is a maintainer tool that live-verifies the
Marvel/DC media ids when a TMDB key is present.

## Tracked-show coverage

Both feeds cover **every tracked show, in any tracked status** — watching,
watchlist, upcoming, paused, finished, and hidden. The engine never filters by
`hidden_at` / `finished_at`; the caller passes the full tracked set and the
identity registry treats them uniformly. (The Phase 2 wiring will read all
tracked rows; this PR's engine is status-agnostic by construction — see the
integration tests.)

## Announcement acquisition (`api/discover/announcements.js`)

The classifier is only as good as the candidates it sees, and a single generic
"TV news" sample cannot cover every tracked show. Acquisition is therefore a
dedicated endpoint, not the generic `/api/news` feed:

- The client (`loadAnnouncements`) derives per-show search terms from the
  identity registry — each show's canonical title plus up to two **verified**
  alternative titles (never invented aliases) — and POSTs them.
- The endpoint builds **bounded, batched** queries: several shows' terms are
  OR-joined per query and ANDed with a shared clause scoped to **only the four
  allowed event categories** (renewed/renewal, canceled/cancelled/"final season",
  premiere/"release date", cast/"joins the cast"). It never issues one
  uncontrolled request per show — both terms-per-query and total query count are
  hard-capped (`MAX_TERMS_PER_QUERY = 8`, `MAX_QUERIES = 20`), and queries run
  under a small concurrency limit (`QUERY_CONCURRENCY = 4`).
- **Guaranteed canonical coverage.** The planner (`buildAnnouncementQueries`)
  schedules terms in two phases so no tracked show is ever silently dropped in
  favour of another show's alias: (1) **every** canonical title fills the shared
  term budget (`TERM_BUDGET = MAX_QUERIES × MAX_TERMS_PER_QUERY = 160`) first, in
  received order; (2) verified aliases take only the **leftover** budget. Complete
  canonical coverage is therefore guaranteed for up to 160 tracked shows per
  refresh (well beyond a personal library). Beyond that the plan reports an
  **explicit partial-coverage state** rather than pretending success.
- **Coverage metadata on every response.** `meta` reports `showsReceived`,
  `canonicalTitlesSearched`, `aliasesSearched`, `aliasesOmitted`, `showsOmitted`
  and `partialCoverage`, so the client can distinguish full coverage from a
  budget-limited run.
- **Quota tradeoff.** Each query is one GNews request, so total upstream requests
  per refresh are capped at `MAX_QUERIES` (20) regardless of library size. Raising
  canonical capacity means raising `MAX_QUERIES` (more requests per refresh). At
  the endpoint's 30-minute cache TTL, 20 requests/refresh stays comfortably inside
  a free-tier daily budget. Aliases are the first thing sacrificed to the cap —
  never a canonical title.
- Each query is **failure-isolated**: one failing query never fails the others;
  a 502 is surfaced only if *every* query fails (so the client keeps its cache).
- Raw candidates are normalized (`normalizeArticle`) and **de-duplicated across
  queries** (`dedupeArticles`) before the response, preserving source name, URL
  and timestamp for client-side deterministic classification.
- The GNews key stays server-side. With no key configured the endpoint returns
  an **empty** candidate set (`configured: false`) — never a generic feed.

This is a clean retirement path: Phase 2 removes the legacy generic-news code
without touching this endpoint.

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

### Trailer freshness & the bootstrap baseline

On the **first** load for a set of shows TMDB returns the entire back-catalogue
of qualifying trailers — often years old. Two things must both hold: we must not
dump all of it into the feed, and we must not let it sneak in on the *next*
refresh either. The store guarantees this with an explicit baseline:

- **Display**: on first bootstrap only videos published within a configurable
  window (default 150 days) enter the feed; undated videos are not displayed.
- **Baseline (`knownKeys`)**: *every* qualifying key observed on bootstrap —
  displayed or not, dated or undated — is recorded as baseline-known. This is the
  anchor that makes "new" meaningful.
- **After bootstrap**: a video is admitted only if its key is **not already in
  the baseline** (genuinely newly discovered). A previously-excluded historical
  key is in `knownKeys`, so when the same old catalogue comes back on the next
  refresh it stays excluded — "new" is never inferred merely from an old video
  not having been displayed.
- A genuinely newly published trailer — even for a long-finished show — has a
  key we have never seen and is admitted, arriving alongside the old catalogue.

Three key-sets are persisted separately so display semantics never bleed into
"new" detection: `knownKeys` (baseline, drives admission), `seenKeys`
(read-state placeholder for a future UI badge), and `items` (currently
displayed). Stale-while-revalidate preserves cached items during a background
refresh; the cache prunes and caps safely. No UI read controls are added in this
PR. The cache schema is bumped to **v2** to add the baseline (Scope O migration:
an older-shaped cache is discarded and re-bootstraps cleanly).

## Marvel/DC catalogue method (the only catalogue exception)

Beyond tracked shows, Trailers additionally include official Marvel/DC TV & movie
trailers — and nothing broader.

### Why an explicit media-id allowlist, not a company discover query

A `/discover?with_companies=<id>` query is only as safe as the company id is
narrow, and the obvious ids are dangerously broad: `429` "DC Comics" is a loose
source-material credit attached to a huge, unrelated set; `174`/`2` (Warner Bros.
Pictures / Walt Disney Pictures) are entire studio slates. One wrong or
loosely-attributed id floods the feed with unrelated media — the exact failure to
avoid.

So membership is an **explicit allowlist of specific TMDB media ids**
(`MARVEL_DC_CATALOGUE`), each recording `{ mediaType, id, title, franchise,
status, releaseDate, pollTier, liveVerified, enabled }`. This is **safe by
construction**: a wrong or stale entry can only add or miss *one* title's
trailers — it can never pull an unrelated catalogue. Membership
(`isFranchiseMediaId`) never inspects title or synopsis text. The broad company
ids (`429`, `174`, `2`, `128`, `6704`) are documented in
`REJECTED_BROAD_COMPANY_IDS` precisely so no maintainer reintroduces a company
query.

Each catalogue target resolves to `/{tv|movie}/{id}/videos` and its videos go
through the **exact same** strict `trailerFilter` + `trailerRank` pipeline as
tracked shows (see the franchise integration test: an official franchise trailer
is accepted and tagged, a franchise clip is rejected).

### Poll cadence & retirement (covering current/upcoming, not just old films)

New trailers come from **upcoming and recently-released** projects; a film from
years ago will not publish a new one. Each entry carries a `pollTier`:

- `active` — upcoming or currently-releasing → polled every refresh (`fast`
  cadence). Includes current/announced projects (e.g. *The Fantastic Four: First
  Steps*, *Superman*, *Daredevil: Born Again*, *Peacemaker* S2).
- `legacy` — released within the maintenance window → still polled (`slow`), for a
  late featurette/anniversary trailer.
- `retired` — long-released and done → **excluded from polling** to save requests,
  but still a **member** for classification, so a stray franchise video is tagged
  correctly rather than mislabelled.

`catalogueTargets()` returns only enabled, non-retired entries (each annotated
with its `cadence`); `isFranchiseMediaId()` matches the full allowlist so
membership is independent of cadence. Tests cover an upcoming Marvel movie, Marvel
TV, DC movie and DC TV entry; that retired titles are excluded from polling yet
still classified; and that unrelated Disney/Warner titles (Moana, Barbie, Bluey)
are excluded.

### Per-entry enable gate & honest live-verification limitation

Each entry has an `enabled` flag and a `liveVerified` flag. `filterCatalogue`
(and therefore `catalogueTargets`/`isFranchiseMediaId`) respect `enabled`, so a
single bad id can be disabled **without affecting any other entry** — proven by a
test that disables one synthetic entry and shows its sibling survives.

The exception is **enabled** (`isMarvelDcEnabled()` returns `true`) because an
explicit allowlist does not carry the breadth risk that would force a company
query to stay gated.

**Exact live checks performed in this build: none.** The build/CI sandbox has no
TMDB key and cannot reach `api.themoviedb.org` (outbound TMDB calls need the
server-side key held only in Vercel). Every entry therefore ships
`liveVerified: false` (`verificationStatus().liveVerified === 0`).

**Maintenance workflow** (documented so the catalogue stays current):

1. Run `TMDB_API_KEY=… node scripts/verify-marvel-dc.mjs` in a key-holding
   environment. It fetches each id, compares the resolved title to the expected
   title, prints an OK/FAIL row per entry, and exits non-zero on any mismatch.
2. For each id that resolves, flip `liveVerified: true`.
3. For any id that **fails**, set `enabled: false` for that one entry (it drops
   from polling and membership; nothing else is affected).
4. As new Marvel Studios / Marvel Television / DC Studios projects are announced,
   add them with `status: 'upcoming'` and `pollTier: 'active'`; move released
   titles to `legacy`, then `retired` once they stop publishing trailers.

Because a wrong id can at worst affect a single title (not the whole feed),
running the feature while per-id live confirmation is pending is safe — this is
the "explicit verified catalogue/configuration boundary rather than guessing"
path the requirement calls for.

## Cache schema & versioning (migration)

Three separate, versioned localStorage namespaces, all distinct from the legacy
`rerun_news_cache:v1`:

- `rerun_discover_announcements:v1`
- `rerun_discover_trailers:v1` (internal schema `version: 2` — carries the
  bootstrap baseline; a stored `version: 1` payload is discarded and re-bootstraps)
- `rerun_discover_video_cache:v1:` / `rerun_discover_video_time:v1:` (TMDB fetch cache)

Each has robust JSON parsing, an explicit version, a TTL / max-age, bounded
storage, and a clean reset on corruption or version mismatch (no boot crash). The
old news cache is left untouched and can never contaminate the new feeds — old
generic articles are not reinterpreted as announcements.

## Refresh strategy & API efficiency

- Per-media `videos` cached 6h (tracked shows and franchise targets alike).
- Bounded concurrency (default 4) across tracked-show and franchise video fetches.
- Announcement acquisition caps both terms-per-query and total query count, runs
  queries under a concurrency limit, and de-duplicates candidates server-side.
- Stale-while-revalidate: cached items stay visible during refresh.
- Failure isolation: one show/target fetch failing yields an empty list, never
  failing the batch; one announcement query failing never fails the rest; one
  feed failing never erases the other's cache.
- No key is ever exposed client-side — TMDB via the `/api/tmdb` proxy, GNews only
  inside `api/discover/announcements.js`.

## Legacy news retirement status

Phase 1 stops extending the generic-news architecture and introduces the new
`announcements`/`trailers` modules with clean boundaries, including a dedicated
`api/discover/announcements.js` acquisition endpoint that does not touch the
legacy news code. The legacy `src/lib/news/*`, `api/news.js`, `BrowseNews.jsx`,
and `rerun_news_cache:v1` remain in place as a temporary compatibility layer so
production stays stable. Announcement acquisition reuses two pure, stable helpers
from the news lib (`normalizeArticle`, `dedupeArticles`) but not its feed
aggregation. Phase 2 will switch the Discover page to the new feeds and retire the
generic "Latest from your shows" and "TV headlines" sections and the legacy news
modules.

## Known limitations

- The Marvel/DC media ids are enabled but not yet **live-verified** in this build
  (no TMDB key in the sandbox — exact live checks performed: none). They ship
  `liveVerified: false`; run `scripts/verify-marvel-dc.mjs` with a key to confirm,
  flip the flags, and `enabled: false` any that fail (per-entry, affects only
  itself). The allowlist is safe by construction (a wrong id affects at most one
  title). `pollTier` must be maintained as projects release — see the maintenance
  workflow above. Upcoming/current ids (2025+) especially warrant a live check.
- Announcement acquisition depends on a configured GNews key server-side. Without
  it the endpoint returns an empty candidate set (never a generic feed), so the
  Announcements feed is empty until the key is present. Adding official
  press/trade RSS *search* providers is possible future work. Canonical coverage
  is guaranteed up to 160 tracked shows per refresh; beyond that the response
  reports `partialCoverage` and raising it means raising `MAX_QUERIES`.
- Person-name extraction for cast additions uses capitalization heuristics on the
  raw headline; ambiguous guest/recurring distinctions default to rejection.
- No live TMDB/GNews calls were made in this build (no keys available); tests use
  fixtures shaped from official response forms.
