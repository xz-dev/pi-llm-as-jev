# pi-llm-as-jev

A Pi extension that exposes one in-process **judgment service** to other
extensions: it answers typed `choice` / `bool` / `score` questions about JSON
state, choosing between an independently selected **native Pi classifier**
(Jev by default) and a **discrete LLM backend** built on any tool-calling
chat model. Consumers compose questions and consume answers; the service
owns selection, caching, capacity splitting, ordered-evidence recovery,
threshold policy and a branch-scoped session ledger.

> **BREAKING (prototype rename).** The prototype interface tagged the native
> path as `jev`. It is now `classifier`: `mode` is `auto | classifier | llm`,
> `JudgeResult.backend` is `"classifier" | "llm"`, and `availability().jev`
> is `availability().classifier`. The old `jev` values are rejected (not
> aliased). Old `jev`-tagged cache/ledger entries are stale under the new
> backend identity and are ignored, never relabeled. Update prototype
> configs, clients and examples during migration.

## Install

This is a Pi extension package (no runtime npm dependencies):

```jsonc
// consumer package.json or ~/.pi/agent/settings.json extensions entry
{ "extensions": ["pi-llm-as-jev"] }
```

Peer types only: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`,
`@earendil-works/pi-tui`.

## Consumer quick start

Copy `client/judgment-client.ts` into your extension (it is self-contained,
zero dependencies) or re-export its types from `src/contract.ts`. Look the
service up at call time — no load-order dependency:

```ts
import { getJudgmentService } from "./judgment-client.ts";

const service = getJudgmentService();
if (service) {
	const result = await service.judge(
		{
			state: { repo: "acme/api", ci: "green" },
			questions: {
				verdict: {
					type: "choice",
					instructions: "Deployment verdict for the current change set",
					criteria: {
						ship: "Ready to deploy",
						hold: "Hold for review",
						revert: "Revert the change",
					},
				},
			},
		},
		{ minConfidence: 0.8 },
	);
	if (result.stopReason === "stop" && result.answers.verdict?.type === "choice") {
		const verdict = result.answers.verdict.choice; // "ship" | "hold" | "revert"
	}
}
// Extension absent: leave the judgment feature unavailable, never a crash.
```

### Full client API

```ts
interface JudgmentService {
	version: 1;
	judge(req: JudgeRequest, opts?: JudgeOptions): Promise<JudgeResult>;
	availability(): Promise<{ classifier?: string; llm?: string }>;
}

interface JudgeRequest {
	state: JsonObject;                              // fixed, never subdivided
	questions: Record<string, ClassifierQuestion>; // choice | bool | score
	evidence?: EvidenceRecord[];                    // ordered, stable unique ids
}

interface EvidenceRecord {
	id: string;
	text: string;
	metadata?: JsonObject; // preserved verbatim (incl. own `fragment` keys)
}

interface JudgeOptions {
	minConfidence?: number;                  // native default gate
	thresholds?: Record<string, ThresholdRule>; // per-question override
	signal?: AbortSignal;
	timeoutMs?: number;
	fresh?: string;                          // force review; reuse within token
}

type ThresholdRule =
	| { metric: "confidence"; minimum: number }
	| { metric: "choiceProbability"; choice: string; minimum: number };

interface JudgeResult {
	answers: Record<string, ClassifierAnswer>; // final accepted view only
	dropped: string[];                         // native-gate failures
	backend: "classifier" | "llm";
	model: string;            // provider/modelid actually used
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;    // set when stopReason !== "stop"
	contextOverflow?: boolean;
	reuse: { hits: number; joined: number; sent: number };
	usage?: Usage;            // provider-reported only, never invented
}
```

`judge()` **never throws** — every failure resolves through `stopReason` and
`errorMessage` with an empty `answers` map.

### Ordered evidence

Supply fixed state plus ordered evidence records; the service owns overflow
recovery over **both** question batches and evidence batches, processes
evidence in order, carries intermediate judgments forward as advisory data,
splits oversized records at Unicode-safe boundaries (preserving source id,
absolute fragment bounds and caller metadata), and returns only the complete
final stage:

```ts
const result = await service.judge(
	{
		state: { board: "release-42", frozen: true },
		questions: {
			blocked: {
				type: "bool",
				instructions: "Is the release blocked by unresolved findings?",
				criteria: { true: "blocked", false: "clear" },
			},
			severity: {
				type: "score",
				instructions: "Highest severity across all findings",
				criteria: ["info", "minor", "major", "critical"],
			},
		},
		evidence, // ordered EvidenceRecord[]
	},
	{ timeoutMs: 60_000 },
);
```

If fixed state plus one irreducible fragment cannot fit, you get an explicit
`contextOverflow` error — evidence is never silently trimmed.

### Resumable reviews (additive capability)

`judge()` remains final-only. Consumers that need durable partial progress must
check the separate `reviewVersion` capability at **each eligible call**, not
just at extension load:

```ts
import { getJudgmentService, type ReviewService } from "./judgment-client.ts";

const candidate = getJudgmentService() as Partial<ReviewService> | undefined;
if (candidate?.version === 1 && candidate.reviewVersion === 1 &&
    typeof candidate.review === "function") {
  const review = await candidate.review({
    state: { scope: "release-42" },
    questions: {
      readiness: {
        type: "choice",
        instructions: "Is the supplied release evidence sufficient?",
        criteria: { ready: "Sufficient", unresolved: "Missing or conflicting evidence" },
      },
    },
    evidence: [{ id: "ci-report", text: "CI checks are reported passed; rollout awaits approval." }],
  }, { minConfidence: 0.8, timeoutMs: 60_000 });
  // Only accepted final answers are advice candidates. Source/authority checks
  // remain the consumer's job. Progress/opinions never authorize an action.
  if (review.stopReason === "stop" && review.unresolved.length === 0) {
    const choice = review.answers.readiness;
  }
}
// Missing capability: skip this feature, report the dependency, try discovery
// on the next normal trigger. Do not send a probe or use a fallback HTTP client.
```

`ReviewResult` adds `progress.stages`, `unresolved`, and `diagnostics` to
`JudgeResult`. Failed or aborted reviews still have **empty final answers**.
Individually validated native members can be persisted for retry, but only a
complete required raw-answer set advances a stage. Native policy-dropped raw
answers are reusable without becoming accepted advice.

For incremental business projection, additional options and projection outputs are:

- `projectStage({ evidence, completed, previousAnswers, final })`: a synchronous
  callback returning `{ state, questions, unresolved? }`. Set a stable
  `projectionRevision`. Descriptors are isolated copies; the service always sends
  its original selected evidence separately. A callback cannot replace source
  bodies, forge fragment bounds, choose dispatches or advance progress.
- `unresolved`: explicitly withhold required questions rather than silently omit
  them. A withheld id cannot also be dispatched. An empty projected question map
  with all required ids withheld sends nothing and advances no coverage; it is
  distinct from an invalid empty initial request. Valid independent final answers
  can remain available in an incomplete locally withheld scope. Missing provider
  answers instead fail the review with empty finals.
- `onProgress(stage)`: notification after acknowledged durable persistence only.
  `stage` includes an opaque `checkpoint`, source ids/genuine bounds, advisory
  `opinions`, `final`, and `durable`. Notification errors are isolated. Failed
  persistence may appear as `durable: false` in returned stages; never advance a
  consumer receipt from those stages.
- `checkpoint`: an opaque active-branch checkpoint id used as an advisory seed
  for a new incremental review. The service validates lineage and durable answer
  references. Keep still-required original facts in the next request; a seed is
  **not** their factual replacement. `fresh` and `checkpoint` cannot be combined.

For interrupted identical work, reconstruct the same inputs; valid completed
stages/members are reused after branch restoration. To force reassessment, supply
`fresh` and no seed: the same token resumes that review, a new token starts new
work. Only a token digest is persisted. Do not change a token and call the result
resumption of the old review. Mid-record progress preserves UTF-16 bounds without
splitting surrogate pairs; visiting every fragment does not prove that a final
factual view contains every required constraint.

Identity includes selected backend/model/effective thinking/transport, exact
fixed state and each individual question, ordered evidence/metadata/genuine
bounds, prior advisory opinions and finality. Adding independent C need not repay
unchanged A/B. Checkpoint membership is separate from raw-question identity.
Changing only threshold policy rechecks raw judgments without new inference.

### Attempt accounting and review transport

`reuse.sent` counts questions, **not HTTP requests**. Read `diagnostics.attempts`
and `attemptCount` for newly owned observed attempts (including native retries),
`presplits` for predictions, and `rejectedReuses` for avoided known rejections.
Attempt ids survive accounting without colliding across service reloads. A row
with `phase: "start"` is unfinished at settlement, not a fabricated response.
Late events cannot mutate a settled result or write onto a newer branch. Joined
waiters own no new attempt, and cancelling a waiter does not abort its owner.

Check `observationCoverage` first: `"unavailable"` is an accounting/capability
failure, **not proof of zero attempts or cost**. Otherwise each usage field has
`{ knownSum, missing }`; a missing value is not a reported zero, and a total with
missing observations is only a lower bound. `usage.costUsd` is provider-reported
charge; optional `catalogCostUsd` is a separate estimate. Cache hits/joins add no
new owner charge. Native adapters need not report a catalog estimate.

Native reviews use the released classifier API's public `fetch` option. This
plugin records each actual fetch and inspects the response as Pi consumes it;
validated independent answer members can be retained without changing Pi's
strict final result. **No private `observe`/`onAttempt` API or Pi core patch is
required.** Pi still owns request construction, authentication and bounded native
retries. The classifier API is supplied by the xz-dev fork; this is not a claim
that stock Pi exposes that API.

LLM reviews use Pi's injected fetch and provider-event seams, `transport: "sse"`,
and `maxRetries: 0`. A route that ignores the required public hooks or cannot
correlate events fails accounting rather than switching models/backends or
inventing a request count. Offline checks cover actual System One and Anthropic
HTTP/SSE paths, not every provider route. Legacy `judge()` does not require
review accounting capabilities.

## Threshold policy (native classifiers only)

When `backend === "classifier"`, the service applies numeric gates to the
**adapter-defined** native fields: choice/score `confidence`, bool certainty
`max(p, 1-p)`, or the probability of a named choice. Per-question rules
**replace** (never stack with) `minConfidence`. Gates are re-checked on
every call, including cache hits, in-flight joins and restored results:

```ts
// Default gate for all questions:
await service.judge(request, { minConfidence: 0.8 });

// Accept only when the reported `revert` probability is at least 0.6:
await service.judge(request, {
	minConfidence: 0.8,
	thresholds: {
		verdict: { metric: "choiceProbability", choice: "revert", minimum: 0.6 },
	},
});
```

A question whose native numbers miss the gate lands in `dropped` and not in
`answers`. Without any rule, nothing is dropped on either backend.

### Calibration limits (important)

Native numeric fields mean **whatever the classifier's adapter defines**.
Jev reports measured choice probabilities/confidence; an explicitly selected
non-Jev classifier reports whatever its Pi adapter defines — the service
uses those fields as-is, validates their ranges, and never invents missing
numbers or converts between scales. **These values are not claimed to be
uniformly calibrated across models.** Pick thresholds per model; a
`minConfidence` tuned on one classifier does not transfer to another.

## Discrete LLM backend and numeric fidelity

When `backend === "llm"`, an ordinary chat model answers each question with
one constrained tool call — a legal choice key, a bool value, or an integer
score level. **The model is never asked for probability, confidence or
certainty**, and every numeric threshold is ignored: `dropped` is always
empty and the discrete business answer is returned directly. Binary
questions mean *condition satisfied / not satisfied*, with no additional
certain/uncertain self-rating.

The numeric fields Pi's classifier contract requires are **local,
deterministic compatibility encodings**: a selected choice gets a one-hot
probability distribution and `confidence: 1`, a bool becomes probability
`0`/`1`, a score level gets `confidence: 1`. They encode *which label was
selected*, never measured certainty, and the service never uses them as
gate inputs. Check the business label, not these numbers.

## Configuration

Global `<agentDir>/llm-as-jev.json` (`PI_CODING_AGENT_DIR` or
`~/.pi/agent`):

```jsonc
{
	"mode": "auto",                     // auto | classifier | llm
	"classifierModel": "typesafe/jev-1.13", // optional explicit native pick
	"model": "anthropic/claude-sonnet-4-5", // LLM slot (independent)
	"thinkingLevel": "low",             // LLM-only thinking level
	"timeoutMs": 120000,
	"contextLimits": {
		"typesafe/jev-1.13": { "request": 64000, "stateAndLongestQuestion": 32000 }
	}
}
```

- Both model slots are `provider/modelid`, split on the **first** slash
  (model ids may contain slashes) and fully independent: configuring one
  never mutates the other, and nothing inherits the main-session model or
  thinking level.
- `mode: auto` uses the selected/default available native classifier and
  otherwise falls back to the LLM **only during initial availability selection**.
  There is no fallback after dispatch or a provider/accounting error.
  `classifier` and `llm` never switch to the other backend.
- **Jev is the default native candidate** (`typesafe`, `openrouter`,
  `cloudflare-workers-ai`, `vercel-ai-gateway`, `opencode` priority).
  Omitting `classifierModel` keeps that discovery. An explicit selection is
  honored exactly — including compatible non-Jev classifiers — and a
  configured-but-unavailable selection is never silently replaced by
  another native model (auto may use the LLM; forced classifier errors).
- Removing `classifierModel` restores default Jev discovery without
  touching LLM settings.
- An unknown chat model means *no LLM backend*, never a main-session
  fallback.
- Every new `judge()`, `review()`, `availability()`, settings command and
  provider metadata/auth/classification operation reads the current file.
  Sessions already running this version and sharing the same agent directory
  see completed saves on their next operation, without a configuration command,
  restart or reload in the receiving session. Different agent directories stay
  isolated; there is no idle watcher or polling timer.
- An admitted judgment or review keeps one snapshot through discovery, stages,
  retries and error reporting. A save does not cancel old work or reset its
  branch ledger. New calls (including resumed reviews) use current settings;
  reuse still requires the same actual backend/model/effective-thinking identity.
- An unreadable or invalid file is reported once per session and **all**
  known settings use defaults, not a partially accepted or last-valid file.
  A missing file uses defaults without a warning. Reads continue after a warning,
  so repairing or restoring the file takes effect on the next operation.
  Unknown extra keys survive valid patch saves. Saves are atomic (temp file +
  rename); a failed save never publishes a tentative choice.
- Updating the extension's **code** still requires the normal reload/restart.
  Subsequent configuration-file edits do not. Simultaneous overlapping writers
  retain last-write behavior: atomic replacement is not a conflict-free merge.

- `timeoutMs` is a whole-call budget, including discovery/authentication,
  projection, provider waits and recovery, not a fresh budget per attempt.
- `contextLimits` is optional. Keys are exact `provider/modelid` references;
  values have positive safe-integer `request` and/or `stateAndLongestQuestion`
  token limits. A profile replaces the defaults for that model and applies to
  both `judge` and `review`; it is not combined with an unrelated smaller limit.
  Invalid profiles reject all known settings without printing profile values.
- Without overrides, review recognizes TypeSafe-direct Jev's 64k request-wide /
  32k state-plus-longest profile and OpenRouter System One's 32k / 32k profile at
  their known endpoints. Other routes use the selected model's context window.
  Legacy `judge` retains its model-window default. Custom endpoints/auth belong
  in Pi, not in a consumer's former endpoint fields.
- Capacity uses the actual serialized envelope and transport-scoped learning.
  Predictions are not exact token counts. Later usable lower-density successes
  correct estimates, including after reload. Overestimated fixed facts get one
  useful unanswered-batch admission; known exact rejections stay protected.
  Only recognized context overflow permits recovery. Auth/quota/rate/validation/
  generic payload errors do not justify subdivision. Required facts are never
  silently cropped to fit.

## Commands

| Command | Effect |
|---|---|
| `/llm-as-jev` | Read-only overview (same as `status`) |
| `/llm-as-jev status` | Read-only overview |
| `/llm-as-jev llm` | Chat model → thinking level pickers |
| `/llm-as-jev classifier` | Native classifier picker (no thinking step) |
| `/llm-as-jev mode <auto\|classifier\|llm>` | Persist mode (old `jev` rejected) |

The bare command and `status` never open a picker, write settings, send an
inference request or touch the main-session model/thinking — in any mode,
including non-TUI. The former `/llm-as-jev-classifier` alias is removed; the
native entry is `/llm-as-jev classifier`. Command-line completion after
`/llm-as-jev` offers `status`, `llm`, `classifier` and all three `mode`
forms.

The overview shows labeled `Mode`, `Classifier`, `LLM`, `Thinking` and
`Config` rows. `Mode` is `Auto(classifier)` when the selected/default
native candidate is usable, `Auto(llm)` when only the configured LLM is
usable, `Auto(None)` when neither is, or the forced `Classifier` / `LLM`
label. The suffix describes an **availability snapshot only** — not quota,
billing or a promise of successful inference — and changes nothing about
routing: `auto` still falls back only during initial availability
selection, never after a dispatched request fails.

An omitted `classifierModel` displays `Jev` (default discovery) plus the
resolved `provider/modelid` when available, or `Jev (unavailable)` when
not. An omitted LLM `model` displays `None` — which is different from a
configured reference shown with `(unavailable)` when it is missing from
Pi's catalog or lacks usable credentials. When the configured mode has no
usable backend a warning names the relevant settings command; forced modes
never switch to the other backend automatically.

Both pickers are searchable (`Input` + `SelectList` + fuzzy matching over
`provider/id` **and display names**), alphabetically ordered by
`provider/modelid` including filtered results, with the configured model
preselected at its real index. The native list excludes this plugin's own
LLM-emulation provider. Opening either picker reads current settings; the open
interaction keeps its original preselection even if another session saves.
Confirmation patches only the selected fields against the file read for that
save, preserving unrelated changes completed before that read and unknown keys.
**Cancel at either step writes nothing and never rolls back another save.**
Reopening reads the latest values. The read-only overview uses one snapshot for
both its displayed settings and availability. Custom pickers are TUI-only;
non-interactive sessions still get the overview and full service operation.
The main-session model and thinking level are never touched.

## Registered classifier provider

The extension also registers `llm-as-jev` as a native Pi classifier provider
exposing the configured LLM as `getAvailableOfType("classifier")` entry
`llm-as-jev/<provider>/<modelid>` with the chat model's `contextWindow` and
cost — visible to codemode scripts and other extensions. It is LLM
emulation: its compatibility numbers never enter native numeric policy, and
it is excluded from the native picker/discovery. The next public listing reflects
current target identity, context window and credential availability without a
priming judgment or re-registration. Classifying through a previously retained
descriptor uses the current configured target and reports its actual full model
reference; removed/unavailable targets return an error rather than using the
old target. A classification already in flight keeps its own snapshot through
output repair.

## Session ledger

Validated raw judgments, exact rejection envelopes, stage coverage and
per-request diagnostics persist as non-context custom entries
(`llm-as-jev-ledger`) — never bodies, secrets or provider replies — and are
replayed **from the active branch only** on session start/tree/fork/switch.
Legacy `judge` buffers new judgments until non-aborted settlement. `review`
keeps already-durable pre-abort stages and individually validated native partial
members; those are historical work, not successful final answers. Answers are
written before checkpoint references. Failed appends cannot establish durable
progress. Late results from an abandoned generation cannot enter a new branch's
cache or ledger.

## Consumer migration

`pi-jev-todo-audit`'s companion development change now uses `reviewVersion: 1`.
Audit owns question construction, source projection, scheduling, business
receipts, diagnostics and advisory/TODO safety. This service owns backend/model
selection, policy, raw cache, capacity/recovery and judgment/attempt storage;
Pi owns provider transport/authentication. Old audit `model`, `apiUrl`, `apiKey`,
`apiKeyEnvVar` and `contextLimits` load but are ignored, with field-name-only
notices. No credential import or automatic configuration rewrite occurs.
Configure selection/limits here and endpoints/credentials in Pi before enabling
audits in an installed host; a missing/incompatible service makes audit skip with a dependency notice,
without disabling ordinary TODO/main-agent work.

Watchdog migration is separate and has not been performed by this change.
Neither these source changes nor offline tests activate an installed checkout,
prove live quality/billing, or publish a release.

## Development

```sh
npm run check   # lint + typecheck + tests + build
```

Verification layers are kept distinct in this repo's records: **unit**
(fake registries, deterministic), **offline host/TUI** (real `pi` process
under `/var/tmp` with pseudo-credential fixture providers, no network), and
**live inference** (real keys, real spend — never run by CI or agents, only
by explicit user authorization).
