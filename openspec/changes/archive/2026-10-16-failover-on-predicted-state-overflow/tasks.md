## 1. Alternate readiness

- [x] 1.1 In `judgeInner`, give each non-final route attempt a memoized `alternateReady(): Promise<boolean>` that resolves the next family with `resolveCandidate` under the caller signal and returns `false` on error/throw; forced modes and the last attempt get none. Verify it is never called for requests whose floor fits (no extra native discovery).

## 2. Pre-dispatch skip

- [x] 2.1 In the `runStages` cache-miss gate, compute the irreducible floor for both `judge()` and `review()`; when `overflowConstraint(profile, fixedSize, limits) === "state"`, the envelope is not already rejected, and `alternateReady` resolves `true`, end the attempt with `stopReason: "error"`, `contextOverflow: true` and a predicted-overflow message, without dispatch. Verify cache hits before the gate are still served.
- [x] 2.2 Ensure the skip records no capacity overflow, adds no rejected envelope, writes no ledger rejection and counts no transport attempt or presplit; verify via capacity profile, ledger and review diagnostics.
- [x] 2.3 Keep the existing one admission check when `alternateReady` is absent or `false`, and leave `request`-dimension prediction, learned rejections and subdivision unchanged; verify existing capacity/review regression tests pass unmodified.

## 3. Tests

- [x] 3.1 Add service tests: `auto` with oversized fixed state and a resolvable LLM → zero native dispatches, LLM answers, `backend: "llm"`; `auto-llm` symmetric case using the LLM's declared window; review path with the watchdog-like indivisible `state.fixed`.
- [x] 3.2 Add negative tests: forced `classifier`, `auto` without `model`, `auto` with an unknown LLM model → native request sent once; both-failed summary when the alternate resolves but fails.

## 4. Documentation and verification

- [x] 4.1 Update README capacity section: predicted irreducible state overflow fails over before dispatch only when a usable alternate exists; prior-ratio trade-off.
- [x] 4.2 Run `npm run check` (and `openspec validate failover-on-predicted-state-overflow --strict` if the CLI is available); all pass before marking complete.
