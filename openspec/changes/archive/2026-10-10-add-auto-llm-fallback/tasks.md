## 1. Mode and shared backend-attempt boundary

- [x] 1.1 Extend `JudgmentMode` and configuration validation with `auto-llm`, retaining default `auto`, independent model slots and unknown-key preservation; verify config tests cover load/save, omitted mode, invalid values and no migration writes.
- [x] 1.2 Refactor the common `judge()`/`review()` execution path to admit configuration and validate input once, then execute a requested backend family with attempt-local state; verify existing forced-mode, configuration-refresh and request-validation tests pass without changing public service versions.
- [x] 1.3 Implement fixed route order (`auto`: classifier then LLM; `auto-llm`: LLM then classifier), lazy candidate resolution and one switch after eligible backend failure; verify both routes for first success, missing/unavailable candidates, discovery/authentication failure, runtime failure and both failures, including exact dispatch counts and no unrelated native substitution.
- [x] 1.4 Preserve terminal cancellation, invalid-input and local callback/orchestration errors, plus success for valid negative and all-dropped judgments; verify no alternate dispatch for these cases, forced modes, or direct calls to the LLM-only emulated provider.

## 2. Timeout, cancellation and result isolation

- [x] 2.1 Separate operation cancellation from each attempt's timeout controller and apply fresh alternate windows with caller-over-config-over-backend-default precedence; verify both timeout directions, hung setup, native shared-stage deadlines, healthy/stalled LLM streams, host idle timeout disabled and unchanged forced timeout behavior in focused timeout tests.
- [x] 2.2 Retire failed/timed-out attempts and fence late publication without waiting for uncooperative promises; verify cancellation before/between/during attempts, session navigation, late results and cleanup cannot trigger extra dispatch, publish new judgments/checkpoints or replace the alternate result.
- [x] 2.3 Restart the complete logical request on the alternate with its own capacity, confidence policy, stage state and exact cache/checkpoint identity; verify partial-primary failure, evidence completeness, larger/smaller alternate capacity, alternate cache hits, configuration edits during failover and no cross-backend reuse for both `judge()` and `review()`; verify a deprecated `checkpoint`-seeded review ends with the resubmit-without-checkpoint error instead of dispatching the alternate.
- [x] 2.4 Preserve independent in-flight waiter lifetimes and timeout-compatible joins across routing; verify cancelling or timing out one waiter does not cancel another live caller or make a cancelled caller start its alternate.
- [x] 2.5 Assemble terminal-attempt answers, identity, capacity, progress and unresolved ids while retaining actual review transport observations from both attempts; verify metering/provenance, absence of stale primary errors on success, both-candidate failure summaries, redaction and no raw response-body disclosure.

## 3. Commands and read-only selection views

- [x] 3.1 Add `mode auto-llm` to command parsing, usage text and prefix-aware completion without altering model slots or thinking settings; verify command tests cover persistence, return to `auto`, all four modes, invalid `jev` and failed saves.
- [x] 3.2 Extend status with `Auto-LLM(llm)`, `Auto-LLM(classifier)` and `Auto-LLM(None)` and use the configured order for read-only capacity selection; verify the candidate-availability matrix, forced-mode warnings, fresh snapshots and no inference/settings/cache writes, including status after a non-sticky runtime fallback.

## 4. Documentation and complete verification

- [x] 4.1 Update README modes/examples and compatibility guidance for one-switch runtime failover, fresh timeout windows, unchanged default/forced modes, backend-dependent thresholds and downgrade handling; verify README example tests and check that no text still claims automatic dispatch failures can never fall back.
- [x] 4.2 Update `docs/programming-thinking/timeout-semantics.idea.lean` during implementation to model operation cancellation, attempt-local timeout, fresh alternate windows and bounded backend switching without claiming bounded LLM wall time; verify the exact file by Lean typecheck, deterministic execution and proof-assumption inspection, then perform the required independent semantic round trip under the project's programming-thinking workflow.
- [x] 4.3 Run `npm run check` and `openspec validate add-auto-llm-fallback --strict`; verify all pass, generated client artifacts remain compatible and default, forced, emulated-provider, review-resume, capacity-disclosure and redaction regressions remain covered before marking implementation complete.
