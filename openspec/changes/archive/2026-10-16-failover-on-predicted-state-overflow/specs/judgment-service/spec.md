## MODIFIED Requirements

### Requirement: Context capacity and splitting
Before sending, the service SHALL predict whether the request exceeds the current backend attempt's input capacity using its declared context limit and learned rejections. When a multi-question request is predicted or reported to overflow, the service SHALL split unanswered questions into smaller batches and retry. When a single question with the given state is rejected for size and applicable recovery cannot complete it, that backend attempt SHALL fail with a context-overflow indication and SHALL NOT resend that exact envelope unchanged to the same backend/model. When the irreducible floor — the given state, evidence that cannot be split and the longest unanswered question — is predicted to exceed the attempt's state limit (`stateAndLongestQuestion`, else the declared context window) and an automatic route has an unused alternate whose candidate currently resolves, that backend attempt SHALL fail with a context-overflow indication before dispatch; without such an alternate the request SHALL still be sent once. An automatic operation with an unused alternate SHALL try the full logical request under the alternate's own capacity profile after either confirmed or predicted irreducible overflow; otherwise the service SHALL report `stopReason: "error"`.

#### Scenario: Batch overflows
- **WHEN** a request with eight questions is rejected by the provider for input size
- **THEN** the service retries the questions in smaller batches and returns the union of accepted answers if that backend completes them

#### Scenario: Irreducible overflow
- **WHEN** a single question with its state is rejected for input size and no applicable recovery or alternate can complete it
- **THEN** the result reports a context-overflow error and the same envelope is not resent to the rejecting backend/model until state or question changes

#### Scenario: Backend-specific limit
- **WHEN** the LLM backend model declares a larger context window than the selected native classifier
- **THEN** overflow prediction for an LLM attempt uses the LLM model's limit, including after native failure

#### Scenario: Thinking level changes
- **WHEN** an LLM judgment was cached at `low` and the same model is configured at `high`
- **THEN** the next identical question sends a new model request

#### Scenario: Smaller alternate cannot fit
- **WHEN** a failed preferred attempt is followed by an alternate whose capacity cannot fit the logical request even after applicable recovery
- **THEN** the operation returns a structured error rather than truncating evidence, borrowing the first backend's limits or cycling back

#### Scenario: Predicted irreducible overflow skips to the alternate
- **WHEN** a single-question `judge()` state is predicted above the preferred backend's state limit and the unused alternate resolves
- **THEN** the preferred backend receives no request and the alternate's result is returned

#### Scenario: Alternate unusable keeps the admission check
- **WHEN** the same prediction occurs but the route's alternate is unconfigured or does not resolve
- **THEN** the preferred backend receives the request once and its actual outcome decides the result
