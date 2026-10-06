## Why

The extension loads `llm-as-jev.json` at activation and keeps session-local configuration, while its emulated provider captures the configuration supplied at registration. Saving settings in one Pi session therefore leaves other already-running sessions using old settings until they are individually reconfigured or reloaded.

## What Changes

- Read the existing global configuration file at each configuration-dependent operation boundary: `judge()`, `review()`, `availability()`, settings/status commands, and emulated-provider classification, availability and model-metadata operations.
- Capture one configuration snapshot for each operation. Backend selection, request stages, recovery and result identity use that snapshot; changes affect the next operation, not work already in flight.
- Make existing sessions sharing the same Pi agent directory observe completed configuration writes without repeating commands, restarting Pi, reloading extensions or replacing the public service handle.
- Make status and picker preselection current, keep status read-only, and retain patch-based atomic settings saves so stale dialogs do not overwrite unrelated settings saved before confirmation.
- Preserve existing defaults and once-per-session diagnostics for invalid/unreadable settings, recover automatically on a later valid read, and retain explicit unavailable model selections and independent native/LLM settings.
- Refresh the emulated provider's model identity, metadata, availability and dispatch from current settings without exposing chat models or silently using a stale descriptor's former chat target.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `judge-model-settings`: Per-operation file authority, cross-session settings/status/picker freshness, failure recovery and safe confirmation/cancellation semantics.
- `judgment-service`: Fresh operation-scoped configuration snapshots across judgments, resumable reviews and availability, preserving in-flight work and identity-qualified reuse.
- `llm-classifier-backend`: Current runtime configuration for the native emulated provider's metadata, availability and classification entry points, including previously obtained provider/model references.

## Impact

- Expected implementation areas: `src/config.ts`, `src/index.ts`, `src/service.ts`, `src/provider.ts`, their existing tests, and configuration guidance in `README.md`.
- Keep the public service lookup, `version: 1`, `reviewVersion: 1`, request/result shapes, configuration location and accepted settings compatible. Consumers need no new refresh call.
- Use the existing Pi provider interfaces, configuration validation and atomic-save mechanism. No new dependency, background watcher/poller, database, cross-session answer cache or credential migration is required.
- Cross-session propagation applies to sessions sharing the same agent-directory configuration file. Independent Pi agent directories stay isolated. Simultaneous-writer conflict resolution is not added.
- This change belongs exclusively to `pi-llm-as-jev`. Audit package delivery, unpinned installation/update policy, disabled-audit provenance and stable audit command registration remain separate work in `pi-jev-todo-audit`.
