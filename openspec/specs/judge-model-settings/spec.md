# Judge Model Settings Specification

## Purpose

Lets the user independently select a compatible native classifier and an LLM chat model/thinking level through searchable Pi pickers, choose the backend mode, and persist those choices in a plain global configuration file without changing the main session model.

## Requirements

### Requirement: Configuration file
Settings SHALL remain in Pi's agent-directory `llm-as-jev.json`, read afresh at each configuration-dependent operation. `PI_CODING_AGENT_DIR` SHALL override the home-based directory; when `HOME` is unset, the OS home directory SHALL be used, with Windows separators supported. `mode` SHALL remain `auto` by default with `auto-llm`, `classifier` and `llm` alternatives. Independent `classifierModel`, chat `model`, `thinkingLevel` and exact-model `contextLimits` overrides SHALL remain supported. Model references SHALL split at the first slash; neither slot nor thinking SHALL inherit main-session settings. Missing native selection SHALL retain default Jev discovery, while explicit unknown selections SHALL stay unavailable instead of selecting another native model.

The existing `classifierBaseUrl` SHALL remain an optional HTTP(S) endpoint override requiring an explicit `classifierModel`. Only this service's selected model copy SHALL use the override; Pi's catalog SHALL remain unchanged and credentials SHALL still come from the selected provider. Trailing slashes SHALL be normalized; a trailing `/systemone` SHALL be removed from System One API bases only, because that adapter appends the path. The endpoint SHALL be frozen with admitted settings. Atomic saves SHALL retain it only while the same explicit classifier remains selected; changing or clearing that selection SHALL remove it. Capacity v2 SHALL use explicit limits or model metadata, not old built-in channel profiles.

Timing SHALL be represented by optional `timeouts.classifier` and `timeouts.llm` objects, each containing optional `idleTimeoutMs` and `modelTimeoutMs`. Idle defaults SHALL be classifier **10,000 ms** and LLM **15,000 ms**. A missing `modelTimeoutMs` SHALL mean no hard limit. Supplied values SHALL be positive integers within the platform timer range. No combined-operation limit or host-HTTP-default inheritance SHALL be introduced. An explicit per-call option SHALL override that field for each model attempt independently. Configuration SHALL be frozen for admitted work and reread for later calls; runtime fallback SHALL not mutate settings.

The legacy top-level `timeoutMs` SHALL be recognized as requiring migration, not ignored as an unknown key or silently interpreted under different semantics. While it remains present, inference SHALL return an actionable configuration error without dispatch; read-only status SHALL identify the field and required explicit replacement. Settings inspection SHALL not rewrite the file. Users SHALL explicitly choose an idle override, a hard limit, or both when migrating; removing the legacy field uses the new defaults. No hard limit SHALL be inferred from an old value.

For other malformed known fields or unreadable files, the existing all-known-fields-default behavior and once-per-session diagnostic SHALL remain; a missing file SHALL use defaults without warning. Unknown unrelated keys SHALL survive atomic patch saves. Error suppression SHALL not prevent rereading a repaired file. Shared-agent-directory sessions SHALL see completed saves on their next operation without polling, restart or reload; separate directories SHALL remain isolated. Confirmed model/mode saves SHALL preserve unrelated settings, including timeout slots, and cancellation SHALL not overwrite another session's save.

#### Scenario: Classifier endpoint snapshot and catalog isolation
- **WHEN** an explicit System One classifier uses `https://proxy.example/v1/systemone/` and settings change while its authentication is pending
- **THEN** admitted work uses `https://proxy.example/v1`, the next operation reads the new endpoint and Pi's original catalog model remains unchanged

#### Scenario: Endpoint validation and save retention
- **WHEN** an endpoint is non-HTTP(S) or lacks an explicit classifier
- **THEN** the file follows the all-known-fields-default rule; valid endpoints survive unrelated or same-classifier saves, but changing or clearing the classifier removes them

#### Scenario: HOME unset
- **WHEN** neither `PI_CODING_AGENT_DIR` nor `HOME` is set
- **THEN** settings resolve under the OS home directory, including on Windows

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

### Requirement: Model picker command
The `/llm-as-jev llm` command SHALL open a searchable list of available chat models from Pi, ordered alphabetically by `provider/modelid`, with the currently configured LLM model preselected (not moved to the top) when present. Typing SHALL fuzzy-match ids or display names while retaining alphabetical order; arrow keys move, confirm selects, and cancel leaves file and in-memory configuration unchanged. Confirmed chat selection SHALL NOT change `classifierModel` or `mode`. The command SHALL continue to the existing thinking-level step and save the model and level only after both selections are confirmed. The bare `/llm-as-jev` command SHALL NOT open this picker.

#### Scenario: Explicit LLM settings entry
- **WHEN** the user runs `/llm-as-jev llm` in an interactive TUI with available chat models
- **THEN** the chat-model picker opens and confirmation leads to the thinking-level picker

#### Scenario: Preselect configured model
- **WHEN** the configured model is `openai/gpt-5` and the user opens `/llm-as-jev llm` with that model in the available list
- **THEN** the picker opens with `openai/gpt-5` highlighted at its alphabetical position

#### Scenario: Nothing configured
- **WHEN** no LLM model is configured and the user opens `/llm-as-jev llm`
- **THEN** the picker opens with the first alphabetical entry highlighted

#### Scenario: Search
- **WHEN** the user types `sonnet`
- **THEN** only models whose `provider/modelid` or display name fuzzy-matches `sonnet` remain, still in alphabetical order

#### Scenario: Cancel
- **WHEN** the user cancels either the model picker or the following thinking-level picker
- **THEN** neither the configuration file nor the active model, thinking level, native selection or mode changes

#### Scenario: Non-interactive LLM settings invocation
- **WHEN** the user invokes `/llm-as-jev llm` outside an interactive TUI
- **THEN** the command reports that selection requires the interactive TUI, opens no custom component and changes no settings

### Requirement: Native classifier picker
The `/llm-as-jev classifier` command SHALL open a searchable, alphabetically ordered list of available compatible Pi classifiers, excluding this plugin's LLM-emulation provider. The configured classifier SHALL be preselected at its actual index when present, otherwise the first entry. Confirming SHALL persist only native selection and apply it to subsequent judgments immediately, without a chat thinking-level step, process restart or extension reload. Cancel SHALL change neither file nor memory. Native selection SHALL NOT alter LLM model/thinking, mode, or the main session model/thinking. The extension SHALL NOT register the former `/llm-as-jev-classifier` alias.

#### Scenario: Non-Jev selection
- **WHEN** the user confirms an available compatible classifier not named Jev through `/llm-as-jev classifier`
- **THEN** `classifierModel` records its exact full reference and the next native judgment uses it

#### Scenario: Native preselection and search
- **WHEN** the configured native model is present and the user filters by its id or display name
- **THEN** selection remains in alphabetical order rather than moving the configured or best-scoring entry to the top

#### Scenario: Native picker cancel
- **WHEN** the user cancels native selection
- **THEN** disk, active configuration and the configured chat model/thinking remain unchanged

#### Scenario: Own emulation excluded
- **WHEN** Pi lists the emulated classifier alongside real native candidates
- **THEN** the native selection list excludes it

#### Scenario: Single native settings entry
- **WHEN** the extension's available commands are listed
- **THEN** `/llm-as-jev-classifier` is absent and the native selection entry is `/llm-as-jev classifier`

### Requirement: Thinking level picker
After a chat model is confirmed, a second list SHALL offer exactly the thinking levels that model supports, computed the same way Pi computes them for its `/thinking` command (a non-reasoning model offers only `off`), with the configured level preselected when supported, otherwise the model's default. Confirming SHALL persist both model and level and apply them immediately. Canceling this second step SHALL leave file and memory unchanged, including the pending model selection. Neither step SHALL modify main-session model/thinking settings.

#### Scenario: Reasoning model
- **WHEN** the selected model supports `off` through `high`
- **THEN** the level list shows exactly those entries

#### Scenario: Non-reasoning model
- **WHEN** the selected model does not support reasoning
- **THEN** the level list shows only `off` and confirming it persists `off`

#### Scenario: Immediate effect
- **WHEN** chat model and level are confirmed
- **THEN** the next LLM `judge()` call in the same session uses them and the registered emulated classifier is updated without restart or reload, while native selection is unchanged

#### Scenario: Cancel thinking step
- **WHEN** the user confirms a chat model but cancels the following level picker
- **THEN** neither the old chat model/level nor native selection changes in memory or on disk

### Requirement: Backend mode command
A command SHALL let the user view and set `mode` to `auto`, `auto-llm`, `classifier` or `llm`, persisting it and applying it immediately. The old prototype `jev` value SHALL NOT be silently accepted as an alias. Mode changes SHALL preserve both model slots and thinking level.

#### Scenario: Set llm
- **WHEN** the user sets mode to `llm`
- **THEN** subsequent requests never use a native classifier even if one is available

#### Scenario: Set classifier
- **WHEN** the user confirms mode `classifier`
- **THEN** disk and memory use that mode and subsequent requests never fall back to the LLM

#### Scenario: Set auto-llm
- **WHEN** the user runs `/llm-as-jev mode auto-llm`
- **THEN** the mode is saved and subsequent operations prefer LLM with native failover, without changing model selections or thinking level

#### Scenario: Return to auto
- **WHEN** the user runs `/llm-as-jev mode auto` after using `auto-llm`
- **THEN** subsequent operations prefer the selected/default native classifier with LLM failover

### Requirement: Status display
Both `/llm-as-jev` and `/llm-as-jev status` SHALL display the same read-only overview with separate `Mode`, `Classifier` and `LLM` rows. They SHALL NOT open a picker, create or update settings, change the main session model/thinking, or send a classification or LLM inference request. The overview SHALL retain the configured thinking-level and config-path information, without requiring a settings mutation to inspect them. Outside the interactive TUI it SHALL remain available through the existing notification surface without custom UI.

The default mode SHALL remain `auto`. Its display SHALL be `Auto(classifier)` when the selected/default native candidate is usable, otherwise `Auto(llm)` when the configured LLM is usable, otherwise `Auto(None)`. Mode `auto-llm` SHALL display `Auto-LLM(llm)` when the configured LLM is usable, otherwise `Auto-LLM(classifier)` when the selected/default native candidate is usable, otherwise `Auto-LLM(None)`. The prefix SHALL preserve the configured preference even when only the alternate is usable. Backend names in the suffix SHALL be complete: `classi` SHALL NOT be used. Forced modes SHALL display `Classifier` or `LLM`, without suggesting automatic switching to the other backend.

An omitted `classifierModel` SHALL continue to mean default Jev discovery and SHALL display `Jev`, not `None`. When default discovery yields a candidate, the classifier row SHALL also show that candidate's actual `provider/modelid`; when unavailable, it SHALL retain `Jev` with an unavailable indication. An explicit classifier SHALL display its exact reference and distinguish an unavailable explicit selection from default discovery. An omitted LLM `model` SHALL display `None`; a configured model missing from Pi's catalog or without usable credentials SHALL retain its reference with an unavailable indication rather than appear unconfigured.

The overview SHALL emit a warning when no usable candidate exists for the configured mode. In either automatic mode this means neither candidate is usable; in a forced mode it means the required candidate is unusable even if the other one is available. The warning SHALL name a relevant settings command and, for forced modes, indicate that the other backend is not selected automatically. Missing settings alone SHALL NOT trigger this warning in an automatic mode when default Jev is usable.

The automatic-mode suffix SHALL describe the first usable candidate in a current availability snapshot, not a guarantee of sufficient quota or successful inference and not the outcome of the previous operation. Displaying this overview SHALL NOT add quota checks, change selection precedence or itself trigger failover. Runtime failover SHALL follow the configured automatic mode's judgment-service contract independently of whether the overview has been displayed.

#### Scenario: Bare command is read-only in the TUI
- **WHEN** the user runs `/llm-as-jev` in an interactive TUI
- **THEN** the overview appears without a picker, settings writes or classification/LLM inference calls

#### Scenario: Status with default Jev available
- **WHEN** no settings have been saved and Pi reports `typesafe/jev-1.13` as the default available Jev candidate
- **THEN** the overview shows `Mode` as `Auto(classifier)`, `Classifier` as Jev with `typesafe/jev-1.13`, and `LLM` as `None`, without a missing-backend warning or creating a settings file

#### Scenario: Initial LLM fallback candidate
- **WHEN** mode is `auto`, default Jev is unavailable, and the configured `openai/gpt-5` LLM is usable
- **THEN** the overview shows `Auto(llm)`, Jev marked unavailable, and `openai/gpt-5`, without a missing-backend warning

#### Scenario: Neither backend is usable
- **WHEN** mode is `auto`, default Jev is unavailable and no LLM is configured
- **THEN** the overview shows `Auto(None)`, Jev marked unavailable and `LLM` as `None`, and warns the user to configure an available classifier with `/llm-as-jev classifier` or an LLM with `/llm-as-jev llm`

#### Scenario: Status with unavailable explicit classifier
- **WHEN** mode is `auto`, the explicit `native/missing` classifier is unavailable, another native model exists, and the configured LLM is usable
- **THEN** the overview shows `Auto(llm)` and `native/missing` marked unavailable, without claiming the other native model will be selected

#### Scenario: Configured LLM is not usable
- **WHEN** mode is `auto`, no selected/default classifier is usable, and the configured LLM is absent from the catalog or lacks usable credentials
- **THEN** the overview shows `Auto(None)`, retains the configured LLM reference marked unavailable, and emits a missing-backend warning

#### Scenario: Forced mode cannot use the other candidate
- **WHEN** mode is `classifier`, its selected/default classifier is unavailable and an LLM is usable
- **THEN** the overview displays `Classifier`, retains both model-slot details and warns about the unavailable required classifier rather than displaying `Auto(llm)` or claiming the LLM is active

#### Scenario: Forced LLM remains forced
- **WHEN** mode is `llm`, the configured LLM is unavailable and a native classifier is usable
- **THEN** the overview displays `LLM` and warns about the unavailable required LLM rather than claiming the classifier is active

#### Scenario: Status command and non-interactive overview
- **WHEN** the user runs `/llm-as-jev status`, or runs the bare command outside the interactive TUI, under the same configuration and availability snapshot
- **THEN** the same mode, model-slot details and applicable warning are reported without custom UI or settings writes

#### Scenario: Auto-llm with both candidates usable
- **WHEN** mode is `auto-llm` and both candidates are usable
- **THEN** the overview shows `Auto-LLM(llm)` with both model slots intact and no missing-backend warning

#### Scenario: Auto-llm uses the native candidate
- **WHEN** mode is `auto-llm`, the LLM is unconfigured or unavailable, and the selected/default classifier is usable
- **THEN** the overview shows `Auto-LLM(classifier)`, preserves `None` versus unavailable LLM details and emits no missing-backend warning

#### Scenario: Auto-llm has no usable candidate
- **WHEN** mode is `auto-llm` and neither candidate is usable
- **THEN** the overview shows `Auto-LLM(None)` and warns with the classifier and LLM settings commands

#### Scenario: Status is not a sticky failover report
- **WHEN** an earlier `auto-llm` operation used the classifier after an LLM runtime error but both candidates remain registry-usable
- **THEN** a later status overview shows `Auto-LLM(llm)`, describing current configured preference rather than claiming the earlier fallback changed the mode

### Requirement: Command discoverability
The extension's command description, argument completions and usage guidance SHALL identify `status`, `llm`, `classifier` and `mode <auto|auto-llm|classifier|llm>` under `/llm-as-jev`. Argument completion SHALL respect the entered prefix and SHALL offer `status`, `llm`, `classifier`, `mode auto`, `mode auto-llm`, `mode classifier` and `mode llm` when the argument prefix is empty. Guidance SHALL NOT advertise `/llm-as-jev-classifier` as a supported command.

#### Scenario: Discover commands without knowing their names
- **WHEN** the user requests argument completions after `/llm-as-jev` with an empty prefix
- **THEN** both model-setting entries, status and all four mode-setting forms are offered

#### Scenario: Filter completions and recover from an unknown argument
- **WHEN** the user completes the prefix `ll` or invokes an unknown subcommand
- **THEN** completion offers `llm` for that prefix, and unknown-command guidance lists the supported subcommands and four modes without changing settings

#### Scenario: Complete the automatic modes
- **WHEN** the user requests completions for the prefix `mode auto`
- **THEN** both `mode auto` and `mode auto-llm` are offered

#### Scenario: Invalid mode guidance
- **WHEN** the user supplies an unsupported mode, including `jev`
- **THEN** guidance lists `auto`, `auto-llm`, `classifier` and `llm`, reports the current mode and leaves settings unchanged

### Requirement: Fresh settings views and confirmation
Every configuration-dependent `/llm-as-jev` invocation SHALL start with current file settings. Status rows, mode guidance and availability within one overview SHALL describe the same configuration snapshot. The chat, thinking-level and native-classifier pickers SHALL use the configuration snapshot captured when their settings interaction opens; an already-open interaction SHALL NOT be restarted or change selection merely because another session saves settings. Reopening SHALL obtain a new snapshot.

A confirmed save SHALL update only the confirmed fields against the file read for that save, preserving unrelated valid settings and unknown keys already saved before confirmation. A cancelled interaction SHALL publish none of its pending choices and SHALL NOT restore its older opening snapshot over another session's changes. The existing atomic-save behavior and save-error reporting SHALL remain; simultaneous overlapping saves SHALL NOT acquire a new conflict-free merge guarantee. Status, availability and metadata inspection SHALL remain free of settings writes, inference requests and main-session model/thinking changes.

#### Scenario: Status is the first operation after another session's save
- **WHEN** A saves a new mode and model selections, and B next invokes the bare command or `status` without first judging anything
- **THEN** B's overview and availability use those current settings, with no configuration write or inference request

#### Scenario: Fresh picker preselection
- **WHEN** A saves a new native selection or LLM model/thinking level and B subsequently opens the corresponding picker
- **THEN** B preselects the current configured value when available, preserving the existing alphabetical ordering and supported-level rules

#### Scenario: Mode guidance uses current settings
- **WHEN** A changes the mode and B subsequently invokes mode guidance without a valid new mode argument
- **THEN** B reports the current file's mode without saving anything

#### Scenario: A dialog does not overwrite an unrelated later save
- **WHEN** B opens an LLM picker, A then saves a different native selection and mode, and B subsequently confirms its LLM model and thinking level
- **THEN** B's save changes only its confirmed LLM fields and preserves A's native selection, mode and unknown extra keys

#### Scenario: Cancel after another session saves
- **WHEN** A saves settings while B has a picker open and B cancels either step
- **THEN** B writes nothing, publishes no pending choice and does not roll back A's save; B's next operation reads A's settings

#### Scenario: Failed confirmation
- **WHEN** a confirmed settings save fails
- **THEN** the command reports failure without publishing the unsaved choice as active, and a subsequent operation reads the configuration actually on disk

### Requirement: Waiting policy is inspectable
The existing read-only overview SHALL show each backend's effective idle duration and hard duration or an explicit disabled indication. It SHALL identify legacy-timeout migration problems without inference, settings writes or a picker. Timing configuration SHALL remain file-based in this change; no new timing wizard or command hierarchy SHALL be required.

#### Scenario: Default overview
- **WHEN** status is shown with omitted timing settings
- **THEN** classifier idle is shown as 10 seconds, LLM idle as 15 seconds, and both model hard limits as disabled
