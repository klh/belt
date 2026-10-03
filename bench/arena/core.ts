// core.ts — shared constants, types, seeded utilities and stream helpers for
// the bench arena. Zero dependencies (bun + node: builtins). Design and
// impartiality rules: bench/arena/README.md (ported from bench-plan.md).
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const ARENA_DIR = import.meta.dir;
export const TASK_DIR = join(ARENA_DIR, "tasks");
export const RES_DIR = join(ARENA_DIR, "results");
export const CACHE_DIR = join(ARENA_DIR, "cache");
export const SEED = "bench-arena/2026-10-02";
export const GEN = "arena-gen-1";
export const AC_FILE = "/tmp/bench-ac-ok";
export const ZAI_BASE =
	process.env.ZAI_BASE_URL ?? "https://api.z.ai/api/paas/v4";
export const ROUTER = "http://127.0.0.1:4000";
export const ENGINE = "http://127.0.0.1:4100/v1";
export const KEV = "http://127.0.0.1:8912";
export const PURE_MODEL = "glm-5.3-flash";
export const LOCAL_IDS: Record<number, string> = {
	8901: "local-coder",
	8902: "local-extract",
	8903: "local-reason",
};
export const ENGINE_IDS = [
	"zai-glm-5.3-flash",
	"local-coder",
	"local-extract",
	"local-reason",
];
export interface Price {
	in: number;
	cached: number;
	out: number;
}
// USD per 1M tokens — docs.z.ai/guides/overview/pricing, fetched 2026-10-02.
export const PRICES: Record<string, Price> = {
	"glm-5.3-flash": { in: 0.15, cached: 0.03, out: 0.5 },
	"glm-5.3-flashx": { in: 0.37, cached: 0.075, out: 1.25 },
	"glm-5.3": { in: 1.4, cached: 0.26, out: 4.4 },
	"glm-5.2": { in: 1.4, cached: 0.26, out: 4.4 },
};
export const PRICE_SRC =
	"docs.z.ai/guides/overview/pricing (fetched 2026-10-02)";
export const TEXT_CAP = 64 * 1024; // captured answer chars per request (streams law)
export const LINE_CAP = 4 * 1024 * 1024; // max single SSE line / JSON body
export const FENCE = "```";
export const CHARS_PER_TOK_LOG = 1.74; // measured on :8902/:8903 with log text, 2026-10-02
export const CHARS_PER_TOK_TEXT = 3.6;

export type ClassId = "a" | "b" | "c" | "d" | "e" | "f";
export interface ClassSpec {
	id: ClassId;
	name: string;
	file: string;
	maxTokens: number;
	effort: "low" | null;
	port: number;
	timeoutMs: number;
	sealedN: number;
}
// class → local tier oracle map (port) is sealed here; model sets reuse it.
export const CLASSES: Record<ClassId, ClassSpec> = {
	a: {
		id: "a",
		name: "short-chat",
		file: "a-short-chat.json",
		maxTokens: 1024,
		effort: "low",
		port: 8903,
		timeoutMs: 180e3,
		sealedN: 130,
	},
	b: {
		id: "b",
		name: "code-gen",
		file: "b-code-gen.json",
		maxTokens: 2048,
		effort: null,
		port: 8901,
		timeoutMs: 300e3,
		sealedN: 130,
	},
	c: {
		id: "c",
		name: "extract",
		file: "c-extract.json",
		maxTokens: 1024,
		effort: "low",
		port: 8902,
		timeoutMs: 180e3,
		sealedN: 130,
	},
	d: {
		id: "d",
		name: "reasoning",
		file: "d-reasoning.json",
		maxTokens: 4096,
		effort: null,
		port: 8903,
		timeoutMs: 600e3,
		sealedN: 130,
	},
	e: {
		id: "e",
		name: "decision",
		file: "e-decision.json",
		maxTokens: 1024,
		effort: "low",
		port: 8902,
		timeoutMs: 180e3,
		sealedN: 130,
	},
	f: {
		id: "f",
		name: "long-context",
		file: "f-long-context.json",
		maxTokens: 1024,
		effort: "low",
		port: 8903,
		timeoutMs: 600e3,
		sealedN: 36,
	},
};
export const CLASS_IDS = Object.keys(CLASSES) as ClassId[];
export const DEFAULT_ORDER: ClassId[] = ["e", "d", "a", "c", "b", "f"];

// ---------------------------------------------------------------- task shapes
export interface ExtractExpect {
	customer_name: string;
	email: string;
	order_id: string;
	total: number;
	currency: string;
	order_date: string;
	quantity: number;
}
export type Check =
	| { kind: "chat"; terms: string[]; min: number; max: number }
	| { kind: "code"; fn: string; tests: [unknown[], unknown][]; ref: string }
	| { kind: "extract"; expect: ExtractExpect }
	| { kind: "answer"; expect: string; type: string }
	| { kind: "tier"; expect: string }
	| { kind: "needle"; expect: string };
export interface Task {
	id: string;
	prompt?: string;
	text?: string;
	label?: string;
	doc?: string;
	q1?: string;
	q2?: string;
	check: Check;
	check2?: Check;
	meta?: Record<string, unknown>;
}
export interface TaskFile {
	class: ClassId;
	name: string;
	generator: string;
	seed: string;
	max_tokens: number;
	effort: string | null;
	note: string;
	tasks: Task[];
	criteria?: Record<string, string>;
	legacy?: { id: string; text: string; scored: boolean }[];
}

// ---------------------------------------------------------------- utilities
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export type R = () => number;
export function rng(seed: string): R {
	let a = Number.parseInt(sha(seed).slice(0, 8), 16) | 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
export const ri = (r: R, lo: number, hi: number) =>
	lo + Math.floor(r() * (hi - lo + 1));
export const pick = <T>(r: R, xs: readonly T[]): T =>
	xs[Math.floor(r() * xs.length)] as T;
export const ch = (r: R, s: string) => s[Math.floor(r() * s.length)] ?? "";
export function shuffle<T>(r: R, xs: readonly T[]): T[] {
	const a = xs.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(r() * (i + 1));
		[a[i], a[j]] = [a[j] as T, a[i] as T];
	}
	return a;
}
export const pad = (i: number, w = 3) => String(i).padStart(w, "0");
export const hex8 = (r: R) =>
	Math.floor(r() * 2 ** 32)
		.toString(16)
		.padStart(8, "0");
export const cap1 = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
export const ints = (r: R, lo: number, hi: number, nlo = 0, nhi = 8) =>
	Array.from({ length: ri(r, nlo, nhi) }, () => ri(r, lo, hi));
export const strOf = (r: R, alpha: string, lo: number, hi: number) =>
	Array.from({ length: ri(r, lo, hi) }, () => ch(r, alpha)).join("");
export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
/** Stable JSON: object keys sorted recursively — for hashing configs. */
export function canonical(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	if (v && typeof v === "object")
		return `{${Object.keys(v)
			.sort()
			.map(
				(k) =>
					`${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
			)
			.join(",")}}`;
	return JSON.stringify(v) ?? "null";
}

// ---------------------------------------------------------------- shared prompt framing
export const TIERS: Record<string, string> = {
	coder: "writing, fixing, refactoring or testing source code",
	extract:
		"pulling fields out of supplied text, short labelling or classification, or format conversion; no open-ended reasoning",
	reason:
		"multi-step analysis, planning, maths or trade-off evaluation in English, without writing code",
	general:
		"casual chat, translation, or writing in a language other than English",
	cloud:
		"input stated to be larger than 32k tokens, or the user explicitly demands the frontier cloud model",
	none: "none of these: needs non-text output or a capability no text model has (image/audio/video generation, live web browsing, phone calls)",
};
export function decisionPrompt(text: string): string {
	const tiers = Object.entries(TIERS)
		.map(([k, v]) => `- ${k}: ${v}`)
		.join("\n");
	return `You are a request router for a model fleet. Choose the single best tier for the request below.\nTiers:\n${tiers}\n\nRequest:\n"""\n${text}\n"""\n\nReply with one line exactly: TIER: <tier name>`;
}
export function longPrompt(doc: string, q: string) {
	return `Below is a service log.\n<log>\n${doc}\n</log>\n\n${q}`;
}
export const stripThink = (t: string) =>
	t
		.replace(/<think>[\s\S]*?<\/think>/g, "")
		.replace(/^[\s\S]*<\/think>/, "")
		.trim();

// ---------------------------------------------------------------- streams
export async function readCapped(
	s: ReadableStream<Uint8Array> | null,
	cap: number,
): Promise<string> {
	if (!s) return "";
	const rd = s.getReader();
	const dec = new TextDecoder();
	let out = "";
	try {
		for (;;) {
			const { done, value } = await rd.read();
			if (done) break;
			if (out.length < cap) out += dec.decode(value, { stream: true });
		}
	} finally {
		rd.releaseLock();
	}
	return out.slice(0, cap);
}
export async function* sseLines(
	s: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
	const rd = s.getReader();
	const dec = new TextDecoder();
	let buf = "";
	try {
		for (;;) {
			const { done, value } = await rd.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			let i = buf.indexOf("\n");
			while (i >= 0) {
				yield buf.slice(0, i).replace(/\r$/, "");
				buf = buf.slice(i + 1);
				i = buf.indexOf("\n");
			}
			if (buf.length > LINE_CAP) throw new Error("SSE line exceeds cap");
		}
		buf += dec.decode();
		if (buf) yield buf;
	} finally {
		rd.releaseLock();
	}
}
/** Stream a JSONL file row by row; a torn tail line is skipped. */
export async function* jsonl<T = Record<string, unknown>>(
	file: string,
): AsyncGenerator<T> {
	if (!existsSync(file)) return;
	const rl = createInterface({
		input: createReadStream(file),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of rl) {
		if (!line.trim()) continue;
		try {
			yield JSON.parse(line) as T;
		} catch {
			// torn tail line
		}
	}
}
