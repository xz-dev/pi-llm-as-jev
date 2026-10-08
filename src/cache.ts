/**
 * Exact-match raw-judgment cache (design D6, task 4.2). One RAW validated
 * answer per canonical identity: identity version, backend, model, effective
 * thinking level, fixed state, ordered framed evidence (records + genuine
 * bounds), advisory preceding opinions, question id, complete question
 * definition AND the dispatched stage coverage/finality. Thresholds are NOT
 * part of identity: each caller's policy is reapplied independently on hits,
 * joins and restores. In-flight joins and forced-review tokens are
 * generation-scoped: a late result from an abandoned generation never enters
 * the current one. Identity is digested with SHA-256 over canonical JSON
 * (sorted keys, ordered arrays, own special keys preserved) — see
 * `capacity.digest` (F6).
 */

import type {
	ClassifierAnswer,
	JsonObject,
	JudgeRequest,
} from "../client/judgment-client.ts";
import { digest } from "./capacity.js";
import type { FramedEvidence } from "./pipeline.js";

/**
 * Identity schema version. Version 3 invalidates version-2 judgments that
 * failed/aborted joins could publish before outcome-aware admission (B2).
 * Canonical SHA-256 and coverage identity remain unchanged; older records
 * are ignored, never rewritten or relabeled.
 */
export const JUDGMENT_VERSION = 3;

/**
 * The evidence slice a judgment identity covers: framed records with their
 * GENUINE internal bounds (outside caller metadata), so different fragment
 * histories cannot collide.
 */
export type StageEvidence = FramedEvidence[];

export interface JudgmentIdentity {
	/** Review identity scope; absent for the legacy final-only API. */
	scope?: string;
	backend: "classifier" | "llm";
	/** Frozen `provider/modelid` for dispatch, cache and ledger. */
	model: string;
	thinkingLevel: string;
	/** Fixed state as sent (post-redaction, post fragment-expansion). */
	state: JsonObject;
	/** Ordered framed evidence for this stage (records + internal bounds). */
	evidence: StageEvidence;
	/** Advisory preceding opinions included in this stage's context. */
	previousAnswers: Record<string, ClassifierAnswer>;
	questionId: string;
	question: JudgeRequest["questions"][string];
	/**
	 * Dispatched stage coverage (F6): whether this judgment was produced by
	 * the ROOT-complete stage over its evidence batch (`true`) or an
	 * intermediate subdivision stage (`false`). A partial-stage judgment
	 * must never be reused as full coverage for a root request.
	 */
	isFinalStage: boolean;
}

/** Canonical identity digest (SHA-256 over canonical JSON). */
export function judgmentKey(identity: JudgmentIdentity): string {
	return digest({
		v: JUDGMENT_VERSION,
		...(identity.scope !== undefined ? { scope: identity.scope } : {}),
		backend: identity.backend,
		model: identity.model,
		thinkingLevel: identity.thinkingLevel,
		state: identity.state,
		evidence: identity.evidence,
		previousAnswers: identity.previousAnswers,
		key: identity.questionId,
		question: identity.question,
		final: identity.isFinalStage,
	});
}

export interface CacheEntry {
	/** RAW validated answer; callers apply their own thresholds. */
	answer: ClassifierAnswer;
	/** Identity digest for ledger restore matching. */
	key: string;
}

export interface PendingJudgment {
	stopReason: "stop" | "error" | "aborted";
	answer?: ClassifierAnswer;
	errorMessage?: string;
	contextOverflow?: boolean;
	/**
	 * Owner's wait policy for join compatibility (F6 timeout slice): an LLM
	 * pending entry records its inactivity window so a caller with a
	 * different window never silently inherits an incompatible owner's
	 * clock. Absent means join-compatible for any caller (native shares one
	 * absolute deadline; the joiner remains bounded by its own).
	 */
	waitTag?: string;
}

export interface RawJudgmentCache {
	answers: Map<string, ClassifierAnswer>;
	/**
	 * In-flight work per identity. A fresh-review caller never joins
	 * ordinary pending work: fresh tokens track their OWN pending entries
	 * (keyed `token\u0000identity`) so a forced review always dispatches a
	 * fresh evaluation while same-token retries still reuse it (F6).
	 */
	pending: Map<string, Promise<PendingJudgment>>;
	/** Owner's wait policy per pending key (LLM inactivity window); absent
	 *  means joinable by any caller. */
	pendingWait: Map<string, string>;
	/** Exact envelopes rejected for context size; never resent unchanged. */
	rejected: Set<string>;
	/** Evaluation keys answered per forced-review token. */
	fresh: Map<string, Set<string>>;
	/** Session generation this cache belongs to; late writes from others are dropped. */
	generation: number;
}

export const newCache = (generation: number): RawJudgmentCache => ({
	answers: new Map(),
	pending: new Map(),
	pendingWait: new Map(),
	rejected: new Set(),
	fresh: new Map(),
	generation,
});

/**
 * Pending-map key for one identity under an optional fresh token. Ordinary
 * (non-fresh) work is keyed by the bare identity digest; fresh work is keyed
 * by `token\u0000identity` so the two pools never mix (F6).
 */
export function freshTokenKey(token: string): string {
	// Tokens are private identities: persist their digest, never caller text.
	return digest({ fresh: token });
}

export function pendingKey(
	cache: RawJudgmentCache,
	token: string | undefined,
	key: string,
): string {
	void cache;
	return token !== undefined ? `${freshTokenKey(token)}:${key}` : key;
}

/**
 * In-flight join promise bookkeeping. Returns a cleanup that removes the
 * entry only if it is still this promise (a generation switch may have
 * replaced the cache).
 */
export function trackPending(
	cache: RawJudgmentCache,
	key: string,
	promise: Promise<PendingJudgment>,
	waitTag?: string,
): void {
	cache.pending.set(key, promise);
	if (waitTag !== undefined) cache.pendingWait.set(key, waitTag);
	const cleanup = () => {
		if (cache.pending.get(key) === promise) {
			cache.pending.delete(key);
			cache.pendingWait.delete(key);
		}
	};
	void promise.then(cleanup, cleanup);
}

/**
 * Settle failed pending ownership (F7): after a dispatched batch reports
 * overflow/failure, its per-question pending entries must stop offering
 * joins before recursive subdivision runs — children must never join their
 * own failed parent promises.
 */
export function settlePending(
	cache: RawJudgmentCache,
	keys: readonly string[],
): void {
	for (const key of keys) {
		// The pending entry (if still present) belongs to the failed batch;
		// delete it so subdivided children dispatch instead of joining it.
		cache.pending.delete(key);
		cache.pendingWait.delete(key);
	}
}

/** Record a fresh-token answer set membership (forced review). */
export function noteFresh(
	cache: RawJudgmentCache,
	token: string,
	key: string,
): void {
	const tokenKey = freshTokenKey(token);
	let set = cache.fresh.get(tokenKey);
	if (!set) {
		set = new Set();
		cache.fresh.set(tokenKey, set);
	}
	set.add(key);
}

/** Answers eligible under a forced-review token: only this token's results. */
export function freshEligible(
	cache: RawJudgmentCache,
	token: string | undefined,
	key: string,
): boolean {
	if (token === undefined) return true;
	return cache.fresh.get(freshTokenKey(token))?.has(key) ?? false;
}
