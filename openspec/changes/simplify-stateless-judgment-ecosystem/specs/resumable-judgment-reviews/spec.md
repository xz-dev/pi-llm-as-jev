## REMOVED Requirements

### Requirement: Additive resumable review discovery
**Reason**: Version two exposes ordinary stateless judgment only.
**Migration**: Use version-two `judge()` with complete packed state; replace review-version checks in watchdog and copied clients. Do not advertise a compatibility `review()` facade.

### Requirement: Durable completed stages and valid partials
**Reason**: Service-owned persistence and partial-progress recovery are removed.
**Migration**: Audit retains its own acknowledged business progress. Watchdog uses only a validated complete judgment or its existing incomplete-review path. Leave historical session entries intact.

### Requirement: Exact stage identity and continuity
**Reason**: No reusable service stages or checkpoints remain.
**Migration**: Consumers maintain their existing factual scope/currentness checks and supply necessary original facts, not service checkpoint seeds or cached opinions.

### Requirement: Progressive recovery preserves predecessor capacity behavior
**Reason**: Capacity learning and generic evidence/question subdivision are outside the two core responsibilities.
**Migration**: Use lightweight declared metadata for consumer packing. Audit reduces whole-loop segments on explicit overflow; watchdog reports incomplete when required facts cannot fit.

### Requirement: Ordered opinions and finality
**Reason**: There is no service stage/opinion progression.
**Migration**: Consumers retain source chronology and factual authority. Each judgment validates all required raw answers before publishing accepted final answers.

### Requirement: Honest attempt diagnostics
**Reason**: Transport-attempt accounting is removed, not renamed as logical-call accounting.
**Migration**: Remove attempt/hit/join/cost-completeness UI and acceptance dependencies. Optional usage retains its source and scope; absence is not zero.

### Requirement: Safe persistence and cancellation
**Reason**: Service persistence disappears; cancellation remains part of the ordinary judgment contract.
**Migration**: Preserve active-call cancellation, late-result fencing and credential-free results under `judgment-service`; preserve consumer-owned business histories without replaying old service records.
