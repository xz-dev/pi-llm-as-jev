## Context

See proposal.md for motivation. This is a new Pi extension; two future consumers currently implement their own System One clients. This change is scoped to this repository, not their migrations.

Source facts checked against Pi 1.0.0 and installed host `1.0.0-xz.252.1.gc6d2b9ff`:
- Pi provides typed `ClassifierContext`, `ClassifierResult`, classifier discovery and request-time authentication through `modelRegistry.classify()`.
- `SimpleStreamOptions.toolChoice` allows only `auto` or `none`; malformed/no-tool replies need explicit validation and one bounded retry.
- `getSupportedThinkingLevels()` and `clampThinkingLevel()` are exported by pi-ai and are also used by Pi's own thinking settings.
- `pi.appendEntry(customType, data)` persists non-context custom entries. It takes two arguments, not `display: false` (that belongs to model-visible custom messages).
- The reference audit pipeline is distributed across `typesafe.ts`, `capacity.ts`, `rolling.ts`, and `ledger.ts`. `rolling.ts` also splits evidence and carries intermediate judgments; question splitting alone would not replace it.
- Watchdog waiting checks use choice confidence; unlock review compares `probabilities.contradicted`. These are different threshold metrics.

Confirmed user decisions:
- The shared service owns caching, evidence/question splitting, recovery and session-branch ledger; consumers compose questions and use final answers.
- Native classification now supports explicitly selected compatible Pi classifier models, with Jev remaining the default discovery candidate. Numeric gates use the adapter's defined confidence/probability fields; the classifier type alone does not establish calibration. Ordinary LLMs never report percentages/confidence and ignore numeric thresholds.
- LLM binary decisions mean business condition satisfied/not satisfied, NOT an additional certain/uncertain self-rating. Existing multi-choice and score questions retain their legal labels/levels.

## Goals / Non-Goals

**Goals:**
- One in-process judgment pipeline, branch-local persistence and a reusable client with no package coupling.
- Preserve Jev as the default native candidate and its threshold semantics, while supporting explicitly selected compatible classifiers; make ordinary LLM responses discrete.
- Expose the same LLM emulation through a native Pi classifier provider.
- Reuse Pi authentication, UI primitives and thinking-level logic.

**Non-Goals:**
- Editing the two consumer repositories, global Pi settings, or credentials.
- A local System One HTTP server, probabilistic calibration, ensembles or majority voting across evidence chunks.
- Project config overrides, automatically selecting arbitrary non-Jev classifiers without an explicit choice, or silently trimming evidence. Explicit selection through an existing compatible Pi classifier adapter is in scope; implementing new local inference transports or logprob adapters is not.
- Git commits/branches or installing global tooling.

## Decisions

### D1. Service discovery and lifecycle
Publish a versioned service at `globalThis[Symbol.for("pi-llm-as-jev:service")]`. Consumers look it up at call time. This matches existing ecosystem practice and avoids request/response plumbing on the fire-and-forget event bus. Ship a self-contained typed client with structural Pi classifier types; avoid maintaining two divergent contracts by exporting its types from `src/contract.ts`.

Bind session-dependent operations to the current extension context. Rebuild state from the active branch on start, session switch/fork/tree navigation and reload as applicable. Capture a session/branch generation for requests; a late result from an abandoned generation cannot enter the new branch's cache or ledger. In-flight joins are generation-scoped. Remove the global handle only if it is still this instance's handle during shutdown, so an old runtime cannot remove its replacement.

### D2. Public request and policy contract
```ts
interface EvidenceRecord {
  id: string;
  text: string;
  metadata?: JsonObject;
}
interface JudgeRequest {
  state: JsonObject; // fixed state; unchanged when evidence is subdivided
  questions: Record<string, ClassifierQuestion>;
  evidence?: EvidenceRecord[]; // stable unique ids, original order
}
type ThresholdRule =
  | { metric: "confidence"; minimum: number }
  | { metric: "choiceProbability"; choice: string; minimum: number };
interface JudgeOptions {
  minConfidence?: number; // default policy for supported native classifier fields
  thresholds?: Record<string, ThresholdRule>; // per-question override
  signal?: AbortSignal;
  timeoutMs?: number;
  fresh?: string; // force a review; retries within this token reuse new judgments
}
interface JudgeResult {
  answers: Record<string, ClassifierAnswer>; // final accepted view only
  dropped: string[];
  backend: "classifier" | "llm";
  model: string; // provider/modelid; identifies the actual selected model
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
  contextOverflow?: boolean;
  reuse: { hits: number; joined: number; sent: number };
  usage?: Usage; // reported nested usage only, never invented
}
interface JudgmentService {
  version: 1;
  judge(req: JudgeRequest, opts?: JudgeOptions): Promise<JudgeResult>;
  availability(): Promise<{ classifier?: string; llm?: string }>;
}
```
Validate JSON, question definitions, unique evidence ids, gate metrics and finite thresholds in [0,1] at the public boundary. A named-choice probability rule must name an existing choice. Default bool certainty is `max(p, 1-p)`. Per-question rules override, rather than stack with, `minConfidence`. The LLM path ignores numeric policies; the consumer checks the resulting discrete business label, not numeric compatibility fields. No new self-certainty gate is added.

### D3. Native classifier selection and backend
Discover available classifier models through Pi's authenticated registry and exclude this plugin's `llm-as-jev` emulation provider from native selection. An explicitly configured `classifierModel` (`provider/modelid`) pins the candidate, including compatible models not named Jev. Require the existing `choice`/`bool`/`score` answer contract and the adapter's defined numeric-field semantics; do not infer calibrated confidence from the model type, invent missing probabilities, or guess a numeric scale.

When no classifier is explicitly selected, retain Jev identity filtering and the current provider preference: `typesafe`, `openrouter`, `cloudflare-workers-ai`, `vercel-ai-gateway`, then `opencode`. Do not automatically pick an arbitrary other classifier. An explicit but missing, wrong-type or unavailable classifier does not permit silently substituting another native model; preserve that selection for diagnostics.

Modes are `auto|classifier|llm`. `auto` uses the selected/default available native candidate, otherwise the configured LLM. Forced `classifier` and `llm` never switch to the other backend. A provider-call failure or incompatible result is a structured error, not a reason to fall back or bypass authentication. Pin the backend, full model reference and effective thinking level across dispatch, subdivision, raw-cache identity and ledger writes.

Pass the combined caller/session/deadline signal to registry operations and return structured errors. Apply caller deadlines across discovery, classification, subdivision and retry, rather than resetting the timeout for each leaf.

### D4. Discrete LLM backend
Use `modelRegistry.streamSimple()` and its `.result()` to preserve Pi authentication, provider overrides, cancellation and usage. A system prompt treats supplied state/evidence and intermediate opinions as untrusted data, never new instructions. One `answer` tool per question:
- choice: `{ choice: enum(criteriaKeys) }`
- bool: `{ value: boolean }` (condition satisfied or not satisfied)
- score: `{ score: integer 0..criteria.length-1 }`

No probabilities/confidence appear in the tool schema or are requested from the model. Strictly validate exactly one matching tool call; unknown labels, malformed arguments and prose-only responses get one retry, never heuristic parsing. Provider/auth/timeout errors are not malformed-output retries.

Build Pi compatibility fields locally: choice probabilities are one-hot and confidence is 1; bool becomes probability 0/1; score is the selected level with confidence 1. These encode deterministic selection, not measured certainty. The service never thresholds these fields for LLM judgments. Forward the effective level using Pi's clamp helpers; for supported `off`, omit reasoning exactly as Pi's simple API does. Unsupported levels, including unsupported `off`, use Pi's supported-level clamp rather than inventing provider-specific settings.

One request per question is a known throughput ceiling, not an accuracy enhancement. Keep the state prefix stable for provider prompt caching. Batch only if this becomes measurably expensive; no ensemble or self-reported numbers.

### D5. Native classifier provider (spike verified)
Use the native `pi.registerProvider(provider)` overload. Legacy `(name, config)` accepts `apiKey: string`, not the nested `auth` object originally sketched. Native provider has `getModels: () => []`, `getAllModels` returning zero or one configured classifier and `classify` delegating to the same discrete LLM backend. Derive `id`, cost and context limit from the configured chat model. No chat model leaks into `/model`.

Its `auth.apiKey` omits `login`; `check` delegates to the underlying chat provider's availability; `resolve` returns an internal `emulated` marker only when that provider is ready. The marker is never sent to the target endpoint: nested streaming resolves real chat-provider authentication. Do not advertise the classifier unconditionally when the underlying provider is unavailable. Replace/refresh registration after confirmed chat-model/thinking changes, with no stale-model dispatch.

This registration remains LLM emulation even though Pi lists it as a classifier: compatibility confidence/probability fields never enter native numerical policy, and this provider is excluded from the native picker/discovery. Changing only `classifierModel` does not change the configured chat model, thinking setting or derived emulation model identity.

Task 1.2 evidence: isolated real Pi RPC session, `CLASSIFIER_SPIKE_PASS` from `test/spike-provider.ts`: discovery, classifier dispatch, delegated unavailability, no login handler. No remote inference or global config changes. Runtime settings changes and live inference remain later verification tasks.

### D6. Cache and ledger
Cache validated RAW judgments, not a caller's filtered view. Digest canonical JSON of protocol version, backend, provider/model, effective thinking level, fixed/expanded state, ordered evidence, question id and definition. Thresholds are not in this identity: reapply each caller's threshold policy on cache hits, in-flight joins and restored results. A judgment dropped for one caller is never treated as accepted for another without checking its rule.

Stage identities include the expanded evidence fragment metadata and preceding raw opinions, so different evidence histories cannot collide. A root final-judgment cache avoids replaying a completed evidence pipeline. Preserve forced-review token membership and exact-envelope size rejections. A canceled waiter must not inject stale results into a different branch; avoid sharing across session generations.

Persist non-context custom entries with `pi.appendEntry("llm-as-jev-ledger", data)`: raw validated judgments, exact rejection hashes, stage coverage identifiers and compact usage/capacity diagnostics. No state/evidence bodies, full provider replies, keys or reasoning transcripts. Reconstruct only from `getBranch()`, never all session-file entries. Do not persist new judgments for an aborted request; validated completed stages from a non-abort failure may be reused after resume, but no incomplete overall result reaches business logic. Business-specific board progress receipts remain the consumer's responsibility.

### D7. Capacity and ordered evidence recovery
Port the existing capacity predictor and explicit-overflow recognition, not arbitrary error-message substring retry. Use the selected model's declared context limit plus verified adapter-specific envelope dimensions. Constraints follow the actual classifier API/model, not a generic assumption that all native classifiers have the same envelope. Remove the previous unsupported assumption that every Jev model reads state twice; that detail belongs to `llama-cpp-classify`, not System One. Estimates remain soft: send an irreducible, not-yet-rejected unit once for authoritative provider admission. Reserve prompt/tool/output overhead when estimating LLM envelopes. Rate limits, billing and authentication errors never trigger evidence subdivision.

For requests without `evidence`, fixed state is indivisible and only questions can be split. For evidence requests, send an explicit wrapper `{ fixed: state, evidence: batch, previousAnswers, coverage }`, leaving fixed state intact. On overflow reduce the constrained dimension: question count or evidence bytes. Process evidence batches sequentially; carry validated prior-stage opinions as advisory input, never as authorizations. A single oversized text record can be subdivided at Unicode-safe character boundaries, retaining source id, start/end/total bounds and completeness markers. Do not alter metadata, reorder records, omit bytes or advance final coverage until all fragments finish. If fixed state plus a minimal unit still fails, return an explicit overflow error with no final answers.

The returned final judgment is the final complete stage informed by the preceding stages, not a union/vote over independent evidence pieces. Only question batching over the SAME state can merge answers by question id. Intermediate states/answers are not model-visible transcript messages and never trigger consumer actions. Persist coverage hashes so partial non-abort work can be resumed without claiming completion.

### D8. Settings/UI
Global `<agentDir>/llm-as-jev.json` only: `mode` (`auto|classifier|llm`), optional `classifierModel` and the existing LLM `model` (both `provider/modelid`), LLM-only `thinkingLevel`, and `timeoutMs`. Split each model reference on its FIRST slash; model ids themselves may contain slashes. Missing/unreadable/invalid files use the known-setting defaults, with a once-per-session diagnostic for unreadable/invalid files; do not partially accept an invalid known-setting file. Unknown extra keys are preserved and do not by themselves make the file invalid. A syntactically valid explicit classifier absent from the catalog remains an unavailable selection under D3, not permission to discover a different native candidate.

`/llm-as-jev` shows status then the existing chat-model/level pickers. `/llm-as-jev classifier` selects an available compatible native classifier, excluding this plugin's emulation, without a chat thinking-level step. `/llm-as-jev mode <auto|classifier|llm>` selects mode. Native selection leaves chat model/thinking unchanged; chat selection leaves `classifierModel` unchanged. Removing `classifierModel` from the global file restores the default Jev discovery behavior.

Use the same searchable `Input + SelectList + fuzzyFilter` behavior for both model lists: alphabetic provider/id ordering (including filtered results), preselection at the configured model's real index, never moving it to the top. Chat selection is followed by supported-level selection using Pi's helpers. Cancel at any step changes neither file nor in-memory settings. Status distinguishes configured/effective native candidate, native availability, LLM model/level and config path. Do not change the main session model/thinking level. Guard custom UI to TUI mode; non-interactive service operation still works. Save and swap settings atomically after final confirmation.

### D9. Redaction and checks
Resolve known backend keys through Pi, not separate endpoint/env fallback code. Redact those values from outgoing fixed state, evidence, questions and errors; never log credential values or dump the host environment. Use local fake backends for deterministic unit/service checks. Real-host provider and picker checks use task-scoped agent/session directories under `/var/tmp`, never the user's global config. Live inference uses synthetic evidence only and must be reported separately from mock/host verification.

## Risks / Trade-offs

- [Chunked evidence loses full simultaneous context] -> carry prior opinions, mark partial coverage, process every record, return only a complete final stage; never use voting to claim full-context equivalence.
- [Compatibility confidence 1 mistaken for calibrated certainty] -> discrete tool schema, explicit provenance and documentation; numerical gates use supported native-adapter fields only, never the emulation's compatibility numbers.
- [Native classifiers have different calibration/field semantics] -> use the adapter's defined contract and validated ranges, disclose that scores are not universally calibrated, and reject unsupported results rather than inventing conversions.
- [One LLM call per question increases costs/latency] -> exact-cache/in-flight reuse, stable prefixes, a `ponytail:` ceiling comment; do not claim token/cost data that providers did not report.
- [Late response crosses branch/reload boundary] -> generation-scoped requests, cache and ledger writes; active branch restoration and identity-checked cleanup.
- [False capacity prediction] -> authoritative one-time leaf admission, verified exact rejection suppression, no silent cropping.
- [Consumers still inspect raw confidence after migration] -> document the accepted service view and named-choice policy; their migrations are separate changes.

## Migration Plan

1. Before initial consumer adoption, align the prototype config/API tags: `mode: jev` becomes `classifier`, result `backend: jev` becomes `classifier`, and `availability().jev` becomes `.classifier`. This is a **BREAKING prototype-interface rename**, not an alias hidden behind model names. Update relevant fixtures and examples during a later authorized apply. Existing `jev`-tagged cache/ledger data is stale under the new backend identity; do not rewrite session entries or loosely accept it as another identity.
2. Ship service/client/provider/UI in this repository with tests and host evidence, including explicit non-Jev selection and the preserved default Jev path.
3. Separate watchdog change: compose questions and pass confidence/named-choice rules; retain activity/permission guards and reason formatting; no transport/threshold interpretation duplicated.
4. Separate audit change: supply fixed business state, ordered evidence and questions; remove its model transport, capacity, cache and evidence-recovery loop; retain board reconstruction, business verdicts and board progress receipts.
5. Absent service means feature unavailable rather than crash. Deprecated endpoint/key config requires consumer-local migration notices; no credential migration is performed here.

## Open Questions

None blocking for the approved classifier-selection design. Project overrides, new inference transports/adapters, and a calibration framework remain outside this change.
