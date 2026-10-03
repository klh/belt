import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LEGS,
	legsFor,
	MODEL_SET_IDS,
	MODEL_SETS,
	selectLegs,
} from "./legs.ts";
import { buildVariants, parseArgs, selClasses } from "./run.ts";
import { acOk, Refused, runVariant } from "./runner.ts";
import { TransformCache } from "./transforms.ts";
import {
	appendManifestRow,
	combineHashes,
	manifestRow,
	readManifest,
	runIdFor,
	type VariantSpec,
	variantHash,
} from "./variant.ts";

const spec: VariantSpec = {
	transform: "condense",
	transformVersion: "ref-condense/1",
	models: "glm",
	legs: ["pure-api", "stack-engine-zai"],
};

describe("variant identity", () => {
	test("hash is stable and independent of leg order", () => {
		const h = variantHash(spec);
		expect(h).toMatch(/^[0-9a-f]{8}$/);
		expect(variantHash({ ...spec, legs: [...spec.legs].reverse() })).toBe(h);
		expect(variantHash({ ...spec, transformVersion: "ext:x@1" })).not.toBe(h);
		expect(variantHash({ ...spec, models: "local" })).not.toBe(h);
	});
	test("run id = UTC stamp + variant hash", () => {
		expect(runIdFor(new Date("2026-10-03T07:30:05.123Z"), "1a2b3c4d")).toBe(
			"20261003T073005Z-1a2b3c4d",
		);
	});
	test("manifest rows round-trip through manifest.jsonl", async () => {
		const dir = mkdtempSync(join(tmpdir(), "arena-mf-"));
		try {
			const row = manifestRow("r1", spec, {
				classes: ["e"],
				n: 12,
				sealed: "6253f5092545542e",
				cacheHash: combineHashes({ e: "n/a" }),
				promptsHash: { e: "abc" },
				started: "2026-10-03T00:00:00Z",
			});
			appendManifestRow(dir, row);
			const got = await readManifest(dir);
			expect(got).toEqual([row]);
			expect(row.enhance_cache_hash).toBe("n/a");
			expect(row.variant).toBe("condense×glm");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("model sets", () => {
	test("every set names real legs; all = every leg", () => {
		const ids = LEGS.map((l) => l.id);
		for (const m of MODEL_SET_IDS)
			for (const id of MODEL_SETS[m]) expect(ids).toContain(id);
		expect(selectLegs("all")).toHaveLength(LEGS.length);
	});
	test("glm/local/kev/mixed select the documented legs", () => {
		expect(selectLegs("glm").map((l) => l.id)).toEqual([
			"pure-api",
			"stack-engine-zai",
		]);
		expect(selectLegs("local").map((l) => l.id)).toEqual([
			"stack-engine-local",
			"local-direct",
		]);
		expect(selectLegs("kev").map((l) => l.id)).toEqual(["kev-direct"]);
		expect(selectLegs("mixed").map((l) => l.id)).toEqual([
			"stack-anthropic",
			"stack-router",
		]);
	});
	test("--legs narrows inside the set and refuses to borrow", () => {
		expect(selectLegs("glm", ["pure-api"]).map((l) => l.id)).toEqual([
			"pure-api",
		]);
		expect(() => selectLegs("local", ["pure-api"])).toThrow("not in model set");
	});
	test("kev serves only the decision class", () => {
		expect(legsFor("a", selectLegs("kev"))).toHaveLength(0);
		expect(legsFor("e", selectLegs("kev"))).toHaveLength(1);
	});
});

describe("cli", () => {
	test("parseArgs flags + values", () => {
		expect(
			parseArgs(["--dry-run", "--transform", "none,condense", "--n", "4"]),
		).toEqual({
			"dry-run": true,
			transform: "none,condense",
			n: "4",
		});
	});
	test("transform × models is a cartesian product", async () => {
		const v = await buildVariants(
			parseArgs(["--transform", "none,condense", "--models", "glm,local"]),
		);
		expect(v.map((x) => `${x.spec.transform}:${x.spec.models}`)).toEqual([
			"none:glm",
			"none:local",
			"condense:glm",
			"condense:local",
		]);
		expect(new Set(v.map((x) => variantHash(x.spec))).size).toBe(4);
	});
	test("unknown transform / model set / class refuse", async () => {
		await expect(
			buildVariants(parseArgs(["--transform", "zip"])),
		).rejects.toThrow("unknown transform");
		await expect(buildVariants(parseArgs(["--models", "gpt"]))).rejects.toThrow(
			"unknown model set",
		);
		expect(() => selClasses(parseArgs(["--classes", "z"]))).toThrow(
			"unknown class",
		);
	});
	test.skipIf(acOk())(
		"real rounds refuse without the AC gate (exit 3)",
		async () => {
			const [v] = await buildVariants(parseArgs(["--models", "kev"]));
			if (!v) throw new Error("no variant");
			const err = await runVariant({
				runId: "never",
				variant: v.spec,
				transform: v.transform,
				cache: new TransformCache("/nonexistent"),
				legs: v.legs,
				classes: ["e"],
				n: 1,
				warm: false,
				replay: 0,
				allowDown: false,
				allowFallback: false,
				refresh: false,
				resDir: "/nonexistent",
			}).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(Refused);
			expect((err as Refused).code).toBe(3);
		},
	);
});
