/**
 * Overflow recognition and question/evidence batch splitting (task 4.3),
 * working on `ClassifierResult` instead of HTTP responses. Only an explicit
 * input-context overflow indication from the backend permits subdivision;
 * rate limits, billing and authentication errors never do.
 */

import { Buffer } from "node:buffer";
import type {
	EvidenceRecord,
	JsonObject,
	JsonValue,
} from "../client/judgment-client.ts";

/**
 * Recognize an explicit context-overflow `ClassifierResult`. Pi classifier
 * backends surface provider rejections as `stopReason: "error"` with an
 * `errorMessage`; recognized shapes mirror the verified reference matcher,
 * with credential/quota/rate-limit text explicitly excluded.
 */
export function isContextOverflow(result: {
	stopReason: string;
	errorMessage?: string;
}): boolean {
	if (result.stopReason !== "error") return false;
	const message = result.errorMessage ?? "";
	if (
		/quota|billing|rate.?limit|per[- ](?:minute|second|hour|day)|balance|authentication|unauthorized|api.?key/i.test(
			message,
		)
	) {
		return false;
	}
	if (
		/context_overflow|context_length_exceeded|context_window_exceeded|max_tokens_exceeded/.test(
			message,
		)
	) {
		return true;
	}
	return [
		/\b(?:maximum|max) context (?:length|window) (?:is |of )?\d[\s\S]*\b(?:exceed|requested|resulted)/i,
		/\b(?:input|request|state|combined|total) (?:token count|tokens|context length)[\s\S]*\bexceeds? (?:the )?(?:maximum|model|allowed|limit)/i,
		/\bcontext (?:length|window|token limit) (?:has been |is )?exceeded\b/i,
		/\bcontext overflow\b/i,
	].some((p) => p.test(message));
}

/** UTF-8 byte sizes of state and question map. */
export function sizeOf(
	state: JsonObject,
	questions: Record<string, unknown>,
	model?: string,
) {
	const each = Object.entries(questions).map(([k, q]) =>
		Buffer.byteLength(JSON.stringify({ [k]: q })),
	);
	return {
		stateBytes:
			Buffer.byteLength(
				JSON.stringify(
					model === undefined ? state : { model, state, questions: {} },
				),
			) - (model === undefined ? 0 : 2),
		questionBytes: Buffer.byteLength(JSON.stringify(questions)),
		longestQuestionBytes: Math.max(0, ...each),
	};
}

/** Split a question-id list into two halves (question-dimension reduction). */
export function splitQuestions(
	questionIds: string[],
): [string[], string[]] | undefined {
	if (questionIds.length < 2) return undefined;
	const mid = Math.ceil(questionIds.length / 2);
	return [questionIds.slice(0, mid), questionIds.slice(mid)];
}

/** A text record is fragmented only while each half stays at least this long. */
export const FRAGMENT_MIN_CHARS = 1000;

/**
 * Internal recovery bounds for one fragment, held in the FRAMED record
 * (outside arbitrary caller metadata). Caller metadata is arbitrary JSON:
 * no key inside it is reserved, trusted or inferred from. Bounds therefore
 * live in an internal wrapper field that never round-trips through caller
 * metadata, so a caller key named like any internal marker is preserved
 * verbatim and cannot spoof recovery bookkeeping.
 */
export interface FragmentBounds {
	/** Original (pre-fragmentation) record id. */
	of: string;
	/** Absolute start/end within the original text. */
	start: number;
	end: number;
	/** Total length of the original text. */
	total: number;
}

/**
 * Internal working representation of one evidence record inside the
 * recovery pipeline: the ORIGINAL caller record (id/text/metadata never
 * mutated) plus, once fragmented, the genuine bounds of this piece.
 * `frameEvidence` lifts caller records into frames; `toModelEvidence`
 * projects frames to the model-facing JSON with bounds OUTSIDE metadata.
 */
export interface FramedEvidence {
	record: EvidenceRecord;
	/** Genuine recovery bounds; undefined for whole (unfragmented) records. */
	bounds?: FragmentBounds;
}

/** Lift caller evidence records into internal frames without copying. */
export function frameEvidence(
	evidence: readonly EvidenceRecord[],
): FramedEvidence[] {
	return evidence.map((record) => ({ record }));
}

/** Project frames to the model-facing JSON array (bounds outside metadata). */
export function toModelEvidence(frames: readonly FramedEvidence[]): JsonValue {
	return frames.map((frame) => ({
		id: frame.record.id,
		text: frame.record.text,
		...(frame.record.metadata !== undefined
			? { metadata: frame.record.metadata }
			: {}),
		...(frame.bounds !== undefined
			? { fragmentBounds: { ...frame.bounds } }
			: {}),
	})) as unknown as JsonValue;
}

/** Total text bytes carried by frames (capacity estimation input). */
export function framedEvidenceBytes(frames: readonly FramedEvidence[]): number {
	return frames.reduce((sum, f) => sum + Buffer.byteLength(f.record.text), 0);
}

export function splitPiece(
	piece: FramedEvidence[],
): [FramedEvidence[], FramedEvidence[]] | undefined {
	if (piece.length > 1) {
		const mid = Math.ceil(piece.length / 2);
		return [piece.slice(0, mid), piece.slice(mid)];
	}
	const frame = piece[0];
	if (!frame || frame.record.text.length < 2 * FRAGMENT_MIN_CHARS)
		return undefined;
	const r = frame.record;
	// Genuine original bounds: inherited on recursive splits (frames carry
	// them internally), else the whole original record. NEVER read from
	// caller metadata — any caller key, same-named or not, is data.
	const bounds: FragmentBounds = frame.bounds ?? {
		of: r.id,
		start: 0,
		end: r.text.length,
		total: r.text.length,
	};
	let mid = Math.floor(r.text.length / 2);
	if (/[\uDC00-\uDFFF]/.test(r.text[mid])) mid++; // never split a surrogate pair
	const part = (start: number, end: number): FramedEvidence => ({
		// The caller record is spread verbatim: id gets the bounds-derived
		// fragment suffix, text the slice, metadata UNTOUCHED (no internal
		// field is written into it).
		record: {
			...r,
			id: `${bounds.of}#${bounds.start + start}-${bounds.start + end}`,
			text: r.text.slice(start, end),
		},
		bounds: {
			of: bounds.of,
			start: bounds.start + start,
			end: bounds.start + end,
			total: bounds.total,
		},
	});
	return [[part(0, mid)], [part(mid, r.text.length)]];
}
