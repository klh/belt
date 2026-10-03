// report.ts — per-run report (port of the prototype) + the run loader the
// variant report reuses. Reads results/*.jsonl as a stream.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CLASSES,
	type ClassId,
	jsonl,
	RES_DIR,
	sha,
	stripThink,
	TIERS,
} from "./core.ts";
import { type Routing, routedTier } from "./legs.ts";
import { lastMatch } from "./scoring.ts";
import { loadTasks, verifyManifest } from "./seal.ts";
import {
	boot,
	ci,
	DELTA,
	f0,
	f2,
	mean,
	NONINF_MIN_N,
	qualLabel,
	quant,
	row,
	sep,
	usd,
	wilson,
} from "./stats.ts";

export interface RawRow {
	type: string;
	run: string;
	cls: ClassId;
	task: string;
	leg: string;
	phase: string;
	ok: boolean;
	wall_ms: number;
	ttft_ms: number | null;
	ttfc_ms: number | null;
	in_tok: number;
	out_tok: number;
	cached_tok: number;
	tok_est: boolean;
	streamed: boolean;
	finish: string | null;
	cost_usd: number;
	priced: string;
	score: number | null;
	conf: number | null;
	detail?: string;
	load1: number;
	routed?: Routing;
	kev?: { confidence?: number | null };
	answer?: string;
	user_chars?: number;
	chars_in?: number;
	chars_out?: number;
	transform_ms?: number;
	cache_hit?: boolean;
	fallback?: string;
}
export interface Row {
	cls: ClassId;
	task: string;
	leg: string;
	phase: string;
	ok: boolean;
	wall: number;
	ttft: number | null;
	ttfc: number | null;
	inT: number;
	outT: number;
	cached: number;
	est: boolean;
	streamed: boolean;
	finish: string | null;
	cost: number;
	priced: string;
	score: number;
	conf: number | null;
	load: number;
	tier?: string | null;
	kevConf?: number | null;
	label?: string;
	charsIn: number | null;
	charsOut: number | null;
	fallback: boolean;
}
export interface RunMeta {
	run: string;
	host?: string;
	bun?: string;
	started?: string;
	manifest?: string;
	price_src?: string;
	dropped?: string[];
	variant?: string;
	variant_hash?: string;
	transform?: string;
	transform_version?: string;
	models?: string;
	enhance_cache_hash?: string;
	prompts_hash?: Record<string, string>;
	legs?: string[];
}
export interface LoadedRun {
	id: string;
	meta: RunMeta | null;
	ended: string | null;
	rows: Row[];
}

function tierOfRow(r: RawRow): string | null | undefined {
	if (r.cls !== "e") return undefined;
	if (r.leg === "stack-router") return routedTier(r.routed);
	if (r.leg === "kev-direct") return r.answer ?? null;
	return lastMatch(
		stripThink(r.answer ?? "").toLowerCase(),
		/tier\W*:\s*\W*([a-z]+)/,
	);
}
let eLabels: Map<string, string> | null = null;
const labelOf = (id: string) => {
	if (!eLabels)
		eLabels = new Map(loadTasks("e").tasks.map((t) => [t.id, t.label ?? ""]));
	return eLabels.get(id);
};
export function toRow(r: RawRow): Row {
	return {
		cls: r.cls,
		task: r.task,
		leg: r.leg,
		phase: r.phase,
		ok: r.ok,
		wall: r.wall_ms,
		ttft: r.ttft_ms,
		ttfc: r.ttfc_ms,
		inT: r.in_tok,
		outT: r.out_tok,
		cached: r.cached_tok,
		est: r.tok_est,
		streamed: r.streamed,
		finish: r.finish,
		cost: r.cost_usd,
		priced: r.priced,
		score: r.score ?? 0,
		conf: r.conf,
		load: r.load1,
		tier: tierOfRow(r),
		kevConf: r.kev?.confidence ?? null,
		label: r.cls === "e" ? labelOf(r.task) : undefined,
		charsIn: r.chars_in ?? null,
		charsOut: r.chars_out ?? r.chars_in ?? null,
		fallback: !!r.fallback,
	};
}
export function latestRun(resDir = RES_DIR): string | null {
	if (!existsSync(resDir)) return null;
	const fs = readdirSync(resDir)
		.filter((f) => f.endsWith(".jsonl") && f !== "manifest.jsonl")
		.sort();
	const last = fs.at(-1);
	return last ? last.replace(/\.jsonl$/, "") : null;
}
export async function loadRun(
	id: string,
	resDir = RES_DIR,
): Promise<LoadedRun> {
	const file = join(resDir, `${id}.jsonl`);
	if (!existsSync(file)) throw new Error(`missing ${file}`);
	let meta: RunMeta | null = null;
	let ended: string | null = null;
	const rows: Row[] = [];
	for await (const r of jsonl<RawRow & RunMeta & { ended?: string }>(file)) {
		if (r.type === "meta") meta = r;
		else if (r.type === "end") ended = r.ended ?? null;
		else if (r.type === "row" && r.phase !== "warmup") rows.push(toRow(r));
	}
	return { id, meta, ended, rows };
}

// ---------------------------------------------------------------- per-run report
const LEGEND =
	"Labels: quality n≥130 moderate, 33–129 weak, <33 insufficient (no claims); speed n≥12 strong. `est` = tokens estimated from chars (router reports 0). `$0 electricity` = local tiers, no marginal API cost, not free. `polluted` = wall p95/p50 > 3 (contention). `fb` = transform fell back to the sealed prompt.";

function legLine(runId: string, cls: ClassId, lg: string, R: Row[]): string {
	const ok = R.filter((r) => r.ok);
	const w = ok.map((r) => r.wall);
	const sc = R.map((r) => r.score);
	const p50 = quant(w, 0.5);
	const p95 = quant(w, 0.95);
	const inS = ok.reduce((s, r) => s + r.inT, 0);
	const cS = ok.reduce((s, r) => s + r.cached, 0);
	const tps = mean(
		ok
			.filter((r) => r.outT && r.wall - (r.ttft ?? 0) > 0)
			.map((r) => r.outT / ((r.wall - (r.ttft ?? 0)) / 1000)),
	);
	const cost = mean(R.map((r) => r.cost));
	const priced = [...new Set(R.map((r) => r.priced))].join("/");
	const fb = R.filter((r) => r.fallback).length;
	const flags = [
		p50 && p95 && p95 / p50 > 3 ? "polluted" : "",
		R.some((r) => r.est) ? "est" : "",
		ok.some((r) => !r.streamed) ? "n/s" : "",
		ok.length < R.length ? `${R.length - ok.length} err` : "",
		fb ? `${fb} fb` : "",
	]
		.filter(Boolean)
		.join(" ");
	const pass = R.filter((r) => r.score === 1).length;
	const wl = wilson(pass, R.length);
	const ttfts = ok.flatMap((r) => (r.ttft === null ? [] : [r.ttft]));
	const ttfcs = ok.flatMap((r) => (r.ttfc === null ? [] : [r.ttfc]));
	const cin = mean(R.flatMap((r) => (r.charsIn === null ? [] : [r.charsIn])));
	const cout = mean(
		R.flatMap((r) => (r.charsOut === null ? [] : [r.charsOut])),
	);
	return row([
		lg,
		R.length,
		f2((100 * (R.length - ok.length)) / R.length, 0),
		f2((100 * R.filter((r) => r.finish === "length").length) / R.length, 0),
		f0(p50),
		f0(p95),
		f0(quant(ttfts, 0.5)),
		f0(quant(ttfcs, 0.5)),
		`${f0(mean(ok.map((r) => r.inT)))}/${f0(mean(ok.map((r) => r.outT)))}`,
		inS ? f2((100 * cS) / inS, 0) : "—",
		`${f0(cin)}→${f0(cout)}`,
		`${f2((100 * pass) / R.length, 0)} ${ci(wl ? [wl[0] * 100, wl[1] * 100] : null, 0)}`,
		`${f2(mean(sc))} ${ci(boot(sc, mean, `${runId}|${cls}|${lg}`))}`,
		qualLabel(R.length),
		`${usd(cost === null ? null : cost * 1000)}${priced.includes("electricity") ? " electricity" : ""}`,
		f0(tps),
		f2(mean(R.map((r) => r.load)), 1),
		flags,
	]);
}

/** Paired comparison A − B by task. */
export function pairedLine(
	title: string,
	A: Row[],
	B: Map<string, Row>,
	seed: string,
): string | null {
	const P = A.flatMap((r) => {
		const b = B.get(r.task);
		return b ? [[r, b] as const] : [];
	});
	if (!P.length) return null;
	const dq = P.map(([x, y]) => x.score - y.score);
	const rt = P.filter(([x, y]) => x.ok && y.ok && y.wall > 0).map(
		([x, y]) => x.wall / y.wall,
	);
	const dc = P.map(([x, y]) => (x.cost - y.cost) * 1000);
	const dqCI = boot(dq, mean, `${seed}|q`);
	const rtCI = boot(rt, (s) => quant(s, 0.5), `${seed}|t`);
	const nonInf = dqCI !== null && dqCI[0] >= -DELTA && P.length >= NONINF_MIN_N;
	return row([
		title,
		P.length,
		`${f2(mean(dq), 3)} ${ci(dqCI, 3)}`,
		nonInf
			? "**non-inferior**"
			: P.length < NONINF_MIN_N
				? `n<${NONINF_MIN_N} — no claim`
				: "not shown",
		`${f2(quant(rt, 0.5))}× ${ci(rtCI)}`,
		usd(mean(dc)),
		nonInf
			? `Δ$/1k = ${usd(mean(dc))} claimable (${qualLabel(P.length)})`
			: "Δ$ not claimable (quality not shown non-inferior)",
	]);
}

function classSection(
	runId: string,
	cls: ClassId,
	rows: Row[],
	p: (s?: string) => void,
) {
	const cold = rows.filter((r) => r.cls === cls && r.phase === "cold");
	const legs = [...new Set(cold.map((r) => r.leg))];
	p(`## ${cls} — ${CLASSES[cls].name}`);
	p();
	p(
		"| leg | n | err% | trunc% | wall p50 | wall p95 | TTFT p50 | TTFC p50 | in/out tok (mean) | cache% | prompt chars in→out | pass% [Wilson 95%] | mean score [boot 95%] | label | $/1k tasks | out tok/s | load1 | flags |",
	);
	p(sep(18));
	for (const lg of legs)
		p(
			legLine(
				runId,
				cls,
				lg,
				cold.filter((r) => r.leg === lg),
			),
		);
	p();
	const legMap = (lg: string) =>
		new Map(cold.filter((r) => r.leg === lg).map((r) => [r.task, r]));
	const of = (lg: string) => cold.filter((r) => r.leg === lg);
	const cmps: [string, string, string][] = [
		...legs
			.filter((l) => l !== "pure-api")
			.map((l): [string, string, string] => [`${l} − pure-api`, l, "pure-api"]),
		[
			"decomp: stack-anthropic − local-direct (real router vs oracle placement)",
			"stack-anthropic",
			"local-direct",
		],
		[
			"decomp: stack-anthropic − stack-engine-zai (router vs same model via gateway)",
			"stack-anthropic",
			"stack-engine-zai",
		],
		[
			"decomp: stack-engine-zai − pure-api (litellm hop)",
			"stack-engine-zai",
			"pure-api",
		],
		[
			"decomp: stack-engine-local − local-direct (litellm on local)",
			"stack-engine-local",
			"local-direct",
		],
	];
	const lines = cmps.flatMap(([t, a, b], i) => {
		const l = pairedLine(t, of(a), legMap(b), `${runId}|${cls}|${a}|${b}|${i}`);
		return l ? [l] : [];
	});
	if (lines.length) {
		p(
			"| comparison (A − B, paired by task) | n | Δquality [95% CI] | δ=0.10 | wall ratio A/B median [CI] | Δ$/1k | verdict |",
		);
		p(sep(7));
		for (const l of lines) p(l);
		p();
	}
	if (cls === "e") decisionSection(cold, legs, p);
	if (cls === "d") {
		p(
			"| leg | Brier (self-reported CONFIDENCE vs correct) | n with confidence |",
		);
		p(sep(3));
		for (const lg of legs) {
			const X = cold.filter((r) => r.leg === lg && r.conf !== null);
			p(
				row([
					lg,
					f2(mean(X.map((r) => ((r.conf ?? 0) - r.score) ** 2)), 3),
					X.length,
				]),
			);
		}
		p();
	}
	phaseSections(rows, cls, cold, p);
}
function decisionSection(cold: Row[], legs: string[], p: (s?: string) => void) {
	p("Routing accuracy per gold label (cold):");
	p();
	const labels = Object.keys(TIERS);
	p(`| leg | ${labels.join(" | ")} | Kev conf when right / wrong |`);
	p(sep(labels.length + 2));
	for (const lg of legs) {
		const R = cold.filter((r) => r.leg === lg);
		const cell = (lb: string) => {
			const X = R.filter((r) => r.label === lb);
			return X.length
				? `${X.filter((r) => r.score === 1).length}/${X.length}`
				: "—";
		};
		const kc = (v: number) =>
			f2(
				mean(
					R.flatMap((r) =>
						r.score === v && r.kevConf != null ? [r.kevConf] : [],
					),
				),
			);
		p(
			row([
				lg,
				...labels.map(cell),
				lg === "kev-direct" ? `${kc(1)} / ${kc(0)}` : "",
			]),
		);
	}
	p();
	p(
		"stack-router can only emit coder/extract/reason/general/cloud; `none` rows are unwinnable for it by design and are counted.",
	);
	p();
}
function phaseSections(
	rows: Row[],
	cls: ClassId,
	cold: Row[],
	p: (s?: string) => void,
) {
	const phases: [string, Row[]][] = [
		[
			"warm (f q2 on same prefix)",
			rows.filter((r) => r.cls === cls && r.phase === "warm"),
		],
		[
			"replay (byte-identical resend)",
			rows.filter((r) => r.cls === cls && r.phase === "replay"),
		],
	];
	for (const [ph, X] of phases) {
		if (!X.length) continue;
		const nm = ph.split(" ")[0];
		p(
			`| leg | ${ph}: n | TTFT p50 cold → ${nm} | wall p50 cold → ${nm} | cache% | quality |`,
		);
		p(sep(6));
		for (const lg of [...new Set(X.map((r) => r.leg))]) {
			const W = X.filter((r) => r.leg === lg && r.ok);
			const ids = new Set(W.map((r) => r.task));
			const Cd = cold.filter((r) => r.leg === lg && r.ok && ids.has(r.task));
			const tt = (Y: Row[]) =>
				quant(
					Y.flatMap((r) => (r.ttft === null ? [] : [r.ttft])),
					0.5,
				);
			const inS = W.reduce((s, r) => s + r.inT, 0);
			p(
				row([
					lg,
					W.length,
					`${f0(tt(Cd))} → ${f0(tt(W))}`,
					`${f0(
						quant(
							Cd.map((r) => r.wall),
							0.5,
						),
					)} → ${f0(
						quant(
							W.map((r) => r.wall),
							0.5,
						),
					)}`,
					inS ? f2((100 * W.reduce((s, r) => s + r.cached, 0)) / inS, 0) : "—",
					f2(mean(W.map((r) => r.score))),
				]),
			);
		}
		p();
	}
}

/** Bounded deterministic spot-check sample (≤K per class×leg, streamed). */
async function spotcheck(
	runId: string,
	resDir: string,
): Promise<[string, number]> {
	const K = 8;
	type Pick = {
		cls: string;
		leg: string;
		task: string;
		score: unknown;
		detail: unknown;
		answer: string;
		h: string;
	};
	const picked = new Map<string, Pick[]>();
	for await (const r of jsonl<RawRow>(join(resDir, `${runId}.jsonl`))) {
		if (
			r.type !== "row" ||
			r.phase !== "cold" ||
			!["a", "c", "d"].includes(r.cls)
		)
			continue;
		const k = `${r.cls}|${r.leg}`;
		const arr = picked.get(k) ?? [];
		arr.push({
			cls: r.cls,
			leg: r.leg,
			task: r.task,
			score: r.score,
			detail: r.detail,
			answer: String(r.answer ?? "").slice(0, 1200),
			h: sha(runId + r.task),
		});
		arr.sort((x, y) => (x.h < y.h ? -1 : 1));
		if (arr.length > K) arr.pop();
		picked.set(k, arr);
	}
	const S = [
		`# Spot-check sheet — run ${runId}`,
		"",
		"Human check of the mechanical scores. Mark each row agree/disagree; >10% disagreement on a class invalidates its quality column.",
		"",
	];
	let n = 0;
	for (const [k, arr] of picked)
		for (const x of arr) {
			n++;
			S.push(
				`### ${k} ${x.task} — score ${x.score} (${x.detail})`,
				"",
				"```",
				x.answer,
				"```",
				"",
				"- [ ] agree  - [ ] disagree",
				"",
			);
		}
	const spot = join(resDir, `${runId}-spotcheck.md`);
	writeFileSync(spot, `${S.join("\n")}\n`);
	return [spot, n];
}

export async function report(runId: string, resDir = RES_DIR): Promise<string> {
	const run = await loadRun(runId, resDir);
	const { meta } = run;
	const L: string[] = [];
	const p = (s = "") => {
		L.push(s);
	};
	const mv = verifyManifest();
	p(`# REPORT — arena run \`${runId}\``);
	p();
	p(
		`Variant **${meta?.variant ?? "legacy (pre-variant run)"}** \`${meta?.variant_hash ?? "—"}\` (transform \`${meta?.transform_version ?? "none"}\`, models \`${meta?.models ?? "—"}\`, enhance cache \`${meta?.enhance_cache_hash ?? "—"}\`). Host \`${meta?.host}\`, bun ${meta?.bun}, started ${meta?.started}, ${run.ended ? `ended ${run.ended}` : "**incomplete (no end row)**"}. Manifest \`${meta?.manifest}\` (${mv.ok && mv.hash === meta?.manifest ? "matches sealed tasks" : "**DOES NOT MATCH current tasks/**"}). Prices: ${meta?.price_src}. Dropped legs: ${meta?.dropped?.join(", ") || "none"}.`,
	);
	p();
	p(LEGEND);
	p();
	for (const cls of [...new Set(run.rows.map((r) => r.cls))])
		classSection(runId, cls, run.rows, p);
	const [spot, n] = await spotcheck(runId, resDir);
	p(`Spot-check sheet: \`${spot}\` (${n} rows).`);
	const md = `${L.join("\n")}\n`;
	writeFileSync(join(resDir, `${runId}-report.md`), md);
	return md;
}
