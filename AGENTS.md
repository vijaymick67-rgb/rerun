# RERUN Working Rules

RERUN is a personal-only, mobile-first TV tracker PWA.

## Repository

`vijaymick67-rgb/rerun`

## Permanent Workflow Rules

1. Before every implementation task, confirm the repository identity and inspect git status.
2. Fetch the latest `origin/main`.
3. Never modify, commit, or implement directly on `main`.
4. Start every implementation task from the latest `origin/main` on a fresh, clearly named branch.
5. Do not reuse an old task branch unless explicitly instructed.
6. Stop and report if the working tree contains unrelated uncommitted changes.
7. Keep each task focused. Avoid unrelated refactors.
8. Preserve existing protected product logic unless the task explicitly targets it.
9. Before finishing, run:
   - focused tests;
   - full test suite;
   - `npm run lint`;
   - `npm run build`;
   - `npm run check:encoding`;
   - `git diff --check`.
10. Push the task branch and open a draft pull request.
11. Do not merge any pull request.
12. Report the branch name, final commit SHA, PR number, files changed, validation results, and remaining uncertainty.
13. Every PR must be independently reviewed in ChatGPT before merge.

## Protected Areas

- timezone and IST release logic;
- TVmaze and TMDB air-date handling;
- countdown and next-episode logic;
- watched and season-watch state;
- finished-show visibility;
- tracked-show selection and filtering;
- Watching sort and persistent route behaviour;
- Supabase query and mutation semantics;
- News and Discover logic;
- notifications;
- scroll restoration;
- PWA update and reload ownership.
