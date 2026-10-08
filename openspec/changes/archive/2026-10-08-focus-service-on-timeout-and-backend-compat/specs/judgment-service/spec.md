## MODIFIED Requirements

### Requirement: Never throws
`judge()` and `review()` SHALL resolve for every input, abort, timeout, missing backend, or provider failure; such outcomes SHALL be reported through `stopReason` and `errorMessage` with an empty `answers` map.

One admitted duration SHALL apply per call: the caller's `timeoutMs`, else the configured `timeoutMs` override, else a backend default of 60 000 ms for the native classifier and the host's `httpIdleTimeoutMs` (Pi default 300 000 ms; `0` meaning disabled) for the LLM backend. Setup (readiness, redaction preparation, backend discovery and authentication resolution) SHALL settle within that duration even when an underlying promise never observes the abort signal. For the native classifier backend the duration SHALL be one absolute logical-call deadline spanning every internal stage, using remaining wall time, never reset per stage. For the LLM backend the duration SHALL be a per-request transport-inactivity window: it restarts for each provider request (including each question batch and the single output-repair attempt), is reset by any raw response bytes or provider stream event, and SHALL NOT be forwarded to the provider SDK as a whole-request timeout. A caller abort SHALL remain an abort; a deadline or inactivity expiry SHALL be an error; a late backend result SHALL NOT be published after either.

#### Scenario: No backend available
- **WHEN** no selected/default native classifier is available and no LLM backend model is configured
- **THEN** the call resolves with `stopReason: "error"`, an `errorMessage` naming the missing configuration, and no answers

#### Scenario: Caller aborts
- **WHEN** the caller's abort signal fires while a request is in flight
- **THEN** the call resolves with `stopReason: "aborted"` and no partial answers are cached

#### Scenario: Native logical deadline
- **WHEN** the native backend needs three internal stages and the caller passed 30000 ms
- **THEN** the three stages share the same 30-second deadline and the call resolves with a timeout error once it passes

#### Scenario: Healthy LLM stream outlasts the number
- **WHEN** the LLM backend streams continuously for longer than `timeoutMs`
- **THEN** the call does not time out while bytes keep arriving

#### Scenario: Stalled LLM stream
- **WHEN** the LLM response produces no bytes or events for `timeoutMs`
- **THEN** that request is aborted and the call resolves with a timeout error and no retry

#### Scenario: Hung discovery
- **WHEN** backend discovery never resolves
- **THEN** the call resolves with a timeout error at the admitted duration without dispatching a provider request

#### Scenario: Timeout
- **WHEN** the caller passes `timeoutMs` and the backend does not answer within its backend-specific interpretation of it
- **THEN** the call resolves with `stopReason: "error"` and the request is not retried


### Requirement: Exact-match caching
The service MAY reuse a previously validated raw judgment internally when backend identity, model, effective thinking level, state, question id and complete question definition are identical, and SHALL join in-flight work for the same identity. It SHALL NOT reuse across backends, models or thinking levels, and SHALL apply thresholds per caller. Consumer-supplied cache lookup/store callbacks are deprecated: existing `version:1` callers that pass them SHALL keep working, new consumers SHALL NOT be required to supply them, and the service SHALL NOT depend on them for correctness.

#### Scenario: Consumer passes no cache callbacks
- **WHEN** a consumer calls the service with state, questions and options only
- **THEN** the call is accepted and judged normally

#### Scenario: Legacy consumer passes callbacks
- **WHEN** a `reviewVersion:1` consumer passes cache callbacks and checkpoints
- **THEN** behavior is unchanged from the previous release

#### Scenario: Same question twice
- **WHEN** the same state and question are judged twice on the same backend and model
- **THEN** the second call sends no provider request and returns the cached answer

#### Scenario: Backend switch
- **WHEN** a question was answered on `classifier` and the mode is changed so the same question is judged on `llm`
- **THEN** a new provider request is sent

#### Scenario: Native model switch
- **WHEN** the configured classifier changes from one model to another and the state/question remain identical
- **THEN** the next request uses the new model, does not reuse the old model's judgment, and records the new actual model identity


### Requirement: Ordered evidence recovery
Ordered evidence with service-owned fragmentation SHALL remain available for callers that supply it, with the same guarantees as before. It SHALL NOT be required: a caller MAY embed its own ordered input inside `state` and rely on capacity disclosure and question splitting only. Business stage callbacks (`planStages`, `projectStage`, `onProgress`) and service checkpoints are deprecated and SHALL NOT be required for a complete result.

#### Scenario: Consumer packs its own input
- **WHEN** a consumer sends state that already fits the disclosed capacity, with no evidence array
- **THEN** the service judges it in one provider request per question batch without fragmentation

#### Scenario: Evidence dominates the request size
- **WHEN** even a single question over all evidence exceeds backend capacity
- **THEN** the service reduces evidence batches and carries previous-stage judgments forward until all supplied evidence is processed

#### Scenario: One large evidence record
- **WHEN** a single evidence record is too large and its text can be divided
- **THEN** the service processes ordered fragments, preserving source identity and completeness metadata

#### Scenario: Original metadata survives fragmentation
- **WHEN** an oversized record has caller metadata, including its own `fragment` key
- **THEN** all original metadata is preserved alongside separate recovery bounds and every text fragment is processed in order

#### Scenario: Failure on a later stage
- **WHEN** an early evidence batch succeeds but a later batch fails or is aborted
- **THEN** no early-stage answer is returned as a final judgment; resume can reuse persisted validated stages

#### Scenario: Fixed state cannot fit
- **WHEN** fixed state with one minimum fragment is rejected for input size
- **THEN** the service reports context overflow rather than deleting evidence or repeatedly resending the same envelope


### Requirement: Session-branch ledger
The service SHALL persist internal raw judgments, size rejections and per-request diagnostics as non-context custom session entries for its own reuse and metering only, restored from the active branch at session start or branch change, never containing credentials, provider bodies or request state/evidence. The ledger SHALL NOT be the consumer's progress or business memory; consumers persist their own judgment state. Aborted work SHALL NOT persist new judgments.

#### Scenario: Consumer progress survives a ledger-free branch
- **WHEN** a consumer switches to a branch without service ledger entries
- **THEN** the consumer's own persisted state is unaffected and the service simply has no internal reuse for that branch

#### Scenario: Ledger entries stay out of model context
- **WHEN** a ledger entry is written
- **THEN** it is not shown in the transcript and not sent to the agent's model

#### Scenario: Resume restores verdicts
- **WHEN** a session is resumed after internal raw judgments were persisted
- **THEN** judging the same state and question returns the persisted answer without a provider request

#### Scenario: Abandoned branch
- **WHEN** the user navigates to a branch that does not contain a persisted answer
- **THEN** that answer is not available for internal reuse on the new branch

#### Scenario: Legacy prototype backend tags
- **WHEN** the active branch contains old `jev`-tagged prototype judgments
- **THEN** they are not relabeled or accepted as new `classifier` identity matches, and existing session entries are not rewritten
