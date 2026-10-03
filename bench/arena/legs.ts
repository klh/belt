// legs.ts — backends under test, model-set selection, wire clients, cost.
import { loadavg } from "node:os";
import {
	CHARS_PER_TOK_LOG,
	CHARS_PER_TOK_TEXT,
	CLASSES,
	type ClassId,
	decisionPrompt,
	ENGINE,
	KEV,
	LINE_CAP,
	LOCAL_IDS,
	longPrompt,
	PRICES,
	PURE_MODEL,
	type Price,
	ROUTER,
	readCapped,
	sha,
	sseLines,
	TEXT_CAP,
	TIERS,
	type Task,
	ZAI_BASE,
} from "./core.ts";
import { type Score, scoreText } from "./scoring.ts";

export type Wire = "openai" | "anthropic" | "kev" | "router";
export interface Leg {
	id: string;
	wire: Wire;
	priced: "remote" | "local" | "routed";
	knob?: "body" | "extra_body";
	only?: ClassId[];
	desc: string;
}
export const LEGS: Leg[] = [
	{
		id: "pure-api",
		wire: "openai",
		priced: "remote",
		knob: "body",
		desc: `z.ai direct ${PURE_MODEL} (baseline)`,
	},
	{
		id: "stack-anthropic",
		wire: "anthropic",
		priced: "routed",
		desc: `:4000 belt router, pin ${PURE_MODEL}`,
	},
	{
		id: "stack-engine-zai",
		wire: "openai",
		priced: "remote",
		knob: "extra_body",
		desc: ":4100 litellm zai-glm-5.3-flash",
	},
	{
		id: "stack-engine-local",
		wire: "openai",
		priced: "local",
		desc: ":4100 litellm class-mapped local-*",
	},
	{
		id: "local-direct",
		wire: "openai",
		priced: "local",
		desc: ":890x raw tier, class-mapped",
	},
	{
		id: "kev-direct",
		wire: "kev",
		priced: "local",
		only: ["e"],
		desc: ":8912 SystemOne choice",
	},
	{
		id: "stack-router",
		wire: "router",
		priced: "local",
		only: ["e"],
		desc: ":4000 placement of the raw request (max_tokens 1)",
	},
];

// ---------------------------------------------------------------- model sets
/** Owner's model-set dimension. Every set runs the same sealed tasks; the
 *  class → tier oracle map (CLASSES[c].port) places local legs per class. */
export const MODEL_SETS = {
	glm: ["pure-api", "stack-engine-zai"],
	local: ["stack-engine-local", "local-direct"],
	kev: ["kev-direct"],
	mixed: ["stack-anthropic", "stack-router"],
	all: LEGS.map((l) => l.id),
} as const satisfies Record<string, readonly string[]>;
export type ModelSet = keyof typeof MODEL_SETS;
export const MODEL_SET_IDS = Object.keys(MODEL_SETS) as ModelSet[];

export function isModelSet(s: string): s is ModelSet {
	return Object.hasOwn(MODEL_SETS, s);
}
/** Legs for a model set, optionally narrowed by an explicit --legs list
 *  (which must stay inside the set — a variant never borrows legs). */
export function selectLegs(models: ModelSet, only?: string[]): Leg[] {
	const ids: readonly string[] = MODEL_SETS[models];
	const set = LEGS.filter((l) => ids.includes(l.id));
	if (!only) return set;
	return only.map((id) => {
		const l = set.find((x) => x.id === id);
		if (!l) throw new Error(`leg ${id} is not in model set ${models}`);
		return l;
	});
}
export const legsFor = (c: ClassId, ls: Leg[]) =>
	ls.filter((l) => !l.only || l.only.includes(c));
export const portsFor = (l: Leg) =>
	l.id === "local-direct" || l.id === "stack-engine-local"
		? [8901, 8902, 8903]
		: [0];

// ---------------------------------------------------------------- targets
export const engineKey = () =>
	process.env.LITELLM_KEY ??
	(process.env.ANTHROPIC_BASE_URL?.includes(":4100")
		? process.env.ANTHROPIC_AUTH_TOKEN
		: undefined);
export const engineKeySrc = () =>
	process.env.LITELLM_KEY
		? "env LITELLM_KEY"
		: engineKey()
			? "env ANTHROPIC_AUTH_TOKEN (ANTHROPIC_BASE_URL→:4100)"
			: "none";
export function target(
	leg: Leg,
	port: number,
): { url: string; model: string; key?: string } {
	switch (leg.id) {
		case "pure-api":
			return {
				url: `${ZAI_BASE}/chat/completions`,
				model: PURE_MODEL,
				key: process.env.ZAI_API_KEY,
			};
		case "stack-anthropic":
		case "stack-router":
			return {
				url: `${ROUTER}/v1/messages`,
				model: PURE_MODEL,
				key: process.env.BELT_ROUTER_KEY,
			};
		case "stack-engine-zai":
			return {
				url: `${ENGINE}/chat/completions`,
				model: "zai-glm-5.3-flash",
				key: engineKey(),
			};
		case "stack-engine-local":
			return {
				url: `${ENGINE}/chat/completions`,
				model: LOCAL_IDS[port] ?? "local-extract",
				key: engineKey(),
			};
		case "local-direct":
			return {
				url: `http://127.0.0.1:${port}/v1/chat/completions`,
				model: "default",
			};
		default:
			return { url: `${KEV}/v1/systemone`, model: "kev-latest" };
	}
}

// ---------------------------------------------------------------- wire
export interface Routing {
	tier?: string;
	category?: string;
	port?: number | string;
	model?: string;
}
export interface KevInfo {
	confidence: number | null;
	p: unknown;
	latency_ms?: number;
}
export interface Req {
	user: string;
	maxTokens: number;
	effort: string | null;
	timeoutMs: number;
	port: number;
	kevState?: string;
}
export interface Out {
	ok: boolean;
	status: number;
	err?: string;
	wall: number;
	ttft: number | null;
	ttfc: number | null;
	streamed: boolean;
	text: string;
	capped: boolean;
	reasoningChars: number;
	inTok: number;
	outTok: number;
	reasonTok: number;
	cachedTok: number;
	tokEst: boolean;
	finish: string | null;
	served?: string;
	routed?: Routing;
	kev?: KevInfo;
}
export const blank = (): Out => ({
	ok: false,
	status: 0,
	wall: 0,
	ttft: null,
	ttfc: null,
	streamed: false,
	text: "",
	capped: false,
	reasoningChars: 0,
	inTok: 0,
	outTok: 0,
	reasonTok: 0,
	cachedTok: 0,
	tokEst: false,
	finish: null,
});
interface Usage {
	prompt_tokens?: number;
	completion_tokens?: number;
	input_tokens?: number;
	output_tokens?: number;
	completion_tokens_details?: { reasoning_tokens?: number };
	prompt_tokens_details?: { cached_tokens?: number };
	cache_read_input_tokens?: number;
}
interface OaMsg {
	content?: string;
	reasoning_content?: string;
	reasoning?: string;
}
interface Wj {
	error?: unknown;
	model?: string;
	usage?: Usage;
	choices?: { delta?: OaMsg; message?: OaMsg; finish_reason?: string }[];
	_routing?: Routing;
	type?: string;
	message?: { usage?: Usage; model?: string; _routing?: Routing };
	delta?: {
		type?: string;
		text?: string;
		thinking?: string;
		stop_reason?: string;
	};
	content?: { type?: string; text?: string; thinking?: string }[];
	stop_reason?: string;
}
type KevQs = Record<string, unknown>;

function addText(o: Out, s: string, t0: number) {
	const now = performance.now() - t0;
	o.ttft ??= now;
	if (s.length) o.ttfc ??= now;
	if (o.text.length < TEXT_CAP) o.text += s;
	else o.capped = true;
}
function onOpenAiChunk(o: Out, j: Wj, t0: number): Usage | undefined {
	const c0 = j.choices?.[0];
	const dl = c0?.delta ?? {};
	const rc = dl.reasoning_content ?? dl.reasoning;
	if (rc) {
		o.ttft ??= performance.now() - t0;
		o.reasoningChars += rc.length;
	}
	if (dl.content) addText(o, dl.content, t0);
	if (c0?.finish_reason) o.finish = c0.finish_reason;
	if (j.model) o.served ??= j.model;
	return j.usage;
}
function onAnthropicEvent(
	o: Out,
	j: Wj,
	t0: number,
	usage: Usage | undefined,
): Usage | undefined {
	let u = usage;
	if (j._routing) o.routed = j._routing;
	if (j.message?._routing) o.routed = j.message._routing;
	if (j.type === "message_start") {
		u = { ...j.message?.usage };
		o.served = j.message?.model;
	}
	if (j.type === "content_block_delta") {
		if (j.delta?.type === "text_delta") addText(o, j.delta.text ?? "", t0);
		else if (j.delta?.type === "thinking_delta") {
			o.ttft ??= performance.now() - t0;
			o.reasoningChars += (j.delta.thinking ?? "").length;
		}
	}
	if (j.type === "message_delta") {
		u = { ...u, ...j.usage };
		o.finish = j.delta?.stop_reason ?? o.finish;
	}
	return u;
}
function onWholeBody(o: Out, leg: Leg, j: Wj): Usage | undefined {
	if (leg.wire === "openai") {
		const m = j.choices?.[0]?.message ?? {};
		o.text = String(m.content ?? "").slice(0, TEXT_CAP);
		o.reasoningChars = String(m.reasoning_content ?? m.reasoning ?? "").length;
		o.finish = j.choices?.[0]?.finish_reason ?? null;
		o.served = j.model;
		return j.usage;
	}
	for (const b of j.content ?? []) {
		if (b.type === "text") o.text += b.text ?? "";
		if (b.type === "thinking") o.reasoningChars += (b.thinking ?? "").length;
	}
	o.text = o.text.slice(0, TEXT_CAP);
	o.finish = j.stop_reason ?? null;
	o.routed = j._routing;
	o.served = j.model;
	return j.usage;
}
function applyUsage(o: Out, q: Req, usage: Usage | undefined) {
	if (usage) {
		o.inTok = usage.prompt_tokens ?? usage.input_tokens ?? 0;
		o.outTok = usage.completion_tokens ?? usage.output_tokens ?? 0;
		o.reasonTok = usage.completion_tokens_details?.reasoning_tokens ?? 0;
		o.cachedTok =
			usage.prompt_tokens_details?.cached_tokens ??
			usage.cache_read_input_tokens ??
			0;
	}
	if (!o.inTok && !o.outTok) {
		// :4000 reports zeros — estimate, flagged
		const cpt = /<log>/.test(q.user) ? CHARS_PER_TOK_LOG : CHARS_PER_TOK_TEXT;
		o.inTok = Math.ceil(q.user.length / cpt);
		o.outTok = Math.ceil(
			(o.text.length + o.reasoningChars) / CHARS_PER_TOK_TEXT,
		);
		o.tokEst = true;
	}
}
async function callKev(
	o: Out,
	url: string,
	model: string,
	q: Req,
	kevQs: KevQs | undefined,
	signal: AbortSignal,
	t0: number,
): Promise<Out> {
	const res = await fetch(url, {
		method: "POST",
		signal,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ state: q.kevState, model, questions: kevQs }),
	});
	o.status = res.status;
	const raw = await readCapped(res.body, LINE_CAP);
	o.wall = performance.now() - t0;
	if (!res.ok) {
		o.err = raw.slice(0, 240);
		return o;
	}
	const j = JSON.parse(raw) as {
		answers?: Record<string, Record<string, unknown>>;
		latency_ms?: number;
		usage?: Usage;
		model?: string;
	};
	const a = Object.values(j.answers ?? {})[0] ?? {};
	o.text = String(a.choice ?? a.noul ?? a.score ?? "");
	o.kev = {
		confidence: typeof a.confidence === "number" ? a.confidence : null,
		p: a.probabilities ?? null,
		latency_ms: j.latency_ms,
	};
	o.inTok = j.usage?.input_tokens ?? 0;
	o.outTok = j.usage?.output_tokens ?? 0;
	o.served = j.model;
	o.ok = true;
	o.finish = "decision";
	return o;
}
function requestBody(
	leg: Leg,
	tg: { model: string; key?: string },
	q: Req,
	headers: Record<string, string>,
): Record<string, unknown> {
	if (leg.wire === "openai") {
		if (tg.key) headers.authorization = `Bearer ${tg.key}`;
		const body: Record<string, unknown> = {
			model: tg.model,
			messages: [{ role: "user", content: q.user }],
			max_tokens: q.maxTokens,
			temperature: 0,
			stream: true,
			stream_options: { include_usage: true },
		};
		if (leg.knob && q.effort) {
			const th = { type: "enabled", effort: q.effort };
			if (leg.knob === "body") body.thinking = th;
			else body.extra_body = { thinking: th };
		}
		return body;
	}
	headers["anthropic-version"] = "2023-06-01";
	if (tg.key) headers["x-api-key"] = tg.key;
	return {
		model: tg.model,
		max_tokens: leg.wire === "router" ? 1 : q.maxTokens,
		temperature: 0,
		stream: true,
		messages: [{ role: "user", content: q.user }],
	};
}
export async function callLeg(leg: Leg, q: Req, kevQs?: KevQs): Promise<Out> {
	const o = blank();
	const tg = target(leg, q.port);
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), q.timeoutMs);
	const t0 = performance.now();
	try {
		if (leg.wire === "kev")
			return await callKev(o, tg.url, tg.model, q, kevQs, ac.signal, t0);
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		const body = requestBody(leg, tg, q, headers);
		const res = await fetch(tg.url, {
			method: "POST",
			signal: ac.signal,
			headers,
			body: JSON.stringify(body),
		});
		o.status = res.status;
		if (!res.ok) {
			o.err = (await readCapped(res.body, 4096))
				.replace(/\s+/g, " ")
				.slice(0, 240);
			o.wall = performance.now() - t0;
			return o;
		}
		const ct = res.headers.get("content-type") ?? "";
		let usage: Usage | undefined;
		if (ct.includes("event-stream") && res.body) {
			o.streamed = true;
			for await (const line of sseLines(res.body)) {
				if (!line.startsWith("data:")) continue;
				const d = line.slice(5).trim();
				if (d === "[DONE]") break;
				let j: Wj;
				try {
					j = JSON.parse(d) as Wj;
				} catch {
					continue;
				}
				if (j.error) {
					o.err = JSON.stringify(j.error).slice(0, 240);
					break;
				}
				if (leg.wire === "openai") usage = onOpenAiChunk(o, j, t0) ?? usage;
				else usage = onAnthropicEvent(o, j, t0, usage);
			}
		} else {
			usage = onWholeBody(
				o,
				leg,
				JSON.parse(await readCapped(res.body, LINE_CAP)) as Wj,
			);
		}
		o.wall = performance.now() - t0;
		if (!o.streamed) {
			// client sees nothing before the whole body (labelled n/s)
			o.ttft = o.wall;
			o.ttfc = o.wall;
		}
		applyUsage(o, q, usage);
		if (o.finish === "max_tokens") o.finish = "length";
		o.ok = !o.err;
	} catch (e) {
		const err = e as { name?: string; message?: string };
		o.wall = performance.now() - t0;
		o.err =
			err?.name === "AbortError"
				? `timeout ${q.timeoutMs}ms`
				: String(err?.message ?? e).slice(0, 240);
	} finally {
		clearTimeout(timer);
	}
	return o;
}

// ---------------------------------------------------------------- cost + routing
export function priceOf(
	model?: string | null,
): (Price & { model: string }) | null {
	if (!model) return null;
	const m = model
		.toLowerCase()
		.replace(/^(openai\/|zai\/|zai-)/, "")
		.replace(/\[.*\]$/, "");
	const p = PRICES[m];
	return p ? { model: m, ...p } : null;
}
export function costOf(leg: Leg, o: Out): { usd: number; priced: string } {
	if (leg.priced === "local" || (!o.ok && !o.outTok))
		return { usd: 0, priced: leg.priced === "local" ? "electricity" : "n/a" };
	let p = priceOf(PURE_MODEL) as Price & { model: string };
	if (leg.priced === "routed") {
		const port = Number(o.routed?.port);
		if (port >= 8900 && port < 9000) return { usd: 0, priced: "electricity" };
		p = priceOf(o.routed?.model) ?? priceOf(o.served) ?? p;
	}
	const cached = Math.min(o.cachedTok, o.inTok);
	return {
		usd:
			((o.inTok - cached) * p.in + cached * p.cached + o.outTok * p.out) / 1e6,
		priced: p.model + (o.tokEst ? " (est)" : ""),
	};
}
export function routedTier(routed: Routing | null | undefined): string | null {
	if (!routed) return null;
	const port = Number(routed.port);
	const cat = String(routed.category ?? "").toLowerCase();
	if (port === 8901 || cat === "code") return "coder";
	if (port === 8902 || cat === "extract") return "extract";
	if (port === 8903 || cat === "reason") return "reason";
	if (port === 8906 || cat === "general") return "general";
	return port >= 8900 && port < 9000 ? `local:${port}` : "cloud";
}
export const KEV_Q = {
	tier: {
		type: "choice",
		instructions: "Which serving tier should handle this request?",
		criteria: TIERS,
	},
};
export const nonceOf = (
	run: string,
	leg: string,
	task: string,
	phase: string,
) => sha(`${run}|${leg}|${task}|${phase}`).slice(0, 8);

/** Build the leg request from a (possibly transformed) task view: the
 *  transform has already rewritten prompt / text / q1 / q2. */
export function buildReq(
	cls: ClassId,
	t: Task,
	leg: Leg,
	nonce: string,
	which: 1 | 2 = 1,
): Req {
	const c = CLASSES[cls];
	const pre = `[ref:${nonce}]\n`;
	const base = {
		maxTokens: c.maxTokens,
		effort: c.effort,
		timeoutMs: c.timeoutMs,
		port: c.port,
	};
	const text = t.text ?? "";
	if (cls === "e")
		return {
			...base,
			user: pre + (leg.wire === "router" ? text : decisionPrompt(text)),
			kevState: `[ref:${nonce}] ${text}`,
		};
	if (cls === "f")
		return {
			...base,
			user: pre + longPrompt(t.doc ?? "", (which === 1 ? t.q1 : t.q2) ?? ""),
		};
	return { ...base, user: pre + (t.prompt ?? "") };
}
export async function scoreOut(
	cls: ClassId,
	t: Task,
	leg: Leg,
	o: Out,
	which: 1 | 2 = 1,
): Promise<Score> {
	if (!o.ok) return { score: 0, pass: false, detail: `error: ${o.err}` };
	if (leg.wire === "router") {
		const tier = routedTier(o.routed);
		return {
			score: +(tier === t.label),
			pass: tier === t.label,
			detail: `routed=${tier}`,
		};
	}
	if (leg.wire === "kev")
		return {
			score: +(o.text === t.label),
			pass: o.text === t.label,
			conf: o.kev?.confidence ?? null,
			detail: `kev=${o.text}`,
		};
	const chk = which === 2 ? t.check2 : t.check;
	if (!chk) throw new Error(`task ${t.id} (${cls}) has no check${which}`);
	return scoreText(chk, o.text);
}
export async function ping(leg: Leg, port: number, tag: string): Promise<Out> {
	if (leg.id === "pure-api" && !process.env.ZAI_API_KEY)
		return {
			...blank(),
			err: "ZAI_API_KEY not set in env (by design never read from files)",
		};
	if (
		(leg.id === "stack-engine-zai" || leg.id === "stack-engine-local") &&
		!engineKey()
	)
		return { ...blank(), err: "no engine key in env (LITELLM_KEY)" };
	const n = sha(`${tag}|${leg.id}|${port}|${Date.now()}`).slice(0, 8);
	return callLeg(
		leg,
		{
			user: `[ref:${n}]\nReply with the single word: pong`,
			maxTokens: 1,
			effort: "low",
			timeoutMs: 120e3,
			port: port || 8902,
			kevState: `[ref:${n}] ping`,
		},
		{ ping: { type: "noul", instructions: "Is this a connectivity ping?" } },
	);
}
export const load1 = () => +(loadavg()[0] ?? 0).toFixed(2);
