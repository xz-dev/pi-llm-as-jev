import assert from "node:assert/strict";
import test from "node:test";
import {
	type AuthResolvingRegistry,
	REDACTED_PLACEHOLDER,
	redactJson,
	redactString,
	resolveKnownSecrets,
} from "../src/redaction.ts";

test("redactString replaces every occurrence of each secret", () => {
	assert.equal(
		redactString("a SECRET1 b SECRET1 c", ["SECRET1"]),
		`a ${REDACTED_PLACEHOLDER} b ${REDACTED_PLACEHOLDER} c`,
	);
	assert.equal(redactString("clean", ["S"]), "clean");
	assert.equal(redactString("empty secret stays", [""]), "empty secret stays");
});

test("redactJson walks nested objects, arrays, keys and values", () => {
	const input = {
		token: "sk-live-123",
		nested: { note: "uses sk-live-123 here", safe: 42 },
		list: ["sk-live-123", null, true],
	};
	const out = redactJson(input, ["sk-live-123"]);
	assert.equal(out.token, REDACTED_PLACEHOLDER);
	assert.ok(String(out.nested.note).includes(REDACTED_PLACEHOLDER));
	assert.equal(out.nested.safe, 42);
	assert.equal(out.list[0], REDACTED_PLACEHOLDER);
	assert.equal(out.list[1], null);
	assert.equal(out.list[2], true);
});

test("redactJson preserves legal own keys like __proto__", () => {
	const input = JSON.parse('{"__proto__":"has sk-1","safe":"ok"}');
	const out = redactJson(input, ["sk-1"]);
	assert.ok(Object.hasOwn(out, "__proto__"));
	assert.equal(
		Object.getOwnPropertyDescriptor(out, "__proto__")?.value,
		`has ${REDACTED_PLACEHOLDER}`,
	);
	assert.equal(Object.getPrototypeOf(out), Object.prototype);
});

test("redactJson does not mutate the input", () => {
	const input = { a: "sk-2" };
	redactJson(input, ["sk-2"]);
	assert.equal(input.a, "sk-2");
});

test("redactJson preserves shared references that are not cycles", () => {
	const shared = { note: "fixture-key" };
	const list = [shared];
	const input = { first: shared, second: shared, arrays: [list, list] };
	const out = redactJson(input, ["fixture-key"]);
	assert.deepEqual(out, {
		first: { note: REDACTED_PLACEHOLDER },
		second: { note: REDACTED_PLACEHOLDER },
		arrays: [
			[{ note: REDACTED_PLACEHOLDER }],
			[{ note: REDACTED_PLACEHOLDER }],
		],
	});
	assert.equal(shared.note, "fixture-key");
});

test("resolveKnownSecrets collects api keys through the registry only", async () => {
	const registry: AuthResolvingRegistry = {
		getProviders: () => [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }],
		getAuth: async (id) => {
			if (id === "alpha") return { auth: { apiKey: "KEY-A" } };
			if (id === "beta") return {}; // no key resolved
			throw new Error("auth store down");
		},
	};
	const secrets = await resolveKnownSecrets(registry);
	assert.deepEqual(secrets, ["KEY-A"]);
});

test("resolveKnownSecrets with no provider list resolves nothing", async () => {
	const registry: AuthResolvingRegistry = {
		getAuth: async () => ({ auth: { apiKey: "X" } }),
	};
	assert.deepEqual(await resolveKnownSecrets(registry), []);
});
