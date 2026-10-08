## 1. Observation surface

- [x] 1.1 Add opt-in classifier attempt/partial-result types in the authorized Pi worktree, preserving existing call signatures; verify TypeScript API fixtures and legacy System One adapter tests.
- [x] 1.2 Add independent partial-answer validation with own-key preservation and unresolved ids; verify a regression where valid A/B survive missing C while strict final answers remain empty, plus invalid numeric fields and special keys.

## 2. Transport observations

- [x] 2.1 Instrument each existing System One fetch start/settlement without changing retry or onResponse semantics; verify 503 then success produces exactly two attempts, pre-dispatch failure produces none, cancellation is visible and failing observers cannot retry or escape unhandled.
- [x] 2.2 Preserve optional provider token/charge fields and structured error categories separately from normalized catalog usage; verify missing versus zero, malformed answers with usage, typed overflow exclusions and body/credential privacy.

## 3. Local verification and handoff

- [x] 3.1 Document the additive classifier API and unsupported-adapter behavior; run focused TypeSafe/Cloudflare tests, relevant type/build/lint checks and prove new assertions fail without the behavior rather than weakening old tests.
- [x] 3.2 Capture the exact patch diff, commands/results and residual limitations for downstream local-source integration; verify no installed checkout, unrelated fixture, version, commit, push or live inference changed.
