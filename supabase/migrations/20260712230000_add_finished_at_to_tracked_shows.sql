-- A personal archive state. This deliberately lives on tracked_shows so watch
-- history, timestamps, and Stats metadata remain untouched.
alter table public.tracked_shows
  add column if not exists finished_at timestamptz null;

comment on column public.tracked_shows.finished_at is
  'When non-null, the owner has personally finished this show and it is archived from Watching.';
