# Acceptance record

Verified on 2026-10-04. All 30 implementation and acceptance tasks are complete.

## Automated and independent verification

- Exact `TMPDIR=/var/tmp npm run check`: 287 tests passed, typecheck and build passed; 53 non-blocking lint warnings remain.
- Strict OpenSpec validation passed.
- Independent read-only candidate review: **Approved with explicit residual risk**. Tracked F1–F12, R1–R4 and B1/B2 findings closed. The reviewer ran the 287-test suite twice, 122 focused tests, and 105 deadline/rejection cases with no unhandled rejection or late dispatch/ledger publication.
- Real Pi offline host/TUI verification: ten proof records, including same-process model discovery and actual registered classifier dispatch after chat-model confirmation, without reload; native-only selection and picker cancellation checks passed.

## User-authorized real inference

Only synthetic weather/temperature questions were sent. These live checks used the same implementation as the reviewed candidate, isolated settings and normal Pi authentication/transport, with no fixture provider or main-session model prompt.

| Check | Observed result |
| --- | --- |
| Auto fallback with no usable native candidate | Independently selected `openai-api-extension/xl/claude-opus-5-5`, thinking `low`; three actual calls returned choice `sunny`, bool `true`, score `3`, all through `backend: llm`. |
| LLM numeric-policy exclusion | A `rainy >= 0.99` named-choice rule did not filter the discrete `sunny` answer. Compatibility numbers were not treated as native confidence. |
| Auto native selection | `typesafe/jev-latest` answered all three questions in one actual classification call, with zero LLM calls. |
| Genuine native confidence filtering | Bool probability was **0.98**; `minConfidence: 0.99` removed that answer and listed it in `dropped`. |
| Genuine named-choice filtering | Reported `rainy` probability was **0**; a `>= 0.99` gate removed the choice answer despite overall confidence 1. |
| Raw-cache policy reapplication | Each stricter policy call had three cache hits and zero new dispatches. |

Successful calls reported 2,679 LLM tokens and 575 native tokens. Catalog cost values were zero; actual billed cost was not established. Native numbers are reported adapter fields, not evidence of calibrated real-world probability or broad accuracy.

The initially selected Haiku route returned HTTP 400 `model_not_found` on its first actual call. The service returned a structured error with empty answers and did not silently switch models. The user explicitly authorized the subsequent Opus run; no successful Haiku inference is claimed.

## Boundaries and remaining limitations

- No implementation change was needed for the successful live checks.
- Global credentials, settings and model catalogs were unchanged; temporary credential copies were cleared and owned test processes stopped.
- Consumer migrations, package releases and production configuration changes remain separate work.
- Existing 53 lint warnings, soft capacity estimates and the empty `updateConfig()` hook remain non-blocking review notes.
- Judgment identity v3 deliberately invalidates v2 cache identities without rewriting session data. Current normal/fresh restoration is tested.
- Timing checks and synthetic live examples are bounded evidence, not exhaustive provider or scheduler guarantees. Independent candidate approval is distinct from final human acceptance.

Local raw evidence was retained outside this repository; no credentials, private session logs or machine-specific evidence paths are required to read this record.
