## MODIFIED Requirements

### Requirement: Never throws
`judge()` SHALL resolve input, selection, abort, timeout and provider failures through `stopReason` and `errorMessage`, with no final answers on failure. Waiting SHALL follow the actual selected backend. The admitted explicit caller `timeoutMs`, otherwise the configured default, SHALL bound discovery/authentication. Native classifier execution SHALL retain one absolute logical-call deadline including internal stages. LLM execution SHALL instead apply a fresh first-response/transport-inactivity window to each attempt, reset by raw bytes and provider events, without a shared whole-review countdown or forwarding the window as an SDK total-request timeout. Cancellation SHALL remain effective and failure SHALL not implicitly select another backend.

#### Scenario: No backend available
- **WHEN** no allowed native classifier or configured LLM backend is available
- **THEN** the call resolves with an error naming the missing configuration and no answers

#### Scenario: Caller aborts legacy judgment
- **WHEN** the caller aborts an in-flight `judge()`
- **THEN** it resolves aborted without final answers or new partial judgment cache writes

#### Scenario: Applicable timeout expires
- **WHEN** setup, a native logical deadline or an LLM inactivity window expires
- **THEN** the call resolves with an error and does not restart the entire operation automatically

#### Scenario: Active stream outlasts the admitted duration
- **WHEN** transport activity continues with gaps smaller than the LLM inactivity window while total elapsed time exceeds it
- **THEN** no whole-review timer aborts the stream

### Requirement: Operation-scoped configuration snapshots
Each public `judge()`, `review()` and `availability()` operation SHALL obtain current settings at admission, including calls made through an older retained service handle. The admitted selection/configuration SHALL remain fixed through internal stages, capacity subdivisions, joins and output repair. Later operations SHALL obtain fresh settings without mutating older operations, resetting the branch or inheriting the main-session model/thinking.

Actual backend/model/transport, effective thinking, applicable limits and the explicit-or-configured timeout policy SHALL govern execution and exact reuse. A configuration edit alone SHALL not authorize incompatible cache/checkpoint reuse, implicit fallback, a hidden retry or cancellation of already-running work. The plugin SHALL leave Pi's process-wide transport dispatcher under host ownership. Legacy service and review versions SHALL remain callable; consumer cache and business-stage support SHALL be separately discoverable on the existing review surface.

#### Scenario: Retained handle sees a later save
- **WHEN** a consumer calls a retained service handle after a completed settings save
- **THEN** the new call uses the current selection and reports its actual execution identity

#### Scenario: Configuration changes during stages or discovery
- **WHEN** configuration X is captured and the file changes to Y while that operation is still running
- **THEN** its selection, effective options, cache identities and error reporting remain based on X

#### Scenario: New call overlaps old work
- **WHEN** a new operation starts under Y while X is still running
- **THEN** neither operation changes the other's admitted model/options and incompatible work is not joined

#### Scenario: Availability is fresh and read-only
- **WHEN** a consumer requests availability after settings change
- **THEN** it observes current candidates without a priming judgment, inference or settings write

#### Scenario: Configured timeout without caller override
- **WHEN** the caller omits `timeoutMs`
- **THEN** the captured configured duration is retained as setup/native total or LLM per-attempt inactivity policy, not silently discarded

#### Scenario: Compatible repeat after an identity change
- **WHEN** a consumer-owned review is reconstructed under a newly selected identity
- **THEN** only fully compatible raw values are reused and old consumer receipts do not cause repeated submission of an incompatible service seed
