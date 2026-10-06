import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const hash = (file: string) =>
	createHash("sha256").update(readFileSync(file)).digest("hex");

test("native: live sessions refresh the actual candidate without priming or reload", {
	skip: process.env.JEV_NATIVE_REFRESH !== "1",
	timeout: 120_000,
}, async (t) => {
	const binary = process.env.JEV_PI_BIN;
	assert.ok(binary, "JEV_PI_BIN must identify the required target host");
	const dir = mkdtempSync("/var/tmp/jev-native-refresh-");
	console.log(`Native refresh evidence: ${dir}`);
	const version = execFileSync(binary, ["--version"], {
		encoding: "utf8",
	}).trim();
	assert.equal(version, "1.0.4-xz.265.1.g02d10232");
	const candidate = Object.fromEntries(
		readdirSync(join(root, "src"))
			.filter((f) => f.endsWith(".ts"))
			.map((f) => [f, hash(join(root, "src", f))]),
	);
	writeFileSync(
		join(dir, "identity.json"),
		JSON.stringify(
			{ binary, version, binaryHash: hash(binary), candidate },
			null,
			2,
		),
	);
	const requests: { path?: string; body: Record<string, unknown> }[] = [];
	let admitted!: () => void, release!: () => void;
	const admission = new Promise<void>((resolve) => {
		admitted = resolve;
	});
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	t.after(() => release());
	let reviewAdmitted!: () => void, releaseReview!: () => void;
	const reviewAdmission = new Promise<void>((resolve) => {
		reviewAdmitted = resolve;
	});
	const reviewBarrier = new Promise<void>((resolve) => {
		releaseReview = resolve;
	});
	t.after(() => releaseReview());
	let failThird = true;
	const server = createServer(async (request, response) => {
		let text = "";
		for await (const part of request) text += part;
		const body = JSON.parse(text);
		requests.push({ path: request.url, body });
		appendFileSync(
			join(dir, "requests.jsonl"),
			JSON.stringify(requests.at(-1)) + "\n",
		);
		response.setHeader("content-type", "application/json");
		if (body.model === "x" && body.state?.fixed?.serial === "overlap") {
			admitted();
			await barrier;
		}
		if (
			["checkpoint", "review-overlap"].includes(body.state?.fixed?.scenario)
		) {
			const pieces = body.state.evidence ?? [];
			if (
				body.state.fixed.scenario === "review-overlap" &&
				pieces.length === 1
			) {
				reviewAdmitted();
				await reviewBarrier;
			}
			const error =
				pieces.length > 1
					? "context_length_exceeded"
					: body.state.fixed.scenario === "checkpoint" &&
							failThird &&
							pieces.some((piece: { id: string }) =>
								piece.id.startsWith("three"),
							)
						? "invalid_payload"
						: undefined;
			if (error) {
				response.statusCode = 400;
				response.end(JSON.stringify({ error: { code: error } }));
				return;
			}
		}
		response.end(
			JSON.stringify({
				answers: Object.fromEntries(
					Object.keys(body.questions ?? {}).map((id) => [
						id,
						{ type: "noul", noul: 0.99 },
					]),
				),
				usage: { input_tokens: 12, output_tokens: 1 },
			}),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const settings = (id: string) => ({
		mode: "classifier",
		classifierModel: `refresh-native/${id}`,
		model: `refresh-chat/${id}`,
		thinkingLevel: "high",
		timeoutMs: 5000,
	});
	const agent = join(dir, "shared"),
		separate = join(dir, "separate");
	for (const path of [agent, separate]) {
		mkdirSync(path);
		writeFileSync(join(path, "llm-as-jev.json"), JSON.stringify(settings("x")));
		writeFileSync(join(path, "auth.json"), "{}");
		writeFileSync(
			join(path, "settings.json"),
			JSON.stringify({ lastChangelogVersion: version }),
		);
	}

	function session(name: string, agentDir: string) {
		const home = join(dir, name);
		for (const part of ["", "project", "tmp", "config", "cache", "data"])
			mkdirSync(join(home, part), { recursive: true });
		const env = {
			PATH: "/usr/bin:/bin",
			HOME: home,
			LANG: "C.UTF-8",
			TERM: "xterm-256color",
			PI_CODING_AGENT_DIR: agentDir,
			TMPDIR: join(home, "tmp"),
			XDG_CONFIG_HOME: join(home, "config"),
			XDG_CACHE_HOME: join(home, "cache"),
			XDG_DATA_HOME: join(home, "data"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
			GIT_TERMINAL_PROMPT: "0",
			NPM_CONFIG_USERCONFIG: join(home, "npmrc"),
			NPM_CONFIG_CACHE: join(home, "cache"),
			PI_OFFLINE: "1",
			JEV_FIXTURE_URL: base,
		};
		writeFileSync(join(home, "environment.json"), JSON.stringify(env, null, 2));
		const child = spawn(
			binary!,
			[
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"--no-themes",
				"--no-mcp",
				"-e",
				join(root, "test/fixtures/refresh-native.mjs"),
				"-e",
				join(root, "src/index.ts"),
			],
			{ cwd: join(home, "project"), env, stdio: ["pipe", "pipe", "pipe"] },
		);
		t.after(async () => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
				child.once("close", () => {
					clearTimeout(timer);
					resolve();
				});
				child.kill("SIGTERM");
			});
		});
		const pending = new Map<
			string,
			{ resolve(value: any): void; reject(error: Error): void }
		>();
		const events: any[] = [];
		let buffer = "",
			serial = 0;
		child.stderr.on("data", (chunk) =>
			appendFileSync(join(home, "stderr.log"), chunk),
		);
		child.stdout.on("data", (chunk) => {
			appendFileSync(join(home, "stdout.jsonl"), chunk);
			buffer += String(chunk);
			while (true) {
				const end = buffer.indexOf("\n");
				if (end < 0) break;
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				if (event.type === "response" && pending.has(event.id))
					pending.get(event.id)!.resolve(event);
				else events.push(event);
			}
		});
		child.once("close", (code) => {
			for (const request of pending.values())
				request.reject(
					new Error(`${name} exited ${code}; inspect ${home}/stderr.log`),
				);
		});
		async function rpc(type: string, message?: string) {
			const id = `${name}-${++serial}`;
			const result = await new Promise<any>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`RPC timeout: ${id} ${message ?? type}`));
				}, 15000);
				pending.set(id, {
					resolve: (value) => {
						clearTimeout(timer);
						pending.delete(id);
						resolve(value);
					},
					reject: (error) => {
						clearTimeout(timer);
						pending.delete(id);
						reject(error);
					},
				});
				child.stdin.write(
					JSON.stringify({ id, type, ...(message ? { message } : {}) }) + "\n",
				);
			});
			assert.equal(result.success, true, JSON.stringify(result));
			assert.deepEqual(
				events.filter((event) => event.type === "extension_error"),
				[],
			);
			if (type === "prompt") assert.equal(result.data?.disposition, "handled");
			return result;
		}
		return {
			env,
			rpc,
			async prompt(command: string) {
				const start = events.length;
				await rpc("prompt", command);
				return events
					.slice(start)
					.filter((event) => typeof event.message === "string")
					.map((event) => event.message as string);
			},
			async proof(command: string): Promise<any> {
				const messages = await this.prompt(`/refresh-proof ${command}`);
				const result = messages.find((message) =>
					message.startsWith("REFRESH_PROOF:"),
				);
				assert.ok(
					result,
					`missing result for ${command}: ${messages.join("\n")}`,
				);
				return JSON.parse(result.slice("REFRESH_PROOF:".length));
			},
		};
	}

	const a = session("A", agent),
		b = session("B", agent),
		c = session("C", separate);
	for (const runtime of [a, b, c]) {
		await runtime.rpc("get_commands");
		assert.deepEqual(await runtime.proof("retain"), {
			ready: true,
			descriptor: "refresh-chat/x",
		});
	}
	// Actual interactive host, not an RPC context pretending to support pickers.
	const tuiLog = join(dir, "tui.log"),
		proofLog = join(dir, "tui-proofs.jsonl");
	const tuiArgs = [
		binary,
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-themes",
		"--no-mcp",
		"-e",
		join(root, "test/fixtures/refresh-native.mjs"),
		"-e",
		join(root, "src/index.ts"),
	];
	const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
	const tui = spawn(
		"/usr/bin/script",
		["-qefc", `exec ${tuiArgs.map(quote).join(" ")}`, tuiLog],
		{
			cwd: join(dir, "B/project"),
			env: { ...b.env, JEV_FIXTURE_OBSERVATIONS: proofLog },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let screen = "";
	tui.stdout.on("data", (chunk) => {
		screen += String(chunk);
	});
	tui.stderr.on("data", (chunk) =>
		appendFileSync(join(dir, "tui.stderr"), chunk),
	);
	t.after(async () => {
		if (tui.exitCode !== null || tui.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => tui.kill("SIGKILL"), 3000);
			tui.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
			tui.kill("SIGTERM");
		});
	});
	async function until(predicate: () => boolean, label: string) {
		const deadline = Date.now() + 15000;
		while (!predicate()) {
			assert.ok(
				tui.exitCode === null && tui.signalCode === null,
				`TUI exited: ${label}`,
			);
			assert.ok(
				Date.now() < deadline,
				`TUI observation timeout: ${label}; ${tuiLog}`,
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
	const plain = () => stripVTControlCharacters(screen);
	async function typeCommand(command: string) {
		const offset = plain().length;
		tui.stdin.write(`\x1b[200~${command}\x1b[201~`);
		await until(
			() => plain().slice(offset).includes(command),
			`typed ${command}`,
		);
		tui.stdin.write("\r");
	}
	await until(
		() => screen.includes("\x1b[?2004h") && plain().includes("[Extensions]"),
		"interactive startup resource report",
	);
	await typeCommand("/refresh-proof retain");
	await until(
		() =>
			existsSync(proofLog) &&
			readFileSync(proofLog, "utf8").includes('"descriptor":"refresh-chat/x"'),
		"TUI retained startup handle",
	);

	const protectedFiles = [
		"auth.json",
		"models.json",
		"trusted-projects.json",
		"settings.json",
	];
	const protect = () =>
		[agent, separate].flatMap((directory) =>
			protectedFiles.map((file) =>
				existsSync(join(directory, file))
					? readFileSync(join(directory, file), "utf8")
					: null,
			),
		);
	const baseline = protect();
	const checks: string[] = [];
	const firstAfterSave = async (
		label: string,
		operation: () => Promise<void>,
	) => {
		await a.proof(`save ${JSON.stringify(settings("x"))}`);
		// Reset the live receiver, not merely the disk, before testing freshness.
		assert.deepEqual(await b.proof("availability"), {
			classifier: "refresh-native/x",
			llm: "refresh-chat/x",
		});
		await a.proof(`save ${JSON.stringify(settings("y"))}`);
		await operation();
		checks.push(label);
		writeFileSync(join(dir, "checks.json"), JSON.stringify(checks, null, 2));
	};
	for (const method of ["judge", "review"])
		await firstAfterSave(method, async () => {
			const result = await b.proof(`${method} ${checks.length}`);
			assert.equal(result.stopReason, "stop", JSON.stringify(result));
			assert.equal(result.model, "refresh-native/y");
			assert.equal(result.answers.q?.type, "bool");
		});
	await firstAfterSave("availability", async () =>
		assert.deepEqual(await b.proof("availability"), {
			classifier: "refresh-native/y",
			llm: "refresh-chat/y",
		}),
	);
	for (const command of [
		"/llm-as-jev",
		"/llm-as-jev status",
		"/llm-as-jev mode invalid",
	])
		await firstAfterSave(command, async () => {
			if (command.endsWith("invalid")) await a.proof('save {"mode":"llm"}');
			const count = requests.length;
			const text = (await b.prompt(command)).join("\n");
			assert.match(
				text,
				command.endsWith("invalid") ? /current: llm/ : /refresh-native\/y/,
			);
			assert.equal(requests.length, count, "inspection sends no inference");
		});
	await firstAfterSave("public metadata", async () =>
		assert.deepEqual(await b.proof("models"), [
			{ id: "refresh-chat/y", contextWindow: 16000 },
		]),
	);
	await firstAfterSave("retained descriptor", async () => {
		const result = await b.proof("classify");
		assert.equal(result.stopReason, "stop", JSON.stringify(result));
		assert.equal(result.model, "refresh-chat/y");
		assert.equal(requests.at(-1)?.body.model, "y");
		assert.equal(requests.at(-1)?.body.reasoning, "high");
	});
	const count = requests.length;
	await a.proof(`save ${JSON.stringify({ model: "refresh-noauth/z" })}`);
	assert.deepEqual(await b.proof("models"), []);
	await a.proof(`save ${JSON.stringify({ model: null })}`);
	assert.deepEqual(await b.proof("models"), []);
	assert.equal((await b.proof("classify")).stopReason, "error");
	assert.equal(
		requests.length,
		count,
		"unavailable/removed targets never dispatch",
	);
	await a.proof(`save ${JSON.stringify(settings("y"))}`);
	assert.deepEqual(await b.proof("models"), [
		{ id: "refresh-chat/y", contextWindow: 16000 },
	]);
	assert.deepEqual(await b.proof("identity"), {
		same: true,
		descriptor: "refresh-chat/x",
	});
	assert.deepEqual(await c.proof("availability"), {
		classifier: "refresh-native/x",
		llm: "refresh-chat/x",
	});
	await a.proof(`save ${JSON.stringify(settings("x"))}`);
	assert.deepEqual(await b.proof("begin"), { started: true });
	await admission;
	await a.proof(`save ${JSON.stringify(settings("y"))}`);
	const overlapping = await b.proof("judge overlap");
	assert.equal(overlapping.model, "refresh-native/y");
	assert.equal(overlapping.stopReason, "stop");
	release();
	const original = await b.proof("collect");
	assert.equal(original.model, "refresh-native/x");
	assert.equal(
		original.stopReason,
		"stop",
		"save does not cancel admitted work",
	);
	const afterOverlap = requests.length;
	assert.equal((await b.proof("judge overlap")).reuse.hits, 1);
	await a.proof(`save ${JSON.stringify(settings("x"))}`);
	assert.equal((await b.proof("judge overlap")).reuse.hits, 1);
	assert.equal(
		requests.length,
		afterOverlap,
		"both identity-qualified caches survive refresh",
	);
	checks.push("actual overlapping X/Y judgments and cache retention");

	const partial = await b.proof("staged");
	assert.notEqual(partial.stopReason, "stop");
	assert.ok(
		partial.progress.stages.length > 0,
		"partial X review retained progress",
	);
	failThird = false;
	await a.proof(`save ${JSON.stringify(settings("y"))}`);
	const beforeStages = requests.length;
	const freshReview = await b.proof("staged");
	assert.equal(freshReview.stopReason, "stop", JSON.stringify(freshReview));
	assert.equal(freshReview.model, "refresh-native/y");
	const stages = requests.slice(beforeStages).map(
		(request) =>
			request.body as {
				model: string;
				state: { evidence: { id: string }[] };
			},
	);
	assert.ok(stages.every((request) => request.model === "y"));
	for (const id of ["one", "two", "three"])
		assert.ok(
			stages.some(
				(request) =>
					request.state.evidence.length === 1 &&
					request.state.evidence[0].id.startsWith(id),
			),
			`Y obtains its own ${id} judgment, not X's checkpoint`,
		);
	const afterStages = requests.length;
	assert.equal((await b.proof("staged")).stopReason, "stop");
	assert.equal(
		requests.length,
		afterStages,
		"same-identity review reuses completed work",
	);
	checks.push(
		"resumed review rejects old identity checkpoints and reuses matching work",
	);

	await a.proof(`save ${JSON.stringify(settings("x"))}`);
	const beforeReview = requests.length;
	assert.deepEqual(await b.proof("begin-review"), { started: true });
	await reviewAdmission;
	await a.proof(
		`save ${JSON.stringify({ ...settings("y"), timeoutMs: 1, contextLimits: { "refresh-native/x": { request: 1 } } })}`,
	);
	const overridden = await b.proof("judge current-during-review 5000");
	assert.equal(
		overridden.stopReason,
		"stop",
		"caller timeout overrides the newly configured 1ms",
	);
	assert.equal(overridden.model, "refresh-native/y");
	releaseReview();
	const completedReview = await b.proof("collect");
	assert.equal(
		completedReview.stopReason,
		"stop",
		JSON.stringify(completedReview),
	);
	assert.equal(completedReview.model, "refresh-native/x");
	const oldStages = requests
		.slice(beforeReview)
		.map(
			(request) =>
				request.body as {
					model: string;
					state?: { fixed?: { scenario?: string } };
				},
		)
		.filter((request) => request.state?.fixed?.scenario === "review-overlap");
	assert.ok(oldStages.length > 2);
	assert.ok(
		oldStages.every((request) => request.model === "x"),
		"all old review stages keep X and its limits",
	);
	await a.proof(
		`save ${JSON.stringify({ ...settings("y"), contextLimits: null })}`,
	);
	checks.push(
		"multi-stage review keeps its snapshot and caller timeout precedence",
	);

	await a.proof('save {"mode":"llm","thinkingLevel":"high"}');
	const llm = await b.proof("judge overlap");
	assert.equal(llm.stopReason, "stop");
	assert.equal(llm.backend, "llm");
	assert.equal(
		llm.reuse.hits,
		0,
		"native answer is not reused after switching backend",
	);
	await a.proof('save {"thinkingLevel":"low"}');
	const low = await b.proof("judge overlap");
	assert.equal(low.stopReason, "stop");
	assert.equal(low.reuse.hits, 0);
	assert.equal(requests.at(-1)?.body.reasoning, "low");
	const afterThinking = requests.length;
	assert.equal((await b.proof("judge overlap")).reuse.hits, 1);
	assert.equal(requests.length, afterThinking);
	checks.push(
		"effective thinking changes miss old cache; unchanged settings reuse",
	);

	await firstAfterSave("native TUI classifier picker", async () => {
		let offset = plain().length;
		await typeCommand("/llm-as-jev classifier");
		await until(
			() =>
				plain().slice(offset).includes("Judge model (sorted by provider/id)"),
			"native classifier dialog",
		);
		offset = plain().length;
		tui.stdin.write("\r");
		await until(
			() =>
				plain().slice(offset).includes("selected (chat settings unchanged)"),
			"classifier confirmation",
		);
		assert.equal(
			JSON.parse(readFileSync(join(agent, "llm-as-jev.json"), "utf8"))
				.classifierModel,
			"refresh-native/y",
		);
	});
	await a.proof(
		`save ${JSON.stringify({ ...settings("x"), thinkingLevel: "off" })}`,
	);
	const coldTuiOffset = plain().length;
	await typeCommand("/llm-as-jev status");
	await until(
		() => plain().slice(coldTuiOffset).includes("refresh-native/x"),
		"TUI observes X before next save",
	);
	await a.proof(
		`save ${JSON.stringify({ ...settings("y"), thinkingLevel: "low" })}`,
	);
	let offset = plain().length;
	await typeCommand("/llm-as-jev llm");
	await until(
		() => plain().slice(offset).includes("Judge model (sorted by provider/id)"),
		"native chat dialog",
	);
	offset = plain().length;
	tui.stdin.write("\r");
	await until(
		() => plain().slice(offset).includes("Thinking level for refresh-chat/y"),
		"native thinking dialog",
	);
	offset = plain().length;
	tui.stdin.write("\r");
	await until(
		() => plain().slice(offset).includes("saved (native selection unchanged)"),
		"chat confirmation",
	);
	const picked = JSON.parse(
		readFileSync(join(agent, "llm-as-jev.json"), "utf8"),
	);
	assert.equal(picked.model, "refresh-chat/y");
	assert.equal(picked.thinkingLevel, "low");
	checks.push("native TUI chat/thinking picker");
	await typeCommand("/refresh-proof identity");
	await until(
		() => readFileSync(proofLog, "utf8").includes('"same":true'),
		"TUI handle identity after picks",
	);
	const exited = new Promise<void>((resolve) =>
		tui.once("close", () => resolve()),
	);
	await typeCommand("/refresh-proof exit");
	await exited;
	assert.equal(tui.exitCode, 0);

	assert.deepEqual(protect(), baseline);
	assert.deepEqual(
		Object.fromEntries(
			Object.keys(candidate).map((file) => [
				file,
				hash(join(root, "src", file)),
			]),
		),
		candidate,
	);
	checks.push(
		"credential/removal/restoration",
		"retained handle",
		"separate agent directory",
		"protected files and candidate unchanged",
	);
	writeFileSync(join(dir, "checks.json"), JSON.stringify(checks, null, 2));
});
