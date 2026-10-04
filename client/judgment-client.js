/**
 * Copy-able, self-contained client for the pi-llm-as-jev judgment service.
 *
 * This file is the CANONICAL type source for the public contract (D1):
 * `src/contract.ts` re-exports these types, it does not duplicate them.
 * No dependency on the extension package at runtime. Consumers may copy this
 * file into their own extension instead of importing from `pi-llm-as-jev`.
 */
/** Global registry key published by the extension at startup. */
const SERVICE_KEY = Symbol.for("pi-llm-as-jev:service");
/**
 * Look up the judgment service at call time. Returns `undefined` when the
 * `pi-llm-as-jev` extension is not installed/running.
 */
export function getJudgmentService() {
    return globalThis[SERVICE_KEY];
}
