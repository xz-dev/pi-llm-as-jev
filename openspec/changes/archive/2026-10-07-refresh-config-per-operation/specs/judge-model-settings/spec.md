## MODIFIED Requirements

### Requirement: Configuration file
Settings SHALL be read from the global `llm-as-jev.json` file in Pi's agent directory at the start of each configuration-dependent operation, not only at extension activation. It SHALL hold `mode` (`auto` | `classifier` | `llm`, default `auto`), optional `classifierModel` and independently configured LLM `model` as `provider/modelid` strings, LLM-only `thinkingLevel` as one of Pi's levels including `off`, and `timeoutMs`. Model references SHALL split on the first slash, retaining any remaining slashes in the model id. The file SHALL NOT inherit model or thinking settings from the main session.

An unreadable or invalid file SHALL be reported once per session and all known settings SHALL use defaults rather than partially accepting the invalid file or retaining a previous valid configuration. A missing file SHALL use defaults without an invalid-file warning. Unknown extra keys SHALL be preserved when saving and SHALL NOT alone invalidate a file. An unknown configured chat model SHALL be unavailable, with no main-session fallback. A syntactically valid explicit classifier absent from the catalog SHALL remain an unavailable explicit candidate, not be erased so that another native model can silently replace it. An omitted `classifierModel` SHALL retain the existing default Jev discovery.

Each new operation SHALL obtain a fresh snapshot even after earlier successful reads, cache hits or configuration errors. Diagnostic suppression SHALL NOT suppress future reads or recovery. Operations in sessions sharing the same agent directory SHALL observe a save completed before the operation starts without a settings command, process restart or extension reload in the receiving session. Separate agent directories SHALL remain isolated. Refresh SHALL NOT rewrite the settings file or introduce background polling or watching while idle.

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
- **WHEN** the user removes `classifierModel` from the global file while a session is already running
- **THEN** its next operation uses default Jev discovery without changing LLM model/thinking settings or requiring a new session

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
- **THEN** its next operation uses the repaired configuration even though its diagnostic has already been emitted

#### Scenario: File removed after initial configuration
- **WHEN** the configuration file is removed after a session has used explicit model settings
- **THEN** its next operation uses defaults rather than retaining the removed selections, without creating a replacement file

#### Scenario: Independent agent directories
- **WHEN** session A saves settings in a different agent directory from session B
- **THEN** B continues to read only its own configuration file

## ADDED Requirements

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
