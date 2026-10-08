> **SUPERSEDED (2026-10-08)** by `focus-service-on-timeout-and-backend-compat`. The timeout, cancellation and configuration-snapshot behavior delivered under this change is retained as implemented and restated there as the contract. The consumer cache callbacks, business-stage callbacks, checkpoint/resume protocol and joint-acceptance tasks are dropped: the only consumer now owns its judgment state and segmentation. Remaining tasks are not to be executed.

## Why

A consumer can repeatedly submit a service checkpoint whose execution identity is no longer compatible, failing before inference. LLM calls also inherited native-classifier whole-call deadlines. Recovery and timeout semantics must be corrected together, without losing source facts or moving business semantics into the judgment service.

## What Changes

- Keep `version: 1`, `judge()` and `reviewVersion: 1`/`review()` callable. Add `reviewCacheVersion: 1` and `reviewStagesVersion: 1` to advertise the optional consumer-cache and ordered-stage contracts on the existing engine.
- The business consumer owns finite questions, sufficient factual input, stable history boundaries, full-review intent and results/progress in its Pi session JSONL. The service owns actual execution identity, raw-answer validation, capacity subdivision, dispatch, policy rechecks and attempts. No `reviewManaged()` business-history API is introduced.
- Accept synchronous `cache.lookup/store` and `planStages` callbacks. The latter returns strictly increasing source-frame ends for sealed provisional prefixes; the remaining tail, including an empty tail, is final. Capacity recovery can subdivide these ranges but cannot reset admission or a native call's total deadline.
- Compute opaque exact keys only after actual backend/model/transport/thinking selection, redaction and business projection. Revalidate restored answers and apply current native thresholds. Preserve independently validated LLM A/B answers when later C fails, without exposing failed-call final answers.
- **Timeout semantic correction:** explicit caller `timeoutMs`, otherwise the captured service configuration default, bounds setup and becomes one native logical-call deadline or an LLM per-attempt first-response/transport-inactivity window. Raw bytes and provider events reset LLM inactivity. Do not forward this window to provider SDK whole-request timers or add an LLM whole-review countdown.
- Keep originals or withhold unsupported scopes when finite answers cannot carry the necessary facts. No generated fact memory, additional summarizer, hidden reasoning, ambient instructions, tool definitions, raw tool bodies or credentials become historical evidence.
- Verify together with the audit consumer through actual candidate service/Pi adapter boundaries and controlled transport. Exact-repeat hits, sealed-stage reuse and whole-packet representation savings are separate claims; arbitrary free-text retirement is not promised.

## Capabilities

### New Capabilities

- `managed-judgment-reviews`: generic staged execution and exact-result cache ports whose business semantics and durable history remain consumer-owned. The existing capability directory name does not imply a managed business-memory API.

### Modified Capabilities

- `judgment-service`: actual-backend timeout policy, operation snapshots and additive capability discovery while preserving legacy calls.
- `llm-classifier-backend`: activity-based waits, observable finite-member completion, bounded output repair and cancellation for service and emulated-provider entry points.
- `judge-model-settings`: explain the configured default and explicit override under the two backend policies without changing settings or probing inference.

## Impact

Primary seams are the canonical client, existing service/cache/stage engine, LLM backend and observation adapter, tests and README. There is no new dependency, database, business-history store, fallback model or mandatory Pi-core change.

Companion: `pi-jev-todo-audit/openspec/changes/consume-managed-review-service/`. The user's later ownership correction supersedes the earlier service-owned history/compaction proposal; this change and the companion retain their existing names. Completed/predecessor changes and historical session records remain untouched. No commit, publication, installed-copy update, activation, paid inference or archive is included in implementation authorization.
