/**
 * Per-channel request capacity (design D7), ported from the verified
 * pi-jev-todo-audit predictor. A channel is one backend + model identity.
 * The estimate is bytes × the latest usable tokens/byte observed on that
 * channel (a conservative prior until usage exists), checked against the
 * backend model's declared context limit, plus actually rejected sizes.
 * It is an estimate, never a fit guarantee: provider admission stays
 * authoritative for irreducible units.
 */

import { createHash } from "node:crypto";

/**
 * Collision-resistant digest (F6): SHA-256 over a canonical serialization of
 * a JSON value. Canonical form sorts object keys (recursively), keeps array
 * order, and records every legal own key — including special ids like
 * `__proto__` — via own-property walks, so reordered-but-equivalent JSON
 * digests identically while distinct values cannot collide practically.
 */
export function digest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Canonical JSON text: sorted object keys, ordered arrays, own keys only. */
function canonicalJson(value: unknown): string {
	const parts: string[] = [];
	const walk = (v: unknown): void => {
		if (v === null || typeof v !== "object") {
			parts.push(JSON.stringify(v) ?? "null");
			return;
		}
		if (Array.isArray(v)) {
			parts.push("[");
			for (let i = 0; i < v.length; i++) {
				if (i > 0) parts.push(",");
				walk(v[i]);
			}
			parts.push("]");
			return;
		}
		parts.push("{");
		const entries = Object.entries(v).sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		);
		for (let i = 0; i < entries.length; i++) {
			if (i > 0) parts.push(",");
			parts.push(JSON.stringify(entries[i][0]));
			parts.push(":");
			walk(entries[i][1]);
		}
		parts.push("}");
	};
	walk(value);
	return parts.join("");
}

/** Envelope dimensions in limited terms. */
export interface EnvelopeSize {
	stateBytes: number;
	questionBytes: number;
	longestQuestionBytes: number;
}

/** Channel is backend + model (`provider/modelid`). */
export const channelKey = (
	backend: "classifier" | "llm",
	model: string,
): string => digest({ backend, model });

/** Live smoke densest observation was 1/1.766 tokens per byte; slightly denser until usage exists. */
export const PRIOR_TOKENS_PER_BYTE = 1 / 1.75;

/**
 * Envelope overhead reserved for an LLM tool-calling request (system prompt,
 * tool schema, output budget) when estimating LLM envelopes; native
 * classifier requests have no tool scaffolding.
 */
export const LLM_ENVELOPE_OVERHEAD_BYTES = 2048;

export interface CapacityProfile {
	/** Latest usable input tokens per sent byte; undefined until usage reported. */
	tokensPerByte?: number;
	/** Minimal set of actually rejected sizes (dominated entries pruned). */
	rejections: EnvelopeSize[];
}

export const newCapacityProfile = (): CapacityProfile => ({ rejections: [] });

export interface CapacityLimits {
	/** Declared model context window in tokens. */
	contextWindow: number;
}

const longest = (s: EnvelopeSize) => s.stateBytes + s.longestQuestionBytes;
const total = (s: EnvelopeSize) => s.stateBytes + s.questionBytes;
/** `a` is at least as large as `b` in both limited dimensions. */
const covers = (a: EnvelopeSize, b: EnvelopeSize) =>
	longest(a) >= longest(b) && total(a) >= total(b);

/** The dimension recovery must reduce. */
export type CapacityConstraint = "state" | "request" | "rejection";

export function overflowConstraint(
	p: CapacityProfile,
	s: EnvelopeSize,
	limits?: CapacityLimits,
): CapacityConstraint | undefined {
	const ratio = p.tokensPerByte ?? PRIOR_TOKENS_PER_BYTE;
	if (limits && longest(s) * ratio > limits.contextWindow) return "state";
	if (limits && total(s) * ratio > limits.contextWindow) return "request";
	if (p.rejections.some((r) => covers(s, r))) return "rejection";
}

export function predictOverflow(
	p: CapacityProfile,
	s: EnvelopeSize,
	limits?: CapacityLimits,
): boolean {
	return overflowConstraint(p, s, limits) !== undefined;
}

const size = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Learn from one real backend attempt (answered usage or explicit overflow). */
export function observe(
	p: CapacityProfile,
	a: {
		outcome?: unknown;
		inputTokens?: unknown;
		stateBytes?: unknown;
		questionBytes?: unknown;
		longestQuestionBytes?: unknown;
	},
): void {
	if (!size(a.stateBytes) || !size(a.questionBytes)) return;
	if (a.outcome === "answered") {
		if (
			size(a.inputTokens) &&
			a.inputTokens > 0 &&
			a.stateBytes + a.questionBytes > 0
		) {
			p.tokensPerByte = a.inputTokens / (a.stateBytes + a.questionBytes);
		}
		if (size(a.longestQuestionBytes)) {
			const admitted = {
				stateBytes: a.stateBytes,
				questionBytes: a.questionBytes,
				longestQuestionBytes: a.longestQuestionBytes,
			};
			p.rejections = p.rejections.filter((r) => !covers(admitted, r));
		}
	} else if (a.outcome === "overflow" && size(a.longestQuestionBytes)) {
		const s: EnvelopeSize = {
			stateBytes: a.stateBytes,
			questionBytes: a.questionBytes,
			longestQuestionBytes: a.longestQuestionBytes,
		};
		if (p.rejections.some((r) => covers(s, r))) return;
		p.rejections = [...p.rejections.filter((r) => !covers(r, s)), s];
	}
}
