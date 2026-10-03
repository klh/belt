// transforms.ts — the transform dimension. A Transform rewrites the sealed
// user prompt before dispatch; every leg of a variant receives the SAME
// transformed text. Pluggable: any module exporting a Transform (or a bare
// `(id, prompt) => prompt` function) can replace the reference condenser via
// --condenser <path> without touching the harness.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONDENSE_VERSION, condense } from "./condense.ts";
import {
	type ClassId,
	LINE_CAP,
	ROUTER,
	readCapped,
	sha,
	stripThink,
	type Task,
} from "./core.ts";

export interface Transform {
	/** variant name: none | condense | enhance | both | custom */
	readonly id: string;
	/** bump whenever output for the same input may change */
	readonly version: string;
	/** false ⇒ the harness caches output per (task, transform) on disk */
	readonly deterministic: boolean;
	transform(id: string, prompt: string): string | Promise<string>;
}
export const TRANSFORM_IDS = ["none", "condense", "enhance", "both"] as const;
export type TransformId = (typeof TRANSFORM_IDS)[number];
export const isTransformId = (s: string): s is TransformId =>
	(TRANSFORM_IDS as readonly string[]).includes(s);

export const noneTransform: Transform = {
	id: "none",
	version: "none/1",
	deterministic: true,
	transform: (_id, prompt) => prompt,
};
export const condenseTransform: Transform = {
	id: "condense",
	version: CONDENSE_VERSION,
	deterministic: true,
	transform: (_id, prompt) => condense(prompt),
};

// ---------------------------------------------------------------- enhance
export const ENHANCE_SYSTEM = `You rewrite prompts for a language model so they are clearer and more explicit.
Rules:
1. Keep every requirement, constraint, number, name, exact term, quoted string, fenced or """-delimited block and output-format line VERBATIM.
2. Never add requirements, never drop any, never answer the prompt.
3. Output ONLY the rewritten prompt — no preamble, no commentary, no code fences around it.`;
/** Short budget: proportional to the input, clamped. */
export const enhanceMaxTokens = (prompt: string) =>
	Math.min(768, Math.max(128, Math.ceil((prompt.length / 3.6) * 1.5) + 64));

export interface EnhanceOpts {
	url?: string;
	model?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}
interface MsgJson {
	content?: { type?: string; text?: string }[];
	stop_reason?: string;
	model?: string;
	_routing?: { model?: string; port?: number | string };
}
/** Local-LLM rewrite through the :4000 belt router (Anthropic wire). Not
 *  deterministic — the harness caches it per (task, transform). */
export function makeEnhance(opts: EnhanceOpts = {}): Transform & {
	lastModel: string | null;
} {
	const url = opts.url ?? `${ROUTER}/v1/messages`;
	const doFetch = opts.fetchImpl ?? fetch;
	const t: Transform & { lastModel: string | null } = {
		id: "enhance",
		version: "enhance-router/1",
		deterministic: false,
		lastModel: null,
		async transform(_id, prompt) {
			const res = await doFetch(url, {
				method: "POST",
				signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
				headers: {
					"content-type": "application/json",
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model: opts.model ?? "local",
					max_tokens: enhanceMaxTokens(prompt),
					temperature: 0,
					stream: false,
					system: ENHANCE_SYSTEM,
					messages: [{ role: "user", content: prompt }],
				}),
			});
			const raw = await readCapped(res.body, LINE_CAP);
			if (!res.ok)
				throw new Error(`enhance HTTP ${res.status}: ${raw.slice(0, 160)}`);
			const j = JSON.parse(raw) as MsgJson;
			if (j.stop_reason === "max_tokens")
				throw new Error("enhance truncated at max_tokens");
			const text = (j.content ?? [])
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("");
			const out = stripThink(text)
				.replace(/^```[\w-]*\n([\s\S]*)\n```$/, "$1")
				.trim();
			if (!out) throw new Error("enhance returned empty text");
			t.lastModel = j._routing?.model ?? j.model ?? null;
			return out;
		},
	};
	return t;
}

/** a then b; deterministic only if both are. */
export function compose(id: string, a: Transform, b: Transform): Transform {
	return {
		id,
		version: `${a.version}+${b.version}`,
		deterministic: a.deterministic && b.deterministic,
		transform: async (tid, p) => b.transform(tid, await a.transform(tid, p)),
		get lastModel() {
			return (b as { lastModel?: string | null }).lastModel ?? null;
		},
	} as Transform;
}

/** Load an external condenser: default export (or named `transform`) that is
 *  a Transform object or a bare `(id, prompt) => prompt` function. */
export async function loadCondenser(path: string): Promise<Transform> {
	const mod = (await import(path)) as {
		default?: unknown;
		transform?: unknown;
	};
	const x = mod.default ?? mod.transform;
	const src = readFileSync(path, "utf8");
	const ver = `ext:${path.split("/").pop()}@${sha(src).slice(0, 8)}`;
	if (typeof x === "function")
		return {
			id: "condense",
			version: ver,
			deterministic: false,
			transform: x as Transform["transform"],
		};
	if (x && typeof x === "object" && "transform" in x) {
		const t = x as Partial<Transform> & Pick<Transform, "transform">;
		return {
			id: "condense",
			version: t.version ?? ver,
			deterministic: t.deterministic ?? false,
			transform: t.transform.bind(t),
		};
	}
	throw new Error(`${path}: no Transform / transform(id, prompt) export`);
}

export function buildTransform(
	name: TransformId,
	parts: { condenser?: Transform; enhance?: Transform } = {},
): Transform {
	const c = parts.condenser ?? condenseTransform;
	const e = parts.enhance ?? makeEnhance();
	if (name === "none") return noneTransform;
	if (name === "condense") return c;
	if (name === "enhance") return e;
	return compose("both", c, e);
}

// ---------------------------------------------------------------- cache
export interface CacheEntry {
	key: string;
	transform: string;
	version: string;
	input_sha: string;
	output: string;
	ms: number;
	model?: string | null;
	at: string;
}
export class CacheMismatch extends Error {}
/** One JSON file per (transform, task-field) — reproducible across rounds. */
export class TransformCache {
	constructor(readonly dir: string) {}
	path(transform: string, key: string) {
		return join(this.dir, transform, `${key}.json`);
	}
	get(transform: string, key: string): CacheEntry | null {
		const p = this.path(transform, key);
		return existsSync(p)
			? (JSON.parse(readFileSync(p, "utf8")) as CacheEntry)
			: null;
	}
	put(e: CacheEntry) {
		mkdirSync(join(this.dir, e.transform), { recursive: true });
		writeFileSync(
			this.path(e.transform, e.key),
			`${JSON.stringify(e, null, 1)}\n`,
		);
	}
}

export interface TMeta {
	transform: string;
	transform_ms: number;
	chars_in: number;
	chars_out: number;
	cache_hit: boolean;
	fallback?: string;
}
export interface Applied {
	text: string;
	meta: TMeta;
	entry: CacheEntry | null;
}
export interface ApplyOpts {
	cache: TransformCache | null;
	refresh?: boolean;
	/** forbid cache misses (dry-run: never generate) */
	offline?: boolean;
}
export async function applyTransform(
	t: Transform,
	key: string,
	prompt: string,
	o: ApplyOpts,
): Promise<Applied> {
	const meta = (text: string, ms: number, hit: boolean): TMeta => ({
		transform: t.id,
		transform_ms: Math.round(ms * 100) / 100,
		chars_in: prompt.length,
		chars_out: text.length,
		cache_hit: hit,
	});
	const t0 = performance.now();
	if (t.deterministic || !o.cache) {
		const text = await t.transform(key, prompt);
		return {
			text,
			meta: meta(text, performance.now() - t0, false),
			entry: null,
		};
	}
	const inSha = sha(prompt);
	const hit = o.cache.get(t.id, key);
	if (hit && !o.refresh) {
		if (hit.input_sha !== inSha || hit.version !== t.version)
			throw new CacheMismatch(
				`cache ${t.id}/${key}: input or version changed (cached ${hit.version}, now ${t.version}) — pass --refresh-cache to regenerate`,
			);
		return {
			text: hit.output,
			meta: meta(hit.output, performance.now() - t0, true),
			entry: hit,
		};
	}
	if (o.offline) throw new CacheMismatch(`cache miss ${t.id}/${key} (offline)`);
	const text = await t.transform(key, prompt);
	const ms = performance.now() - t0;
	const entry: CacheEntry = {
		key,
		transform: t.id,
		version: t.version,
		input_sha: inSha,
		output: text,
		ms: Math.round(ms),
		model: (t as { lastModel?: string | null }).lastModel ?? null,
		at: new Date().toISOString(),
	};
	o.cache.put(entry);
	return { text, meta: meta(text, ms, false), entry };
}

// ---------------------------------------------------------------- prepare a variant
/** Prompt fields the transform rewrites, per class. e: the routed request
 *  (the router-instruction framing is harness, not prompt); f: the questions
 *  only (the log haystack is data — rewriting it would move the needles). */
export const FIELDS: Record<
	ClassId,
	readonly ("prompt" | "text" | "q1" | "q2")[]
> = {
	a: ["prompt"],
	b: ["prompt"],
	c: ["prompt"],
	d: ["prompt"],
	e: ["text"],
	f: ["q1", "q2"],
};
export type Field = (typeof FIELDS)[ClassId][number];
export interface Prepared {
	task: Task;
	meta: Partial<Record<Field, TMeta>>;
}
export interface PrepareResult {
	tasks: Map<string, Prepared>;
	/** sha over every transformed prompt, in order — byte-stability witness */
	promptsHash: string;
	/** sha over the cache entries used ("n/a" for deterministic transforms) */
	cacheHash: string;
	failures: string[];
	hits: number;
	misses: number;
}
export async function prepareTasks(
	cls: ClassId,
	tasks: Task[],
	t: Transform,
	o: ApplyOpts & { allowFallback?: boolean; log?: (s: string) => void },
): Promise<PrepareResult> {
	const out = new Map<string, Prepared>();
	const ph: string[] = [];
	const ch: string[] = [];
	const failures: string[] = [];
	let hits = 0;
	let misses = 0;
	for (const task of tasks) {
		const view: Task = { ...task };
		const meta: Prepared["meta"] = {};
		for (const f of FIELDS[cls]) {
			const src = task[f];
			if (src === undefined) continue;
			const key = `${task.id}.${f}`;
			try {
				const r = await applyTransform(t, key, src, o);
				view[f] = r.text;
				meta[f] = r.meta;
				if (r.entry)
					ch.push(`${key}\t${r.entry.input_sha}\t${sha(r.entry.output)}`);
				if (r.meta.cache_hit) hits++;
				else if (!t.deterministic) misses++;
			} catch (e) {
				if (e instanceof CacheMismatch && !o.allowFallback) throw e;
				const why = String((e as Error)?.message ?? e).slice(0, 160);
				failures.push(`${key}: ${why}`);
				o.log?.(`transform ${t.id} ${key} FAILED: ${why}`);
				meta[f] = {
					transform: t.id,
					transform_ms: 0,
					chars_in: src.length,
					chars_out: src.length,
					cache_hit: false,
					fallback: why,
				};
			}
			ph.push(`${key}\t${sha(view[f] ?? "")}`);
		}
		out.set(task.id, { task: view, meta });
	}
	return {
		tasks: out,
		promptsHash: sha(ph.join("\n")).slice(0, 16),
		cacheHash: t.deterministic ? "n/a" : sha(ch.sort().join("\n")).slice(0, 16),
		failures,
		hits,
		misses,
	};
}
