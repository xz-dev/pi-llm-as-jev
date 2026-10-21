# Judgment Service Specification

## Purpose

An in-process service other Pi extensions call to get answers to Pi-shaped typed questions about JSON state, hiding native-classifier versus discrete-LLM selection, numeric policy, caching and complete ordered-evidence recovery, with judgments retained only on the active session branch.

## Requirements

### Requirement: Service discovery
The extension SHALL publish one process-wide judgment service with `version: 2`, discoverable at call time through the existing service key. Its judgment entry SHALL be `judge()`; it SHALL NOT advertise or implement `review`, `reviewVersion`, `reviewCacheVersion` or `reviewStagesVersion`. Missing or incompatible services SHALL be distinguishable without inference. A retiring activation SHALL NOT delete a newer activation's handle.

#### Scenario: Consumer loads before the service
- **WHEN** a consumer looks up the service before and after service activation
- **THEN** the first lookup is absent and the later lookup returns the version-two service without reloading the consumer

#### Scenario: Service absent
- **WHEN** the judgment extension is not installed
- **THEN** lookup returns nothing and the consumer continues without a judgment feature

#### Scenario: Old consumer meets new service
- **WHEN** a consumer requires version one or the review capability
- **THEN** it detects incompatibility rather than invoking a misleading compatibility facade

### Requirement: Request and answer shape
`judge()` SHALL accept a JSON `state` object and a nonempty map of Pi-shaped `choice`, `bool` and `score` questions. It SHALL return accepted `answers`, `dropped` ids, actual `backend` (`classifier` or `llm`) and `provider/modelid`, `stopReason` (`stop`, `error` or `aborted`) and a bounded `errorMessage` on failure. Provider-reported usage SHALL remain optional; it SHALL NOT claim complete operation billing. Version two SHALL omit reuse counters, review progress, checkpoints, attempt observations and learned input-dimension accounting. Removed evidence/stage/cache/freshness options and legacy `timeoutMs` SHALL be rejected explicitly, not silently ignored. Consumers SHALL place necessary factual input in `state`.

Answers SHALL validate against the complete requested types, labels and numeric constraints before native threshold filtering. An incomplete or malformed raw result SHALL NOT publish partial final answers. Legal own JSON keys SHALL survive validation and serialization without prototype mutation; service persistence and reuse are removed by the explicit removals below.

#### Scenario: Mixed question types
- **WHEN** a request contains one choice, one bool and one score question
- **THEN** each validated answer retains its matching type and question id

#### Scenario: Special JSON identifiers
- **WHEN** a valid question id or choice label is `__proto__`, `constructor` or `toString`
- **THEN** the own key and answer/probability survive validation and serialization without inherited-property lookup, prototype mutation or data loss

#### Scenario: Legacy payload is not silently shortened
- **WHEN** a caller supplies a separate legacy evidence array or checkpoint option
- **THEN** the service returns an invalid-request error with no inference, rather than ignoring required facts

### Requirement: Never throws
Every public judgment SHALL resolve to a result, including invalid input, unavailable backends, exceptions, cancellation and timeout. Error and aborted results SHALL have empty final `answers`. Eligible automatic failures SHALL permit one unused alternate; forced modes SHALL remain terminal.

Each backend attempt SHALL have a generation-progress idle timer, defaulting to **10,000 ms for classifier** and **15,000 ms for LLM**, and an optional `modelTimeoutMs` hard limit. Caller `idleTimeoutMs` and `modelTimeoutMs`, when supplied, SHALL override the corresponding backend-slot setting for each attempt independently. An omitted hard limit with no configured hard limit SHALL mean no hard limit. The service SHALL NOT derive these values from the host HTTP idle setting or add a combined primary-plus-alternate deadline.

Both timers SHALL start at backend-attempt admission, covering readiness, discovery, authentication, every question and the single permitted LLM output repair per question. Only nonempty generated text, reasoning or tool-argument deltas, or a completed validated question answer, SHALL renew the idle timer. Headers, heartbeats, empty/lifecycle events, retry starts, question dispatches and setup completion SHALL NOT renew it. The hard timer SHALL never renew. A non-streaming native adapter SHALL remain subject to idle expiry while waiting for its complete answer.

Timeout SHALL cancel cooperative work and settle even when an adapter ignores cancellation. Failover SHALL start independent timers and abandon the previous attempt's partial results. Caller cancellation, session navigation and shutdown SHALL terminate the operation, prevent alternate dispatch and fence late results; concurrent independent calls SHALL retain their own cancellation ownership.

#### Scenario: No backend available
- **WHEN** neither native nor configured LLM is usable in an automatic mode
- **THEN** the call resolves with error, no answers and a bounded explanation of both unavailable candidates

#### Scenario: Caller aborts
- **WHEN** caller cancellation occurs during either attempt
- **THEN** the call resolves aborted with no answers, no alternate dispatch and no persisted judgments

#### Scenario: Native logical deadline
- **WHEN** a native attempt has `modelTimeoutMs: 30000`
- **THEN** its setup and classification share one 30-second hard deadline; expiry permits only the automatic route's unused alternate

#### Scenario: Healthy LLM stream outlasts the number
- **WHEN** genuine generation continues within each idle window for longer than `idleTimeoutMs`, with no hard cap configured
- **THEN** idle expiry and an invented total deadline do not stop it

#### Scenario: Stalled LLM stream
- **WHEN** an LLM produces no genuine generation progress for its idle duration, even while receiving heartbeats
- **THEN** its attempt fails and only an unused automatic alternate can continue

#### Scenario: Hung discovery
- **WHEN** preferred discovery or credential readiness never resolves, even after cancellation
- **THEN** the attempt expires without late dispatch and a usable alternate obtains fresh clocks

#### Scenario: Timeout
- **WHEN** a forced backend exceeds idle or hard expiry
- **THEN** the call resolves with error and does not restart that attempt or dispatch another backend

#### Scenario: Fresh alternate window
- **WHEN** `auto` uses caller overrides `idleTimeoutMs: 30000` and `modelTimeoutMs: 30000`, and native times out
- **THEN** LLM receives its own fresh 30-second idle and hard clocks from admission, not the exhausted native deadline or aborted timeout signal

#### Scenario: Alternate native deadline
- **WHEN** `auto-llm` times out and caller `modelTimeoutMs: 30000` applies to its native alternate
- **THEN** native receives a fresh 30-second hard deadline spanning its setup and classification

#### Scenario: Defaults belong to each backend
- **WHEN** automatic failover occurs without timing overrides
- **THEN** classifier idle is 10,000 ms, LLM idle is 15,000 ms and neither attempt has a hard cap or borrows host HTTP idle settings

#### Scenario: Cancellation wins between attempts
- **WHEN** caller cancellation is observed after primary failure but before alternate admission
- **THEN** the operation resolves aborted without dispatching the alternate

#### Scenario: Timed-out backend resolves late
- **WHEN** a retired primary ignores cancellation and returns after failover begins
- **THEN** it cannot replace the alternate result, publish answers or affect a later call

#### Scenario: Default native silence
- **WHEN** native produces no answer or generation progress for 10,000 ms after admission
- **THEN** it expires and an automatic route can start its unused LLM alternate with a fresh 15,000 ms idle window

#### Scenario: Hard cap survives internal requests
- **WHEN** an LLM has a 20,000 ms hard limit and remains active across setup, several questions and output repair
- **THEN** it expires 20,000 ms after admission, not after its last request or delta

#### Scenario: Alternate keeps its whole budget
- **WHEN** a primary exhausts its hard limit and its alternate has a separately configured 30,000 ms hard limit
- **THEN** the alternate receives 30,000 ms from its own admission without subtracting primary time

### Requirement: Backend selection
Modes SHALL remain `auto`, `auto-llm`, `classifier` and `llm`. `auto` SHALL prefer the selected/default native classifier; `auto-llm` SHALL prefer the independently configured LLM. Forced modes SHALL never switch family. An explicit native model SHALL be honored exactly, including compatible non-Jev classifiers; an unavailable explicit model SHALL NOT be silently replaced by another native model. Omitted native selection SHALL retain existing Jev discovery. The emulation provider SHALL remain excluded from native selection. Compatibility SHALL require the defined answer and numerical-field semantics, not an assumption that every classifier has uniformly calibrated confidence. Availability SHALL come from Pi's registry. LLM model/thinking SHALL NOT inherit main-session settings.

Automatic modes SHALL consider each family at most once, sequentially. Missing/unavailable candidates, discovery/auth/provider errors, invalid output after the allowed repair, confirmed context overflow and timeout SHALL permit the unused alternate. Invalid requests/policy, caller cancellation, navigation and local consumer faults SHALL remain terminal. Valid negative answers and all-dropped native results SHALL count as success. Every alternate SHALL evaluate the complete immutable request, not a partial prefix or suffix. No operation SHALL rewrite settings or pin the last successful family for the next operation. Each attempt SHALL retain its selected full model identity through questions and repair.

#### Scenario: Default auto with Jev available
- **WHEN** mode is auto, no explicit classifier is configured and an available Jev-family model succeeds
- **THEN** it answers with its actual classifier identity and no LLM dispatch

#### Scenario: Explicit non-Jev classifier
- **WHEN** a compatible non-Jev classifier is explicitly configured and available
- **THEN** a native attempt uses that exact model

#### Scenario: Auto without a native candidate
- **WHEN** auto has no usable native candidate and a usable configured LLM
- **THEN** LLM answers and the result identifies it

#### Scenario: Missing explicit model does not select another native model
- **WHEN** an explicit classifier is unavailable but another native model exists
- **THEN** automatic mode can try only its configured LLM alternate and forced classifier mode errors

#### Scenario: Forced classifier with none available
- **WHEN** forced classifier has no usable selected/default native model
- **THEN** it returns error without LLM dispatch

#### Scenario: Emulation is not a native candidate
- **WHEN** the emulation provider appears in classifier listings or is explicitly selected as native
- **THEN** it is excluded and never recursively dispatched as native

#### Scenario: Native failure is not fallback permission
- **WHEN** forced classifier fails authentication, transport or validation
- **THEN** it errors without another native model or LLM attempt

#### Scenario: Native runtime failure permits one LLM attempt
- **WHEN** auto's native attempt fails and its configured LLM succeeds
- **THEN** only the complete LLM answers and actual identity are returned

#### Scenario: Selected identity survives registry changes
- **WHEN** registry results change between questions or during repair
- **THEN** that attempt retains its initially selected backend/model identity

#### Scenario: Auto-llm prefers LLM
- **WHEN** auto-llm has two usable candidates and LLM succeeds
- **THEN** no native inference is dispatched

#### Scenario: Auto-llm with no usable LLM
- **WHEN** auto-llm's LLM is unset, unknown or lacks credentials, and selected/default native is usable
- **THEN** native answers without main-model substitution or disabling default Jev discovery

#### Scenario: LLM runtime failure permits one native attempt
- **WHEN** auto-llm's LLM fails after permitted repair and native succeeds
- **THEN** only native's complete answers and identity are returned

#### Scenario: Both backend attempts fail
- **WHEN** both candidates fail in either automatic mode
- **THEN** error contains no answers and a redacted summary of both outcomes, with neither family tried again

#### Scenario: Forced backend fails
- **WHEN** a forced family fails while the other is usable
- **THEN** the failure remains terminal

#### Scenario: No failover for valid business outcomes
- **WHEN** valid false answers or an all-dropped native result is returned
- **THEN** that successful business outcome is final without consulting the alternate

#### Scenario: Invalid request does not select an alternate
- **WHEN** a request or threshold policy is invalid
- **THEN** neither backend runs inference

#### Scenario: Next call restores configured priority
- **WHEN** a previous call succeeded through fallback
- **THEN** the next call starts with its current configured preference

#### Scenario: Runtime failure and full fallback
- **WHEN** primary fails after answering part of a multi-question request
- **THEN** its alternate evaluates all original questions against the original state once

### Requirement: Backend availability
`availability()` SHALL expose optional `classifier` and `llm` full model references for usable selected/default native and configured chat candidates. It SHALL NOT expose a `jev` compatibility alias or treat an unconfigured LLM as the main-session model.

#### Scenario: Independent candidates
- **WHEN** a native classifier and an independently configured chat model are both usable
- **THEN** availability reports their respective actual references under `classifier` and `llm`

### Requirement: Redaction
State sent to a backend SHALL redact every credential known to the operation. The selected provider's credential resolution and redaction readiness SHALL complete before dispatch under the same attempt timers. The service SHALL use Pi's credential mechanisms, not an independent credential store. Readiness SHALL NOT wait for credential resolution of unrelated providers; it SHALL still redact keys already available in the host/runtime snapshot and selected-provider keys. Errors SHALL be bounded and credential-free, without raw provider bodies. A selected-provider readiness failure SHALL NOT dispatch unsanitized input.

#### Scenario: Key inside state text
- **WHEN** state contains a credential already known to the operation or resolved for its selected provider
- **THEN** the value is replaced before dispatch and is absent from returned errors

#### Scenario: Unrelated provider hangs
- **WHEN** an unrelated provider's authentication would hang but the selected provider is ready
- **THEN** that unrelated lookup does not delay or cause a failure of the judgment

### Requirement: Stateless judgment execution
The service SHALL retain only configuration and active-operation lifecycle state, not completed answers, cross-call pending joins, rejection caches, learned capacity, checkpoints or persistent accounting. Identical calls SHALL perform independent inference. Shutdown/navigation SHALL still cancel owned active operations. Existing session records SHALL remain untouched and SHALL NOT be restored as reusable judgments. Consumers SHALL own durable business state; this service SHALL not execute the business action selected by a judgment.

#### Scenario: Identical independent calls
- **WHEN** two callers request identical judgments
- **THEN** both execute independently and cancelling either does not cancel the other

#### Scenario: Reload with old ledger entries
- **WHEN** a session contains historical `llm-as-jev-ledger` records
- **THEN** the new service neither rewrites/deletes them nor restores their answers or emits replacement ledger entries

### Requirement: Per-call native confidence policy
Native confidence rules SHALL retain choice/score confidence, bool certainty `max(p, 1-p)`, or named-choice probability. Per-question rules SHALL replace, not stack with, `minConfidence`. Invalid rules or missing/invalid required native numerical fields SHALL be rejected rather than guessed. Dropped ids SHALL be absent from answers. LLM answers SHALL ignore numeric thresholds and have no dropped ids because their compatibility numbers are not measured confidence. Without a rule no valid answer SHALL be dropped. Each call SHALL apply policy to its own newly validated inference, with no cached/joined/restored answers.

#### Scenario: Native classifier below threshold
- **WHEN** native confidence is 0.6 under minimum 0.8
- **THEN** the question is dropped and absent from answers

#### Scenario: LLM ignores threshold
- **WHEN** LLM answers under caller minimum 0.8
- **THEN** all valid answers are accepted with no numeric gating

#### Scenario: Named-choice probability threshold
- **WHEN** a per-question rule requires contradicted probability 0.8 and the response has 0.85 with confidence 0.7
- **THEN** it uses 0.85 instead of the default confidence threshold

#### Scenario: Stricter repeat call runs fresh inference
- **WHEN** confidence 0.85 passed threshold 0.8 and an identical later request uses 0.9
- **THEN** the later call runs new inference and applies 0.9 to that new result, without reusing the old answer

### Requirement: Consumer-owned input capacity
Consumers SHALL own factual packing and business subdivision. The service SHALL NOT fragment evidence, automatically subdivide overflowing requests, learn capacity or retain rejected envelopes. Confirmed overflow SHALL permit the unused alternate on complete original input, then return structured failure if no candidate succeeds. Facts SHALL never be cropped or summarized to manufacture success. A terminal error's `contextOverflow` flag SHALL describe its terminal model failure, not a hidden earlier failure or an unrelated error.

#### Scenario: Batch overflow is not subdivided
- **WHEN** a provider rejects an eight-question request for input size
- **THEN** service tries only its unused automatic alternate on complete input or returns overflow, without a subdivision loop

#### Scenario: Irreducible overflow
- **WHEN** one question and its state overflow with no successful alternate
- **THEN** that operation returns structured overflow without resending to the rejecting model; a later independent call is not suppressed by a rejection cache

#### Scenario: Backend-specific limit
- **WHEN** fallback changes from native to an LLM with a different declared window
- **THEN** disclosed capacity belongs to that LLM and does not imply learned prediction or successful fit

#### Scenario: Thinking level changes
- **WHEN** thinking changes from low to high before an identical new judgment
- **THEN** new inference uses high, without reusing a low-thinking answer

#### Scenario: Smaller alternate cannot fit
- **WHEN** the alternate also rejects complete input for size
- **THEN** service returns overflow without cropping facts, borrowing primary limits or cycling back

#### Scenario: Overflow followed by authentication failure
- **WHEN** primary overflows but terminal alternate fails authentication
- **THEN** final error describes authentication and does not authorize consumer overflow retries using a stale overflow flag

### Requirement: Immutable stateless operation configuration
Every `judge()`, availability and capacity query SHALL obtain current global settings at admission. One judgment SHALL freeze mode, both model slots, effective thinking, timeout policies and declared capacity overrides through setup, questions, repair and failover. Explicit caller options SHALL retain precedence. Later saves SHALL affect later operations through existing handles without restarting, cancelling or duplicating admitted work. Inspection SHALL remain free of inference and writes. Review resumes, checkpoints, cache invalidation and cross-call joining SHALL NOT be part of configuration refresh.

#### Scenario: Existing service handle observes the next save
- **WHEN** a retained v2 handle is called after a settings save
- **THEN** it uses the new selection without reload and reports the actual answering identity

#### Scenario: Judgment spans an external edit
- **WHEN** settings change from X to Y between questions or during repair
- **THEN** admitted work retains X and the edit sends no replacement request

#### Scenario: New call overlaps old work
- **WHEN** an X call is running and another starts after Y is saved
- **THEN** each keeps its own settings and cancellation without sharing inference

#### Scenario: Edit during backend discovery
- **WHEN** settings change during discovery or authentication
- **THEN** selection, timing, thinking and result identity retain the admitted snapshot

#### Scenario: Failure retains the operation identity
- **WHEN** a call admitted with X fails after Y is saved
- **THEN** its diagnostic identifies X's candidates, not Y's unrelated models

#### Scenario: Availability is independently fresh
- **WHEN** model slots change before availability or capacity inspection
- **THEN** inspection uses current selection without a priming judgment or settings mutation

#### Scenario: Configured timeout and limits change
- **WHEN** new idle/hard settings or declared capacity overrides change
- **THEN** later calls observe them, caller overrides retain precedence and earlier calls keep their snapshot for both attempts

#### Scenario: Unchanged settings still require independent inference
- **WHEN** repeated calls have identical effective settings and input
- **THEN** each performs new inference without a branch reset or cross-call join

#### Scenario: Failover ignores an intervening settings save
- **WHEN** a call captures X and Y changes its alternate model before fallback
- **THEN** fallback uses X's model, thinking, timing and capacity; the next call observes Y

### Requirement: Stateless failover result isolation
Accepted answers, dropped ids, backend/model and capacity SHALL belong solely to the terminal attempt. Alternate success SHALL replace rather than merge primary partial answers and SHALL have no primary terminal error. Both-failed outcomes SHALL have empty answers and a bounded redacted summary of both candidates. Optional usage SHALL retain its stated reporting scope without implying complete transport billing across failures. Read-only queries SHALL describe the first usable candidate, not promise inference success. Historical judgments/checkpoints SHALL never seed an alternate. Cancellation SHALL remain local to each independent caller.

#### Scenario: Partial primary results are not merged
- **WHEN** primary answers A but fails B and alternate answers both
- **THEN** both final answers, policy and identity belong solely to alternate

#### Scenario: Confidence follows the answering backend
- **WHEN** fallback moves native to LLM with numeric thresholds configured
- **THEN** LLM ignores them; reverse fallback applies native thresholds

#### Scenario: Historical alternate answer is not reused
- **WHEN** a prior session has a matching alternate-model judgment
- **THEN** fallback still runs fresh inference without restoring history

#### Scenario: Usage does not fabricate attempt coverage
- **WHEN** fallback succeeds after primary did observable work
- **THEN** final answers describe alternate and any usage names its reporting scope, without claiming complete billing or observation coverage

#### Scenario: Query and execution differ after failure
- **WHEN** a query reports primary and subsequent inference fails over
- **THEN** query ran no inference and result identifies actual alternate and capacity

#### Scenario: Failure message remains private
- **WHEN** both providers fail with credentials or raw bodies in their errors
- **THEN** combined error identifies outcomes without exposing that content

#### Scenario: Legacy checkpoint input is rejected before dispatch
- **WHEN** a caller supplies a removed checkpoint seed
- **THEN** request validation rejects it before either backend runs and directs the caller to submit complete state without the legacy option

#### Scenario: Independent caller cancellation remains local
- **WHEN** two identical calls run and one cancels
- **THEN** that call aborts without fallback while the other keeps its own completion and fallback eligibility
