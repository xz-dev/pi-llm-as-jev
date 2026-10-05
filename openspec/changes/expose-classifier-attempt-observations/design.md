## Context

See proposal.md. Pi's shared System One adapter parses all answers atomically, normalizes absent token fields to zero and prices normalized usage from the catalog. Its fetch closure already encloses every retry; no change to the generic retry utility is needed. Upstream's difference from the inspected installed baseline in `types.ts` only concerns sampling parameters, not classification.

## Goals / Non-Goals

**Goals:** an additive typed seam that a strict final-only caller can ignore, and an observing consumer can use without decoding raw provider responses.

**Non-Goals:** provider discovery redesign, general chat telemetry, new HTTP clients, adapter-wide billing inference, retry policy changes or installing this patch into the user's running Pi.

## Decisions

1. **Opt-in on the classifier options.** Add `observe?: true` and a synchronous notification callback `onAttempt?`. Add optional `observation` to `ClassifierResult`, with `version: 1`, validated `partialAnswers` and unresolved ids. The callback emits `{ phase: 'start' | 'end', attempt, ... }`; the terminal form has a bounded outcome/status, reported model and optional observed usage. The result reports observation support even for zero-dispatch setup failures. Unsupported adapters leave it absent. This is smaller and safer than weakening `answers` or interpreting `stopReason: error` as success.
2. **Instrument the existing fetch closure.** Emit start immediately before fetch, and exactly one end on each settlement. Parse usage and observations for non-OK bodies when they are JSON, without exposing those bodies. Preserve the current retry boundary: HTTP/transport failures can retry according to existing rules; malformed successful responses do not gain new retries. Preserve the existing final-only `onResponse` location. Catch observer exceptions and attach rejection handlers to unexpected returned promises; do not await an observer or allow it to extend the transport deadline.
3. **Keep strict parsing compatible.** Preserve the strict parser's existing behavior; use its per-question parsing plus definition validation for the optional partial map. Native observation validity checks include own-key access, choice membership, finite [0,1] confidence/probabilities, score range and boolean probability. A valid partial is not final success. The shared service revalidates it at its own boundary.
4. **Use presence-aware fields.** `inputTokens?`, `outputTokens?`, `costUsd?` represent provider observations, not normalized `Usage`. Only known System One `usage.cost` semantics supply USD charges; separate catalog estimates must identify their provenance and missing dimensions. No catalog zero is called free billing. Preserve the old `usage` field for existing callers.
5. **Typed error categories rather than raw-body export.** Recognize provider overflow codes in documented top-level/detail/error metadata locations, with authentication/billing/rate/validation exclusions. Expose a bounded overflow/retryability indication for service recovery; do not scan echoed state.

## Risks / Trade-offs

- Old Pi or custom adapters may ignore options → absence of `observation.version` is unsupported, not an empty complete observation stream. The audit-capable service must report an accounting capability failure, never fabricate attempts or silently switch backend.
- A transport ignoring cancellation can settle late → start remains visible, consumers guard terminal publication by captured generation; service deadlines still settle independently.
- Catalog price differs from billing → preserve separate fields and test missing/zero independently.
- Stricter observation validation differs from legacy parser permissiveness → only opt-in partial data is filtered; legacy strict behavior is regression-tested.

## Migration Plan

Implement only in the authorized patch worktree. Run existing TypeSafe/Cloudflare adapter tests plus observation cases with fake fetch. Use local source linkage in the downstream integration harness; do not change installed Pi or publish a version. Rollback is leaving the uninstalled patch unused; existing callers are unchanged. A later deployment requires separate approval.
