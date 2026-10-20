/**
 * Copy-able, self-contained client for the pi-llm-as-jev judgment service.
 *
 * This file is the CANONICAL type source for the public contract (D1):
 * `src/contract.ts` re-exports these types, it does not duplicate them.
 * No dependency on the extension package at runtime. Consumers may copy this
 * file into their own extension instead of importing from `pi-llm-as-jev`.
 *
 * VERSION TWO (stateless): the service exposes only `judge()`,
 * `availability()` and `describeSelection()`. Review, checkpoints, stage
 * projections, result caching/in-flight joins, persistent ledgers, capacity
 * learning and transport-attempt observations are REMOVED. Consumers pack
 * every necessary fact into `state` and own their own business progress.
 */
/** Global registry key published by the extension at startup. */
const SERVICE_KEY = Symbol.for("pi-llm-as-jev:service");
/**
 * Look up the judgment service at call time. Returns `undefined` when the
 * `pi-llm-as-jev` extension is not installed/running, and may return an
 * incompatible (version-one or foreign) handle: check `version === 2`
 * before calling `judge()`.
 */
export function getJudgmentService() {
    return globalThis[SERVICE_KEY];
}
