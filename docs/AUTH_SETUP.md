# Owner-only auth — setup, rollout, and recovery

Rerun is a personal, single-owner app. This document is the manual
companion to the auth PR: everything here is a Supabase Dashboard / Google
Cloud Console / SQL Editor step that Claude Code cannot perform (no
credentials, no browser, no dashboard access) and that Vijay must do by
hand, in the order given below.

No real secrets, passwords, emails, or UUIDs appear in this document —
every value below is a placeholder (`<...>`).

Architecture summary, for context: a private `owner_config` singleton table
holds one canonical Supabase Auth UUID; `private.is_owner()` (SECURITY
DEFINER) consults it for RLS policies; `public.current_user_is_owner()` is
the only thing the browser can call, and it returns a boolean, never the
UUID. See the comments in
`supabase/migrations/20260720130000_add_owner_auth_infrastructure.sql` and
`supabase/migrations/20260720140000_owner_only_rls_tracked_watched.sql` for
the full design rationale.

---

## Before preview testing

Do this once, before testing the auth frontend anywhere (Preview or
Production):

1. **Google Cloud Console** — create or reuse an OAuth 2.0 **Web
   application** client.
   - Authorized JavaScript origins: `https://rerun-nine.vercel.app` (add
     your Preview origin too if you plan to test there, e.g.
     `https://<preview-branch>.vercel.app`).
   - Authorized redirect URI: your Supabase project's auth callback,
     `https://<your-project-ref>.supabase.co/auth/v1/callback`.
   - Copy the **Client ID** and **Client Secret** — paste the secret only
     into the Supabase Dashboard in the next step, never into this repo or
     into chat.

2. **Supabase Dashboard → Authentication → Providers → Google** — enable
   it, paste the Client ID/Secret from step 1.

3. **Supabase Dashboard → Authentication → Providers → Email** — leave
   enabled (this is the recovery login), but under **Authentication →
   Settings**:
   - Turn **off** "Allow new users to sign up" (no public signup UI, and no
     server-side path to create one either).
   - Turn **off** Anonymous sign-ins if the project has them enabled.

4. **Supabase Dashboard → Authentication → URL Configuration** — Site URL
   and the redirect allow-list must include the exact production origin
   (`https://rerun-nine.vercel.app/`) and any Preview origin(s) you intend
   to test against.

5. Confirm **`private` is not listed** under **Project Settings → API →
   Exposed schemas** (it should only ever contain `public`, and whatever
   else was already there — do not add `private`). This is what keeps
   `private.is_owner()` uncallable from the browser even though
   `authenticated` holds an EXECUTE grant on it at the SQL level (`anon` and
   `PUBLIC` do not — see the migration's comments for why the grant is
   scoped this narrowly).

---

## Migration A — auth infrastructure only

Applying this migration is safe at any time — it does not touch
`tracked_shows` or `watched_episodes`, so the live app keeps working
exactly as it does today (public/anon access) until Migration B is applied
separately, later, in "Production rollout" below.

1. Apply `supabase/migrations/20260720130000_add_owner_auth_infrastructure.sql`
   (via the Supabase CLI migration flow, or paste it into the SQL Editor if
   that's the project's current practice).

2. **Confirm the RPC exists and is callable**, in the SQL Editor:
   ```sql
   select public.current_user_is_owner();
   ```
   As the `postgres` role in the SQL Editor this will likely return `false`
   (no `auth.uid()` in that context) — that's expected. The point of this
   check is just that the function exists and runs without error.

Registering the actual owner UUID happens later, in "Registering the
canonical owner" below, once the auth frontend is deployed somewhere
reachable (Preview or Production) — creating the Google identity is a
frontend action (`supabase.auth.signInWithOAuth`), not a Dashboard one, so
it has to happen in that order.

---

## Registering the canonical owner

This is the one deterministic path — don't substitute Dashboard "Add user" /
"Invite" flows or guess at whichever password option a given Supabase
version's UI happens to expose; both are unreliable ways to guarantee a
**single** `auth.users` row ends up owning both the Google and the
email/password identity.

Do this once Migration A is applied and the auth frontend (this PR) is
deployed somewhere with working Google OAuth — a Vercel Preview is fine, you
don't need to wait for Production:

1. Open the deployed app and click **Continue with Google**, signing in with
   the owner's Google account.
2. You will be **rejected** — Login reappears showing "You're not the
   owner." This is expected: no UUID is registered in `private.owner_config`
   yet, so `public.current_user_is_owner()` correctly returns `false` for
   everyone, including you. Supabase Auth has already created the
   `auth.users` row for this Google identity even though the app rejected
   it.
3. In the Supabase Dashboard, **Authentication → Users**, find that new
   user and copy its **UUID** (the `id` column). Treat it like any other
   credential — don't paste it anywhere public.
4. **Register the owner UUID** in the SQL Editor:
   ```sql
   insert into private.owner_config (id, owner_id)
   values (true, '<owner-auth-uuid>')
   on conflict (id) do update set owner_id = excluded.owner_id;
   ```
5. Sign in with Google again. This time the app should admit you —
   `current_user_is_owner()` now returns `true` for this UUID, and the
   normal app (TabBar, Watching, etc.) loads.
6. **Set the recovery password on that same authenticated session** — while
   still signed in as the owner from step 5, go to **Settings → Account →
   Set recovery password** in the app and enter/confirm a password there.
   That screen calls `supabase.auth.updateUser({ password })` directly —
   the Supabase-documented way to attach a password credential to an
   **already-authenticated** OAuth user, and the only path that's
   guaranteed to land on the same `auth.users` row rather than risking a
   second, Dashboard-created one. No browser console, no temporarily
   exposing the Supabase client, no debug deploy — it's a normal owner-only
   screen, reachable only once you're already past the ownership gate, and
   you can return to it any time to change the recovery password again
   later.
7. **Verify recovery login** — sign out, choose "Use recovery login" on the
   Login screen, and sign in with the owner's email + the password from
   step 6. This must succeed and load the same authenticated app.
8. **Confirm one canonical UUID owns both methods:**
   ```sql
   select id, email, raw_app_meta_data->'providers' as providers
   from auth.users;
   ```
   This must show **exactly one row**, its `id` matching what you
   registered in step 4, and `providers` containing both `"google"` and
   `"email"`. If you ever see two separate rows instead, the extra one was
   not created by this procedure — delete it and repeat from step 1.

---

## Preview verification

Deploy the frontend PR to a Vercel Preview (Preview origin already added to
the Google/Supabase allow-lists in step 4 of "Before preview testing") and
check, in order:

1. **Owner Google sign-in** — "Continue with Google" → Google's consent
   screen → back on Rerun, signed in, the app (TabBar, Watching, etc.)
   loads normally.
2. **Recovery sign-in** — sign out, "Use recovery login", the owner's
   email/password → same result as (1).
3. **Unauthorized Google rejection** — sign in with a **different** Google
   account. Expect: no private screen ever flashes, the session is
   terminated, and Login reappears showing exactly **"You're not the
   owner."**
4. **Offline ownership-check behavior** — sign in as the owner, then put
   the device offline (airplane mode / devtools "Offline") and reload.
   Expect a calm "can't verify your account right now" screen with a Retry
   action — never the private app, and never a forced sign-out.
5. **Sign-out and private-cache clearing** — from Settings → Account, sign
   out (with confirmation). Expect Login to reappear, and (via devtools →
   Application → Local Storage) confirm `watching_cache:*`,
   `showdetail_cache:*`, `seasondetail_cache:*`, and `stats_cache:*` keys
   are gone, while push-related keys
   (`push_*`/management-token/notification-preference storage) are still
   present — sign-out must not disturb notification delivery.

At this stage Migration B has **not** been applied yet, so `tracked_shows`/
`watched_episodes` are still publicly readable/writable by anon — this is
expected and fine; it's what step "Migration B" below fixes.

---

## Production rollout

Apply in this exact order. Steps 1–5 can happen well ahead of step 6 — the
app keeps working for Vijay throughout, since Migration B is the only step
that changes who can read/write `tracked_shows`/`watched_episodes`.

1. **Apply Migration A** (see "Migration A" above). Rerun has a single
   Supabase project shared by Preview and Production (see CLAUDE.md), so
   this only needs to happen once.
2. **Register the canonical owner** — run "Registering the canonical
   owner" above using whichever deployed frontend (Preview or Production)
   is convenient; because both point at the same Supabase project, the
   registration applies everywhere immediately.
3. **Deploy/test the auth frontend in Preview** (see "Preview verification"
   above) — do this before merging to `main`.
4. **Merge/deploy the frontend** to `main` → Production (Vercel
   auto-deploys). At this point Production has the login screen and owner
   gate live, but `tracked_shows`/`watched_episodes` are still public — the
   owner-only *gate* is enforced by the frontend UX, not yet by the
   database.
5. **Verify owner access in Production** — repeat "Preview verification"
   steps 1–3 against `https://rerun-nine.vercel.app`.
6. **Apply Migration B**
   (`supabase/migrations/20260720140000_owner_only_rls_tracked_watched.sql`)
   in Production. This is the step that actually locks the data down —
   apply it immediately after step 5 confirms the owner can sign in, so
   there's no meaningful window where the frontend is live but RLS isn't.
7. **Verify anonymous and non-owner access are denied** — the real proof,
   independent of the frontend:
   ```sh
   curl 'https://<your-project-ref>.supabase.co/rest/v1/tracked_shows?select=*' \
     -H "apikey: <anon-key>"
   ```
   Must return `[]`, not real rows. Also repeat "Preview verification" step
   3 (non-owner Google account) against Production.
8. **Verify normal reads/writes and notifications still work** — as the
   owner: browse/track a show, mark an episode watched, export a backup
   (Settings → Backup & Restore), and send a test notification (Settings →
   Notifications). The notification worker
   (`api/notifications/run.js`, Supabase Cron) uses the service-role key and
   is unaffected by Migration B, but confirm a test notification still
   arrives as a final check that nothing in that path regressed.

---

## Emergency recovery

If the owner is ever locked out (wrong UUID registered, owner_config
emptied, Google identity lost, etc.):

- **Repair `owner_config`** directly in the SQL Editor — re-run the
  `insert ... on conflict` from "Registering the canonical owner" step 4
  with the correct UUID. This table is not reachable from the app or from
  PostgREST at all, so the SQL Editor (or another trusted service-role/
  dashboard path) is the only way to fix it.
- **Repair the auth app** (frontend bug, bad deploy, etc.) via a normal
  Vercel rollback/redeploy — this doesn't require touching the database at
  all.
- Use **dashboard/service-role access** for anything that needs to bypass
  RLS temporarily while diagnosing (e.g. reading `tracked_shows` directly
  in the SQL Editor as `postgres`, which isn't subject to the
  `authenticated`-scoped policies at all).
- **Do not** restore the old public/permissive policies on
  `tracked_shows`/`watched_episodes` as a recovery step, even temporarily —
  every recovery path above fixes the actual problem (the owner
  registration or the frontend) without ever reopening the tables to
  anonymous access.

---

## Cleanup workflow decision

`scripts/cleanup-unaired-watched.js` used to run via a GitHub Action
authenticated with the Supabase anon key
(`.github/workflows/cleanup-unaired-watched.yml`). Once Migration B is
applied, the anon key can no longer read or write `tracked_shows`/
`watched_episodes` at all, so that workflow would only ever find zero rows.

**Decision: retire the GitHub Action, keep the script for manual use.**
Giving a GitHub Actions secret the service-role key (which bypasses RLS
entirely) would have widened what a CI credential can do, for a maintenance
task that is one-time-per-bug-class and already dry-run-by-default. Instead:

- The workflow file has been removed.
- The script itself now reads `SUPABASE_SERVICE_ROLE_KEY` instead of the
  anon key, and is meant to be run by hand from a machine you control (see
  the comment at the top of the script) — never from CI, never with the key
  stored anywhere but your own environment for the duration of the run.
