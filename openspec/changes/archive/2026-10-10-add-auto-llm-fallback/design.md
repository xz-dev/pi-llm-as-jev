## Context

See `proposal.md` for motivation and the two delta specs for observable behavior. The user confirmed that default mode remains `auto` and timeout is an eligible automatic-failover cause, with a fresh window for the alternate.

Current selection in `src/service.ts` resolves one backend before execution. `judgeInner()` captures configuration, validates input, establishes cancellation/deadline handling, selects a model and runs the existing recovery pipeline. Both `judge()` and `review()` use it. Native execution uses one absolute deadline; LLM execution changes from bounded setup to transport inactivity. `test/service.test.ts` explicitly asserts that native dispatch failure never calls the LLM, and timeout tests assume timeout ends the operation.

Cache, in-flight joining, capacity calibration, review checkpoints and ledger records are keyed by actual backend/model/thinking identity. Review also holds mutable attempt, progress and unresolved-question state. Re-entering the public service recursively would reread configuration and inherit or duplicate these lifecycles. `src/provider.ts` exposes a separate LLM-only emulated classifier; it does not use the service's automatic routing.

This requires a design because timeout and cancellation ownership cross selection, execution, caching and review diagnostics. The existing `docs/programming-thinking/timeout-semantics.idea.lean` models the old timeout slice; updating it belongs to implementation, not this planning-only change creation.

## Goals / Non-Goals

**Goals:**
- Separate operation lifetime from backend-attempt lifetime at the existing shared service boundary.
- Preserve existing recovery, confidence, identity, redaction and consumer API contracts while adding one ordered alternate.
- Make missing candidates, dispatch errors and timeouts settle predictably in both automatic directions.

**Non-Goals:**
- No new routing framework, configurable backend list, circuit breaker, sticky failover, parallel racing or background health checks.
- No new provider, credential resolver, model slot or dependency.
- No change to forced-backend modes, the emulated provider's LLM-only execution, native discovery preference, or confidence policy.
- No new public timeout option, service-version bump or history UI. Existing result/error and review observation fields carry the behavior.

## Decisions

### 1. One ordered route in the shared service, not recursive public calls

Use a fixed order derived from the operation's configuration snapshot:

| Mode | Backend order |
| --- | --- |
| `auto` | classifier, llm |
| `auto-llm` | llm, classifier |
| `classifier` | classifier |
| `llm` | llm |

Keep validation and configuration admission outside backend-attempt execution. Isolate the existing single-backend path enough to admit an explicitly requested backend family with attempt-local state. Resolve candidates lazily in route order, so a successful LLM-first call does not wait for unused native discovery. Use the same ordering for read-only selected-capacity queries, without dispatch.

Respect explicit native references exactly; unset native selection retains default Jev discovery. Missing credentials or unknown models make a candidate unusable. Resolve availability/authentication through Pi, never by inspecting independent environment credentials. Shared setup must not require the failed or unused provider to succeed before the alternate can proceed.

**Alternative rejected:** wrapping public `judge()` calls or recursively changing mode. That rereads mutable settings, duplicates operation admission and can leak primary cancellation into fallback. A general router is unnecessary for two fixed candidates.

### 2. Fail over only after a backend outcome, never after valid business judgment

Within each family keep existing question splitting, evidence recovery, LLM repair and adapter retry semantics. When that family cannot finish, an automatic operation can advance once. Setup failures and timeouts are eligible even when no provider request was sent.

Validate malformed requests and caller policies once, before inference. Treat caller/session cancellation as terminal. Treat `stop` as success even for `false` or all-dropped judgments. Do not indiscriminately reinterpret every thrown exception as provider failure: local validation/callback-contract or orchestration faults must retain their terminal structured errors rather than silently rerunning caller code against another backend. Preserve failure origin internally where a generic error result would otherwise lose that distinction; no public error taxonomy is required.

**Alternative rejected:** fallback on any empty answer map or any `stopReason: error` without origin. Empty maps can be legitimate confidence-filtered success, and switching providers does not fix invalid input.

### 3. Operation cancellation survives; timeout cancellation does not

Maintain one operation signal representing caller cancellation and session navigation. For each backend attempt derive a fresh controller and timer from that operation signal. On timeout, retire only that attempt and cancel its in-flight transport; check operation cancellation again before admitting the alternate. Do not pass an already-expired attempt signal to the alternate, and do not await an uncooperative provider's eventual settlement before proceeding.

| Phase | Explicit caller/configured duration | No explicit duration |
| --- | --- | --- |
| Candidate setup | Fresh absolute setup bound | 60000 ms |
| Native execution | Remaining time from this attempt's admission | Remaining time from 60000 ms |
| LLM execution | Per-request inactivity window | Host `httpIdleTimeoutMs`, including disabled `0` |
| Alternate | Fresh setup and backend-specific execution window | Alternate's own defaults |

Native setup and execution share one deadline; LLM execution replaces its setup deadline with per-request inactivity as today. Existing timer-range validation remains. Automatic routing has no new overall wall-clock deadline. A healthy LLM stream can outlast any fixed multiple of the configured inactivity number; caller abort remains the way to stop the entire operation.

Retiring an attempt must close publication gates, timers and listeners, including on cache joins and late stream callbacks. Late backend results must not publish judgments, checkpoints or alter the alternate result. Observable transport work can still be reported under the existing observation lifecycle without becoming a judgment.

**Alternative rejected:** one shared absolute deadline. A preferred-backend timeout would leave zero budget for the user-requested failover. Resetting native timers for every internal stage would weaken the existing native timeout contract.

### 4. Restart the logical request, isolate attempt state and reuse only matching identities

Keep one validated original request and immutable settings snapshot. Each backend attempt starts from that logical request, with its own redacted execution view, selected model, effective thinking level, capacity profile, stage state, input measurements and result buffers. Prepare/redact known keys before each dispatch, including the provider selected for that attempt. Do not feed primary answers, reduced evidence suffixes or primary checkpoints into the alternate.

Existing validated cache/ledger entries need not be globally cleared or retroactively deleted. They remain reusable only under their original exact identity. Retired or aborted work cannot publish late entries. The alternate can reuse its own compatible cached judgments and checkpoints; it cannot inherit the primary's. In-flight joins retain their timeout compatibility and independent waiter cancellation. Cancelling one waiter must not terminate another live owner/waiter or make the cancelled waiter start its alternate.

Review transport facts span the operation, but semantic progress, unresolved ids, capacity and returned answers belong to the terminal attempt. Keep operation-level observation identity/ordinals coherent across failover and retain both backends' actual metered attempts, without inventing observation support or attaching first-backend capacity measurements to the second backend. Already emitted progress callbacks cannot be retracted; they remain attempt progress, not a guarantee of final mixed-backend answers. No new consumer callback API is introduced.

The deprecated `checkpoint` seed is an exception. Its record stores answer references and source ids, not the original evidence, and it is bound to one backend/model/thinking lineage. A seeded request may carry only the new evidence, so the alternate cannot rebuild the full input, and reusing the seed would cross identities. No current consumer passes `checkpoint` (the only live caller, `pi-continue-watchdog`, calls `review(request, { signal })`), and the README already marks it for removal. A seeded review therefore does not fail over: when the preferred attempt fails, the operation ends with an error asking for a full resubmission without `checkpoint`. Removing the deprecated options is a separate change.

**Alternative rejected:** retry only unresolved questions on the alternate. That would mix models and numeric policies in a result claiming one backend and could skip evidence required for a complete judgment. Clearing the entire branch cache would discard unrelated valid work.

### 5. Report actual results; use existing diagnostics and read-only views

On success, return only the successful attempt's answer/result fields and no terminal primary error. On terminal failure, use the terminal resolved backend/model when available; include a bounded redacted summary of both candidate outcomes in `errorMessage`, identifying unavailable candidates even when no model resolved. Do not copy raw provider bodies into combined errors. Detailed actual review attempts remain in the existing diagnostics contract.

`describeSelection()` and status describe the first registry-usable candidate in configured order, not a prediction that inference will succeed and not the last operation's fallback. `availability()` remains the independent two-slot inventory. Actual result capacity remains consistent with the actual terminal backend, so existing capacity-disclosure requirements still apply without a new capability or result shape.

Use `Auto-LLM(llm)`, `Auto-LLM(classifier)` and `Auto-LLM(None)` to distinguish the new configured preference from existing `Auto(...)`. Both automatic modes warn only if neither candidate is usable. The LLM-only emulated provider remains excluded from native selection and unchanged by service mode.

**Alternative rejected:** persisting the successful alternate or adding a new route-history API. Neither is needed; sticky selection would silently change the next operation's configured priority.

## Risks / Trade-offs

- Longer waits and extra provider charges -> document per-attempt windows and the one-switch limit; retain actual review metering from both attempts. The limit is on backend admissions, not total HTTP requests.
- Default `auto` changes behavior after runtime failures -> mark as a compatibility change; preserve forced modes for callers/users requiring one backend family.
- Classifier-to-LLM failover changes threshold treatment -> preserve actual-backend metadata and the existing policy; never synthesize calibrated confidence for LLM output.
- A smaller alternate may not fit input packed for the preferred backend -> recompute capacity and use existing lossless recovery; report an error rather than truncate or recycle to the first backend.
- Late primary work or mutable review buffers contaminates fallback -> fresh attempt lifetime/state, publication fencing, identity-specific reuse and adversarial timeout/cancellation tests.
- Diagnostics contain misleading mixed-channel totals -> retain attempt-local provenance and meter all observable work, while using terminal-attempt capacity/progress fields; verify both `judge()` and `review()`.
- Existing full-request native deadline proof no longer describes automatic operations -> update and verify the timeout Lean model during implementation; do not claim the unchanged model proves failover.

## Migration Plan

1. Implement and test the shared attempt boundary and both routing orders, then expose the new accepted mode in configuration and commands. Ship together so persisted `auto-llm` is never advertised before routing supports it.
2. Keep `DEFAULT_MODE` as `auto`; do not rewrite user configuration, session ledgers or historical cache identities. Update README examples and compatibility guidance, plus the timeout process model.
3. Validate the change specs, run project checks and verify the affected Lean model. Test default/forced modes and the emulated provider as regressions, alongside both automatic routes.
4. To opt out of runtime failover, explicitly select `llm` or `classifier`. Before rolling back to a version that does not accept `auto-llm`, change that saved mode to a supported value; otherwise the older parser rejects the known field and falls back to all defaults. No automatic rollback rewrite is added.
