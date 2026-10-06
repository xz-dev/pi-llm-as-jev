## Context

See `proposal.md` for motivation and `specs/judge-model-settings/spec.md` for the behavior contract. Commands and picker orchestration live in `src/index.ts`; `src/ui.ts` contains the pure status formatter and picker helpers. The bare command currently shows status and then calls the chat picker, while two commands reach the same native picker.

The service already exposes `availability()`, returning usable selected/default native and configured LLM references. It handles native discovery and checks configured LLM catalog/auth readiness within an existing timeout budget. The current UI's native-only status probe and raw configured LLM string do not provide that full readiness view. Design is included because command compatibility and availability-versus-routing semantics benefit from an explicit technical decision before implementation.

## Goals / Non-Goals

**Goals:**

- Separate read-only inspection from explicit settings mutations using the existing command registration and notification surfaces.
- Derive overview labels and missing-backend guidance from one availability snapshot while retaining the distinction between a default, an explicit selection, and an unconfigured slot.
- Preserve picker transaction boundaries and service routing without introducing another configuration or readiness subsystem.

**Non-Goals:**

- No quota/billing probe, automatic failover after dispatch, cooldown or new retry policy.
- No dashboard, persistent status widget, new keyboard binding, reset/clear command, standalone thinking command, timeout/capacity editor or hot reload.
- No config migration, cancellation redesign, picker component overhaul, provider authentication ownership change or service/client API change.
- No fixes to unrelated hand-edit/session-reload wording or other inventory findings.

## Decisions

### 1. Keep one command tree and reuse both picker flows

Route empty arguments and `status` to the same overview handler and return. Add `llm` to invoke the existing `runChatPickers` flow behind the same TUI guard as `classifier`. Delete the separate `llm-as-jev-classifier` registration; do not leave a hidden compatibility alias. Keep mode-setting persistence unchanged.

Update description, completions and unknown-argument usage together. The command vocabulary is `status`, `llm`, `classifier`, `mode auto`, `mode classifier`, `mode llm`. Migrate existing chat picker integration examples from empty arguments to `llm`; add the new read-only-empty-arguments example instead of deleting cancellation coverage.

**Alternative:** a new settings menu with an Apply button. Rejected: the user chose explicit `llm`/`classifier` entries and existing two-step atomic confirmation already supplies the required behavior. `model` was considered as a subcommand; the user selected `llm` for symmetry with `classifier`.

### 2. Assemble status from existing availability, not a second native probe

Once the service is bound, use one `service.availability()` result for an overview. Combine it with the current effective config and `configFilePath()` in the command integration layer. Use that snapshot to format both model rows, the mode suffix and warning eligibility. Replace the redundant native-only UI discovery path rather than independently discovering candidates twice. Keep presentation helpers in `src/ui.ts` pure, with no registry/auth/file access.

A truthy usable native reference takes precedence in `auto`; only when it is absent can a usable LLM reference supply `Auto(llm)`. No usable reference yields `Auto(None)`. Forced modes keep their own label and warn if their required slot lacks a usable reference. A configured reference is retained even when unavailable; missing `classifierModel` is presented as default Jev rather than as an unset slot. If the service is not bound yet, report runtime-not-ready rather than inventing a successful route.

**Alternative:** infer LLM usability solely from `config.model`, as the current formatter does. Rejected: a catalog-missing or uncredentialed reference would incorrectly imply usable fallback. Extending the service API or adding credential resolution in the UI is also unnecessary: its current availability method already owns those checks.

This is a best-effort configuration/readiness snapshot, not the identity of an in-flight or last completed judgment. The UI does not dispatch inference, measure quota or promise future success. Native discovery/credential refresh may still perform the host's ordinary readiness work. In particular, a discovery error can be reported as unavailable by the existing best-effort method while a real request returns that error; this change must not alter request routing to make the presentation a stronger guarantee.

### 3. Use a compact multiline notification, not a custom component

Keep the existing `ctx.ui.notify` surface for the overview in both TUI and non-TUI contexts. Use labeled rows, with the three primary rows first. Preserve thinking and config path as supplementary rows; align spacing for readability without making padding a contract.

Representative available-default output:

```text
LLM-as-Jev

Mode        Auto(classifier)
Classifier  Jev (default: typesafe/jev-1.13)
LLM         None
Thinking    off
Config      <agentDir>/llm-as-jev.json
```

Representative unavailable-default output:

```text
LLM-as-Jev

Mode        Auto(None)
Classifier  Jev (unavailable)
LLM         None
Thinking    off
Config      <agentDir>/llm-as-jev.json
```

Send the overview plus an applicable warning through the existing notification severities. For auto with neither usable candidate, guidance names `/llm-as-jev classifier` and `/llm-as-jev llm`. For a forced mode, guidance names its settings entry and explains that automatic use of the other candidate requires changing mode; it never changes mode itself. Discovery/auth failure details remain bounded and secret-free rather than printing raw exceptions or credentials.

**Alternative:** persist `None`, `Jev`, or `Auto(classifier)` as configuration values. Rejected: these are display values only. Persisted modes stay `auto|classifier|llm`; an omitted native reference retains existing Jev discovery and its provider priority.

### 4. Preserve the existing settings transaction and routing boundaries

The new LLM command delegates to the current two-step flow: no write after the first selection, cancellation at either step leaves file and memory unchanged, final confirmation saves both values and refreshes the emulated provider immediately. The native command still updates only its own slot. Neither picker changes mode or the main-session model/thinking.

The backend selection algorithm and post-dispatch error behavior remain unchanged. An available default Jev is still usable without a config file. Quota exhaustion, billing failures, rate limits, timeouts or malformed results after dispatch do not authorize trying LLM. Update README wording and keep the existing service regressions as evidence of that unchanged boundary.

**Alternative:** turn auto into error-driven failover while changing its label. Rejected: the user asked what current auto means, not for a new fallback policy; failover would change billing, retries and judgment identity beyond this change.

### 5. Validate at the existing command seam

Use the current Node test runner, fake extension UI/registry and isolated settings directory in `test/index.test.ts`, plus formatter tests in `test/ui.test.ts`. No new acceptance framework or live provider calls. Reuse picker/config/service regressions instead of duplicating their implementation-level coverage.

Each implementation slice starts with the relevant changed observable example, proves its expected pre-change failure, then applies the smallest fix. Tests assert meaningful text/commands, absence of settings writes and inference calls, and preserved save/cancel behavior, not exact padding or private helper topology. Existing guarantees that already pass are regression evidence, not new red/green claims.

| Example | Acceptance seam / evidence |
| --- | --- |
| Bare command and `status` display an overview without a picker or write | Command handler with fake UI; inspect notifications, custom-UI requests, config file and inference counters |
| No saved settings, usable default Jev | `Auto(classifier)`, Jev plus resolved reference, `LLM None`, no missing-backend warning, settings file still absent |
| Native unavailable, usable configured LLM | `Auto(llm)` and both slot details |
| Neither candidate usable, including a configured but uncredentialed LLM | `Auto(None)`, `None` versus unavailable distinction, useful warning |
| Forced mode unavailable while other slot works | Forced label and warning; no claim of automatic switching |
| New `llm` entry confirmed or cancelled | Existing atomicity and next-request/provider-refresh checks through the new entry |
| Alias removed and commands discoverable | Command registry and prefix completion/usage outputs |
| Native request fails after dispatch | Existing service regression: no cross-backend dispatch; not inferred from overview text |

Minimal manual acceptance after implementation: use the fake/safe TUI environment to confirm that the three primary rows are readable, the default command does not steal focus with a picker, and `/llm-as-jev llm` still performs its two-step interaction. Present evidence to the user for acceptance; passing checks do not independently establish product acceptance.

## Risks / Trade-offs

- [Removing the alias and moving the bare-command picker breaks habitual inputs] -> Describe both replacement commands in README, usage and completion. No hidden alias remains.
- [Availability can change after the overview] -> Document snapshot semantics; do not present the suffix as quota validation or change service dispatch decisions.
- [Auth/discovery can be slow or unavailable] -> Reuse the existing bounded availability call and surface unavailable/runtime-not-ready without running a test inference; no new polling loop or network client.
- [Global defaults could accidentally become explicit saved settings] -> Assert that viewing status with no file never creates one; keep all existing config defaults unchanged.
- [Shared picker regression while changing entry points] -> Reuse its existing flows and redirect existing command tests, including cancellation at the thinking step.

## Migration Plan

1. Implement and validate this change only after a separate apply request. Keep all changes limited to the command/UI integration, its tests and user documentation.
2. Update README command examples: bare command inspects, `llm` configures the chat path, `classifier` replaces the removed alias. Explain the availability-only auto suffix and unchanged post-dispatch behavior.
3. No settings rewrite, install activation, package publication or provider migration is required by this change. Those operations require their own authorization.
4. Rollback uses the prior extension version with the same JSON settings; there is no schema or data migration to reverse.
