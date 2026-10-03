// dryrun.ts — everything a real round checks, minus the round. Shared
// sections once (AC gate, seal, checkers, sandbox, inventory), then one
// section per variant (legs, identity, transform stats, pings, plan).
// Never generates enhance output: the cache is read offline.
import { existsSync, rmSync } from "node:fs";
import { hostname, loadavg } from "node:os";
import { join } from "node:path";
import { condense } from "./condense.ts";
import {
	AC_FILE,
	ARENA_DIR,
	CHARS_PER_TOK_LOG,
	CHARS_PER_TOK_TEXT,
	CLASSES,
	type ClassId,
	ENGINE,
	ENGINE_IDS,
	FENCE,
	KEV,
	LINE_CAP,
	LOCAL_IDS,
	PRICE_SRC,
	PRICES,
	PURE_MODEL,
	ROUTER,
	readCapped,
} from "./core.ts";
import {
	buildReq,
	engineKey,
	engineKeySrc,
	type Leg,
	LEGS,
	legsFor,
	type Out,
	ping,
	portsFor,
	target,
} from "./legs.ts";
import { acOk, prepareVariant } from "./runner.ts";
import { checkCode, goldFor, sandboxInfo, scoreText } from "./scoring.ts";
import { loadTasks, verifyManifest } from "./seal.ts";
import { f2, qualLabel, row, sep, speedLabel } from "./stats.ts";
import { FIELDS, type Transform, type TransformCache } from "./transforms.ts";
import {
	runIdFor,
	type VariantSpec,
	variantHash,
	variantLabel,
} from "./variant.ts";

export interface DryVariant {
	spec: VariantSpec;
	transform: Transform;
	legs: Leg[];
}
export interface DryOpts {
	variants: DryVariant[];
	classes: ClassId[];
	n: number;
	cache: TransformCache;
	ping: boolean;
	cmd: string;
}
interface Tally {
	pass: number;
	fail: number;
}
type P = (s?: string) => void;
const mark = (t: Tally, ok: boolean) => {
	if (ok) t.pass++;
	else t.fail++;
	return ok ? "PASS" : "FAIL";
};

async function getJson(url: string, key?: string) {
	const t0 = performance.now();
	try {
		const res = await fetch(url, {
			headers: key ? { authorization: `Bearer ${key}` } : {},
			signal: AbortSignal.timeout(10_000),
		});
		const raw = await readCapped(res.body, LINE_CAP);
		let j: unknown = null;
		try {
			j = JSON.parse(raw);
		} catch {
			j = raw.slice(0, 120);
		}
		return { status: res.status, j, ms: performance.now() - t0 };
	} catch (e) {
		return {
			status: 0,
			j: null,
			err: String((e as Error)?.message ?? e).slice(0, 120),
			ms: performance.now() - t0,
		};
	}
}

async function checkerSelfTest(p: P, t: Tally) {
	p("## 3. Checker self-test (gold must score 1.0, garbage 0)");
	p();
	p(`Code checks run under: ${sandboxInfo().why}.`);
	p();
	p("| class | tasks | gold = 1.0 | garbage = 0 | verdict |");
	p(sep(5));
	for (const c of Object.values(CLASSES)) {
		const ts = loadTasks(c.id).tasks;
		let g = 0;
		let j = 0;
		const bad: string[] = [];
		for (const task of ts) {
			const { gold, junk } = goldFor(task, c.id);
			const sg = await scoreText(task.check, gold);
			const sj = await scoreText(task.check, junk);
			if (sg.pass && sg.score === 1) g++;
			else bad.push(`${task.id}:${sg.detail}`);
			if (!sj.pass && sj.score < 1) j++;
			if (c.id === "f" && task.check2?.kind === "needle") {
				const s2 = await scoreText(task.check2, task.check2.expect);
				if (!s2.pass) bad.push(`${task.id}/q2`);
			}
		}
		const ok = g === ts.length && j === ts.length && !bad.length;
		const v = mark(t, ok);
		p(
			row([
				`${c.id} ${c.name}`,
				ts.length,
				`${g}/${ts.length}`,
				`${j}/${ts.length}`,
				ok ? v : `${v} ${bad.slice(0, 3).join(" ")}`,
			]),
		);
	}
	p();
	const esc = join(ARENA_DIR, `.sbx-escape-${process.pid}`);
	const probes: [string, string][] = [
		[
			"write outside temp dir",
			`require("fs").writeFileSync(${JSON.stringify(esc)},"x");function f(x){return x}`,
		],
		[
			"network egress",
			`await fetch("http://127.0.0.1:4000/health/liveliness");function f(x){return x}`,
		],
		[
			"spawn a shell",
			`require("child_process").execSync("/bin/echo hi");function f(x){return x}`,
		],
		["infinite loop (10 s kill)", "while(true){}function f(x){return x}"],
	];
	p(
		'Sandbox containment probes (each hostile "solution" must score 0 and leave no trace):',
	);
	p();
	p("| probe | score | detail | verdict |");
	p(sep(4));
	for (const [name, code] of probes) {
		const s = await checkCode(`${FENCE}js\n${code}\n${FENCE}`, {
			fn: "f",
			tests: [[[1], 1]],
		});
		const ok = s.score === 0 && !existsSync(esc);
		rmSync(esc, { force: true });
		p(row([name, s.score, s.detail ?? "", mark(t, ok)]));
	}
	p();
}

type J = Record<string, unknown> & {
	data?: { id?: string }[];
	models?: { id?: string; run?: string }[];
	status?: string;
};
async function inventory(p: P, t: Tally) {
	p("## 4. Model inventory (GET, no generation)");
	p();
	p("| endpoint | HTTP | ms | finding | verdict |");
	p(sep(5));
	const inv = async (
		name: string,
		url: string,
		f: (j: J) => [string, boolean],
		key?: string,
	) => {
		const r = await getJson(url, key);
		const [txt, ok] =
			r.status === 200 && r.j && typeof r.j === "object"
				? f(r.j as J)
				: [r.err ?? JSON.stringify(r.j).slice(0, 100), false];
		p(row([name, r.status || "—", Math.round(r.ms), txt, mark(t, ok)]));
	};
	await inv(
		`\`:4100/v1/models\` (key: ${engineKeySrc()})`,
		`${ENGINE}/models`,
		(j) => {
			const ids = (j.data ?? []).map((m) => m.id ?? "");
			const miss = ENGINE_IDS.filter((x) => !ids.includes(x));
			return [
				miss.length
					? `missing ${miss.join(", ")}`
					: `required ids present: ${ENGINE_IDS.join(", ")} (${ids.length} total)`,
				!miss.length,
			];
		},
		engineKey(),
	);
	for (const port of [8901, 8902, 8903])
		await inv(
			`\`:${port}/v1/models\``,
			`http://127.0.0.1:${port}/v1/models`,
			(j) => {
				const id = j.data?.[0]?.id;
				return [`serves \`${id ?? "?"}\` (${LOCAL_IDS[port]})`, !!id];
			},
		);
	await inv("`:8912/v1/models` (kev)", `${KEV}/v1/models`, (j) => {
		const m = j.models?.[0];
		return [
			`\`${m?.id ?? "?"}\` run=${m?.run ?? "?"} (unpinned alias — record per run)`,
			!!m?.id,
		];
	});
	await inv("`:4000/health/liveliness`", `${ROUTER}/health/liveliness`, (j) => [
		JSON.stringify(j),
		j?.status === "alive" || j?.status === "ok",
	]);
	p();
}

/** Transform evidence for one variant: chars, savings, byte-stability. */
async function transformSection(v: DryVariant, o: DryOpts, p: P, t: Tally) {
	const tr = v.transform;
	p(
		`#### Transform \`${tr.id}\` (${tr.version}, ${tr.deterministic ? "deterministic" : "cached — read offline, never generated in a dry-run"})`,
	);
	p();
	if (tr.id === "none") {
		p("Identity: legs receive the sealed prompt bytes unchanged.");
		p();
		return;
	}
	const run = () =>
		prepareVariant({
			transform: tr,
			cache: o.cache,
			classes: o.classes,
			n: o.n,
			allowFallback: true,
			refresh: false,
			offline: true,
		});
	const a = await run();
	const b = tr.deterministic ? await run() : a;
	p(
		"| class | fields | prompts | chars in → out | Δchars | prompts hash | byte-stable (2 passes) | idempotent | cache hits / misses | verdict |",
	);
	p(sep(10));
	for (const c of o.classes) {
		const ra = a.get(c);
		const rb = b.get(c);
		if (!ra || !rb) continue;
		let cin = 0;
		let cout = 0;
		let idem = true;
		let k = 0;
		for (const pr of ra.tasks.values())
			for (const f of FIELDS[c]) {
				const m = pr.meta[f];
				if (!m) continue;
				k++;
				cin += m.chars_in;
				cout += m.chars_out;
				const x = pr.task[f] ?? "";
				if (tr.id === "condense" && tr.deterministic && condense(x) !== x)
					idem = false;
			}
		const stable = ra.promptsHash === rb.promptsHash;
		const misses = ra.failures.length;
		const ok = tr.deterministic ? stable && idem && cout <= cin : true;
		const verdict = tr.deterministic
			? mark(t, ok)
			: misses
				? `${misses} uncached — run \`--prepare\` (AC) first`
				: "cache complete";
		p(
			row([
				`${c} ${CLASSES[c].name}`,
				FIELDS[c].join(","),
				k,
				`${cin.toLocaleString("en-US")} → ${cout.toLocaleString("en-US")}`,
				cin ? `${f2((100 * (cout - cin)) / cin, 1)}%` : "—",
				`\`${ra.promptsHash}\``,
				tr.deterministic ? (stable ? "yes" : "NO") : "n/a",
				tr.id === "condense" && tr.deterministic
					? idem
						? "yes"
						: "NO"
					: "n/a",
				tr.deterministic ? "n/a" : `${ra.hits} / ${misses}`,
				verdict,
			]),
		);
	}
	p();
}

const pingCache = new Map<string, Out>();
async function pingSection(v: DryVariant, o: DryOpts, p: P, t: Tally) {
	if (!o.ping) {
		p("Pings skipped (`--no-ping`).");
		p();
		return;
	}
	p(
		"| leg | target | HTTP | wall ms | streamed | served / routed | tokens in/out | verdict |",
	);
	p(sep(8));
	for (const l of v.legs)
		for (const port of portsFor(l)) {
			const key = `${l.id}:${port}`;
			const prev = pingCache.get(key);
			const r = prev ?? (await ping(l, port, "dry"));
			pingCache.set(key, r);
			const verdict = prev
				? `${r.ok ? "PASS" : `FAIL — ${r.err}`} (same ping as above, not re-counted)`
				: r.ok
					? mark(t, true)
					: `${mark(t, false)} — ${r.err}`;
			const tg = target(l, port || 8902);
			const route = r.routed
				? `→ ${r.routed.category}:${r.routed.port}`
				: r.kev
					? `kev conf ${r.kev.confidence ?? "-"}`
					: "";
			p(
				row([
					`${l.id}${port ? ` :${port}` : ""}`,
					`\`${tg.url.replace(/\/v1\/.*$|\/chat\/completions$/, "")}\` ${tg.model}`,
					r.status || "—",
					Math.round(r.wall),
					r.streamed ? "yes" : "no",
					`${r.served ?? ""} ${route}`,
					`${r.inTok}/${r.outTok}${r.tokEst ? " est" : ""}`,
					verdict,
				]),
			);
		}
	p();
}

async function planSection(v: DryVariant, o: DryOpts, p: P) {
	p(
		`| class | max_tokens | z.ai effort | local tier | legs | requests (cold + warmups) | user chars sent (sum) | pure-api worst-case $ (transformed prompts) | quality label at n | speed label at n |`,
	);
	p(sep(10));
	const prepared = await prepareVariant({
		transform: v.transform,
		cache: o.cache,
		classes: o.classes,
		n: o.n,
		allowFallback: true,
		refresh: false,
		offline: true,
	});
	let totalReq = 0;
	let totalUsd = 0;
	const pr = PRICES[PURE_MODEL] ?? { in: 0, out: 0, cached: 0 };
	const base = LEGS[0] as Leg;
	for (const c of o.classes) {
		const s = CLASSES[c];
		const ts = [...(prepared.get(c)?.tasks.values() ?? [])].map((x) => x.task);
		const Ls = legsFor(c, v.legs);
		const cpt = c === "f" ? CHARS_PER_TOK_LOG : CHARS_PER_TOK_TEXT;
		const chars = ts.reduce(
			(acc, task) => acc + buildReq(c, task, base, "00000000").user.length,
			0,
		);
		const usd =
			((chars / cpt) * pr.in + ts.length * s.maxTokens * pr.out) / 1e6;
		const req = ts.length * Ls.length + Ls.length;
		totalReq += req;
		totalUsd += Ls.filter((l) => l.priced === "remote").length * usd;
		p(
			row([
				`${c} ${s.name}`,
				s.maxTokens,
				s.effort ?? "default",
				`:${s.port} ${LOCAL_IDS[s.port]}`,
				Ls.map((l) => l.id).join(", ") || "— (no leg serves this class)",
				req,
				chars.toLocaleString("en-US"),
				`$${usd.toFixed(4)}`,
				qualLabel(ts.length),
				speedLabel(ts.length),
			]),
		);
	}
	p();
	p(
		`Total ≈ ${totalReq} requests; remote worst-case (remote-priced legs, every reply hitting max_tokens) ≈ $${totalUsd.toFixed(3)} at ${PRICE_SRC}.`,
	);
	p();
}

export async function dryRun(
	o: DryOpts,
): Promise<{ md: string; code: number }> {
	const L: string[] = [];
	const p: P = (s = "") => {
		L.push(s);
	};
	const t: Tally = { pass: 0, fail: 0 };
	p("# DRYRUN — arena variant matrix");
	p();
	p(
		`Generated by \`${o.cmd}\` at ${new Date().toISOString()} on \`${hostname()}\`, bun ${Bun.version}. Real output, unedited. No real round was run; no enhance output was generated.`,
	);
	p();
	p("## 1. AC-power gate");
	p();
	p(
		acOk()
			? `\`${AC_FILE}\` PRESENT — \`--run\` would be allowed.`
			: `\`${AC_FILE}\` ABSENT — \`--run\` / \`--prepare\` refuse (exit 3). Expected: the orchestrator owns this gate; the dry-run never creates it.`,
	);
	p();
	p("## 2. Sealed task sets");
	p();
	const mv = verifyManifest();
	p("| file | class | n | size | sha256 | manifest |");
	p(sep(6));
	for (const r of mv.rows) p(r);
	p();
	p(`Manifest hash \`${mv.hash}\` — overall **${mark(t, mv.ok)}**.`);
	p();
	if (!mv.ok) {
		p("Cannot continue without sealed sets.");
		return { md: `${L.join("\n")}\n`, code: 1 };
	}
	await checkerSelfTest(p, t);
	await inventory(p, t);
	p(
		`## 5. Variants (${o.variants.length}; n=${o.n}, order ${o.classes.join(",")})`,
	);
	p();
	p("| variant | hash | transform version | models | legs | run-id preview |");
	p(sep(6));
	const now = new Date();
	for (const v of o.variants) {
		const vh = variantHash(v.spec);
		p(
			row([
				variantLabel(v.spec),
				`\`${vh}\``,
				v.spec.transformVersion,
				v.spec.models,
				v.legs.map((l) => l.id).join(", "),
				`\`${runIdFor(now, vh)}\``,
			]),
		);
	}
	p();
	for (const v of o.variants) {
		p(`### ${variantLabel(v.spec)} \`${variantHash(v.spec)}\``);
		p();
		await transformSection(v, o, p, t);
		p(
			"#### Endpoint pings (1-token, nonce'd, through the real runner code path)",
		);
		p();
		await pingSection(v, o, p, t);
		p(`#### Plan`);
		p();
		await planSection(v, o, p);
	}
	p(
		`Options: \`--warm\` (f: prefix-cache follow-up), \`--replay K\` (byte-identical resend), \`--allow-down\`, \`--run-id\` (resume, variant hash must match). Contention: lane agents share :890x; loadavg now ${loadavg()
			.map((x) => x.toFixed(2))
			.join(" / ")}.`,
	);
	p();
	p("## Verdict");
	p();
	p(
		`${t.pass} PASS / ${t.fail} FAIL. ${t.fail ? "FAIL rows above are real and unhidden; a real round needs every selected leg PASS (or --allow-down, recorded in the run meta)." : "All checks PASS."}`,
	);
	const md = `${L.join("\n")}\n`;
	return { md, code: t.fail ? 2 : 0 };
}
