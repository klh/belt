// variant.ts — reproducible variant identity: run-id = UTC stamp + variant
// hash; one manifest row per run in results/manifest.jsonl.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type ClassId, canonical, jsonl, sha } from "./core.ts";
import type { ModelSet } from "./legs.ts";

export interface VariantSpec {
	transform: string;
	/** transform implementation version — a swapped condenser is a new variant */
	transformVersion: string;
	models: ModelSet;
	legs: string[];
}
/** 8-hex identity of a variant; independent of key and leg order. */
export function variantHash(v: VariantSpec): string {
	return sha(
		canonical({
			transform: v.transform,
			transform_version: v.transformVersion,
			models: v.models,
			legs: [...v.legs].sort(),
		}),
	).slice(0, 8);
}
export const variantLabel = (v: { transform: string; models: string }) =>
	`${v.transform}×${v.models}`;
/** e.g. 20261003T073000Z-1a2b3c4d — sortable, filename-safe. */
export function runIdFor(now: Date, vh: string): string {
	const stamp = now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z");
	return `${stamp}-${vh}`;
}

export interface ManifestRow {
	type: "variant";
	run: string;
	variant: string;
	variant_hash: string;
	transform: string;
	transform_version: string;
	models: ModelSet;
	legs: string[];
	classes: ClassId[];
	n: number;
	sealed_manifest_hash: string;
	enhance_cache_hash: string;
	prompts_hash: Record<string, string>;
	started: string;
}
export function manifestRow(
	run: string,
	v: VariantSpec,
	x: {
		classes: ClassId[];
		n: number;
		sealed: string;
		cacheHash: string;
		promptsHash: Record<string, string>;
		started: string;
	},
): ManifestRow {
	return {
		type: "variant",
		run,
		variant: variantLabel(v),
		variant_hash: variantHash(v),
		transform: v.transform,
		transform_version: v.transformVersion,
		models: v.models,
		legs: [...v.legs].sort(),
		classes: x.classes,
		n: x.n,
		sealed_manifest_hash: x.sealed,
		enhance_cache_hash: x.cacheHash,
		prompts_hash: x.promptsHash,
		started: x.started,
	};
}
/** Combine per-class cache hashes into one (order-independent). */
export const combineHashes = (hs: Record<string, string>) => {
	const vals = Object.values(hs);
	if (vals.every((h) => h === "n/a")) return "n/a";
	return sha(canonical(hs)).slice(0, 16);
};
export function appendManifestRow(resDir: string, row: ManifestRow) {
	mkdirSync(resDir, { recursive: true });
	appendFileSync(join(resDir, "manifest.jsonl"), `${JSON.stringify(row)}\n`);
}
export async function readManifest(resDir: string): Promise<ManifestRow[]> {
	const rows: ManifestRow[] = [];
	for await (const r of jsonl<ManifestRow>(join(resDir, "manifest.jsonl")))
		if (r.type === "variant") rows.push(r);
	return rows;
}
