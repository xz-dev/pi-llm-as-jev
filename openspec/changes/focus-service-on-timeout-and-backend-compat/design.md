## Context

See proposal.md - Why. Current source facts (verified read-only on 2026-10-08):

- `src/service.ts` `judgeInner`: admits `rawOpts.timeoutMs ?? config.timeoutMs` (default 120000), validates it as a positive integer, arms one deadline timer, bounds readiness/discovery/auth with `bounded`/`guardSelection`, then clears the timer for the LLM backend and keeps `remaining` wall time for the native backend at dispatch.
- `src/backend-llm.ts`: `newInactivityClock` per provider request; `activityFetch` taps response headers and every body chunk; `onProviderStreamEvent` also resets; `timeoutMs` is deliberately not forwarded to `streamSimple`; `guardRace` distinguishes idle timeout from caller abort.
- `src/llm-observations.ts`: composes the caller's fetch/stream observers with its own.
- Saved `npm run check` log (`/var/tmp/jev-service-check-WKE4w3/check.log`): 348 tests, 347 pass, 1 skipped live gate; includes inactivity reset per question/chunk, silent stall, hung discovery, configured default, and non-joining of different inactivity windows. `src/service.ts` hash matches the one recorded with that run; other files were not re-hashed.
- `contextLimits()` returns configured overrides, then built-in channel constants for Jev (TypeSafe direct: request 64000 / state+longest 32000; OpenRouter: 32000 / 32000), else `model.contextWindow`, else undefined. OpenRouter's Jev 1.13 page states a 32,000-token context window; the TypeSafe direct figure is not confirmed from documentation read so far.
- Consumer-facing cache/stage/checkpoint protocol (`reviewCacheVersion`, `reviewStagesVersion`, `planStages`, `projectStage`, `onProgress`, projection revisions) exists and is used only by the current audit implementation that is being replaced.

## Goals / Non-Goals

**Goals:**
- Freeze the timeout contract as specified; no re-implementation.
- Add capacity disclosure (query + result diagnostics).
- Deprecate consumer cache/stage/checkpoint protocol without breaking current callers.
- Keep backend switching/compatibility behavior as is.

**Non-Goals:**
- Business memory, consumer progress, summaries or any LLM-only feature.
- A single-value configured default. The user decided: native default 60 s, LLM default follows Pi's `httpIdleTimeoutMs`; an explicit `timeoutMs` override still applies to both backends.
- Verifying provider limits by paid probes; constants stay labeled by source.
- Repairing audit-side timing-flaky tests.

## Decisions

### D1. Disclosure as a read-only query plus result field

Add `describeSelection()` (name indicative) returning `{ backend, model, limits?: { request?, stateAndLongestQuestion?, contextWindow? }, limitSource, tokensPerByte, prior: boolean }` from the current configuration snapshot without inference, and include the same block in every result's diagnostics. Alternative: have the consumer read `model.contextWindow` from Pi's registry (rejected: misses channel constants, overrides and learned ratio, and the native model object is service-internal).

### D2. Deprecation, not removal

Leave the cache/stage/checkpoint code paths in place and document them as deprecated; add no new tests for them. Removal is a later change after the audit's `incremental-todo-state-judgment` lands and no caller passes those options. Alternative: remove now (rejected: breaks the dirty audit tree before its replacement exists).

### D3. Limit-source labeling

Each limit carries its source (`override`, `channel`, `model`). Channel constants are documented with the evidence available (OpenRouter page: 32k; TypeSafe direct: unverified) so a later correction is a constant change, not a contract change.

### D4. Timeout documentation

README gains one table: backend -> interpretation (LLM: per-request inactivity; native: whole-call deadline; setup: bounded by the same number) and the note that the consumer passes one number.

## Risks / Trade-offs

- Disclosed limits may be wrong where constants are unverified; the consumer treats them as declared, not proven, and recalibrates from reported usage.
- Keeping deprecated paths keeps code size; acceptable until the audit migration lands.
- Only `service.ts` was hash-matched to the saved test run; the proposal relies on current source reading for the other files. Task 1.1 re-runs the full check before any change.
