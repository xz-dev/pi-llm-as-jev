/** Native review metadata through Pi's released fetch option; Pi still owns dispatch and retries. */
import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import type { ClassifierAnswer } from "../client/judgment-client.ts";
import { validateAnswer } from "./policy.js";

const object = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const number = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Read only provider error-code locations, never echoed prompts or free-text messages. */
function errorCategory(status: number, raw: unknown): string {
	if (status === 401 || status === 403) return "authentication";
	if (status === 402) return "billing";
	if (status === 429) return "rate-limit";
	if (status === 413) return "http";
	const body = object(raw),
		error = object(body.error),
		detail = object(body.detail);
	const codes = [
		body.code,
		error.code,
		error.type,
		object(error.metadata).error_type,
		typeof body.detail === "string" ? body.detail : undefined,
		detail.code,
		detail.error_type,
		object(body.details).code,
		...(Array.isArray(body.errors)
			? body.errors.map((e) => object(e).code)
			: []),
	].filter((value): value is string => typeof value === "string");
	const nonOverflow =
		/auth|unauthor|forbidden|permission|credential|api[_-]?key|billing|payment|insufficient|quota|rate.?limit|too.?many.?requests|throttl|invalid|validation|bad.?request|malformed|request_too_large|payload|entity_too_large/i;
	if (
		!codes.some((code) => nonOverflow.test(code)) &&
		codes.some((code) =>
			[
				"context_length_exceeded",
				"context_window_exceeded",
				"max_tokens_exceeded",
				"prompt_too_long",
			].includes(code.toLowerCase()),
		)
	)
		return "overflow";
	return status === 400 || status === 422 ? "validation" : "http";
}

/** Only metadata is copied; the response and the SDK's parsed value remain unchanged. */
export function observeNativeFetch(
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options: {
		signal?: AbortSignal;
		fetch?: typeof globalThis.fetch;
		onAttempt?: (event: never) => void;
	},
) {
	const fetch = options.fetch ?? globalThis.fetch;
	let open = true,
		count = 0;
	let partialAnswers: Record<string, ClassifierAnswer> = {};
	const rows: Record<string, unknown>[] = [];
	const live = () => open && !options.signal?.aborted;
	const emit = (event: Record<string, unknown>) => {
		if (!open) return;
		try {
			const returned: unknown = options.onAttempt?.(
				structuredClone(event) as never,
			);
			if (
				returned &&
				(typeof returned === "object" || typeof returned === "function")
			)
				void Promise.resolve(returned).catch(() => {});
		} catch {
			/* Diagnostics cannot replace provider results. */
		}
	};
	const observedFetch: typeof globalThis.fetch = async (url, init) => {
		if (!live()) throw new DOMException("Review settled", "AbortError");
		const signal =
			init?.signal ?? (url instanceof Request ? url.signal : options.signal);
		signal?.throwIfAborted();
		const headers = new Headers(
			init?.headers ?? (url instanceof Request ? url.headers : undefined),
		);
		const secrets = [...headers.values()].flatMap((value) => [
			value,
			value.replace(/^(?:Bearer|Basic)\s+/i, ""),
		]);
		const row: Record<string, unknown> = {
			version: 1,
			phase: "start",
			attempt: ++count,
		};
		rows.push(row);
		partialAnswers = {};
		emit(row);
		const terminal = (outcome: string, category?: string) => {
			if (!open || row.phase === "end") return;
			row.phase = "end";
			row.outcome = outcome;
			if (category) row.errorCategory = category;
			emit(row);
		};
		try {
			const response = await fetch(url, init);
			if (!live()) return response;
			row.status = response.status;
			const inspect = (raw: unknown) => {
				if (!live()) return;
				const body = object(raw);
				let result = body,
					metadata = body;
				if (model.api === "cloudflare-workers-ai-system-one") {
					const envelope = object(body.result);
					// Failed/incomplete envelopes may still report billable work.
					// Unwrap metadata independently; answer eligibility stays strict below.
					metadata =
						envelope.result !== null &&
						typeof envelope.result === "object" &&
						!Array.isArray(envelope.result)
							? object(envelope.result)
							: envelope;
					result =
						body.success === false
							? {}
							: Object.hasOwn(envelope, "answers")
								? envelope
								: envelope.state === "Completed"
									? object(envelope.result)
									: {};
				}
				const usage = object(metadata.usage);
				for (const [field, wire] of [
					["inputTokens", "input_tokens"],
					["outputTokens", "output_tokens"],
					["costUsd", "cost"],
				]) {
					row[`${field}Present`] = number(usage[wire]);
					if (number(usage[wire])) row[field] = usage[wire];
				}
				if (
					typeof metadata.model === "string" &&
					/^[a-zA-Z0-9._:/@~-]{1,200}$/.test(metadata.model) &&
					!secrets.some(
						(secret) => secret && (metadata.model as string).includes(secret),
					)
				)
					row.model = metadata.model;
				if (!response.ok) {
					terminal("response", errorCategory(response.status, body));
					return;
				}
				const answers = object(result.answers);
				partialAnswers = Object.fromEntries(
					Object.entries(context.questions).flatMap(([id, question]) => {
						if (!Object.hasOwn(answers, id)) return [];
						const rawAnswer = object(answers[id]);
						const normalized =
							question.type === "bool"
								? rawAnswer.type === "noul"
									? { type: "bool", probability: rawAnswer.noul }
									: undefined
								: rawAnswer;
						const answer = validateAnswer(question, normalized);
						return answer ? [[id, answer]] : [];
					}),
				);
				row.complete =
					Object.keys(partialAnswers).length ===
					Object.keys(context.questions).length;
				terminal("response", row.complete ? undefined : "response");
			};
			// Observe the body when Pi consumes it. No cloned stream, duplicate JSON read,
			// body-size quota on valid answers, or independent provider/parser dispatch.
			const json = response.json.bind(response),
				text = response.text.bind(response);
			response.json = async () => {
				try {
					const body: unknown = await json();
					inspect(body);
					return body;
				} catch (error) {
					terminal(
						signal?.aborted ? "aborted" : "response",
						signal?.aborted ? "aborted" : "response",
					);
					throw error;
				}
			};
			response.text = async () => {
				try {
					const body = await text();
					let metadata: unknown;
					if (Buffer.byteLength(body) <= 65536)
						try {
							metadata = JSON.parse(body);
						} catch {
							/* No typed metadata. */
						}
					inspect(metadata);
					return body;
				} catch (error) {
					terminal(
						signal?.aborted ? "aborted" : "response",
						signal?.aborted ? "aborted" : "response",
					);
					throw error;
				}
			};
			return response;
		} catch (error) {
			const aborted = options.signal?.aborted;
			terminal(
				aborted ? "aborted" : signal?.aborted ? "timeout" : "network",
				aborted ? "aborted" : "transport",
			);
			throw error;
		}
	};
	return {
		fetch: observedFetch,
		finish(result: ClassifierResult) {
			// A registry that ignores the public fetch hook supplies no wire proof.
			// Never turn its logical result into a fabricated zero-attempt success.
			if (
				!count ||
				(result.stopReason === "stop" &&
					rows.some((row) => row.phase !== "end"))
			)
				return { ...result, observation: undefined };
			return {
				...result,
				observation: {
					version: 1,
					attempts: count,
					partialAnswers: structuredClone(partialAnswers),
				},
			};
		},
		close() {
			open = false;
		},
	};
}
