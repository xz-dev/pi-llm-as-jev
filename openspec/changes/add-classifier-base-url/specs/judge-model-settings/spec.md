## ADDED Requirements

### Requirement: Classifier endpoint override
The configuration file MAY hold `classifierBaseUrl`, an http(s) URL. Native judgment dispatch for the explicit `classifierModel` SHALL use this URL in place of the model's catalog `baseUrl`, with credentials still resolved by Pi for the selected provider. The override SHALL NOT change Pi's provider registration or catalog for other consumers.

#### Scenario: Third-party System One host
- **WHEN** the file sets `classifierModel: "typesafe/jev-latest"` and `classifierBaseUrl: "https://proxy.example.com/v1"`
- **THEN** native judgments are sent to `https://proxy.example.com/v1/systemone` with the `typesafe` credential from Pi

#### Scenario: Full endpoint pasted
- **WHEN** `classifierBaseUrl` is `https://proxy.example.com/v1/systemone` for a System One classifier
- **THEN** requests go to `https://proxy.example.com/v1/systemone`, not a doubled `systemone` path

#### Scenario: Other consumers unaffected
- **WHEN** an override is configured
- **THEN** Pi's catalog entry for the classifier keeps its original endpoint

#### Scenario: Built-in channel limits
- **WHEN** the overridden endpoint is not a known TypeSafe or OpenRouter endpoint
- **THEN** built-in channel limits do not apply; a `contextLimits` profile or the model window is used

### Requirement: Classifier endpoint validation and persistence
A `classifierBaseUrl` that is not an http(s) URL, or that is present without `classifierModel`, SHALL invalidate the file under the existing all-or-defaults rule. A save SHALL keep `classifierBaseUrl` only while the same `classifierModel` remains selected.

#### Scenario: Override without explicit classifier
- **WHEN** the file sets `classifierBaseUrl` but omits `classifierModel`
- **THEN** all known settings use defaults and the invalid-file diagnostic is emitted once per session

#### Scenario: Unchanged classifier save
- **WHEN** the user changes the mode while the same classifier stays selected
- **THEN** the saved file keeps `classifierBaseUrl`

#### Scenario: Classifier changed by picker
- **WHEN** the user selects a different classifier with the native picker
- **THEN** the saved file no longer contains `classifierBaseUrl`
