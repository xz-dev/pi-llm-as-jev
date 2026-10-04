import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
	agentDir,
	configFilePath,
	loadConfig,
	saveConfig,
	validateConfig,
} from "../src/config.ts";

const tmpRoot = await fs.mkdtemp(path.join("/var/tmp", "llm-as-jev-config-"));
test.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));

const dirA = path.join(tmpRoot, "a");
const fileA = configFilePath(dirA);

const DEFAULTS = {
	mode: "auto",
	thinkingLevel: "off",
	timeoutMs: 120_000,
};

test("unreadable path yields defaults plus diagnostic, never throws", async () => {
	// /dev/null is a file, so `/dev/null/llm-as-jev.json` fails with ENOTDIR.
	const loaded = await loadConfig("/dev/null");
	assert.equal(loaded.defaults, false);
	assert.deepEqual(loaded.config, DEFAULTS);
	assert.equal(loaded.diagnostics.length, 1);
	assert.match(loaded.diagnostics[0]?.message ?? "", /could not read/);
});

test("directory-as-config-file yields defaults plus diagnostic, never throws", async () => {
	const dirF = path.join(tmpRoot, "f");
	await fs.mkdir(configFilePath(dirF), { recursive: true });
	const loaded = await loadConfig(dirF);
	assert.equal(loaded.defaults, false);
	assert.equal(loaded.config.mode, "auto");
	assert.match(loaded.diagnostics[0]?.message ?? "", /could not read/);
});

test("any invalid known field defaults ALL known fields", () => {
	// mode + model are valid; thinkingLevel is not. Every known field must
	// fall back to its default — no partial acceptance (task 3.1).
	const loaded = validateConfig({
		mode: "classifier",
		classifierModel: "prov/clf",
		model: "prov/id",
		thinkingLevel: "turbo",
		timeoutMs: 2500,
	});
	assert.deepEqual(loaded.config, DEFAULTS);
	assert.equal(loaded.diagnostics.length, 1);
	assert.match(loaded.diagnostics[0]?.message ?? "", /unknown thinkingLevel/);
});

test("an invalid model reference also defaults the whole file", () => {
	const loaded = validateConfig({
		mode: "classifier",
		model: "no-slash",
		timeoutMs: 2500,
	});
	assert.deepEqual(loaded.config, DEFAULTS);
	assert.equal(loaded.diagnostics.length, 1);
	assert.match(loaded.diagnostics[0]?.message ?? "", /provider\/modelid/);
});

test("an invalid explicit classifier reference defaults the whole file", () => {
	const loaded = validateConfig({
		mode: "auto",
		classifierModel: 42,
		model: "a/b",
	});
	assert.deepEqual(loaded.config, DEFAULTS);
	assert.ok(loaded.diagnostics.length >= 1);
});

test("mixed valid/invalid file on disk defaults all known fields", async () => {
	const dirG = path.join(tmpRoot, "g");
	await fs.mkdir(dirG, { recursive: true });
	await fs.writeFile(
		configFilePath(dirG),
		JSON.stringify({ mode: "llm", thinkingLevel: "mega", timeoutMs: "fast" }),
	);
	const loaded = await loadConfig(dirG);
	assert.deepEqual(loaded.config, DEFAULTS);
	assert.equal(loaded.diagnostics.length, 2);
	assert.match(loaded.diagnostics[0]?.message ?? "", /unknown thinkingLevel/);
	assert.match(loaded.diagnostics[1]?.message ?? "", /timeoutMs/);
});

test("old jev mode value is invalid, not silently aliased", () => {
	const loaded = validateConfig({ mode: "jev", model: "a/b" });
	assert.deepEqual(loaded.config, DEFAULTS);
	assert.equal(loaded.diagnostics.length, 1);
	assert.match(loaded.diagnostics[0]?.message ?? "", /unknown mode/);
});

test("saveConfig over an unreadable existing file recovers and replaces it", async (t) => {
	if (process.getuid?.() === 0) {
		t.skip("chmod 000 does not block reads for root");
		return;
	}
	const dirI = path.join(tmpRoot, "i");
	const fileI = configFilePath(dirI);
	await fs.mkdir(dirI, { recursive: true });
	await fs.writeFile(fileI, JSON.stringify({ mode: "classifier", secret: 1 }));
	await fs.chmod(fileI, 0o000);
	try {
		const saved = await saveConfig({ mode: "llm" }, dirI);
		assert.equal(saved.config.mode, "llm");
		assert.ok(
			saved.diagnostics.some((d) =>
				/could not read existing file/.test(d.message),
			),
		);
		const onDisk = JSON.parse(await fs.readFile(fileI, "utf8"));
		assert.equal(onDisk.mode, "llm");
	} finally {
		await fs.chmod(fileI, 0o600).catch(() => {});
	}
});

test("saveConfig onto a directory-named config file fails without leaving a temp file", async () => {
	const dirJ = path.join(tmpRoot, "j");
	await fs.mkdir(configFilePath(dirJ), { recursive: true }); // config path is a dir
	await assert.rejects(saveConfig({ mode: "auto" }, dirJ));
	const entries = await fs.readdir(dirJ);
	// Only the directory named llm-as-jev.json; no stale temp siblings.
	assert.equal(entries.filter((e) => e.includes(".tmp-")).length, 0);
});

test("saveConfig temporary names are unique across rapid sequential saves", async () => {
	const dirH = path.join(tmpRoot, "h");
	// Same millisecond: verify via repeated saves that nothing collides and no
	// stale temps remain. Temp name = path.tmp-pid-ms-seq; seq is monotonic.
	const before = await fs.readdir(dirH).catch(() => [] as string[]);
	await Promise.all([
		saveConfig({ timeoutMs: 1000 }, dirH),
		saveConfig({ timeoutMs: 1001 }, dirH),
		saveConfig({ timeoutMs: 1002 }, dirH),
	]);
	const after = await fs.readdir(dirH);
	assert.equal(after.length, 1);
	assert.equal(after[0], "llm-as-jev.json");
	assert.equal(before.length, 0);
	// Final file is valid JSON from one complete write.
	const onDisk = JSON.parse(await fs.readFile(configFilePath(dirH), "utf8"));
	assert.equal(onDisk.mode, "auto");
	assert.ok([1000, 1001, 1002].includes(onDisk.timeoutMs));
});

test("missing file yields defaults, no diagnostics", async () => {
	const loaded = await loadConfig(dirA);
	assert.equal(loaded.defaults, true);
	assert.deepEqual(loaded.config, DEFAULTS);
	assert.equal(loaded.diagnostics.length, 0);
});

test("valid file parses all fields including an independent classifierModel", async () => {
	await fs.mkdir(dirA, { recursive: true });
	await fs.writeFile(
		fileA,
		JSON.stringify({
			mode: "classifier",
			classifierModel: "custom-net/family/clf-2",
			model: "anthropic/claude/sonnet",
			thinkingLevel: "high",
			timeoutMs: 5000,
		}),
	);
	const loaded = await loadConfig(dirA);
	assert.equal(loaded.defaults, false);
	assert.equal(loaded.diagnostics.length, 0);
	assert.equal(loaded.config.mode, "classifier");
	assert.equal(loaded.config.classifierModel, "custom-net/family/clf-2");
	assert.equal(loaded.config.classifierProvider, "custom-net");
	assert.equal(loaded.config.classifierModelId, "family/clf-2");
	assert.equal(loaded.config.model, "anthropic/claude/sonnet");
	assert.equal(loaded.config.provider, "anthropic");
	assert.equal(loaded.config.modelId, "claude/sonnet");
	assert.equal(loaded.config.thinkingLevel, "high");
	assert.equal(loaded.config.timeoutMs, 5000);
});

test("malformed JSON yields defaults plus diagnostic", async () => {
	const dirB = path.join(tmpRoot, "b");
	await fs.mkdir(dirB, { recursive: true });
	await fs.writeFile(configFilePath(dirB), "{ not json");
	const loaded = await loadConfig(dirB);
	assert.equal(loaded.defaults, false);
	assert.equal(loaded.config.mode, "auto");
	assert.equal(loaded.config.timeoutMs, 120_000);
	assert.match(loaded.diagnostics[0]?.message ?? "", /malformed JSON/);
});

test("unknown enum values produce diagnostics and all-defaults", () => {
	const loaded = validateConfig({ mode: "nope", thinkingLevel: "ultra" });
	assert.equal(loaded.config.mode, "auto");
	assert.equal(loaded.config.thinkingLevel, "off");
	assert.equal(loaded.diagnostics.length, 2);
	assert.match(loaded.diagnostics[0]?.message ?? "", /unknown mode/);
	assert.match(loaded.diagnostics[1]?.message ?? "", /unknown thinkingLevel/);
});

test("model without provider/id is rejected and defaults the whole file", () => {
	const loaded = validateConfig({ model: "just-a-model" });
	assert.equal(loaded.config.model, undefined);
	assert.equal(loaded.config.provider, undefined);
	assert.equal(loaded.config.modelId, undefined);
	assert.match(
		loaded.diagnostics[0]?.message ?? "",
		/not in provider\/modelid form/,
	);
});

test("model split at first slash keeps slashes in modelid", () => {
	const loaded = validateConfig({ model: "openrouter/a/b/c" });
	assert.equal(loaded.diagnostics.length, 0);
	assert.equal(loaded.config.provider, "openrouter");
	assert.equal(loaded.config.modelId, "a/b/c");
});

test("classifierModel split at first slash keeps slashes in model id", () => {
	const loaded = validateConfig({ classifierModel: "prov/family/clf" });
	assert.equal(loaded.diagnostics.length, 0);
	assert.equal(loaded.config.classifierProvider, "prov");
	assert.equal(loaded.config.classifierModelId, "family/clf");
});

test("invalid timeoutMs falls back to all-defaults", () => {
	const loaded = validateConfig({ timeoutMs: -5 });
	assert.equal(loaded.config.timeoutMs, 120_000);
	assert.equal(loaded.diagnostics.length, 1);

	const nan = validateConfig({ timeoutMs: Number.NaN });
	assert.equal(nan.config.timeoutMs, 120_000);
	assert.equal(nan.diagnostics.length, 1);
});

test("home fallback when env unset", () => {
	const prev = process.env.PI_CODING_AGENT_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
	const home = process.env.HOME;
	process.env.HOME = "/home/tester/";
	try {
		assert.equal(agentDir(), "/home/tester/.pi/agent");
	} finally {
		process.env.HOME = home;
		if (prev === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = prev;
		}
	}
});

test("agentDir honors PI_CODING_AGENT_DIR", () => {
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = "/var/tmp/some-agent-dir";
	try {
		assert.equal(agentDir(), "/var/tmp/some-agent-dir");
	} finally {
		if (prev === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = prev;
		}
	}
});
test("saveConfig round-trips, preserves unknown keys and independent slots", async () => {
	const dirC = path.join(tmpRoot, "c");
	const fileC = configFilePath(dirC);
	await fs.mkdir(dirC, { recursive: true });
	await fs.writeFile(
		fileC,
		JSON.stringify({
			mode: "classifier",
			classifierModel: "prov/clf-1",
			model: "a/b",
			thinkingLevel: "low",
			timeoutMs: 1000,
			futureSetting: { nested: [1, 2] },
		}),
	);
	const saved = await saveConfig({ mode: "llm", timeoutMs: 2000 }, dirC);
	assert.equal(saved.config.mode, "llm");
	assert.equal(saved.config.timeoutMs, 2000);
	assert.equal(saved.config.model, "a/b");
	// Independent native slot survives an LLM-only update.
	assert.equal(saved.config.classifierModel, "prov/clf-1");
	assert.equal(saved.diagnostics.length, 0);

	const onDisk = JSON.parse(await fs.readFile(fileC, "utf8"));
	assert.deepEqual(onDisk.futureSetting, { nested: [1, 2] });
	assert.equal(onDisk.mode, "llm");
	assert.equal(onDisk.timeoutMs, 2000);
	assert.equal(onDisk.thinkingLevel, "low");
	assert.equal(onDisk.model, "a/b");
	assert.equal(onDisk.classifierModel, "prov/clf-1");

	const reloaded = await loadConfig(dirC);
	assert.equal(reloaded.config.mode, "llm");
	assert.equal(reloaded.config.timeoutMs, 2000);
	assert.equal(reloaded.config.provider, "a");
	assert.equal(reloaded.config.modelId, "b");
	assert.equal(reloaded.config.classifierProvider, "prov");
	assert.equal(reloaded.config.classifierModelId, "clf-1");
	assert.equal(reloaded.diagnostics.length, 0);
});

test("saveConfig classifier-only update leaves the LLM slot untouched", async () => {
	const dirK = path.join(tmpRoot, "k");
	const fileK = configFilePath(dirK);
	await fs.mkdir(dirK, { recursive: true });
	await fs.writeFile(
		fileK,
		JSON.stringify({
			mode: "auto",
			classifierModel: "prov/clf-1",
			model: "a/b",
			thinkingLevel: "low",
		}),
	);
	const saved = await saveConfig(
		{ classifierModel: "other-net/family/clf-9" },
		dirK,
	);
	assert.equal(saved.config.classifierModel, "other-net/family/clf-9");
	assert.equal(saved.config.classifierModelId, "family/clf-9");
	assert.equal(saved.config.model, "a/b");
	assert.equal(saved.config.thinkingLevel, "low");
	const onDisk = JSON.parse(await fs.readFile(fileK, "utf8"));
	assert.equal(onDisk.model, "a/b");
	assert.equal(onDisk.thinkingLevel, "low");
	assert.equal(onDisk.classifierModel, "other-net/family/clf-9");
});

test("saveConfig LLM-only update leaves the classifier slot untouched", async () => {
	const dirL = path.join(tmpRoot, "l");
	const fileL = configFilePath(dirL);
	await fs.mkdir(dirL, { recursive: true });
	await fs.writeFile(
		fileL,
		JSON.stringify({
			mode: "auto",
			classifierModel: "prov/clf-1",
			model: "a/b",
			thinkingLevel: "low",
		}),
	);
	const saved = await saveConfig(
		{ model: "anthropic/claude-sonnet-4-5", thinkingLevel: "high" },
		dirL,
	);
	assert.equal(saved.config.model, "anthropic/claude-sonnet-4-5");
	assert.equal(saved.config.thinkingLevel, "high");
	assert.equal(saved.config.classifierModel, "prov/clf-1");
	const onDisk = JSON.parse(await fs.readFile(fileL, "utf8"));
	assert.equal(onDisk.classifierModel, "prov/clf-1");
});

test("removing classifierModel restores default discovery without touching chat fields", async () => {
	const dirM = path.join(tmpRoot, "m");
	const fileM = configFilePath(dirM);
	await fs.mkdir(dirM, { recursive: true });
	await fs.writeFile(
		fileM,
		JSON.stringify({
			mode: "auto",
			classifierModel: "prov/clf-1",
			model: "a/b",
			thinkingLevel: "low",
		}),
	);
	const saved = await saveConfig({ classifierModel: null }, dirM);
	assert.equal(saved.config.classifierModel, undefined);
	assert.equal(saved.config.classifierProvider, undefined);
	assert.equal(saved.config.classifierModelId, undefined);
	assert.equal(saved.config.model, "a/b");
	assert.equal(saved.config.thinkingLevel, "low");
	const onDisk = JSON.parse(await fs.readFile(fileM, "utf8"));
	assert.equal("classifierModel" in onDisk, false);
	assert.equal(onDisk.model, "a/b");
});

test("saveConfig writes 0600 and no stale temp files", async () => {
	const dirD = path.join(tmpRoot, "d");
	await saveConfig({ mode: "auto" }, dirD);
	const entries = await fs.readdir(dirD);
	assert.deepEqual(entries, ["llm-as-jev.json"]);
	const stat = await fs.stat(configFilePath(dirD));
	// eslint-disable-next-line no-bitwise
	assert.equal(stat.mode & 0o777, 0o600);
});

test("saveConfig over a malformed file starts clean but keeps unknown keys absent", async () => {
	const dirE = path.join(tmpRoot, "e");
	await fs.mkdir(dirE, { recursive: true });
	await fs.writeFile(configFilePath(dirE), "corrupt{");
	const saved = await saveConfig({ mode: "classifier" }, dirE);
	assert.equal(saved.config.mode, "classifier");
	assert.equal(saved.diagnostics.length, 1);
	const onDisk = JSON.parse(await fs.readFile(configFilePath(dirE), "utf8"));
	assert.equal(onDisk.mode, "classifier");
});

test("a syntactically valid explicit classifier is preserved as an unavailable selection", () => {
	// Valid form but not in any catalog here: the reference stays intact for
	// diagnostics; load/save never erases it (task 3.1/5.1).
	const loaded = validateConfig({ classifierModel: "ghost/net-clf" });
	assert.equal(loaded.diagnostics.length, 0);
	assert.equal(loaded.config.classifierModel, "ghost/net-clf");
	assert.equal(loaded.config.classifierProvider, "ghost");
	assert.equal(loaded.config.classifierModelId, "net-clf");
});

// ---------------------------------------------------------------------------
// F8 regression: save over invalid persisted file keeps the confirmed update;
// unknown own keys (incl. __proto__) survive without prototype mutation.
// ---------------------------------------------------------------------------

test("legacy invalid mode plus native save keeps the confirmed selection", async () => {
	// F8: `{"mode":"jev","model":"chat/tool"}` + {classifierModel:"native/kev"}
	// must persist native/kev, NOT resurrect jev on disk nor return defaults.
	const dirN = path.join(tmpRoot, "n");
	const fileN = configFilePath(dirN);
	await fs.mkdir(dirN, { recursive: true });
	await fs.writeFile(
		fileN,
		JSON.stringify({ mode: "jev", model: "chat/tool" }),
	);
	const saved = await saveConfig({ classifierModel: "native/kev" }, dirN);
	assert.equal(saved.config.classifierModel, "native/kev");
	assert.equal(saved.config.classifierProvider, "native");
	assert.equal(saved.config.classifierModelId, "kev");
	const onDisk = JSON.parse(await fs.readFile(fileN, "utf8"));
	assert.equal(onDisk.classifierModel, "native/kev");
	// Old invalid `mode:"jev"` must not persist: normalized base wrote a valid mode.
	assert.notEqual(onDisk.mode, "jev");
	// The whole file was invalid → ALL known fields normalized to defaults;
	// the previously persisted model slot does not resurrect either.
	assert.equal("model" in onDisk, false);
	// Disk equals the returned effective config.
	const loaded = await loadConfig(dirN);
	assert.equal(loaded.config.classifierModel, "native/kev");
	assert.equal(loaded.config.mode, saved.config.mode);
	assert.equal(loaded.config.model, undefined);
});

test("malformed setting plus chat/mode save normalizes base and persists choice", async () => {
	const dirO = path.join(tmpRoot, "o");
	const fileO = configFilePath(dirO);
	await fs.mkdir(dirO, { recursive: true });
	await fs.writeFile(
		fileO,
		JSON.stringify({
			mode: "classifier",
			thinkingLevel: "mega",
			classifierModel: "prov/clf-1",
		}),
	);
	const saved = await saveConfig(
		{ mode: "llm", model: "anthropic/claude-sonnet-4-5" },
		dirO,
	);
	assert.equal(saved.config.mode, "llm");
	assert.equal(saved.config.model, "anthropic/claude-sonnet-4-5");
	const onDisk = JSON.parse(await fs.readFile(fileO, "utf8"));
	assert.equal(onDisk.mode, "llm");
	assert.equal(onDisk.model, "anthropic/claude-sonnet-4-5");
	// Persisted invalid thinkingLevel is normalized, not resurrected — and
	// per all-defaults the rest of the invalid file's known fields drop too.
	assert.notEqual(onDisk.thinkingLevel, "mega");
	assert.equal("classifierModel" in onDisk, false);
});

test("null removal clears a slot over a file with other invalid known fields", async () => {
	const dirP = path.join(tmpRoot, "p");
	const fileP = configFilePath(dirP);
	await fs.mkdir(dirP, { recursive: true });
	await fs.writeFile(
		fileP,
		JSON.stringify({
			mode: "jev",
			classifierModel: "prov/clf-1",
			model: "a/b",
		}),
	);
	const saved = await saveConfig({ classifierModel: null }, dirP);
	assert.equal(saved.config.classifierModel, undefined);
	const onDisk = JSON.parse(await fs.readFile(fileP, "utf8"));
	assert.equal("classifierModel" in onDisk, false);
	assert.notEqual(onDisk.mode, "jev");
	// All-defaults on the invalid file: persisted chat model also drops.
	assert.equal("model" in onDisk, false);
});

test("invalid update fails without writing, leaving disk unchanged", async () => {
	const dirQ = path.join(tmpRoot, "q");
	const fileQ = configFilePath(dirQ);
	await fs.mkdir(dirQ, { recursive: true });
	const before = JSON.stringify({ mode: "auto", model: "a/b" });
	await fs.writeFile(fileQ, before);
	await assert.rejects(
		saveConfig({ mode: "bogus" as never }, dirQ),
		/invalid|unknown|must/i,
	);
	// Disk byte-identical; no stale temp siblings remain.
	assert.equal(await fs.readFile(fileQ, "utf8"), before);
	const entries = await fs.readdir(dirQ);
	assert.equal(entries.filter((e) => e.includes(".tmp-")).length, 0);
});

test("unknown own __proto__/constructor/toString extras survive without prototype mutation", async () => {
	const dirR = path.join(tmpRoot, "r");
	const fileR = configFilePath(dirR);
	await fs.mkdir(dirR, { recursive: true });
	await fs.writeFile(
		fileR,
		'{"mode":"auto","model":"a/b","__proto__":{"keep":1},"constructor":{"keep":2},"toString":{"keep":3}}',
	);
	const saved = await saveConfig({ timeoutMs: 5000 }, dirR);
	const onDisk = JSON.parse(await fs.readFile(fileR, "utf8")) as Record<
		string,
		unknown
	>;
	const protoExtra = Object.getOwnPropertyDescriptor(
		onDisk,
		"__proto__",
	)?.value;
	assert.deepEqual(protoExtra, { keep: 1 });
	assert.deepEqual(
		// biome-ignore lint/complexity/useLiteralKeys: own-key assertion, not the Function constructor
		onDisk["constructor"],
		{ keep: 2 },
	);
	assert.deepEqual(
		// biome-ignore lint/complexity/useLiteralKeys: own-key assertion, not the method
		onDisk["toString"],
		{ keep: 3 },
	);
	// Object's own prototype unchanged by the copy.
	assert.equal(Object.getPrototypeOf(onDisk), Object.prototype);
	assert.equal(saved.config.timeoutMs, 5000);
});

test("disk and returned config agree for independent slots (3.2)", async () => {
	const dirS = path.join(tmpRoot, "s");
	const fileS = configFilePath(dirS);
	await fs.mkdir(dirS, { recursive: true });
	const saved = await saveConfig(
		{
			classifierModel: "prov/family/clf-9",
			model: "anthropic/claude/sonnet",
			thinkingLevel: "low",
		},
		dirS,
	);
	const onDisk = JSON.parse(await fs.readFile(fileS, "utf8"));
	assert.equal(onDisk.classifierModel, "prov/family/clf-9");
	assert.equal(onDisk.model, "anthropic/claude/sonnet");
	assert.equal(onDisk.thinkingLevel, "low");
	const loaded = await loadConfig(dirS);
	assert.equal(loaded.config.classifierModelId, "family/clf-9");
	assert.equal(loaded.config.modelId, "claude/sonnet");
	// Return value is the same effective config as the disk reload.
	assert.deepEqual(loaded.config, saved.config);
});
