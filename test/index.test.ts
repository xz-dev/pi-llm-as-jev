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
	registeredProviders: { provider: string }[] = [];
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

	registerProvider(provider: { id: string }): void {
		this.registeredProviders.push({ provider: provider.id });
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
		throw new Error("llm path not exercised in this suite");
	},
};

/** Fake chat backend models including our own emulation entry. */
function resetCatalog(): void {
	chatModels = [];
	nativeModels = [];
	nativeCalls.length = 0;
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

test("/llm-as-jev mode classifier persists to the config file", async () => {
	await withAgentDir(async () => {
		chatModels = [chatModel("fake", "alpha")];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		await handler.handler("mode classifier", pi.makeCtx());
		const raw = JSON.parse(
			await fs.readFile(path.join(agentDir!, "llm-as-jev.json"), "utf8"),
		);
		assert.equal(raw.mode, "classifier");
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

test("status names mode, effective native candidate, llm and config path", async () => {
	await withAgentDir(async () => {
		await fs.writeFile(
			path.join(agentDir!, "llm-as-jev.json"),
			JSON.stringify({ model: "fake/alpha", thinkingLevel: "off" }),
		);
		chatModels = [chatModel("fake", "alpha")];
		nativeModels = [
			nativeModel("openrouter", "jev"),
			nativeModel("typesafe", "jev"),
		];
		const { pi, fire } = await freshExtension();
		await fire("session_start");
		const handler = pi.commands.get("llm-as-jev");
		assert.ok(handler);
		// Non-TUI: status only, no custom UI attempted.
		await handler.handler("", pi.makeCtx({ mode: "rpc", hasUI: true }));
		const status = pi.uiNotifications.find((n) =>
			/llm-as-jev: mode=/.test(n.message),
		);
		assert.ok(status, "status line emitted");
		assert.match(status.message, /mode=auto/);
		assert.match(status.message, /classifier=default jev \(typesafe\/jev\)/);
		assert.match(status.message, /llm=fake\/alpha @ off/);
		assert.match(
			status.message,
			new RegExp(agentDir!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
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
		const status = [...pi.uiNotifications]
			.reverse()
			.find((n) => /llm-as-jev: mode=/.test(n.message));
		assert.ok(status);
		assert.match(status.message, /classifier=native\/gone-1 \(unavailable\)/);
		assert.doesNotMatch(status.message, /auto→native\/jev-1\.13/);
	});
});

// ---------------------------------------------------------------------------
// 8.2/8.3: chat pickers — cancel, confirm, re-registration
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
		await handler.handler("", pi.makeCtx());
		const raw = JSON.parse(
			await fs.readFile(path.join(agentDir!, "llm-as-jev.json"), "utf8"),
		);
		assert.equal(raw.model, "fake/alpha");
		assert.equal(raw.thinkingLevel, "off");
		assert.equal(pi.registeredProviders.length, 1);
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
		await handler.handler("", pi.makeCtx());
		const raw = JSON.parse(
			await fs.readFile(path.join(agentDir!, "llm-as-jev.json"), "utf8"),
		);
		assert.equal(raw.model, "fake/alpha");
		assert.equal(raw.thinkingLevel, "off");
		assert.equal(pi.registeredProviders.length, 1);
	});
});

test("chat confirm persists model+level, re-registers and leaves classifierModel alone", async () => {
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
		await handler.handler("", pi.makeCtx());

		const raw = JSON.parse(
			await fs.readFile(path.join(agentDir!, "llm-as-jev.json"), "utf8"),
		);
		assert.equal(raw.model, "fake/beta");
		assert.equal(raw.thinkingLevel, "high");
		assert.equal(raw.classifierModel, "native/kev-2.1");
		// 7.2: unregister + register on chat-model change.
		assert.deepEqual(pi.unregistered, ["llm-as-jev", "llm-as-jev"]);
		assert.equal(pi.registeredProviders.length, 2);
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
		assert.deepEqual(pi.unregistered, ["llm-as-jev"]);
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
		const handler = pi.commands.get("llm-as-jev-classifier");
		assert.ok(handler);
		await handler.handler("", pi.makeCtx());
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
		const handler = pi.commands.get("llm-as-jev-classifier");
		assert.ok(handler);
		await handler.handler("", pi.makeCtx());
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
		const handler = pi.commands.get("llm-as-jev-classifier");
		assert.ok(handler);
		await handler.handler("", ctx);
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
		await handler.handler("", ctx);
		assert.equal(customCalls, 0, "guard: no custom UI in non-TUI mode");
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
