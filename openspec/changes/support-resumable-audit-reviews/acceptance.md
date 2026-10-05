# Local migration candidate acceptance

Implementation and independent **offline** acceptance are complete. The final reviewer approved R2 with explicit residual risk and closed F1/F2; this is not installed rollout or user/business acceptance. No new live inference, publication, commit/push or archive is included.

## Independent approval and final delivery

- Approved candidate: `/var/tmp/judgment-migration-candidate-r2.json`, SHA-256 `c82e58a35ac79698cfcc9f4055cf6eae91834c3b3b3956a2da8d3cc4cb4f3566`.
- Verdict: **Approved with explicit residual risk**, reviewer run `2a1ebdc7-8894-4af5-8da7-e6adc9e749df`; preserved report `/var/tmp/judgment-migration-review-r2.md`.
- Reviewer independently checked all **85 delivery hashes**, three HEADs/branches/patches, unstaged indexes, service **296**, audit **311**, and source-linked integration **70** passing tests; evidence `/var/tmp/r2-review-integrity.json` and `/var/tmp/r2-review-{service-test,audit-test,wire}.log`.
- The additional reviewer probe `/var/tmp/r2-review-promotion.ts` confirms an earlier successful question half cannot overwrite later evidence-stage final answers; repeat/reload produce zero sends. Both original F1/F2 probes pass.
- Service and audit tasks are **13/13 each**. Pi remains the unchanged independently verified six-file prerequisite (80 passing focused tests). Both predecessor changes remain unchanged and unarchived.
- Full changed-file inventory and final bookkeeping receipt: `/var/tmp/judgment-migration-delivery.json`. Delivery spans **32 service, 47 audit and 6 Pi files**. The approved implementation, tests, interfaces, READMEs and generated outputs are unchanged; only this acceptance record, audit's regression map and final task checkboxes were updated after approval. Those documentation-only differences are explicitly recorded, not represented as part of the independently approved R2 byte snapshot.

Changed areas: canonical/additive review client and generated outputs; shared selection/policy/cache/capacity/recovery/ledger/attempt observation; audit service discovery and factual projection/receipts/advisory safety/config migration; isolated historical test comparisons and actual source-linked integration; both READMEs and OpenSpec evidence. No runtime audit HTTP/auth/cache/recovery fallback remains.

Residual limits stay explicit: 56 non-blocking lint warnings; difficult retained-facts corpus may remain incomplete rather than drop facts; full audit token lifetime remains per extension load; unsupported observation seams fail honestly. Offline approval does not establish current Windows execution, installed activation, live model quality, billing savings or universal provider support.

## F1/F2 repair evidence (approved at R2)

The first independent review returned **Changes required**, not approval, for manifest `ad3182db42fa2f4c2948efa08622ed71512caed60aafac5589b900d526b32486`. Report: `/var/tmp/judgment-migration-review-r1.md`. The revised candidate is `/var/tmp/judgment-migration-candidate-r2.json`; the original manifest/patches are preserved.

- **F1:** `subdivide` now receives the actual unanswered-envelope constraint. Request-only pressure keeps complete evidence and frozen priors while batching questions; state pressure reduces evidence. Unclassified rejections compare serialized candidate reductions rather than guessing from record count. If a question subtree discovers that evidence must shrink, it performs one complete-question evidence traversal, and ancestor question loops retain that result rather than replaying it per sibling or mixing factual stages. An irreducible source participates in the fixed admission floor so fallible state-size hints do not multiply an admissible retry.
- **F2:** dependency feedback recognizes both ordinary and full manual labels; each manual request gets an error even after an automatic notice. Automatic deduplication, zero fallback/auth/ledger/advice before discovery, and later-compatible-service discovery remain unchanged.
- `/var/tmp/review-f1-f2-red.log`: **six expected failures** before repairs (two mixed question-pressure cases, four manual-full feedback cases).
- `/var/tmp/review-f1-f2-focused.log`: focused contracts green. Ownership tests also strengthen partial question failure/reload by retaining six evidence records on every batch; no original assertion was weakened.
- Original reviewer scripts are unchanged and now pass: `/var/tmp/repair-final-review-question-dimension.log` shows six records/eight questions **2 attempts, 1 stage, 1 pre-split**, both packets contain all six records with empty prior; `/var/tmp/repair-final-review-manual-full.log` shows warning → explicit full error → explicit ordinary error.
- Final repaired checks: `/var/tmp/repair-service.log` **296 pass**, types/build pass, 56 warnings unchanged; `/var/tmp/repair-audit.log` **311 pass / 70 optional skips / 0 fail / 2,982 assertions**; `/var/tmp/repair-audit-types.log` pass; `/var/tmp/repair-wire.log` **70 pass / 0 fail / 2,206 assertions**. Both original state-pressure and irreducible/source/reload cases still pass. Pi files and client APIs are unchanged from the original reviewed candidate.

F1/F2 were independently closed on R2, including affected recovery/persistence interactions. The reviewer accepted the full-token lifetime and fragment/local-independence interpretations within the original contracts, and classified the three new style warnings as non-blocking. Parent test results alone were not used as approval.

## Initial candidate and authority (preserved evidence)

- Service: `/home/xz/Code/ai/pi-llm-as-jev`, baseline `905d734c1d9b022758300102927635adcee6d1ab`.
- Audit: `/home/xz/Code/ai/pi-jev-todo-audit`, baseline `f02aaf4ac401539ead6c5a0413b0f2b1e73336e0`.
- Pi: `/var/tmp/pi-classifier-attempt-observations`, branch `patch/classifier-attempt-observations`, upstream `200387122ca450d6387f033949423114a270b96c`. All six hashes still match `/var/tmp/pi-observations-parent-repair-manifest.json`; prior independent Pi approval remains component-only.
- Initial review locator: `/var/tmp/judgment-migration-candidate.json`, with HEADs, tracked patch digests and individual hashes for tracked **and untracked** deliverables. Audit `.serena/` is unrelated and excluded. Full diffs/logs are local artifacts, not published content.
- Requirements: this change's proposal/design/spec; audit `use-shared-judgment-service`; both unchanged audit predecessors `prevent-audit-request-amplification` and `improve-audit-context-fidelity`.

## Initial candidate commands (superseded by repaired gates above)

Service cwd:

```sh
npm run check
```

Result: **296 tests passed**, types/build passed, **56 lint warnings**, no lint errors. `/var/tmp/final-service.log`. Build now synchronizes tracked `client/judgment-client.js` and `.d.ts` from `dist/client/` via `scripts/sync-client.mjs`; byte equality is checked separately. The canonical TypeScript client equals audit's copy. The README's five actual TypeScript examples compile and execute under offline bindings.

Audit cwd (remove inherited `PI_JEV_TODO_AUDIT_OWNER_PID` only in these test subprocesses):

```sh
bun test
npm run typecheck
node "test/fixtures/node ownership.mjs"
PI_JUDGMENT_SOURCE="/home/xz/Code/ai/pi-llm-as-jev" \
PI_CLASSIFIER_SOURCE="/var/tmp/pi-classifier-attempt-observations" \
bun test test/shared-service.integration.test.ts \
  test/shared-service-boundary.integration.test.ts \
  test/shared-service-llm.integration.test.ts \
  test/shared-service-corpus.integration.test.ts \
  test/shared-service-ownership.integration.test.ts \
  test/shared-service-accounting.integration.test.ts
npm pack --dry-run --ignore-scripts --offline --json
```

Results: **303 ordinary tests passed / 66 optional skips / 0 failed / 2,862 assertions**; all six explicitly enabled suites **66 passed / 0 failed / 1,974 assertions**; types and Node parent/child/grandchild ownership passed. Package dry-run has **16 files, no tests/legacy**; no package was published. Logs: `/var/tmp/final-{audit,audit-types,node-ownership,wire}.log`, `/var/tmp/final-audit-pack.json`. Ordinary tests include labelled historical-engine comparisons; those are not new-owner evidence.

Pi `packages/ai` cwd:

```sh
node ../../node_modules/vitest/dist/cli.js --run \
  test/system-one-observation-regressions.test.ts \
  test/system-one-observation.test.ts test/typesafe-system-one.test.ts \
  test/cloudflare-workers-ai-system-one.test.ts test/llama-cpp-classify.test.ts \
  test/classifier-models.test.ts --reporter=dot
```

Result: **80/80 tests in six files**, `/var/tmp/final-pi-focused.log`. No Pi source/fixture/main changes were made in this closure pass. The earlier Pi full check remains attached to the same six-file hashes, not a new runtime rollout.

Both migration changes and both audit predecessor changes pass `openspec validate <change> --strict` in their respective CLI-resolved roots. Planning validity is not runtime evidence. `git diff --check` and client/generated equality are recorded with the final manifest.

## Service task → owner → evidence

| Task | Implementation / decisive evidence |
| --- | --- |
| 1.1 | Canonical client + generated JS/declarations + audit copy; `judgment-client`, `contract`, README examples, legacy service tests; unchanged final-only judge behavior. |
| 1.2 | Common `runStages`, not a parallel review engine. Ownership wire tests cover individual question identity/new C, facts/metadata/order/legal own keys; existing common-engine regressions cover prior opinions/finality/policy. Boundary tests reject omitted required ids, contradictory unresolved declarations, throwing/async projectors; original evidence cannot be mutated/forged. |
| 2.1 | Ledger answer references precede checkpoints; entry stage-one/two → third failure → reload; R10 failed append never acknowledges durable progress; branch-isolation entry/late-lifecycle cases. |
| 2.2 | Real native omitted C/granularity resumes only that member; low-confidence 0.7 raw reuse under 0.8; ownership independent batches retain frozen priors. |
| 2.3 | R02 compaction/id-less authority, R06 contiguous genuine bounds and same full token, R16 incremental/new-only source traversal; same-token reload/new-token wire case; first-slice checkpoint scope validation. |
| 2.4 | Legacy `F4: abort after a completed early stage persists no judgments` remains green. New real boundary case preserves two pre-abort durable stages, switches branch, consumes late transport rejection without writes/result mutation, then restores and pays only third-stage work. Deadline and isolated joiner cancellation checks also pass. |
| 3.1 | Service limits config RED→GREEN; real direct/router/custom/override matrices, independent request and state-plus-longest dimensions, exact wire bytes and transport identity. Overrides apply to judge and review; no audit routing/limit ownership. |
| 3.2 | Actual 1/6/69-record × 12-question admission, R01 first-leaf irreducibility, R15 learning/reload, lower-density correction, exact rejected-single superset protection. Original 15-envelope sample also resides at service owner. |
| 3.3 | Actual patched Pi native start/end observations, partial/malformed members, unknown vs zero usage, bounded 429/500 retries, cache/join no new cost, no unsupported-observer backend substitution. |
| 3.4 | Actual Pi Anthropic HTTP/SSE seam, configured independent LLM/thinking, maxRetries=0, typed overflow vs non-overflow errors, unknown/zero usage and separate catalog estimates; unsupported/ambiguous seams fail accounting. |
| 3.5 | Service attempt/ledger sanitization; real provider-body privacy and old-key redaction; deadline/branch isolation. Frozen-clock two-instance test reproduces duplicate operation IDs RED; instance UUID repairs identity collision. Charges stay distinct from estimates. |
| 4.1 | Updated service/audit READMEs, complete service check and README execution; RED locators below. |
| 4.2 | Explicit task-scoped source roots in six opt-in suites; actual audit registration → service → patched Pi and fake fetch. No unconditional sibling package dependency or installed-package edits. |

## Closure RED/GREEN evidence

- Config trusted-project presence/redaction: `/var/tmp/config-migration-red.log`; public negative control `/var/tmp/config-redaction-public-red.log` fails when forwarding read-layer secrets is removed. Restored candidate passes config/public-port/full audit/type/wire checks. Assertions are outside audit's swallowed callback boundary.
- Projection omission, all-withheld projection and attempt-id collision: `/var/tmp/lifecycle-projection-red.log` has **3 failures**; `/var/tmp/lifecycle-projection-green.log` has **30 passing cases / 300 assertions** after minimal service fixes.
- Actual locally withheld task #5 / supported sibling #7: `/var/tmp/independent-withheld-evidence.log`, then included in the full wire gate. No withheld question dispatch or full-range receipt; only #7 receives a board-only correction.
- Exact actual-entry source/coverage/role and remembered-primary candidate changes: `/var/tmp/entry-final-source-check.log`, included in the full wire gate. Changes require new work; unchanged repeats are zero-send. The next task-local candidate set includes the new valid prior-selected source.
- Earlier capacity/cache/source RED→GREEN locators and original-assertion mappings remain in audit `regression-map.md`; they are not replaced by aggregate test counts.

## Two explicit contract boundaries

**Full review token lifetime:** audit baseline `f02aaf4:index.ts` already used an in-memory `fullReviews` map with the same unfinished-token creation/deletion rules. The approved audit full scenario requires a new fresh identity and successful ordinary baseline, not persistence of this consumer-generated token across extension loads. Actual entry proves interrupted full retry within one load, completed-full ordinary reuse and next-full new work. Separately, service contract same-token recovery across reload is proven by the explicit token wire test. The README now distinguishes these, without claiming host-restart survival of audit's token.

**Fragment finality vs local independence:** stage receipts measure processing, not factual completeness. Audit's stage adapter keeps task supplements fixed and traverses public history; a fragment of unscoped public text cannot be declared unrelated by title/old opinion/source selection. R06 adversarial early-constraint tests withhold completion/continuation when only a tail remains; whole-source controls preserve the constraint. That safety guard is not used to reject all local uncertainty: the actual #5/#7 withholding case above preserves the independent correction from complete source facts. These are separate requirements, not a waiver of either one.

## Warnings and residual limits

The 56 warnings are **52 in unchanged tests** (`backend-llm`: 2, `index`: 24, `service`: 26), plus four in `src/service.ts`. One optional-chain warning on joined-result handling is present verbatim at baseline; the three migration-added warnings are an unused type import, an optional-chain suggestion for seed validation and a non-null assertion after the seed's durable references were checked. They are non-blocking lint findings, not hidden test failures. Structured inventory: `/var/tmp/final-lint-candidate.json`. No broad stylistic rewrite was performed.

Offline mechanical evidence does not establish live model quality, billing improvement, every provider adapter's review observability, installed activation or Windows execution of this candidate. The difficult retained-facts corpus still honestly stops incomplete. Unsupported adapter coverage is unknown expense, never zero. The independent reviewer judged these limits against the contracts and approved R2 with explicit residual risk; this producer report is not the source of that approval.
