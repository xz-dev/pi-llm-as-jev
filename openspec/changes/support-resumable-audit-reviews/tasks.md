## 1. Additive review contract

- [x] 1.1 Add versioned review discovery, result/progress/attempt types and projection contract to the canonical client; verify generated client artifacts and old version-one callers still compile and preserve final-only errors.
- [x] 1.2 Implement one bounded review path through the existing engine with projection validation and full identity; verify changed facts/questions/order/metadata/advisory opinions/finality invalidate reuse, threshold-only changes do not, and arbitrary own JSON keys survive.

## 2. Durable recovery

- [x] 2.1 Add active-branch checkpoint persistence after validated answer writes and exact restore validation; verify two committed stages survive third-stage failure/reload, append failure never advances durable progress and abandoned-branch records are unusable.
- [x] 2.2 Consume Pi's individually valid partial answers without exposing incomplete final answers; verify retry sends only unresolved members, low-confidence raw members remain reusable and independent question batches share frozen prior opinions.
- [x] 2.3 Support incremental checkpoint seeds and hashed fresh-review membership; verify ordinary incremental review, same-token interruption recovery, new-token full review, compaction gaps and mid-record bounds without replaying completed provider work or treating opinions as facts.
- [x] 2.4 Preserve legacy judge abort buffering while review commits only completed pre-abort stages; verify branch/generation replacement, waiter cancellation, whole-call deadline and late-rejection regressions.

## 3. Capacity and attempt provenance

- [x] 3.1 Add service-owned channel limits and exact serialized-envelope measurement with transport-scoped identities; verify TypeSafe-direct versus OpenRouter two-dimensional profiles, custom override precedence and no unrelated channel calibration reuse.
- [x] 3.2 Port fixed-state admission correction and constrained-dimension recovery; verify 69 records/12 questions admitted in one attempt, lower-density correction survives reload, exact rejected envelopes are not resent and confirmed irreducible fixed facts stop without Cartesian traversal.
- [x] 3.3 Capture native Pi attempt start/end observations and partial usage; verify retry/malformed/overflow/cancelled outcomes, reported response model, cache/join zero new charge and unsupported-adapter accounting failure without backend substitution.
- [x] 3.4 Capture supported Pi LLM HTTP/SSE attempts with retries disabled and provider-event presence-aware usage; verify discrete outcomes, effective thinking, token/charge absence, capability failure for unsupported seams and no self-rated confidence policy.
- [x] 3.5 Persist bounded attempt observations and report known sums/missing counts separately from catalog estimates; verify no body/credential/fresh-token leakage, no new-branch late writes and no duplicate owner accounting.

## 4. Service handoff

- [x] 4.1 Update README and migration guidance; run the full service check plus focused review regressions and unchanged legacy tests, retaining RED evidence for the added behavior.
- [x] 4.2 Provide exact local Pi/service source linkage for the audit integration harness without publishing or altering installed packages; verify actual adapter-to-service events rather than mocked service-only receipts.
