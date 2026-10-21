## Context

See `proposal.md` for motivation and the delta specs for the behavior contract. This design is necessary because the change crosses a shared protocol, two independently distributed consumers, model cancellation and existing session history.

Read-only inventory on 2026-10-19:

| Source owner | Inspected revision | Relevant current use |
|---|---|---|
| `pi-llm-as-jev` | `7486d1f` | Version-one `judge` and `review`, emulated provider, 3,053-line `src/service.ts`, persistent recovery/accounting |
| `pi-jev-todo-audit` | `c85023c` | `incremental.ts` already calls `judge` and `describeSelection`; `judgment-service.ts` independently provisions the service and checks version one |
| `pi-continue-watchdog` | `42387d7` | `src/unlock-review.ts` discovers review v1 and requires `unresolved` plus complete `observationCoverage` before accepting a challenge |

Source roots are `/home/xz/Code/ai/<repository>`. Installed copies of all three also exist under `/home/xz/.pi/agent/git/github.com/xz-dev/<repository>`; their activation/revisions were not verified in this planning pass. Searches covered these source/installed roots, excluding generated output, dependency trees, tests and worktrees. Recheck the inventory before activation; this is not proof that no external consumer exists.

Current source is more reliable than some prose: audit's `shared-audit-integration` specification still describes resumable review, whereas its executable path and newer `judgment-service-delivery` contract use ordinary judge. Reconcile those references during audit adaptation; do not rebuild the retired protocol to satisfy stale prose.

Existing unrelated work must survive: audit has a modified `.serena/project.yml`; watchdog has untracked `PLAN/` and `openspec/changes/consume-shared-private-inquiry-runtime/`. That watchdog change touches private runtime/distribution and overlaps `src/runtime.ts`, but does not own judgment protocol semantics. Coordinate that shared file, not a second rewrite of its state machine.

## Goals / Non-Goals

**Goals**

- Give each operation one immutable input/configuration snapshot and one owner of cancellation, idle waiting, optional hard expiry and final result publication.
- Remove recovery machinery rather than hide it behind a version-two facade.
- Make consumer migration and actual-consumer tests part of completion, not follow-up work after the service changes.
- Preserve local authority/currentness rules, final-answer validation and consumer-owned durable progress while removing transport accounting from business acceptance.

**Non-Goals**

- No total primary-plus-fallback deadline, concurrent hedged requests, sticky failover, adaptive tuning, circuit breaker or new retry framework.
- No business action execution, provider routing outside Pi, credential import, Pi core changes or new runtime dependencies.
- No automatic deletion/rewrite of historical sessions, user settings, package sources or pins.
- No deployment, Git publication, installation or paid inference during proposal creation. Implementation and activation are distinct later operations.

## Decisions

### 1. Version the real contract break instead of retaining review

Keep the global discovery key and provider id. Publish `JudgmentService.version = 2`; use `capacityVersion = 2` for the reduced capacity shape. Remove review members/types entirely from the new distributed client. `judge` input is `state + questions`; output retains validated final answers, dropped ids, terminal identity, stop/error/abort, optional terminal capacity and optional backend usage. Remove `reuse`, `inputDimensions`, progress, checkpoint, unresolved and attempt-diagnostic fields.

Retain `availability()` and `describeSelection()` as supporting metadata, not extra product responsibilities. Remove the capacity query's obsolete review-path selector. Reject known removed input/options rather than dropping legacy evidence silently. New consumers require v2 and fail safely against v1; old v1 consumers already reject a v2 handle. Do not add a v1 emulation layer or pretend that cached/review behavior is preserved.

**Alternative rejected:** keeping version one while dropping fields would turn independent package updates into runtime errors or false acceptance. A permanent compatibility layer would preserve the machinery this change removes. A matched release set plus explicit degraded behavior is smaller and honest.

### 2. Use two clocks per model attempt, not an operation-wide timer

Configuration sketch; hard limits are omitted by default:

```json
{
  "mode": "auto",
  "timeouts": {
    "classifier": { "idleTimeoutMs": 10000 },
    "llm": { "idleTimeoutMs": 15000 }
  }
}
```

Each slot optionally accepts `modelTimeoutMs`. It applies to whichever model that slot selects for an operation. This avoids a speculative model-id policy registry. A caller can provide `idleTimeoutMs` and/or `modelTimeoutMs` as per-call overrides; they apply independently to each attempted family. Field precedence is caller, backend slot, then idle default/no hard limit. Timers accept positive integral milliseconds within the timer range, not zero-as-disable; remove a hard setting to disable it.

Start both clocks before selected-backend preparation/discovery/auth. Keep them across all questions and output repair. Reset only idle on actual nonempty text/thinking/tool-argument deltas or a validated completed question answer. Setup completion, headers, heartbeat bytes, empty events, new requests and retries do not renew either clock. Thus preparation consumes initial idle allowance, and a non-streaming native classifier normally has up to 10 seconds without a result. A configured hard cap can be shorter or longer than idle; whichever expires first wins.

```text
admit immutable operation
          |
          v
primary attempt: setup --> classify questions --> optional repair
          |      idle clock + optional fixed hard clock
          |
          +-- success --> validated terminal result
          |
          +-- eligible failure --> retire primary
                                      |
                                      v
                             alternate attempt
                             fresh independent clocks
                                      |
                                      v
                             terminal result / error

caller abort / navigation / shutdown --> cancel owned work; no alternate
```

A small shared waiting primitive is justified only to keep service and direct-provider execution on the same semantics. One entry point owns the clocks; nested adapters receive its signal/progress hook and must not start a second competing hard budget. A direct provider invocation constructs its own attempt because it has no enclosing judgment operation.

The installed Pi SDK already exposes an async-iterable `AssistantMessageEventStream` with `text_delta`, `thinking_delta` and `toolcall_delta`. Consume nonempty normalized deltas instead of maintaining provider-specific raw SSE parsers. Keep the complete-result validation path. Race consumption/result settlement against cancellation so a stalled or non-cooperative producer cannot hold the caller; handle late rejection and stop publishing after retirement. Provider transport policies remain underneath; do not pass idle milliseconds as an SDK whole-request timeout or disable Pi-owned safety policies.

At the direct Pi classifier entry, standard caller `timeoutMs` is an explicit whole-invocation hard deadline under the new provider contract; it overrides that entry's configured hard cap. This is a documented breaking change from this plugin's former idle interpretation, not a legacy alias inside `judge`. Service v2 callers use only the two unambiguous fields. Preserve supported caller fetch/event hooks, without treating their existence as billable-attempt accounting.

**Alternatives rejected:** total shared budgets starve fallback and were explicitly rejected by the user; heartbeat-based renewal recreates the original problem; per-HTTP-request hard limits multiply the intended cap; parallel questions/hedging add cost and ownership complexity not needed for this slice.

### 3. Make the service stateless, retain only useful support

Retain configuration access, registry adaptation, provider registration, active-operation cancellation, native selection/validation/policy, discrete LLM answers and read-only metadata. Session navigation still aborts active work; it no longer restores or writes service ledgers. The latest activation still owns its discovery handle.

Expected module treatment:

| Area | Treatment |
|---|---|
| `src/service.ts` | Replace stage/cache/review orchestration with validation, frozen selection route, attempts and final result assembly |
| `src/backend-llm.ts`, `src/backend-jev.ts`, `src/provider.ts` | Retain core adapters and validation; share waiting ownership; remove partial-observation/recovery plumbing |
| `src/cache.ts`, `src/ledger.ts`, `src/review-observations.ts`, `src/native-observations.ts`, `src/llm-observations.ts` | Remove after preserved validation/transport necessities have a core home; do not delete safety code merely because it shares a module |
| `src/pipeline.ts` | Remove evidence fragmentation/recovery; retain only necessary context-error recognition in its direct caller |
| `src/capacity.ts` | Reduce to declared override/model metadata; remove learning, hashes and rejection history |
| `src/config.ts`, `src/index.ts`, `src/ui.ts`, `src/picker.ts` | Preserve useful model controls and live snapshots; change timing/status and remove ledger lifecycle coupling |
| `src/policy.ts`, `src/redaction.ts` | Preserve policy and privacy; eliminate blocking unrelated-provider credential sweeps |
| `client/`, `src/contract.ts` | One v2 source contract plus existing generated `.js`/`.d.ts` outputs |

This is a responsibility boundary, not a target file count. Do not replace deleted observation/state modules with equivalent new frameworks.

Known-secret redaction remains mandatory. Resolve selected-provider credentials only through Pi before dispatch, within its timers; use already available host/runtime known-secret input as well. Do not await unrelated providers to enumerate potential keys. Return service-authored bounded errors rather than raw provider bodies. Unknown credentials inside arbitrary caller input cannot be discovered by this service; retain explicit caller privacy responsibilities rather than claim exhaustive secret discovery.

Capacity v2 returns identity, declared limits and `override | model | none`. Keep exact configured overrides. Drop review-only built-in channel assumptions, learned ratios and service-envelope calibration. Audit already has local packing priors (`1 / 1.75` tokens/byte and 2048 envelope bytes); preserve them explicitly as consumer estimates, not provider facts. Actual overflow, not an estimate, governs local shrinking. The service does no automatic subdivision.

### 4. Adapt audit end to end, including provisioning

Owner: audit repository.

- Replace its copied client and version/capacity checks in `index.ts`, `judgment-service.ts` and `incremental.ts`.
- Keep consumer-owned scope cursors, source anchors, whole-loop packing, dependent-drift rejudgment, acknowledgement-before-advance and full-audit reset. Do not create an audit-side cache to replace removed service reuse.
- Pass packed state directly; update fixtures that currently expect the service's `{ fixed: ... }` envelope. Preserve whole-loop overflow reduction, candidate limits, suppressed-child ownership and stale delivery checks.
- Replace audit `timeoutMs` call/config plumbing with optional explicit idle/hard fields. Omission delegates to service defaults. Legacy configuration produces a migration diagnostic and skips affected audit inference until resolved, without disabling TODO/main-agent work.
- Remove `reuse`-based completion/reporting and cache counters from `incremental.ts`, `index.ts`, `ledger.ts` and their types/UI if still reachable. Count locally known business calls/questions only when useful and label them accurately; do not synthesize HTTP counts, hits or zero billing.
- Preserve independent unpinned package provisioning. Update `/jev-audit-service`, post-install readiness, resource-order tests and diagnostics to the same v2 compatibility predicate. Retain trust/offline gates, user pins/filters, no reinstall of existing choices and no automatic downgrade.
- Update `shared-audit-integration`, `judgment-service-delivery`, affected `incremental-judgment-state` references, README and existing process models. Resolve stale review/checkpoint requirements to the current consumer-owned model, not a new reset of user progress.

### 5. Adapt watchdog without changing who can unlock

Owner: watchdog repository.

Replace review discovery and `ReviewServiceLike` usage in `src/unlock-review.ts` with ordinary v2 judgment. Build the same permitted complete macro snapshot into state; no service-side evidence framing is needed. Accept only a live `stop` result with the required legal choice, correct type and no missing/dropped required answer. Remove `unresolved` and `observationCoverage` checks because those fields no longer exist.

This intentionally changes the old acceptance condition: complete transport observations are no longer required. They establish accounting coverage, not factual authority. The replacement is the strict final-answer contract plus existing source-gap, candidate identity, parent-context, currentness and publication checks. A valid `challenged` answer still permits only one existing semantic reconsideration; it does not unlock, continue or grant authority itself.

Keep the important existing asymmetry: incomplete/unavailable review warns and releases the **still-current original unlock**, rather than denying all unlocks. Preserve manual cancellation and lifecycle invalidation so a late successful/error result cannot resurrect that candidate. Do not introduce an outer timer or local fallback engine.

Update `src/runtime.ts` report/history fields and tests to show disposition, actual service identity and optional scoped usage. Leave old history readable; missing old/new diagnostics are not zero. Review-history persistence remains optional and context-excluded. Keep the ongoing private-inquiry-runtime refactor separate; one active writer owns overlapping runtime changes at integration time.

### 6. Migrate configuration explicitly and test actual consumers

Legacy service `timeoutMs` has two incompatible meanings today. Do not silently map it to a hard cap (would violate default-no-hard intent), map it only to idle (would drop an old native cap), or discard it as unknown. Surface a migration-required error with no inference until the user/operator explicitly replaces/removes it. Other configuration validation retains its existing behavior. Document two examples: remove old override to use 10s/15s and no hard cap; or select explicit idle and/or per-slot hard values. Reading settings never edits them.

This same rule applies to audit's legacy caller override. Deployment must inventory field presence through approved settings access and resolve it before activation, preserving model selection, unrelated keys and secrets. New timing settings are file-based; no timing wizard, automatic migration daemon or compatibility toggle is needed.

Reuse existing testing tools: service/watchdog `tsx --test`, audit `bun test`, and existing offline-host fixtures. Audit already supports `PI_JUDGMENT_SOURCE` in `test/actual-service-fixture.ts`; update that fixture and use it to exercise the actual candidate service, not only a handwritten fake protocol. Add the same explicit source fixture to watchdog's judgment seam rather than creating a new cross-repo test platform. Keep pure fake-service tests for local policy cases, but at least one cross-repo success/failure/cancellation path must consume real candidate code.

Acceptance matrix:

| Boundary | Required evidence |
|---|---|
| Timing | Native 10s/LLM 15s defaults; shorter injected-clock examples; heartbeat-only expiry; reasoning/tool progress; optional hard cap across questions/repair; no hard cap and no combined deadline |
| Routing | Both automatic directions, forced modes, full-request alternate, both-failed summary, no retry on valid negative/all-dropped results |
| Safety | Invalid input, malformed output, explicit overflow, redaction, hung selected setup, unrelated-auth nonblocking, cancellation and ignored-signal late results |
| Statelessness | Independent identical calls, no service ledger append/restore, old history untouched, no learned metadata |
| Audit integration | Real candidate service, whole-loop packing, durable progress, full reset, threshold semantics, provisioning/load order, disabled/suppressed/offline cases |
| Watchdog integration | Real candidate service, supported/challenged/incomplete, one reconsideration, incomplete original-unlock policy, takeover/abort/stale result, no observation requirement |
| Versioning | Old consumer/new service and new consumer/old service degrade explicitly; matched set succeeds without network probes or duplicate activation |
| Distribution | Distributed client outputs match source; current package entry points work together in an isolated host with fixture providers |

## Risks / Trade-offs

- **10s native / 15s LLM can interrupt slow healthy starts** -> these are user-selected initial defaults, not measured latency targets; retain per-slot/caller overrides and revisit only after evidence.
- **Active generation can run arbitrarily long without a hard limit** -> intentional policy; expose disabled hard caps clearly and preserve caller cancellation.
- **Cancellation may not stop remote billing immediately** -> cancel cooperatively and fence local results; do not claim upstream billing cessation.
- **Removing cache increases repeated-call cost** -> preserve existing consumer scheduling/progress; do not add another cache before real usage demonstrates a need.
- **Providers vary in normalized progress events** -> verify existing public SDK event seams with actual offline adapters; no raw-heartbeat fallback. An adapter with no progress is subject to idle expiry until a complete answer.
- **Independent updates can temporarily mismatch versions** -> explicit no-inference/incomplete behavior, consumer-first publication when authorized, followed by coordinated activation of the tested set.
- **Watchdog accounting gate removal changes accepted cases** -> document and test valid final judgments without observations plus every existing authority/currentness gate; never report observation completeness that was not measured.
- **Existing specs and fixtures encode deleted behavior** -> update contracts and genuine behavior tests together; remove obsolete cache/review assertions, not preserved privacy or cancellation checks.

## Migration Plan

1. **Freeze the contract and scope.** Use this change as the integration authority. Before external implementation, activate each destination repository and create a linked consumer-local change through its own OpenSpec CLI for its affected specs/tasks. The root change's repo-local `allowedEditRoots` does not itself grant cross-repo writes; the subsequent explicit cross-repository apply request must name/cover the three repositories. No external files are changed by this proposal.
2. **Build the service candidate first, without activating it.** Implement the v2 core and waiting rules, update client generation, targeted checks and the timeout Lean model. Keep old installed versions operational during development.
3. **Adapt the consumers against that candidate.** Audit and watchdog can proceed independently after the client contract stabilizes; serialize watchdog `src/runtime.ts` integration with its private-inquiry owner. Owners finish their callers, fixtures, docs/specs and local checks, not just the entry method.
4. **Run joint acceptance.** Point both consumers at the same service candidate. Use `/var/tmp` for isolated host/test directories, fixture credentials/endpoints and no live model calls. Record tested source revisions/artifact locations, host version, commands and outcomes. Do not treat skipped actual-service tests as passes.
5. **Prepare an authorized matched activation.** Inspect actual installed sources and user overrides before any update. Resolve legacy timeout fields explicitly. Preserve package sources/pins/filters, save the prior matched revisions and only affected non-secret configuration for recovery. If publishing is separately authorized, make compatible consumers available before the breaking service; do not modify the audit's independent unpinned service-source contract to force an artificial lockstep pin.
6. **Activate through normal package/reload mechanisms when authorized.** Prefer updating the full tested set before starting a new session. Verify one service/provider registration, both status surfaces, compatibility and configured 10s/15s defaults without paid probes. In-flight old sessions keep their old loaded code until normal reload; do not claim file update alone changes them.
7. **Recover as a matched set if needed.** Restore the recorded known-good service and consumers plus their affected settings through the normal package mechanism. Do not use destructive whole-tree resets, remove session entries or undo unrelated modifications. Recheck status/currentness after reload. If a user pin prevents a compatible set, report that concrete dependency rather than bypassing it.

Completion has separate labels: **source integration accepted** after the actual-consumer matrix, **source publication verified** only after the confirmed releases and meaningful CI pass for each exact pushed revision, and **installed activation verified** only after separately authorized effective install/reload checks. A planning-only delivery claims none.

### Apply addendum: meaningful source-release CI/CD

The human's subsequent apply instruction authorizes the three-repository implementation and requires publication, not merely local completion. Preserve the existing Git-distribution/package-privacy model. Confirm concrete targets/versions before Git writes; do not assume npm publication or installed activation. Make compatible consumers available before the breaking service after all candidate-source acceptance checks pass.

CI must execute real typechecks, behavioral tests and builds, consume the actual candidate service in both consumers, verify distributable package contents and propagate failures. Preserve existing watchdog e2e and install-policy gates. Audit required actual-service tests for skipped execution; supply an explicit candidate checkout and require these paths to execute. Use representative isolated negative controls to show the relevant gate fails on wrong behavior rather than accepting a cosmetic workflow. Verify remote workflow run head SHA, actual step results and published artifacts, not just a green badge. Record release/CI URLs separately from installation evidence.
