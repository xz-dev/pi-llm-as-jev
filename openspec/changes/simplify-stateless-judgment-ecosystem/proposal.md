## Why

The plugin's two useful responsibilities—LLM classifier emulation and executing typed judgments—are buried in a stateful review, recovery, caching and accounting engine. Failover waits are also difficult to predict: raw heartbeats extend LLM inactivity indefinitely, while each internal request restarts its window; dependent plugins must migrate with the service rather than discover the removals after an independent update.

## What Changes

- Keep two public responsibilities: the `llm-as-jev` Pi classifier provider and a stateless `judge()` service. Keep model selection/settings, native confidence policy, validation, privacy, cancellation and lightweight capacity metadata.
- **BREAKING**: publish judgment service version 2. Remove `review()` and its capabilities, checkpoints, stage/cache callbacks, service-owned evidence subdivision, result caching/in-flight sharing, persistent judgment/attempt ledgers and capacity learning. Callers own business state and input packing.
- **BREAKING**: replace ambiguous `timeoutMs` with explicit progress-idle and optional per-model-attempt hard limits. Defaults: native classifier **10,000 ms**, LLM **15,000 ms**. Nonempty text, reasoning or tool-argument generation renews idle waiting; heartbeats and empty events do not. Hard limits cover setup, every question and output repair in one model attempt, and are disabled when not configured. Each alternate gets independent timers; there is **no combined operation deadline**.
- Keep at most one sequential cross-backend failover, frozen inputs/settings, complete-result isolation and terminal caller cancellation. Do not introduce hedging, circuit breakers, adaptive timing or a retry framework.
- Adapt `pi-jev-todo-audit` judgment calls, copied client, capacity packing, diagnostics, timeout settings and independent-package provisioning/version checks.
- Adapt `pi-continue-watchdog` unlock review to ordinary `judge()` results. Preserve source/authority checks, stale-result fencing, incomplete-review behavior and the single reconsideration bound; remove transport-observation completeness as an acceptance condition.
- Plan a coordinated three-repository acceptance and activation sequence, including mixed-version behavior and rollback of the matched set. Keep user package sources, pins, credentials, filters and historical session entries intact.

## Capabilities

### New Capabilities

- `judgment-ecosystem-integration`: coordinated client compatibility, audit/watchdog adaptation, cross-repository acceptance, independent package delivery and matched-set activation/recovery.

### Modified Capabilities

- `judgment-service`: stateless version-two contract, explicit waiting semantics, consumer-owned packing and isolated failover.
- `llm-classifier-backend`: generation-progress idle waiting and optional whole-model-attempt limits for both service and direct provider use.
- `judge-model-settings`: explicit backend-slot timeout settings, migration diagnostics and retained independent model selection.
- `backend-capacity-disclosure`: declared metadata only, without learning, persisted calibration or service-side overflow prediction.
- `resumable-judgment-reviews`: remove the entire resumable review capability and migrate its consumers.
- `classifier-attempt-observations`: remove this plugin's transport-observation/partial-result accounting capability; leave Pi-owned transport APIs untouched.

## Impact

- Planning home: this repository only. `design.md` and `tasks.md` contain the coordinated external-repository work; external specs and code are not edited by this proposal workflow.
- Service: `src/service.ts`, backends, provider, config, lifecycle wiring, shared client and generated client artifacts; deletion/contraction of cache, ledger, pipeline, capacity and observation modules; tests, README and `docs/programming-thinking/timeout-semantics.idea.lean` during implementation.
- Audit: `/home/xz/Code/ai/pi-jev-todo-audit`, especially `judgment-client.ts`, `incremental.ts`, `index.ts`, `judgment-service.ts`, configuration/diagnostics and integration fixtures. Existing consumer-owned progress remains.
- Watchdog: `/home/xz/Code/ai/pi-continue-watchdog`, especially `src/judgment-client.ts`, `src/unlock-review.ts`, related `src/runtime.ts` reporting and review tests/specs. Its independent `consume-shared-private-inquiry-runtime` change remains separate.
- Installed copies under `/home/xz/.pi/agent/git/github.com/xz-dev/` are deployment targets, not additional source owners. No install, release, live inference, Git publication or code changes are authorized by this planning workflow.
- No new runtime dependency, Pi core modification or shared framework is planned.

## Apply addendum: source publication and CI

After planning delivery, the human authorized implementation in all three source repositories and required publication with meaningful CI/CD. The execution task list therefore includes CI audit/repair, actual-candidate integration without skipped required tests, failure-propagation negative controls and exact-revision remote release evidence. The human subsequently selected direct commit/push to all three `master` branches, without candidate branches, tags, GitHub Releases or a new versioning mechanism. Local integration/review and exact-head remote CI remain gates. Source publication does not authorize effective installation or activation.
