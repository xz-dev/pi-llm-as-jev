# Local component verification: classifier observations

The Pi prerequisite is implemented and independently reviewed **OK**. This is component verification, not user acceptance of the service/audit migration, installed rollout or live provider behavior.

## Exact candidate

- Worktree: `/var/tmp/pi-classifier-attempt-observations`
- Branch: `patch/classifier-attempt-observations`
- Unchanged upstream HEAD: `200387122ca450d6387f033949423114a270b96c`
- Tracked diff SHA256: `c24403513076f6685f55fe9640328716dbc5b818a610f3f2b3bba483a2dbdd0a`
- Six-file manifest: `/var/tmp/pi-observations-parent-repair-manifest.json` (parent rechecked all six hashes after review)
- Diff: `/var/tmp/pi-observations-parent-repaired.patch`; two new untracked observation test files are covered by the manifest, not this tracked diff alone.

## Evidence

- New parent repair regressions: **14/14 failed RED** on the preceding candidate, then all passed. `/var/tmp/pi-observations-parent-repair-red.log`.
- Focused Pi suites: **80/80 passed**, six files. `/var/tmp/pi-observations-parent-repair-focused.log` and independent `/var/tmp/pi-observations-final-review-focused.log`.
- Original unchanged parent harness: **4/4 passed**. `/var/tmp/pi-observations-final-review-parent.log`.
- Independent saved transport/baseline harness: **30/30 scenario groups passed**, including previously failing variants. `/var/tmp/pi-observations-final-review-independent.log`.
- Parent `npm run check`: exit 0, no formatter fixes; includes typecheck, dependency/import/entry-graph/install-lock/browser-smoke checks. `/var/tmp/pi-observations-parent-repair-check.log`.
- Independent non-writing typecheck, changed-file lint and diff whitespace checks passed.
- Reviewer closed F1–F12 and R1 against the exact candidate. Report: `/home/xz/.pi/agent/sessions/--home-xz-Code-ai-pi-llm-as-jev--/subagent-artifacts/outputs/9e43912f-3f65-42c4-ad66-14464c46fba6/pi-observations/rereview-parent-fix.md`.

## Verified boundaries and remaining work

Strict opt-out parsing/results remain compatible, observations count real fetch starts/settlements, partial valid members stay separate, unknown usage stays absent, provider charges are not catalog estimates, callbacks cannot mutate internal facts or cause retries/unhandled rejections, and actual overflow/error metadata paths retain the required exclusions. Effective credential-bearing response model values are suppressed.

No staged files, commit/push, publication, installed Pi update or real inference. Validation used fake transport. Outer auth wrappers and unsupported adapters can still return no observation capability; the downstream service must handle that explicitly. Conservative model-identifier privacy filtering may omit unusual identifiers. Legacy raw `errorMessage` behavior is not changed by this observation-only contract; the service remains responsible for its own redaction.

The separate audit integration test is intentionally RED because the current audit still uses its direct HTTP client. Shared-service review and consumer migration are not delivered by this component.
