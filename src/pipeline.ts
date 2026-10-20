/**
 * Overflow recognition on `ClassifierResult`. Only an explicit input-context
 * overflow indication from the backend marks `contextOverflow`; rate limits,
 * billing and authentication errors never do. Version two performs no
 * service-side subdivision: consumers own packing and reduction.
 */

import { Buffer } from "node:buffer";
import type { JsonObject } from "../client/judgment-client.ts";

/**
 * Recognize SDK status prefixes: OpenAI/OpenRouter `NNN[: ]<body>` and
 * native `System One API error (NNN): <body>` (plus other fixed SDK labels).
 * This is string-format recognition, not independent transport attestation;
 * parenthesized digits elsewhere in a body are never a status.
 */
function httpStatus(message: string): number | undefined {
	// classifyWithModel adds this fixed local prefix when the registry throws.
	message = message.replace(/^Native classification failed: /, "");
	const match =
		/^\s*(\d{3})(?::|\s)/.exec(message) ??
		/^(?:System One API|Cloudflare Workers AI|llama\.cpp|OpenAI API|Azure OpenAI API) error \((\d{3})\):/.exec(
			message,
		);
	const status = match ? Number(match[1]) : undefined;
	return status !== undefined && status >= 100 && status < 600
		? status
		: undefined;
}

/**
 * Statuses on which a context-overflow body text is trustworthy. Request
 * rejections (400/413) and timeouts (408) may carry a real size verdict;
 * authentication, quota, validation and server failures never authorize
 * subdivision even when their body mentions `context_length_exceeded`.
 */
const OVERFLOW_STATUSES: ReadonlySet<number> = new Set([400, 408, 413]);

export function isContextOverflow(result: {
	stopReason: string;
	errorMessage?: string;
}): boolean {
	if (result.stopReason !== "error") return false;
	const message = result.errorMessage ?? "";
	const status = httpStatus(message);
	if (status !== undefined && !OVERFLOW_STATUSES.has(status)) return false;
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

/**
 * Untrusted provider/adapter text never passes through the public boundary.
 * Only a recognized SDK status prefix contributes to a bounded category;
 * callers retain known-key redaction and render local validation separately.
 */
export function publicErrorMessage(message: string): string {
	const status = httpStatus(message);
	return status !== undefined
		? `provider request failed (HTTP ${status})`
		: "provider or transport failure";
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
