# judgment-ecosystem-integration Specification

## Purpose
Keep the judgment service and its dependent audit and watchdog plugins usable as one coordinated ecosystem while replacing stateful review protocols with stateless classification and judgment.

## Requirements

### Requirement: Consumers identify the supported judgment contract
The service's distributed client and the copies consumed by `pi-jev-todo-audit` and `pi-continue-watchdog` SHALL describe the same version-two request/result and capacity contracts. Consumers SHALL check compatibility at each eligible call without a probe inference. Missing, version-one or otherwise incompatible services SHALL produce the consumer's existing dependency-unavailable behavior rather than a direct-provider fallback, automatic downgrade or fake review adapter. Old consumers presented with version two SHALL fail their compatibility check safely. Independent package source selection and native updates SHALL remain possible; no new service pin SHALL be imposed on users.

#### Scenario: Compatible set in either load order
- **WHEN** version-two consumers and service load in either order
- **THEN** each later eligible call discovers the same single service and uses the ordinary judgment entry without duplicate activation

#### Scenario: Mixed-version audit
- **WHEN** either side of an audit/service pair requires a different service version
- **THEN** audit skips inference/advice with its normal dependency notice, preserves TODO/main-agent work and checks again on a later eligible trigger

#### Scenario: Mixed-version watchdog
- **WHEN** watchdog cannot discover a compatible judgment service
- **THEN** it marks review unavailable and applies its existing still-current-original-unlock behavior without claiming review approval

### Requirement: Audit owns incremental business progress
Audit SHALL continue to own question construction, effective source projection, whole-loop packing, scheduling, scope/currentness checks and acknowledged durable business progress. It SHALL obtain inference only from version-two `judge()`, use declared capacity metadata with explicitly consumer-owned estimates, and reduce complete loop segments only on explicit context overflow. It SHALL not crop required facts, rely on service checkpoints or install a replacement service cache. Independently valid completed consumer scopes SHALL retain their existing persistence and advice rules. Full audit SHALL reset/reassess the consumer's scope using its existing business-state mechanism rather than a service `fresh` token.

Native thresholds SHALL remain service-owned and LLM compatibility numbers SHALL not gain numeric authority. Ownership suppression, user-source authority, stale-result rejection and normal TODO/main-agent behavior SHALL remain intact. Legacy audit timeout configuration SHALL require explicit migration to the new call options rather than silently changing its meaning.

#### Scenario: Later segment fails
- **WHEN** audit has acknowledged earlier complete segments and a later judgment fails
- **THEN** earlier consumer progress remains, the failing scope does not advance, and no incomplete result becomes definitive advice

#### Scenario: Unchanged task state
- **WHEN** audit's existing durable state shows no new eligible work
- **THEN** audit need not call the service; this is consumer scheduling, not a claim of service cache reuse

#### Scenario: Whole-loop overflow recovery
- **WHEN** a packed multi-loop judgment returns confirmed terminal context overflow
- **THEN** audit can retry a smaller complete-loop prefix without splitting a loop or deleting necessary fixed facts

### Requirement: Audit delivery remains independently managed
Audit's provisioning and status paths SHALL use version-two compatibility consistently with its inference path. First eligible provisioning SHALL retain the unqualified independent Git source and Pi-native package machinery, trust/offline/resource/ownership gates, scoped registration and single-activation behavior. Existing disabled, pinned, filtered, incompatible or failing service selections SHALL not be replaced, re-enabled or downgraded. A successful installation SHALL not be described as compatible readiness until version-two capability is available. Read-only status SHALL not install, resolve credentials or infer.

#### Scenario: New independent installation
- **WHEN** eligible audit provisioning finds no selected service and installs a compatible current service
- **THEN** the ordinary service commands and version-two judgment capability become available once, without a paid readiness probe

#### Scenario: User chose an old service
- **WHEN** a user's selected or pinned service exposes version one
- **THEN** audit reports incompatibility without replacing the source, removing the pin or installing an older/newer substitute behind the user's choice

### Requirement: Watchdog consumes final judgments without transport accounting
Watchdog SHALL preserve its complete permitted macro-evidence projection and call version-two `judge()` for its support/challenge/insufficient-evidence question. It SHALL accept only a successful, current, complete, correctly typed legal required answer. It SHALL not require `reviewVersion`, `unresolved`, checkpoint progress or `observationCoverage`. Removed observation completeness SHALL not be replaced by a fabricated successful-observation marker. Source gaps, missing/dropped/invalid answers, errors, timeout, unavailable dependencies and context overflow SHALL remain incomplete-review conditions.

A supported judgment SHALL release the original candidate through existing currentness/publication checks. An incomplete judgment SHALL preserve the same still-current-original-unlock policy with a warning/disposition, without claiming approval. Only a valid definite challenge SHALL allow the existing single semantic reconsideration; it SHALL not itself choose a replacement action or create user authority. Manual unlock, user cancellation, terminal errors, stale candidates, ownership loss and session replacement SHALL retain their existing bypass/cancellation behavior. Watchdog SHALL not add an outer total timer, independent model routing, a cache, factual cropping or a retry/recovery engine.

#### Scenario: Valid challenge without attempt observations
- **WHEN** a current version-two judgment returns the legal required `challenged` choice and no transport diagnostics
- **THEN** watchdog permits at most its existing one reconsideration after local validation, without manufacturing observation evidence

#### Scenario: Unsupported evidence or malformed result
- **WHEN** necessary permitted facts are unavailable or the returned required answer is missing/malformed
- **THEN** review is incomplete, not a challenge or approval, and the still-current original candidate follows existing policy

#### Scenario: Cancellation wins
- **WHEN** the user takes over or manually unlocks while judgment is pending
- **THEN** owned work is cancelled and neither its late answer nor an incomplete-result fallback resurrects the old candidate

### Requirement: Diagnostics keep their actual meaning
Consumers SHALL remove service-cache hit/join counters, persistent stage receipts and required HTTP-attempt/charge-completeness fields from new result handling and user-facing claims. Optional reported usage SHALL stay optional and scoped to the backend result; absent usage SHALL not become zero. A logical judgment or question count SHALL not be renamed as a measured HTTP-attempt count. Consumer-owned audit progress and watchdog history SHALL remain under their existing privacy/authority rules. Historical records SHALL remain readable as history without being promoted to current runtime authority or new-schema telemetry.

#### Scenario: Missing usage after fallback
- **WHEN** a final judgment lacks usage for failed primary work
- **THEN** diagnostics omit a complete-operation charge claim instead of reporting zero or presenting alternate-only usage as total billing

#### Scenario: Existing session history
- **WHEN** a session contains old service observations or consumer review records
- **THEN** the upgrade leaves them intact and does not restore pending calls, checkpoints, locks or execution authority from them

### Requirement: Source publication is gated by meaningful CI/CD
The coordinated source release SHALL execute real typecheck, behavioral test, build and package-content checks. Both consumers' actual-candidate-service paths SHALL execute rather than skip. Relevant failures SHALL fail their gate; representative isolated negative controls SHALL demonstrate this. Existing watchdog e2e/install-policy coverage SHALL remain, including the supported standalone Pi's Bun installation path. Local success, formatting-only checks or an unrelated green revision SHALL NOT establish release success.

Concrete source destinations/versions and Git writes SHALL be confirmed before publication. Each release SHALL identify its exact source revision, corresponding remote CI runs and produced distributable contents. Git publication SHALL NOT imply installed activation or authorize changing package privacy, user pins or credentials.

#### Scenario: Required integration is skipped
- **WHEN** a consumer test command exits successfully but its required actual-service tests did not execute
- **THEN** source-release acceptance remains incomplete despite the green exit code

#### Scenario: Supported install path fails
- **WHEN** npm checks pass but the supported standalone Pi Bun install or private-runtime export check fails
- **THEN** CI fails and the candidate is not reported releasable

#### Scenario: Green run belongs to an older revision
- **WHEN** a released commit differs from the verified workflow head
- **THEN** publication remains unverified until the exact released revision passes the meaningful gates

### Requirement: Coordinated delivery has cross-repository acceptance
The change SHALL not be called ecosystem-complete on service-only tests. Acceptance SHALL exercise the actual candidate service with each adapted consumer, both automatic directions and forced modes, new timing defaults, heartbeat-versus-generation behavior, hard-cap/no-cap behavior, cancellation, malformed/overflow responses, mixed-version outcomes and package-order independence. Existing deterministic fixtures and offline-host mechanisms SHALL be reused without live credentials or paid inference. A candidate delivery record SHALL identify the three tested source revisions/artifacts, relevant host version, test results and any unperformed installation step.

Activation SHALL use the tested set through normal package/reload mechanisms only after separate authorization. Recovery SHALL restore the previous matched source/configuration set without deleting session history, overriding user source choices or reverting unrelated work. Source completion and observed installed activation SHALL be reported separately.

#### Scenario: Service tests pass before consumers
- **WHEN** only the service candidate has passed its checks
- **THEN** cross-repository acceptance remains pending and the ecosystem is not reported ready for activation

#### Scenario: Independent update creates a mismatch
- **WHEN** native updating advances only the service or a consumer
- **THEN** incompatibility follows the defined degraded paths, with no silent downgrade or false readiness, until the matching set is activated
