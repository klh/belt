// route-policy.test.ts — W96 hint grammar: parse + fit + verb semantics.
// Pure tests — no fleet, no network: hintFit takes a structural candidate
// (kind, machine, model, tags), so the grammar is provable without booting
// the dashboard or touching metrics.db.
import { describe, expect, test } from "bun:test";
import { hintFit, hintTotal, parseHint } from "./route-policy.ts";

const cand = (
	kind: string,
	machine: string,
	model: string,
	tags: string,
): { kind: string; machine: string; model: string; tags: string } => ({
	kind,
	machine,
	model,
	tags,
});

const LOCAL_REASON = cand(
	"local",
	"m5max",
	"mlx-community/Qwen3.5-35B-A3B-4bit",
	"reason multi-step reasoning, planning, hard analysis, determinate answers mlx-community/Qwen3.5-35B-A3B-4bit",
);

describe("parseHint", () => {
	test("must cloud", () => {
		const p = parseHint("must cloud");
		expect(p.ok).toBe(true);
		if (p.ok) {
			expect(p.hint.verb).toBe("must");
			expect(p.hint.location).toEqual({ kind: "cloud" });
			expect(p.hint.tags).toEqual([]);
			expect(p.hint.model).toBeUndefined();
		}
	});

	test("prefer local distill reasoning — the flagship hint", () => {
		const p = parseHint("prefer local distill reasoning");
		expect(p.ok).toBe(true);
		if (p.ok) {
			expect(p.hint.verb).toBe("prefer");
			expect(p.hint.location).toEqual({ kind: "local" });
			expect(p.hint.tags).toEqual(["distill", "reasoning"]);
		}
	});

	test("prefer host:nas model:qwen* — host + glob model", () => {
		const p = parseHint("prefer host:nas model:qwen*");
		expect(p.ok).toBe(true);
		if (p.ok) {
			expect(p.hint.location).toEqual({ host: "nas" });
			expect(p.hint.model).toBe("qwen*");
		}
	});

	test("rejections — verb, empty host/model, duplicates, token flood", () => {
		expect(parseHint("gimme fast").ok).toBe(false);
		expect(parseHint("prefer host:").ok).toBe(false);
		expect(parseHint("prefer model:").ok).toBe(false);
		expect(parseHint("prefer local cloud").ok).toBe(false);
		expect(parseHint("must model:a model:b").ok).toBe(false);
		expect(parseHint("prefer a b c d e f g h i j k l").ok).toBe(false);
	});
});

describe("hintFit + hintTotal — verb semantics", () => {
	test("flagship hint fully fits the local reason specialist", () => {
		const p = parseHint("prefer local distill reasoning");
		if (!p.ok) throw new Error("parse failed");
		expect(hintFit(LOCAL_REASON, p.hint)).toBe(2);
		expect(hintTotal(p.hint)).toBe(2);
	});

	test("tags are OR: one matching tag satisfies the tag group", () => {
		const p = parseHint("prefer local distill reasoning");
		if (!p.ok) throw new Error("parse failed");
		const extract = cand(
			"local",
			"m5max",
			"mlx-community/Qwen3-4B-Instruct-2507-4bit",
			"extract structured extraction, json shaping, summarization",
		);
		expect(hintFit(extract, p.hint)).toBe(1);
	});

	test("model:qwen* glob matches case-insensitively", () => {
		const p = parseHint("prefer model:qwen*");
		if (!p.ok) throw new Error("parse failed");
		expect(hintTotal(p.hint)).toBe(1);
		expect(hintFit(LOCAL_REASON, p.hint)).toBe(1);
	});

	test("cloud candidate misses the local location group", () => {
		const p = parseHint("prefer local distill reasoning");
		if (!p.ok) throw new Error("parse failed");
		const cloud = cand("cloud", "zai", "glm-5.3", "reasoning code general");
		expect(hintFit(cloud, p.hint)).toBe(1);
	});

	test("host: matches machine name case-insensitively", () => {
		const p = parseHint("prefer host:M5Max");
		if (!p.ok) throw new Error("parse failed");
		expect(hintFit(LOCAL_REASON, p.hint)).toBe(1);
	});
});
