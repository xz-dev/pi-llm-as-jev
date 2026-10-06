## ADDED Requirements

### Requirement: Operation-scoped configuration snapshots
Each public `judge()`, `review()` and `availability()` call SHALL obtain current global file settings at operation admission, including calls through a service handle acquired before the settings changed. The configuration snapshot SHALL be fixed for that entire call. A review's internal stages, splitting, malformed-output retries and recovery SHALL NOT become new configuration-reading boundaries. A later public review call, including a resumed review, SHALL obtain a new snapshot.

Backend selection, configured native and LLM references, effective thinking level, configured timeout and applicable context-limit overrides SHALL derive from that snapshot. Existing explicit caller-option precedence SHALL remain, including a caller timeout overriding the configured timeout. Helpers, error reporting and cache/ledger identities SHALL NOT combine settings from different snapshots. Configuration refresh SHALL preserve public service and review versions and SHALL NOT require consumers to replace their handle or call a refresh API.

Observing a changed configuration SHALL NOT itself cancel, restart or duplicate already-running work, clear the active branch ledger or invalidate otherwise reusable judgments. Existing caller abort, deadline, shutdown and branch-navigation semantics SHALL remain. Cache lookup, in-flight joining and review-checkpoint reuse SHALL continue to require matching actual backend, model and effective thinking identity; a changed configuration SHALL NOT enable cross-identity reuse.

#### Scenario: Existing service handle observes the next save
- **WHEN** B retains a service handle, A completes a save selecting a different usable backend/model, and B then calls `judge()` through that same handle
- **THEN** the call uses the new selection without reload or a configuration command in B, and reports the actual new identity

#### Scenario: Review spans an external edit
- **WHEN** a review starts with configuration X, the file changes to Y between evidence stages, and the review continues
- **THEN** all stages, retries, result metadata and stored judgments of that call retain X's selected backend/model/thinking and applicable limits; the edit alone sends no replacement request

#### Scenario: New call overlaps old work
- **WHEN** a judgment using X is still running and another judgment starts after configuration Y has been saved
- **THEN** the new call uses Y while the existing call finishes using X, without one call mutating the other's settings

#### Scenario: Edit during backend discovery
- **WHEN** a call captures X and the file changes to Y while model discovery or authentication is pending
- **THEN** the call selects and reports its backend using X, without mixing X's mode or timeout with Y's model or thinking level

#### Scenario: Failure retains the operation identity
- **WHEN** a call admitted with X fails after the file has changed to Y
- **THEN** its structured error identifies the selection made for that call, not an unrelated model from Y

#### Scenario: Availability is independently fresh
- **WHEN** another session changes either model slot before B calls `availability()`
- **THEN** B evaluates the current selected/default native and configured LLM candidates without a preceding judgment, inference request or settings mutation

#### Scenario: Configured timeout and limits change
- **WHEN** a new call starts after `timeoutMs` or applicable context-limit overrides change
- **THEN** that call uses the new defaults for deadline/admission behavior while explicit caller overrides keep their existing precedence and older calls retain their earlier snapshot

#### Scenario: No stale cache or in-flight identity
- **WHEN** identical questions are cached or in flight under one backend/model/thinking identity and a save selects a different identity before the next call
- **THEN** the next call does not reuse or join the older identity's work or restore an incompatible review checkpoint

#### Scenario: Unchanged settings still permit reuse
- **WHEN** a new operation rereads settings yielding the same effective identity and an exact matching judgment is available
- **THEN** it reuses that judgment under the existing policy without an extra provider request or a configuration-triggered branch reset

#### Scenario: A resumed review uses current selection
- **WHEN** a review returns and a later public `review()` call resumes the same evidence after the configured identity changes
- **THEN** the later call uses current settings and reuses only checkpoints compatible with that identity
