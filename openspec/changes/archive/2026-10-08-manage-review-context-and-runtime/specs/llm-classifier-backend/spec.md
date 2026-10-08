## ADDED Requirements

### Requirement: LLM waits follow transport activity
LLM execution SHALL use Pi's provider-neutral streaming path with a plugin-owned first-response/transport-inactivity clock per attempt. The explicit caller `timeoutMs`, otherwise the configured default at admission, SHALL supply that window. Raw bytes, reasoning, incremental tool arguments and provider/protocol events SHALL count as activity, and observers SHALL be composed rather than overwritten. The window SHALL not be forwarded to an SDK as a whole-request timer. Pi's underlying transport limits remain host-owned.

#### Scenario: Continuous long response
- **WHEN** real transport activity continues beyond the supplied duration with gaps below its inactivity window
- **THEN** the LLM request can finish without a whole-review countdown aborting it

#### Scenario: Successive questions or repair
- **WHEN** several questions or the one permitted malformed-output repair exceed the supplied duration in aggregate
- **THEN** each request starts its own inactivity window instead of receiving a depleted remainder

#### Scenario: Missing first response or stalled body
- **WHEN** no first response arrives or an active stream stops producing activity for the window
- **THEN** execution settles as an error, not a successful empty answer or an automatic whole-review retry

### Requirement: All LLM entry points share timing and cancellation
Legacy judgment, review and the emulated classifier SHALL use the same activity-based LLM backend. Setup/discovery/authentication SHALL remain bounded. Caller abort, branch invalidation and shutdown SHALL settle even when an asynchronous adapter ignores cancellation. Disposed clocks and closed observations SHALL ignore late activity and outcomes. The main-session model/thinking and process-global networking settings SHALL not be changed.

#### Scenario: Default duration is retained
- **WHEN** a service call omits an explicit override
- **THEN** the configured default still bounds LLM inactivity rather than silently allowing an unbounded wait

#### Scenario: Uncooperative adapter
- **WHEN** cancellation or the applicable waiting guard fires while a provider promise does not settle
- **THEN** the public call still settles and late output cannot change returned results or enter a new generation

#### Scenario: In-flight joiners
- **WHEN** a caller requests a different LLM inactivity window from the pending owner
- **THEN** it does not silently inherit that owner's incompatible waiting policy

### Requirement: Recovery and useful partial work remain finite
Only malformed discrete output SHALL receive the existing one repair attempt. Auth, quota, transport, idle and cancellation failures SHALL not amplify retries or select another backend. Review MAY persist independently validated and observed finite members before later questions execute, but a failed aggregate SHALL have no final answers or completed-stage coverage. Legacy `judge` SHALL not gain partial-on-abort writes.

#### Scenario: A/B succeed and C fails
- **WHEN** A/B are validated and acknowledged before C fails
- **THEN** review retains compatible A/B for retry without declaring the failed call complete

#### Scenario: Activity without visible prose
- **WHEN** the provider emits only reasoning, tool arguments, protocol events or keepalive bytes
- **THEN** activity still resets the clock while any missing usage remains explicitly unknown
