-- Soft visibility state. Existing rows stay visible because the nullable
-- column defaults to null. Watch history is intentionally untouched.
alter table public.tracked_shows
  add column if not exists hidden_at timestamptz null;

comment on column public.tracked_shows.hidden_at is
  'When non-null, the owner has hidden this show while preserving its history.';
