/**
 * Integration tests for src/index.ts (tasks 7.2, 8.1-8.4, 9.1 wiring) with a
 * fake ExtensionAPI + fake HOST registry facade: handle publish/clear
 * identity checks, adapted-registry service dispatch, once-per-session
 * diagnostics, mode persistence (classifier mode, no jev alias), chat and
 * native pickers, cancel leaving disk+memory unchanged, atomic swaps only
 * on successful writes, re-registration on chat-model change. No real host,
 * no inference.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getJudgmentService } from "../client/judgment-client.ts";

const SERVICE_KEY = Symbol.for("pi-llm-as-jev:service");
const EMULATED = "llm-as-jev";

/** Fake ExtensionAPI capturing registrations, events and UI calls. */
class FakePi {
	registeredProviders: {
		id: string;
		getAllModels?: () => readonly { id: string }[];
	}[] = [];
	unregistered: string[] = [];
	commands = new Map<
		string,
		{ handler: (args: string, ctx: never) => Promise<void> }
	>();
	handlers = new Map<
		string,
		((event: unknown, ctx: unknown) => Promise<void>)[]
	>();
	entries: { type: string; data: unknown }[] = [];
	uiNotifications: { message: string; type?: string }[] = [];
	private customHandler:
		| ((done: (result: string | undefined) => void) => void)
		| undefined;
	/** Count of ctx.ui.custom invocations (picker focus grabs). */
	customCalls = 0;

	registerProvider(provider: { id: string }): void {
		this.registeredProviders.push(provider);
	}
	unregisterProvider(name: string): void {
		this.unregistered.push(name);
	}
	registerCommand(
		name: string,
		options: { handler: (args: string, ctx: never) => Promise<void> },
	): void {
		this.commands.set(name, options);
	}
	on(
		event: string,
		handler: (event: unknown, ctx: unknown) => Promise<void>,
	): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}
	appendEntry(type: string, data: unknown): void {
		this.entries.push({ type, data });
	}

	/** The next ctx.ui.custom call resolves through this handler. */
	nextCustom(
		handler: (done: (result: string | undefined) => void) => void,
	): void {
		this.customHandler = handler;
	}

	makeCtx(overrides: Record<string, unknown> = {}): never {
		return {
			modelRegistry: fakeHost,
			sessionManager: { getBranch: () => [] },
			mode: "tui",
			hasUI: true,
			ui: {
				notify: (message: string, type?: string) =>
					this.uiNotifications.push({ message, type }),
				custom: async (
					factory: (
						tui: unknown,
						theme: unknown,
						keybindings: unknown,
						done: (result: string | undefined) => void,
					) => unknown,
				) => {
					this.customCalls += 1;
					if (!this.customHandler) throw new Error("no custom handler set");
					return new Promise<string | undefined>((resolve) => {
						this.customHandler?.(resolve);
						void factory(undefined, undefined, undefined, resolve);
					});
				},
			},
			...overrides,
		} as never;
	}

	async fire(event: string, ctx?: unknown): Promise<void> {
		for (const handler of this.handlers.get(event) ?? [])
			await handler({}, ctx ?? this.makeCtx());
	}
}

// ---------------------------------------------------------------------------
// Fake HOST facade — mirrors the REAL ctx.modelRegistry surface exactly
// (find/getProviderAuth/getRegisteredProviderIds/getAll + classify and
// streamSimple that actually work), so the adapted registry is exercised.
// ---------------------------------------------------------------------------

function chatModel(provider: string, id: string, reasoning = false) {
	return {
		id,
		provider,
		name: `${id} display`,
		api: "openai-completions",
		baseUrl: "https://fake.invalid",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning,
		thinkingLevelMap: {},
		contextWindow: 8192,
		maxTokens: 1024,
	} as unknown as Model<Api>;
}

function nativeModel(provider: string, id: string) {
	return {
		type: "classifier",
		id,
		provider,
		name: `${provider}/${id}`,
		api: "typesafe-system-one",
		baseUrl: "https://fake.invalid",
		input: ["text"],
		contextWindow: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

let chatModels: ReturnType<typeof chatModel>[] = [];
let nativeModels: ReturnType<typeof nativeModel>[] = [];
/** Recorded native classify calls (model identity + context). */
const nativeCalls: { model: string; questions: string[] }[] = [];
let llmCalls = 0;
/** Answer produced by the fake native provider, keyed by question id. */
let nativeAnswers: Record<string, unknown> = {};

const fakeHost = {
	getAll: () => [...chatModels, ...nativeModels] as never,
	getAvailable: () => chatModels as never,
	find: (provider: string, id: string) =>
		chatModels.find((m) => m.provider === provider && m.id === id),
	getAvailableOfType: async (_type: "classifier") =>
		nativeModels.filter((m) => m.provider !== EMULATED) as never,
	getProviderAuth: async (providerId: string) =>
		providerId === "fake" || providerId === "native"
			? { auth: { apiKey: "pseudo-native-key" }, source: "fixture" }
			: providerId === EMULATED
				? { auth: { apiKey: "emulated" }, source: "delegated" }
				: undefined,
	getRegisteredProviderIds: () => ["fake", "native", EMULATED],
	classify: async (model: { provider: string; id: string }, context: never) => {
		const questions = Object.keys((context as { questions: object }).questions);
		nativeCalls.push({ model: `${model.provider}/${model.id}`, questions });
		return {
			api: "typesafe-system-one",
			provider: model.provider,
			model: model.id,
			answers: { ...nativeAnswers },
			stopReason: "stop",
			timestamp: Date.now(),
		};
	},
	streamSimple: () => {
		llmCalls += 1;
		throw new Error("llm path not exercised in this suite");
	},
};

/** Fake chat backend models including our own emulation entry. */
function resetCatalog(): void {
	chatModels = [];
	nativeModels = [];
	nativeCalls.length = 0;
	llmCalls = 0;
	nativeAnswers = {};
}

let agentDir: string | undefined;

async function withAgentDir<T>(fn: () => Promise<T>): Promise<T> {
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-as-jev-index-test-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	resetCatalog();
	try {
		return await fn();
	} finally {
		process.env.PI_CODING_AGENT_DIR = prev;
		await fs.rm(agentDir, { recursive: true, force: true });
		agentDir = undefined;
	}
}

/** Load the extension fresh; module state must not leak between tests. */
async function freshExtension(): Promise<{
	pi: FakePi;
	fire: (event: string, ctx?: unknown) => Promise<void>;
}> {
	const module = await import(`../src/index.ts?${Math.random()}`);
	const pi = new FakePi();
	module.default(pi as never);
	return { pi, fire: (event, ctx) => pi.fire(event, ctx) };
}

/** Standard one-choice/bool/score request for judge() dispatch checks. */
function mixedRequest() {
	return {
		state: { project: "test" },
		questions: {
			verdict: {
				type: "choice" as const,
				instructions: "pick",
				criteria: { ship: "fine", hold: "wait" },
			},
			green: {
				type: "bool" as const,
				instructions: "tests?",
				criteria: { true: "y", false: "n" },
			},
			severity: {
				type: "score" as const,
				instructions: "rate",
				criteria: ["low", "high"],
			},
		},
	};
}

test.after(() => {
	delete (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
});

// ---------------------------------------------------------------------------
// 9.1: service handle publish + identity-checked dispose
// ---------------------------------------------------------------------------

test("handle published after registry bind and cleared on shutdown (identity-checked)", async () => {
	await withAgentDir(async () => {
		chatModels = [chatModel("fake", "alpha")];
		const { fire } = await freshExtension();
		const holder = globalThis as Record<symbol, unknown>;
		delete holder[SERVICE_KEY];
		await fire("session_start");
		const service = getJudgmentService();
		assert.ok(service, "service handle published after session_start");
		assert.equal(service.version, 1);

		// A replacement instance's handle must survive our shutdown.
		const replacement = {
			version: 1,
			judge: async () => ({}) as never,
			availability: async () => ({}),
		};
		holder[SERVICE_KEY] = replacement;
		await fire("session_shutdown");
		assert.equal(
			holder[SERVICE_KEY],
			replacement,
			"identity check: replacement handle kept",
		);
	});
});

test("consumer load-before-service sees undefined until activation", async () => {
	await withAgentDir(async () => {
		const holder = globalThis as Record<symbol, unknown>;
		delete holder[SERVICE_KEY];
		assert.equal(getJudgmentService(), undefined);
		chatModels = [chatModel("fake", "alpha")];
		const { fire } = await freshExtension();
		await fire("session_start");
		assert.ok(getJudgmentService());
	});
});

// ---------------------------------------------------------------------------
// 9.1 + parent source fix: the service consumes the ADAPTED registry and
// really dispatches through the host facade's classify.
// ---------------------------------------------------------------------------

test("judge() dispatches through the adapted registry to the host classify", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({
				mode: "classifier",
				classifierModel: "native/kev-2.1",
				classifierProvider: "native",
				classifierModelId: "kev-2.1",
				model: "fake/alpha",
				thinkingLevel: "off",
			}),
		);
		chatModels = [chatModel("fake", "alpha")];
		nativeModels = [nativeModel("native", "kev-2.1")];
		nativeAnswers = {
			verdict: {
				type: "choice",
				choice: "ship",
				probabilities: { ship: 1, hold: 0 },
				confidence: 0.9,
			},
			green: { type: "bool", probability: 0.8 },
			severity: { type: "score", score: 1, confidence: 0.85 },
		};
		const { fire } = await freshExtension();
		await fire("session_start");
		const service = getJudgmentService();
		assert.ok(service);

		const result = await service.judge(mixedRequest());
		assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
		assert.equal(result.backend, "classifier");
		// Correct model identity reported and actually dispatched.
		assert.equal(result.model, "native/kev-2.1");
		assert.equal(nativeCalls.length, 1);
		assert.equal(nativeCalls[0]?.model, "native/kev-2.1");
		assert.deepEqual(nativeCalls[0]?.questions, [
			"verdict",
			"green",
			"severity",
		]);
		assert.equal(result.answers.verdict.type, "choice");
		// Threshold policy applies to native numeric fields.
		const strict = await service.judge(mixedRequest(), {
			minConfidence: 0.99,
		});
		assert.equal(strict.backend, "classifier");
		assert.equal(strict.reuse.sent, 0); // cache hit, no second dispatch
		assert.deepEqual([...strict.dropped].sort(), [
			"green",
			"severity",
			"verdict",
		]);
	});
});

test("availability() reports classifier and llm slots through the adapted registry", async () => {
	await withAgentDir(async () => {
		chatModels = [chatModel("fake", "alpha")];
		nativeModels = [nativeModel("native", "jev-1.13")];
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({ model: "fake/alpha", thinkingLevel: "off" }),
		);
		const { fire } = await freshExtension();
		await fire("session_start");
		const service = getJudgmentService();
		assert.ok(service);
		const availability = await service.availability();
		assert.equal(availability.classifier, "native/jev-1.13");
		assert.equal(availability.llm, "fake/alpha");
	});
});

// ---------------------------------------------------------------------------
// 9.1: config diagnostics once per session
// ---------------------------------------------------------------------------

test("invalid config diagnostics are reported exactly once per session", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({ mode: "turbo", model: "no-slash" }),
		);
		chatModels = [chatModel("fake", "alpha")];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		await fire("session_start");
		const warnings = pi.uiNotifications.filter((n) =>
			n.message.includes("llm-as-jev.json"),
		);
		assert.equal(warnings.length, 2); // one per invalid key, once
		assert.match(warnings[0]?.message ?? "", /unknown mode/);
		assert.match(warnings[1]?.message ?? "", /provider\/modelid/);
		// Clean config produces no diagnostics.
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({ mode: "auto" }),
		);
		const { pi: pi2, fire: fire2 } = await freshExtension();
		await fire2("session_start");
		assert.equal(
			pi2.uiNotifications.filter((n) => n.message.includes("llm-as-jev.json"))
				.length,
			0,
		);
	});
});

// ---------------------------------------------------------------------------
// 8.1: mode command persists (classifier mode; no jev alias)
// ---------------------------------------------------------------------------

test("/llm-as-jev mode persists auto-llm and a return to auto", async () => {
	await withAgentDir(async () => {
		chatModels = [chatModel("fake", "alpha")];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		await handler.handler("mode classifier", pi.makeCtx());
		await handler.handler("mode auto-llm", pi.makeCtx());
		let raw = JSON.parse(
			await fs.readFile(path.join(agentDir!, "llm-as-jev.json"), "utf8"),
		);
		assert.equal(raw.mode, "auto-llm");
		// Round trip: auto-llm → auto restores the default preference.
		await handler.handler("mode auto", pi.makeCtx());
		raw = JSON.parse(
			await fs.readFile(path.join(agentDir!, "llm-as-jev.json"), "utf8"),
		);
		assert.equal(raw.mode, "auto");
		// Model slots and thinking stay untouched by mode switches.
		assert.equal(raw.thinkingLevel, "off");
	});
});

test("invalid mode (including the old jev alias) shows usage, writes nothing", async () => {
	await withAgentDir(async () => {
		chatModels = [chatModel("fake", "alpha")];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		for (const bad of ["jev", "turbo"]) {
			await handler.handler(`mode ${bad}`, pi.makeCtx());
			assert.match(
				pi.uiNotifications[pi.uiNotifications.length - 1]?.message ?? "",
				/Usage: \/llm-as-jev mode/,
			);
		}
		await assert.rejects(
			fs.readFile(path.join(agentDir!, "llm-as-jev.json")),
			/ENOENT/,
		);
	});
});

// ---------------------------------------------------------------------------
// Read-only overview: bare command and `status` share one snapshot.
// ---------------------------------------------------------------------------

test("bare command and `status` show the overview without picker, write or inference", async () => {
	await withAgentDir(async () => {
		chatModels = [chatModel("fake", "alpha")];
		nativeModels = [nativeModel("typesafe", "jev-1.13")];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		for (const args of ["", "status", "  status  "]) {
			pi.uiNotifications.length = 0;
			pi.customCalls = 0;
			await handler.handler(args, pi.makeCtx());
			assert.equal(pi.customCalls, 0, `no picker for ${JSON.stringify(args)}`);
			const overview = pi.uiNotifications.find((n) =>
				n.message.startsWith("LLM-as-Jev\n"),
			);
			assert.ok(overview, "overview emitted");
			assert.equal(overview.type, "info");
			assert.match(overview.message, /^Mode\s+Auto\(classifier\)$/m);
			assert.match(
				overview.message,
				/^Classifier\s+Jev \(default: typesafe\/jev-1\.13\)$/m,
			);
			assert.match(overview.message, /^LLM\s+None$/m);
			assert.match(overview.message, /^Thinking\s+off$/m);
			// No missing-backend warning while default Jev is usable.
			assert.ok(
				pi.uiNotifications.every((n) => n.type !== "warning"),
				"no warning when default Jev is usable",
			);
		}
		// Read-only: no settings file, no inference, no llm open side effects.
		await assert.rejects(
			fs.readFile(path.join(agentDir!, "llm-as-jev.json")),
			/ENOENT/,
			"status must not create a missing settings file",
		);
		assert.equal(nativeCalls.length, 0, "no native inference dispatched");
		assert.equal(llmCalls, 0, "no LLM inference dispatched");
	});
});

test("service unbound: overview reports runtime-not-ready, no writes", async () => {
	await withAgentDir(async () => {
		const { pi } = await freshExtension(); // no session_start: never bound
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		await handler.handler("status", pi.makeCtx());
		assert.match(
			pi.uiNotifications[pi.uiNotifications.length - 1]?.message ?? "",
			/runtime not ready/,
		);
		await assert.rejects(
			fs.readFile(path.join(agentDir!, "llm-as-jev.json")),
			/ENOENT/,
		);
	});
});

test("overview shows Auto(llm) without picker, writes or inference", async () => {
	await withAgentDir(async () => {
		const configPath = path.join(agentDir!, "llm-as-jev.json");
		const before = JSON.stringify({
			model: "fake/alpha",
			thinkingLevel: "off",
		});
		await fs.writeFile(configPath, before);
		chatModels = [chatModel("fake", "alpha")];
		nativeModels = []; // no Jev candidate
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		for (const args of ["", "status"]) {
			pi.uiNotifications.length = 0;
			await handler.handler(args, pi.makeCtx({ mode: "rpc" }));
			const overview = pi.uiNotifications.find((n) =>
				n.message.startsWith("LLM-as-Jev\n"),
			);
			assert.ok(overview);
			assert.match(overview.message, /^Mode\s+Auto\(llm\)$/m);
			assert.match(overview.message, /^Classifier\s+Jev \(unavailable\)$/m);
			assert.match(overview.message, /^LLM\s+fake\/alpha$/m);
			assert.ok(pi.uiNotifications.every((n) => n.type !== "warning"));
			assert.equal(pi.customCalls, 0);
			assert.equal(nativeCalls.length, 0, "no native inference dispatched");
			assert.equal(llmCalls, 0, "no LLM inference dispatched");
			assert.equal(await fs.readFile(configPath, "utf8"), before);
		}
	});
});

test("Auto(None) warns to configure either backend without claiming quota checks", async () => {
	await withAgentDir(async () => {
		chatModels = [];
		nativeModels = [];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		await handler.handler("", pi.makeCtx());
		const overview = pi.uiNotifications.find((n) =>
			n.message.startsWith("LLM-as-Jev\n"),
		);
		assert.ok(overview);
		assert.match(overview.message, /^Mode\s+Auto\(None\)$/m);
		assert.match(overview.message, /^Classifier\s+Jev \(unavailable\)$/m);
		assert.match(overview.message, /^LLM\s+None$/m);
		const warning = pi.uiNotifications.find((n) => n.type === "warning");
		assert.ok(warning, "missing-backend warning emitted");
		assert.match(warning.message, /\/llm-as-jev classifier/);
		assert.match(warning.message, /\/llm-as-jev llm/);
		assert.doesNotMatch(warning.message, /quota/i);
		assert.equal(pi.customCalls, 0);
	});
});

test("configured-but-uncredentialed LLM retains its reference as unavailable", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({ model: "ghost/turbo" }),
		);
		chatModels = [chatModel("ghost", "turbo")]; // in catalog, no auth
		nativeModels = [];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		await handler.handler("status", pi.makeCtx());
		const overview = pi.uiNotifications.find((n) =>
			n.message.startsWith("LLM-as-Jev\n"),
		);
		assert.ok(overview);
		assert.match(overview.message, /^Mode\s+Auto\(None\)$/m);
		assert.match(overview.message, /^LLM\s+ghost\/turbo \(unavailable\)$/m);
		// Credentials never leak into the overview or warning text.
		assert.ok(
			pi.uiNotifications.every(
				(n) => !/pseudo-native-key|emulated/.test(n.message),
			),
		);
		assert.ok(pi.uiNotifications.some((n) => n.type === "warning"));
	});
});

test("forced classifier mode warns and never claims the usable LLM is active", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({
				mode: "classifier",
				classifierModel: "native/gone-1",
				model: "fake/alpha",
			}),
		);
		chatModels = [chatModel("fake", "alpha")];
		nativeModels = [nativeModel("native", "jev-1.13")]; // other native exists
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		await handler.handler("status", pi.makeCtx());
		const overview = pi.uiNotifications.find((n) =>
			n.message.startsWith("LLM-as-Jev\n"),
		);
		assert.ok(overview);
		assert.match(overview.message, /^Mode\s+Classifier$/m);
		assert.match(
			overview.message,
			/^Classifier\s+native\/gone-1 \(unavailable\)$/m,
		);
		assert.match(overview.message, /^LLM\s+fake\/alpha$/m);
		assert.doesNotMatch(overview.message, /Auto\(/);
		const warning = pi.uiNotifications.find((n) => n.type === "warning");
		assert.ok(warning);
		assert.match(warning.message, /\/llm-as-jev classifier/);
		// Never claims the other native model or the LLM will be selected.
		assert.doesNotMatch(
			overview.message + (warning?.message ?? ""),
			/jev-1\.13/,
		);
	});
});

test("forced llm mode warns about the required LLM despite a usable classifier", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({ mode: "llm", model: "ghost/turbo" }),
		);
		chatModels = []; // configured LLM absent from the catalog
		nativeModels = [nativeModel("typesafe", "jev-1.13")];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		await handler.handler("status", pi.makeCtx());
		const overview = pi.uiNotifications.find((n) =>
			n.message.startsWith("LLM-as-Jev\n"),
		);
		assert.ok(overview);
		assert.match(overview.message, /^Mode\s+LLM$/m);
		assert.match(overview.message, /^LLM\s+ghost\/turbo \(unavailable\)$/m);
		const warning = [...pi.uiNotifications]
			.reverse()
			.find((n) => n.type === "warning");
		assert.ok(warning);
		assert.match(warning.message, /\/llm-as-jev llm/);
		assert.match(warning.message, /never uses the classifier/);
	});
});

test("status reports an unavailable explicit classifier without claiming another", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({
				mode: "auto",
				classifierModel: "native/gone-1",
				model: "fake/alpha",
			}),
		);
		chatModels = [chatModel("fake", "alpha")];
		nativeModels = [nativeModel("native", "jev-1.13")];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		await handler.handler("status", pi.makeCtx({ mode: "rpc" }));
		const overview = pi.uiNotifications.find((n) =>
			n.message.startsWith("LLM-as-Jev\n"),
		);
		assert.ok(overview);
		// Explicit unavailable selection kept; usable LLM drives Auto(llm).
		assert.match(
			overview.message,
			/^Classifier\s+native\/gone-1 \(unavailable\)$/m,
		);
		assert.match(overview.message, /^Mode\s+Auto\(llm\)$/m);
		// Never claims the other native model will be selected.
		assert.doesNotMatch(overview.message, /jev-1\.13/);
	});
});

// ---------------------------------------------------------------------------
// Command discoverability: description, completions, alias removal, usage.
// ---------------------------------------------------------------------------

test("only /llm-as-jev is registered; the classifier alias is gone", async () => {
	await withAgentDir(async () => {
		const { pi } = await freshExtension();
		assert.ok(pi.commands.get("llm-as-jev"));
		assert.equal(
			pi.commands.get("llm-as-jev-classifier"),
			undefined,
			"former alias must not be registered",
		);
		assert.equal(pi.commands.size, 1, "single command tree");
	});
});

test("completions offer every subcommand on empty prefix and filter `ll`", async () => {
	await withAgentDir(async () => {
		const { pi } = await freshExtension();
		const command = pi.commands.get("llm-as-jev") as unknown as {
			getArgumentCompletions(prefix: string): { value: string }[] | null;
		};
		const completions = (prefix: string): { value: string }[] =>
			command.getArgumentCompletions(prefix) ?? [];
		assert.deepEqual(
			completions("").map((o) => o.value),
			[
				"status",
				"llm",
				"classifier",
				"mode auto",
				"mode auto-llm",
				"mode classifier",
				"mode llm",
			],
		);
		assert.deepEqual(
			completions("ll").map((o) => o.value),
			["llm"],
		);
		assert.deepEqual(
			completions("mode ").map((o) => o.value),
			["mode auto", "mode auto-llm", "mode classifier", "mode llm"],
		);
		assert.deepEqual(
			completions("mode auto").map((o) => o.value),
			["mode auto", "mode auto-llm"],
		);
		assert.deepEqual(completions("zzz"), []);
	});
});

test("description and unknown-argument usage name all entries, not the alias", async () => {
	await withAgentDir(async () => {
		const { pi, fire } = await freshExtension();
		const command = pi.commands.get("llm-as-jev") as unknown as {
			description: string;
		};
		for (const word of [
			"status",
			"llm picker",
			"classifier picker",
			"mode <auto|auto-llm|classifier|llm>",
		]) {
			assert.ok(
				command.description.includes(word),
				`description mentions ${word}`,
			);
		}
		chatModels = [chatModel("fake", "alpha")];
		await fire("session_start");
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		await handler.handler("bogus", pi.makeCtx({ mode: "rpc" }));
		const usage = pi.uiNotifications[pi.uiNotifications.length - 1];
		assert.match(usage?.message ?? "", /Unknown argument "bogus"/);
		assert.match(usage?.message ?? "", /\[status\]\s+\|/);
		assert.match(usage?.message ?? "", /\|\s+llm\s+\|/);
		assert.match(usage?.message ?? "", /\|\s+classifier\s+\|/);
		assert.match(
			usage?.message ?? "",
			/mode <auto\|auto-llm\|classifier\|llm>/,
		);
		// The removed alias is never advertised.
		assert.doesNotMatch(usage?.message ?? "", /llm-as-jev-classifier/);
		assert.doesNotMatch(command.description, /llm-as-jev-classifier/);
		await assert.rejects(
			fs.readFile(path.join(agentDir!, "llm-as-jev.json")),
			/ENOENT/,
			"unknown argument changes no settings",
		);
	});
});

// ---------------------------------------------------------------------------
// 8.2/8.3: chat pickers via `/llm-as-jev llm` — cancel, confirm, re-registration
// ---------------------------------------------------------------------------

test("cancel at the chat model picker leaves disk and memory unchanged", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({
				model: "fake/alpha",
				thinkingLevel: "off",
				mode: "auto",
			}),
		);
		chatModels = [chatModel("fake", "alpha"), chatModel("fake", "beta")];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		assert.equal(pi.registeredProviders.length, 1);
		pi.nextCustom((done) => done(undefined)); // Esc on model picker
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		await handler.handler("llm", pi.makeCtx());
		const raw = JSON.parse(
			await fs.readFile(path.join(agentDir!, "llm-as-jev.json"), "utf8"),
		);
		assert.equal(raw.model, "fake/alpha");
		assert.equal(raw.thinkingLevel, "off");
		assert.equal(pi.registeredProviders.length, 1);
		assert.equal(pi.customCalls, 1);
	});
});

test("cancel at the level picker leaves nothing saved, including the pending model", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({ model: "fake/alpha", thinkingLevel: "off" }),
		);
		chatModels = [
			chatModel("fake", "alpha", true),
			chatModel("fake", "beta", true),
		];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		let call = 0;
		pi.nextCustom((done) => {
			call += 1;
			done(call === 1 ? "fake/beta" : undefined); // model ok, level cancel
		});
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		await handler.handler("llm", pi.makeCtx());
		const raw = JSON.parse(
			await fs.readFile(path.join(agentDir!, "llm-as-jev.json"), "utf8"),
		);
		assert.equal(raw.model, "fake/alpha");
		assert.equal(raw.thinkingLevel, "off");
		assert.equal(pi.registeredProviders.length, 1);
	});
});

test("chat confirm persists model+level, refreshes provider metadata and leaves classifierModel alone", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({
				model: "fake/alpha",
				thinkingLevel: "off",
				classifierModel: "native/kev-2.1",
			}),
		);
		chatModels = [chatModel("fake", "alpha"), chatModel("fake", "beta", true)];
		nativeModels = [nativeModel("native", "kev-2.1")];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		assert.equal(pi.registeredProviders.length, 1);

		let customIndex = 0;
		const answers = ["fake/beta", "high"];
		pi.nextCustom((done) => done(answers[customIndex++]));
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		await handler.handler("llm", pi.makeCtx());

		const raw = JSON.parse(
			await fs.readFile(path.join(agentDir!, "llm-as-jev.json"), "utf8"),
		);
		assert.equal(raw.model, "fake/beta");
		assert.equal(raw.thinkingLevel, "high");
		assert.equal(raw.classifierModel, "native/kev-2.1");
		assert.deepEqual(pi.unregistered, []);
		assert.equal(pi.registeredProviders.length, 1);
		assert.equal(
			pi.registeredProviders[0].getAllModels?.()[0]?.id,
			"fake/beta",
		);
	});
});

// ---------------------------------------------------------------------------
// 8.4: native classifier picker
// ---------------------------------------------------------------------------

test("/llm-as-jev classifier selects a non-Jev native model without touching chat", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({ model: "fake/alpha", thinkingLevel: "off" }),
		);
		chatModels = [chatModel("fake", "alpha")];
		nativeModels = [
			nativeModel("native", "jev-1.13"),
			nativeModel("native", "kev-2.1"),
		];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		pi.nextCustom((done) => done("native/kev-2.1"));
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		await handler.handler("classifier", pi.makeCtx());
		const raw = JSON.parse(
			await fs.readFile(path.join(agentDir!, "llm-as-jev.json"), "utf8"),
		);
		assert.equal(raw.classifierModel, "native/kev-2.1");
		assert.equal(raw.model, "fake/alpha");
		assert.equal(raw.thinkingLevel, "off");
		// No provider re-registration: emulated identity depends only on chat.
		assert.equal(pi.registeredProviders.length, 1);
		assert.deepEqual(pi.unregistered, []);
	});
});

test("classifier selection changes the NEXT native judgment immediately", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({ model: "fake/alpha", thinkingLevel: "off" }),
		);
		chatModels = [chatModel("fake", "alpha")];
		nativeModels = [
			nativeModel("native", "jev-1.13"),
			nativeModel("native", "kev-2.1"),
		];
		nativeAnswers = {
			verdict: {
				type: "choice",
				choice: "ship",
				probabilities: { ship: 1, hold: 0 },
				confidence: 0.9,
			},
			green: { type: "bool", probability: 0.8 },
			severity: { type: "score", score: 1, confidence: 0.85 },
		};
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		const service = getJudgmentService();
		assert.ok(service);
		// Default discovery: jev answers the first request.
		let result = await service.judge(mixedRequest());
		assert.equal(result.backend, "classifier");
		assert.equal(result.model, "native/jev-1.13");
		// Picker: select the non-Jev model.
		pi.nextCustom((done) => done("native/kev-2.1"));
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		await handler.handler("classifier", pi.makeCtx());
		// Next judgment uses the selection, same process, no reload.
		result = await service.judge({
			...mixedRequest(),
			state: { project: "x2" },
		});
		assert.equal(result.backend, "classifier");
		assert.equal(result.model, "native/kev-2.1");
		assert.equal(nativeCalls[nativeCalls.length - 1]?.model, "native/kev-2.1");
	});
});

test("classifier picker cancel leaves disk and memory unchanged", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({ model: "fake/alpha", thinkingLevel: "off" }),
		);
		chatModels = [chatModel("fake", "alpha")];
		nativeModels = [nativeModel("native", "jev-1.13")];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		pi.nextCustom((done) => done(undefined));
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		await handler.handler("classifier", pi.makeCtx());
		const raw = JSON.parse(
			await fs.readFile(path.join(agentDir!, "llm-as-jev.json"), "utf8"),
		);
		assert.equal(raw.classifierModel, undefined);
		assert.equal(raw.model, "fake/alpha");
	});
});

test("classifier picker with an empty available list notifies and writes nothing", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({ model: "fake/alpha", thinkingLevel: "off" }),
		);
		chatModels = [chatModel("fake", "alpha")];
		nativeModels = [];
		let customCalls = 0;
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		const ctx = pi.makeCtx({
			ui: {
				notify: (message: string, type?: string) =>
					pi.uiNotifications.push({ message, type }),
				custom: async () => {
					customCalls += 1;
					return undefined;
				},
			},
		});
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		await handler.handler("classifier", ctx);
		assert.equal(customCalls, 0);
		assert.match(
			pi.uiNotifications[pi.uiNotifications.length - 1]?.message ?? "",
			/No compatible native classifiers available/,
		);
	});
});

test("classifier mode with unavailable explicit selection errors without substitution", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({
				mode: "classifier",
				classifierModel: "native/gone-1",
				model: "fake/alpha",
				thinkingLevel: "off",
			}),
		);
		chatModels = [chatModel("fake", "alpha")];
		nativeModels = [nativeModel("native", "jev-1.13")];
		const { fire } = await freshExtension();
		await fire("session_start");
		const service = getJudgmentService();
		assert.ok(service);
		const result = await service.judge(mixedRequest());
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /native\/gone-1/);
		assert.equal(nativeCalls.length, 0); // never dispatched to jev instead
	});
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("unknown catalog chat model behaves unconfigured", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({ model: "gone/model", mode: "llm" }),
		);
		chatModels = [chatModel("fake", "alpha")];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		await fire("session_tree");
		assert.equal(
			pi.uiNotifications.filter((n) =>
				/configured chat model.*not in/.test(n.message),
			).length,
			1,
		);
		const service = getJudgmentService();
		assert.ok(service);
		const result = await service.judge(mixedRequest());
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /no LLM model is configured/);
	});
});

test("no custom UI is requested outside TUI mode", async () => {
	await withAgentDir(async () => {
		chatModels = [chatModel("fake", "alpha")];
		nativeModels = [nativeModel("typesafe", "jev-1.13")];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		let customCalls = 0;
		const ctx = pi.makeCtx({
			mode: "print",
			hasUI: false,
			ui: {
				notify: (message: string, type?: string) =>
					pi.uiNotifications.push({ message, type }),
				custom: async () => {
					customCalls += 1;
					return undefined;
				},
			},
		});
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		// Bare command in print mode: read-only overview, never a picker.
		await handler.handler("", ctx);
		assert.equal(customCalls, 0, "guard: no custom UI in non-TUI mode");
		assert.ok(
			pi.uiNotifications.some((n) => n.message.startsWith("LLM-as-Jev\n")),
			"non-TUI still gets the overview",
		);
		// Explicit picker entries are guarded too.
		for (const sub of ["llm", "classifier"]) {
			await handler.handler(sub, ctx);
			assert.equal(customCalls, 0, `no custom UI for ${sub}`);
			assert.match(
				pi.uiNotifications[pi.uiNotifications.length - 1]?.message ?? "",
				/needs the interactive TUI/,
			);
		}
	});
});

test("retained production handle reads each admission once and preserves overlapping snapshots", async () => {
	await withAgentDir(async () => {
		const file = path.join(agentDir!, "llm-as-jev.json");
		const save = (id: string) =>
			fs.writeFile(
				file,
				JSON.stringify({ mode: "classifier", classifierModel: `native/${id}` }),
			);
		await save("x");
		nativeModels = [nativeModel("native", "x"), nativeModel("native", "y")];
		nativeAnswers = { green: { type: "bool", probability: 0.9 } };
		const { pi, fire } = await freshExtension();
		let entered!: () => void;
		const admission = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const original = fakeHost.classify;
		fakeHost.classify = async (model, context) => {
			if (model.id === "x") {
				entered();
				await barrier;
			}
			return original(model, context);
		};
		const request = {
			state: {},
			questions: { green: mixedRequest().questions.green },
		};
		try {
			await fire("session_start");
			const handle = getJudgmentService()!;
			const old = handle.judge(request);
			await admission;
			await save("y");
			const fresh = handle.judge(request);
			release();
			const next = await fresh;
			assert.equal(next.model, "native/y");
			assert.equal(next.stopReason, "stop");
			assert.equal((await old).model, "native/x");
			assert.equal(getJudgmentService(), handle);
			assert.deepEqual(await handle.availability(), { classifier: "native/y" });
			const calls = nativeCalls.length;
			assert.equal((await handle.judge(request)).reuse.hits, 1);
			assert.equal(
				nativeCalls.length,
				calls,
				"refresh preserves identity-qualified cache",
			);
			assert.ok(pi.entries.length > 0, "refresh preserves ledger writes");
		} finally {
			release();
			fakeHost.classify = original;
			await fire("session_shutdown");
		}
	});
});

test("status, guidance and native picker read external saves on their first operation", async () => {
	await withAgentDir(async () => {
		const file = path.join(agentDir!, "llm-as-jev.json");
		nativeModels = [nativeModel("native", "x"), nativeModel("native", "y")];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		const command = pi.commands.get("llm-as-jev")!;
		for (const args of ["", "status", "mode invalid", "classifier"]) {
			await fs.writeFile(
				file,
				JSON.stringify({ mode: "classifier", classifierModel: "native/y" }),
			);
			const before = await fs.readFile(file, "utf8");
			pi.uiNotifications.length = 0;
			if (args === "classifier") {
				const ctx = pi.makeCtx() as { ui: { custom: unknown } };
				ctx.ui.custom = async (
					factory: (
						tui: unknown,
						theme: unknown,
						keys: unknown,
						done: (v: string | undefined) => void,
					) => { handleInput(data: string): void },
				) => {
					let selected: string | undefined;
					factory(undefined, undefined, undefined, (v) => {
						selected = v;
					}).handleInput("\r");
					assert.equal(
						selected,
						"native/y",
						"native preselection uses the latest file",
					);
					return undefined; // inspect selection, cancel without persistence
				};
				await command.handler(args, ctx as never);
			} else {
				await command.handler(args, pi.makeCtx());
				assert.match(
					pi.uiNotifications.map((n) => n.message).join("\n"),
					args.startsWith("mode") ? /current: classifier/ : /native\/y/,
				);
			}
			assert.equal(await fs.readFile(file, "utf8"), before);
			await fs.writeFile(
				file,
				JSON.stringify({ mode: "llm", classifierModel: "native/x" }),
			);
		}
		assert.equal(nativeCalls.length + llmCalls, 0);
	});
});

test("status rows and availability share one snapshot across discovery", async () => {
	await withAgentDir(async () => {
		const file = path.join(agentDir!, "llm-as-jev.json");
		await fs.writeFile(
			file,
			JSON.stringify({ mode: "classifier", classifierModel: "native/x" }),
		);
		nativeModels = [nativeModel("native", "x"), nativeModel("native", "y")];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		let entered!: () => void;
		const admission = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const original = fakeHost.getAvailableOfType;
		fakeHost.getAvailableOfType = async (type) => {
			entered();
			await barrier;
			return original(type);
		};
		try {
			const status = pi.commands
				.get("llm-as-jev")!
				.handler("status", pi.makeCtx());
			await admission;
			await fs.writeFile(
				file,
				JSON.stringify({ mode: "classifier", classifierModel: "native/y" }),
			);
			release();
			await status;
			const text = pi.uiNotifications.map((n) => n.message).join("\n");
			assert.match(text, /native\/x/);
			assert.doesNotMatch(text, /native\/y/);
		} finally {
			release();
			fakeHost.getAvailableOfType = original;
		}
	});
});

test("running extension defaults on invalid/unreadable/missing settings and recovers once warned", async () => {
	await withAgentDir(async () => {
		const file = path.join(agentDir!, "llm-as-jev.json");
		nativeModels = [nativeModel("native", "x")];
		await fs.writeFile(
			file,
			JSON.stringify({ mode: "classifier", classifierModel: "native/x" }),
		);
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		const handle = getJudgmentService()!;
		assert.equal((await handle.availability()).classifier, "native/x");
		await fs.writeFile(file, '{"classifierModel":"native/x","mode":"bad"}');
		assert.deepEqual(await handle.availability(), {});
		assert.equal(
			pi.uiNotifications.filter((n) => /using default settings/.test(n.message))
				.length,
			1,
		);
		await fs.rm(file);
		await fs.mkdir(file);
		assert.deepEqual(await handle.availability(), {});
		await fs.rmdir(file);
		assert.deepEqual(await handle.availability(), {});
		await fs.writeFile(
			file,
			JSON.stringify({ mode: "classifier", classifierModel: "native/x" }),
		);
		assert.equal((await handle.availability()).classifier, "native/x");
		assert.equal(
			pi.uiNotifications.filter((n) => /using default settings/.test(n.message))
				.length,
			1,
		);
		assert.equal(getJudgmentService(), handle);
		assert.equal(nativeCalls.length + llmCalls, 0);
	});
});

for (const cancelAt of [0, 1, 2]) {
	test(`open LLM dialog preserves a later save (cancel step ${cancelAt || "confirm"})`, async () => {
		await withAgentDir(async () => {
			const file = path.join(agentDir!, "llm-as-jev.json");
			await fs.writeFile(
				file,
				JSON.stringify({ model: "fake/beta", thinkingLevel: "high" }),
			);
			chatModels = [
				chatModel("fake", "alpha", true),
				chatModel("fake", "beta", true),
			];
			const { pi, fire } = await freshExtension();
			await fire("session_start");
			// The next operation must preselect the externally saved model/level.
			await fs.writeFile(
				file,
				JSON.stringify({ model: "fake/alpha", thinkingLevel: "low" }),
			);
			const later = {
				mode: "classifier",
				classifierModel: "native/y",
				model: "fake/beta",
				thinkingLevel: "high",
				timeoutMs: 2500,
				unknown: { keep: true },
			};
			let step = 0;
			const ctx = pi.makeCtx() as { ui: { custom: unknown } };
			ctx.ui.custom = async (
				factory: (
					tui: unknown,
					theme: unknown,
					keys: unknown,
					done: (v: string | undefined) => void,
				) => { handleInput(data: string): void },
			) => {
				step += 1;
				if (step === 1) await fs.writeFile(file, JSON.stringify(later));
				let selected: string | undefined;
				factory(undefined, undefined, undefined, (v) => {
					selected = v;
				}).handleInput("\r");
				assert.equal(
					selected,
					step === 1 ? "fake/alpha" : "low",
					"open interaction retains its own preselection",
				);
				return cancelAt === step ? undefined : selected;
			};
			await pi.commands.get("llm-as-jev")!.handler("llm", ctx as never);
			const actual = JSON.parse(await fs.readFile(file, "utf8"));
			assert.deepEqual(
				actual,
				cancelAt
					? later
					: { ...later, model: "fake/alpha", thinkingLevel: "low" },
			);
			assert.equal(nativeCalls.length + llmCalls, 0);
		});
	});
}

test("failed dialog confirmation does not publish tentative settings", async () => {
	await withAgentDir(async () => {
		const file = path.join(agentDir!, "llm-as-jev.json");
		await fs.writeFile(
			file,
			JSON.stringify({ model: "fake/alpha", thinkingLevel: "off" }),
		);
		chatModels = [chatModel("fake", "alpha"), chatModel("fake", "beta", true)];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		const ctx = pi.makeCtx() as { ui: { custom: unknown } };
		let step = 0;
		ctx.ui.custom = async () => {
			if (++step === 1) return "fake/beta";
			await fs.rename(file, `${file}.saved`);
			await fs.mkdir(file); // deterministic rename failure, including for root
			return "high";
		};
		await pi.commands.get("llm-as-jev")!.handler("llm", ctx as never);
		assert.ok(
			pi.uiNotifications.some((notice) =>
				/could not save settings/.test(notice.message),
			),
		);
		assert.deepEqual(
			pi.registeredProviders[0].getAllModels?.(),
			[],
			"unreadable disk uses defaults, not a tentative beta selection",
		);
		await fs.rmdir(file);
		await fs.rename(`${file}.saved`, file);
		assert.equal(
			pi.registeredProviders[0].getAllModels?.()[0]?.id,
			"fake/alpha",
		);
	});
});

test("ledger append routes through two-argument appendEntry and branch restore runs", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({
				mode: "classifier",
				classifierModel: "native/kev-2.1",
				model: "fake/alpha",
				thinkingLevel: "off",
			}),
		);
		chatModels = [chatModel("fake", "alpha")];
		nativeModels = [nativeModel("native", "kev-2.1")];
		nativeAnswers = {
			verdict: {
				type: "choice",
				choice: "ship",
				probabilities: { ship: 1, hold: 0 },
				confidence: 0.9,
			},
			green: { type: "bool", probability: 0.8 },
			severity: { type: "score", score: 1, confidence: 0.85 },
		};
		const branch: unknown[] = [];
		const { pi, fire } = await freshExtension();
		const ctx = {
			modelRegistry: fakeHost,
			sessionManager: { getBranch: () => branch },
			ui: { notify: () => {} },
		};
		await fire("session_start", ctx);
		const service = getJudgmentService();
		assert.ok(service);
		await service.judge(mixedRequest());
		const judgments = pi.entries.filter(
			(e) =>
				e.type === "llm-as-jev-ledger" &&
				(e.data as { kind?: string }).kind === "judgment",
		);
		assert.equal(judgments.length, 3); // one per question
		// Branch replay: same branch entries on a navigation restore the cache.
		branch.push(
			...pi.entries.map((e) => ({
				type: "custom",
				customType: e.type,
				data: e.data,
			})),
		);
		await fire("session_tree", ctx);
		nativeCalls.length = 0;
		const resumed = await service.judge(mixedRequest());
		assert.equal(resumed.stopReason, "stop");
		assert.equal(nativeCalls.length, 0, "restored from ledger, no dispatch");
	});
});
