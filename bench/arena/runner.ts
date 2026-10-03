// runner.ts — one real round for one variant. AC-gated, resumable by run-id,
// streams rows to results/<run>.jsonl (never buffers a round in memory).
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { hostname, loadavg } from "node:os";
import { join } from "node:path";
import {
	AC_FILE,
	CLASSES,
	type ClassId,
	GEN,
	jsonl,
	PRICE_SRC,
	PRICES,
	RES_DIR,
	SEED,
	type Task,
} from "./core.ts";
import {
	buildReq,
	callLeg,
	costOf,
	engineKeySrc,
	KEV_Q,
	type Leg,
	legsFor,
	load1,
	nonceOf,
	type Out,
	ping,
	portsFor,
	scoreOut,
} from "./legs.ts";
import type { Score } from "./scoring.ts";
import { loadTasks, verifyManifest } from "./seal.ts";
import {
	type Field,
	type Prepared,
	type PrepareResult,
	prepareTasks,
	type TMeta,
	type Transform,
	type TransformCache,
} from "./transforms.ts";
import {
	appendManifestRow,
	combineHashes,
	manifestRow,
	type VariantSpec,
	variantHash,
	variantLabel,
} from "./variant.ts";

export const acOk = () => existsSync(AC_FILE);
export class Refused extends Error {
	constructor(
		msg: string,
		readonly code = 1,
	) {
		super(msg);
	}
}
export function acGate() {
	if (!acOk())
		throw new Refused(
			`AC gate: ${AC_FILE} absent — refusing real rounds (the orchestrator creates it after pmset confirms AC power). --dry-run is always allowed.`,
			3,
		);
}

const r1 = (x: number | null) => (x === null ? null : Math.round(x));
/** Field the request of `phase` was built from (for per-row transform meta). */
const fieldOf = (cls: ClassId, which: 1 | 2): Field =>
	cls === "e" ? "text" : cls === "f" ? (which === 2 ? "q2" : "q1") : "prompt";

export function rowOf(
	x: {
		run: string;
		variant: string;
		cls: ClassId;
		task: string;
		phase: string;
	},
	leg: Leg,
	o: Out,
	s: Score | null,
	nonce: string,
	userChars: number,
	tm?: TMeta,
) {
	const c = costOf(leg, o);
	return {
		type: "row",
		run: x.run,
		variant: x.variant,
		ts: new Date().toISOString(),
		cls: x.cls,
		task: x.task,
		leg: leg.id,
		phase: x.phase,
		ok: o.ok,
		status: o.status,
		err: o.err,
		wall_ms: r1(o.wall),
		ttft_ms: r1(o.ttft),
		ttfc_ms: r1(o.ttfc),
		streamed: o.streamed,
		in_tok: o.inTok,
		out_tok: o.outTok,
		reason_tok: o.reasonTok,
		reason_chars: o.reasoningChars,
		cached_tok: o.cachedTok,
		tok_est: o.tokEst,
		finish: o.finish,
		served: o.served,
		routed: o.routed
			? {
					tier: o.routed.tier,
					category: o.routed.category,
					port: o.routed.port,
					model: o.routed.model,
				}
			: undefined,
		kev: o.kev,
		cost_usd: c.usd,
		priced: c.priced,
		score: s?.score ?? null,
		pass: s?.pass ?? null,
		conf: s?.conf ?? null,
		detail: s?.detail,
		load1: load1(),
		nonce,
		user_chars: userChars,
		transform: tm?.transform,
		transform_ms: tm?.transform_ms,
		chars_in: tm?.chars_in,
		chars_out: tm?.chars_out,
		cache_hit: tm?.cache_hit,
		fallback: tm?.fallback,
		answer: o.text.slice(0, 4000),
		capped: o.capped,
	};
}

export interface RunOpts {
	runId: string;
	variant: VariantSpec;
	transform: Transform;
	cache: TransformCache;
	legs: Leg[];
	classes: ClassId[];
	n: number;
	warm: boolean;
	replay: number;
	allowDown: boolean;
	allowFallback: boolean;
	refresh: boolean;
	resDir?: string;
	log?: (s: string) => void;
}
/** Transform every selected task once, up front (never inside a timed call). */
export async function prepareVariant(
	o: Pick<
		RunOpts,
		| "transform"
		| "cache"
		| "classes"
		| "n"
		| "allowFallback"
		| "refresh"
		| "log"
	> & { offline?: boolean },
): Promise<Map<ClassId, PrepareResult>> {
	const out = new Map<ClassId, PrepareResult>();
	for (const cls of o.classes) {
		const tasks = loadTasks(cls).tasks.slice(0, o.n);
		const r = await prepareTasks(cls, tasks, o.transform, {
			cache: o.cache,
			refresh: o.refresh,
			offline: o.offline,
			allowFallback: o.allowFallback,
			log: o.log,
		});
		if (r.failures.length && !o.allowFallback)
			throw new Refused(
				`transform ${o.transform.id} failed on ${r.failures.length} ${cls} prompt(s) (first: ${r.failures[0]}); fix the transform or pass --allow-fallback (falls back to the sealed prompt, flagged per row)`,
			);
		out.set(cls, r);
	}
	return out;
}

export async function runVariant(o: RunOpts): Promise<string> {
	const log = o.log ?? ((s: string) => console.error(s));
	acGate();
	const mv = verifyManifest();
	if (!mv.ok)
		throw new Refused(
			"task manifest verification FAILED — sealed sets changed; refusing to run",
		);
	if (o.legs.some((l) => l.id === "pure-api") && !process.env.ZAI_API_KEY)
		throw new Refused(
			"baseline leg pure-api needs ZAI_API_KEY in env (never read from files). Use --models/--legs without pure-api (no headline possible).",
		);
	const resDir = o.resDir ?? RES_DIR;
	mkdirSync(resDir, { recursive: true });
	const file = join(resDir, `${o.runId}.jsonl`);
	const vh = variantHash(o.variant);
	const label = variantLabel(o.variant);
	const done = new Set<string>();
	let fresh = true;
	for await (const r of jsonl<{
		type: string;
		cls: string;
		task: string;
		leg: string;
		phase: string;
		variant_hash?: string;
	}>(file)) {
		if (fresh && r.type === "meta" && r.variant_hash !== vh)
			throw new Refused(
				`run ${o.runId} was started as variant ${r.variant_hash}; this invocation is ${vh} — refusing to mix variants in one run`,
			);
		fresh = false;
		if (r.type === "row") done.add(`${r.cls}|${r.task}|${r.leg}|${r.phase}`);
	}
	const put = (x: unknown) => appendFileSync(file, `${JSON.stringify(x)}\n`);
	log(
		`run ${o.runId} [${label} ${vh}] → ${file} (${done.size} rows already done)`,
	);

	const prepared = await prepareVariant({ ...o, log });
	const ph: Record<string, string> = {};
	const chs: Record<string, string> = {};
	for (const [c, r] of prepared) {
		ph[c] = r.promptsHash;
		chs[c] = r.cacheHash;
	}

	const down: string[] = [];
	for (const l of o.legs)
		for (const p of portsFor(l)) {
			const r = await ping(l, p, o.runId);
			log(
				`preflight ${l.id}${p ? `:${p}` : ""} ${r.ok ? "ok" : `FAIL ${r.err}`} ${Math.round(r.wall)}ms`,
			);
			if (!r.ok) {
				if (!o.allowDown)
					throw new Refused(
						`preflight failed for ${l.id}; fix it or pass --allow-down to drop the leg (recorded)`,
					);
				down.push(l.id);
			}
		}
	const legs = o.legs.filter((l) => !down.includes(l.id));
	if (fresh) {
		const started = new Date().toISOString();
		const mrow = manifestRow(o.runId, o.variant, {
			classes: o.classes,
			n: o.n,
			sealed: mv.hash,
			cacheHash: combineHashes(chs),
			promptsHash: ph,
			started,
		});
		appendManifestRow(resDir, mrow);
		put({
			...mrow,
			type: "meta",
			host: hostname(),
			bun: Bun.version,
			manifest: mv.hash,
			generator: GEN,
			seed: SEED,
			legs: legs.map((l) => l.id),
			dropped: down,
			warm: o.warm,
			replay: o.replay,
			ac_file: AC_FILE,
			price_src: PRICE_SRC,
			prices: PRICES,
			load1: loadavg()[0],
			engine_key_src: engineKeySrc(),
			transform_failures: [...prepared.values()].flatMap((r) => r.failures),
		});
	}
	for (const cls of o.classes) {
		acGate();
		const prep = prepared.get(cls);
		if (!prep) continue;
		await runClass(
			o.runId,
			label,
			cls,
			prep.tasks,
			legsFor(cls, legs),
			o,
			done,
			put,
			log,
		);
	}
	put({
		type: "end",
		run: o.runId,
		ended: new Date().toISOString(),
		load1: loadavg()[0],
	});
	log(`done. bun bench/arena/run.ts --report --run-id ${o.runId}`);
	return o.runId;
}

async function runClass(
	run: string,
	variant: string,
	cls: ClassId,
	prepared: Map<string, Prepared>,
	Ls: Leg[],
	o: RunOpts,
	done: Set<string>,
	put: (x: unknown) => void,
	log: (s: string) => void,
) {
	const spec = CLASSES[cls];
	const tasks = [...prepared.values()];
	if (o.n > tasks.length)
		log(`class ${cls}: sealed set has ${tasks.length} < n=${o.n}; using all`);
	for (const leg of Ls) {
		// warmup per (leg, class): excluded from stats, logged
		if (done.has(`${cls}|warmup|${leg.id}|warmup`)) continue;
		const non = nonceOf(run, leg.id, `warmup-${cls}`, "warmup");
		const user = `[ref:${non}]\nReply with the single word: ready`;
		const out = await callLeg(
			leg,
			{
				user,
				maxTokens: 16,
				effort: spec.effort,
				timeoutMs: spec.timeoutMs,
				port: spec.port,
				kevState: `[ref:${non}] warmup`,
			},
			KEV_Q,
		);
		put(
			rowOf(
				{ run, variant, cls, task: "warmup", phase: "warmup" },
				leg,
				out,
				null,
				non,
				user.length,
			),
		);
	}
	const one = async (p: Prepared, leg: Leg, phase: string, which: 1 | 2) => {
		const t: Task = p.task;
		if (done.has(`${cls}|${t.id}|${leg.id}|${phase}`)) return null;
		const non = nonceOf(run, leg.id, t.id, "cold");
		const q = buildReq(cls, t, leg, non, which);
		const out = await callLeg(leg, q, which === 1 ? KEV_Q : undefined);
		const s = await scoreOut(cls, t, leg, out, which);
		put(
			rowOf(
				{ run, variant, cls, task: t.id, phase },
				leg,
				out,
				s,
				non,
				q.user.length,
				p.meta[fieldOf(cls, which)],
			),
		);
		return { out, s };
	};
	for (let i = 0; i < tasks.length; i++) {
		const p = tasks[i];
		if (!p) continue;
		const order = Ls.map((_, k) => Ls[(k + i) % Ls.length]).filter(
			(l): l is Leg => !!l,
		);
		for (const leg of order) {
			const r = await one(p, leg, "cold", 1);
			if (r)
				log(
					`[${cls} ${i + 1}/${tasks.length}] ${leg.id.padEnd(18)} ${r.out.ok ? "ok " : "ERR"} ${String(Math.round(r.out.wall)).padStart(6)}ms q=${r.s.score.toFixed(2)} ${r.out.ok ? "" : r.out.err}`,
				);
			if (cls === "f" && o.warm) await one(p, leg, "warm", 2);
		}
	}
	// byte-identical resend → response-cache behaviour
	for (const p of tasks.slice(0, o.replay))
		for (const leg of Ls) await one(p, leg, "replay", 1);
}
