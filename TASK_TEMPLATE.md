# Current Task

## Goal

Describe the exact outcome in 1–3 sentences.

## Scope

Allowed areas or files:

*
*

## Do Not Change

* Unrelated features.
* Protected product logic unless explicitly required.
* Dependencies unless necessary.
* Existing architecture without a clear reason.

## Known Context

Add only facts directly relevant to this task:

*
*

## Implementation Rules

1. Inspect only the relevant code first.
2. Avoid broad repository-wide exploration unless necessary.
3. Reuse existing patterns before creating new abstractions.
4. Keep the change focused and minimal.
5. Do not repeatedly run unchanged commands.
6. If the same approach fails twice, stop and reassess instead of looping.
7. Report unexpected scope expansion before implementing it.

## Validation Ladder

During implementation:

1. Run the smallest relevant test.
2. Run related tests only when needed.
3. Do not repeatedly run the full suite, lint, or build.

When implementation is believed complete:

1. Run focused tests.
2. Run the full test suite once.
3. Run `npm run lint`.
4. Run `npm run build`.
5. Run `npm run check:encoding`.
6. Run `git diff --check`.

Rerun full validation only if later changes could affect its result.

## Completion Requirements

* Summarize the implementation.
* List files changed.
* Report focused and final validation results.
* State any uncertainty or unverified behaviour.
* Push the branch and open a draft pull request.
* Do not merge.
