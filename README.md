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
