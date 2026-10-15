## Why

When the required fixed state plus the longest unanswered question is predicted to exceed the attempt's declared state-plus-longest-question limit, the service still sends one real admission check. With Jev's documented 32K-token "state plus the longest question" window, an unlock review carrying a ~137 KB indivisible `macroSnapshot` is rejected (`max_tokens_exceeded`) every time, and only then can an automatic operation fail over. The doomed request costs a round trip, a provider attempt and a confusing error log, even though the service already knew it could not fit and a usable alternate backend was available.

## What Changes

- Before dispatching a cache-miss batch, when the irreducible floor (fixed state, any evidence that cannot be split, and the longest unanswered question) is predicted to exceed the attempt's state limit (`stateAndLongestQuestion`, else the generic `contextWindow`), **and** an automatic route has an unused alternate whose candidate currently resolves, end that attempt with a predicted context-overflow error without sending the request. The existing one-switch failover then runs the full logical request on the alternate.
- Without a usable alternate (forced modes, exhausted routes, unconfigured or unresolvable alternate) keep today's behavior: one real admission check of the current unanswered batch.
- A skipped attempt is a prediction, not a rejection: it records no capacity rejection, adds nothing to the rejected-envelope set, writes no ledger rejection and counts no transport attempt.
- Request-wide (`request`) predictions, learned-rejection matches and question/evidence subdivision are unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `resumable-judgment-reviews`: the "one real admission check" rule for over-limit fixed-state predictions gains an exception when a usable automatic alternate exists.
- `judgment-service`: context capacity prediction may end an attempt before dispatch to permit automatic failover; irreducible predicted overflow becomes an eligible failover cause alongside confirmed overflow.

## Impact

- Runtime: `src/service.ts` cache-miss capacity gate in `runStages`, and `judgeInner`/`judgeAttempt` to expose whether the current attempt has a usable unused alternate. No adapter, config, client or public type changes.
- Verification: service/review capacity tests for skip-with-alternate (both `auto` and `auto-llm`), no-skip without alternate, forced modes, cached answers still reused, no rejection bookkeeping, and failure summaries.
- Documentation: README capacity section notes the pre-dispatch failover.
- Compatibility: users with an automatic mode and a configured alternate see fewer provider rejections for oversized fixed state. A conservative prior ratio can occasionally skip a request the preferred backend would have admitted; the cost is one alternate call instead of an answer from the preferred backend. No configuration migration.
