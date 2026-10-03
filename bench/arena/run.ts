#!/usr/bin/env bun
// run.ts — arena CLI. Zero dependencies; see bench/arena/README.md.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	CACHE_DIR,
	CLASSES,
	type ClassId,
	DEFAULT_ORDER,
	TASK_DIR,
} from "./core.ts";
import { dryRun } from "./dryrun.ts";
import { isModelSet, type Leg, type ModelSet, selectLegs } from "./legs.ts";
import { latestRun, report } from "./report.ts";
import { variantReport } from "./report-variant.ts";
import { acGate, prepareVariant, Refused, runVariant } from "./runner.ts";
import { design, sealFrom, verifyManifest } from "./seal.ts";
import {
	buildTransform,
	isTransformId,
	loadCondenser,
	type Transform,
	TransformCache,
	type TransformId,
} from "./transforms.ts";
import { runIdFor, type VariantSpec, variantHash } from "./variant.ts";

export const USAGE = `bun bench/arena/run.ts <mode> [options]

modes
  --seal-from <dir>     copy a reference seal byte-for-byte into tasks/ (hash-verified; refuses to overwrite)
  --design              generate + seal tasks/ from the generators (refuses to overwrite)
  --verify              verify tasks/ against its MANIFEST
  --dry-run             every check a round makes, no round; --transform/--models accept lists (cartesian)
  --prepare             (AC-gated) warm the enhance cache for the selected variant(s); no legs are called
  --run                 (AC-gated) real round, one run per variant
  --report              per-run report (--run-id, default latest)
  --report --variant    compare variants (--runs a,b  --baseline <run-id>)

options
  --transform none|condense|enhance|both[,…]   default none
  --models glm|local|kev|mixed|all[,…]          default all
  --legs id,…           narrow inside the model set
  --classes e,d,a,c,b,f --n 12 --warm --replay K --allow-down --run-id <id>
  --condenser <path>    module whose default export is a Transform or (id, prompt) => prompt
  --refresh-cache       regenerate stale/mismatched enhance cache entries
  --allow-fallback      on transform failure send the sealed prompt (flagged per row)
  --no-ping             dry-run: skip endpoint pings
  --out <file>          dry-run: also write markdown to <file>`;

type Args = Record<string, string | boolean>;
export function parseArgs(argv: string[]): Args {
	const a: Args = {};
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i] ?? "";
		if (!k.startsWith("--")) continue;
		const nx = argv[i + 1];
		if (nx !== undefined && !nx.startsWith("--")) {
			a[k.slice(2)] = nx;
			i++;
		} else a[k.slice(2)] = true;
	}
	return a;
}
const str = (a: Args, k: string) =>
	typeof a[k] === "string" ? (a[k] as string) : undefined;
const list = (a: Args, k: string) =>
	str(a, k)
		?.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

export function selClasses(a: Args): ClassId[] {
	const cs = list(a, "classes") ?? DEFAULT_ORDER;
	for (const c of cs)
		if (!Object.hasOwn(CLASSES, c)) throw new Refused(`unknown class ${c}`);
	return cs as ClassId[];
}
export interface BuiltVariant {
	spec: VariantSpec;
	transform: Transform;
	legs: Leg[];
}
export async function buildVariants(a: Args): Promise<BuiltVariant[]> {
	const ts = list(a, "transform") ?? ["none"];
	const ms = list(a, "models") ?? ["all"];
	for (const t of ts)
		if (!isTransformId(t)) throw new Refused(`unknown transform ${t}`);
	for (const m of ms)
		if (!isModelSet(m)) throw new Refused(`unknown model set ${m}`);
	const condPath = str(a, "condenser");
	const condenser = condPath
		? await loadCondenser(resolve(condPath))
		: undefined;
	const only = list(a, "legs");
	const out: BuiltVariant[] = [];
	for (const t of ts as TransformId[])
		for (const m of ms as ModelSet[]) {
			const transform = buildTransform(t, { condenser });
			const legs = selectLegs(m, only);
			out.push({
				spec: {
					transform: t,
					transformVersion: transform.version,
					models: m,
					legs: legs.map((l) => l.id),
				},
				transform,
				legs,
			});
		}
	return out;
}

async function main(argv: string[]): Promise<number> {
	const a = parseArgs(argv);
	const n = Number(str(a, "n") ?? 12);
	const cache = new TransformCache(CACHE_DIR);
	const sealSrc = str(a, "seal-from");
	if (sealSrc) {
		sealFrom(resolve(sealSrc), TASK_DIR);
		return 0;
	}
	if (a.design) {
		design(TASK_DIR);
		return 0;
	}
	if (a.verify) {
		const v = verifyManifest();
		console.log(
			[...v.rows, `manifest ${v.hash} ${v.ok ? "PASS" : "FAIL"}`].join("\n"),
		);
		return v.ok ? 0 : 1;
	}
	if (a.report) {
		if (a.variant) {
			console.log(
				await variantReport({
					runs: list(a, "runs"),
					baseline: str(a, "baseline"),
				}),
			);
			return 0;
		}
		const id = str(a, "run-id") ?? latestRun();
		if (!id) throw new Refused("no results/*.jsonl — nothing to report");
		console.log(await report(id));
		return 0;
	}
	const classes = selClasses(a);
	const variants = await buildVariants(a);
	if (a["dry-run"]) {
		const out = str(a, "out");
		const r = await dryRun({
			variants,
			classes,
			n,
			cache,
			ping: !a["no-ping"],
			cmd: `bun bench/arena/run.ts ${argv.join(" ")}`,
		});
		console.log(r.md);
		if (out) writeFileSync(resolve(out), r.md);
		return r.code;
	}
	const common = {
		cache,
		classes,
		n,
		allowFallback: !!a["allow-fallback"],
		refresh: !!a["refresh-cache"],
	};
	if (a.prepare) {
		acGate();
		for (const v of variants) {
			const r = await prepareVariant({ ...common, transform: v.transform });
			for (const [c, x] of r)
				console.error(
					`prepare ${v.spec.transform} ${c}: hits ${x.hits}, generated ${x.misses}, failed ${x.failures.length}, cache ${x.cacheHash}`,
				);
		}
		return 0;
	}
	if (a.run) {
		const rid = str(a, "run-id");
		if (rid && variants.length > 1)
			throw new Refused(
				"--run-id resumes ONE variant; pass a single --transform and --models",
			);
		for (const v of variants)
			await runVariant({
				...common,
				runId: rid ?? runIdFor(new Date(), variantHash(v.spec)),
				variant: v.spec,
				transform: v.transform,
				legs: v.legs,
				warm: !!a.warm,
				replay: Number(str(a, "replay") ?? 0),
				allowDown: !!a["allow-down"],
			});
		return 0;
	}
	console.log(USAGE);
	return 0;
}

if (import.meta.main) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exitCode = e instanceof Refused ? e.code : 1;
	}
}
