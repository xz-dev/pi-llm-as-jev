/**
 * Session-branch ledger (task 6.1, design D6). Non-context persistence for
 * RAW validated judgments, exact rejection hashes, stage coverage
 * identifiers and compact capacity/usage diagnostics via the two-argument
 * `pi.appendEntry(customType, data)` API. Never request bodies, state or
 * evidence text, provider replies, credentials or reasoning transcripts.
 * Restored only from the active branch on lifecycle navigation.
 */

import type { ClassifierAnswer } from "../client/judgment-client.ts";

export const LEDGER_TYPE = "llm-as-jev-ledger";

export type LedgerRecord =
	| {
			kind: "judgment";
			/** Identity digest → RAW validated answer. */
			key: string;
			answer: ClassifierAnswer;
			backend: "classifier" | "llm";
			/** Frozen model identity for dispatch/cache/ledger. */
			model: string;
			thinkingLevel: string;
			/** SHA-256 fresh-review token identity; never the caller's token text. */
			freshToken?: string;
	  }
	/** An exact envelope rejected for context size: never resent unchanged. */
	| { kind: "rejected"; envelope: string }
	/** Compact channel capacity observation (sizes/tokens only, no bodies). */
	| {
			kind: "capacity";
			channel: string;
			attempt: {
				outcome: "answered" | "overflow";
				inputTokens?: number;
				stateBytes: number;
				questionBytes: number;
				longestQuestionBytes?: number;
			};
	  }
	/** Per-request accounting: counts only, never content. */
	| {
			kind: "diag";
			backend: "classifier" | "llm";
			model: string;
			hits: number;
			joined: number;
			sent: number;
			inputTokens: number;
			outputTokens: number;
			outcome: "stop" | "error" | "aborted";
	  };

/** One restored capacity observation (validated shape). */
export interface CapacityObservation {
	outcome: string;
	inputTokens?: number;
	stateBytes: number;
	questionBytes: number;
	longestQuestionBytes?: number;
}

const object = (v: unknown): Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};

/** Own entries on the active branch. */
export function isOwnBookkeeping(raw: unknown): boolean {
	const e = object(raw);
	return e.type === "custom" && e.customType === LEDGER_TYPE;
}

const validAnswer = (v: unknown): v is ClassifierAnswer => {
	const a = object(v);
	if (a.type === "choice") {
		return (
			typeof a.choice === "string" &&
			typeof a.confidence === "number" &&
			Number.isFinite(a.confidence)
		);
	}
	if (a.type === "score") {
		return typeof a.score === "number" && typeof a.confidence === "number";
	}
	if (a.type === "bool") {
		return typeof a.probability === "number";
	}
	return false;
};

/** Append one record; returns false when the write failed or is not durable. */
export function writeLedger(
	append: ((type: string, data: LedgerRecord) => void) | undefined,
	record: LedgerRecord,
): boolean {
	if (!append) return false;
	try {
		append(LEDGER_TYPE, record);
		return true;
	} catch {
		return false;
	}
}

export interface RestoredLedger {
	answers: Map<string, ClassifierAnswer>;
	fresh: Map<string, Set<string>>;
	rejected: Set<string>;
	capacity: Map<string, CapacityObservation[]>;
}

/**
 * Replay compatible records from the ACTIVE BRANCH ONLY, in branch order. A
 * judgment record restores the RAW answer (thresholds are reapplied by each
 * caller, never stored as acceptance). Non-own and malformed entries are
 * ignored, never fatal.
 */
export function restoreLedger(branch: Iterable<unknown>): RestoredLedger {
	const out: RestoredLedger = {
		answers: new Map(),
		fresh: new Map(),
		rejected: new Set(),
		capacity: new Map(),
	};
	for (const raw of branch) {
		if (!isOwnBookkeeping(raw)) continue;
		const d = object(object(raw).data);
		if (d.kind === "judgment") {
			// Legacy prototype `jev`-tagged judgments are STALE under the new
			// `classifier` identity: never relabeled, never restored as matches.
			// Their keys were digested under the old backend tag anyway, so they
			// cannot legitimately hit the new identity — reject the record outright
			// instead of trusting a possibly-mismatched key.
			if (d.backend !== "classifier" && d.backend !== "llm") {
				continue;
			}
			if (typeof d.key === "string" && validAnswer(d.answer)) {
				out.answers.set(d.key, d.answer);
				if (
					typeof d.freshToken === "string" &&
					/^[a-f0-9]{64}$/.test(d.freshToken)
				) {
					out.answers.set(`${d.freshToken}:${d.key}`, d.answer);
					const keys = out.fresh.get(d.freshToken) ?? new Set<string>();
					keys.add(d.key);
					out.fresh.set(d.freshToken, keys);
				}
			}
		} else if (d.kind === "rejected") {
			if (typeof d.envelope === "string") out.rejected.add(d.envelope);
		} else if (d.kind === "capacity") {
			const attempt = object(d.attempt);
			if (
				typeof d.channel === "string" &&
				typeof attempt.stateBytes === "number" &&
				typeof attempt.questionBytes === "number"
			) {
				const list = out.capacity.get(d.channel) ?? [];
				list.push({
					outcome: String(attempt.outcome),
					inputTokens:
						typeof attempt.inputTokens === "number"
							? attempt.inputTokens
							: undefined,
					stateBytes: attempt.stateBytes,
					questionBytes: attempt.questionBytes,
					longestQuestionBytes:
						typeof attempt.longestQuestionBytes === "number"
							? attempt.longestQuestionBytes
							: undefined,
				});
				out.capacity.set(d.channel, list);
			}
		}
	}
	return out;
}
