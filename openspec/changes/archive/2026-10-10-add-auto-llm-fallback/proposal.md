## Why

The service currently offers only classifier-first automatic selection, and a selected backend's runtime failure ends the operation even when the other backend could answer. Users need an LLM-first automatic mode and symmetric, bounded failover without losing forced-backend modes or changing the default.

## What Changes

- Add `auto-llm`: prefer the independently configured LLM, then use the selected/default native classifier when the LLM is missing, unavailable or fails.
- Keep `auto` as the default and classifier-first: use the configured LLM when the selected/default native classifier is missing, unavailable or fails.
- **BREAKING**: automatic modes may now switch backend after dispatch failure, including timeout. The alternate receives a fresh backend-specific timeout window; `timeoutMs` is not a combined automatic-operation wall-clock limit.
- Permit at most one backend switch per operation. Preserve existing per-backend recovery; do not introduce a general retry router or change forced `llm`/`classifier` behavior.
- Keep caller cancellation, session navigation and invalid requests terminal. Valid negative answers and confidence-filtered results are not backend failures.
- Keep configuration frozen for the operation and execution/cache identity frozen per backend attempt. Restart the full logical request on failover without combining answers or checkpoints across backends.
- Extend configuration validation, command help/completion and read-only status for `auto-llm`. Preserve explicit native selection, default Jev discovery, independent model slots and the LLM-only emulated provider.

## Capabilities

### New Capabilities

None; this extends the existing judgment service and settings capabilities.

### Modified Capabilities

- `judgment-service`: ordered automatic backend selection, failure/timeout failover, cancellation boundaries, per-attempt identity and result diagnostics for `judge()` and `review()`.
- `judge-model-settings`: accept and display `auto-llm`, while retaining default `auto`, forced-mode behavior and existing settings semantics.

## Impact

- Runtime: `src/service.ts` selection, timeout admission, attempt lifecycle, recovery/cache/ledger boundaries and final result assembly; preserve existing adapter behavior in `src/backend-jev.ts` and `src/backend-llm.ts`.
- User entry points: `src/config.ts`, `src/index.ts`, `src/ui.ts`; public service signatures and backend values remain unchanged.
- Verification: service, timeout, config, command, status, capacity-disclosure and review regression tests; retain forced-mode and emulated-provider coverage.
- Documentation: README and, during implementation, `docs/programming-thinking/timeout-semantics.idea.lean` must reflect automatic-mode timeout behavior. Existing main specs are not edited during proposal creation.
- Compatibility: existing `auto` configurations gain runtime failover and may incur extra latency or charges. Numeric threshold behavior follows the actual answering backend. No new dependency, model slot, credential resolver or automatic configuration migration is required.
