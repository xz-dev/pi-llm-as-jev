## 1. Scaffold and spike

- [x] 1.1 Create the package layout mirroring `pi-continue-watchdog` (package.json with `pi` extension entry, `src/`, `test/`, tsconfig, biome, scripts `lint`/`typecheck`/`test`/`build`/`check`); verify `npm run check` passes on an empty `src/index.ts` that exports a no-op extension
- [x] 1.2 Spike D5: register a stub classifier provider with a pseudo-credential and one classifier model; verify in a real `pi` session that `ctx.modelRegistry.getAvailableOfType("classifier")` lists it and `/login` is not polluted; record the working registration form (legacy `ProviderConfig` vs native `Provider`) in design.md

## 2. Shared types and client

- [x] 2.1 Update the self-contained canonical types in `client/judgment-client.ts` and type-only re-export in `src/contract.ts` to D2: backend `classifier|llm`, availability `{ classifier?, llm? }`, unchanged request/policy types and structural Pi question/answer compatibility; verify typecheck, canonical export tests and no `@earendil-works/*` imports in the client contract
- [x] 2.2 Write `client/judgment-client.ts` (copy-able into consumers) exposing `getJudgmentService(): JudgmentService | undefined` via `Symbol.for("pi-llm-as-jev:service")`; verify a unit test that returns `undefined` when unset and the object when set

## 3. Configuration

- [x] 3.1 Validate global `mode|classifierModel|model|thinkingLevel|timeoutMs` with `auto|classifier|llm`, independent optional model slots and first-slash parsing; missing/unreadable/invalid files use defaults and diagnostics, with all known fields defaulted on any invalid known setting. Verify unreadable paths, mixed valid/invalid files, unknown enums, slash-containing model ids, no main-session inheritance, and preservation of an explicit unavailable classifier reference
- [x] 3.2 Save settings atomically while preserving unknown keys and independent model slots; verify round-trip classifier/LLM settings, concurrent unique temp names, failure cleanup and cancellation leaving disk/memory unchanged

## 4. Judgment pipeline (lifted from pi-jev-todo-audit)

- [x] 4.1 Retain the verified capacity predictor with selected-model `contextWindow` limits and `channelKey(classifier|llm, model)`; apply only verified adapter-specific dimensions, not a universal native-state multiplier. Verify existing predictor tests and distinct explicitly selected native-model limits
- [x] 4.2 Retain canonical raw-judgment caching, joining and forced-review membership, with `classifier|llm` and frozen actual model/thinking/state/evidence/full-question identity; verify native-model switches cause misses, dispatch/cache/ledger identities agree, and each caller's policy is reapplied on hits/joins/restores
- [x] 4.3 Port overflow detection and batch splitting (`isContextOverflow`, `evaluateBatched` subdivision) into `src/pipeline.ts` working on `ClassifierResult` instead of HTTP responses; verify unit tests for batch split, irreducible single-question rejection, and no-resend of a rejected envelope
- [x] 4.4 Apply native-classifier numeric policy using the adapter-defined choice/score confidence, bool certainty and per-question confidence/named-choice overrides; ignore all numeric rules for discrete LLM decisions. Verify Jev defaults and explicit non-Jev native thresholds, boundaries, stricter cached/restored/joined callers, invalid/missing fields and no invented numeric conversion
- [x] 4.5 Implement known-key redaction of outgoing fixed state, evidence, questions and returned errors; verify a fake backend never receives embedded keys and ledger records contain neither secrets nor request bodies
- [x] 4.6 Verify retained ordered evidence recovery: fixed state, order, all text and original metadata must survive question/evidence subdivision and Unicode-safe fragments with separate stable source bounds; preceding opinions remain advisory and only a complete final stage is returned. Include caller `metadata.fragment` collisions, large records, irreducible state and later-stage failure regressions; repair only proven gaps
- [x] 4.7 Implement session-generation and cancellation isolation for in-flight work and ledger writes; verify a canceled waiter or branch switch cannot persist a late result into the current branch and an aborted request persists no new judgments

## 5. Backends

- [x] 5.1 Generalize the existing native backend to honor explicit compatible `classifierModel` (including non-Jev ids), otherwise retain Jev identity/provider-priority discovery; exclude own emulation and never silently substitute another native model. Use Pi classification/auth with combined signals and frozen model identity; verify default/explicit selection, wrong-type/missing/unsupported candidates, provider failure without fallback, discovery/dispatch deadlines and abort priority
- [x] 5.2 Implement `src/backend-llm.ts` using per-question `streamSimple`, a data-only system prompt, and a discrete `answer` tool: legal choice key, bool value, or integer score level. Never request probability/confidence from the model; encode one-hot/0-or-1 compatibility fields locally. Apply Pi's thinking clamp and one malformed-output retry. Verify choice/bool/score outputs, schemas without confidence/probability inputs, unknown labels and prose-only failures, exact retry count, and supported off/unsupported-level behavior
- [x] 5.3 Assemble selection for `auto|classifier|llm` with `backend: classifier|llm`, `{ classifier?, llm? }` availability, frozen dispatch identity and no main-session fallback; verify every Backend selection/Never throws scenario, auto fallback only before dispatch, and selected-model identity across recovery/cache/ledger

## 6. Ledger

- [x] 6.1 Retain non-context `llm-as-jev-ledger` persistence via two-argument appendEntry for validated raw judgments/rejections/coverage/diagnostics and active-branch-only replay. Verify new native model/tag identity, stale old `jev` entries ignored without rewrite, resume reuse, special own JSON keys, no bodies/secrets, and no incomplete/aborted/stale-generation judgment accepted
- [x] 6.2 Wire ledger persistence into `judge()` (`onStore`, `onReject`, diagnostics per request); verify an integration test that two `judge()` calls across a simulated resume send exactly one backend request

## 7. Classifier provider registration

- [x] 7.1 Implement `src/provider.ts`: register `llm-as-jev` provider with the form proven in 1.2, exposing zero or one classifier model derived from the configured chat model (`id = provider/modelid`, `contextWindow`, `cost`) and a `classify` that delegates to the LLM backend; verify unit tests for unconfigured → no models, configured → one model, and `classify` result `provider`/`model` provenance
- [x] 7.2 Refresh emulation after confirmed chat-model/thinking changes and verify immediate discovery and actual dispatch in the same real Pi process without restart OR `/reload`; changing only native selection must leave the derived emulated model identity/chat settings unchanged

## 8. Commands and picker UI

- [x] 8.1 Implement `/llm-as-jev mode <auto|classifier|llm>` and status showing mode, explicit/default effective classifier and availability, LLM model/level and config path; verify formatter tests and real TUI mode persistence, with no old `jev` mode alias
- [x] 8.2 Reuse one searchable picker for native and chat lists: available models alphabetic by provider/id, fuzzy id/display-name filtering preserving order, real-index preselection and cancellation without disk/memory change; verify pure helpers and real TUI including native emulation exclusion
- [x] 8.3 Implement the thinking level picker using `getSupportedThinkingLevels(model)`, preselect configured level else model default, confirm persists both values, swaps in-memory config, and triggers 7.2 re-registration; verify unit tests for level lists of a reasoning and a non-reasoning model and a manual TUI check that the next `judge()` uses the new model
- [x] 8.4 Add `/llm-as-jev classifier` for independent native selection, atomic confirm and immediate next-judgment effect without a thinking step; verify non-Jev selection, cancel, no chat/main-session mutation, unavailable/empty lists, and restoring default discovery by removing the global classifier field

## 9. Extension entry and docs

- [x] 9.1 Assemble `src/index.ts`: load config, construct service, publish the `Symbol.for` handle on activation and clear it on dispose, register provider and commands, hook ledger restore; verify `npm run check` and a manual session where `getJudgmentService()` from a scratch extension returns the service
- [x] 9.2 Write README with the updated classifier/LLM client API, independent config/commands, preserved Jev defaults, unavailable explicit models, native numeric-policy/calibration limits, ordered evidence, discrete-LLM disclosure and BREAKING prototype tags. State consumer migrations are separate; verify exact client examples typecheck
- [x] 9.3 User-gated real inference only: with independently configured LLM and no native candidate, verify choice/bool/score return `backend: "llm"`; with available selected/default native model in auto, verify `backend: "classifier"` and actual confidence/named-choice threshold filtering, including `minConfidence: 0.99` and genuine dropped entries when the reported fields are below the gate. Never fabricate drops, substitute offline fixtures for live inference or run without explicit authorization; user-authorized live checks passed with `openai-api-extension/xl/claude-opus-5-5` (low) and `typesafe/jev-latest`. Evidence: [acceptance record](acceptance.md).

## 10. Candidate acceptance

- [x] 10.1 Verify end-to-end model pinning and arbitrary own JSON keys through native dispatch, raw cache, joined stricter callers, forced reviews, evidence stages and active-branch restore; selected-model switches and old prototype tags must never yield mismatched reused identities
- [x] 10.2 Run the exact-final `TMPDIR=/var/tmp npm run check`, planning strict validation and isolated real Pi offline host/TUI checks; retain reproducible commands/results and do not count `/reload` as immediate-update evidence
- [x] 10.3 Obtain fresh-context read-only candidate review against all artifacts and acceptance gates, resolve proven findings, and rerun affected/full checks before acceptance. Keep live 9.3 separate and unmarked while unauthorized
