## Purpose

An in-process service other Pi extensions call to get answers to Pi-shaped typed questions about JSON state, hiding native-classifier versus discrete-LLM selection, numeric policy, caching and complete ordered-evidence recovery, with judgments retained only on the active session branch.

## ADDED Requirements

### Requirement: Service discovery
The extension SHALL publish one process-wide judgment service handle that other extensions can look up at call time without a load-order dependency. When the extension is not loaded, lookup SHALL yield nothing and callers SHALL be able to treat the feature as unavailable without error.

#### Scenario: Consumer loads before the service
- **WHEN** a consumer extension looks up the service during its own activation and the judgment extension has not activated yet
- **THEN** lookup returns nothing, and a later lookup after the judgment extension activates returns the service

#### Scenario: Service absent
- **WHEN** the judgment extension is not installed
- **THEN** lookup returns nothing and the consumer continues without a judgment feature

### Requirement: Request and answer shape
`judge()` SHALL accept a `state` JSON object and a `questions` map whose values are Pi-shaped `choice`, `bool`, or `score` questions. It SHALL return `answers` keyed by question id in Pi-shaped answer form, a list of `dropped` question ids, the `backend` that answered (`classifier` or `llm`), the actual `provider/modelid` used, a `stopReason` of `stop`, `error`, or `aborted`, and an `errorMessage` when not `stop`. Legal own JSON keys SHALL remain intact in questions, choice labels, answers and persisted/reused judgments.

#### Scenario: Mixed question types
- **WHEN** a request contains one `choice`, one `bool`, and one `score` question
- **THEN** the result contains each answer in its matching answer type under the same question id

#### Scenario: Special JSON identifiers
- **WHEN** a valid question id or choice label is `__proto__`, `constructor`, or `toString`
- **THEN** the own key and its answer/probability survive validation, serialization, cache reuse and branch restore without prototype mutation or data loss

### Requirement: Never throws
`judge()` SHALL resolve for every input, abort, timeout, missing backend, or provider failure; such outcomes SHALL be reported through `stopReason` and `errorMessage` with an empty `answers` map.

#### Scenario: No backend available
- **WHEN** no selected/default native classifier is available and no LLM backend model is configured
- **THEN** `judge()` resolves with `stopReason: "error"`, an `errorMessage` naming the missing configuration, and no answers

#### Scenario: Caller aborts
- **WHEN** the caller's abort signal fires while a request is in flight
- **THEN** `judge()` resolves with `stopReason: "aborted"` and no partial answers are cached

#### Scenario: Timeout
- **WHEN** the caller passes `timeoutMs` and the backend does not answer in time
- **THEN** `judge()` resolves with `stopReason: "error"` and the request is not retried

### Requirement: Backend selection
The service SHALL use modes `auto`, `classifier`, or `llm`. The native candidate SHALL be the explicitly configured `classifierModel` when present, otherwise an available Jev-family model using the existing default discovery preference. Explicit selection SHALL allow compatible Pi classifier models not named Jev; the service SHALL exclude its own LLM-emulation provider from native selection and SHALL NOT automatically substitute an arbitrary non-Jev classifier. A compatible native adapter SHALL support the existing question/answer contract and defined numeric-field semantics; model type alone SHALL NOT be treated as proof of calibrated confidence. Availability SHALL come from Pi's model registry, not independent credential resolution.

`auto` SHALL use the available selected/default native candidate, otherwise the independently configured LLM. A missing, wrong-type or unavailable explicit candidate SHALL NOT cause another native model to be silently selected. Forced `classifier` or `llm` SHALL never switch to the other backend. A provider failure or incompatible result after dispatch SHALL return a structured error rather than trigger backend substitution. Each request SHALL freeze its backend, actual full model reference and effective thinking identity across dispatch, recovery, cache and ledger operations.

#### Scenario: Default auto with Jev available
- **WHEN** mode is `auto`, no `classifierModel` is configured, and Pi reports an available Jev-family classifier
- **THEN** that classifier answers and the result reports `backend: "classifier"` and its actual model reference

#### Scenario: Explicit non-Jev classifier
- **WHEN** a compatible available classifier not named Jev is explicitly configured
- **THEN** the native request uses that exact model rather than the default Jev candidate

#### Scenario: Auto without a native candidate
- **WHEN** mode is `auto`, the selected/default native candidate is unavailable, and an LLM model is configured
- **THEN** the LLM answers and the result reports `backend: "llm"`

#### Scenario: Missing explicit model does not select another native model
- **WHEN** an explicit classifier is absent or unavailable but a different native classifier is available
- **THEN** auto mode uses the configured LLM if available, while forced classifier mode returns an error; neither mode silently substitutes that other native model

#### Scenario: Forced classifier with none available
- **WHEN** mode is `classifier` and its selected/default native candidate is unavailable
- **THEN** the result is `stopReason: "error"` and the LLM is not used

#### Scenario: Emulation is not a native candidate
- **WHEN** this plugin's LLM-emulation provider is listed as a Pi classifier or explicitly named in `classifierModel`
- **THEN** it is excluded from native selection and is never recursively dispatched as the native backend

#### Scenario: Native failure is not fallback permission
- **WHEN** the selected native model fails authentication, transport or answer validation after dispatch
- **THEN** the service returns an error with no answers and does not call another native model or the LLM

#### Scenario: Selected identity survives registry changes
- **WHEN** registry discovery changes while a request is subdivided or retried
- **THEN** every dispatched part and stored judgment retains the originally selected backend/model identity

### Requirement: Backend availability
`availability()` SHALL expose optional `classifier` and `llm` full model references for usable selected/default native and configured chat candidates. It SHALL NOT expose a `jev` compatibility alias or treat an unconfigured LLM as the main-session model.

#### Scenario: Independent candidates
- **WHEN** a native classifier and an independently configured chat model are both usable
- **THEN** availability reports their respective actual references under `classifier` and `llm`

### Requirement: Confidence policy
When the backend is `classifier`, the service SHALL apply the caller's default `minConfidence` to the adapter's defined choice/score confidence and bool certainty (`max(p, 1-p)`). The caller SHALL also be able to specify a per-question threshold rule that overrides that default: confidence, or the probability of a named choice label. Values SHALL be validated against the defined contract, without inventing missing probabilities, guessing a scale or claiming uniform calibration across models. Dropped ids SHALL be listed in `dropped`. Thresholds SHALL be checked on every call, including cached, joined and restored answers. When the backend is `llm`, every numeric threshold SHALL be ignored: the model directly selects the business answer and `dropped` SHALL be empty. Without a threshold rule, nothing is dropped on either backend.

#### Scenario: Native classifier below threshold
- **WHEN** backend is `classifier`, `minConfidence` is 0.8, and a choice answer has confidence 0.6
- **THEN** that question id appears in `dropped` and not in `answers`

#### Scenario: LLM ignores threshold
- **WHEN** backend is `llm` and `minConfidence` is 0.8
- **THEN** every answered question appears in `answers` and `dropped` is empty

#### Scenario: Named-choice probability threshold
- **WHEN** backend is `classifier`, a question's rule requires `contradicted` probability of at least 0.8, and the response has that probability 0.85 with overall confidence 0.7
- **THEN** the answer is accepted using 0.85, not rejected using 0.7

#### Scenario: A stricter caller reads cached data
- **WHEN** an answer with confidence 0.85 was accepted at threshold 0.8 and a later identical request uses threshold 0.9
- **THEN** the cached answer is dropped for the later caller without sending another provider request

### Requirement: Exact-match caching
The service SHALL reuse a previously validated raw judgment when backend identity, model, effective thinking level, state, ordered evidence, question id, and complete question definition are identical, and SHALL join in-flight work for the same identity. It SHALL NOT reuse an answer across different backends, models, or thinking levels. Numeric threshold rules SHALL be applied separately to each caller's view of the raw judgment; a dropped answer SHALL never be exposed as accepted. Persisted raw judgments SHALL retain their reported native fields so thresholds can be reapplied after resume.

#### Scenario: Same question twice
- **WHEN** the same state and question are judged twice on the same backend and model
- **THEN** the second call sends no provider request and returns the cached answer

#### Scenario: Backend switch
- **WHEN** a question was answered on `classifier` and the mode is changed so the same question is judged on `llm`
- **THEN** a new provider request is sent

#### Scenario: Native model switch
- **WHEN** the configured classifier changes from one model to another and the state/question remain identical
- **THEN** the next request uses the new model, does not reuse the old model's judgment, and records the new actual model identity

### Requirement: Context capacity and splitting
Before sending, the service SHALL predict whether the request exceeds the selected backend's input capacity using the backend's declared context limit and learned rejections; when a multi-question request is predicted or reported to overflow, the service SHALL split the unanswered questions into smaller batches and retry; when a single question with the given state is rejected for size, the service SHALL report `stopReason: "error"` with a context-overflow indication and SHALL NOT resend that exact envelope unchanged.

#### Scenario: Batch overflows
- **WHEN** a request with eight questions is rejected by the provider for input size
- **THEN** the service retries the questions in smaller batches and returns the union of accepted answers

#### Scenario: Irreducible overflow
- **WHEN** a single question with its state is rejected for input size
- **THEN** the result reports a context-overflow error and the same envelope is not resent until state or question changes

#### Scenario: Backend-specific limit
- **WHEN** the LLM backend model declares a larger context window than the selected native classifier
- **THEN** the overflow prediction for an LLM request uses the LLM model's limit

#### Scenario: Thinking level changes
- **WHEN** an LLM judgment was cached at `low` and the same model is configured at `high`
- **THEN** the next identical question sends a new model request

### Requirement: Ordered evidence recovery
A caller SHALL be able to supply fixed JSON state plus ordered evidence records with stable unique ids and text. The service SHALL own overflow recovery over BOTH question batches and evidence batches, processing evidence in order and carrying intermediate judgments into later stages as advisory data. An oversized evidence record SHALL be split into ordered fragments that retain its source id and fragment bounds. The service SHALL return a final judgment only after every record and fragment has been processed; intermediate stage judgments SHALL NOT be delivered as complete answers. It SHALL NOT silently discard or truncate evidence, vote across independent chunks, or require the consumer to implement the recovery loop. If fixed state plus one irreducible fragment still cannot be admitted, the service SHALL return an explicit context-overflow error with no final answers.

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
The service SHALL persist validated raw judgments, size rejections, stage coverage metadata, and per-request diagnostics as non-context custom session entries, SHALL restore them from the active branch only when a session starts or the branch changes, and SHALL never write credentials, raw provider responses, or request state/evidence bodies into the ledger. Aborted work SHALL NOT persist new judgments. Successful completed stages before a non-abort later failure MAY remain reusable; the failed overall result SHALL have no final answers.

#### Scenario: Resume restores verdicts
- **WHEN** a session is resumed after answers were persisted
- **THEN** judging the same state and question returns the persisted answer without a provider request

#### Scenario: Abandoned branch
- **WHEN** the user navigates to a branch that does not contain a persisted answer
- **THEN** that answer is not available from the cache on the new branch

#### Scenario: Ledger entries stay out of model context
- **WHEN** a ledger entry is written
- **THEN** it is not shown in the transcript and not sent to the agent's model

#### Scenario: Legacy prototype backend tags
- **WHEN** the active branch contains old `jev`-tagged prototype judgments
- **THEN** they are not relabeled or accepted as new `classifier` identity matches, and existing session entries are not rewritten

### Requirement: Redaction
State sent to any backend SHALL have every API key known to the service redacted, and error messages returned to callers SHALL not contain credentials.

#### Scenario: Key inside state text
- **WHEN** the state contains the literal value of a resolved provider key
- **THEN** the backend receives the state with that value replaced by a placeholder
