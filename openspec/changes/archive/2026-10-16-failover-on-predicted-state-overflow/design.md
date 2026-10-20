## Context

`runStages` in `src/service.ts` gates each cache-miss batch with `overflowConstraint(profile, size, limits)`. For review flights it also computes the irreducible floor `fixedSize` (fixed state + unsplittable evidence + unanswered questions, with `longestQuestionBytes`) and sets `admitFixed` when the floor is predicted over the state limit, so the batch is sent once anyway. For `judge()` the equivalent is `irreducible && misses.length === 1`. This is deliberate: the predictor uses a conservative prior ratio (1/1.75 tokens per byte) until usage is observed, and an over-estimated fixed state must not multiply work or be refused outright.

Failover lives one level up in `judgeInner`: the route is fixed per mode (`auto`: classifier → llm, `auto-llm`: llm → classifier), and an attempt ending with a non-local `stopReason: "error"` is eligible to switch once. Irreducible confirmed overflow already reaches failover this way. The attempt does not currently know whether an alternate exists.

Observed failure: pi-continue-watchdog sends unlock reviews with the whole session projection in `state.fixed` (by design indivisible). At 483 rows / 137 KB the floor is ≈78K predicted tokens against Jev's 32K `stateAndLongestQuestion`; the provider rejects within ~40 ms, then failover would run if an LLM is configured.

## Goals / Non-Goals

**Goals:**
- Skip a dispatch that the declared state limit already rules out, but only when skipping leads somewhere: a usable unused alternate in an automatic route.
- Keep every existing behavior when no alternate is usable.

**Non-Goals:**
- No change to request-wide (`request`) prediction, learned rejections, question splitting or evidence recovery.
- No margin/threshold tuning of the prior ratio, no new configuration key, no consumer-side shrinking.
- No change to forced `classifier`/`llm` modes.

## Decisions

### 1. Trigger: floor predicted over the state dimension

Compute the floor for both `judge()` and `review()` cache-miss batches (today only review computes it). Skip only when `overflowConstraint(profile, fixedSize, limits) === "state"`, i.e. fixed state + unsplittable evidence + longest unanswered question exceeds `stateAndLongestQuestion ?? contextWindow`. No question batching or evidence split can reduce that floor, so the prediction is about the irreducible unit, not a soft batch estimate.

The generic `contextWindow` fallback is included because the existing predictor already treats it as the state limit when no channel/override value exists; this keeps behavior symmetric for `auto-llm`, where the preferred LLM may declare a small window.

**Alternative rejected:** skip only after the ratio is learned from usage. A new session's first oversized request would still be rejected, which is the reported problem. The user chose skipping whenever an alternate exists.

### 2. Gate: a usable unused alternate

`judgeInner` passes each attempt a memoized `alternateReady(): Promise<boolean>` when the attempt is not the last in the route. It resolves the next family with the existing `resolveCandidate` (LLM: configured model present in the registry; native: explicit-or-default discovery) under the caller signal, and returns `false` on error or throw. It is called lazily, only when the floor is predicted over the state limit, so ordinary requests never pay native discovery.

Forced modes and the last route entry have no `alternateReady`, so they keep the one real admission check.

**Alternative rejected:** skip whenever the route has another entry. With `auto` and no `model` configured, the skip would turn a possibly-admissible Jev request into a guaranteed "both failed" error.

### 3. Outcome of a skip

The attempt ends via the existing irreducible path: `total.stopReason = "error"`, `total.contextOverflow = true`, an error message stating the predicted floor exceeds the declared state limit and the request was not sent. It is not a local fault, so `judgeAttempt` reports it as eligible and the route advances. The alternate restarts the full logical request under its own capacity profile, as for any failover.

A prediction is not a rejection: no `recordCapacity(... "overflow")`, no `rejected.add(envelope)`, no ledger `rejected` record, and no transport attempt or presplit counted. Cached answers found before the gate are still served; only misses reach it.

If the alternate then fails, the operation reports "both automatic backend attempts failed" with the skip's summary; it does not cycle back to send the skipped request.

## Risks / Trade-offs

- [Prior over-estimates tokens] → a fixed state that would actually fit may be skipped while the ratio is still the prior. Mitigation: only when an alternate is usable; the user accepted one alternate call as the cost.
- [Alternate resolves but then fails at auth/transport] → the preferred request was never tried. Mitigation: same "both failed" summary as today; next operation starts with the configured preference again (non-sticky).
- [Extra native discovery in `auto-llm`] → bounded by the caller signal and only when the floor is over the limit.
