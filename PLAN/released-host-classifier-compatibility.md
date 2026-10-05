# Released-host classifier compatibility

## Scope

Fix the plugin, not Pi. Keep the installed Pi `1.0.2-xz.263.1.g3e582445` and the existing model/credential configuration unchanged. Use the official extension surface and the released xz-dev classifier API. No paid inference, core deployment, or new recovery engine.

## Verified cause and public seam

- `modelRegistry.classify()` accepts the released `ClassifierOptions.fetch` hook. The SDK retains request construction, authentication, parsing and retries.
- `onPayload` precedes the retry loop; `onResponse` follows its final successful response. Neither alone proves individual attempt counts.
- The plugin currently requires unpublished host `observe/onAttempt/result.observation` fields. The released host correctly ignores them; the plugin then rejects a successful classification.
- Published sources: `https://github.com/xz-dev/pi/blob/3e582445/packages/ai/src/types.ts` and `packages/ai/src/api/system-one-shared.ts`.

## Small implementation path

1. Collect request-owned native metadata through the public fetch hook. Observe the body as Pi consumes it; do not duplicate provider dispatch/retries or persist raw bodies/headers. Reuse `validateAnswer` for valid independent members.
2. Keep observation metadata internal to the service; never require or send private host observation fields. Keep legacy `judge` final-only and preserve all prior recovery, identity, durability and accounting assertions.
3. Update the existing transport fixtures to exercise this public seam, and update current documentation without rewriting historical R2 approval.

## Acceptance

- Unchanged released Pi loads both plugins; one deterministic fake provider response gives one successful review and one actual attempt, with no real network/inference.
- Missing/invalid members retain valid independent raw answers without advancing full coverage. SDK retries remain distinct attempts; zero and absent usage remain distinct.
- Cancellation/late completion and branch durability retain their existing behavior. No diagnostic fallback invents zero expense or provider success.
- Existing complete checks plus bounded independent review precede a follow-up commit/update. Re-run the actual host in Herdr after installation.

## Pre-publication evidence

- Herdr pane `w47:p3`: the unchanged installed predecessor makes `node /var/tmp/pi-jev-install-smoke/run.mjs` exit **1** with `selected classifier adapter lacks attempt-observation capability version 1`; setting `JEV_SMOKE_SERVICE_ROOT` to this working tree makes the same host check pass. The host still has no private observation contract.
- `/var/tmp/pi-jev-install-smoke/full-run.mjs` uses a disposable documented Pi JSONL session and actual audit commands: ordinary = 1 fake HTTP request, unchanged repeat = 0, full = 1 fresh request. The task remains in progress, receipts are durable, and no main-model run or external network occurs. Candidate evidence: `/var/tmp/public-hooks-full-candidate-host.log`.
- `/var/tmp/public-hooks-foreign-metadata-red.log` proves an adapter that ignores fetch cannot make unsupported accounting look free by returning a fabricated private observation object. The plugin now discards that claim.
- Full candidate checks: `/var/tmp/public-hooks-service-check.log` (296 tests, types/build pass, 56 pre-existing non-blocking warnings), `/var/tmp/public-hooks-audit-test.log` (311 pass / 70 optional skips), `/var/tmp/public-hooks-audit-types.log` (pass), `/var/tmp/public-hooks-wire.log` (70 pass / 2,206 assertions). The source-linked fixtures explicitly reject private host observation options and preserve the original behavioral assertions.
- Independent review, follow-up publication and default-installed-path validation remain delivery gates. R2 approved the earlier migration snapshot, not this compatibility diff.

The RPC runners assert returned results outside extension callbacks: a handled RPC command is not proof of successful audit. Temporary fake-transport probes and per-run evidence are under `/var/tmp/pi-jev-install-smoke/` and `/var/tmp/pi-full-audit-smoke-*/`.

### Compatibility review R1 follow-up

The independent compatibility review (`/var/tmp/public-hooks-review-r1.md`) reproduced one blocking regression: failed Cloudflare envelopes discarded provider-reported metering. This is distinct from the historical migration R2 approval. The repair separates diagnostic payload unwrapping from successful-answer eligibility; it does not change transport/retry ownership or admit failed-envelope answers.

Sixteen added unit cases cover direct/nested failed envelopes and failed/running job states, HTTP 200/400, known versus absent input, reported zero output and cost, persisted attempts, no checkpoints and no cached failed answers. Their pre-fix failures are recorded in `/var/tmp/public-hooks-f1-red.log`. Post-fix checks: `/var/tmp/public-hooks-r2-service-check.log` (312 tests; types/build pass; 56 existing warnings), `/var/tmp/public-hooks-r2-wire.log` (70 tests; 2,206 assertions), and `/var/tmp/public-hooks-r2-native-repro.log` (reviewer's eight real-adapter controls pass through public fetch). Both released-host probes pass again in `/var/tmp/public-hooks-r2-{host,full-host}.log`.

At this pre-publication snapshot, independent finding closure, unsigned follow-up publication and default-installed-path Herdr validation remain gates. The working-tree checks above are not a claim that the fixed version is already installed.
