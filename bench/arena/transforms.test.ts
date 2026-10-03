import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { condense } from "./condense.ts";
import type { Task } from "./core.ts";
import {
	applyTransform,
	buildTransform,
	CacheMismatch,
	compose,
	condenseTransform,
	enhanceMaxTokens,
	loadCondenser,
	makeEnhance,
	noneTransform,
	prepareTasks,
	type Transform,
	TransformCache,
} from "./transforms.ts";

const dir = mkdtempSync(join(tmpdir(), "arena-tf-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => new TransformCache(join(dir, `c${n++}`));

/** Fake LLM transform: counts calls, uppercases. */
function fake(version = "fake/1"): Transform & { calls: number } {
	const t = {
		id: "enhance",
		version,
		deterministic: false,
		calls: 0,
		transform(_id: string, p: string) {
			t.calls++;
			return `ENH:${p.toUpperCase()}`;
		},
	};
	return t;
}

describe("transform cache", () => {
	test("miss generates + persists, hit reuses without calling", async () => {
		const c = fresh();
		const t = fake();
		const a = await applyTransform(t, "a-001.prompt", "hello", { cache: c });
		expect(a.meta.cache_hit).toBe(false);
		expect(t.calls).toBe(1);
		const b = await applyTransform(t, "a-001.prompt", "hello", { cache: c });
		expect(b.meta.cache_hit).toBe(true);
		expect(b.text).toBe("ENH:HELLO");
		expect(t.calls).toBe(1);
		expect(c.get("enhance", "a-001.prompt")?.input_sha).toHaveLength(64);
	});
	test("changed input or version is a hard mismatch unless refreshed", async () => {
		const c = fresh();
		await applyTransform(fake(), "k", "one", { cache: c });
		await expect(
			applyTransform(fake(), "k", "two", { cache: c }),
		).rejects.toBeInstanceOf(CacheMismatch);
		await expect(
			applyTransform(fake("fake/2"), "k", "one", { cache: c }),
		).rejects.toBeInstanceOf(CacheMismatch);
		const r = await applyTransform(fake("fake/2"), "k", "one", {
			cache: c,
			refresh: true,
		});
		expect(r.meta.cache_hit).toBe(false);
		expect(c.get("enhance", "k")?.version).toBe("fake/2");
	});
	test("offline never generates", async () => {
		const t = fake();
		await expect(
			applyTransform(t, "k", "x", { cache: fresh(), offline: true }),
		).rejects.toBeInstanceOf(CacheMismatch);
		expect(t.calls).toBe(0);
	});
	test("deterministic transforms bypass the cache", async () => {
		const c = fresh();
		const r = await applyTransform(
			condenseTransform,
			"k",
			"Please note that the plan works.",
			{ cache: c },
		);
		expect(r.entry).toBeNull();
		expect(c.get("condense", "k")).toBeNull();
	});
});

describe("prepareTasks", () => {
	const tasks: Task[] = [
		{
			id: "f-1",
			doc: "the the log",
			q1: "What is the key?",
			q2: "And the second?",
			check: { kind: "needle", expect: "X" },
		},
	];
	test("f rewrites questions only, never the log", async () => {
		const r = await prepareTasks("f", tasks, fake(), { cache: fresh() });
		const p = r.tasks.get("f-1");
		expect(p?.task.doc).toBe("the the log");
		expect(p?.task.q1).toBe("ENH:WHAT IS THE KEY?");
		expect(p?.meta.q2?.chars_in).toBe(15);
		expect(r.cacheHash).toHaveLength(16);
	});
	test("failure falls back (flagged, not cached) only with allowFallback", async () => {
		const boom: Transform = {
			id: "enhance",
			version: "b/1",
			deterministic: false,
			transform: () => {
				throw new Error("down");
			},
		};
		const c = fresh();
		const r = await prepareTasks("f", tasks, boom, {
			cache: c,
			allowFallback: true,
		});
		expect(r.failures).toHaveLength(2);
		expect(r.tasks.get("f-1")?.task.q1).toBe("What is the key?");
		expect(r.tasks.get("f-1")?.meta.q1?.fallback).toContain("down");
		expect(c.get("enhance", "f-1.q1")).toBeNull();
	});
	test("prompts hash is byte-stable", async () => {
		const a = await prepareTasks("f", tasks, condenseTransform, {
			cache: null,
		});
		const b = await prepareTasks("f", tasks, condenseTransform, {
			cache: null,
		});
		expect(a.promptsHash).toBe(b.promptsHash);
		expect(a.cacheHash).toBe("n/a");
	});
});

describe("composition + loading", () => {
	test("both = condense then enhance; non-deterministic; version chains", async () => {
		const e = fake();
		const both = compose("both", condenseTransform, e);
		expect(both.deterministic).toBe(false);
		expect(both.version).toBe("ref-condense/1+fake/1");
		const src = "Please note that the answer is 4.";
		expect(await both.transform("k", src)).toBe(
			`ENH:${condense(src).toUpperCase()}`,
		);
		expect(buildTransform("both", { enhance: e }).id).toBe("both");
		expect(buildTransform("none")).toBe(noneTransform);
	});
	test("external condenser: bare function and Transform object", async () => {
		// both files exist before the first import (bun caches dir listings)
		const fn = join(dir, "fn.ts");
		const obj = join(dir, "obj.ts");
		writeFileSync(
			fn,
			"export default (_id: string, p: string) => p.slice(0, 3);\n",
		);
		writeFileSync(
			obj,
			'export default { id: "x", version: "sus/3", deterministic: true, transform: (_i: string, p: string) => p.trim() };\n',
		);
		const t1 = await loadCondenser(fn);
		expect(await t1.transform("k", "abcdef")).toBe("abc");
		expect(t1.version).toMatch(/^ext:fn\.ts@[0-9a-f]{8}$/);
		expect(t1.deterministic).toBe(false);
		const t2 = await loadCondenser(obj);
		expect([t2.id, t2.version, t2.deterministic]).toEqual([
			"condense",
			"sus/3",
			true,
		]);
		expect(buildTransform("condense", { condenser: t2 })).toBe(t2);
	});
});

describe("enhance client", () => {
	const reply = (body: unknown, status = 200) =>
		(async () =>
			new Response(JSON.stringify(body), {
				status,
			})) as unknown as typeof fetch;
	test("parses text, strips think + fences, records routed model", async () => {
		const e = makeEnhance({
			fetchImpl: reply({
				content: [
					{ type: "text", text: "<think>hm</think>```\nBetter prompt\n```" },
				],
				stop_reason: "end_turn",
				_routing: { model: "local-reason" },
			}),
		});
		expect(await e.transform("k", "p")).toBe("Better prompt");
		expect(e.lastModel).toBe("local-reason");
	});
	test("truncation, HTTP errors and empty output throw", async () => {
		const t = (b: unknown, s?: number) =>
			makeEnhance({ fetchImpl: reply(b, s) }).transform("k", "p");
		await expect(
			t({ content: [{ type: "text", text: "x" }], stop_reason: "max_tokens" }),
		).rejects.toThrow("truncated");
		await expect(t({ error: "x" }, 500)).rejects.toThrow("HTTP 500");
		await expect(t({ content: [] })).rejects.toThrow("empty");
	});
	test("max_tokens budget is clamped", () => {
		expect(enhanceMaxTokens("x")).toBe(128);
		expect(enhanceMaxTokens("x".repeat(100_000))).toBe(768);
	});
});
