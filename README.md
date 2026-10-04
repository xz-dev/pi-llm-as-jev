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
	"timeoutMs": 120000
}
```

- Both model slots are `provider/modelid`, split on the **first** slash
  (model ids may contain slashes) and fully independent: configuring one
  never mutates the other, and nothing inherits the main-session model or
  thinking level.
- `mode: auto` uses the selected/default available native classifier and
  otherwise falls back to the LLM. `classifier` and `llm` never switch to
  the other backend.
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
- An unreadable or invalid file is reported once per session and **all**
  known settings use defaults (no partial acceptance). Unknown extra keys
  are preserved on save and never invalidate the file. Saves are atomic
  (temp file + rename) and only swap in-memory state after a successful
  write.

## Commands

| Command | Effect |
|---|---|
| `/llm-as-jev` | Status line, then chat model → thinking level pickers |
| `/llm-as-jev status` | Status line only |
| `/llm-as-jev mode <auto\|classifier\|llm>` | Persist mode (old `jev` rejected) |
| `/llm-as-jev classifier` | Native classifier picker (no thinking step) |

Status shows mode, the effective native candidate and its availability,
the LLM model/level and the config path — and distinguishes an unavailable
explicit classifier from unconfigured default discovery.

Both pickers are searchable (`Input` + `SelectList` + fuzzy matching over
`provider/id` **and display names**), alphabetically ordered by
`provider/modelid` including filtered results, with the configured model
preselected at its real index. The native list excludes this plugin's own
LLM-emulation provider. Chat confirmation refreshes the registered emulated
classifier immediately (no restart or `/reload`); native confirmation
applies to the next judgment immediately. **Cancel at any step leaves both
disk and memory unchanged.** Custom pickers are TUI-only; non-interactive
sessions still get status and full service operation. The main-session
model and thinking level are never touched.

## Registered classifier provider

The extension also registers `llm-as-jev` as a native Pi classifier provider
exposing the configured LLM as `getAvailableOfType("classifier")` entry
`llm-as-jev/<provider>/<modelid>` with the chat model's `contextWindow` and
cost — visible to codemode scripts and other extensions. It is LLM
emulation: its compatibility numbers never enter native numeric policy, and
it is excluded from the native picker/discovery.

## Session ledger

Validated raw judgments, exact rejection envelopes, stage coverage and
per-request diagnostics persist as non-context custom entries
(`llm-as-jev-ledger`) — never bodies, secrets or provider replies — and are
replayed **from the active branch only** on session start/tree/fork/switch.
Aborted work persists no new judgments; late results from an abandoned generation
cannot enter a new branch's cache or ledger.

## Consumer migrations (separate changes)

Migrations land in the consumers' own repositories; this package defines
the contract:

- **pi-continue-watchdog**: drop `askJevChoice` / `resolveJevEndpoint` /
  System One constants from `src/jev-wait-gate.ts`; compose questions and
  pass confidence/named-choice rules; keep activity/permission guards and
  reason formatting. Treat an absent service as feature-unavailable.
- **pi-jev-todo-audit**: drop transport, `EvaluationCache`, `envelopeKey`,
  `isContextOverflow` from `typesafe.ts`, all of `capacity.ts`, and the
  `eval`/`rejected`/`diag` ledger kinds from `ledger.ts` (keep `receipt`);
  supply fixed business state, ordered evidence and questions; keep board
  reconstruction, business verdicts and board progress receipts.

## Development

```sh
npm run check   # lint + typecheck + tests + build
```

Verification layers are kept distinct in this repo's records: **unit**
(fake registries, deterministic), **offline host/TUI** (real `pi` process
under `/var/tmp` with pseudo-credential fixture providers, no network), and
**live inference** (real keys, real spend — never run by CI or agents, only
by explicit user authorization).
