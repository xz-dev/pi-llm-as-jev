/** Presence-aware, request-owned native attempt collection. No transport lives here. */
import type {
	ReviewAttemptObservation,
	ReviewDiagnostics,
} from "../client/judgment-client.ts";

export function emptyDiagnostics(): ReviewDiagnostics {
	return {
		attempts: [],
		attemptCount: 0,
		usage: {
			inputTokens: { knownSum: 0, missing: 0 },
			outputTokens: { knownSum: 0, missing: 0 },
			costUsd: { knownSum: 0, missing: 0 },
		},
		observationCoverage: "complete",
	};
}

/** One row per started attempt, updated by its terminal event. Missing terminals stay explicit. */
export function collectAttempts(
	operation: string,
	attempts: ReviewAttemptObservation[],
	isOpen: () => boolean,
	publish: (attempt: ReviewAttemptObservation) => void,
	sanitize: (text: string) => string,
	size: Pick<
		ReviewAttemptObservation,
		"stateBytes" | "questionBytes" | "longestQuestionBytes"
	> = {},
): (event: unknown) => void {
	const indices = new Map<number, number>();
	return (event) => {
		if (!isOpen() || !event || typeof event !== "object") return;
		const e = event as Record<string, unknown>;
		if (
			e.version !== 1 ||
			!Number.isSafeInteger(e.attempt) ||
			(e.attempt as number) < 1
		)
			return;
		const local = e.attempt as number;
		if (e.phase === "start" && !indices.has(local)) {
			const ordinal = attempts.length + 1;
			const row: ReviewAttemptObservation = {
				...size,
				id: `${operation}#${ordinal}`,
				ordinal,
				phase: "start",
			};
			indices.set(local, attempts.length);
			attempts.push(row);
			publish({ ...row });
		} else if (e.phase === "end") {
			const index = indices.get(local);
			if (index === undefined || attempts[index].phase === "end") return;
			if (
				!["response", "network", "timeout", "aborted"].includes(
					String(e.outcome),
				)
			)
				return;
			const row: ReviewAttemptObservation = {
				...attempts[index],
				phase: "end",
				outcome: e.outcome as ReviewAttemptObservation["outcome"],
			};
			if (
				Number.isInteger(e.status) &&
				(e.status as number) >= 100 &&
				(e.status as number) <= 599
			)
				row.status = e.status as number;
			if (typeof e.model === "string")
				row.model = sanitize(e.model).slice(0, 200);
			for (const name of ["inputTokens", "outputTokens", "costUsd"] as const) {
				const value = e[name];
				if (
					e[`${name}Present`] === true &&
					typeof value === "number" &&
					Number.isFinite(value) &&
					value >= 0
				)
					row[name] = value;
			}
			if (
				typeof e.errorCategory === "string" &&
				/^(overflow|rate-limit|authentication|billing|validation|http|transport|response|aborted)$/.test(
					e.errorCategory,
				)
			)
				row.errorCategory = e.errorCategory;
			attempts[index] = row;
			publish({ ...row });
		}
	};
}

export function diagnostics(
	attempts: readonly ReviewAttemptObservation[],
	supported: boolean,
): ReviewDiagnostics {
	const result = emptyDiagnostics();
	result.attempts = attempts.map((row) => ({ ...row }));
	result.attemptCount = attempts.length;
	result.observationCoverage = supported ? "complete" : "unavailable";
	for (const row of attempts) {
		for (const name of ["inputTokens", "outputTokens", "costUsd"] as const) {
			if (row[name] === undefined) result.usage[name].missing++;
			else result.usage[name].knownSum += row[name];
		}
	}
	if (attempts.some((row) => row.catalogCostUsd !== undefined))
		result.catalogCostUsd = {
			knownSum: attempts.reduce(
				(sum, row) => sum + (row.catalogCostUsd ?? 0),
				0,
			),
			missing: attempts.filter(
				(row) =>
					row.catalogCostUsd === undefined ||
					row.inputTokens === undefined ||
					row.outputTokens === undefined,
			).length,
		};
	return result;
}
