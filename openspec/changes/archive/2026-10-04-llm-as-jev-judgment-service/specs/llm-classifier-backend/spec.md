## Purpose

Lets an independently configured tool-calling chat model answer Pi-shaped classifier questions with discrete business decisions and explicit compatibility encodings, so judgment works when the selected/default native classifier is unavailable.

## ADDED Requirements

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
The backend SHALL obtain a discrete answer through a tool call whose schema constrains the allowed labels. A choice selects one criteria key, a bool selects true or false, and a score selects one integer level. The model SHALL NOT be asked to generate probability or confidence percentages. A response with no tool call, an unknown label, or malformed arguments SHALL be retried once and then reported as `stopReason: "error"` rather than guessed. Authentication, transport, caller-abort or deadline failures SHALL NOT be treated as malformed-output retries and SHALL resolve as structured errors/aborts, never rejected promises.

#### Scenario: Model replies in prose
- **WHEN** the model returns text without the expected tool call
- **THEN** the backend retries once and, on a second failure, returns `stopReason: "error"` with no answers

#### Scenario: Unknown label
- **WHEN** the tool call names a choice key that is not in the question's criteria
- **THEN** the answer is rejected and handled as a malformed response

#### Scenario: Authentication or transport failure
- **WHEN** streaming throws synchronously or its result rejects asynchronously
- **THEN** the backend resolves a structured error with no answers and sends no malformed-output retry

#### Scenario: Special choice key
- **WHEN** the selected legal choice key is `__proto__`
- **THEN** the locally encoded probabilities retain that own key, all legal keys and sum 1 without changing the map prototype

### Requirement: Thinking level pass-through
The backend SHALL clamp the configured thinking level using Pi's own supported-level logic and send the effective reasoning level; when `off` is supported and selected, it SHALL send no reasoning request in Pi's provider-neutral simple API.

#### Scenario: Supported off
- **WHEN** the configured level is `off` and the model supports `off`
- **THEN** the request carries no reasoning effort

#### Scenario: Unsupported level
- **WHEN** the configured level is `xhigh` and the model supports only up to `high`
- **THEN** the request is sent with `high`

### Requirement: Registered as a Pi classifier provider
The extension SHALL register a classifier provider whose single classifier model reflects the configured chat model, so that `getAvailableOfType("classifier")` lists it whenever an LLM model is configured and the underlying chat model's provider has usable credentials, and `modelRegistry.classify()` on it yields the same result as the service's LLM backend. The classifier model's `contextWindow` SHALL equal the configured chat model's context window. When no LLM model is configured, the provider SHALL expose no classifier models.

#### Scenario: Visible to codemode
- **WHEN** an LLM model is configured and its provider has credentials
- **THEN** a codemode script calling `models.getAvailableOfType("classifier")` sees the emulated classifier and can `classify()` with it

#### Scenario: Unconfigured
- **WHEN** no LLM model is configured
- **THEN** the provider lists no classifier models

#### Scenario: Reconfigured at runtime
- **WHEN** the user changes the configured chat model
- **THEN** the registered emulated classifier reflects the new model and dispatches to it immediately without restarting or reloading Pi

#### Scenario: Independent classifier setting
- **WHEN** only the native `classifierModel` changes
- **THEN** the emulated model identity and its underlying chat model/thinking remain unchanged

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
