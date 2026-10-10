## MODIFIED Requirements

### Requirement: Never throws
`judge()` and `review()` SHALL resolve for every input, abort, timeout, missing backend or provider failure. A backend failure recovered by automatic failover SHALL produce the successful alternate's result. A terminal error or abort SHALL be reported through `stopReason` and `errorMessage` with an empty `answers` map.

For each backend attempt, duration precedence SHALL be the caller's `timeoutMs`, else the configured `timeoutMs` override, else the backend default. Backend setup (readiness, redaction preparation, discovery and authentication resolution) SHALL be bounded by the explicit duration or, when absent, 60 000 ms, even when underlying promises ignore cancellation. The native default SHALL be 60 000 ms, with one absolute deadline from admission of that backend attempt through setup and every internal stage, using remaining wall time and never resetting per stage. LLM execution SHALL use the explicit duration or the host's `httpIdleTimeoutMs` (Pi default 300 000 ms; `0` meaning disabled) as a per-request transport-inactivity window. That window SHALL restart for each provider request, including each question batch and the single output-repair attempt, reset on any raw response bytes or provider stream event, and SHALL NOT be forwarded to the SDK as a whole-request timeout.

In automatic modes, timeout of the preferred backend, including its setup, SHALL permit the one alternate backend attempt with a fresh window using that alternate's timeout semantics. An explicit timeout value SHALL apply independently to both attempts; without an override, each backend SHALL use its own default. It SHALL NOT be treated as a combined wall-clock limit for the automatic operation. Forced modes and exhausted automatic routes SHALL end on timeout without restarting the timed-out backend.

Caller cancellation and session navigation SHALL remain terminal aborts across both attempts. A deadline or inactivity expiry SHALL be a backend error, not a caller abort. Caller cancellation observed before alternate admission SHALL prevent alternate dispatch. A late result from a cancelled or expired attempt SHALL NOT publish answers, judgments or checkpoints, or alter the alternate attempt's outcome.

#### Scenario: No backend available
- **WHEN** neither selected/default native classifier nor configured LLM is usable in an automatic mode
- **THEN** the call resolves with `stopReason: "error"`, an `errorMessage` explaining both unavailable candidates, and no answers

#### Scenario: Caller aborts
- **WHEN** the caller's abort signal fires while either backend attempt is in flight
- **THEN** the call resolves with `stopReason: "aborted"`, no new backend is started and aborted work caches or persists no new judgments

#### Scenario: Native logical deadline
- **WHEN** a native backend attempt needs three internal stages and the caller passed 30000 ms
- **THEN** setup and the three stages share that attempt's 30-second deadline; expiry fails the attempt and permits only the automatic route's unused alternate

#### Scenario: Healthy LLM stream outlasts the number
- **WHEN** the LLM backend streams continuously for longer than `timeoutMs`
- **THEN** the attempt does not time out or trigger failover while bytes keep arriving

#### Scenario: Stalled LLM stream
- **WHEN** an LLM response produces no bytes or events for `timeoutMs`
- **THEN** its request is cancelled and the attempt fails; `auto-llm` can try its unused native alternate, while forced `llm` or an already-used alternate ends with a timeout error

#### Scenario: Hung discovery
- **WHEN** preferred-backend discovery never resolves in an automatic mode but the alternate is usable
- **THEN** the preferred attempt times out without dispatch, the alternate obtains a fresh setup window and can answer

#### Scenario: Timeout
- **WHEN** a forced backend exceeds the backend-specific interpretation of `timeoutMs`
- **THEN** the call resolves with `stopReason: "error"` and that timed-out request is not retried or replaced by another backend

#### Scenario: Fresh alternate window
- **WHEN** `auto` uses `timeoutMs: 30000`, the native attempt times out, and the configured LLM is usable
- **THEN** the LLM receives a fresh 30000 ms setup bound followed by a 30000 ms per-request inactivity window, rather than the native attempt's exhausted deadline or aborted timeout signal

#### Scenario: Alternate native deadline
- **WHEN** `auto-llm` times out on the LLM with `timeoutMs: 30000` and switches to the classifier
- **THEN** the classifier receives one fresh 30000 ms absolute deadline spanning its setup and all stages

#### Scenario: Defaults belong to each backend
- **WHEN** automatic failover occurs without a caller or configured timeout override
- **THEN** native execution uses its 60000 ms absolute deadline and LLM execution uses the host idle-timeout setting, without borrowing the preferred backend's default

#### Scenario: Cancellation wins between attempts
- **WHEN** the preferred backend fails and caller cancellation is observed before the alternate starts
- **THEN** the operation resolves aborted without dispatching the alternate

#### Scenario: Timed-out backend resolves late
- **WHEN** the preferred backend ignores cancellation and returns after failover has begun
- **THEN** its late result cannot replace the alternate result, populate answers or publish new judgments or checkpoints

### Requirement: Backend selection
The service SHALL use modes `auto`, `auto-llm`, `classifier` or `llm`. The native candidate SHALL be the explicitly configured `classifierModel` when present, otherwise an available Jev-family model using the existing default discovery preference. Explicit selection SHALL allow compatible Pi classifier models not named Jev; the service SHALL exclude its own LLM-emulation provider from native selection and SHALL NOT automatically substitute an arbitrary non-Jev classifier. A compatible native adapter SHALL support the existing question/answer contract and defined numeric-field semantics; model type alone SHALL NOT be treated as proof of calibrated confidence. Availability SHALL come from Pi's model registry, not independent credential resolution.

`auto` SHALL prefer the selected/default native candidate and use the independently configured LLM if that candidate is missing, unavailable or fails. `auto-llm` SHALL prefer the independently configured LLM and use the selected/default native candidate if the LLM is unconfigured, unavailable or fails. Both public judgment paths, `judge()` and `review()`, SHALL follow the same ordering. Each operation SHALL consider each backend family at most once, stop on success and never cycle back to a previously failed or unavailable family. This bound SHALL NOT remove existing within-backend question splitting, evidence recovery, output repair or adapter transport retry behavior.

Eligible failures SHALL include backend discovery/authentication failure, transport/provider failure, invalid or incompatible output after applicable recovery, irreducible context failure, and setup or execution timeout. Invalid requests, invalid caller policy, caller cancellation and session navigation SHALL NOT trigger failover. A valid negative answer or confidence-filtered result, including all questions being dropped, SHALL count as backend success rather than failure.

A missing, wrong-type or unavailable explicit native candidate SHALL NOT cause another native model to be silently selected. Forced `classifier` and `llm` SHALL never switch backend. The operation SHALL freeze its configuration; each backend attempt SHALL freeze its actual full model reference and effective thinking identity across dispatch, recovery, cache and ledger operations. Failover SHALL NOT reread settings or mutate the persisted mode or model slots. Each later public operation SHALL start with the configured preference again, not a sticky choice based on an earlier failure.

#### Scenario: Default auto with Jev available
- **WHEN** mode is `auto`, no `classifierModel` is configured, and Pi reports an available Jev-family classifier that successfully answers
- **THEN** that classifier answers, the result reports `backend: "classifier"` and its actual model reference, and the LLM is not dispatched

#### Scenario: Explicit non-Jev classifier
- **WHEN** a compatible available classifier not named Jev is explicitly configured and a native attempt is needed
- **THEN** the native request uses that exact model rather than the default Jev candidate

#### Scenario: Auto without a native candidate
- **WHEN** mode is `auto`, the selected/default native candidate is unavailable, and a usable LLM model is configured
- **THEN** the LLM answers and the result reports `backend: "llm"`

#### Scenario: Missing explicit model does not select another native model
- **WHEN** an explicit classifier is absent or unavailable but a different native classifier is available
- **THEN** automatic modes can use only the configured LLM as the other family, while forced classifier mode errors; no mode silently substitutes that other native model

#### Scenario: Forced classifier with none available
- **WHEN** mode is `classifier` and its selected/default native candidate is unavailable
- **THEN** the result is `stopReason: "error"` and the LLM is not used

#### Scenario: Emulation is not a native candidate
- **WHEN** this plugin's LLM-emulation provider is listed as a Pi classifier or explicitly named in `classifierModel`
- **THEN** it is excluded from native selection and is never recursively dispatched as the native backend

#### Scenario: Native failure is not fallback permission
- **WHEN** mode is forced `classifier` and the selected native model fails authentication, transport or answer validation after dispatch
- **THEN** the service returns an error with no answers and does not call another native model or the LLM

#### Scenario: Native runtime failure permits one LLM attempt
- **WHEN** mode is `auto`, the selected native model fails authentication, transport or answer validation after applicable recovery, and the configured LLM succeeds
- **THEN** the operation succeeds with the LLM's answers and actual identity, without trying another native model

#### Scenario: Selected identity survives registry changes
- **WHEN** registry discovery changes while one backend attempt is subdivided or retried
- **THEN** every part and stored judgment of that attempt retains its originally selected backend/model identity

#### Scenario: Auto-llm prefers LLM
- **WHEN** mode is `auto-llm`, both candidates are usable and the LLM succeeds
- **THEN** the LLM answers and no native inference is dispatched

#### Scenario: Auto-llm with no usable LLM
- **WHEN** mode is `auto-llm`, the LLM slot is unset, unknown or lacks usable credentials, and the selected/default classifier is usable
- **THEN** that classifier answers without inheriting the main-session model or treating an unset classifier slot as disabling default Jev discovery

#### Scenario: LLM runtime failure permits one native attempt
- **WHEN** mode is `auto-llm`, the LLM fails after applicable recovery and the selected/default native classifier succeeds
- **THEN** the operation succeeds with only that classifier's answers and actual identity

#### Scenario: Both backend attempts fail
- **WHEN** the preferred and alternate backends both fail in either automatic mode
- **THEN** the operation ends with `stopReason: "error"`, no answers and redacted diagnostics identifying both failures; neither backend is tried again by automatic routing

#### Scenario: Forced backend fails
- **WHEN** a forced `llm` or `classifier` attempt fails while the other family is usable
- **THEN** the failure remains terminal and the other family is not dispatched

#### Scenario: No failover for valid business outcomes
- **WHEN** the preferred backend returns valid `false` answers or succeeds with all classifier answers dropped by confidence policy
- **THEN** the operation reports that backend's successful result without trying the alternate

#### Scenario: Invalid request does not select an alternate
- **WHEN** a request or threshold policy fails validation
- **THEN** the call returns an invalid-request error without inference on either backend

#### Scenario: Next call restores configured priority
- **WHEN** an earlier automatic operation succeeded through its alternate and a new public operation starts
- **THEN** the new operation starts from its current configured preference rather than pinning the previous alternate

### Requirement: Context capacity and splitting
Before sending, the service SHALL predict whether the request exceeds the current backend attempt's input capacity using its declared context limit and learned rejections. When a multi-question request is predicted or reported to overflow, the service SHALL split unanswered questions into smaller batches and retry. When a single question with the given state is rejected for size and applicable recovery cannot complete it, that backend attempt SHALL fail with a context-overflow indication and SHALL NOT resend that exact envelope unchanged to the same backend/model. An automatic operation with an unused alternate SHALL try the full logical request under the alternate's own capacity profile; otherwise the service SHALL report `stopReason: "error"`.

#### Scenario: Batch overflows
- **WHEN** a request with eight questions is rejected by the provider for input size
- **THEN** the service retries the questions in smaller batches and returns the union of accepted answers if that backend completes them

#### Scenario: Irreducible overflow
- **WHEN** a single question with its state is rejected for input size and no applicable recovery or alternate can complete it
- **THEN** the result reports a context-overflow error and the same envelope is not resent to the rejecting backend/model until state or question changes

#### Scenario: Backend-specific limit
- **WHEN** the LLM backend model declares a larger context window than the selected native classifier
- **THEN** overflow prediction for an LLM attempt uses the LLM model's limit, including after native failure

#### Scenario: Thinking level changes
- **WHEN** an LLM judgment was cached at `low` and the same model is configured at `high`
- **THEN** the next identical question sends a new model request

#### Scenario: Smaller alternate cannot fit
- **WHEN** a failed preferred attempt is followed by an alternate whose capacity cannot fit the logical request even after applicable recovery
- **THEN** the operation returns a structured error rather than truncating evidence, borrowing the first backend's limits or cycling back

### Requirement: Ordered evidence recovery
Ordered evidence with service-owned fragmentation SHALL remain available for callers that supply it, with the same completeness and metadata guarantees as before. It SHALL NOT be required: callers SHALL be able to embed ordered input inside `state` and rely on capacity disclosure and question splitting only. Business stage callbacks (`planStages`, `projectStage`, `onProgress`) and service checkpoints are deprecated and SHALL NOT be required for a complete result.

Recovery SHALL operate within one frozen backend identity. When that attempt fails and automatic failover remains, the alternate SHALL process the complete logical request, not only the first backend's unanswered questions or evidence suffix. Early-stage answers SHALL NOT become final answers for a failed or aborted attempt, and checkpoints SHALL only be reusable under compatible backend/model/thinking identity.

#### Scenario: Consumer packs its own input
- **WHEN** a consumer sends state that fits the selected backend's capacity, with no evidence array
- **THEN** a successful attempt judges it in one provider request per question batch without fragmentation

#### Scenario: Evidence dominates the request size
- **WHEN** even a single question over all evidence exceeds a backend's capacity
- **THEN** the service reduces evidence batches and carries previous-stage judgments forward within that backend attempt until all supplied evidence is processed

#### Scenario: One large evidence record
- **WHEN** a single evidence record is too large and its text can be divided
- **THEN** the service processes ordered fragments, preserving source identity and completeness metadata

#### Scenario: Original metadata survives fragmentation
- **WHEN** an oversized record has caller metadata, including its own `fragment` key
- **THEN** all original metadata is preserved alongside separate recovery bounds and every text fragment is processed in order

#### Scenario: Failure on a later stage
- **WHEN** an early evidence batch succeeds but a later batch fails or is aborted
- **THEN** no early-stage answer is returned as a final judgment; resume can reuse persisted validated stages only under the matching identity, and eligible failover starts a complete alternate attempt

#### Scenario: Fixed state cannot fit
- **WHEN** fixed state with one minimum fragment is rejected for input size
- **THEN** the attempt fails with context overflow rather than deleting evidence or repeatedly resending the same envelope; only an unused automatic alternate can continue the operation

### Requirement: Operation-scoped configuration snapshots
Each public `judge()`, `review()` and `availability()` call SHALL obtain current global file settings at operation admission, including calls through a service handle acquired before the settings changed. The configuration snapshot SHALL be fixed for that entire call. Internal stages, splitting, malformed-output retries, recovery and automatic failover SHALL NOT become new configuration-reading boundaries. A later public review call, including a resumed review, SHALL obtain a new snapshot.

Backend order, configured native and LLM references, effective thinking level, configured timeout and applicable context-limit overrides SHALL derive from that snapshot. Existing explicit caller-option precedence SHALL remain, including a caller timeout overriding the configured timeout. Helpers, error reporting and cache/ledger identities SHALL NOT combine settings from different snapshots. Configuration refresh SHALL preserve public service and review versions and SHALL NOT require consumers to replace their handle or call a refresh API.

Observing a changed configuration SHALL NOT itself cancel, restart or duplicate already-running work, clear the active branch ledger or invalidate otherwise reusable judgments. Caller abort, shutdown and branch navigation SHALL remain terminal; deadlines SHALL follow the per-backend-attempt contract, including the one automatic failover. Cache lookup, in-flight joining and review-checkpoint reuse SHALL require matching actual backend, model and effective thinking identity; neither a configuration change nor failover SHALL enable cross-identity reuse.

#### Scenario: Existing service handle observes the next save
- **WHEN** B retains a service handle, A completes a save selecting a different usable backend/model, and B then calls `judge()` through that same handle
- **THEN** the call uses the new selection without reload or a configuration command in B, and reports the actual answering identity

#### Scenario: Review spans an external edit
- **WHEN** a review starts with configuration X and the file changes to Y between evidence stages
- **THEN** stages, retries, any failover, result metadata and stored judgments retain X's settings and the identity of their respective backend attempt; the edit alone sends no replacement request

#### Scenario: New call overlaps old work
- **WHEN** a judgment using X is still running and another judgment starts after configuration Y has been saved
- **THEN** the new call uses Y while the existing call finishes using X, without one call mutating the other's settings

#### Scenario: Edit during backend discovery
- **WHEN** a call captures X and the file changes to Y while model discovery or authentication is pending
- **THEN** the call selects and reports its backend using X, without mixing X's mode or timeout with Y's model or thinking level

#### Scenario: Failure retains the operation identity
- **WHEN** a call admitted with X ends in error after the file has changed to Y
- **THEN** its structured error identifies candidates or attempts derived from X, not an unrelated model from Y

#### Scenario: Availability is independently fresh
- **WHEN** another session changes either model slot before B calls `availability()`
- **THEN** B evaluates the current selected/default native and configured LLM candidates without a preceding judgment, inference request or settings mutation

#### Scenario: Configured timeout and limits change
- **WHEN** a new call starts after `timeoutMs` or applicable context-limit overrides change
- **THEN** that call uses the new defaults while explicit caller overrides keep their precedence and older calls retain their earlier snapshot for both backend attempts

#### Scenario: No stale cache or in-flight identity
- **WHEN** identical questions are cached or in flight under one backend/model/thinking identity and a save selects a different identity before the next call
- **THEN** the next call does not reuse or join the older identity's work or restore an incompatible review checkpoint

#### Scenario: Unchanged settings still permit reuse
- **WHEN** a new operation rereads settings yielding the same effective identity and an exact matching judgment is available
- **THEN** it reuses that judgment under the existing policy without an extra provider request or a configuration-triggered branch reset

#### Scenario: A resumed review uses current selection
- **WHEN** a review returns and a later public `review()` call resumes the same evidence after the configured identity changes
- **THEN** the later call uses current settings and reuses only checkpoints compatible with the selected identity

#### Scenario: Failover ignores an intervening settings save
- **WHEN** an automatic call captures X, its preferred backend fails, and a save to Y changes the alternate model before failover starts
- **THEN** the call uses X's alternate model, thinking level, timeout override and limits; the next public call observes Y

## ADDED Requirements

### Requirement: Automatic failover result isolation
After automatic failover, final answers, dropped ids, backend/model identity, capacity and capacity-related input measurements SHALL describe the terminal backend attempt, not a mixture of both attempts. The alternate SHALL evaluate the complete logical request under its own confidence policy. A successful result SHALL contain no terminal `errorMessage` from the failed preferred attempt. If neither candidate succeeds, the result SHALL have no answers and SHALL describe both failures or unavailable candidates in a bounded, redacted `errorMessage`. If a model was resolved for the terminal attempt, its backend/model SHALL identify that attempt.

Validated cached judgments and persisted review checkpoints from the first backend SHALL NOT be relabeled or reused as alternate-backend judgments. Reuse under the exact same backend/model/thinking identity SHALL remain supported. Review transport diagnostics SHALL account for actual attempts from both backends using existing observation and redaction rules, while final progress and unresolved questions SHALL describe the terminal attempt. Failed-attempt diagnostics SHALL NOT falsely claim that its partial judgments form part of a successful alternate result. Aborting one caller SHALL NOT cancel other callers' independently live work or make a cancelled caller start its alternate.

Read-only selection and capacity queries SHALL describe the first currently usable candidate in the configured order, without inference or cache/settings mutation. They SHALL NOT promise that inference will succeed or predict runtime failover. Final results SHALL disclose the backend and capacity actually used by the terminal attempt, which can differ from the earlier query.

#### Scenario: Partial primary results are not merged
- **WHEN** the preferred backend answers one batch and fails later, and the alternate succeeds
- **THEN** every final answer belongs to the alternate's complete evaluation, with its identity and capacity; preferred-backend answers are not spliced into the result

#### Scenario: Confidence follows the answering backend
- **WHEN** an automatic operation fails over from classifier to LLM with numeric thresholds configured
- **THEN** the successful LLM result ignores those thresholds and has no dropped ids; failover in the reverse direction applies the classifier's normal thresholds

#### Scenario: Alternate has a compatible cache entry
- **WHEN** the preferred backend fails and an exact alternate-backend judgment is already cached
- **THEN** the alternate can reuse it without another inference request, but cannot use a preferred-backend cache entry

#### Scenario: Review reports both attempts honestly
- **WHEN** a review dispatches the preferred backend, fails over, and completes on the alternate
- **THEN** existing transport diagnostics retain actual observable work from both attempts, while final answers, progress, unresolved ids and capacity describe the alternate

#### Scenario: Query and execution differ after failure
- **WHEN** a read-only selection query reports the usable preferred candidate and a later automatic operation fails over after that candidate's inference fails
- **THEN** the query has performed no inference and the operation reports the alternate's actual identity and capacity rather than the earlier prediction

#### Scenario: Failure message remains private
- **WHEN** both candidates fail and provider errors contain credentials or raw response bodies
- **THEN** the combined error identifies the two outcomes without exposing credentials or raw response bodies

#### Scenario: Deprecated checkpoint seed is not replayed on the alternate
- **WHEN** a `review()` call supplies the deprecated `checkpoint` seed, its preferred backend fails, and automatic failover would otherwise start the alternate
- **THEN** the alternate is not dispatched; the call ends with `stopReason: "error"`, no answers, and an `errorMessage` stating that a checkpoint-seeded review cannot fail over and the complete input must be resubmitted without `checkpoint`

#### Scenario: Joined caller cancellation remains local
- **WHEN** two callers share compatible backend work and one cancels while the other remains live
- **THEN** the cancelled caller returns aborted without failover and the other caller retains its own completion and failover eligibility
