## ADDED Requirements

### Requirement: Backend-specific waiting policy is visible
Read-only service documentation/status SHALL distinguish the configured default from an explicit caller override and explain their actual-backend meaning: bounded setup and one native logical-call total deadline, or an LLM first-response/transport-inactivity window per attempt. Neither SHALL be described as an LLM whole-review countdown. The service SHALL leave Pi's underlying transport limits and process-wide dispatcher under host ownership; it SHALL not claim that unimplemented host-setting bridges or disabled plugin timeouts exist.

#### Scenario: Configured two-minute default
- **WHEN** the service configuration contains `timeoutMs: 120000` without a caller override
- **THEN** its stated meaning is two minutes for setup/native total or LLM per-attempt inactivity, not two minutes total across an active LLM review

#### Scenario: Explicit caller duration
- **WHEN** a caller supplies a valid positive integer `timeoutMs`
- **THEN** that admitted duration overrides the configuration default without choosing the backend or changing global settings

#### Scenario: Read-only inspection
- **WHEN** the user inspects service status or capability
- **THEN** no inference, settings write, main-session model change or hidden recovery attempt is performed, and availability is not represented as successful inference

#### Scenario: Native selection remains independent
- **WHEN** LLM settings or underlying host transport settings change
- **THEN** the configured native classifier remains independently selected and preserves its numerical policy and whole-call deadline
