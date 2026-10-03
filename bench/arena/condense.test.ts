import { describe, expect, test } from "bun:test";
import { CONDENSE_VERSION, condense } from "./condense.ts";
import { CLASS_IDS } from "./core.ts";
import { loadTasks } from "./seal.ts";
import { condenseTransform, FIELDS, prepareTasks } from "./transforms.ts";

// Pinned: any change to condense output on the sealed tasks must bump
// CONDENSE_VERSION (it is part of the variant hash) and re-pin these.
const GOLDEN = {
	a: "f62de73861d021f8",
	b: "811815dd98bb0558",
	c: "1648c37592721780",
	d: "a7acd12cd82e2008",
	e: "920fbc2f6fda4df7",
	f: "39ff3049b91f5c88",
};

describe("condense", () => {
	test("version is pinned with the golden hashes", () => {
		expect(CONDENSE_VERSION).toBe("ref-condense/1");
	});
	test("golden prompts hash per class over all sealed tasks", async () => {
		for (const c of CLASS_IDS) {
			const r = await prepareTasks(c, loadTasks(c).tasks, condenseTransform, {
				cache: null,
			});
			expect([c, r.promptsHash]).toEqual([c, GOLDEN[c]]);
		}
	});
	test("deterministic, idempotent, never longer on every sealed prompt", () => {
		for (const c of CLASS_IDS)
			for (const t of loadTasks(c).tasks)
				for (const f of FIELDS[c]) {
					const x = t[f] ?? "";
					const y = condense(x);
					expect(condense(x)).toBe(y);
					expect(condense(y)).toBe(y);
					expect(y.length).toBeLessThanOrEqual(x.length);
				}
	});
	test("preserves quoted blocks, code spans, fences and numbers", () => {
		const src =
			'Please note that you should extract the order. In order to do this, use `toBase(n)` and the "exact term".\n\nMessage:\n"""\nPlease note that the the data is here 1,234.50\n"""\n```js\nthe the code\n```';
		const out = condense(src);
		expect(out).toContain("`toBase(n)`");
		expect(out).toContain('"exact term"');
		expect(out).toContain(
			'"""\nPlease note that the the data is here 1,234.50\n"""',
		);
		expect(out).toContain("```js\nthe the code\n```");
		expect(out.length).toBeLessThan(src.length);
	});
	test("keeps every digit sequence of every sealed prompt", () => {
		for (const c of CLASS_IDS)
			for (const t of loadTasks(c).tasks)
				for (const f of FIELDS[c]) {
					const x = t[f] ?? "";
					const nums = (s: string) => s.match(/\d+(?:[.,]\d+)*/g) ?? [];
					expect(nums(condense(x))).toEqual(nums(x));
				}
	});
});
