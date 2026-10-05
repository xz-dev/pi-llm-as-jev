import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import test from "node:test";
import {
	configFilePath,
	loadConfig,
	saveConfig,
	validateConfig,
} from "../src/config.ts";

const limits = {
	"typesafe/jev-latest": { request: 64000, stateAndLongestQuestion: 32000 },
	"openrouter/typesafe/jev-latest": { request: 32000 },
};
test("review limits are validated model-scoped settings and survive unrelated saves", async () => {
	const raw = {
		mode: "classifier",
		classifierModel: "typesafe/jev-latest",
		contextLimits: limits,
		extra: { keep: true },
	};
	const loaded = validateConfig(raw);
	assert.deepEqual(Reflect.get(loaded.config, "contextLimits"), limits);
	assert.equal(loaded.diagnostics.length, 0);
	const dir = await fs.mkdtemp("/var/tmp/jev-limits-");
	try {
		await fs.writeFile(configFilePath(dir), JSON.stringify(raw));
		await saveConfig({ thinkingLevel: "high" }, dir);
		assert.deepEqual(
			Reflect.get((await loadConfig(dir)).config, "contextLimits"),
			limits,
		);
		const changed = {
			"typesafe/jev-latest": { stateAndLongestQuestion: 1000 },
		};
		await saveConfig({ contextLimits: changed }, dir);
		assert.deepEqual((await loadConfig(dir)).config.contextLimits, changed);
		await assert.rejects(
			saveConfig({ contextLimits: { "a/b": { request: -1 } } }, dir),
		);
		assert.deepEqual((await loadConfig(dir)).config.contextLimits, changed);
		await saveConfig({ contextLimits: null }, dir);
		assert.equal((await loadConfig(dir)).config.contextLimits, undefined);
		assert.deepEqual(
			JSON.parse(await fs.readFile(configFilePath(dir), "utf8")).extra,
			{ keep: true },
		);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("invalid limits default all known settings without echoing their values", () => {
	for (const contextLimits of [
		null,
		[],
		{ "bad-secret": { request: 100 } },
		{ "a/b": {} },
		{ "a/b": { request: 0 } },
		{ "a/b": { request: -1 } },
		{ "a/b": { request: 1.5 } },
		{ "a/b": { request: "bad-secret" } },
		{ "a/b": { contextWindow: 10 } },
	]) {
		const parsed = validateConfig({ mode: "llm", model: "a/b", contextLimits });
		assert.deepEqual(parsed.config, validateConfig({}).config);
		assert.match(parsed.diagnostics[0]?.message ?? "", /contextLimits/);
		assert.doesNotMatch(JSON.stringify(parsed.diagnostics), /bad-secret/);
	}
});
