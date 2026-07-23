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
| `announcementPlan.js` | Shared query planner + cache token (guaranteed canonical coverage; stable token for the cacheable GET). Imported by both the client and the acquisition endpoint. |
| `franchiseSeeds.js` | **Verified narrow franchise company seeds** (Marvel Studios / Marvel Television / DC Studios candidates) + rejected broad-company ids + live `verifySeed`. Ships all seeds disabled/unverified. |
| `franchiseCatalogue.js` | **Dynamic** Marvel/DC discovery: TMDB `/discover` (movie+TV) → detail-level company confirmation → moving date window → bounded pagination → dedup → overrides. Membership is TMDB company attribution, never keyword. |
| `franchiseOverrides.js` | Tiny exceptional include/exclude override layer (empty by default). |
| `franchiseCatalogueStore.js` | Versioned SWR catalogue cache (`rerun_discover_franchise_catalogue:v1`, 24h TTL, config-keyed, stale-on-error). |
| `tmdbVideos.js` | TMDB `videos`/`discover`/detail fetching via the existing keyed proxy, cache + bounded concurrency + failure isolation. |
| `discoverClient.js` | Orchestration + error-isolated feed state (the Phase 2 seam). |

Server-side: `api/discover/announcements.js` is the announcements **acquisition**
endpoint (bounded, batched, event-scoped per-show search + server cache), and
`api/discover/franchise-catalogue.js` runs the dynamic Marvel/DC discovery
pipeline with the protected TMDB key (CDN-cached). `scripts/verify-franchise-seeds.mjs`
is a maintainer tool that live-verifies the franchise **company seeds** when a
TMDB key is present.

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
  alternative titles (never invented aliases). It computes a stable plan **token**
  (shared `announcementPlan.js`) and **GETs** the cacheable
  `/api/discover/announcements?plan=<token>` URL, so identical libraries hit the
  edge CDN with zero upstream calls (see the server-cache section below).
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

### Server acquisition cache & actual persistence guarantee

A refresh can issue up to 20 GNews searches, so normal Discover mounts must not
trigger them every time. Two cache layers, with an honest account of what each
actually guarantees:

1. **Durable layer — the Vercel edge CDN.** The client requests the endpoint as a
   **GET** with a stable `?plan=<token>`. The token is a self-describing encoding
   of the **sorted** scheduled canonical titles + sorted scheduled aliases +
   vocabulary/schema/language versions, so equivalent libraries (same shows in any
   order) produce an **identical URL**. The GET response carries
   `Cache-Control: public, s-maxage=1800, stale-while-revalidate=10800,
   stale-if-error=86400`, so within the 30-minute TTL the CDN serves repeats
   **without invoking the function at all** — genuinely zero upstream GNews calls,
   shared across clients/POPs and persistent across serverless cold starts. This
   is the real persistence guarantee. A `Cache-Control` header on a **POST** would
   *not* be cacheable — which is exactly why the durable path is a GET with a
   token (generated by shared code; the server is the authority that decodes it to
   rebuild the exact query set).
2. **Best-effort in-process layer.** A small bounded `Map` (injectable, so it is
   unit-testable) dedupes upstream calls **within a warm invocation** and lets a
   full-upstream failure serve the last usable candidates (`stale-if-error`). It is
   explicitly **not** relied on for durability across invocations — the CDN is.
   Corruption in this layer is treated as a miss, never a crash.

The cache key is the plan token, so differing query plans never contaminate each
other. A partial upstream failure still caches the usable candidates. `refresh=1`
(GET) / `forceRefresh` (POST) is the only bypass — normal mounts never force. The
POST path (used for planning/tests) also returns the `planToken` so a client can
switch to the cacheable GET. Cache behaviour is proven by eight endpoint tests
(first request calls upstream; second within TTL calls zero; changed plan → new
key; expiry refreshes; partial failure preserves candidates; full failure serves
stale; no cross-plan contamination; corruption does not crash).

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

## Marvel/DC catalogue method — dynamic TMDB franchise discovery

Beyond tracked shows, Trailers additionally include official Marvel/DC TV & movie
trailers — and nothing broader. Membership is **discovered dynamically** from TMDB
structured metadata; it is **not** a hand-maintained list of titles.

### Why the static title list was rejected

The previous implementation hard-coded every individual Marvel/DC movie and TV id
in source (`MARVEL_DC_CATALOGUE`). That list goes stale the moment Marvel Studios
or DC Studios announces a new project, and it required a code change per title —
exactly the titles most likely to publish a fresh trailer would be missing until
someone edited the array. **It has been deleted.** Future Marvel/DC projects must
enter automatically, without a source-code title addition.

### Verified narrow company seeds (`franchiseSeeds.js`)

A `/discover?with_companies=<id>` query is only as safe as the company id is
**narrow**. Parent-studio ids are dangerously broad — `429` "DC Comics" (a loose
source-material credit on decades of unrelated media), `174`/`2` (Warner Bros.
Pictures / Walt Disney Pictures, entire slates), `128`, `6704` — and are listed in
`REJECTED_BROAD_COMPANY_IDS`, never used. Eligible seeds are only franchise-specific
production entities: **Marvel Studios, Marvel Television, DC Studios** (and the
like). Each seed is a **candidate** shipped `verified: false, enabled: false`; a
seed is never queried at runtime until it is live-verified. We never ship
`verified: false, enabled: true`.

`verifySeed(seed, { fetchJson })` performs the live check: it rejects broad ids
outright, confirms the live company **name** matches the candidate, and inspects a
`/discover` sample to confirm the company is **narrow** (`total_results ≤
MAX_NARROW_SAMPLE`, i.e. a franchise entity, not a studio slate). It returns
evidence only — a maintainer reviews it and edits the seed flags.

### Detail-level membership confirmation (`franchiseCatalogue.js`)

A discover result is only a **candidate**. Before a title is admitted, its detail
is fetched and it must contain at least one configured verified seed id in
`production_companies` (`confirmMembership`). This defends against loose discover
behaviour, stale metadata, and query leakage. Membership is therefore TMDB company
attribution, **re-confirmed at the detail level** — never title/synopsis keywords,
genre, or broad studio ownership. Each member records
`{ mediaType, mediaId, title, posterPath, backdropPath, releaseDate, firstAirDate,
franchise, matchedCompanyIds, verifiedAt }`.

### Moving date window (`dateWindow` / `withinWindow`)

Only media that could plausibly publish a new teaser/trailer is monitored. The
window is derived from `now` — default **12 months before → 36 months after**
(`DATE_WINDOW`, configurable) — and slides forward automatically; nothing is pinned
to a calendar year. Discover uses the correct date field per media type
(`primary_release_date` for movies, `first_air_date` for TV). A dated title must
fall inside the window; an **undated** title is kept only when its TMDB `status`
indicates active/planned production (so it could still drop a trailer). Polling
eligibility is thus **date-derived**, not a hand-maintained active/legacy/retired
tier.

### Bounded pagination & completeness

Discover is paginated. Each franchise + media type is fetched across its verified
seeds (OR-combined with the TMDB `|` operator), up to `MAX_DISCOVER_PAGES` (5),
deduped across pages. Hitting the cap sets `coverage.truncated`/`partial` — a
truncated build is **never** dressed up as complete. A safety ceiling of
`MAX_CATALOGUE_ITEMS` (200) bounds detail-confirm + video polling work and also
marks partial coverage.

### Franchise catalogue cache (`franchiseCatalogueStore.js` + `api/discover/franchise-catalogue.js`)

The discover → detail-confirm pipeline is expensive, so it runs **server-side**
(`api/discover/franchise-catalogue.js`, with the protected TMDB key) once per TTL
and is served from the **Vercel edge CDN** (`s-maxage=86400, stale-while-revalidate,
stale-if-error`). The client also keeps a 24h `localStorage` copy
(`rerun_discover_franchise_catalogue:v1`): versioned schema, corruption-safe reset,
bounded item count, and a **config key** embedding the verified seed set + window
version so a seed change invalidates the old catalogue. On a failed refresh the
client returns the last usable **stale** catalogue (`stale-on-error`) so the
trailers feed never empties. One failed company query never erases the others'
results.

### Video polling & the same strict filter

Only the discovered (recent/upcoming) members are polled for videos via
`/{tv,movie}/{id}/videos` — the same bounded-concurrency, per-media-cached,
failure-isolated fetcher as tracked shows. Their videos go through the **exact
same** strict `trailerFilter` + `trailerRank` pipeline (an official franchise
trailer is accepted and tagged; a franchise clip is rejected). Retired historical
titles are simply outside the date window, so they are never polled — no manual
poll tiers.

### Exceptional overrides (`franchiseOverrides.js`)

A very small escape hatch, **empty by default**: `includeOverrides` admit a
verified title TMDB does not yet attribute to a configured company (bypassing the
company gate by design, each with an explanation + verification date), and
`excludeOverrides` drop a confirmed false positive. Ordinary future projects must
enter through dynamic attribution, never via an override; overrides should be
pruned once TMDB corrects the metadata.

### Honest live-verification status

**Exact live checks performed in this build: none.** The build/CI sandbox has no
TMDB key and cannot reach `api.themoviedb.org`. Because **no company seed could be
live-verified here, every seed stays disabled and the dynamic catalogue is empty
in this environment** — the feature is safely inert rather than guessing. A safe
disabled seed is strictly preferable to an enabled guessed one.

**Maintenance workflow** (documented so the catalogue stays current on its own):

1. Run `TMDB_API_KEY=… node scripts/verify-franchise-seeds.mjs` in a key-holding
   environment. For each candidate seed it resolves the company, confirms its live
   name, and samples `/discover` (movie + TV) to confirm narrowness, printing an
   OK/FAIL row.
2. For each seed that resolves narrow and name-matched, set `verified: true,
   enabled: true` in `franchiseSeeds.js`. Keep any that fail **disabled**.
3. Deploy. From then on, new Marvel/DC projects enter the catalogue automatically
   as TMDB attributes them to a verified company — **no per-title source edits**.
4. Revisit only if TMDB reorganises a franchise company id, or to prune an
   override once its metadata gap is fixed upstream.

## Cache schema & versioning (migration)

Three separate, versioned localStorage namespaces, all distinct from the legacy
`rerun_news_cache:v1`:

- `rerun_discover_announcements:v1`
- `rerun_discover_trailers:v1` (internal schema `version: 2` — carries the
  bootstrap baseline; a stored `version: 1` payload is discarded and re-bootstraps)
- `rerun_discover_video_cache:v1:` / `rerun_discover_video_time:v1:` (TMDB fetch cache)
- `rerun_discover_franchise_catalogue:v1` (dynamic Marvel/DC catalogue, 24h TTL,
  config-keyed on the verified seed set + window version, stale-on-error)

Server-side, the announcement acquisition cache's durable layer is the **Vercel
edge CDN** (GET `?plan=<token>`, `s-maxage`) — not an in-memory module Map, which
is used only as a best-effort per-invocation layer. The franchise catalogue
endpoint is likewise CDN-cached.

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

- The Marvel/DC franchise **company seeds are not live-verified** in this build
  (no TMDB key in the sandbox — exact live checks performed: none). All seeds ship
  `verified: false, enabled: false`, so **the dynamic catalogue is empty here** and
  no franchise trailers surface until a maintainer runs
  `scripts/verify-franchise-seeds.mjs` and enables the seeds that pass. This is the
  intended safe state: a disabled seed is preferable to an enabled guessed one. Once
  seeds are enabled, new Marvel/DC projects enter automatically via TMDB company
  attribution — no per-title source edits.
- Announcement acquisition depends on a configured GNews key server-side. Without
  it the endpoint returns an empty candidate set (never a generic feed), so the
  Announcements feed is empty until the key is present. Canonical coverage is
  guaranteed up to 160 tracked shows per refresh; beyond that the response reports
  `partialCoverage` and raising it means raising `MAX_QUERIES`.
- The announcement cache's durable persistence is the Vercel edge CDN (per-POP,
  best-effort, honouring `s-maxage`/SWR/`stale-if-error`). It is not a strongly
  consistent store; for a personal single-user app this is more than sufficient and
  no cross-user data is involved. The in-process Map is explicitly non-durable.
- Person-name extraction for cast additions uses capitalization heuristics on the
  raw headline; ambiguous guest/recurring distinctions default to rejection.
- No live TMDB/GNews calls were made in this build (no keys available); tests use
  fixtures shaped from official response forms.
