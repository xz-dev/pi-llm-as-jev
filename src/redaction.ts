/**
 * Known-key redaction (design D9). Key values are resolved through Pi's
 * registry auth (`getAuth`), never by separate endpoint/env fallback code.
 * Every resolved api-key value is replaced by a placeholder in outgoing
 * fixed state, evidence, questions and returned error messages; credential
 * values are never logged.
 */

/** Registry slice that can resolve provider auth. */
export interface AuthResolvingRegistry {
	getAuth(
		providerId: string,
	): Promise<{ auth?: { apiKey?: string } } | undefined>;
	getProviders?(): readonly { id: string }[];
}

export const REDACTED_PLACEHOLDER = "[REDACTED]";

const safeSplit = (text: string, secret: string): string =>
	secret.length === 0 ? text : text.split(secret).join(REDACTED_PLACEHOLDER);

/** Redact one string against known secrets. */
export function redactString(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const secret of secrets) {
		out = safeSplit(out, secret);
	}
	return out;
}

function redactUnknown(
	value: unknown,
	secrets: readonly string[],
	seen?: WeakSet<object>,
): unknown {
	if (typeof value === "string") return redactString(value, secrets);
	if (Array.isArray(value)) {
		if (seen?.has(value)) return undefined; // cyclic caller data
		const next = seen ?? new WeakSet();
		next.add(value);
		const out = value.map((v) => redactUnknown(v, secrets, next));
		next.delete(value);
		return out;
	}
	if (value !== null && typeof value === "object") {
		if (seen?.has(value)) return undefined; // cyclic caller data
		const next = seen ?? new WeakSet();
		next.add(value);
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value)) {
			// Redact the key name too: a key can itself be a secret value.
			Object.defineProperty(out, redactString(key, secrets), {
				value: redactUnknown(v, secrets, next),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		next.delete(value);
		return out;
	}
	return value;
}

/** Redact every string inside arbitrary JSON, preserving own keys (incl. `__proto__`). */
export function redactJson<T>(value: T, secrets: readonly string[]): T {
	return redactUnknown(value, secrets) as T;
}

/**
 * Collect known provider api-key values through Pi's registry. Values are
 * used in-memory only, never logged or persisted. Unavailable resolution is
 * skipped (redaction is best-effort over what Pi can resolve).
 */
export async function resolveKnownSecrets(
	registry: AuthResolvingRegistry,
): Promise<string[]> {
	const providers = registry.getProviders?.() ?? [];
	const secrets: string[] = [];
	await Promise.all(
		providers.map(async (provider) => {
			try {
				const auth = await registry.getAuth(provider.id);
				const key = auth?.auth?.apiKey;
				if (typeof key === "string" && key.length > 0) secrets.push(key);
			} catch {
				// Auth resolution failure never breaks judgment; skip provider.
			}
		}),
	);
	return secrets;
}
