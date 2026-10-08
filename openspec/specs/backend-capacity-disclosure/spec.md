# backend-capacity-disclosure Specification

## Purpose
Read-only disclosure of the selected judgment backend, model identity and its input capacity limits, so a consumer can pack its own request within the model's actual capacity instead of relying on service-side splitting.

## Requirements

### Requirement: Selected backend and capacity are queryable

The service SHALL expose a read-only query that resolves the backend and model that a judgment would use under the current configuration snapshot and returns, when known, its request-wide and state-plus-longest-question limits in tokens, the applicable bytes-to-tokens ratio (learned from provider usage or the conservative prior), and the source of each limit (configured override, model metadata, built-in channel constant). The query SHALL NOT run paid inference, write settings or mutate caches. Unknown limits SHALL be reported as absent, never inferred.

#### Scenario: Native Jev through a known channel
- **WHEN** the selected backend is the native classifier on a built-in channel with declared constants
- **THEN** the query returns those limits with source `channel`

#### Scenario: LLM model without metadata
- **WHEN** the selected LLM model declares no context window and no override exists
- **THEN** the query returns absent limits and reports that metadata is missing

#### Scenario: Configuration changes between queries
- **WHEN** the configured model changes after a query
- **THEN** the next query reflects the new selection without a restart

### Requirement: Judgment results disclose the capacity used

Every judgment result SHALL include the selected backend/model identity and the capacity limits and ratio applied to its overflow prediction, together with provider-reported input tokens when available, so the consumer can recalibrate its packing. Disclosure SHALL NOT include provider response bodies or credentials.

#### Scenario: Overflow reported
- **WHEN** the provider rejects a request for input size
- **THEN** the result reports the overflow, the limits in force and the logical input sizes measured at dispatch (estimates, not HTTP wire bytes)
