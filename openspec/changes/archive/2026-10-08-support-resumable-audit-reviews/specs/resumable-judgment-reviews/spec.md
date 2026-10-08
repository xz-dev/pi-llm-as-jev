## Purpose

Allow advisory consumers to resume completed review stages and account for real provider work while retaining final-only judgment safety and shared backend ownership.

## ADDED Requirements

### Requirement: Additive resumable review discovery
The service SHALL retain its existing version-one `judge` interface and expose a separately discoverable version-one review extension. Legacy errors SHALL still contain no final answers. Review results SHALL separate final answers, completed-stage progress, unresolved work and attempt observations; consumers SHALL NOT need to infer progress from `reuse.sent` or usage totals.

#### Scenario: Older consumer
- **WHEN** a consumer calls only `judge`
- **THEN** it keeps its final-only contract and no partial result becomes successful answers

#### Scenario: Older service
- **WHEN** a consumer looks for the review extension on an old service
- **THEN** it detects the missing capability without sending a probe request

### Requirement: Durable completed stages and valid partials
A review SHALL durably record complete stages before publishing them as durable progress. Each stage SHALL require valid raw answers to all of its required questions; policy-dropped raw answers remain reusable but are not accepted advice. Individually valid native partial members SHALL remain reusable without advancing an incomplete range. A later failed or aborted stage SHALL expose no final answers and SHALL NOT erase previously committed complete stages. Work completed before an abort is historical progress, not permission to publish the aborted review. Legacy `judge` SHALL retain its no-new-judgments-on-abort behavior.

#### Scenario: Two stages succeed and the third fails
- **WHEN** two completed stages are persisted and the third fails, then the same branch is reloaded
- **THEN** ordinary review reuses those stages and sends only unresolved work, while the failed call has empty final answers

#### Scenario: Partial native batch
- **WHEN** A and B validate but C does not
- **THEN** A and B are stored under their complete identities, C alone is requested on a compatible retry, and the range does not advance until C is valid

#### Scenario: Persistence fails
- **WHEN** a stage ledger append fails
- **THEN** it is not advertised as durable progress, and a later reload does not skip it on the strength of a volatile cursor

#### Scenario: Abort and branch replacement
- **WHEN** a later stage is aborted or the active branch changes
- **THEN** earlier active-branch durable stages remain historical records, but no late answer, progress event or ledger write contaminates the new generation

### Requirement: Exact stage identity and continuity
Reuse SHALL bind backend, full model reference, effective thinking, fixed facts, complete question definitions, ordered evidence content/metadata, genuine fragment bounds, prior advisory opinions and stage finality. Forced-review membership SHALL be separate from ordinary identity and persisted only as a digest. Restored progress SHALL be verified against active-branch records and its captured identity. Consumers SHALL be able to carry validated prior opinions into a new incremental review as labelled advisory input; factual source selection remains the consumer's responsibility.

#### Scenario: Changed source or policy
- **WHEN** a fact, question, evidence order, metadata, prior opinion or model changes
- **THEN** a different identity cannot borrow a completed stage, while a threshold-only change rechecks stored raw values without new inference

#### Scenario: Full review retry
- **WHEN** a fresh review is retried with the same token after interruption
- **THEN** only results belonging to that fresh review are reused; a different token starts a new review without storing raw token text

#### Scenario: Fragment and special keys
- **WHEN** evidence has arbitrary own JSON keys and caller metadata named `fragment`
- **THEN** all text/order/metadata survives and recovery bounds come only from actual original text, not the caller's lookalike metadata

### Requirement: Progressive recovery preserves predecessor capacity behavior
The service SHALL own question and evidence recovery, without consumer transport or retry loops. It SHALL distinguish request-wide and state-plus-longest-question channel limits, use the actual serialized unanswered envelope including advisory state, learn from later successful lower-density input and restore learning on the active branch. Channel identity SHALL include transport configuration as well as backend/model. Service-owned configuration SHALL permit explicit channel limits; audit-owned limit fields SHALL NOT override it.

Predictions SHALL not count as attempts or actual rejections. An over-limit fixed-state prediction SHALL receive one real admission check of the current unanswered batch unless that exact envelope was already rejected. A successful check SHALL finish the stage without validation-only or per-question repeats. An irreducible prediction SHALL not prove rejection. Confirmed overflow SHALL reduce the constrained dimension, terminate when required fixed state cannot fit, and never resend an identical known-rejected envelope. Authentication, quota, rate, payload-size, generic validation and unknown errors SHALL not authorize context subdivision.

#### Scenario: Fixed-state prediction would multiply work
- **WHEN** retained state is overestimated with 69 new records and 12 unresolved questions but the provider admits the full batch
- **THEN** one attempt handles all questions, every record remains represented, and no 69-by-12 traversal occurs

#### Scenario: Distinct channel limits
- **WHEN** an envelope fits a TypeSafe-direct 64k request-wide and 32k per-question profile but exceeds an OpenRouter 32k single-window profile
- **THEN** channel-specific prediction distinguishes them without imposing the smaller limit on all direct batches

#### Scenario: Admission corrects the estimate
- **WHEN** a later lower-density envelope is admitted
- **THEN** future prediction and reload use the corrected observation, but exact earlier rejected envelopes remain protected

#### Scenario: Required fixed facts cannot fit
- **WHEN** the smallest necessary question and irreducible evidence still receive an explicit overflow
- **THEN** the affected scope stops with an actionable incomplete-account diagnostic, retaining facts and completed work rather than traversing all remaining combinations

### Requirement: Ordered opinions and finality
Intermediate opinions SHALL be advisory and replaced by later stage results, not accumulated by voting. Independent question batches SHALL evaluate the same frozen state. The consumer SHALL be able to project its stage-specific factual view and complete dynamic questions without owning the subdivision loop. No stage projection SHALL silently remove required original evidence or turn a missing question into complete coverage.

#### Scenario: Later evidence reverses the view
- **WHEN** an early stage suggests completion and later user evidence withdraws authority
- **THEN** only the later complete final view is eligible for advice, and neither union nor vote preserves the earlier completion

#### Scenario: Independent question batches
- **WHEN** capacity splits A/B and C/D over one stage
- **THEN** both see the same prior-stage opinions, not the other batch's new answers

### Requirement: Honest attempt diagnostics
Review diagnostics SHALL distinguish logical calls, per-question hits/joins/sends, actual started attempts, terminal observations and pre-splits. Every observed owner attempt, including retries, malformed responses, overflow and stale/cancelled work, SHALL have an identity; joined callers SHALL not charge it again. Missing token or charge fields SHALL remain unknown. Totals SHALL report sums of known values and counts of missing observations per field; partly known totals are lower bounds. Provider charges SHALL remain distinct from catalog estimates. Observations SHALL not trigger inference.

#### Scenario: Retry plus cache reuse
- **WHEN** a call makes two transport attempts and a later identical call uses cache
- **THEN** the first accounts for two attempts, the second for zero, and question send counts are not reported as request counts

#### Scenario: Partial usage
- **WHEN** one attempt reports input 10, another reports input 7/output 2, and neither reports a charge
- **THEN** input totals 17, output totals at least 2 with one missing observation, and no provider dollar total is invented

#### Scenario: Unsupported observations
- **WHEN** the selected adapter does not supply the required observation contract
- **THEN** review reports a structured capability/accounting failure without fabricating zero attempts or substituting another backend; legacy judge remains usable

### Requirement: Safe persistence and cancellation
Progress/judgment/attempt ledger entries SHALL be non-context two-argument appends containing only validated answers, digests, source identifiers/bounds and bounded diagnostics, never request/evidence bodies, credentials, provider extras or raw fresh tokens. All discovery, auth, projection, provider waits and recovery SHALL obey one deadline and generation. Joined waiter cancellation SHALL not abort an unrelated owner. Late promises SHALL remain rejection-handled. Stale attempt observations may be returned to their original caller for accounting but SHALL not write onto a new branch or authorize advice.

#### Scenario: Hung selection or observer
- **WHEN** discovery/auth/provider work ignores its signal or a consumer callback misbehaves
- **THEN** the call still settles within its deadline, work is actively cancelled where possible, and late rejection is handled

#### Scenario: Ledger privacy
- **WHEN** a review includes secrets, arbitrary evidence and a fresh token
- **THEN** neither its persisted progress nor diagnostics contain those bodies, secrets or raw token
