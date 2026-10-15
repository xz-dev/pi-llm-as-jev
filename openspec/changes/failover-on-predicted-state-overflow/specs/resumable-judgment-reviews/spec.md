## MODIFIED Requirements

### Requirement: Progressive recovery preserves predecessor capacity behavior
The service SHALL own question and evidence recovery, without consumer transport or retry loops. It SHALL distinguish request-wide and state-plus-longest-question channel limits, use the actual serialized unanswered envelope including advisory state, learn from later successful lower-density input and restore learning on the active branch. Channel identity SHALL include transport configuration as well as backend/model. Service-owned configuration SHALL permit explicit channel limits; audit-owned limit fields SHALL NOT override it.

Predictions SHALL not count as attempts or actual rejections. An over-limit fixed-state prediction SHALL receive one real admission check of the current unanswered batch unless that exact envelope was already rejected, or unless the irreducible floor (fixed state, evidence that cannot be split and the longest unanswered question) is predicted to exceed the attempt's state-plus-longest-question limit while an automatic route has an unused alternate whose candidate currently resolves. In that case the attempt SHALL end with a predicted context-overflow error without dispatch so that the alternate can run; the skip SHALL NOT record a capacity rejection, mark the envelope rejected or count as a transport attempt. A successful check SHALL finish the stage without validation-only or per-question repeats. An irreducible prediction SHALL not prove rejection. Confirmed overflow SHALL reduce the constrained dimension, terminate when required fixed state cannot fit, and never resend an identical known-rejected envelope. Authentication, quota, rate, payload-size, generic validation and unknown errors SHALL not authorize context subdivision.

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

#### Scenario: Predicted state overflow with a usable alternate
- **WHEN** an `auto` review's fixed state plus the longest unanswered question is predicted above the native attempt's `stateAndLongestQuestion` limit and the configured LLM resolves
- **THEN** no native request is sent, no rejection or capacity overflow is recorded, and the LLM answers the full logical request

#### Scenario: Predicted state overflow without an alternate
- **WHEN** the same prediction occurs in forced `classifier` mode, or in `auto` with no usable LLM
- **THEN** the current unanswered batch still receives one real admission check, as before
