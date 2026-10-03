// router-core.ts — router-shim policy + upstream I/O, importable for tests
// (router-shim.ts binds a port at module load). W270 bench-informed fixes:
//   - code detection: strong vs weak signals; weak tokens (api/return/debug)
//     no longer turn a long log haystack into a "code" task
//   - Anthropic `system` is forwarded and (when short) classified
//   - Kev pre-hop gated by Kev's context window (no serial hop on long prompts)
//   - budget policy: per-model thinking/min-budget table (data, not branches)
//   - upstream 429 + Retry-After honored (bounded wait, then fallback/propagate)
//   - OpenAI SSE → Anthropic SSE streaming translation (TTFT = first token)

import { EXTERNAL, type Specialist } from "./registry.ts";

// ─── 7-dimension complexity scoring (LiteLLM Auto Router pattern) ───
export interface ComplexityScore {
	total: number; // 0..1 (higher = more complex)
	tier: "SIMPLE" | "MEDIUM" | "COMPLEX" | "VERY_COMPLEX";
	dimensions: Record<string, number>;
}

// Lower thresholds (were too conservative — 0.221 scored as SIMPLE)
export const TIER_THRESHOLDS = { SIMPLE: 0.15, MEDIUM: 0.35, COMPLEX: 0.6 };

// Strong code signals: any one hit makes the request a code task.
export const CODE_STRONG: Array<{ name: string; re: RegExp }> = [
	{ name: "fence", re: /```/ },
	{
		name: "language",
		re: /\b(javascript|typescript|python|golang|rust|java|kotlin|swift|ruby|php|csharp|c\+\+|c#|haskell|scala|elixir|lua|perl|bash\s+script|shell\s+script|powershell|sql\s+query|regex)\b/i,
	},
	{
		name: "write-code",
		re: /\b(write|implement|create|code|fix|refactor|debug|complete)\s+(an?\s+|the\s+|this\s+|my\s+)?(\w+\s+){0,2}(function|method|class|script|program|snippet|module|unit\s+tests?|regex|query|algorithm|component|endpoint)\b/i,
	},
	{
		name: "signature",
		re: /\b[a-z_$][\w$]*\((?!s\))\s*[a-z_$][\w$]*(\s*,\s*[a-z_$][\w$]*)*\s*\)\s*(:|=>|\{|that|which|returns?|to\s+return|should)/i,
	},
	{
		name: "decl",
		re: /^\s*(def|function|class|import|export|const|let|var|public|private|fn|func|#include)\s+\S/m,
	},
	{
		// a signature leading a line, any args — "rle(s) should return …"
		name: "signature-lead",
		re: /^\s*[a-z_$][\w$]*\(\s*[a-z_$][\w$]*(\s*,\s*[a-z_$][\w$]*)*\s*\)\s*(:|=>|\{|that|which|returns?|to\s+return|should)/im,
	},
	{ name: "arrow", re: /\)\s*=>/ },
];

// Weak code signals: generic engineering vocabulary that also fills logs,
// tickets, and prose. They count only in short prompts and only in numbers.
export const CODE_WEAK =
	/\b(function|class|interface|async|await|return|refactor|debug|compile|lint|api|endpoint|component|hook|docker|kubernetes|algorithm|implement|optimize|typescript|javascript|python)\b/gi;
export const CODE_WEAK_MIN = 2; // distinct weak hits needed
export const LONG_PROMPT_WORDS = 1500; // above this, weak hits never count

export function codeSignal(text: string): {
	isCode: boolean;
	strong: string[];
	weak: string[];
} {
	const strong = CODE_STRONG.filter((s) => s.re.test(text)).map((s) => s.name);
	const words = text.split(/\s+/).length;
	const weak =
		words > LONG_PROMPT_WORDS
			? []
			: [...new Set((text.match(CODE_WEAK) ?? []).map((w) => w.toLowerCase()))];
	return {
		isCode: strong.length > 0 || weak.length >= CODE_WEAK_MIN,
		strong,
		weak,
	};
}

const REASONING_MARKERS =
	/\b(analyze|explain|compare|evaluate|design|architect|strategy|why|how\s+does|what\s+if|pros\s+and\s+cons|trade.?off|implications|consequences|root\s+cause|derive|prove|justify|critique)\b/gi;
const TECHNICAL_TERMS =
	/\b(distributed|concurrency|latency|throughput|scalab|migration|protocol|authentication|encryption|database|schema|middleware|microservice|monolith|event.?driven|state\s+machine|compiler|runtime|garbage\s+collection)\b/gi;
const SIMPLE_INDICATORS =
	/^(reply|respond|list|name|give\s+me|tell\s+me|what\s+is|who\s+is|when\s+is|where\s+is|how\s+many|convert|translate|summarize\s+this|format\s+this|sort\s+this)\b/i;
const MULTI_STEP =
	/\b(first.*then|step\s+\d|also\s+after|additionally|furthermore|meanwhile|subsequently|before\s+that|after\s+that|next\s+you|finally)\b/i;
const QUESTION_DEPTH =
	/\b(underlying|fundamental|philosophical|theoretical|abstract|conceptual|architectural|systemic|holistic|nuanced|paradox|dilemma|emergence)\b/i;

const WEIGHTS: Record<string, number> = {
	tokenCount: 0.15,
	codePresence: 0.25,
	reasoningMarkers: 0.25,
	technicalTerms: 0.1,
	simpleIndicators: 0.1,
	multiStep: 0.05,
	questionComplexity: 0.1,
};

export function scoreComplexity(text: string): ComplexityScore {
	const lower = text.toLowerCase();
	const words = text.split(/\s+/).length;
	const dimensions: Record<string, number> = {
		tokenCount: Math.min(words / 200, 1),
		codePresence: codeSignal(text).isCode ? 0.8 : 0,
		reasoningMarkers: (lower.match(REASONING_MARKERS) ?? []).length * 0.25,
		technicalTerms: (lower.match(TECHNICAL_TERMS) ?? []).length * 0.2,
		simpleIndicators: SIMPLE_INDICATORS.test(text.trim()) ? -0.3 : 0, // NEGATIVE weight
		multiStep: MULTI_STEP.test(lower) ? 0.3 : 0,
		questionComplexity: QUESTION_DEPTH.test(lower) ? 0.4 : 0,
	};
	let total = 0;
	for (const [dim, weight] of Object.entries(WEIGHTS)) {
		dimensions[dim] = Math.max(0, Math.min(1, dimensions[dim] ?? 0));
		total += dimensions[dim] * weight;
	}
	total = Math.max(0, Math.min(1, total));

	// code tasks always route to coder regardless of complexity
	if (dimensions.codePresence > 0.5)
		return { total, tier: "MEDIUM", dimensions };

	let tier: ComplexityScore["tier"];
	if (total < TIER_THRESHOLDS.SIMPLE) tier = "SIMPLE";
	else if (total < TIER_THRESHOLDS.MEDIUM) tier = "MEDIUM";
	else if (total < TIER_THRESHOLDS.COMPLEX) tier = "COMPLEX";
	else tier = "VERY_COMPLEX";
	return { total, tier, dimensions };
}

// ─── Anthropic request shape → classifier text + OpenAI messages ───
export interface AnthropicBody {
	model?: string;
	max_tokens?: number;
	temperature?: number;
	stream?: boolean;
	system?: unknown;
	messages?: Array<{ role: unknown; content: unknown }>;
	_force_dead_port?: number;
}

export const blockText = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content
					.map((b) => {
						const t = (b as { text?: unknown } | null)?.text;
						return typeof t === "string" ? t : "";
					})
					.join("")
			: "";

// A short system prompt is a task instruction ("reply with one JS function");
// a long one is an agent harness (Claude Code) whose vocabulary would make
// every request look like code — only the former is classified.
export const SYSTEM_CLASSIFY_MAX_CHARS = 2000;

export function classifierText(body: AnthropicBody): string {
	const sys = blockText(body.system);
	const msgs = (body.messages ?? []).map((m) => blockText(m.content));
	if (sys && sys.length <= SYSTEM_CLASSIFY_MAX_CHARS) msgs.unshift(sys);
	return msgs.join(" ");
}

export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

/** OpenAI messages with the Anthropic `system` forwarded (it was dropped
 *  before W270) and Qwen3's `/no_think` appended to it. */
export function toOpenAiMessages(body: AnthropicBody): ChatMessage[] {
	const sys = blockText(body.system).trim();
	const messages: ChatMessage[] = (body.messages ?? []).map((m) => ({
		role: m.role === "assistant" ? "assistant" : "user",
		content: blockText(m.content),
	}));
	messages.unshift({
		role: "system",
		content: sys ? `${sys} /no_think` : "/no_think",
	});
	return messages;
}

// ─── Kev pre-hop eligibility ───
const KEV_CONTEXT_TOKENS =
	EXTERNAL.find((e) => e.role === "classify")?.contextTokens ?? 384;
export const estTokens = (text: string): number => Math.ceil(text.length / 4);

/** Kev was trained on ≤ contextTokens of state; past that its verdict is
 *  unmeasured and the serial hop only adds latency ahead of the prefill
 *  (stack-anthropic f-class TTFT 8.8 s vs 2.5-3.5 s elsewhere). */
export const kevEligible = (text: string, ctx = KEV_CONTEXT_TOKENS): boolean =>
	estTokens(text) <= ctx;

// ─── budget policy: per-model thinking control (data, not branches) ───
export interface BudgetRule {
	match: RegExp;
	/** "off": thinking can be disabled via `offExtra` (router always does — speed);
	 *  "always": the model thinks at every effort, so max_tokens is shared. */
	thinking: "off" | "always";
	minBudget: number;
	offExtra?: Record<string, unknown>;
}

export const BUDGET_RULES: BudgetRule[] = [
	// Qwen3.5 thinking is template-controlled — /no_think in the prompt doesn't
	// reach it; the kwarg does (verified direct-answer with this off, Sep 23).
	{
		match: /Qwen3\.5-/,
		thinking: "off",
		minBudget: 0,
		offExtra: { chat_template_kwargs: { enable_thinking: false } },
	},
	// GLM-5.3(-flash) always thinks (thinking disabled → 400). Bench a-class:
	// max_tokens 1024 at effort low truncated 100% (pure-api) — reasoning ate
	// the shared budget. Below minBudget the router raises it.
	{
		match: /^(z\.ai:)?glm-5\.3(-flash)?(\[1m\])?$/,
		thinking: "always",
		minBudget: 2048,
	},
];

export function applyBudget(
	model: string,
	maxTokens: number,
	rules: BudgetRule[] = BUDGET_RULES,
): { maxTokens: number; extra: Record<string, unknown>; note?: string } {
	const rule = rules.find((r) => r.match.test(model));
	if (!rule) return { maxTokens, extra: {} };
	if (rule.thinking === "off") return { maxTokens, extra: rule.offExtra ?? {} };
	// Probe-scale budgets (< 64: health pings, liveness checks) are explicit —
	// raising them to minBudget turns a 1-token pong into a 2048-token thinking
	// request (2026-10-03: bench preflight timed out on exactly this).
	if (maxTokens < 64) return { maxTokens, extra: {} };
	if (maxTokens >= rule.minBudget) return { maxTokens, extra: {} };
	return {
		maxTokens: rule.minBudget,
		extra: {},
		note: `budget ${maxTokens}→${rule.minBudget} (${model} always thinks)`,
	};
}

// ─── Retry-After ───
const envInt = (v: string | undefined, dflt: number): number => {
	const n = Number(v);
	return Number.isInteger(n) && n >= 0 ? n : dflt;
};
/** Longest upstream Retry-After the router waits out in-request before
 *  taking the fallback hop instead. */
export const RETRY_WAIT_CAP_MS = envInt(
	process.env.BELT_RETRY_WAIT_CAP_MS,
	2000,
);

/** Retry-After (delta-seconds or HTTP-date) → ms; undefined when absent/bad. */
export function retryAfterMs(
	h: string | null,
	now = Date.now(),
): number | undefined {
	if (h === null || h.trim() === "") return undefined;
	const s = Number(h);
	if (Number.isFinite(s)) return s >= 0 ? Math.round(s * 1000) : undefined;
	const at = Date.parse(h);
	return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

// ─── specialist call (OpenAI format) ───
export interface LocalResult {
	ok: boolean;
	response: string;
	error?: string;
	status?: number;
	retryAfterMs?: number;
	finish?: string;
}

export interface CallOpts {
	base?: string; // default http://localhost:<port>
	extra?: Record<string, unknown>;
	timeoutMs?: number;
}

export const specialistBase = (port: number): string =>
	process.env.BELT_UPSTREAM_BASE ?? `http://localhost:${port}`;

const strip = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

export async function viaLocal(
	r: { port: number; model: string },
	messages: ChatMessage[],
	maxTokens: number,
	temperature: number,
	opts: CallOpts = {},
): Promise<LocalResult> {
	let text = "";
	try {
		const res = await fetch(
			`${opts.base ?? specialistBase(r.port)}/v1/chat/completions`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
				body: JSON.stringify({
					model: r.model,
					messages,
					max_tokens: maxTokens,
					temperature,
					stream: false,
					...(opts.extra ?? {}),
				}),
			},
		);
		if (res.status === 429) {
			await res.body?.cancel();
			return {
				ok: false,
				response: "",
				status: 429,
				retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
				error: "429 overloaded",
			};
		}
		text = await res.text();
		// mlx_lm occasionally emits raw newlines inside JSON strings — strict
		// parse first (preserves unicode), fall back to escaping control chars.
		let j: {
			error?: string | { message?: string };
			choices?: Array<{
				finish_reason?: string;
				message?: { content?: string; reasoning_content?: string };
			}>;
		};
		try {
			j = JSON.parse(text);
		} catch {
			j = JSON.parse(text.replace(/\n/g, "\\n"));
		}
		if (j.error) {
			return {
				ok: false,
				response: "",
				status: res.status,
				error:
					typeof j.error === "string"
						? j.error
						: (j.error.message ?? "specialist error"),
			};
		}
		const choice = j.choices?.[0];
		const msg = choice?.message ?? {};
		const response =
			strip(msg.content || "") || strip(msg.reasoning_content || "");
		if (!response) {
			return {
				ok: false,
				response: "",
				status: res.status,
				error: `empty (finish=${choice?.finish_reason ?? "?"}, keys=${Object.keys(msg).join("+") || "none"})`,
			};
		}
		return {
			ok: true,
			response,
			status: res.status,
			finish: choice?.finish_reason,
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			ok: false,
			response: "",
			error: `${msg}${text ? ` | raw: ${text.slice(0, 120)}` : ""}`,
		};
	}
}

/** One call; on 429 with Retry-After ≤ cap, wait it out and retry once on
 *  the same specialist (prefix cache stays warm there). Longer waits return
 *  the 429 so the caller takes the fallback hop or propagates it. */
export async function callHonoringRetryAfter<
	T extends { status?: number; retryAfterMs?: number },
>(
	call: () => Promise<T>,
	capMs = RETRY_WAIT_CAP_MS,
	sleep: (ms: number) => Promise<unknown> = Bun.sleep,
): Promise<T> {
	const first = await call();
	if (first.status !== 429) return first;
	const wait = first.retryAfterMs ?? capMs;
	if (wait > capMs) return first;
	await sleep(wait);
	return call();
}

// ─── streaming: specialist SSE → Anthropic SSE ───
export type StreamOpen =
	| { ok: true; body: ReadableStream<Uint8Array> }
	| { ok: false; error: string; status?: number; retryAfterMs?: number };

export async function openLocalStream(
	r: { port: number; model: string },
	messages: ChatMessage[],
	maxTokens: number,
	temperature: number,
	opts: CallOpts = {},
): Promise<StreamOpen> {
	try {
		const res = await fetch(
			`${opts.base ?? specialistBase(r.port)}/v1/chat/completions`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
				body: JSON.stringify({
					model: r.model,
					messages,
					max_tokens: maxTokens,
					temperature,
					stream: true,
					...(opts.extra ?? {}),
				}),
			},
		);
		const ct = res.headers.get("content-type") ?? "";
		if (res.ok && res.body && ct.includes("text/event-stream"))
			return { ok: true, body: res.body };
		const raw = await res.text().catch(() => "");
		return {
			ok: false,
			status: res.status,
			retryAfterMs:
				res.status === 429
					? retryAfterMs(res.headers.get("retry-after"))
					: undefined,
			error: `${res.status} ${ct || "no content-type"}${raw ? ` | raw: ${raw.slice(0, 120)}` : ""}`,
		};
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/** Drops <think>…</think> spans across chunk boundaries. */
export function thinkFilter(): (chunk: string) => string {
	let inThink = false;
	let carry = "";
	return (chunk) => {
		let s = carry + chunk;
		carry = "";
		let out = "";
		for (;;) {
			const tag = inThink ? "</think>" : "<think>";
			const i = s.indexOf(tag);
			if (i >= 0) {
				if (!inThink) out += s.slice(0, i);
				s = s.slice(i + tag.length);
				inThink = !inThink;
				continue;
			}
			// hold back a possible partial tag at the end
			let keep = 0;
			for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
				if (tag.startsWith(s.slice(s.length - k))) {
					keep = k;
					break;
				}
			}
			if (!inThink) out += s.slice(0, s.length - keep);
			carry = s.slice(s.length - keep);
			return out;
		}
	};
}

const sseEvent = (event: string, data: unknown) =>
	`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const STOP_REASON: Record<string, string> = {
	length: "max_tokens",
	stop: "end_turn",
};
export const stopReason = (finish?: string): string =>
	(finish && STOP_REASON[finish]) || "end_turn";

export interface StreamMeta {
	id: string;
	model: string | undefined;
	routing?: Record<string, unknown>;
}

function anthropicHead(meta: StreamMeta): string {
	return (
		sseEvent("message_start", {
			type: "message_start",
			message: {
				id: meta.id,
				type: "message",
				role: "assistant",
				model: meta.model,
				content: [],
				stop_reason: null,
				usage: { input_tokens: 0, output_tokens: 0 },
				...(meta.routing ? { _routing: meta.routing } : {}),
			},
		}) +
		sseEvent("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		})
	);
}

function anthropicTail(finish: string | undefined, outTokens: number): string {
	return (
		sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
		sseEvent("message_delta", {
			type: "message_delta",
			delta: { stop_reason: stopReason(finish), stop_sequence: null },
			usage: { output_tokens: outTokens },
		}) +
		sseEvent("message_stop", { type: "message_stop" })
	);
}

const textDelta = (text: string) =>
	sseEvent("content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text },
	});

/** A buffered answer (cloud escalation, fallback) as an Anthropic SSE stream,
 *  so stream:true clients always get the wire they asked for. */
export function anthropicSseFromText(
	text: string,
	meta: StreamMeta,
	finish?: string,
): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(c) {
			c.enqueue(
				enc.encode(
					anthropicHead(meta) + textDelta(text) + anthropicTail(finish, 0),
				),
			);
			c.close();
		},
	});
}

interface OpenAiChunk {
	choices?: Array<{
		delta?: { content?: string | null };
		finish_reason?: string | null;
	}>;
	usage?: { completion_tokens?: number };
}

/** Translate an OpenAI chat-completions SSE body into Anthropic SSE, piping
 *  chunk by chunk (no buffering). `onDone` fires once with the totals. */
export function anthropicSseFromOpenAi(
	upstream: ReadableStream<Uint8Array>,
	meta: StreamMeta,
	onDone: (r: {
		chars: number;
		finish?: string;
		error?: string;
	}) => void = () => {},
): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	const filter = thinkFilter();
	let buf = "";
	let chars = 0;
	let finish: string | undefined;
	let outTokens = 0;
	let finished = false;
	const done = (error?: string) => {
		if (finished) return;
		finished = true;
		onDone({ chars, finish, error });
	};
	const handleLine = (line: string): string => {
		if (!line.startsWith("data:")) return "";
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") return "";
		let j: OpenAiChunk;
		try {
			j = JSON.parse(data);
		} catch {
			return "";
		}
		if (j.usage?.completion_tokens) outTokens = j.usage.completion_tokens;
		const ch = j.choices?.[0];
		if (ch?.finish_reason) finish = ch.finish_reason;
		const text = filter(ch?.delta?.content ?? "");
		if (!text) return "";
		chars += text.length;
		return textDelta(text);
	};
	const reader = upstream.getReader();
	return new ReadableStream({
		start(c) {
			c.enqueue(enc.encode(anthropicHead(meta)));
			// PUSH-based: pump inside start() — Bun 1.4.x serve does not drive
			// pull()-based ReadableStream responses (verified 2026-10-03: pull()
			// never fires after start(); push-style pumping streams fine).
			void (async () => {
				try {
					for (;;) {
				const { value, done: eof } = await reader.read();
				if (eof) {
					const out = handleLine(buf) + anthropicTail(finish, outTokens);
					c.enqueue(enc.encode(out));
					c.close();
					done();
					return;
				}
				buf += dec.decode(value, { stream: true });
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				const out = lines.map(handleLine).join("");
				if (out) c.enqueue(enc.encode(out));
					}
				} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				c.enqueue(
					enc.encode(
						sseEvent("error", {
							type: "error",
							error: {
								type: "api_error",
								message: `router: upstream stream broke (${msg})`,
							},
						}),
					),
				);
				c.close();
				done(msg);
			}
			})();
		},
		cancel(reason) {
			done("client cancelled");
			return reader.cancel(reason);
		},
	});
}

export type RouteTarget = Pick<Specialist, "port" | "model">;
