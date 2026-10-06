// Local native-host acceptance backend. Never reads real credentials or sends
// requests outside the test's loopback endpoint. Production entry loads separately.
import { appendFileSync } from "node:fs";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getJudgmentService } from "../../client/judgment-client.ts";
import { saveConfig } from "../../src/config.ts";

const base = process.env.JEV_FIXTURE_URL;
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } };
const native = (id) => ({ type: "classifier", provider: "refresh-native", id, name: id, api: "typesafe-system-one", baseUrl: base, input: ["text"], contextWindow: 100000, cost });
const chat = (id, provider = "refresh-chat") => ({ provider, id, name: id, api: "openai-completions", baseUrl: base, input: ["text"], contextWindow: id === "x" ? 8000 : 16000, maxTokens: 1000, reasoning: true, cost });
const auth = { apiKey: { check: async () => ({ type: "api_key", source: "fixture" }), resolve: async () => ({ auth: { apiKey: "local-test-only" }, source: "fixture" }) } };
const question = { type: "bool", instructions: "Fixture condition?", criteria: { true: "yes", false: "no" } };

export default function fixture(pi) {
	pi.registerProvider({
		id: "refresh-native", name: "Local native fixture", auth,
		getModels: () => [], getAllModels: () => [native("x"), native("y")],
		stream: () => { throw new Error("classifier only"); },
		streamSimple: () => { throw new Error("classifier only"); },
		classify: async (model, context, options) => {
			const response = await (options?.fetch ?? fetch)(`${base}/systemone`, {
				method: "POST", signal: options?.signal,
				body: JSON.stringify({ model: model.id, state: context.state, questions: Object.fromEntries(Object.entries(context.questions).map(([id, q]) => [id, { ...q, type: "noul" }])) }),
			});
			const body = await response.json();
			if (!response.ok) return { api: model.api, provider: model.provider, model: model.id, answers: {}, stopReason: "error", errorMessage: body.error?.code ?? "fixture error", timestamp: Date.now() };
			return { api: model.api, provider: model.provider, model: model.id, answers: Object.fromEntries(Object.entries(body.answers).map(([id, answer]) => [id, { type: "bool", probability: answer.noul }])), stopReason: "stop", timestamp: Date.now() };
		},
	});
	const stream = (model, _context, options) => {
		const events = new AssistantMessageEventStream();
		void (async () => {
			await fetch(`${base}/chat`, { method: "POST", signal: options?.signal, body: JSON.stringify({ model: model.id, reasoning: options?.reasoning }) });
			const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "toolCall", id: "fixture", name: "answer", arguments: { value: true } }], stopReason: "stop", usage, timestamp: Date.now() };
			events.push({ type: "done", reason: "stop", message });
			events.end(message);
		})().catch((error) => events.end({ role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "error", errorMessage: String(error), usage, timestamp: Date.now() }));
		return events;
	};
	pi.registerProvider({ id: "refresh-chat", name: "Local chat fixture", auth, getModels: () => [chat("x"), chat("y")], stream, streamSimple: stream });
	pi.registerProvider({ id: "refresh-noauth", name: "Unauthenticated fixture", auth: { apiKey: { check: async () => undefined, resolve: async () => undefined } }, getModels: () => [chat("z", "refresh-noauth")], stream, streamSimple: stream });
	let retained;
	let descriptor;
	let inFlight;
	pi.registerCommand("refresh-proof", {
		handler: async (args, ctx) => {
			const [operation, ...rest] = args.split(" ");
			let value;
			if (operation === "retain") {
				retained = getJudgmentService();
				descriptor = (await ctx.modelRegistry.getAvailableOfType("classifier")).find((m) => m.provider === "llm-as-jev");
				value = { ready: !!retained, descriptor: descriptor?.id };
			} else if (operation === "save") {
				value = (await saveConfig(JSON.parse(rest.join(" ")))).config;
			} else if (operation === "begin") {
				inFlight = retained.judge({ state: { operation: "judge", serial: "overlap" }, questions: { q: question } });
				value = { started: true };
			} else if (operation === "begin-review") {
				inFlight = retained.review({ state: { scenario: "review-overlap" }, questions: { q: question }, evidence: ["one", "two", "three"].map((id) => ({ id, text: `${id} recorded findings` })) });
				value = { started: true };
			} else if (operation === "collect") {
				value = await inFlight;
			} else if (operation === "staged") {
				value = await retained.review({ state: { scenario: "checkpoint" }, questions: { q: question }, evidence: ["one", "two", "three"].map((id) => ({ id, text: `${id} recorded findings` })) });
			} else if (operation === "availability") {
				value = await retained.availability();
			} else if (operation === "judge" || operation === "review") {
				value = await retained[operation]({ state: { operation, serial: rest[0] }, questions: { q: question }, ...(operation === "review" ? { evidence: [{ id: "fact", text: "Local acceptance evidence." }] } : {}) }, rest[1] ? { timeoutMs: Number(rest[1]) } : undefined);
			} else if (operation === "models") {
				value = (await ctx.modelRegistry.getAvailableOfType("classifier")).filter((m) => m.provider === "llm-as-jev").map((m) => ({ id: m.id, contextWindow: m.contextWindow }));
			} else if (operation === "classify") {
				value = await ctx.modelRegistry.classify(descriptor, { state: {}, questions: { q: question } });
			} else if (operation === "identity") {
				value = { same: getJudgmentService() === retained, descriptor: descriptor?.id };
			} else if (operation === "ready") {
				value = { ready: !!getJudgmentService() };
			} else if (operation === "exit") {
				ctx.shutdown();
				return;
			} else throw new Error("Unknown fixture operation");
			if (process.env.JEV_FIXTURE_OBSERVATIONS) appendFileSync(process.env.JEV_FIXTURE_OBSERVATIONS, JSON.stringify({ operation, value, pid: process.pid }) + "\n");
			ctx.ui.notify(`REFRESH_PROOF:${JSON.stringify(value)}`, "info");
		},
	});
}
