# pi-llm-as-jev

A Pi extension that exposes one in-process **judgment service** to other
extensions: it answers typed `choice` / `bool` / `score` questions about JSON
state, choosing between an independently selected **native Pi classifier**
(Jev by default) and a **discrete LLM backend** built on any tool-calling
chat model. Consumers compose questions, pack every necessary fact into
`state` and consume answers. The service is **stateless**: no result cache,
no in-flight joins, no evidence subdivision, no checkpoints, no session
ledger, no learned capacity and no transport-attempt accounting. Identical
calls perform independent inference.

> **BREAKING (version two).** `version: 1`, `review()`, `reviewVersion`,
> `reviewCacheVersion`, `reviewStagesVersion`, `evidence`, `timeoutMs`,
> `fresh`, `cache`, `planStages`, `projectStage`, `projectionRevision`,
> `checkpoint`, `onProgress`, `reuse`, `progress`, `diagnostics`,
> `unresolved` and `inputDimensions` are removed. Removed request/option
> fields are rejected explicitly, never silently ignored. Historical
> `llm-as-jev-ledger` session entries are left intact and never restored or
> rewritten. Check `version === 2` before calling `judge()`.

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
if (service?.version === 2) {
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
// Missing or version-one handle: leave the judgment feature unavailable.
```

### Full client API

```ts
interface JudgmentService {
	version: 2;
	judge(req: JudgeRequest, opts?: JudgeOptions): Promise<JudgeResult>;
	availability(): Promise<{ classifier?: string; llm?: string }>;
	capacityVersion?: 2;                              // advertises describeSelection + result.capacity
	describeSelection?(opts?: { signal?: AbortSignal }):
		Promise<CapacityDisclosure | { error: string }>;
}

interface CapacityDisclosure {
	backend: "classifier" | "llm";
	model: string;                                    // provider/modelid
	limits: { request?: number; stateAndLongestQuestion?: number; contextWindow?: number }; // tokens
	limitSource: "override" | "model" | "none";       // declared, not proven
}

interface JudgeRequest {
	state: JsonObject;                              // every needed fact; never subdivided
	questions: Record<string, ClassifierQuestion>; // choice | bool | score
}

interface JudgeOptions {
	minConfidence?: number;                  // native default gate
	thresholds?: Record<string, ThresholdRule>; // per-question override
	signal?: AbortSignal;
	idleTimeoutMs?: number;                  // per-attempt generation-progress idle
	modelTimeoutMs?: number;                 // optional whole-attempt hard cap
}

type ThresholdRule =
	| { metric: "confidence"; minimum: number }
	| { metric: "choiceProbability"; choice: string; minimum: number };

interface JudgeResult {
	answers: Record<string, ClassifierAnswer>; // terminal attempt's accepted view
	dropped: string[];                         // native-gate failures
	backend: "classifier" | "llm";
	model: string;            // provider/modelid actually used
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;    // set when stopReason !== "stop"
	contextOverflow?: boolean; // terminal model rejected input for size
	usage?: Usage;            // provider-reported only, never invented
	capacity?: CapacityDisclosure; // terminal attempt's declared metadata
}
```

`judge()` **never throws** — every failure resolves through `stopReason` and
`errorMessage` with an empty `answers` map. Removed fields (`timeoutMs`,
`fresh`, `cache`, `checkpoint`, `planStages`, `projectStage`,
`projectionRevision`, `onProgress`, `evidence`) are explicit invalid-request
errors.

### Waiting: progress idle plus an optional hard cap

Each backend attempt owns **two clocks**, started at attempt admission and
covering readiness, discovery, authentication, every question and the single
permitted LLM output repair:

- **`idleTimeoutMs`** — generation-progress idle. Renewed only by nonempty
  normalized text, reasoning or tool-argument deltas on the provider stream,
  or a validated completed question answer. Headers, heartbeats, empty
  events, request starts and retries never renew it. A non-streaming native
  adapter is subject to idle expiry while waiting for its complete answer.
  Defaults: **classifier 10 000 ms**, **LLM 15 000 ms**.
- **`modelTimeoutMs`** — optional whole-model-attempt hard limit. Never
  renews; absent means **no hard limit**. It is never derived from an idle
  value or Pi's HTTP idle setting.

Caller options override the configured backend-slot values **independently
per attempted family**. Automatic failover gives the alternate fresh
independent clocks — there is **no combined primary-plus-alternate
deadline**. Timeout cancels cooperative work and settles even when an
adapter ignores cancellation; a retired attempt's late result can never
publish. Caller abort, session navigation and shutdown are terminal.

The **direct emulated-provider entry** is different: the standard Pi
classifier `timeoutMs` option is a finite whole-invocation hard deadline
there (a documented change from this plugin's former idle interpretation)
and overrides the configured LLM hard limit. Service callers use only the
named `idleTimeoutMs`/`modelTimeoutMs` fields.

### Capacity disclosure (capacityVersion 2)

`describeSelection()` resolves the first usable candidate now and its
**declared** input limits (tokens) with their source: an exact configured
`contextLimits` override, the model's own `contextWindow`, or `none`.
Read-only: no inference, no writes, no learned ratios, no built-in channel
constants, no service-envelope estimates. `JudgeResult.capacity` reports the
**terminal attempt's** declared metadata, including a confirmed overflow
failure; fallback answers carry the alternate's identity and limits.
Consumers own packing estimates and local subdivision on explicit overflow.

### Threshold policy (native classifiers only)

When `backend === "classifier"`, the service applies numeric gates to the
**adapter-defined** native fields: choice/score `confidence`, bool certainty
`max(p, 1-p)`, or the probability of a named choice. Per-question rules
**replace** (never stack with) `minConfidence`. Gates apply to each call's
own freshly validated inference:

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
`answers`. Without any rule, nothing is dropped on either backend. All valid
answers are validated against the requested types, labels and numeric
constraints before filtering — an incomplete or malformed raw result never
publishes partial final answers.

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
`~/.pi/agent`; when `HOME` is unset, use the OS home directory, including
Windows path separators):

```jsonc
{
	"mode": "auto",                     // auto | auto-llm | classifier | llm
	"classifierModel": "typesafe/jev-1.13", // optional explicit native pick
	"classifierBaseUrl": "https://jev-proxy.example.com/v1", // optional third-party endpoint for that pick
	"model": "anthropic/claude-sonnet-4-5", // LLM slot (independent)
	"thinkingLevel": "low",             // LLM-only thinking level
	"timeouts": {
		"classifier": { "idleTimeoutMs": 10000, "modelTimeoutMs": 30000 },
		"llm": { "idleTimeoutMs": 15000 }
	},
	"contextLimits": {
		"typesafe/jev-1.13": { "request": 64000, "stateAndLongestQuestion": 32000 }
	}
}
```

- Both model slots are `provider/modelid`, split on the **first** slash
  (model ids may contain slashes) and fully independent: configuring one
  never mutates the other, and nothing inherits the main-session model or
  thinking level.
- `mode: auto` prefers the selected/default available native classifier;
  `mode: auto-llm` prefers the independently configured LLM. Both automatic
  modes switch **once** to the other backend family when the preferred one is
  missing, unavailable or fails at runtime. The alternate restarts the
  complete immutable request with its own fresh clocks; at most one switch
  per operation, no cycling back, and the next operation starts from the
  configured preference again. Valid negative or all-dropped results are
  successes, and invalid requests, caller cancellation and local faults
  never trigger failover. `classifier` and `llm` never switch to the other
  backend.
- **Jev is the default native candidate** (`typesafe`, `openrouter`,
  `cloudflare-workers-ai`, `vercel-ai-gateway`, `opencode` priority).
  Omitting `classifierModel` keeps that discovery. An explicit selection is
  honored exactly — including compatible non-Jev classifiers — and a
  configured-but-unavailable selection is never silently replaced by
  another native model (auto may use the LLM; forced classifier errors).
- Removing `classifierModel` restores default Jev discovery without
  touching LLM settings.
- `classifierBaseUrl` (optional, http/https) sends the explicit
  `classifierModel` to a third-party host of the **same API** — for example a
  TypeSafe System One mirror for `typesafe/jev-latest`. It requires
  `classifierModel` and affects only judgment calls; Pi's own catalog and other
  extensions keep the original endpoint. For System One APIs, give the base
  (`https://host/v1`); Pi appends `systemone`, and a pasted
  `.../v1/systemone` is reduced to its base. Credentials still come from that
  provider in Pi (for `typesafe`, `TYPESAFE_API_KEY` or `/login`). Capacity
  uses only explicit `contextLimits` or selected-model metadata, not built-in
  channel profiles or learned estimates. The endpoint is frozen with admitted
  settings. Picking a different classifier, or clearing the explicit selection,
  drops the URL; unrelated saves and reselecting the same classifier retain it.
  For an endpoint shared by all of Pi, override the provider's `baseUrl` in
  Pi's `models.json` instead.
- An unknown chat model means *no LLM backend*, never a main-session
  fallback.
- **Legacy `timeoutMs` migration.** The removed top-level `timeoutMs` had
  two incompatible meanings (native whole-call deadline vs LLM inactivity).
  While it is present, inference returns an actionable migration error and
  status reports it; nothing is dispatched, rewritten or silently mapped.
  Remove it for the 10 s/15 s idle defaults, or replace it with explicit
  `timeouts` members — no hard limit is ever inferred from the old value.
- Each `timeouts.<slot>` accepts positive-integer `idleTimeoutMs` and/or
  `modelTimeoutMs` within the platform timer range; a missing hard limit
  means none. Invalid values follow the existing invalid-known-field
  behavior (all known settings default).
- Every new `judge()`, `availability()`, `describeSelection()`, settings
  command and provider operation reads the current file. Sessions sharing
  the same agent directory see completed saves on their next operation
  without restart or reload. Different agent directories stay isolated.
- An admitted judgment freezes mode, both model slots, thinking, timing and
  declared capacity overrides through setup, questions, repair and failover.
  A save does not cancel admitted work or change its settings.
- An unreadable or invalid file is reported once per session and **all**
  known settings use defaults. A missing file uses defaults without a
  warning. Unknown extra keys survive valid patch saves; saves are atomic
  (temp file + rename); a failed save never publishes a tentative choice.

## Commands

| Command | Effect |
|---|---|
| `/llm-as-jev` | Read-only overview (same as `status`) |
| `/llm-as-jev status` | Read-only overview |
| `/llm-as-jev llm` | Chat model → thinking level pickers |
| `/llm-as-jev classifier` | Native classifier picker (no thinking step) |
| `/llm-as-jev mode <auto\|auto-llm\|classifier\|llm>` | Persist mode (old `jev` rejected) |

The bare command and `status` never open a picker, write settings, send an
inference request or touch the main-session model/thinking — in any mode,
including non-TUI.

The overview shows `Mode`, `Classifier`, `LLM`, `Thinking`, each backend's
effective **idle duration and hard cap (or disabled)** and `Config`, plus a
migration warning while legacy `timeoutMs` is present. `Mode` shows
`Auto(classifier)` / `Auto(llm)` / `Auto(None)` (or `Auto-LLM(...)`) over an
availability snapshot — not a promise of successful inference.

Both pickers are searchable, alphabetically ordered by `provider/modelid`,
with the configured model preselected. The native list excludes this
plugin's own LLM-emulation provider. Confirmation patches only the selected
fields against the current file; **cancel at either step writes nothing**.

## Registered classifier provider

The extension also registers `llm-as-jev` as a native Pi classifier provider
exposing the configured LLM as `getAvailableOfType("classifier")` entry
`llm-as-jev/<provider>/<modelid>` with the chat model's `contextWindow` and
cost — visible to codemode scripts and other extensions. It is LLM
emulation: its compatibility numbers never enter native numeric policy, and
it is excluded from the native picker/discovery. The next public listing
reflects current target identity, context window and credential availability
without a priming judgment. Classifying through a previously retained
descriptor uses the current configured target and reports its actual full
model reference; removed/unavailable targets return an error rather than
using the old target. A classification already in flight keeps its own
snapshot through output repair. Direct `classify()` callers' `timeoutMs` is
a whole-invocation hard deadline (see Waiting).

## Session history

Version two writes **no** `llm-as-jev-ledger` entries and restores none.
Historical entries in existing sessions are untouched. Consumer-owned
progress/history remains in each consumer's own session mechanism.
Session navigation and shutdown still cancel owned in-flight work; a late
result from a retired generation can never publish.

## Consumer migration

Consumers require `version === 2` and pack every necessary fact into
`state`. A version-one or absent service is an explicit dependency failure,
never a direct-provider fallback or silent downgrade. Old v1 consumers
already reject a v2 handle. `pi-jev-todo-audit` and `pi-continue-watchdog`
carry their own linked migration changes.

## Development

```sh
npm run check   # lint + typecheck + tests + build
```

Verification layers are kept distinct in this repo's records: **unit**
(fake registries, deterministic), **offline host/TUI** (real `pi` process
under `/var/tmp` with pseudo-credential fixture providers, no network), and
**live inference** (real keys, real spend — never run by CI or agents, only
by explicit user authorization).
