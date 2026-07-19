# Rerun — Project State

> Paste this file's contents at the start of any new Claude chat or Claude Code session.
> Update the "Current Status" section after every merge. This file is the single source of truth —
> don't rely on chat summaries to carry context between sessions.

## What This Is
A personal TV watch-log app. TV shows only, no movies, no auth (single-user, no login).

## Stack
- React + Vite
- Tailwind
- Supabase (Postgres, no auth — public/anon access)
- TMDB API (search + episode data)
- Deploy: merge to `main` on GitHub → Vercel auto-deploys. No local dev environment
  (Mac is away for several months) — all work happens via GitHub Claude Code / web merges.

## Repo & Infra
- GitHub: vijaymick67-rgb/rerun (private)
- Supabase project ref: umzeszalktyudjtnvmus
- Vercel project: rerun-nine.vercel.app, connected to `main`
- Env vars (set in Vercel Production + Preview): VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, TMDB_API_KEY
  (server-only, no VITE_ prefix — used by the api/tmdb proxy, never exposed to the client)

## Data Model
- `tracked_shows`: id, tmdb_id (unique), name, poster_path, added_at
- `watched_episodes`: id, tmdb_show_id, season_number, episode_number, episode_name,
  runtime_minutes (real per-episode runtime from TMDB, not an estimate), watched_at.
  Unique on (tmdb_show_id, season_number, episode_number) — marking watched twice updates
  watched_at instead of duplicating (upsert).
- RLS enabled on both tables, policy set to public (no auth in this app).

## Screens (in build order)
1. Scaffold + TMDB integration
2. Browse — TMDB search, add shows to tracked_shows
3. Watching — shows in progress, sorted by next-unwatched-episode-aired (Marquee's "up next" logic)
4. Log — chronological watched_episodes history, thumbnails
5. Stats — total episodes, real hours watched (sum of runtime_minutes), shows completed,
   monthly breakdown
6. Insights banner — rotates between numeric ("127 hours this month") and vibe/genre-based
   ("prestige-drama era") templates, computed client-side from real data, no external AI calls
7. Aesthetics pass (last) — mobile-first (iPhone primary, desktop secondary), same premium/
   polished bar as FinFlow's Hearth pass, though Rerun gets its own distinct visual identity
   (not a reskin of Hearth's espresso/gold/sage/rust palette)

## Notifications
- Native Web Push, sent by Rerun's own service worker — no ntfy, no third-party relay.
  See `docs/web-push.md` for setup (VAPID keys, required env vars, migration) and exactly
  what the old ntfy/GitHub Actions system (PRs #52–#56) was replaced.
- **Phase 1 (done):** permission + subscription plumbing, Settings → Notifications is fully
  interactive (enable/disable/send test), one manually triggered test notification. No
  automatic episode notifications yet.
- **Phase 2 (not built):** automatic "episode available" notifications on a schedule. When
  built, reuse `notification_deliveries` (left in place, unused) or its identity/claim shape
  — don't reinvent idempotent delivery tracking from scratch.

## Key Technical Decisions
- **Cache TMDB responses locally from day one.** Lesson learned from Marquee — don't skip this.
- No auth. No multi-user. Single-user personal tool.

## Workflow Rules (non-negotiable, apply to every PR)
- Always branch new work off `main` directly — never stack a branch on an unmerged PR's branch.
- Before merging, always request full raw file content — not diffs or summaries. GitHub's diff
  view can visually mislead (looks like duplication when it isn't).
- Keep source and documentation files UTF-8 encoded. Avoid PowerShell `Out-File` and `>`
  redirection unless UTF-8 output is explicitly assured; run `npm run check:encoding` before
  pushing, inspect the PR diff for mojibake, and never paste terminal output into source files.
- All layout/UI changes sanity-checked at 375px width (iPhone 12 primary device).
- Model default: **Sonnet** for both chat and Claude Code. Only escalate to **Opus** for initial/
  tricky schema design, or if Sonnet is stuck on the same bug after a few tries.
- Deployment is merge-only: no local sync, no VS Code. Refresh the live site to verify.

## Current Status
_(update this after every merge)_
- [x] Repo scaffolded
- [x] TMDB integration working
- [x] Search/Browse UI
- [x] Watched toggle + Supabase
- [ ] Log view
- [ ] Stats
- [ ] Aesthetics pass

## Open Questions / Not Yet Decided
- Visual direction for the aesthetics pass (not started — decide once core screens are functional)
