## 1. Baseline

- [x] 1.1 Re-run `npm run check` on the current tree and record the result in the change directory; confirm the timeout tests listed in design.md still pass. Verify: saved log with pass/fail counts.
- [x] 1.2 Add a focused test naming the contract per backend: LLM healthy stream longer than `timeoutMs` succeeds; LLM stall fails at the window; native three-stage call shares one deadline; setup hang settles at the admitted duration. Verify: test file passes; no production code change required (if one is, record it).

## 2. Capacity disclosure

- [x] 2.1 Add `describeSelection()` returning backend, model, limits with sources, tokens-per-byte and prior flag from the current config snapshot; no inference, no writes. Verify: unit tests for channel constant, override, model metadata and absent cases; config change reflected on next call.
- [x] 2.2 Include the same disclosure block in judgment/review result diagnostics, with logical input dimensions (state/question/longest-question bytes at backend dispatch; estimates, not HTTP wire bytes) and provider-reported input tokens when present. Verify: result shape test; overflow case reports limits in force.
- [x] 2.3 Sync `client/` types with the new optional fields; existing fields unchanged. Verify: client-sync check passes.

## 3. Deprecation

- [x] 3.1 Mark cache callbacks, `checkpoint`, `planStages`, `projectStage`, `onProgress`, `reviewCacheVersion`/`reviewStagesVersion` and projection revisions as deprecated in types and README; behavior unchanged. Verify: typecheck; existing tests pass unchanged.
- [x] 3.2 Document that the session-branch ledger is internal reuse/metering only. Verify: README section present; no code change.

## 4. Documentation

- [x] 4.1 README timeout table (backend -> interpretation, one caller number, backend defaults: native 60 s / LLM Pi `httpIdleTimeoutMs`, setup bounded). Verify: section present and consistent with spec scenarios.
- [x] 4.2 Label built-in channel constants with their evidence (OpenRouter Jev 1.13 page: 32,000 tokens; TypeSafe direct: unverified) in code comments and README. Verify: grep shows labels; no constant value changed by this task.

## 5. Acceptance

- [x] 5.1 Full `npm run check` green (live gate may stay skipped) after 2.x–4.x. Verify: saved log.
- [x] 5.2 Audit consumer (`incremental-todo-state-judgment` task 5.2) reads the disclosure successfully against this build. Verify: cross-repo integration test or recorded manual check.

## Candidate disposition

See [verification](evidence/verification.md) and the source manifest. `service-check.log` records 355 pass, 1 skip, 0 fail against the unchanged service candidate. `cross-repo.log` records seven offline actual-service/Pi adapter passes, including judge capacity consumption.

Task 2.2 closed with narrowed wording (user accepted the plain-language explanation): `inputDimensions` is a logical input-size estimate at backend dispatch, documented as such; actual HTTP envelope/retry telemetry is out of scope. No task closure is inferred from a smaller test suite, a skipped live gate or scripted model replies.

