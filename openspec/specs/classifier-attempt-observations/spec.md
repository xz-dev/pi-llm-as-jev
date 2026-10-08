# classifier-attempt-observations Specification

## Purpose
Expose transport facts and usable partial classifier results without changing the strict result semantics expected by existing Pi callers.

## Requirements

### Requirement: Optional observation contract
System One classification SHALL expose an opt-in versioned observation contract. Existing calls without observation options SHALL retain their strict final answer/error behavior, authentication, endpoint selection, default retries and response callback behavior. Unsupported adapters SHALL NOT claim observation support merely because they are classifier models.

#### Scenario: Legacy caller receives an incomplete response
- **WHEN** one required answer is missing
- **THEN** the ordinary result remains an error with an empty final answer map

#### Scenario: Unsupported adapter
- **WHEN** an adapter does not implement the observation contract
- **THEN** callers can distinguish unavailable observations from an observed zero-attempt operation

### Requirement: Actual transport attempt lifecycle
An observing caller SHALL receive a start and terminal observation for each actual System One fetch, including internal retries, HTTP failures, malformed JSON, malformed answers, network failure and cancellation. Observations SHALL use stable local attempt ordinals and SHALL distinguish a successful response with incomplete answers from a complete response. No start SHALL be emitted for authentication, request construction or pre-aborted work that never reaches fetch. Observer exceptions and rejected observer promises SHALL NOT cause a retry, change a classifier judgment or escape unhandled.

#### Scenario: Retry then success
- **WHEN** fetch returns a retryable 503 followed by a valid response
- **THEN** two distinct attempts are observed with their actual statuses and one logical classify result is returned

#### Scenario: Cancellation after dispatch
- **WHEN** a request starts and is then cancelled
- **THEN** its start remains observable and its cancellation is not described as zero work

#### Scenario: Observer fails
- **WHEN** a supplied observer throws or returns a rejected promise
- **THEN** the transport still makes only its otherwise necessary attempts and the callback failure creates no unhandled rejection

### Requirement: Partial answers remain separate
Observation-enabled classification SHALL expose individually valid requested answers separately from final answers when another member is missing or malformed. Partial members SHALL satisfy the actual question's type, labels and numeric field constraints; missing numeric fields SHALL NOT be synthesized. Extra unrequested answers SHALL NOT enter the partial map. Legal own JSON keys SHALL survive unchanged. A partial map SHALL NOT turn an error or abort into final success.

#### Scenario: Two valid members and one missing member
- **WHEN** A and B are valid but C is missing
- **THEN** the observation contains A and B, identifies C as unresolved, and the strict final map is empty

#### Scenario: Invalid numerical member
- **WHEN** a member has an invalid confidence, probability, score or choice label
- **THEN** it remains unresolved and does not prevent an independent valid member from being observed

#### Scenario: Special question identifiers
- **WHEN** a requested question or label is an own key named `__proto__`, `constructor` or `toString`
- **THEN** its observation preserves the key without consulting inherited properties

### Requirement: Honest usage and price provenance
Observations SHALL retain independently valid nonnegative finite input tokens, output tokens and provider-reported USD charge, including reported zero. Missing or malformed fields SHALL remain absent, independently of legacy normalized usage. A catalog-based estimate SHALL be labelled separately and SHALL NOT populate the provider-charge field. Usage on malformed answer responses SHALL remain observable. Response model identifiers SHALL be separate from the requested frozen model identity.

#### Scenario: Partial usage and zero charge
- **WHEN** a response reports input tokens 17, omits output tokens and reports a USD charge of zero
- **THEN** the observation contains input 17 and charge 0 but no output value

#### Scenario: Catalog has zero prices
- **WHEN** the provider reports no charge and the model catalog prices are zero
- **THEN** no provider-billed zero charge is invented

#### Scenario: Malformed answers were metered
- **WHEN** a response has usable usage fields but malformed answers
- **THEN** its usage remains observable separately from the failed judgment

### Requirement: Observation privacy
Observations SHALL contain only bounded contract fields, not request state, evidence bodies, credentials, headers, raw response bodies or arbitrary provider extras. Structured error categories SHALL NOT require consumers to persist raw provider errors. Observations SHALL not initiate any additional provider request.

#### Scenario: Echoed sensitive response
- **WHEN** an error body echoes a credential and request state
- **THEN** neither appears in the observation, and the HTTP failure is still identified
