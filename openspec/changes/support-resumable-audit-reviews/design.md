## Context

See proposal.md and `specs/resumable-judgment-reviews/spec.md`. The existing `runStages` engine already owns subdivision and raw cache keys, but flushes judgments at whole-call settlement, has no stage receipts, validates result batches atomically and records zero-filled aggregate diagnostics. Audit's old `reviewRolling` also projects retained facts and dynamic candidate sets at each stage; merely passing its entire serialized context as fixed state would prevent meaningful evidence recovery.

## Goals / Non-Goals

**Goals:** extend the existing engine once; make checkpoint durability and attempt provenance explicit; keep consumer business projection separate from transport/recovery.

**Non-Goals:** a second general workflow engine, direct HTTP transport, mutable external resume blobs, model-generated factual summaries, legacy audit configuration import, or relaxing final-only `judge` safety.

## Decisions

### D1. Add a capability, do not reinterpret version one

Keep `JudgmentService.version: 1`; add `reviewVersion?: 1` and `review?(request, options): Promise<ReviewResult>`. `ReviewResult` contains the ordinary final `JudgeResult` fields plus `progress` and `diagnostics`. Only `review` enables early durable-stage commits and partial native member reuse. `judge` uses the same engine with those options disabled and retains all existing abort/empty-result tests. Export from the canonical `client/judgment-client.ts`; regenerate its JS/declarations using the existing build.

### D2. Stage projection is business data, not a recovery hook

`ReviewRequest` carries fixed JSON state, ordered evidence and typed questions. `ReviewOptions` extends `JudgeOptions` with an optional synchronous `projectStage` callback, invoked with a read-only descriptor: current genuine evidence frames, completed source bounds, latest prior opinions and finality. It returns only fixed JSON state and complete questions for that stage. It cannot request transport, choose batches/models, manufacture fragment bounds or advance progress. Include a required caller projection revision and the exact returned state/questions in identity; catch exceptions as structured projection failure. Always pass the service-selected evidence frames separately in the actual model envelope, so a callback cannot replace or omit the evidence being traversed. Audit builds dynamic question candidates and retained source-backed facts through this seam, without reimplementing split/retry loops.

A projection may withhold an over-limit required question locally. It must declare its unresolved ids rather than shrink the required set silently; that scope remains incomplete and no completed full-range receipt is produced. Valid independent questions still remain reusable.

### D3. Service receipts are the trust boundary for resumption

A stage checkpoint has a version, opaque digest id, request/projection identity, frozen backend/model/transport/thinking identity, ordered source ids and genuine bounds, question-key references, raw latest opinions, finality and hashed fresh membership. It is stored after its referenced raw answers are durable. `onProgress` receives only acknowledged durable checkpoints. Results distinguish volatile completion from durable progress when append fails; audit does not advance on volatile progress.

The service accepts a prior checkpoint id as advisory seed only if it exists on the active branch, has valid answer references and matches the declared scope/projection revision and selected identity. A changed fixed factual state produces new evaluation keys; the seed remains labelled historical advice, not a cache hit for changed facts. The caller cannot supply a checkpoint's trusted raw internals. A full review supplies no incremental seed and uses a fresh token. Token membership persists as a digest.

On identical failed-review resumption, reconstruct the ordered traversal from current evidence and active-branch checkpoints; completed stages/partial questions hit exact identities without dispatch. On incremental audit review, audit's durable receipt identifies the processed frontier and service checkpoint; only new projected evidence is passed, with still-required facts explicitly retained in fixed state. Compaction can retain a verifiable frontier and seed; missing factual sources remain audit gaps, not invented text.

Per-question records survive partial batch failure, but only all-required valid raw answers advance a stage. Question batches share frozen prior opinions; their results merge only inside that stage. Later evidence replaces the prior view. Mid-record checkpoints retain genuine bounds; a whole-source cursor advances only at its last fragment. Stage observations do not establish factual completeness.

### D4. Honest attempt accounting across the adapter boundary

The native backend requests Pi observations and forwards start/end events into a request-owned collector before any deadline race. Pi's existing retry closure remains transport owner. Only adapter events establish actual transport counts; `reuse.sent` retains its question-level meaning. If the selected adapter does not acknowledge observation version one, review returns a capability failure, with observation coverage marked unavailable, not zero. Do not fall back to another backend after dispatch.

For LLM review, use Pi's supported `maxRetries: 0`, injected `fetch` seam and `onProviderStreamEvent` where supported to observe actual HTTP starts/settlements and provider token/charge presence; force supported HTTP/SSE transport for this observable review path. Existing configured thinking stays frozen. An adapter ignoring these observation seams is unsupported for honest review accounting, not silently counted as one call. Legacy `judge` is not restricted. This uses the Pi transport option, not an alternate HTTP client. Authentication remains Pi-owned. No new chat-adapter patch is assumed; an unsupported required route is surfaced as a capability error.

Assign each actual attempt an operation id plus ordinal. Return only newly owned attempts; joined callers retain reuse references without charging the owner again. A started but unfinished attempt remains explicit at deadline. Late terminal events cannot mutate a settled result or write into another branch. Persist starts and terminal updates keyed by attempt id while the captured generation is live; fold by id during restoration to avoid double counts. Totals have known sum and missing count for each token/charge field, plus a separate catalog-estimate field. Keep legacy aggregate usage for compatibility, but never use it to manufacture presence-aware review fields.

### D5. Port predecessor capacity semantics, not just its estimator name

Extend service-owned limits to `{ request?, stateAndLongestQuestion? }` with the model's single context window as generic fallback. Put trusted per-model overrides in shared-service configuration; retain verified TypeSafe-direct and OpenRouter System One profiles without applying them to unrelated custom endpoints. Include actual base URL/API/configuration in channel/cache identity (hash it for persistence; never log URL credentials). Apply limits to the serialized stage wrapper, including previous opinions and metadata, rather than only raw evidence text.

Port the audit predecessor's fixed-state admission correction and dimension-sensitive subdivision into the common engine. Required retained facts are fixed; only new service-owned frames and independent questions are divisible. An overestimated fixed state gets one complete unanswered-batch admission, not a Cartesian walk. Capacity observations use reported input presence, later successes replace density estimates and can remove contradicted size hints. Exact rejection digests remain separate. Only typed/recognized context overflow authorizes recovery; preserve missing/partial questions without replaying validated members.

### D6. One generation and deadline

Reuse the existing generation-owned in-flight cache and whole-call deadline guards. New projection, receipt writes, callbacks and attempt collection check the captured generation. Do not await notification callbacks; catch synchronous throws and rejected returned promises. No new answers/checkpoints after abort, except checkpoints already committed by `review` before that abort. Legacy `judge` buffers until its old settlement boundary. A joined waiter's cancellation does not cancel its owner. All started promises stay rejection-handled, including synchronous elapsed fast paths.

## Contract transfer and acceptance map

| Old guarantee | Owner after migration | Failing example / gate |
| --- | --- | --- |
| Valid A/B retained when C missing | Pi partial observation + service raw cache | repeat sends only C |
| Stage 1/2 survive stage 3 failure | service checkpoint + audit frontier receipt | reload dispatches only unresolved stage 3 |
| Required factual history survives opinions | audit stage projection | different earlier user decisions remain distinguishable |
| Two capacity dimensions and corrected estimates | service channel profile | direct 64k/32k vs OpenRouter 32k; 69 records/12 questions one admitted batch |
| Every real retry accounted | Pi start/end observer + service diagnostics | 503→200 yields two attempts; cache yields none |
| Missing usage is unknown | service presence-aware totals + audit display | one missing output yields known lower bound and missing count |
| Numeric native gates only | service policy | cached native threshold changes; LLM choices ignore thresholds |
| No child audits / no stale advice | audit ownership and freshness | suppressed owner and switched branch produce no inference/advice |

## Risks / Trade-offs

- Stage callback adds API surface → restrict it to synchronous JSON projection and complete identity; never expose dispatch controls.
- Review and legacy abort contracts differ → explicit method boundary and paired regressions; never globally relax `judge`.
- Old receipt/cache identity lacks backend lineage → leave old entries untouched; new-version identity cannot treat them as verified new judgments.
- LLM/provider observation support varies → capability failure with no fake counts; test the supported Pi native and LLM paths offline.
- Durable writes are not transactional → write answers first, then checkpoint; dangling answers are safe, dangling checkpoints are rejected.

## Migration Plan

Implement and verify the Pi prerequisite first. Add service client/types and failing contract cases, then persistence/partial recovery, then capacity and attempt adapters. Keep the audit development checkout unchanged until the service contract is validated. The integration harness resolves all three development sources through explicit task-scoped paths and a fake provider; no absolute local dependency enters the published package manifest. Existing installed consumers keep version-one behavior. Deployment, live acceptance and publication need separate authorization.
