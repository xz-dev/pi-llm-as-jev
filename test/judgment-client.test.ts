import assert from "node:assert/strict";
import test from "node:test";
import type { JudgmentService } from "../client/judgment-client.ts";
import { getJudgmentService } from "../client/judgment-client.ts";

const KEY = Symbol.for("pi-llm-as-jev:service");
const holder = globalThis as unknown as Record<symbol, unknown>;

test("returns undefined when no service is published", () => {
	const prev = holder[KEY];
	delete holder[KEY];
	try {
		assert.equal(getJudgmentService(), undefined);
	} finally {
		if (prev !== undefined) {
			holder[KEY] = prev;
		}
	}
});

test("returns the published object", () => {
	const prev = holder[KEY];
	const stub: JudgmentService = {
		version: 1,
		judge: async () => {
			throw new Error("not implemented");
		},
		availability: async () => ({}),
	};
	holder[KEY] = stub;
	try {
		assert.equal(getJudgmentService(), stub);
	} finally {
		if (prev === undefined) {
			delete holder[KEY];
		} else {
			holder[KEY] = prev;
		}
	}
});

test("set/restore leaves the registry clean", () => {
	delete holder[KEY];
	assert.equal(getJudgmentService(), undefined);
});
