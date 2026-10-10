## MODIFIED Requirements

### Requirement: Configuration file
Settings SHALL be read from the global `llm-as-jev.json` file in Pi's agent directory at the start of each configuration-dependent operation, not only at extension activation. It SHALL hold `mode` (`auto` | `auto-llm` | `classifier` | `llm`, default `auto`), optional `classifierModel` and independently configured LLM `model` as `provider/modelid` strings, LLM-only `thinkingLevel` as one of Pi's levels including `off`, and `timeoutMs`. Model references SHALL split on the first slash, retaining any remaining slashes in the model id. The file SHALL NOT inherit model or thinking settings from the main session.

An unreadable or invalid file SHALL be reported once per session and all known settings SHALL use defaults rather than partially accepting the invalid file or retaining a previous valid configuration. A missing file SHALL use defaults without an invalid-file warning. Unknown extra keys SHALL be preserved when saving and SHALL NOT alone invalidate a file. An unknown configured chat model SHALL be unavailable, with no main-session fallback. A syntactically valid explicit classifier absent from the catalog SHALL remain an unavailable explicit candidate, not be erased so that another native model can silently replace it. An omitted `classifierModel` SHALL retain the existing default Jev discovery.

Each new operation SHALL obtain a fresh snapshot even after earlier successful reads, cache hits or configuration errors. Diagnostic suppression SHALL NOT suppress future reads or recovery. Operations in sessions sharing the same agent directory SHALL observe a save completed before the operation starts without a settings command, process restart or extension reload in the receiving session. Separate agent directories SHALL remain isolated. Refresh SHALL NOT rewrite the settings file or introduce background polling or watching while idle.

`auto-llm` SHALL change only backend preference and automatic failover behavior, not create another model slot or implicitly configure an LLM. Omitting `mode` SHALL continue to select `auto`, including when an LLM is configured. Runtime failover SHALL NOT rewrite the mode or either model slot.

#### Scenario: Valid file
- **WHEN** the file sets `model: "anthropic/claude-sonnet-4-5"` and `thinkingLevel: "low"`
- **THEN** an LLM backend attempt uses that model with low reasoning

#### Scenario: Independent native selection
- **WHEN** the file also sets a compatible non-Jev `classifierModel`
- **THEN** native requests use that classifier while LLM model/thinking settings remain unchanged

#### Scenario: Unknown chat model id
- **WHEN** `model` names a chat model not in Pi's catalog
- **THEN** the LLM is unavailable and the user is notified once; the main session model is not substituted

#### Scenario: Unknown explicit classifier id
- **WHEN** `classifierModel` names an absent model and another native model is available
- **THEN** the selection remains unavailable; automatic modes can use the configured LLM, while forced classifier mode errors instead of selecting that other native model

#### Scenario: Invalid known field with otherwise valid fields
- **WHEN** a file has a valid chat model but an invalid known mode, model-reference syntax, level or timeout
- **THEN** all known settings use defaults and the invalid-file diagnostic is emitted once per session

#### Scenario: Unreadable file
- **WHEN** reading the global file fails for a reason other than a missing file
- **THEN** configuration loading does not throw, uses defaults and reports the failure once per session

#### Scenario: Model id contains a slash
- **WHEN** a model reference is `provider/family/model`
- **THEN** provider is `provider` and the complete model id is `family/model`

#### Scenario: Clear explicit classifier
- **WHEN** the user removes `classifierModel` from the global file while a session is already running
- **THEN** its next operation uses default Jev discovery for native selection without changing LLM model/thinking settings or requiring a new session

#### Scenario: Hand edit
- **WHEN** the user completes a valid edit outside Pi while a session is already running
- **THEN** that session's next configuration-dependent operation uses the new values without a settings command or reload

#### Scenario: Two already-running sessions
- **WHEN** sessions A and B share an agent directory and A successfully saves new settings after both sessions started
- **THEN** B's next configuration-dependent operation observes those settings without repeating A's configuration action

#### Scenario: Invalid configuration after a valid operation
- **WHEN** a session has used valid settings and the file subsequently becomes invalid or unreadable
- **THEN** the next operation uses defaults for all known settings, not the earlier valid settings, and diagnostic emission remains bounded to once per session

#### Scenario: Recovery after a reported error
- **WHEN** a session has already reported invalid settings and the file is repaired
- **THEN** its next operation uses the repaired configuration even though the diagnostic has already been emitted

#### Scenario: File removed after initial configuration
- **WHEN** the configuration file is removed after a session has used explicit model settings
- **THEN** its next operation uses defaults rather than retaining the removed selections, without creating a replacement file

#### Scenario: Independent agent directories
- **WHEN** session A saves settings in a different agent directory from session B
- **THEN** B continues to read only its own configuration file

#### Scenario: Auto-llm is a valid persisted mode
- **WHEN** an otherwise valid file sets `mode: "auto-llm"`
- **THEN** the mode and independent model slots load without an invalid-file diagnostic, and subsequent judgments prefer the configured LLM

#### Scenario: Default remains classifier-first
- **WHEN** the file is absent or omits `mode`, including when an LLM model is configured
- **THEN** effective mode is `auto`, not `auto-llm`, and no migration write is performed

#### Scenario: Failover leaves settings unchanged
- **WHEN** an `auto-llm` operation succeeds on the classifier after an LLM failure
- **THEN** the saved mode and both model slots remain unchanged and the next operation still starts with LLM preference

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
