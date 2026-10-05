/** Observe Pi-owned HTTP/SSE streams. Never select models, resolve auth, or build provider requests. */
import type { ReviewAttemptObservation } from "../client/judgment-client.ts";
import type { LlmRegistry } from "./backend-llm.js";

const object = (v: unknown): Record<string, unknown> =>
	v !== null && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
const number = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v) && v >= 0;

function contextError(raw: unknown, api: string): boolean {
	const error = object(raw);
	const code = error.code ?? error.type;
	if (
		[
			"context_length_exceeded",
			"context_window_exceeded",
			"max_tokens_exceeded",
		].includes(String(code))
	)
		return true;
	// Anthropic's documented context rejection has no distinct code. Match the
	// typed error's entire numeric message, never arbitrary echoed request text.
	return (
		api === "anthropic-messages" &&
		error.type === "invalid_request_error" &&
		error.code === undefined &&
		typeof error.message === "string" &&
		/^prompt is too long: [\d,]+ tokens > [\d,]+ maximum[.!]?$/i.test(
			error.message,
		)
	);
}

/** Bound error-body inspection; no body is retained, logged or handed to a consumer. */
async function errorMetadata(
	response: Response,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const reader = response.clone().body?.getReader();
	if (!reader) return {};
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", cancel, { once: true });
	let text = "",
		bytes = 0;
	const decoder = new TextDecoder();
	try {
		while (!signal?.aborted) {
			const part = await reader.read();
			if (part.done) return object(JSON.parse(text + decoder.decode()));
			bytes += part.value.byteLength;
			if (bytes > 65536) return {};
			text += decoder.decode(part.value, { stream: true });
		}
	} catch {
		/* Unavailable metering stays unknown. */
	} finally {
		signal?.removeEventListener("abort", cancel);
		cancel();
	}
	return {};
}

export function observeLlmRegistry(
	registry: LlmRegistry,
	owner: {
		operation: string;
		attempts: ReviewAttemptObservation[];
		isOpen(): boolean;
		publish(attempt: ReviewAttemptObservation): void;
		sanitize(text: string): string;
	},
) {
	const fetch = globalThis.fetch;
	let open = true,
		supported = true;
	const startIndex = owner.attempts.length;
	const calls: {
		count: number;
		events: number;
		ambiguous: boolean;
		current?: ReviewAttemptObservation;
	}[] = [];
	const live = () => open && owner.isOpen();
	const publish = (row: ReviewAttemptObservation) => {
		if (live()) owner.publish({ ...row });
	};
	const readUsage = (row: ReviewAttemptObservation, raw: unknown) => {
		const usage = object(raw);
		const input = usage.input_tokens ?? usage.prompt_tokens;
		const output = usage.output_tokens ?? usage.completion_tokens;
		if (number(input)) row.inputTokens = input;
		if (number(output)) row.outputTokens = output;
		if (number(usage.cost)) row.costUsd = usage.cost;
	};
	const wrapped: LlmRegistry = {
		streamSimple(model, context, options) {
			const headerSecrets: string[] = [];
			const call = {
				count: 0,
				events: 0,
				ambiguous: false,
				current: undefined as ReviewAttemptObservation | undefined,
			};
			calls.push(call);
			const observeFetch: typeof globalThis.fetch = async (url, init) => {
				if (!live() || options?.signal?.aborted)
					throw new DOMException("review settled", "AbortError");
				// Provider events carry no fetch id. Overlapping/unsettled sends cannot
				// be correlated honestly; retain starts rather than inventing a terminal.
				if (call.current && call.current.phase !== "end") {
					call.ambiguous = true;
					supported = false;
				}
				const headers = new Headers(
					init?.headers ?? (url instanceof Request ? url.headers : undefined),
				);
				for (const [name, value] of headers)
					if (/authorization|api[-_]?key|cookie|token|secret/i.test(name)) {
						headerSecrets.push(
							value,
							value.replace(/^(?:Bearer|Basic)\s+/i, ""),
						);
					}
				const ordinal = owner.attempts.length + 1;
				const row: ReviewAttemptObservation = {
					id: `${owner.operation}#${ordinal}`,
					ordinal,
					phase: "start",
				};
				owner.attempts.push(row);
				call.current = row;
				call.count++;
				publish(row);
				try {
					const response = await fetch(url, init);
					if (!live()) return response;
					row.status = response.status;
					if (!response.ok) {
						const raw = await errorMetadata(response, options?.signal);
						if (!live() || options?.signal?.aborted) return response;
						readUsage(row, raw.usage);
						row.errorCategory =
							[400, 422].includes(response.status) &&
							contextError(raw.error, model.api)
								? "overflow"
								: response.status === 401 || response.status === 403
									? "authentication"
									: response.status === 429
										? "rate-limit"
										: "http";
						row.phase = "end";
						row.outcome = "response";
						publish(row);
					}
					return response;
				} catch (error) {
					if (live()) {
						row.phase = "end";
						row.outcome = options?.signal?.aborted ? "aborted" : "network";
						row.errorCategory = options?.signal?.aborted
							? "aborted"
							: "transport";
						publish(row);
					}
					throw error;
				}
			};
			const stream = registry.streamSimple(model, context, {
				...options,
				maxRetries: 0,
				transport: "sse",
				fetch: observeFetch,
				onProviderStreamEvent: (raw) => {
					if (
						!live() ||
						call.ambiguous ||
						!call.current ||
						call.current.phase === "end"
					)
						return;
					call.events++;
					const event = object(raw),
						message = object(event.message),
						response = object(event.response);
					readUsage(
						call.current,
						event.usage ?? message.usage ?? response.usage,
					);
					if (event.type === "error" && contextError(event.error, model.api))
						call.current.errorCategory = "overflow";
					const reported = event.model ?? message.model ?? response.model;
					if (
						typeof reported === "string" &&
						/^[a-zA-Z0-9._:/@~-]{1,200}$/.test(reported) &&
						!headerSecrets.some((secret) => secret && reported.includes(secret))
					)
						call.current.model = owner.sanitize(reported);
				},
			});
			return {
				result: async () => {
					try {
						const message = await stream.result();
						if (
							live() &&
							!call.ambiguous &&
							call.current &&
							call.current.phase !== "end"
						) {
							const row = call.current;
							row.phase = "end";
							row.outcome =
								message.stopReason === "aborted" ? "aborted" : "response";
							if (
								message.stopReason === "error" ||
								message.stopReason === "aborted"
							)
								row.errorCategory ??=
									message.stopReason === "aborted" ? "aborted" : "response";
							if (
								(row.inputTokens !== undefined ||
									row.outputTokens !== undefined) &&
								number(message.usage?.cost?.total)
							)
								row.catalogCostUsd = message.usage.cost.total;
							publish(row);
						}
						if (
							call.count === 0 ||
							(message.stopReason !== "error" &&
								message.stopReason !== "aborted" &&
								call.events === 0)
						)
							supported = false;
						return message;
					} catch (error) {
						if (call.count === 0) supported = false;
						throw error;
					}
				},
			};
		},
	};
	return {
		registry: wrapped,
		close() {
			for (const call of calls) {
				if (call.count === 0) supported = false;
			}
			for (const row of owner.attempts.slice(startIndex))
				if (row.phase === "start") publish(row);
			open = false;
			return supported;
		},
	};
}
