## Purpose

Provide generic staged execution and validated exact-result cache ports while leaving factual sufficiency, history boundaries, full intent and durable business history with the consumer.

## ADDED Requirements

### Requirement: Independently discoverable execution capabilities
The existing service SHALL retain `version: 1`, `judge()` and `reviewVersion: 1`/`review()`. It SHALL advertise `reviewCacheVersion: 1` and `reviewStagesVersion: 1` for the corresponding optional review contracts. Discovery SHALL not require inference. A consumer requiring either capability SHALL be able to diagnose its absence without a probe, downgrade, duplicate activation or silent checkpoint fallback. No separate managed business-memory API SHALL be required.

#### Scenario: Service updates before an old consumer
- **WHEN** an existing consumer calls the legacy judgment or review interface
- **THEN** it remains callable without supplying a cache or stage planner

#### Scenario: New audit encounters missing support
- **WHEN** the service lacks a required cache or stage capability
- **THEN** audit does not dispatch inference or replace the existing service and reports the limitation

### Requirement: Consumer owns finite semantics and persistence
A review SHALL accept consumer-supplied permitted evidence, fixed state, finite questions and optional synchronous business projection/planning and cache callbacks. The consumer SHALL own which facts are sufficient, stable business boundaries, history reconstruction and durable business results/progress. The service SHALL own actual execution identity, raw validation, capacity, dispatch and acceptance-policy rechecks. It SHALL not retrieve excluded history or require generated summaries.

#### Scenario: Non-TODO consumer
- **WHEN** another business domain supplies a finite factual contract and cache/stage callbacks
- **THEN** the same engine executes it without TODO-specific interpretation or a service-owned business-history database

#### Scenario: Ambient instructions and bookkeeping
- **WHEN** a business snapshot is constructed from historical events
- **THEN** ambient system/AGENTS instructions, tool definitions and private cache/diagnostic entries are not evidence or freshness changes; genuine historical mentions retain their provenance

### Requirement: Service-derived exact raw-result identity
The service SHALL compute opaque per-question keys after actual backend/model/transport/thinking selection, redaction and projection. Keys SHALL cover complete question meaning/rules, semantic scope/revision, effective fixed state, ordered source roles/content/bounds, genuine prior inputs and finality. Question ids, cursors or configured model names alone SHALL not establish equivalence. External raw values SHALL be validated against the current question and copied before use. Current native numerical policy SHALL be reapplied separately.

#### Scenario: New service with consumer JSONL
- **WHEN** a new service instance has no old service ledger but the consumer restores matching acknowledged answers
- **THEN** the unchanged review needs zero provider attempts and does not require a service checkpoint

#### Scenario: Identity, question or facts change
- **WHEN** effective model/transport/thinking, question/rules, required source content or source roles change
- **THEN** incompatible answers miss the cache despite identical ids or labels

#### Scenario: Stricter native threshold
- **WHEN** only the current native acceptance threshold changes
- **THEN** valid stored raw values are rechecked without inference and rejected values are withheld

### Requirement: Ordered business stages retain one execution
A synchronous `planStages` callback SHALL return a finite snapshot of strictly increasing exclusive original-frame ends. These prefixes SHALL be provisional; the remaining tail, including an empty tail, SHALL be final. No source SHALL be omitted or reordered. Planning/projection SHALL require an explicit revision. Malformed/asynchronous plans SHALL not dispatch. Engine capacity subdivision SHALL preserve genuine fragment bounds, strict progress and one admitted backend/configuration snapshot.

#### Scenario: Appended tail
- **WHEN** the consumer's stable business rule produces the same sealed prefix followed by appended evidence
- **THEN** exact compatible prefix judgments can be reused and the available tail is processed without waiting for a full block

#### Scenario: Native multi-stage call
- **WHEN** a native review executes several business stages or capacity subdivisions
- **THEN** every stage shares the original logical-call total deadline rather than receiving a fresh budget

#### Scenario: Invalid boundaries
- **WHEN** a planner returns zero, non-integer, descending, duplicate or out-of-range ends, or returns a promise
- **THEN** the operation fails boundedly with zero provider attempts and no claimed progress

### Requirement: Finite answers do not replace undeclared facts
The consumer projection SHALL retain required original facts or use an explicit sufficient business representation; otherwise affected scopes SHALL remain incomplete. The service SHALL not infer arbitrary factual sufficiency from a prior label, primary-source selection, hash, cursor or completed block. No additional model-generated fact memory or prose-summary call SHALL be introduced. Intermediate engine success SHALL not become final business advice.

#### Scenario: Lossless macro representation
- **WHEN** the audit consumer replaces repeated macro-event field names with columns
- **THEN** the model-facing values, text, roles, source ids, ordering, call links and statuses remain reconstructible, and whole-packet savings are measured separately from exact hits

#### Scenario: Required free text remains large
- **WHEN** necessary reports or protected constraints cannot be represented by the declared finite state and do not fit the backend
- **THEN** originals remain or the affected scope is withheld; the result is not advertised as successful arbitrary-history compression

#### Scenario: XML versus CSV or later permission withdrawal
- **WHEN** an earlier opinion cannot distinguish the required format or a later user decision withdraws permission
- **THEN** distinguishing source facts and current authority remain explicit, or the scope is unresolved; the cached opinion cannot authorize continuation

### Requirement: Useful members are durable before stage completion
Review SHALL make independently validated and observable finite members available to the consumer cache before later members run. Acknowledged A/B SHALL survive later C failure as historical exact results, without completing the failed stage or exposing failed-call final answers. Legacy `judge()` SHALL retain its no-new-partials-on-abort behavior.

#### Scenario: A and B succeed before C fails
- **WHEN** A/B are independently validated and acknowledged and C then fails
- **THEN** the failed review has no final answers, incomplete coverage does not advance, and a compatible cold retry requests only C

### Requirement: Durability and currentness are explicit
Consumer cache acknowledgement SHALL be distinct from legacy service-checkpoint durability and final-answer validity. Business progress SHALL depend on its required acknowledged evaluations and verified source coverage. Cache/progress callbacks and late completions SHALL be fenced by the captured ownership and cancellation state. Stored cache and diagnostics SHALL not contain copied transcript bodies, hidden thinking or credentials.

#### Scenario: Consumer persistence fails
- **WHEN** a raw answer is valid but the required consumer append is not acknowledged
- **THEN** the service does not claim consumer durability and audit advances no required frontier or final advice from that failure

#### Scenario: Branch changes during execution
- **WHEN** the captured branch or input ownership becomes stale
- **THEN** late answers, writes and advice do not enter the new branch

### Requirement: Recovery and full intent remain business-owned
Consumers using the cache contract SHALL be able to reconstruct permitted input without a service seed. Legacy receipts SHALL remain readable but SHALL not prove current source sufficiency. A changed identity SHALL cause compatible reuse or misses under one selection, not repeated submission of an invalid continuation or an implicit backend switch. The consumer SHALL own explicit full-review identity and unfinished-intent resumption; the service SHALL honor its opaque fresh identity.

#### Scenario: Old native receipt with missing checkpoint
- **WHEN** audit restores an old valid receipt but selects a different execution identity
- **THEN** its one current operation supplies history/cache without the stale checkpoint and preserves historical records

#### Scenario: Full retry and new full intent
- **WHEN** the consumer retries an unfinished full review and later requests another full after completion
- **THEN** compatible partial work belongs to the same unfinished intent while the later completed-intent reassessment is distinct

### Requirement: Attempts and limitations remain observable
Results SHALL distinguish accepted answers, unresolved scope, failure, cancellation, reuse and acknowledged durability. Actual observed attempts and presence-aware usage SHALL remain attributable; HTTP 200, unknown usage and zero local dispatches SHALL not be misrepresented as successful or free inference. Diagnostics SHALL be bounded and redacted. No cache result SHALL itself authorize execution or TODO mutation.

#### Scenario: Partial failure accounting
- **WHEN** some attempts report usage and a later attempt has no terminal usage
- **THEN** diagnostics retain known sums and missing-field counts without fabricating complete totals
