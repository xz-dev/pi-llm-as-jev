## MODIFIED Requirements

### Requirement: Registered as a Pi classifier provider
The extension SHALL register a classifier provider whose single classifier model reflects the configured chat model, so that `getAvailableOfType("classifier")` lists it whenever an LLM model is configured and the underlying chat model's provider has usable credentials, and `modelRegistry.classify()` on it yields the same result as the service's LLM backend. The classifier model's `contextWindow` SHALL equal the configured chat model's context window. When no LLM model is configured, the provider SHALL expose no classifier models.

Provider model-metadata queries, availability/authentication checks and classification invocations SHALL each use current global file settings for that operation. Metadata and availability operations SHALL NOT write settings, run paid inference or expose chat models through this classifier provider.

Each classification SHALL freeze its configured chat model, effective thinking and applicable timeout for the whole invocation, including any output-repair retry. The applicable timeout (caller-supplied, else configured) SHALL be a per-request transport-inactivity window: it bounds the wait for the first response and is reset by any response bytes (visible text, reasoning deltas, tool-argument deltas, keepalives) and by provider stream events; it SHALL NOT be passed to the chat provider as a whole-request timeout; a caller-supplied fetch or stream observer SHALL be composed with, not replaced by, the inactivity observer. An unavailable or removed current target SHALL produce a structured error rather than dispatch to the descriptor's old target, the main-session model or a native classifier.

#### Scenario: Visible to codemode
- **WHEN** an LLM model is configured and its provider has credentials
- **THEN** a codemode script calling `models.getAvailableOfType("classifier")` sees the emulated classifier and can `classify()` with it

#### Scenario: Unconfigured
- **WHEN** no LLM model is configured
- **THEN** the provider lists no classifier models

#### Scenario: Reconfigured at runtime
- **WHEN** the user changes the configured chat model in this session or another session sharing the configuration file
- **THEN** the next emulated-provider operation reflects the new configuration without restarting or reloading Pi, while already-running classifications keep their previous snapshot

#### Scenario: Independent classifier setting
- **WHEN** only the native `classifierModel` changes
- **THEN** the emulated model identity and its underlying chat model/thinking remain unchanged

#### Scenario: Public model listing is the first operation after a save
- **WHEN** A changes the configured chat model from X to Y and B's next operation is a public classifier-model listing
- **THEN** B lists Y's emulated identity and context window, not X's, without a preparatory plugin command or classification

#### Scenario: Current credential availability
- **WHEN** A changes the configured chat target to a provider without usable credentials and B next queries classifier availability
- **THEN** B does not advertise a usable emulated classifier based on the old target's credentials and sends no inference request

#### Scenario: Previously obtained descriptor
- **WHEN** B retains an emulated-model descriptor for X, A saves a usable target Y, and B starts classification with its retained descriptor
- **THEN** the operation uses Y's configured model/thinking and reports Y's actual full model reference without requiring B to reconfigure the plugin

#### Scenario: Removed target with a retained descriptor
- **WHEN** the current LLM target is removed or unavailable after B obtained a descriptor
- **THEN** a new classification through that descriptor resolves a structured error without invoking its former chat target or another backend

#### Scenario: In-flight emulated classification
- **WHEN** the file changes after an emulated classification begins but before a response or output-repair retry completes
- **THEN** its dispatches and result identity retain the initial snapshot and no request is restarted merely because of the edit

#### Scenario: Model removal and restoration
- **WHEN** another session removes the LLM model and later saves a usable model again
- **THEN** successive public classifier-list operations expose zero and then one current emulated model without restarting or reloading the receiving session

#### Scenario: Reasoning-only activity
- **WHEN** the chat model emits only reasoning deltas for longer than the inactivity window before any visible text
- **THEN** the classification is not timed out

#### Scenario: Composed observer
- **WHEN** the caller passes its own `fetch` and `onProviderStreamEvent`
- **THEN** both the caller's observers and the inactivity clock see every event
