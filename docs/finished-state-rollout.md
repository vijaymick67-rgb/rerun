# Personal finished-state rollout

The committed migration is `supabase/migrations/20260712230000_add_finished_at_to_tracked_shows.sql`.

## Apply in Supabase

1. Open the Rerun Supabase project (`umzeszalktyudjtnvmus`) and go to **SQL Editor**.
2. Paste and run the complete contents of that migration file:

```sql
alter table public.tracked_shows
  add column if not exists finished_at timestamptz null;

comment on column public.tracked_shows.finished_at is
  'When non-null, the owner has personally finished this show and it is archived from Watching.';
```

3. Merge the app PR into `main` and wait for Vercel to deploy.
4. In the deployed app, go to **Settings** → **Archive earlier bulk-marked shows** → **Preview archive repair**. Review the names and confirm. The exception-list shows must not appear in the affected list.

## Production verification

1. In **Watching**, confirm an active show with no unwatched aired episodes remains visible when it has no `finished_at` value.
2. Open a personally completed but TMDB-active show from **Stats**, choose **Mark finished**, confirm it disappears from Watching, and confirm its poster still remains in Stats.
3. Open that same show from Stats and choose **Restore to Watching**; confirm it becomes eligible for Watching again.
4. In Supabase SQL Editor, verify no history was changed by either action:

```sql
select tmdb_show_id, season_number, episode_number, watched_at
from public.watched_episodes
where tmdb_show_id = <tmdb_id>
order by season_number, episode_number;
```

5. Verify only the personal archive field changed on the tracked show:

```sql
select tmdb_id, name, finished_at
from public.tracked_shows
where tmdb_id = <tmdb_id>;
```
