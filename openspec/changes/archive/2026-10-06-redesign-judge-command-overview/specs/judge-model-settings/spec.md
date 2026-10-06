## MODIFIED Requirements

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

### Requirement: Status display
Both `/llm-as-jev` and `/llm-as-jev status` SHALL display the same read-only overview with separate `Mode`, `Classifier` and `LLM` rows. They SHALL NOT open a picker, create or update settings, change the main session model/thinking, or send a classification or LLM inference request. The overview SHALL retain the configured thinking-level and config-path information, without requiring a settings mutation to inspect them. Outside the interactive TUI it SHALL remain available through the existing notification surface without custom UI.

The default mode SHALL remain `auto`. Its display SHALL be `Auto(classifier)` when the selected/default native candidate is usable, otherwise `Auto(llm)` when the configured LLM is usable, otherwise `Auto(None)`. The backend names in the suffix SHALL be complete: `classi` SHALL NOT be used. Forced modes SHALL display `Classifier` or `LLM`, without suggesting automatic switching to the other backend.

An omitted `classifierModel` SHALL continue to mean default Jev discovery and SHALL display `Jev`, not `None`. When default discovery yields a candidate, the classifier row SHALL also show that candidate's actual `provider/modelid`; when unavailable, it SHALL retain `Jev` with an unavailable indication. An explicit classifier SHALL display its exact reference and distinguish an unavailable explicit selection from default discovery. An omitted LLM `model` SHALL display `None`; a configured model missing from Pi's catalog or without usable credentials SHALL retain its reference with an unavailable indication rather than appear unconfigured.

The overview SHALL emit a warning when no usable candidate exists for the configured mode. In `auto` this means neither candidate is usable; in a forced mode it means the required candidate is unusable even if the other one is available. The warning SHALL name a relevant settings command and, for forced modes, indicate that the other backend is not selected automatically. Missing settings alone SHALL NOT trigger this warning when default Jev is usable.

The automatic-mode suffix SHALL describe an availability snapshot, not a guarantee of sufficient quota or successful inference. Displaying this overview SHALL NOT add quota checks, change initial-selection precedence or enable switching after a dispatched request fails.

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

## ADDED Requirements

### Requirement: Command discoverability
The extension's command description, argument completions and usage guidance SHALL identify `status`, `llm`, `classifier` and `mode <auto|classifier|llm>` under `/llm-as-jev`. Argument completion SHALL respect the entered prefix and SHALL offer `status`, `llm`, `classifier`, `mode auto`, `mode classifier` and `mode llm` when the argument prefix is empty. Guidance SHALL NOT advertise `/llm-as-jev-classifier` as a supported command.

#### Scenario: Discover commands without knowing their names
- **WHEN** the user requests argument completions after `/llm-as-jev` with an empty prefix
- **THEN** both model-setting entries, status and all three mode-setting forms are offered

#### Scenario: Filter completions and recover from an unknown argument
- **WHEN** the user completes the prefix `ll` or invokes an unknown subcommand
- **THEN** completion offers `llm` for that prefix, and unknown-command guidance lists the supported subcommands without changing settings
