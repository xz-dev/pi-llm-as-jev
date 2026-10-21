# backend-capacity-disclosure Specification

## Purpose
Read-only disclosure of the selected judgment backend, model identity and its input capacity limits, so a consumer can pack its own request within the model's actual capacity instead of relying on service-side splitting.

## Requirements

### Requirement: Selected backend and capacity are queryable
The version-two service SHALL expose a bounded read-only selection/capacity query so consumers can pack their own input. It SHALL return the selected backend and full model reference, known declared `request`, `stateAndLongestQuestion` and/or `contextWindow` token limits, and source `override`, `model` or `none`. An exact configured context-limit override SHALL replace that model's default profile. Unknown limits SHALL remain absent. Built-in review-only channel profiles, learned bytes-to-tokens ratios, learning flags and service-envelope estimates SHALL NOT be part of this capability.

The query SHALL use current configuration and selected-provider readiness, without paid inference, settings writes or calibration mutations. Timing/cancellation SHALL be bounded by each candidate's configured setup policy; reporting a candidate SHALL not promise subsequent inference success. The version-two service SHALL advertise the revised capacity contract as `capacityVersion: 2`.

#### Scenario: Model metadata without calibration
- **WHEN** the selected model supplies a context window and no override exists
- **THEN** the query reports that window with source `model`, with no learned ratio or previous-request dependence

#### Scenario: Explicit model override
- **WHEN** the exact selected model has configured request and state-plus-longest limits
- **THEN** those declared override limits replace its default profile without mixing in unrelated channel constants

#### Scenario: Native Jev through a known channel
- **WHEN** native Jev runs through a previously recognized built-in channel
- **THEN** the query uses only an exact configured override or current model metadata, otherwise absent limits with source `none`; it no longer supplies review-only channel constants

#### Scenario: LLM model without metadata
- **WHEN** the selected LLM declares no context window and no override exists
- **THEN** the query reports absent limits and source `none`, without an invented limit

#### Scenario: Configuration changes between queries
- **WHEN** a settings save changes the selected model after a query
- **THEN** the next query reflects that selection without restart and does not reuse the previous model's metadata

### Requirement: Judgment results disclose the capacity used
A result with a resolved model SHALL disclose that terminal attempt's declared capacity metadata, including a confirmed overflow failure. A result before model resolution SHALL not invent capacity. Usage SHALL include only information actually returned by the backend and SHALL NOT become learned service state or claim exact transport billing. The service SHALL not report learned prediction ratios or per-dispatch input-dimension histories. Consumers SHALL own packing estimates and necessary local overflow recovery.

#### Scenario: Fallback changes model capacity
- **WHEN** an earlier query selected a native model but judgment succeeds through LLM fallback
- **THEN** the result reports the LLM identity and its declared capacity rather than the earlier native profile

#### Scenario: Overflow reported
- **WHEN** the terminal model explicitly rejects input for context size
- **THEN** the result reports context overflow with that model's declared metadata, without silently removing facts or manufacturing token counts
