// bench-ttft.ts — prefill / time-to-first-token bench (bench-suite.ts --ttft).
// Agent traffic is long prompts + short outputs, so TTFT and prefix-cache hit
// rate dominate wall time — decode tok/s alone mis-ranks the fleet.
//
//   bun bench-suite.ts --ttft --port 8903 --model <id> [--sizes 2000,8000,32000]
//                      [--reps 5] [--label L] [--suite S] [--thinking-off]
//
// Per size, per rep: a COLD request (fresh nonce leads the prompt → no prefix
// reuse) then a CACHED request sharing that whole prefix with only the final
// line changed — a prefix-cache hit that the response cache cannot answer.
// Medians decide; one row per metric per size goes to benchmarks.jsonl.

import { existsSync, readFileSync } from "node:fs";
import { byPort } from "./registry.ts";

export const AC_FLAG = "/tmp/bench-ac-ok";
export const DEFAULT_SIZES = [2000, 8000, 32000];
export const DEFAULT_REPS = 5;
const LOG = `${process.env.HOME}/.claude/local-llm/bench-log.ts`;

export type Logger = (
	metric: string,
	value: number,
	meta: Record<string, unknown>,
) => void;

export interface TtftOpts {
	baseUrl: string;
	model: string;
	sizes: number[];
	reps: number;
	thinkingOff?: boolean;
	timeoutMs?: number;
}

export interface TtftRow {
	size: number;
	coldMs: number;
	cachedMs: number;
	promptTokens: number | null;
	prefillTps: number | null;
}

const FILLER = [
	"The ledger records each shipment with its origin, carrier and weight.",
	"Operators reconcile the manifest against the dock scans every evening.",
	"Late pallets are flagged and the carrier is notified within the hour.",
	"Quarterly audits sample one hundred rows and compare signatures.",
];

/** ~`tokens` prompt tokens (≈4 chars/token); `nonce` leads so cold runs never share a prefix. */
export function buildPrompt(tokens: number, nonce: string): string {
	const target = tokens * 4;
	const head = `Session ${nonce}. Read the log below.`;
	const parts = [head];
	let len = head.length;
	for (let i = 0; len < target; i++) {
		const line = `${i}: ${FILLER[i % FILLER.length]}`;
		parts.push(line);
		len += line.length + 1;
	}
	return parts.join("\n");
}

export const median = (xs: number[]): number => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? 0;
};

type Delta = {
	content?: string;
	reasoning_content?: string;
	reasoning?: string;
};
type Chunk = {
	choices?: Array<{ delta?: Delta }>;
	usage?: { prompt_tokens?: number };
};

/** Stream one completion; TTFT = first non-empty content/reasoning delta. */
export async function measureTtft(
	o: TtftOpts,
	content: string,
): Promise<{ ttftMs: number; promptTokens: number | null }> {
	const t0 = performance.now();
	const res = await fetch(`${o.baseUrl}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: o.model,
			max_tokens: 8,
			temperature: 0,
			stream: true,
			stream_options: { include_usage: true },
			...(o.thinkingOff
				? { chat_template_kwargs: { enable_thinking: false } }
				: {}),
			messages: [{ role: "user", content }],
		}),
		signal: AbortSignal.timeout(o.timeoutMs ?? 600_000),
	});
	if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	let ttftMs = -1;
	let promptTokens: number | null = null;
	const onLine = (line: string) => {
		if (!line.startsWith("data:")) return;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") return;
		let c: Chunk;
		try {
			c = JSON.parse(data);
		} catch {
			return;
		}
		if (c.usage?.prompt_tokens) promptTokens = c.usage.prompt_tokens;
		const d = c.choices?.[0]?.delta;
		if (ttftMs < 0 && (d?.content || d?.reasoning_content || d?.reasoning))
			ttftMs = performance.now() - t0;
	};
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		let nl = buf.indexOf("\n");
		while (nl !== -1) {
			onLine(buf.slice(0, nl));
			buf = buf.slice(nl + 1);
			nl = buf.indexOf("\n");
		}
	}
	onLine(buf);
	if (ttftMs < 0) throw new Error("stream ended without a token");
	return { ttftMs, promptTokens };
}

export async function runTtft(o: TtftOpts): Promise<TtftRow[]> {
	await measureTtft(o, "Say READY"); // warmup
	const rows: TtftRow[] = [];
	for (const size of o.sizes) {
		const cold: number[] = [];
		const cached: number[] = [];
		const toks: number[] = [];
		for (let r = 0; r < o.reps; r++) {
			const prefix = buildPrompt(size, `${Date.now()}-${size}-${r}`);
			const a = await measureTtft(o, `${prefix}\nHow many rows? One word.`);
			const b = await measureTtft(
				o,
				`${prefix}\nName the carrier rule. One word.`,
			);
			cold.push(a.ttftMs);
			cached.push(b.ttftMs);
			if (a.promptTokens) toks.push(a.promptTokens);
		}
		const coldMs = median(cold);
		const promptTokens = toks.length ? median(toks) : null;
		rows.push({
			size,
			coldMs,
			cachedMs: median(cached),
			promptTokens,
			prefillTps:
				promptTokens && coldMs > 0 ? promptTokens / (coldMs / 1000) : null,
		});
	}
	return rows;
}

const sh = (cmd: string[]): string => {
	try {
		const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
		return p.exitCode === 0 ? p.stdout.toString().trim() : "";
	} catch {
		return "";
	}
};

/** HF hub revision sha of the cached weights (refs/main), if present. */
export function modelRevision(model: string): string | null {
	const hub =
		process.env.HF_HUB_CACHE ??
		`${process.env.HF_HOME ?? `${process.env.HOME}/.cache/huggingface`}/hub`;
	const ref = `${hub}/models--${model.replace("/", "--")}/refs/main`;
	return existsSync(ref) ? readFileSync(ref, "utf8").trim() : null;
}

export async function benchMeta(
	baseUrl: string,
	port: number,
	model: string,
): Promise<Record<string, unknown>> {
	const spec = byPort(port);
	let servedBy: string | null = null;
	try {
		const r = await fetch(`${baseUrl}/v1/models`, {
			signal: AbortSignal.timeout(3000),
		});
		const j = (await r.json()) as { data?: Array<{ owned_by?: string }> };
		servedBy = j.data?.[0]?.owned_by ?? null;
	} catch {}
	const batt = sh(["pmset", "-g", "batt"]);
	const therm = sh(["pmset", "-g", "therm"]);
	return {
		port,
		model,
		engine: spec?.engine ?? servedBy ?? "unknown",
		served_by: servedBy,
		revision: modelRevision(model),
		flags: spec?.flags ?? [],
		power: /AC Power/.test(batt)
			? "ac"
			: /Battery Power/.test(batt)
				? "battery"
				: "unknown",
		thermal: therm
			? /No thermal warning/.test(therm)
				? "nominal"
				: therm.split("\n")[0]
			: null,
		macos_build: sh(["sw_vers", "-buildVersion"]) || null,
	};
}

const benchLog =
	(suite: string, label: string): Logger =>
	(metric, value, meta) => {
		Bun.spawnSync([
			"bun",
			LOG,
			"add",
			suite,
			label,
			metric,
			value.toFixed(1),
			JSON.stringify(meta),
		]);
	};

export function logRows(
	rows: TtftRow[],
	meta: Record<string, unknown>,
	reps: number,
	log: Logger,
): void {
	for (const r of rows) {
		const m = { ...meta, size: r.size, n: reps, prompt_tokens: r.promptTokens };
		log(`ttft_cold_ms_${r.size}`, r.coldMs, m);
		log(`ttft_cached_ms_${r.size}`, r.cachedMs, m);
		if (r.prefillTps !== null) log(`prefill_tps_${r.size}`, r.prefillTps, m);
	}
}

export async function ttftMain(
	args: string[],
	env: { acFlag?: string; log?: Logger; baseUrl?: string } = {},
): Promise<number> {
	const get = (f: string) => {
		const i = args.indexOf(f);
		return i !== -1 ? args[i + 1] : undefined;
	};
	const port = Number(get("--port"));
	const model = get("--model") ?? byPort(port)?.model ?? "?";
	const label =
		get("--label") ?? model.replace("mlx-community/", "").slice(0, 30);
	const suite = get("--suite") ?? "fleet";
	const sizes = (get("--sizes") ?? DEFAULT_SIZES.join(","))
		.split(",")
		.map(Number)
		.filter((n) => n > 0);
	const reps = Number(get("--reps") ?? DEFAULT_REPS);
	if (!port || !sizes.length || !(reps > 0)) {
		console.error(
			"usage: bench-suite.ts --ttft --port N [--model id] [--sizes 2000,8000] [--reps N]",
		);
		return 1;
	}
	const flag = env.acFlag ?? AC_FLAG;
	if (!existsSync(flag)) {
		console.error(
			`refusing: bench runs need AC power — ${flag} missing (benchmarks.md law)`,
		);
		return 2;
	}
	const baseUrl = env.baseUrl ?? `http://localhost:${port}`;
	const o: TtftOpts = {
		baseUrl,
		model,
		sizes,
		reps,
		thinkingOff: args.includes("--thinking-off"),
	};
	const meta = await benchMeta(baseUrl, port, model);
	const rows = await runTtft(o);
	console.log(`${label} (:${port}) TTFT, median of ${reps}:`);
	for (const r of rows) {
		console.log(
			`  ${String(r.size).padStart(6)} tok  cold ${r.coldMs.toFixed(0).padStart(6)}ms  cached ${r.cachedMs.toFixed(0).padStart(6)}ms  prefill ${r.prefillTps?.toFixed(0) ?? "?"} tok/s (${r.promptTokens ?? "?"} prompt tok)`,
		);
	}
	logRows(rows, meta, reps, env.log ?? benchLog(suite, label));
	console.log("  logged to benchmarks.jsonl");
	return 0;
}
