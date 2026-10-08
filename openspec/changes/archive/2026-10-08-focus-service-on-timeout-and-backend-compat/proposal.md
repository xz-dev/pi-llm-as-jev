## Why

The only consumer (pi-jev-todo-audit) is moving to its own persisted judgment state and complete-loop segmentation, so the service's consumer-cache, business-stage callbacks and checkpoint/resume protocol no longer have a user. The service should narrow to what only it can do: one caller-supplied timeout interpreted per backend, switching and compatibility between the native Jev classifier and LLM emulation, and reporting the selected backend's capacity so the consumer can pack its own segments.

## What Changes

- Confirm and keep as the contract (already implemented, verified against current source and the saved `npm run check` log of 348 tests / 347 pass / 1 skipped live gate): caller `timeoutMs` or configured default is the one admitted duration; setup/discovery/auth are bounded by it; the LLM backend interprets it as per-request transport-inactivity reset by raw bytes and provider events and never forwards it as an SDK whole-request timeout; the native backend keeps one absolute logical-call deadline across internal stages; caller abort, deadline-expired fencing and no-late-publication hold.
- Expose the selected backend/model and its capacity limits (request-wide and state-plus-longest-question, in tokens, plus the bytes-to-tokens prior/learned ratio) in the result diagnostics and through a read-only `capabilities`/`describeSelection` style query, so a consumer can pack input before sending. Limits come from configured overrides, model metadata or built-in channel constants; absence is reported, not guessed.
- Keep backend switching and compatibility: auto/classifier/llm modes, explicit model references, native failure is not fallback permission, thinking-level pass-through for LLM only, emulated classifier registered as a Pi classifier provider, structured-output enforcement and repair.
- Keep stateless overflow handling: predict from limits/learned rejections, split independent questions, report irreducible overflow. Ordered-evidence fragmentation stays available for callers that still pass evidence, but is no longer the recommended path.
- **Deprecate** (keep callable for existing `version:1`/`reviewVersion:1` clients, mark for removal after the audit migration): consumer cache lookup/store callbacks, `planStages`/`projectStage`/`onProgress` business stages, service checkpoints and resume receipts, review-cache namespaces and projection revisions, the session-branch ledger as consumer progress memory (it remains an internal diagnostics/metering record only).
- Supersedes `manage-review-context-and-runtime` (in-progress, 10/29). Its timeout, cancellation and configuration-snapshot work is retained as implemented; its cache/stage-protocol tasks are dropped.

## Capabilities

### New Capabilities

- `backend-capacity-disclosure`: read-only reporting of the selected backend/model identity and its capacity limits and calibration, before and after a judgment.

### Modified Capabilities

- `judgment-service`: `Never throws` (timeout scenarios split into LLM inactivity vs native logical deadline and bounded setup), `Exact-match caching` (service-internal only; consumer callbacks deprecated), `Ordered evidence recovery` (optional, not required for consumers), `Session-branch ledger` (diagnostics/metering only, not consumer progress memory).
- `llm-classifier-backend`: timing paragraph of `Registered as a Pi classifier provider` made explicit: per-request inactivity window, raw activity sources, no SDK forwarding.

## Impact

- `src/service.ts`: add capacity disclosure; mark cache/stage/checkpoint option paths deprecated; no behavior change for current callers.
- `src/backend-llm.ts`, `src/llm-observations.ts`: no change; documented as the contract.
- `src/capacity.ts`: expose limits/ratio through the result shape.
- `client/` sync: new optional fields; existing fields untouched.
- Docs: README/timeout section reflects backend-specific interpretation and the 120s default; note that the audit currently passes 30s.
- Historical open test evidence (audit-side backoff ratio and J11 full-suite failures) is unrelated to this scope and stays recorded in the audit repository.
