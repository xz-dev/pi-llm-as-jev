## Context and authority

Companion: `pi-jev-todo-audit/openspec/changes/consume-managed-review-service/`. Both changes are one acceptance unit. Baselines are service `d34cd611c7c7e0404a39e8d87bebac02b41caad9` and audit `6aa88097a1faa082943f01c1d801e2850b2726a7`.

A historical incident had 29 zero-attempt checkpoint failures, including eight terminal stops, after an execution-channel change. Offline replay accepted the checkpoint with its original transport and rejected it with changed transport. The exact changed identity field is unknown. A separate approximately 29.8-second LLM incident had six starts and five HTTP 200s but no durable business success or preserved terminal error. Its timing is consistent with the old shared countdown, not conclusive proof of that incident's final cause. Neither history authorizes paid probes or copying private transcripts.

The user's later correction controls this design: **business plugins own finite factual obligations, the history-splitting function and prior results/progress in session JSONL; Jev owns generic judgment execution and backend-specific timeout interpretation.** The earlier `reviewManaged`, service-owned business history, mandatory service compactor and removal of audit's timeout override are superseded. Keep the change/capability directory names, not those obsolete responsibilities.

## Goals and boundaries

- Recover old sessions without repeatedly submitting an incompatible service seed.
- Reuse identical finite judgments after a new service instance starts; retain useful A/B when C fails.
- Permit business-directed stable large blocks and immediately process partial tails.
- Preserve source facts, roles, bounds and authority; reduce measured outbound cost where the business representation permits it.
- Let healthy LLM transport outlast its inactivity duration while bounding real stalls, setup, cancellation and native whole calls.
- Preserve scheduling, independent package delivery and legacy callers.

Not in scope: a service business-memory database/API, model-generated fact memory, extra summarizer, generic lossless semantic retirement of arbitrary text, paid-model accuracy claims, provider-prefix-cache billing guarantees, hidden retries/model switches, watchdog changes, deployment or archive.

## D1. Canonical additive contracts

Retain `version: 1`, `judge`, `reviewVersion: 1` and `review`. Advertise `reviewCacheVersion: 1` and `reviewStagesVersion: 1` on the same service. New audit requires both markers; old consumers need neither. Discovery/status must not infer.

| Surface | Contract |
| --- | --- |
| `ReviewOptions.cache.lookup(key)` | Synchronous raw value or miss; key is supplied by the service, not guessed from configuration/question ids |
| `cache.store(key, answer)` | Synchronous acknowledged persistence; `true` is durability, not merely a valid result |
| `ReviewOptions.planStages(frames)` | Synchronous strictly increasing exclusive frame ends for sealed provisional prefixes; no omitted/reordered sources |
| `projectStage` | Consumer's deterministic factual/question projection over current/completed frames, prior opinions and finality |
| `projectionRevision` | Required for either projection/planning callback; versions the business interpretation |
| `progress.stages[].cache` | Opaque required keys and consumer-cache acknowledgement, separate from legacy service-checkpoint durability |
| `timeoutMs` / `signal` | One duration with actual-backend interpretation, plus external cancellation |

The callbacks are local business contracts, not a new model-facing protocol or consumer-selected timeout mode. The consumer remains responsible for historical sufficiency and source/authority checks. `projectStage` cannot silently omit a required question; absent scopes must be explicitly unresolved. The existing 255-choice boundary remains.

## D2. Exact identity and independently durable members

The service selects the actual backend/model/transport, effective thinking and operation configuration before computing reusable keys. Identity includes the complete question/rules, projection revision, effective fixed state, ordered evidence with roles/content/genuine UTF-16 bounds, genuine prior opinions and finality. Consumer full-intent tokens are incorporated opaquely. Current native thresholds are policy, not raw-answer identity; reapply them on restored values. Identical sibling judgments can survive unrelated question additions when their effective input is unchanged.

Validate consumer raw values against each current question, copy finite answer fields and treat malformed/foreign values as misses. Acknowledged values can survive service-ledger loss. The service may still maintain its existing generic cache/legacy ledger; it is not the business history's source of truth.

For review, an independently parsed, observed LLM member can be persisted before the next question begins. A/B durability does not complete a stage or authorize failed-call answers if C fails. Legacy `judge` retains its no-new-partials-on-abort behavior. Cache lookup/store, callbacks, in-flight joins and late results remain generation/abort fenced.

## D3. One execution for a finite business plan

```text
admit config + identity + setup budget
  -> validate/snapshot business boundaries
  -> sealed prefix (provisional) -> ... -> tail (final)
       | cache hit or capacity subdivision       |
       +---------- same execution identity -----+
  -> accepted final answers or explicit failure/incompleteness
```

A returned boundary seals an original-source prefix; subsequent appends do not move it under the same business rule. The tail is always processed, even when shorter than a target or empty after the last sealed boundary. Engine subdivisions remain provisional until their parent/final tail is actually complete. Neither a per-frame split nor an engine-final leaf is permission to deliver incomplete business advice.

Native execution has one absolute deadline across setup, all business stages and capacity recovery. The plan does not call `review` recursively or reset that deadline. Overflow retains genuine fragment bounds, reduces the constrained unresolved dimension and does not resend an identical known-rejected envelope. Irreducible fixed factual input is an honest failure/unresolved boundary, not a license to crop it.

## D4. Factual responsibility and the demonstrated optimization

The audit consumer's current declared representation is deliberately conservative:

- Stable approximately 32 KiB source blocks are selected only for sufficiently large macro-tool histories, without padding or waiting for a full tail.
- Completed macro records can use a `columns/1` representation that removes repeated field names. Every value, original text, role, source id, call relation, status and chronological position remains available. Unknown/non-scalar shapes and fragments stay explicit.
- Original records remain local for source eligibility and final authority validation. User/assistant free text is retained, not inferred from a cached status label. Authored task accounts remain reported data, not proof of semantic coverage.
- A cache hit prevents re-dispatch of the identical sealed stage. A changed final tail is a new judgment, and necessary old facts can still appear in its compact input.

These are **representation savings and exact stage reuse**, not arbitrary historical text retirement or a bounded-size summary. The service neither implements TODO column encoding nor chooses its business block target. A different consumer supplies its own explicit facts/planning law through the same generic ports.

J06 measures the complete outbound packet, not just evidence arrays. The current controlled TODO macro case reduced 124703 to 90921 bytes and reused nine sealed-stage judgments. Its final packet is independently decoded and compared field-for-field and in order with permitted original history, including error/cancelled events. XML/CSV and later withdrawal controls distinguish factual/authority changes. These results do not establish semantic-model accuracy or useful compression of every free-text workload.

The free-text floor can still grow past backend capacity. Original report bodies must then remain or the scope must be withheld. The representative long-report/irreducible workload and the user's required operating scale remain an explicit acceptance gate; do not check them off from the macro fixture. If that floor blocks the intended workload, present the concrete limit for a user decision rather than weakening source obligations or inventing a summarizer.

## D5. Consumer recovery and full intent

New audit reconstructs the permitted active history and supplies its own JSONL cache. It does not submit a legacy `serviceCheckpoint`. A valid old receipt remains readable historical data, but its digest/cursor is not sufficient factual state. Changed execution/question/facts produce misses after actual selection; compatible members are reused in the same admitted operation. There is no invalid-seed repair loop, implicit model fallback, transcript deletion or automatic paid rebuild loop.

Persist finite answers before consumer progress. A receipt references acknowledged keys and valid active-branch source coverage. Incomplete fragments cannot establish complete-source coverage. Failed persistence and stale ownership cannot produce business progress/advice. Generic service validity and durability remain separate; audit's stricter delivery rule suppresses final advice when its required persistence fails.

Explicit full-review intent belongs to the consumer, including its unfinished retry identity and eventual new-intent allocation. The service honors the supplied opaque fresh identity, not a service-owned business operation. Reload/partial full-intent resumption must be verified separately (J09); ordinary cache reload does not prove it.

## D6. Backend-specific timing under one timeoutMs

| Phase / path | Policy |
| --- | --- |
| Discovery and selected-provider authentication | Bounded by the admitted duration, including uncooperative asynchronous adapters |
| Native classifier | One logical-call total deadline, including business stages, subdivisions and waits |
| Actual LLM request | Fresh per-attempt first-response/inactivity window; raw bytes and provider events reset it |
| LLM questions, stages and one malformed-output repair | No shared elapsed-time countdown |
| Provider SDK options | Do not pass `timeoutMs` as the SDK's total request timer; compose fetch/event observers and use an abort signal |
| All paths | External abort, shutdown and generation invalidation settle and suppress late effects |

The explicit caller duration takes precedence; otherwise use the captured service configuration default. Audit keeps passing its timeout and does not choose a backend or add an LLM total timer. Pi's transport remains underneath and may apply its own transport limits; the plugin does not rewrite the global dispatcher, inherit the main-session model, or claim to bridge unimplemented Pi settings. Requesting an infinite/disabled plugin timeout is not part of this positive-integer API.

Legacy `judge`, `review` and the emulated classifier share the LLM backend. Preserve SSE attempt observation, raw-byte/reasoning/tool/protocol activity, one malformed-output repair and no auth/quota/transport retry amplification. Joiners must not inherit a different LLM inactivity policy. A continuously active infinite stream requires caller cancellation; no unconditional termination claim is made for it.

## D7. Diagnostics and safety

Separate actual attempts from local capacity decisions and cache hits. Preserve known sums and missing usage, including starts without terminal usage; HTTP 200 is not answer validity or business acceptance. Never store ordinary raw tool/shell bodies, hidden thinking, credentials or copied transcript as cache/diagnostic records. Historical user mentions of AGENTS remain evidence; ambient AGENTS/system prompts/tool definitions and bookkeeping are not history or freshness changes.

Audit retains single-active scheduling, cooldown/pending trigger arbitration, final source/authority validation, reported-not-independently-verified completion and advice deduplication. Valid cached opinions never authorize task execution or TODO mutation.

## D8. Scoped process models

`docs/programming-thinking/timeout-semantics.idea.lean` models backend waiting where present; the companion `audit-session-cache.idea.lean` models exact membership, acknowledgement/currentness guards and ordered abstract macro tuples. Keep core/Std, no proof escapes, exact-file check/run/axiom evidence and fresh neutral file/hash semantic reading. Reconcile existing model paths/claims against the current files before closing the gate.

Models are scoped executable documentation. They do not prove arbitrary factual sufficiency, dynamic JSON codec correctness, scheduler behavior, model truth or TypeScript equivalence. Real public-call traces and complete-packet decoding remain necessary evidence. Do not invent a service-owned business-memory lifecycle merely to preserve the superseded model design.

## D9. Shared acceptance matrix

The IDs match the companion design; both repositories refer to the same observations.

| ID | Observable contract |
| --- | --- |
| J01 | Old native/legacy receipt plus identity change: no rejected-seed loop, no stale reuse or implicit model switch |
| J02 | Actual SDK healthy activity exceeds the caller duration, including a real-clock run over 30 seconds |
| J03 | First-response/body stalls, raw/reasoning/tool activity, external cancellation and uncooperative adapters |
| J04 | Consumer JSONL reload with an empty service ledger; stable sealed-prefix reuse and immediate partial tail |
| J05 | Independently valid A/B persist before C failure; cold retry buys only C, no false final answers/coverage |
| J06 | Whole-packet append savings for the explicit business representation; distinguish exact repeats, retained facts and unsupported free-text retirement |
| J07 | XML/CSV, changed rules, whole acceptance, first-active trajectory, later withdrawal and irreducible/missing facts |
| J08 | Persistence failure, branch/generation changes, malformed records, fragments and no late progress/advice |
| J09 | Consumer-owned full intent: partial failure, reload/retry, completed intent then a genuinely new full request |
| J10 | Both optional capabilities, legacy consumers, load order, ownership/filters and no probes/downgrades/duplicate activation |
| J11 | Native numerical rechecks, batching/capacity and one deadline across business stages |
| J12 | Non-TODO finite consumer uses generic cache/stage ports; no TODO semantics in the service |
| J13 | One actual old-session/native-to-LLM, long-stream, consumer reload, stall/retry/cancellation trace |
| J14 | Honest usage/attempts and bounded diagnostics without repeated unchanged notices or hidden retry storms |

A passing synthetic oracle verifies orchestration and source preservation, not live model accuracy. Record candidate file hashes, commands, failures and fixes. Full regression, independent review, scoped model review, documentation reconciliation and human acceptance remain separate gates.

## Migration and remaining acceptance

Update service first, then audit when activation is separately authorized. Legacy clients remain callable. New audit reports missing cache/stage capabilities without a paid probe, downgrade, duplicate activation, direct HTTP or silent checkpoint fallback. Rolling back the service below the required capabilities disables new audit judgment while leaving TODO available; keep all historical records.

No commit/push, publishing, installed-copy update, activation, paid inference, predecessor sync/archive or watchdog modification is included. Source implementation approval is already granted; this reconciliation does not restart planning or request it again. Outstanding full-intent, irreducible-scale, independent-review and model gates stay open until actually established, and human acceptance is not inferred from tests.
