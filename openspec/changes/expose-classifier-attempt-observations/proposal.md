## Why

The audit migration depends on facts that Pi's current System One result cannot express: individually usable answers in an incomplete response, missing versus zero usage, provider-reported charges, and each actual transport attempt. Replacing these with a final aggregate would weaken existing audit recovery and accounting guarantees.

## What Changes

- Add an optional, versioned classifier observation surface for System One adapters, exposing sanitized per-attempt outcomes, token-field presence, reported response model and provider-reported charges separately from catalog estimates.
- Expose individually validated answers separately from the strict final answer map when other requested members are missing or malformed. Ordinary classifier callers retain their existing all-or-error behavior.
- Observe actual fetch attempts, including retry failures and malformed successful responses, without changing transport ownership, authentication, default retry policy or `onResponse` semantics.
- Keep observer failure isolated from provider retries and classify results; do not expose request/response bodies, credentials or arbitrary provider fields in observations.

## Capabilities

### New Capabilities
- `classifier-attempt-observations`: Optional Pi classifier observations and strict/partial-result separation needed by resumable consumers.

### Modified Capabilities
None.

## Impact

Runtime changes belong only in `/var/tmp/pi-classifier-attempt-observations`, branch `patch/classifier-attempt-observations`, based on upstream `200387122ca450d6387f033949423114a270b96c`. Principal seams are `packages/ai/src/types.ts`, `packages/ai/src/api/system-one-shared.ts`, System One adapter tests and classifier documentation. This service repository is the planning home, not the Pi implementation target.

This change precedes `support-resumable-audit-reviews`, which precedes audit's `use-shared-judgment-service`. Development validation uses local sources and fake transport; installed Pi, provider credentials, live inference, release/version changes and publication are outside this change.
