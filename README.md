# Rerun

A personal TV watch-log app. TV shows only, no movies, no auth.

See [CLAUDE.md](./CLAUDE.md) for full project context, stack, data model, and workflow rules.

## Stack

- React + Vite
- Tailwind CSS v4
- Supabase (Postgres, public/anon access — no auth)
- TMDB API

## Local setup

```bash
npm install
cp .env.example .env
# fill in VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, TMDB_API_KEY
npm run dev
```

## Deploy

Merging to `main` auto-deploys via Vercel.

## Running the cleanup script from a phone

`scripts/cleanup-unaired-watched.js` (a one-time maintenance script — see its
header comment) runs as a GitHub Actions workflow instead of locally, since
there's no local dev environment for this project.

**Setup (once):** in the repo on GitHub, go to **Settings → Secrets and
variables → Actions** and add two repository secrets:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

(Same values as the app's own Vercel env vars.)

**To run it, from the GitHub mobile app or mobile site:**

1. Open the repo → **Actions** tab
2. Select **Cleanup unaired watched episodes** in the workflow list
3. Tap **Run workflow**
4. Leave **confirm** off for a dry run (prints what it would delete, deletes
   nothing) — check the run's log to review the table of flagged rows
5. If it looks right, run it again with **confirm** switched on to actually
   delete those rows
