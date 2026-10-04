## Purpose

Lets the user independently select a compatible native classifier and an LLM chat model/thinking level through searchable Pi pickers, choose the backend mode, and persist those choices in a plain global configuration file without changing the main session model.

## ADDED Requirements

### Requirement: Configuration file
Settings SHALL be read from a global JSON file in Pi's agent directory. It SHALL hold `mode` (`auto` | `classifier` | `llm`, default `auto`), optional `classifierModel` and independently configured LLM `model` as `provider/modelid` strings, LLM-only `thinkingLevel` as one of Pi's levels including `off`, and `timeoutMs`. Model references SHALL split on the first slash, retaining any remaining slashes in the model id. The file SHALL NOT inherit model or thinking settings from the main session.

An unreadable or invalid file SHALL be reported once per session and all known settings SHALL use defaults rather than partially accepting the invalid file. Unknown extra keys SHALL be preserved when saving and SHALL NOT alone invalidate a file. An unknown configured chat model SHALL be unavailable, with no main-session fallback. A syntactically valid explicit classifier absent from the catalog SHALL remain an unavailable explicit candidate, not be erased so that another native model can silently replace it. An omitted `classifierModel` SHALL retain the existing default Jev discovery.

#### Scenario: Valid file
- **WHEN** the file sets `model: "anthropic/claude-sonnet-4-5"` and `thinkingLevel: "low"`
- **THEN** the LLM backend uses that model with low reasoning

#### Scenario: Independent native selection
- **WHEN** the file also sets a compatible non-Jev `classifierModel`
- **THEN** native requests use that classifier while LLM model/thinking settings remain unchanged

#### Scenario: Unknown chat model id
- **WHEN** `model` names a chat model not in Pi's catalog
- **THEN** the LLM is unavailable and the user is notified once; the main session model is not substituted

#### Scenario: Unknown explicit classifier id
- **WHEN** `classifierModel` names an absent model and another native model is available
- **THEN** the selection remains unavailable; auto may use the configured LLM, while forced classifier mode errors instead of selecting that other native model

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
- **WHEN** the user removes `classifierModel` from the global file and starts a new session
- **THEN** the service returns to default Jev discovery without changing LLM model/thinking settings

#### Scenario: Hand edit
- **WHEN** the user edits the file outside Pi and starts a new session
- **THEN** the new values take effect without using the command

### Requirement: Model picker command
The existing command SHALL open a searchable list of available chat models from Pi, ordered alphabetically by `provider/modelid`, with the currently configured LLM model preselected (not moved to the top) when present. Typing SHALL fuzzy-match ids or display names while retaining alphabetical order; arrow keys move, confirm selects, and cancel leaves file and in-memory configuration unchanged. Confirmed chat selection SHALL NOT change `classifierModel`.

#### Scenario: Preselect configured model
- **WHEN** the configured model is `openai/gpt-5` and the list contains it
- **THEN** the picker opens with `openai/gpt-5` highlighted at its alphabetical position

#### Scenario: Nothing configured
- **WHEN** no model is configured
- **THEN** the picker opens with the first alphabetical entry highlighted

#### Scenario: Search
- **WHEN** the user types `sonnet`
- **THEN** only models whose `provider/modelid` or display name fuzzy-matches `sonnet` remain, still in alphabetical order

#### Scenario: Cancel
- **WHEN** the user cancels the picker
- **THEN** the configuration file is not modified

### Requirement: Native classifier picker
A separate command SHALL open a searchable, alphabetically ordered list of available compatible Pi classifiers, excluding this plugin's LLM-emulation provider. The configured classifier SHALL be preselected at its actual index when present, otherwise the first entry. Confirming SHALL persist only native selection and apply it to subsequent judgments immediately, without a chat thinking-level step, process restart or extension reload. Cancel SHALL change neither file nor memory. Native selection SHALL NOT alter LLM model/thinking or the main session model/thinking.

#### Scenario: Non-Jev selection
- **WHEN** the user confirms an available compatible classifier not named Jev
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
A command SHALL let the user view and set `mode` to `auto`, `classifier`, or `llm`, persisting it and applying it immediately. The old prototype `jev` value SHALL NOT be silently accepted as an alias.

#### Scenario: Set llm
- **WHEN** the user sets mode to `llm`
- **THEN** subsequent requests never use a native classifier even if one is available

#### Scenario: Set classifier
- **WHEN** the user confirms mode `classifier`
- **THEN** disk and memory use that mode and subsequent requests never fall back to the LLM

### Requirement: Status display
A command or picker header SHALL show mode, configured/effective native candidate and availability, configured LLM model and level, and config path. It SHALL distinguish an unavailable explicit native selection from unconfigured default discovery.

#### Scenario: Status with default Jev available
- **WHEN** mode is `auto`, no explicit classifier is configured and Jev is available
- **THEN** status identifies the actual Jev candidate under the native classifier path and names the configured LLM as fallback

#### Scenario: Status with unavailable explicit classifier
- **WHEN** an explicit classifier is unavailable but another native model exists
- **THEN** status reports the explicit selection unavailable rather than claiming that other model will be used
