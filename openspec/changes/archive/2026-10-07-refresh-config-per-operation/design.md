## Context

See `proposal.md` for motivation and scope. Source inspection at service HEAD `cdd3d795598a192ff0127a9037856073358a3b68` establishes three relevant boundaries:

- `src/index.ts` runs `loadConfig()` at activation. Its service getter returns the session-local `config`, and settings commands update that variable after saving.
- `src/provider.ts` captures a `JudgmentConfig` at provider creation for model listing, delegated authentication and classification. Local picker confirmation re-registers the provider, but another session's save does not enter that path.
- `src/service.ts` reads its injected configuration at admission and again in backend selection/error handling. Making those reads individually fresh would let one operation combine different file versions. `refreshBranch()` also aborts active work and rebuilds branch state, so it is not a configuration-refresh mechanism.

Existing `loadConfig()`/validation and `saveConfig()` already define defaults, unknown-key preservation and atomic patch saves. Existing resumable-review behavior remains owned by the separate `support-resumable-audit-reviews` change; this change only defines the configuration boundary of each public review call.

## Goals / Non-Goals

**Goals:**

- Keep file access at extension/provider operation boundaries and pass snapshots into the existing service/backend logic.
- Preserve service handle identity and existing consumer APIs, cache identities, branch lifecycle and backend-selection rules.
- Make the public Pi provider path—not just direct calls to the provider object—part of acceptance.

**Non-Goals:**

- No background watcher, timer, notification bus, shared answer cache, database or new configuration framework.
- No cancellation/restart of a running judgment because settings changed; no replacement of an open picker after another session saves.
- No new cross-process locking or conflict-free transaction protocol. Atomic file replacement remains the write boundary; overlapping saves retain their existing last-write behavior.
- No Pi-core modifications, credential migration, new file location, backend fallback policy changes or audit delivery/command work.

## Decisions

### 1. Read at operation boundaries, reuse validation

Use a small file-backed snapshot reader at the integration boundary, reusing the existing parsing, normalization and error/default policy. Keep any in-memory configuration as a display/registration snapshot, not an authority that bypasses the next file read. Do not add mtime/TTL shortcuts: a completed edit must be observed even when timestamps are unchanged.

The service engine keeps an injected configuration source for tests and non-filesystem internals. Capture its result once per public operation and pass it explicitly through selection, dispatch, recovery and error reporting. For synchronous native metadata callbacks, use a synchronous read adapter sharing the same validation policy; asynchronous entry points can retain the existing asynchronous loader. Do not duplicate validators or change the existing loader's public contract merely to fit a callback.

Alternative rejected: a watcher or activation-time cache would require new lifecycle/synchronization machinery and would not implement the selected on-demand behavior.

### 2. Define an operation narrowly enough to preserve consistency

| Boundary | Snapshot lifetime |
| --- | --- |
| `judge()` / `review()` | One public call, including discovery, all stages, retries, recovery, diagnostics and persistence |
| `availability()` | One availability call, without inference |
| Bare command / `status` / mode guidance | One command response; displayed configuration and candidate availability share its snapshot |
| Native or LLM settings interaction | Opening the interaction through confirmation/cancellation; a confirmed save separately reads the latest file as its merge base |
| Provider metadata or delegated-auth check | One such invocation, independently fresh |
| Provider classification | One invocation and its existing output-repair retry, regardless of a descriptor obtained earlier |

A call captures whichever complete file contents its admission read observes. A write completed before admission must be visible; a write racing with admission can belong to the next operation. A resumed review is a new public call, not an extension of the previous snapshot. An idle session does no refresh work.

Pass the snapshot rather than a mutable global reference or a dynamically reread getter to internal helpers. In particular, selection must not take the mode from one read and the model from another, and error reporting must not read a later model reference. Status must not combine freshly read rows with availability from a separately admitted configuration. Internal snapshot-aware helpers can support this without expanding the consumer-facing service interface.

Alternative rejected: per-stage or per-helper reads would change a review halfway through and undermine identity-qualified reuse.

### 3. Preserve work and identity; do not simulate a reload

Configuration refresh must not call `refreshBranch()`, recreate the public service, or abort its active controllers. Freeze the selected backend/model object, effective thinking and applicable timeout/capacity settings for each admitted call. Retain existing caller-option precedence, structured error behavior and lifecycle cancellation.

Existing cache and review-checkpoint keys remain the authority for reuse. Read current settings before selecting a reusable identity, so changing the model or effective thinking cannot join or restore incompatible work. A reread yielding the same identity is not a reason to flush valid results or spend another provider request.

Alternative rejected: recreating the service on every observed edit would cancel unrelated work, lose branch-local state and break retained handles.

### 4. Treat provider freshness as a public-host integration gate

Replace registration-time configuration capture with operation-time snapshots in the provider callbacks. Model metadata derives from the current configured chat model; classification ignores a retained emulated descriptor as a source of configuration and reports the actual admitted chat target. Missing/removed targets produce structured errors, never fallback to the descriptor's old target. Standalone auth/metadata operations take their own snapshots; classification does not rely on an earlier auth probe's configuration staying unchanged.

Before production integration, use one bounded native-host test to verify the supported Pi model-list, availability and dispatch paths on target Pi `1.0.4-xz.265.1.g02d10232`, recording the executable/build identity. Development-SDK-only results are not sufficient; if the target is unavailable, report that blocker rather than silently substituting another runtime. Determine whether the host consults provider metadata dynamically or caches it and which public provider mechanism can refresh that catalog on the first query. Reuse the existing public registration facilities only where needed; avoid unconditional re-registration on every read, recursive registry discovery and interference with admitted calls.

**Gate established (2026-10-06):** the corrected bounded fixture `/var/tmp/jev-refresh-gate-b1/` and parent reproduction `/var/tmp/jev-refresh-parent-XbvcN1/` show that public listing consults dynamic metadata and delegated authentication without a stored emulation credential, and a retained descriptor reaches the registered provider. One registration suffices: the provider must read current configuration and return the actual admitted target's identity. The target binary and eight assertions are recorded in the task 1.1 receipt. This is host-seam evidence only; production integration and cross-session acceptance remain required. If subsequent integration exposes unsupported behavior, stop with that evidence rather than narrowing the contract.

Alternative rejected: only refreshing after `judge()` would leave metadata-first consumers and other plugins stale.

### 5. Keep settings interaction and failure semantics small

Refresh before status rendering, mode guidance and picker preselection. A dialog uses its opening snapshot for presentation, but confirmation sends only its chosen fields to the existing `saveConfig()` patch path. Do not serialize the opening snapshot back to disk. Cancellation writes nothing and never restores old settings over another session's save. A failed save must not publish its tentative selection as effective.

Missing/invalid/unreadable files use the existing defaults; do not retain the last valid selection as an undocumented fallback. Keep diagnostic emission once per session while continuing to read on every new operation, so repair recovers without reload. Unknown keys survive valid patch saves. Explicit unavailable models remain explicit, including after external edits.

Alternative rejected: merging from the dialog's old configuration loses unrelated completed saves; adding cross-process locks is unnecessary for the requested propagation semantics.

## Risks / Trade-offs

- **Host catalog caching or retained-descriptor routing may block first-query freshness** → Run the public-host gate first, preserve its evidence and stop on unsupported behavior rather than claiming callback tests prove integration.
- **Small synchronous metadata reads block the event loop briefly** → Keep parsing shared and file reads at metadata boundaries only; do not introduce speculative caching that weakens freshness. This design targets the existing small local settings file.
- **Nested operations could reread configuration or recursively rebuild the registry** → Pass captured snapshots into internal helpers; test a single request with barriers around discovery and dispatch, plus metadata/auth re-entry.
- **Concurrent operations could overwrite a shared config variable** → Hold request-local snapshots through completion and test overlapping X/Y requests, including review stages and error paths.
- **Hand edits can temporarily produce invalid JSON** → Apply the established all-default policy and recover on the next valid read. Built-in saves remain atomic.
- **Truly overlapping saves can lose a concurrent writer's fields** → Preserve existing semantics and document this limit; the guarantee for an old picker is preservation of unrelated changes completed before its confirmation read, not transactional multi-writer merging.

## Migration Plan

No settings migration or service protocol bump is required. Implement and validate entirely in the service repository. Updating the plugin introduces the behavior for that loaded code; subsequent configuration edits require no restart or reload in other sessions already running the updated plugin.

Acceptance uses task-owned temporary agent directories and fake/local backends, not real credentials or paid requests. Keep both service runtimes alive across a save; retain the receiving handle/descriptor and prove each entry point works without a priming call. Include a distinct-agent-directory negative case and unchanged auth/model/trust files. Extend the existing tests rather than creating another verification framework.

Run the focused configuration, integration, provider and service/review tests, then the repository's `npm run check`, and strict validation of this change. Document the operation boundary and multi-writer limit in `README.md`. Rolling back code requires no file conversion; older loaded versions revert to their previous session-local refresh behavior. This plan does not authorize publishing or deployment.
