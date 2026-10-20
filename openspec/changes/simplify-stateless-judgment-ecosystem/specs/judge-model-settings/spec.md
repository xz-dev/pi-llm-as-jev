## MODIFIED Requirements

### Requirement: Configuration file
Settings SHALL remain in Pi's agent-directory `llm-as-jev.json`, read afresh at each configuration-dependent operation. `mode` SHALL remain `auto` by default with `auto-llm`, `classifier` and `llm` alternatives. Independent `classifierModel`, chat `model`, `thinkingLevel` and exact-model `contextLimits` overrides SHALL remain supported. Model references SHALL split at the first slash; neither slot nor thinking SHALL inherit main-session settings. Missing native selection SHALL retain default Jev discovery, while explicit unknown selections SHALL stay unavailable instead of selecting another native model.

Timing SHALL be represented by optional `timeouts.classifier` and `timeouts.llm` objects, each containing optional `idleTimeoutMs` and `modelTimeoutMs`. Idle defaults SHALL be classifier **10,000 ms** and LLM **15,000 ms**. A missing `modelTimeoutMs` SHALL mean no hard limit. Supplied values SHALL be positive integers within the platform timer range. No combined-operation limit or host-HTTP-default inheritance SHALL be introduced. An explicit per-call option SHALL override that field for each model attempt independently. Configuration SHALL be frozen for admitted work and reread for later calls; runtime fallback SHALL not mutate settings.

The legacy top-level `timeoutMs` SHALL be recognized as requiring migration, not ignored as an unknown key or silently interpreted under different semantics. While it remains present, inference SHALL return an actionable configuration error without dispatch; read-only status SHALL identify the field and required explicit replacement. Settings inspection SHALL not rewrite the file. Users SHALL explicitly choose an idle override, a hard limit, or both when migrating; removing the legacy field uses the new defaults. No hard limit SHALL be inferred from an old value.

For other malformed known fields or unreadable files, the existing all-known-fields-default behavior and once-per-session diagnostic SHALL remain; a missing file SHALL use defaults without warning. Unknown unrelated keys SHALL survive atomic patch saves. Error suppression SHALL not prevent rereading a repaired file. Shared-agent-directory sessions SHALL see completed saves on their next operation without polling, restart or reload; separate directories SHALL remain isolated. Confirmed model/mode saves SHALL preserve unrelated settings, including timeout slots, and cancellation SHALL not overwrite another session's save.

#### Scenario: Omitted timing settings
- **WHEN** a valid configuration has no timeout objects
- **THEN** native idle is 10,000 ms, LLM idle is 15,000 ms and both hard limits are absent

#### Scenario: LLM-only hard limit
- **WHEN** only `timeouts.llm.modelTimeoutMs` is set to 45000
- **THEN** LLM attempts have a 45-second hard cap, native attempts remain uncapped, and idle defaults remain 10 and 15 seconds respectively

#### Scenario: Caller override through fallback
- **WHEN** a caller supplies `idleTimeoutMs: 5000` and `modelTimeoutMs: 20000`
- **THEN** each attempted family independently gets those values from its own admission, with no shared 20-second deadline

#### Scenario: Legacy timeout migration
- **WHEN** the configuration contains top-level `timeoutMs`, including alongside new fields
- **THEN** status explains the required migration and inference sends nothing until the ambiguity is removed, without rewriting settings or silently setting a hard cap

#### Scenario: Invalid new timing value
- **WHEN** a new timeout field is zero, negative, fractional or outside the timer range
- **THEN** it follows the existing invalid-known-settings diagnostic/default behavior rather than disabling a timer

#### Scenario: Independent slots and slash-containing model
- **WHEN** the file contains native and LLM selections and a chat reference `provider/family/model`
- **THEN** the full model id is `family/model`, each slot remains independent and no main-session setting changes

#### Scenario: Live settings and recovery
- **WHEN** another session sharing the directory saves new settings or repairs an invalid file
- **THEN** the next operation observes them without restarting, while admitted work retains its earlier snapshot

#### Scenario: Explicit unknown model
- **WHEN** either explicit model reference is syntactically valid but unavailable
- **THEN** it remains unavailable; it is not erased, replaced by another same-family model or inherited from the main session

#### Scenario: Missing file or separate directory
- **WHEN** the file is removed, or another session saves into a different agent directory
- **THEN** the first case uses defaults without rewriting a file, and the second case leaves this session's configuration unchanged

#### Scenario: Atomic unrelated save
- **WHEN** a picker confirms an LLM model after another session changed native timeout settings
- **THEN** the save preserves those timeout settings and unrelated keys; cancellation writes nothing and failed persistence publishes no tentative configuration

#### Scenario: Valid file
- **WHEN** the file sets `model: "anthropic/claude-sonnet-4-5"` and `thinkingLevel: "low"`
- **THEN** an LLM attempt uses that model with low reasoning and the applicable explicit/default timing settings

#### Scenario: Independent native selection
- **WHEN** the file also sets a compatible non-Jev `classifierModel`
- **THEN** native requests use that classifier without changing LLM model or thinking

#### Scenario: Unknown chat model id
- **WHEN** the configured chat model is absent from Pi's catalog
- **THEN** it remains unavailable, the bounded diagnostic is shown and the main-session model is not substituted

#### Scenario: Unknown explicit classifier id
- **WHEN** an explicit native reference is unavailable but another native model exists
- **THEN** the reference remains selected; automatic mode can try its LLM alternate and forced mode errors

#### Scenario: Invalid known field with otherwise valid fields
- **WHEN** a file has a valid chat reference but a malformed new timing field, mode or thinking level
- **THEN** all known settings use defaults and the invalid-file diagnostic is bounded to once per session

#### Scenario: Unreadable file
- **WHEN** reading settings fails for a reason other than absence
- **THEN** loading uses defaults without throwing and reports the failure once per session

#### Scenario: Model id contains a slash
- **WHEN** the model reference is `provider/family/model`
- **THEN** provider is `provider` and model id is `family/model`

#### Scenario: Clear explicit classifier
- **WHEN** `classifierModel` is removed from a valid file during a session
- **THEN** the next native selection uses default Jev discovery without changing LLM settings or reloading

#### Scenario: Hand edit
- **WHEN** an external edit completes before a new operation
- **THEN** that operation observes it without a settings command or restart

#### Scenario: Two already-running sessions
- **WHEN** sessions A and B share an agent directory and A completes a save
- **THEN** B's next configuration-dependent operation observes that save without reconfiguration

#### Scenario: Invalid configuration after a valid operation
- **WHEN** previously valid settings become unreadable or invalid, excluding the explicit legacy migration case
- **THEN** the next operation uses defaults rather than stale or partially accepted settings

#### Scenario: Recovery after a reported error
- **WHEN** an invalid or migration-required file is repaired after its diagnostic was shown
- **THEN** subsequent operations read the repaired settings despite diagnostic suppression

#### Scenario: File removed after initial configuration
- **WHEN** the configured file is removed
- **THEN** subsequent operations use defaults without writing a replacement

#### Scenario: Independent agent directories
- **WHEN** a different agent directory receives a settings save
- **THEN** this session continues to read only its own directory

#### Scenario: Auto-llm is a valid persisted mode
- **WHEN** a valid file selects `auto-llm`
- **THEN** operations prefer the configured LLM with native fallback without implicitly selecting a chat model

#### Scenario: Default remains classifier-first
- **WHEN** mode is absent, even if a chat model is configured
- **THEN** effective mode is `auto` and no migration write occurs

#### Scenario: Failover leaves settings unchanged
- **WHEN** an automatic operation succeeds through its alternate
- **THEN** mode and model slots remain unchanged and the next call starts with the configured preference

## ADDED Requirements

### Requirement: Waiting policy is inspectable
The existing read-only overview SHALL show each backend's effective idle duration and hard duration or an explicit disabled indication. It SHALL identify legacy-timeout migration problems without inference, settings writes or a picker. Timing configuration SHALL remain file-based in this change; no new timing wizard or command hierarchy SHALL be required.

#### Scenario: Default overview
- **WHEN** status is shown with omitted timing settings
- **THEN** classifier idle is shown as 10 seconds, LLM idle as 15 seconds, and both model hard limits as disabled
