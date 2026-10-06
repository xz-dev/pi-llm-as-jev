## Why

The main `/llm-as-jev` command opens the LLM picker even when users only want to inspect the active mode and the two model slots. A duplicate classifier command and an opaque status line make the default Jev path, an unconfigured LLM, and an unavailable configured model harder to distinguish.

## What Changes

- **BREAKING**: make `/llm-as-jev` a read-only overview, identical to `/llm-as-jev status`, rather than automatically opening a picker.
- Add `/llm-as-jev llm` as the explicit entry to the existing chat-model → thinking-level flow. Preserve its atomic save, cancellation and immediate-effect behavior.
- **BREAKING**: remove `/llm-as-jev-classifier`; keep `/llm-as-jev classifier` as the sole native selection entry.
- Show separate `Mode`, `Classifier` and `LLM` rows. Keep default mode `auto` and implicit Jev discovery. Display `Auto(classifier)` or `Auto(llm)` using the complete backend names, and `Auto(None)` when neither candidate is usable.
- Show the default classifier as `Jev`, including the actual discovered reference when available. Show an unconfigured LLM as `None`; retain configured references and label them unavailable when necessary.
- Warn when the configured mode has no usable backend, with a relevant configuration command. Do not warn merely because no settings file exists if default Jev is available.
- Align command description, argument completion, usage hints and README examples with the new entries. Preserve thinking-level and configuration-path details in the overview.
- Keep routing unchanged: `auto` falls back only during initial availability selection, never because of quota, billing, rate-limit or other post-dispatch errors. The overview is an availability snapshot, not a quota check or an inference request.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `judge-model-settings`: read-only default overview, explicit LLM/native settings entries, complete automatic-mode labels and unavailable-backend guidance.

## Impact

- Expected implementation surfaces: command registration and status assembly in `src/index.ts`, presentation helpers in `src/ui.ts`, existing command/UI tests, and `README.md`.
- Reuse the existing picker and service availability interfaces; no new dependency, tool, global shortcut or settings framework.
- No configuration migration or new persisted fields. Backend selection, request contracts, credential ownership, cache/ledger behavior and existing picker semantics remain unchanged.
- Existing users opening the LLM picker with the bare command must use `/llm-as-jev llm`; users of the removed alias must use `/llm-as-jev classifier`.
