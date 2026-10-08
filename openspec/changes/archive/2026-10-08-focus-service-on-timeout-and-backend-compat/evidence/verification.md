# Candidate verification — timeout and backend compatibility

Status: **verified baseline and capacity integration, with task 2.2 still partial**. No release, installed-copy activation, deployment or paid inference was performed.

## Frozen source and checks

`evidence/candidate.json` identifies candidate `c13180a43ca0b765f28f2a59b8c2867fb254bb85d1bed4ae8fbca995a3711055` by individual file hashes (previous verified candidate `443dc719…`). The authoritative full digest is the value in the manifest; source and canonical client remained unchanged after the checks.

- `npm run build`: exit 0, including generated client synchronization (`candidate-build.log`).
- `npm run check`: exit 0; 358 tests, **357 pass, 1 skip, 0 fail**, with lint, typecheck and build (`service-check.log`). The live gate did not run.
- Strict OpenSpec validation: valid (`service-spec.log`). This checks artifact structure, not implementation completeness.
- The audit's copied client is byte-identical to `client/judgment-client.ts`.
- `final-cross-repo.log` records seven successful offline tests against final audit candidate `f29159b475acbcf2e53de4c7ff2cba63d8307459ed6a20de1551adf7e4f34409`, using the actual service source and installed Pi native adapter. The audit reads judge-path selection/capacity, performs A/B partial-progress continuation and cold JSONL/compaction restoration, and retains permission withdrawal. The transport is scripted and local; it does not measure model accuracy, real token usage or billing.

## Supported contract

- One caller `timeoutMs`, else the configured override, else a backend default (user decision): native classifier 60 000 ms absolute; LLM = Pi `httpIdleTimeoutMs` read through `getSettings()` (Pi default 300 000 ms; `0` disabled → timer maximum). Setup/auth resolution is bounded by the explicit value or the native default. `resolveTimeoutMs` is unit-tested; a hung native registry with an omitted value stays pending at 50 ms (60 s not expired) rather than settling early.
- LLM execution uses per-request transport inactivity, including bytes/reasoning/tools/provider events rather than only visible text. A healthy stream may outlast the window; an inactive transport may not.
- Native classification uses an absolute logical-call deadline shared by its internal stages/batches.
- Existing transport observers are composed rather than replaced. Execution failure does not authorize backend fallback.
- `describeSelection` is a read-only optional capability. It reports selected backend/model and known limits with their source, current byte/token calibration or prior status; pre-aborted queries return before discovery. Querying it does not run inference or create ledger entries.
- Judge and review use their own selection/capacity paths. Overrides precede the applicable channel/model metadata. Unavailable metadata stays unknown.
- Successful judge results disclose the initial prediction snapshot rather than relabeling later learned calibration as the ratio that planned the first dispatch.
- Legacy version-1 judge/review clients remain callable. Deprecation annotations do not remove their behavior.

## Task 2.2 closed with narrowed wording

The new optional `JudgeResult.inputDimensions` records state/question/longest-question UTF-8 sizes at logical backend dispatch. Cached rejection may produce an empty array. It does **not** observe every SDK HTTP envelope or hidden retry, and it must not be presented as actual wire bytes or request count.

The task wording now states what the field is: a logical input-size estimate at dispatch. Actual HTTP envelope/retry telemetry is out of scope by user decision (plain-language explanation accepted). No diagnostics are promoted into token or cost truth when the provider did not supply them.

The audit's separate fixture-level HTTP interceptor measured its actual offline wire bodies. Those fixture measurements do not change the semantics of this service API field.

## Limit provenance and other boundaries

The OpenRouter Jev 1.13 reference states a 32,000-token window. The built-in TypeSafe direct request/state-longest constants remain explicitly unverified. Those review-channel constants are not silently reused as judge-model metadata. Unknown Pi fallback limits are not invented.

These checks establish timeout/state/transport mechanisms with deterministic adapters. Live provider behavior, true model judgments, real tokenization and billing remain unmeasured. The audit no longer sends a default; both repos document the backend defaults above.
