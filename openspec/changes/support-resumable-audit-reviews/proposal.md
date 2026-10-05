## Why

Audit's existing rolling review preserves completed ranges and valid partial answers after a later failure, and accounts for individual provider requests. The current shared service exposes only final answers and aggregate usage; moving the audit unchanged onto that surface would lose those guarantees.

## What Changes

- Add an explicitly discoverable resumable review extension while keeping `version: 1` and existing `judge()` callers compatible. Failed reviews still expose no successful final answer map.
- Make durable completed-stage checkpoints, unresolved question identities and per-attempt diagnostics available separately from final judgments. Restore only verifiable active-branch work; observations and cursors never establish factual coverage or execution authority.
- Preserve valid partial native answers, using the Pi prerequisite's validated observation fields, without treating an incomplete response as final success.
- Move the audit predecessor's two-dimensional channel capacity, fixed-state admission correction and progress-making recovery guarantees into the shared service, rather than duplicating them in the consumer.
- Preserve per-field unknown usage and distinguish provider charges from catalog estimates; caches and joined callers do not double-charge owner attempts.
- Keep backend/model/thinking selection, native numeric policy, credential integration, transport, recovery and judgment storage in the service. LLM judgments remain discrete business choices, without self-rated confidence.

## Capabilities

### New Capabilities
- `resumable-judgment-reviews`: Opt-in durable review progress, partial-answer reuse, honest attempt diagnostics and audit-compatible recovery.

### Modified Capabilities
None. The additive review contract does not weaken the existing `judgment-service` contract.

## Impact

Depends on `expose-classifier-attempt-observations`; consumed by `/home/xz/Code/ai/pi-jev-todo-audit/openspec/changes/use-shared-judgment-service`. Affects the canonical copyable client, service/cache/ledger/capacity/backend seams, tests and README in this repository. Both audit predecessor changes (`prevent-audit-request-amplification`, `improve-audit-context-fidelity`) remain authoritative inputs and are not archived or overwritten.

Local cross-repository validation must use the actual patched Pi adapter and service, not just substitute a fake service result. No global configuration rewrite, installed plugin update, new paid inference, commit/push, archive or release is part of this change.
