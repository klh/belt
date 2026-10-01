// bin/fit-classifier.ts — W159 two-stage fit, stage 2: a reclassifier for
// AMBIGUOUS fits only (federation-2026-10-01 "Two-stage fit", owner law).
// Stage 1 is the W96 regex gate (parseHint/hintFit — <1ms, always front,
// semantics untouched). Stage 2 refines fit for LONG-RUNNING task placement
// so heavy work lands where it does not overtax the user's machine: a small
// local model (:8902-class) judges which placement class (local/remote/
// cloud) actually satisfies the task's hint.
//
// Latency law: verdicts are CACHED per task signature (sha256 of the hint)
// and the cache lookup is synchronous O(1) — but a cache MISS never blocks
// a decision: the model call runs async (void, deduped per signature), so
// the routing hot path stays regex-only. If the local model is absent, one
// on-demand spawn is attempted; failing that, degrade to regex-only
// honestly. Local calls only — domain=private by definition; nothing here
// ever touches the hub or the cloud.
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	renameSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SPECIALISTS, type Specialist } from "./registry.ts";
import { spawnArgs, mlxLogPath } from "./spawner.ts";

// ─── config ───
const CLASSIFIER_PORT = 8902; // extract specialist — the minimal tier's judge
const PROBE_TIMEOUT_MS = 1200;
const CALL_TIMEOUT_MS = 20_000;
const CACHE_CAP = 512; // LRU by ts — bounded file, never grows unbounded
const SPAWN_RETRY_MS = 60_000; // at most one spawn attempt per minute

export const FIT_VERDICTS_PATH =
	process.env.FIT_VERDICTS_PATH ??
	join(process.env.HOME ?? "", ".claude", "local-llm", "fit-verdicts.json");

export type Placement = "local" | "remote" | "cloud";

export interface FitVerdict {
	/** sha256-16 of the normalized hint — the cache key. */
	sig: string;
	placement: Placement;
	/** optional model glob ('qwen*') narrowing within the placement class */
	model_glob: string | null;
	/** true when the task looks long-running (heavy, placement matters) */
	longrun: boolean;
	confidence: number;
	source: "model";
	ts: number;
}

/** Minimal shape the classifier needs from a candidate (structural — no
 *  import from route-policy; belt's Candidate satisfies this). */
export interface FitCandidate {
	machine: string;
	port: number;
	model: string;
	kind: "local" | "remote" | "cloud";
	tags: string;
}

// ─── verdict cache (per task signature, O(1) sync lookup) ───
const mem = new Map<string, FitVerdict>();
let loaded = false;
/** port → last spawn attempt ts (one on-demand spawn per minute, max). */
const lastSpawnAttempt = new Map<number, number>();

/** Task signature: sha256-16 of the normalized hint — the cache key. The
 *  hint grammar is the deterministic task encoding, so the same task always
 *  maps to the same signature (and thus one model call, ever). */
export function taskSignature(raw: string): string {
	return createHash("sha256")
		.update(raw.trim().replace(/\s+/g, " ").toLowerCase())
		.digest("hex")
		.slice(0, 16);
}

function loadCache(): void {
	if (loaded) return;
	loaded = true;
	if (!existsSync(FIT_VERDICTS_PATH)) return;
	try {
		const parsed: unknown = JSON.parse(readFileSync(FIT_VERDICTS_PATH, "utf8"));
		if (typeof parsed === "object" && parsed !== null)
			for (const [sig, v] of Object.entries(parsed as Record<string, unknown>))
				if (isVerdict(v)) mem.set(sig, v);
	} catch {
		console.error(`[fit-classifier] unreadable cache ${FIT_VERDICTS_PATH}`);
	}
}

/** Structural verdict guard — a corrupted cache entry is dropped, never served. */
function isVerdict(v: unknown): v is FitVerdict {
	if (typeof v !== "object" || v === null) return false;
	const c = v as Partial<FitVerdict>;
	return (
		typeof c.sig === "string" &&
		(c.placement === "local" ||
			c.placement === "remote" ||
			c.placement === "cloud") &&
		(c.model_glob === null || typeof c.model_glob === "string") &&
		typeof c.longrun === "boolean" &&
		typeof c.confidence === "number" &&
		c.source === "model" &&
		typeof c.ts === "number"
	);
}

/** Save the in-memory cache to disk, capped LRU by ts. Tmp file + rename so
 *  a concurrent reader never sees a torn cache file. */
function saveCache(): void {
	try {
		mkdirSync(join(FIT_VERDICTS_PATH, ".."), { recursive: true });
		const entries = [...mem.values()].sort((a, b) => b.ts - a.ts);
		const capped: Record<string, FitVerdict> = {};
		for (const v of entries.slice(0, CACHE_CAP)) capped[v.sig] = v;
		const tmp = `${FIT_VERDICTS_PATH}.tmp`;
		writeFileSync(tmp, JSON.stringify(capped, null, "\t"));
		renameSync(tmp, FIT_VERDICTS_PATH);
	} catch (e) {
		console.error(`[fit-classifier] cache write failed: ${String(e)}`);
	}
}

/** Sync O(1) lookup — the ONLY classifier call on the routing hot path. */
export function lookupFitVerdict(sig: string): FitVerdict | null {
	loadCache();
	return mem.get(sig) ?? null;
}

// ─── verdict application (deterministic, pure) ───
const RE_META = new Set("\\.*+?^$()[]{}|/".split(""));

const escapeRe = (s: string): string =>
	s
		.split("")
		.map((ch) => (RE_META.has(ch) ? `\\${ch}` : ch))
		.join("");

/** Glob → case-insensitive substring regexp ('*' wildcard), same semantics
 *  as route-policy's model globs. Non-compiling input degrades literal. */
const globToRe = (glob: string): RegExp => {
	try {
		return new RegExp(
			glob
				.split("")
				.map((ch) => (ch === "*" ? ".*" : escapeRe(ch)))
				.join(""),
			"i",
		);
	} catch {
		return new RegExp(escapeRe(glob), "i");
	}
};

/** Does a candidate satisfy the verdict? Placement class must match; a
 *  model glob narrows within the class (matched against id AND tags). */
export function verdictMatches(c: FitCandidate, v: FitVerdict): boolean {
	if (c.kind !== v.placement) return false;
	if (v.model_glob === null) return true;
	const re = globToRe(v.model_glob);
	return re.test(c.model) || re.test(c.tags);
}

/** Refine an ordered candidate list by a cached verdict: matching candidates
 *  move to the front, relative order otherwise preserved (stable partition). */
export function applyFitVerdict<T extends FitCandidate>(
	list: T[],
	v: FitVerdict,
): T[] {
	const hit = list.filter((c) => verdictMatches(c, v));
	const rest = list.filter((c) => !verdictMatches(c, v));
	return [...hit, ...rest];
}

// ─── the local model (loopback only — never hub, never cloud) ───
function specialist(): Specialist | undefined {
	return SPECIALISTS.find((s) => s.port === CLASSIFIER_PORT);
}

async function probeClassifier(): Promise<boolean> {
	try {
		const r = await fetch(`http://127.0.0.1:${CLASSIFIER_PORT}/v1/models`, {
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		return r.ok;
	} catch {
		return false;
	}
}

/** On-demand spawn of the minimal-tier specialist (the swarm's own spawner);
 *  at most one attempt per SPAWN_RETRY_MS — no spawn storms. */
function spawnClassifier(): boolean {
	const s = specialist();
	if (s === undefined) return false;
	const now = Date.now();
	const last = lastSpawnAttempt.get(CLASSIFIER_PORT) ?? 0;
	if (now - last < SPAWN_RETRY_MS) return false;
	lastSpawnAttempt.set(CLASSIFIER_PORT, now);
	try {
		const log = mlxLogPath(s);
		const shellCmd = `nohup ${spawnArgs(s).join(" ")} >> ${log} 2>&1 &`;
		Bun.spawn(["/bin/sh", "-c", shellCmd], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		console.error(
			`[fit-classifier] spawning :${CLASSIFIER_PORT} (${s.model}) on demand`,
		);
		return true;
	} catch (e) {
		console.error(`[fit-classifier] spawn failed: ${String(e)}`);
		return false;
	}
}

/** One classification call against the loopback model. Capped stream read —
 *  never res.json() on trust (streams-over-buffers). */
async function callClassifier(prompt: string): Promise<string> {
	const r = await fetch(
		`http://127.0.0.1:${CLASSIFIER_PORT}/v1/chat/completions`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: specialist()?.model ?? "",
				messages: [
					{
						role: "system",
						content:
							"You output ONLY compact JSON. No prose, no markdown fences.",
					},
					{ role: "user", content: prompt },
				],
				max_tokens: 120,
				temperature: 0,
			}),
			signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
		},
	);
	if (!r.ok) throw new Error(`HTTP ${r.status} from :${CLASSIFIER_PORT}`);
	const reader = r.body?.getReader();
	if (reader === undefined) throw new Error("empty body");
	const dec = new TextDecoder();
	let text = "";
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > 16 * 1024) {
			await reader.cancel();
			throw new Error("body exceeded 16KB cap");
		}
		text += dec.decode(value, { stream: true });
	}
	text += dec.decode();
	const j = JSON.parse(text) as {
		choices?: { message?: { content?: string } }[];
	};
	return j.choices?.[0]?.message?.content ?? "";
}

/** Validate a parsed model reply — honest null on any shape deviation. */
function verdictFromParsed(
	p: {
		placement?: unknown;
		model_glob?: unknown;
		longrun?: unknown;
		confidence?: unknown;
	},
	sig: string,
): FitVerdict | null {
	const okPlacement =
		p.placement === "local" ||
		p.placement === "remote" ||
		p.placement === "cloud";
	if (
		!okPlacement ||
		(p.model_glob !== null && typeof p.model_glob !== "string") ||
		typeof p.longrun !== "boolean" ||
		typeof p.confidence !== "number"
	)
		return null;
	return {
		sig,
		placement: p.placement as Placement,
		model_glob: (p.model_glob as string | null) ?? null,
		longrun: p.longrun,
		confidence: p.confidence,
		source: "model",
		ts: Date.now(),
	};
}

/** Parse the model's reply: extract the JSON object, validate, build. */
export function parseVerdictReply(raw: string, sig: string): FitVerdict | null {
	const m = raw.match(/\{[\s\S]*\}/);
	if (m === null) return null;
	try {
		return verdictFromParsed(JSON.parse(m[0]), sig);
	} catch {
		return null;
	}
}

function buildPrompt(hint: string, candidates: FitCandidate[]): string {
	const lines = candidates.map(
		(c) =>
			`- ${c.machine}:${c.port} ${c.model} [${c.kind}] ${c.tags.slice(0, 80)}`,
	);
	return [
		`Task hint: "${hint}"`,
		"Candidate models (machine, model, class, capabilities):",
		...lines,
		"Which placement class best fits this task for LONG-RUNNING work?",
		'Reply ONLY: {"placement":"local|remote|cloud","model_glob":"<glob|null>","longrun":true|false,"confidence":0-1}',
	].join("\n");
}

// ─── background classification (async, off the hot path) ───
/** Classify + cache — the testable core (caller injected; tests count calls
 *  to prove same-task = one model call). Returns false when nothing was
 *  cached (unparseable reply — regex-only stands). */
export async function classifyAndCache(
	sig: string,
	hint: string,
	candidates: FitCandidate[],
	caller: (prompt: string) => Promise<string>,
): Promise<boolean> {
	if (mem.has(sig)) return true; // second look = cache hit, never a new call
	const raw = await caller(buildPrompt(hint, candidates));
	const verdict = parseVerdictReply(raw, sig);
	if (verdict === null) return false;
	mem.set(sig, verdict);
	saveCache();
	return true;
}

async function runClassification(
	sig: string,
	hint: string,
	candidates: FitCandidate[],
): Promise<void> {
	let up = await probeClassifier();
	if (!up) {
		spawnClassifier();
		await new Promise((r) => setTimeout(r, 1500));
		up = await probeClassifier();
	}
	if (!up) {
		console.error(
			`[fit-classifier] :${CLASSIFIER_PORT} unavailable — regex-only verdict stands for sig ${sig}`,
		);
		return;
	}
	const ok = await classifyAndCache(sig, hint, candidates, callClassifier);
	if (!ok)
		console.error(
			`[fit-classifier] unparseable model reply for sig ${sig} — nothing cached`,
		);
}

const inFlight = new Map<string, Promise<void>>();

/** Fire-and-forget classification — NEVER awaited by the routing hot path.
 *  Deduped per signature: identical tasks in flight share one model call. */
export function scheduleFitClassification(
	sig: string,
	hint: string,
	candidates: FitCandidate[],
): void {
	if (inFlight.has(sig) || mem.has(sig)) return;
	const p = runClassification(sig, hint, candidates)
		.catch((e) =>
			console.error(`[fit-classifier] classify failed: ${String(e)}`),
		)
		.finally(() => inFlight.delete(sig));
	inFlight.set(sig, p);
}
