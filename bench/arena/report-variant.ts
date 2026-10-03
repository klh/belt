// report-variant.ts — compare variants (transform × model set) across runs.
// Baseline = a none-transform run that contains pure-api (latest by default);
// every leg of every variant is paired by task against the baseline's
// pure-api leg, so the speed and quality deltas share one reference.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CHARS_PER_TOK_LOG,
	CHARS_PER_TOK_TEXT,
	CLASSES,
	type ClassId,
	PRICES,
	PURE_MODEL,
	RES_DIR,
} from "./core.ts";
import { LEGS } from "./legs.ts";
import { type LoadedRun, loadRun, type Row } from "./report.ts";
import {
	boot,
	ci,
	DELTA,
	f0,
	f2,
	mean,
	median,
	NONINF_MIN_N,
	pct,
	qualLabel,
	quant,
	row,
	sep,
	speedLabel,
	usd,
} from "./stats.ts";
import { type ManifestRow, readManifest } from "./variant.ts";

export interface VariantReportOpts {
	runs?: string[];
	baseline?: string;
	resDir?: string;
}
const remoteLegs = new Set(
	LEGS.filter((l) => l.priced !== "local").map((l) => l.id),
);

/** Pick the runs to compare: explicit list, else the latest run per variant
 *  hash recorded in results/manifest.jsonl. */
export function pickRuns(
	manifest: ManifestRow[],
	o: VariantReportOpts,
): string[] {
	if (o.runs?.length) return o.runs;
	const latest = new Map<string, ManifestRow>();
	for (const m of manifest) {
		const prev = latest.get(m.variant_hash);
		if (!prev || prev.run < m.run) latest.set(m.variant_hash, m);
	}
	return [...latest.values()].map((m) => m.run).sort();
}
export function pickBaseline(
	runs: LoadedRun[],
	explicit?: string,
): LoadedRun | null {
	if (explicit) return runs.find((r) => r.id === explicit) ?? null;
	const cands = runs.filter(
		(r) =>
			(r.meta?.transform ?? "none") === "none" &&
			r.rows.some((x) => x.leg === "pure-api" && x.phase === "cold"),
	);
	return cands.sort((a, b) => (a.id < b.id ? 1 : -1))[0] ?? null;
}

/** Estimated input-token and $ effect of prompt compression on a leg. */
function compression(cls: ClassId, R: Row[], leg: string) {
	const ins = R.flatMap((r) => (r.charsIn === null ? [] : [r.charsIn]));
	const outs = R.flatMap((r) => (r.charsOut === null ? [] : [r.charsOut]));
	const cin = mean(ins);
	const cout = mean(outs);
	if (cin === null || cout === null)
		return { cin, cout, dPct: null, dTok: null, dUsd: null };
	const cpt = cls === "f" ? CHARS_PER_TOK_LOG : CHARS_PER_TOK_TEXT;
	const dTok = (cout - cin) / cpt;
	const pr = PRICES[PURE_MODEL];
	const dUsd = remoteLegs.has(leg) && pr ? (dTok * pr.in * 1000) / 1e6 : null;
	return {
		cin,
		cout,
		dPct: cin ? (100 * (cout - cin)) / cin : null,
		dTok,
		dUsd,
	};
}

export function variantClassTable(
	cls: ClassId,
	runs: LoadedRun[],
	base: LoadedRun | null,
): string[] {
	const out: string[] = [];
	const bmap = new Map(
		(base?.rows ?? [])
			.filter(
				(r) => r.cls === cls && r.phase === "cold" && r.leg === "pure-api",
			)
			.map((r) => [r.task, r]),
	);
	out.push(`## ${cls} — ${CLASSES[cls].name}`, "");
	out.push(
		"| variant | leg | n | wall p50 | speed vs base pure-api (median ratio [CI]) | speed label | quality mean | pass% | Δq vs base [95% CI] | δ=0.10 | $/1k | prompt chars in→out | Δchars | est Δin-tok/task | est Δ$/1k from compression | fb | flags |",
	);
	out.push(sep(17));
	for (const run of runs) {
		const vlabel = run.meta?.variant ?? run.id;
		const cold = run.rows.filter((r) => r.cls === cls && r.phase === "cold");
		for (const lg of [...new Set(cold.map((r) => r.leg))]) {
			const R = cold.filter((r) => r.leg === lg);
			const ok = R.filter((r) => r.ok);
			const P = R.flatMap((r) => {
				const b = bmap.get(r.task);
				return b ? [[r, b] as const] : [];
			});
			const rt = P.filter(([x, y]) => x.ok && y.ok && y.wall > 0).map(
				([x, y]) => x.wall / y.wall,
			);
			const dq = P.map(([x, y]) => x.score - y.score);
			const seed = `${run.id}|${base?.id}|${cls}|${lg}`;
			const dqCI = boot(dq, mean, `${seed}|q`);
			const rtCI = boot(rt, median, `${seed}|t`);
			const isBase = run.id === base?.id && lg === "pure-api";
			const nonInf =
				dqCI !== null && dqCI[0] >= -DELTA && P.length >= NONINF_MIN_N;
			const cm = compression(cls, R, lg);
			const cost = mean(R.map((r) => r.cost));
			const p50 = quant(
				ok.map((r) => r.wall),
				0.5,
			);
			const p95 = quant(
				ok.map((r) => r.wall),
				0.95,
			);
			const fb = R.filter((r) => r.fallback).length;
			const flags = [
				isBase ? "BASELINE" : "",
				p50 && p95 && p95 / p50 > 3 ? "polluted" : "",
				R.some((r) => r.est) ? "est" : "",
				ok.length < R.length ? `${R.length - ok.length} err` : "",
				!P.length && !isBase ? "unpaired" : "",
			]
				.filter(Boolean)
				.join(" ");
			out.push(
				row([
					vlabel,
					lg,
					R.length,
					f0(p50),
					isBase ? "1.00×" : rt.length ? `${f2(median(rt))}× ${ci(rtCI)}` : "—",
					speedLabel(rt.length),
					f2(mean(R.map((r) => r.score))),
					f2(
						(100 * R.filter((r) => r.score === 1).length) / (R.length || 1),
						0,
					),
					isBase
						? "0 (ref)"
						: P.length
							? `${f2(mean(dq), 3)} ${ci(dqCI, 3)}`
							: "—",
					isBase
						? "—"
						: nonInf
							? "**non-inferior**"
							: P.length < NONINF_MIN_N
								? `n<${NONINF_MIN_N} — no claim (${qualLabel(P.length)})`
								: "not shown",
					`${usd(cost === null ? null : cost * 1000)}`,
					`${f0(cm.cin)}→${f0(cm.cout)}`,
					pct(cm.dPct),
					f2(cm.dTok, 0),
					cm.dUsd === null ? "— (local/electricity)" : usd(cm.dUsd),
					fb,
					flags,
				]),
			);
		}
	}
	out.push("");
	return out;
}

export async function variantReport(
	o: VariantReportOpts = {},
): Promise<string> {
	const resDir = o.resDir ?? RES_DIR;
	const manifest = await readManifest(resDir);
	const ids = pickRuns(manifest, o);
	if (!ids.length)
		throw new Error(
			`no runs in ${join(resDir, "manifest.jsonl")} — nothing to compare`,
		);
	const runs: LoadedRun[] = [];
	for (const id of ids) runs.push(await loadRun(id, resDir));
	const base = pickBaseline(runs, o.baseline);
	const L: string[] = ["# VARIANT REPORT — arena", ""];
	L.push(
		`Runs: ${runs.length}. Baseline: ${base ? `\`${base.id}\` (${base.meta?.variant ?? "?"}) pure-api` : "**none** (no none-transform run with pure-api — speed/Δq columns empty)"}. Pairing is by task id; δ=${DELTA} non-inferiority needs n≥${NONINF_MIN_N}. Compression deltas are estimated from chars (${CHARS_PER_TOK_TEXT} chars/token text, ${CHARS_PER_TOK_LOG} log) and priced only for remote legs at ${PURE_MODEL} input price.`,
		"",
	);
	L.push(
		"| run | variant | hash | transform version | models | legs | sealed | enhance cache | prompts (per class) | ended |",
	);
	L.push(sep(10));
	for (const r of runs) {
		const m = r.meta;
		L.push(
			row([
				`\`${r.id}\``,
				m?.variant ?? "legacy",
				m?.variant_hash ?? "—",
				m?.transform_version ?? "—",
				m?.models ?? "—",
				(m?.legs ?? []).join(", "),
				m?.manifest ?? "—",
				m?.enhance_cache_hash ?? "—",
				Object.entries(m?.prompts_hash ?? {})
					.map(([k, v]) => `${k}:${v.slice(0, 8)}`)
					.join(" "),
				r.ended ?? "**incomplete**",
			]),
		);
	}
	L.push("");
	const classes = [...new Set(runs.flatMap((r) => r.rows.map((x) => x.cls)))];
	for (const c of classes) L.push(...variantClassTable(c, runs, base));
	const md = `${L.join("\n")}\n`;
	writeFileSync(join(resDir, "variants-report.md"), md);
	return md;
}
