// bin/fit-classifier.test.ts — W159 stage-2 fit classifier: same task →
// one model call, second look cached; hot-path lookup is sync + O(1);
// unparseable/unavailable model degrades to regex-only honestly; verdicts
// refine candidate order stably. Isolated cache file via env override.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CACHE = join(
	mkdtempSync(join(tmpdir(), "w159-fit-")),
	"fit-verdicts.json",
);
process.env.FIT_VERDICTS_PATH = CACHE; // read at module import — set first
const FC = await import(`./fit-classifier.ts?w159fit=${Date.now()}`);

const CANDS = [
	{
		machine: "local",
		port: 8901,
		model: "Qwen3-Coder-30B",
		kind: "local" as const,
		tags: "code generation multi-file edits",
	},
	{
		machine: "nas",
		port: 8100,
		model: "Qwen3.5-35B",
		kind: "remote" as const,
		tags: "reasoning planning hard analysis",
	},
	{
		machine: "gw",
		port: 4100,
		model: "glm-5.3",
		kind: "cloud" as const,
		tags: "frontier general",
	},
];

afterAll(() => {
	rmSync(CACHE, { force: true });
});

test("taskSignature: normalizes case + whitespace, stable", () => {
	const a = FC.taskSignature("  Prefer   LOCAL distill ");
	const b = FC.taskSignature("prefer local distill");
	expect(a).toBe(b);
	expect(a).toMatch(/^[0-9a-f]{16}$/);
	expect(FC.taskSignature("prefer cloud")).not.toBe(a);
});

test("parseVerdictReply: valid, prose-wrapped, and invalid replies", () => {
	const sig = FC.taskSignature("prefer local");
	const good = FC.parseVerdictReply(
		'{"placement":"local","model_glob":"qwen*","longrun":true,"confidence":0.8}',
		sig,
	);
	expect(good).not.toBeNull();
	expect(good?.placement).toBe("local");
	expect(good?.model_glob).toBe("qwen*");
	expect(good?.longrun).toBe(true);
	expect(good?.source).toBe("model");
	const wrapped = FC.parseVerdictReply(
		'Sure! {"placement":"cloud","model_glob":null,"longrun":false,"confidence":0.9} done',
		sig,
	);
	expect(wrapped?.placement).toBe("cloud");
	expect(FC.parseVerdictReply("no json here", sig)).toBeNull();
	expect(
		FC.parseVerdictReply('{"placement":"moon","confidence":1}', sig),
	).toBeNull();
	expect(
		FC.parseVerdictReply('{"placement":"local","confidence":"high"}', sig),
	).toBeNull();
});

test("verdictMatches + applyFitVerdict: placement, glob narrowing, stable order", () => {
	const vLocal = mkVerdict("local", "qwen*");
	const hit = CANDS.filter((c) => FC.verdictMatches(c, vLocal));
	expect(hit.map((c) => c.model)).toEqual(["Qwen3-Coder-30B"]);
	const vAny = mkVerdict("remote", null);
	expect(
		CANDS.filter((c) => FC.verdictMatches(c, vAny)).map((c) => c.model),
	).toEqual(["Qwen3.5-35B"]);
	// stable partition: matches move front, relative order preserved
	const vCloud = mkVerdict("cloud", null);
	const reordered = FC.applyFitVerdict([...CANDS], vCloud);
	expect(reordered.map((c) => c.model)).toEqual([
		"glm-5.3",
		"Qwen3-Coder-30B",
		"Qwen3.5-35B",
	]);
	const reordered2 = FC.applyFitVerdict([...CANDS].reverse(), vCloud);
	expect(reordered2.map((c) => c.model)).toEqual([
		"glm-5.3",
		"Qwen3.5-35B",
		"Qwen3-Coder-30B",
	]);
});

function mkVerdict(
	placement: "local" | "remote" | "cloud",
	glob: string | null,
) {
	return {
		sig: "test",
		placement,
		model_glob: glob,
		longrun: true,
		confidence: 0.9,
		source: "model" as const,
		ts: Date.now(),
	};
}

test("classifyAndCache: same task → one model call, second look cached", async () => {
	let calls = 0;
	const caller = async () => {
		calls++;
		return '{"placement":"remote","model_glob":null,"longrun":true,"confidence":0.7}';
	};
	const sig = FC.taskSignature("prefer local reasoning");
	const first = await FC.classifyAndCache(
		sig,
		"prefer local reasoning",
		CANDS,
		caller,
	);
	expect(first).toBe(true);
	expect(calls).toBe(1);
	// identical task: served from the verdict cache — no second model call
	const v2 = FC.lookupFitVerdict(sig);
	expect(v2?.placement).toBe("remote");
	await FC.classifyAndCache(sig, "prefer local reasoning", CANDS, caller);
	expect(calls).toBe(1); // the whole point: still one call
	// a different task gets its own call
	const sig2 = FC.taskSignature("must cloud");
	await FC.classifyAndCache(sig2, "must cloud", CANDS, caller);
	expect(calls).toBe(2);
});

test("unparseable reply degrades honestly: nothing cached, regex stands", async () => {
	let calls = 0;
	const bad = async () => {
		calls++;
		return "the model is unavailable";
	};
	const sig = FC.taskSignature("prefer local distill extract");
	const ok = await FC.classifyAndCache(
		sig,
		"prefer local distill extract",
		CANDS,
		bad,
	);
	expect(ok).toBe(false);
	expect(calls).toBe(1);
	expect(FC.lookupFitVerdict(sig)).toBeNull();
});

test("cache round-trips through disk for a fresh module instance", async () => {
	const again = await import(`./fit-classifier.ts?reload=${Date.now()}`);
	const sig = FC.taskSignature("prefer local reasoning");
	// the same normalized hint in a brand-new process/module instance hits disk
	expect(again.lookupFitVerdict(sig)?.placement).toBe("remote");
});
