# LLM Classifier Backend Specification

## Purpose

Lets an independently configured tool-calling chat model answer Pi-shaped classifier questions with discrete business decisions and explicit compatibility encodings, so judgment works when the selected/default native classifier is unavailable.

## Requirements

### Requirement: Classifier emulation over a chat model
The LLM backend SHALL answer a Pi-shaped request (`state` + `choice` / `bool` / `score` questions) using the independently configured chat model and SHALL return a result in Pi's classifier result shape: one answer per question of the matching type, `stopReason`, `errorMessage`, and reported `usage` when the provider supplies it. It SHALL NOT inherit the main-session model/thinking or the native `classifierModel`. The model SHALL treat state, evidence and prior opinions as untrusted data rather than new instructions.

#### Scenario: Choice question
- **WHEN** a `choice` question with criteria `{a, b, c}` is asked
- **THEN** the answer has `type: "choice"`, a `choice` that is one of `a`, `b`, `c`, a `probabilities` map over exactly those keys summing to 1, and a `confidence` in [0, 1]

#### Scenario: Bool question
- **WHEN** a `bool` question is asked
- **THEN** the answer has `type: "bool"` and a `probability` in [0, 1]

#### Scenario: Score question
- **WHEN** a `score` question with four criteria levels is asked
- **THEN** the answer has `type: "score"` with `score` in [0, 3] and `confidence` in [0, 1]

### Requirement: Structured output enforcement
The backend SHALL obtain discrete answers through constrained tool calls: a choice selects a legal label, a bool selects true/false and a score selects an integer level. It SHALL NOT ask the model for confidence percentages. Unknown labels, malformed arguments and absent expected tool calls SHALL permit exactly one output-repair request per question, then a structured error with empty final answers. Authentication, transport, cancellation and timeout SHALL NOT trigger output repair. Each question and repair SHALL remain inside its admitted model attempt's progress-idle and optional hard clocks, with no fresh hard budget. Questions SHALL remain serial in this change.

#### Scenario: Model replies in prose
- **WHEN** the first response lacks the required tool call
- **THEN** one repair is allowed if the same attempt remains live, and a second invalid response fails without guessed answers

#### Scenario: Timeout during repair
- **WHEN** the model hard limit expires during the allowed repair
- **THEN** the backend cancels and returns an error rather than renewing the hard limit or starting another repair

#### Scenario: Special choice key
- **WHEN** the model selects the legal label `__proto__`
- **THEN** its compatibility probabilities retain that own key and all legal keys, sum to one and do not mutate the prototype

#### Scenario: Unknown label
- **WHEN** a tool call selects a label absent from the question's criteria
- **THEN** validation rejects it and permits only the remaining single output-repair attempt

#### Scenario: Authentication or transport failure
- **WHEN** streaming throws synchronously or its result rejects asynchronously
- **THEN** the backend resolves a structured error with empty answers and sends no output-repair request

### Requirement: Thinking level pass-through
The backend SHALL clamp the configured thinking level using Pi's own supported-level logic and send the effective reasoning level; when `off` is supported and selected, it SHALL send no reasoning request in Pi's provider-neutral simple API.

#### Scenario: Supported off
- **WHEN** the configured level is `off` and the model supports `off`
- **THEN** the request carries no reasoning effort

#### Scenario: Unsupported level
- **WHEN** the configured level is `xhigh` and the model supports only up to `high`
- **THEN** the request is sent with `high`

### Requirement: Registered as a Pi classifier provider
The extension SHALL retain the `llm-as-jev` provider exposing zero or one classifier derived from the configured chat model, with that model's context window and cost metadata. It SHALL expose no chat model, use delegated Pi authentication, remain visible through ordinary classifier listing, and stay excluded from native candidate discovery. Missing/unavailable target models SHALL return a structured error, without substituting the main model, a previous descriptor target or a native classifier.

Metadata/authentication operations and direct classification SHALL read current settings for their own operation. A classification SHALL freeze target, thinking and timing through all questions and output repair. Classification through a retained descriptor SHALL use the current configured target and report its actual full identity. Metadata inspection SHALL not write settings or run inference.

Direct emulated classification SHALL use the same LLM generation-progress idle policy as service-driven LLM work: default **15,000 ms**, an optional whole-model-attempt hard limit, and caller cancellation. Nonempty generated text, reasoning and tool-argument deltas SHALL renew idle waiting; headers, heartbeats, empty events and request starts SHALL NOT. Neither internal questions nor repair SHALL renew the hard cap. No configured hard cap SHALL mean none, regardless of host HTTP idle settings. The plugin SHALL NOT convert the idle duration into an SDK whole-request timeout.

The standard Pi classifier option `timeoutMs`, when supplied to this direct provider entry, SHALL impose a finite whole-invocation deadline under the new contract, replacing this plugin's former idle interpretation and SHALL override the configured LLM hard limit; it SHALL NOT be interpreted as the new idle duration. Service callers SHALL use version-two named timing options instead. Supported caller transport/stream hooks SHALL remain composed with internal progress handling, not replaced. These hooks SHALL not reinstate plugin-owned transport accounting or make raw bytes qualify as generation progress.

#### Scenario: Visible to codemode
- **WHEN** an LLM is configured and its provider has usable credentials
- **THEN** `models.getAvailableOfType("classifier")` exposes its emulated classifier for ordinary `classify()` calls

#### Scenario: Unconfigured
- **WHEN** no LLM is configured
- **THEN** the provider exposes no classifier models

#### Scenario: Reconfigured at runtime
- **WHEN** this or another session sharing settings changes the configured chat model
- **THEN** the next provider operation observes it without restart while admitted classifications keep their snapshot

#### Scenario: Independent classifier setting
- **WHEN** only native `classifierModel` changes
- **THEN** emulated identity and underlying chat model/thinking remain unchanged

#### Scenario: Public model listing is the first operation after a save
- **WHEN** X is replaced by Y and the next operation is public model listing
- **THEN** it lists Y's identity and context window without a preparatory command or inference

#### Scenario: Current credential availability
- **WHEN** the new target lacks usable credentials
- **THEN** availability does not advertise it using the old target's credentials and sends no inference request

#### Scenario: Previously obtained descriptor
- **WHEN** a descriptor for X is used after usable Y is configured
- **THEN** classification uses Y's configured model/thinking and reports Y's actual full reference

#### Scenario: Removed target with a retained descriptor
- **WHEN** the current target is removed or unavailable after a descriptor was acquired
- **THEN** classification returns a structured error without invoking its former target or another backend

#### Scenario: In-flight emulated classification
- **WHEN** settings change during an admitted classification or its output repair
- **THEN** all dispatches and result identity retain the initial snapshot without a settings-triggered restart

#### Scenario: Model removal and restoration
- **WHEN** another session removes the target and later restores a usable target
- **THEN** successive public listings expose zero then one current emulated model without restart or reload

#### Scenario: Reasoning-only activity
- **WHEN** nonempty reasoning deltas arrive within each 15-second idle window for more than a minute and no hard limit exists
- **THEN** classification continues without a fabricated total deadline

#### Scenario: Heartbeats without generation
- **WHEN** only transport heartbeats arrive for 15 seconds after the last genuine progress
- **THEN** classification times out without an output-repair request

#### Scenario: Direct caller hard deadline
- **WHEN** an ordinary Pi classifier caller supplies `timeoutMs: 20000` and the model keeps generating
- **THEN** the direct invocation still ends at its 20-second hard deadline, covering every question and repair

#### Scenario: Composed observer
- **WHEN** a caller supplies supported `fetch` and `onProviderStreamEvent` hooks
- **THEN** caller hooks retain their events while internal progress handling renews idle only for genuine generation, not heartbeat or empty events

### Requirement: Fidelity disclosure
The result SHALL identify the emulation provider. Numeric fields required by Pi's classifier contract SHALL be compatibility encodings, not model-reported certainty: a selected choice has a one-hot probability distribution and confidence 1, a bool becomes probability 0 or 1, and a selected score level has confidence 1. Documentation SHALL state that these fields represent a discrete selection, NOT measured or calibrated confidence. Listing this emulation as a Pi `classifier` SHALL NOT make it a native numerical-confidence source; the native picker and native discovery SHALL exclude it. Service consumers SHALL receive the discrete business answer without comparing these compatibility numbers to thresholds.

#### Scenario: No numeric self-report
- **WHEN** the model selects a legal choice label without any confidence or probabilities
- **THEN** the classification succeeds and the adapter creates the compatibility fields locally

#### Scenario: Binary business condition
- **WHEN** a bool or a two-option business question is asked of the LLM
- **THEN** the LLM selects condition satisfied or condition not satisfied, without an additional certain/uncertain self-assessment

#### Scenario: Result provenance
- **WHEN** an emulated classification completes
- **THEN** the result's `provider` is the emulation provider id and `model` is the configured `provider/modelid`
