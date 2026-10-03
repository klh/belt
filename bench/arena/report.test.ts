import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRun, report } from "./report.ts";
import { pickBaseline, pickRuns, variantReport } from "./report-variant.ts";
import { boot, mean, quant, wilson } from "./stats.ts";
import {
	appendManifestRow,
	manifestRow,
	readManifest,
	type VariantSpec,
} from "./variant.ts";

const dir = mkdtempSync(join(tmpdir(), "arena-rep-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function synth(
	run: string,
	v: VariantSpec,
	f: (
		i: number,
		leg: string,
	) => { wall: number; score: number; cin: number; cout: number },
) {
	const m = manifestRow(run, v, {
		classes: ["a"],
		n: 40,
		sealed: "6253f5092545542e",
		cacheHash: "n/a",
		promptsHash: { a: "x" },
		started: "2026-10-03T00:00:00Z",
	});
	appendManifestRow(dir, m);
	const file = join(dir, `${run}.jsonl`);
	const put = (x: unknown) => appendFileSync(file, `${JSON.stringify(x)}\n`);
	put({
		...m,
		type: "meta",
		host: "h",
		bun: "1",
		manifest: "6253f5092545542e",
		price_src: "test",
		dropped: [],
	});
	for (let i = 0; i < 40; i++)
		for (const leg of v.legs) {
			const x = f(i, leg);
			put({
				type: "row",
				run,
				cls: "a",
				task: `a-${i}`,
				leg,
				phase: "cold",
				ok: true,
				wall_ms: x.wall,
				ttft_ms: 10,
				ttfc_ms: 12,
				in_tok: 100,
				out_tok: 50,
				cached_tok: 0,
				tok_est: false,
				streamed: true,
				finish: "stop",
				cost_usd: 0.001,
				priced: "glm-5.3-flash",
				score: x.score,
				conf: null,
				load1: 1,
				answer: "ok",
				chars_in: x.cin,
				chars_out: x.cout,
				transform: v.transform,
			});
		}
	put({ type: "end", run, ended: "2026-10-03T01:00:00Z" });
}
const glm = (t: string, ver: string): VariantSpec => ({
	transform: t,
	transformVersion: ver,
	models: "glm",
	legs: ["pure-api", "stack-engine-zai"],
});
synth("20261003T000000Z-base", glm("none", "none/1"), (i) => ({
	wall: 1000 + i,
	score: 1,
	cin: 400,
	cout: 400,
}));
synth("20261003T010000Z-cond", glm("condense", "ref-condense/1"), (i) => ({
	wall: 900 + i,
	score: i === 7 ? 0 : 1,
	cin: 400,
	cout: 360,
}));

describe("stats", () => {
	test("quantiles, wilson, mean, seeded bootstrap", () => {
		expect(quant([1, 2, 3, 4], 0.5)).toBe(2.5);
		expect(mean([])).toBeNull();
		const w = wilson(5, 10);
		expect(w?.[0]).toBeCloseTo(0.237, 2);
		const xs = [1, 2, 3, 4, 5, 6];
		expect(boot(xs, mean, "s")).toEqual(boot(xs, mean, "s"));
		expect(boot([1], mean, "s")).toBeNull();
	});
});

describe("reports", () => {
	test("loadRun reads meta, rows, end and transform meta", async () => {
		const r = await loadRun("20261003T010000Z-cond", dir);
		expect(r.meta?.variant).toBe("condense×glm");
		expect(r.ended).toBe("2026-10-03T01:00:00Z");
		expect(r.rows).toHaveLength(80);
		expect(r.rows[0]?.charsOut).toBe(360);
	});
	test("per-run report has the variant header and chars column", async () => {
		const md = await report("20261003T010000Z-cond", dir);
		expect(md).toContain("Variant **condense×glm**");
		expect(md).toContain("400→360");
		expect(md).toContain("stack-engine-zai − pure-api");
	});
	test("baseline = latest none run with pure-api; latest run per variant", async () => {
		const runs = pickRuns(await readManifest(dir), {});
		expect(runs).toEqual(["20261003T000000Z-base", "20261003T010000Z-cond"]);
		const loaded = await Promise.all(runs.map((id) => loadRun(id, dir)));
		expect(pickBaseline(loaded)?.id).toBe("20261003T000000Z-base");
	});
	test("variant report: speed ratio, Δq, Δchars and compression $", async () => {
		const md = await variantReport({ resDir: dir });
		const line =
			md.split("\n").find((l) => l.startsWith("| condense×glm | pure-api |")) ??
			"";
		expect(line).toContain("-10.0%");
		expect(line).toContain("-0.025");
		expect(line).toMatch(/0\.9\d×/);
		expect(line).toContain("**non-inferior**");
		expect(md).toContain("BASELINE");
	});
});
