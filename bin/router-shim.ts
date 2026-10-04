#!/usr/bin/env bun
// router-shim.ts — LLM specialist swarm router v3.
// Anthropic API format on :4000 → complexity-scored routing across the local
// mlx swarm, bounded fallback to an alternate specialist, then optional cloud
// escalation (prefs-gated). Policy + upstream I/O live in router-core.ts
// (importable for tests); stream:true is piped through as Anthropic SSE.
//
// Routing preference + cloud switch live in prefs.json (same dir):
//   { "cost_speed": "balanced"|"cost"|"speed"|"quality", "allow_cloud": bool }
// Cloud escalation fires only when: allow_cloud=true, cost mode isn't active,
// local failed twice, and the task is COMPLEX/VERY_COMPLEX (SIMPLE never
// leaves the machine).

import { appendFileSync } from "node:fs";
import { createAdmission, overloaded } from "./admission.ts";
import { promptFingerprint } from "./prompt-fingerprint.ts";
import { byPort, fallbackFor, type Specialist } from "./registry.ts";
import {
	type AnthropicBody,
	anthropicSseFromOpenAi,
	anthropicSseFromText,
	applyBudget,
	callHonoringRetryAfter,
	classifierText,
	kevEligible,
	openLocalStream,
	retryAfterMs,
	scoreComplexity,
	stopReason,
	toOpenAiMessages,
	viaLocal,
} from "./router-core.ts";
import { registryResponse } from "./registry-emit.ts";
import { ensureUp } from "./spawner.ts";

const admission = createAdmission();

const HOME = process.env.HOME;
const PREFS_FILE = `${HOME}/.claude/local-llm/prefs.json`;
const ROUTING_LOG = `${HOME}/.claude-insights/swarm-routing.log`;

function logRouting(entry: Record<string, unknown>) {
	const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
	try {
		appendFileSync(ROUTING_LOG, `${line}\n`);
	} catch {}
}

type Prefs = {
	cost_speed?: "balanced" | "cost" | "speed" | "quality";
	allow_cloud?: boolean;
	profile?: string[];
	routing_table?: Record<string, number>;
	kev?: { enabled?: boolean; port?: number; ambiguity_band?: [number, number] };
};
async function loadPrefs(): Promise<Prefs> {
	try {
		return JSON.parse(await Bun.file(PREFS_FILE).text());
	} catch {
		return {};
	}
}

// arithmetic lane: a pure-math ask is evaluated directly, never sent to an
// LLM — Qwen3-4B deterministically answers 17*23 -> "401" at temp 0 (verified
// 2026-09-23). Strict allowlist; anything ambiguous fails safe to the LLM.
const ARITH_LEAD =
	/^(what\s+is|what's|whats|calculate|compute|how\s+much\s+is|how\s+many\s+is|hvad\s+er|hvor\s+meget\s+er)\s+/i;
const ARITH_TAIL =
	/\s*[,.;]?\s*(answer|reply|respond|svar)(\s+\w+){0,3}\s*(the\s+)?(number|result|tallet)(\s+only)?[.]*$/i;
function arithmeticAnswer(text: string): string | null {
	let t = text
		.trim()
		.replace(ARITH_LEAD, "")
		.replace(ARITH_TAIL, "")
		.replace(/[?!.]+$/, "")
		.trim();
	if (!t || t.length > 120) return null;
	t = t.replace(/\bx\b|×/gi, "*").replace(/÷/g, "/");
	if (!/^[\d\s+\-*/()]+$/.test(t)) return null; // strict charset
	if (!/\d/.test(t) || (!/[+*/]/.test(t) && !/\d\s*-\s*\d/.test(t)))
		return null; // need an operator
	const tokens = t.match(/\d+(?:\.\d+)?|[+\-*/()]/g);
	if (!tokens) return null;
	const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };
	const out: (number | string)[] = [];
	const ops: string[] = [];
	let prev: "n" | "op" | "(" | ")" | null = null;
	for (const tk of tokens) {
		if (/^\d/.test(tk)) {
			out.push(parseFloat(tk));
			prev = "n";
			continue;
		}
		if (tk === "(") {
			ops.push(tk);
			prev = "(";
			continue;
		}
		if (tk === ")") {
			for (;;) {
				const top = ops[ops.length - 1];
				if (top === undefined || top === "(") break;
				ops.pop();
				out.push(top);
			}
			if (!ops.includes("(")) return null;
			ops.pop();
			prev = ")";
			continue;
		}
		if (tk === "-" && (prev === null || prev === "op" || prev === "("))
			out.push(0); // unary minus
		else {
			for (;;) {
				const top = ops[ops.length - 1];
				if (top === undefined || top === "(" || (prec[top] ?? 0) < prec[tk])
					break;
				ops.pop();
				out.push(top);
			}
		}
		ops.push(tk);
		prev = "op";
	}
	while (ops.length) {
		const o = ops.pop();
		if (o === undefined || o === "(") return null;
		out.push(o);
	}
	const st: number[] = [];
	for (const tk of out) {
		if (typeof tk === "number") {
			st.push(tk);
			continue;
		}
		const b = st.pop();
		const a = st.pop();
		if (a === undefined || b === undefined) return null;
		st.push(
			tk === "+" ? a + b : tk === "-" ? a - b : tk === "*" ? a * b : a / b,
		);
	}
	if (st.length !== 1 || !Number.isFinite(st[0])) return null;
	const r = st[0];
	return String(
		Math.abs(r - Math.round(r)) < 1e-9 ? Math.round(r) : Number(r.toFixed(6)),
	);
}

// ─── routes derived from registry.ts (single source of truth) ───
// fail fast at boot on a misconfigured registry, not mid-request
const specialist = (port: number): Specialist => {
	const s = byPort(port);
	if (!s) throw new Error(`registry: no specialist on :${port}`);
	return s;
};
const CODE = specialist(8901);
const REASON = specialist(8903);
const EXTRACT = specialist(8902);
const DANISH = specialist(8906); // tier:"ondemand" — spawned on first request
const TIER_ROUTES: Record<string, Specialist> = {
	SIMPLE: EXTRACT,
	MEDIUM: CODE,
	COMPLEX: REASON,
	VERY_COMPLEX: REASON,
};

// Danish/multilingual detection — deterministic word list + æøå, no model
// calls (routing rule 3). Two strong hits, or one strong + weak, or three
// weak; æøå shares with Norwegian, but :8906 covers 201 langs either way.
const DA_STRONG =
	/\b(jeg|ikke|hvad|hvordan|hvorfor|hvilken|hvilket|hvilke|også|måske|dansk|danmark|hygge|mig|dig)\b/gi;
const DA_WEAK =
	/\b(og|er|det|som|på|til|af|med|der|hun|han|vi|har|skal|år)\b/gi;
function isDanish(text: string): boolean {
	const strong = (text.match(DA_STRONG) ?? []).length;
	const weak = (text.match(DA_WEAK) ?? []).length;
	if ((text.match(/[æøå]/gi) ?? []).length >= 2) return true;
	return strong >= 2 || (strong >= 1 && weak >= 1) || weak >= 3;
}

// ─── cloud escalation (z.ai, Anthropic format; creds read at request time,
// never logged or cached). Budget policy applies (GLM always thinks); an
// upstream 429 surfaces its Retry-After instead of an empty answer. ───
async function viaCloud(
	body: AnthropicBody,
	maxTokens: number,
	wantFast: boolean,
): Promise<{
	text: string;
	model: string;
	status?: number;
	retryAfterMs?: number;
	note?: string;
}> {
	const model = wantFast ? "glm-5.3-flash" : "glm-5.3";
	const settings = JSON.parse(
		await Bun.file(`${HOME}/.claude/settings.json`).text(),
	);
	const tok = settings.env?.ANTHROPIC_AUTH_TOKEN;
	const base = settings.env?.ANTHROPIC_BASE_URL;
	if (!tok || !base) return { text: "", model };
	const budget = applyBudget(model, maxTokens);
	const res = await fetch(`${base}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": tok,
			authorization: `Bearer ${tok}`,
			"anthropic-version": "2023-06-01",
		},
		signal: AbortSignal.timeout(120_000),
		body: JSON.stringify({
			model: `${model}[1m]`,
			max_tokens: budget.maxTokens,
			...(body.system === undefined ? {} : { system: body.system }),
			messages: body.messages,
		}),
	});
	if (res.status === 429) {
		await res.body?.cancel();
		return {
			text: "",
			model,
			status: 429,
			retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
		};
	}
	const j = (await res.json()) as { content?: Array<{ text?: string }> };
	return {
		text: (j.content ?? [])
			.map((b) => b.text ?? "")
			.join("")
			.trim(),
		model,
		status: res.status,
		note: budget.note,
	};
}

// selftest: fire one request whose primary target is a dead port, asserting
// the fallback branch answers. The path otherwise almost never runs — first
// real firing ever (Sep 23) crashed on a stale FALLBACKS table.
if (process.argv[2] === "selftest") {
	const base = `http://127.0.0.1:${process.env.BELT_ROUTER_PORT ?? 4000}`;
	const t0 = performance.now();
	const r = await fetch(`${base}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4",
			max_tokens: 60,
			_force_dead_port: 59999,
			messages: [{ role: "user", content: "Reply with the word OK." }],
		}),
		signal: AbortSignal.timeout(120_000),
	});
	const d = (await r.json()) as {
		_routing?: { note?: string };
		content?: Array<{ text?: string }>;
	};
	const note = String(d._routing?.note ?? "");
	const text = String(d.content?.[0]?.text ?? "");
	const ok = r.status === 200 && note.includes("fallback") && text.length > 0;
	console.log(
		`${ok ? "✓" : "✗"} fallback ${ok ? "verified" : "BROKEN"} — status=${r.status} note="${note}" head="${text.slice(0, 40)}" (${Math.round(performance.now() - t0)}ms)`,
	);
	process.exit(ok ? 0 : 1);
}

// selftest-danish: fire one request that must land on the on-demand
// generalist :8906 — asserts detection + spawn-on-demand. Needs :8906 either
// warm or spawnable; run against BELT_ROUTER_PORT for side-by-side checks.
if (process.argv[2] === "selftest-danish") {
	const base = `http://127.0.0.1:${process.env.BELT_ROUTER_PORT ?? 4000}`;
	const t0 = performance.now();
	const r = await fetch(`${base}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "claude-sonnet-4",
			max_tokens: 60,
			messages: [
				{
					role: "user",
					content:
						"Hvad er forskellen på hypotese og teori? Forklar venligst kort.",
				},
			],
		}),
		signal: AbortSignal.timeout(120_000),
	});
	const d = (await r.json()) as {
		_routing?: { port?: number; note?: string };
		content?: Array<{ text?: string }>;
	};
	const note = String(d._routing?.note ?? "");
	const text = String(d.content?.[0]?.text ?? "");
	const ok = r.status === 200 && d._routing?.port === 8906 && text.length > 0;
	console.log(
		`${ok ? "✓" : "✗"} danish ondemand ${ok ? "verified" : "BROKEN"} — status=${r.status} port=${d._routing?.port} note="${note}" head="${text.slice(0, 40)}" (${Math.round(performance.now() - t0)}ms)`,
	);
	process.exit(ok ? 0 : 1);
}

// ─── Anthropic↔OpenAI shim ───
// BELT_ROUTER_PORT: side-by-side runs (tests, canary) without disturbing :4000.
const ROUTER_PORT = Number(process.env.BELT_ROUTER_PORT ?? 4000);

type Attempt = {
	ok: boolean;
	error?: string;
	status?: number;
	retryAfterMs?: number;
};

/** Primary → one bounded fallback (admission-gated). The fallback slot is
 *  returned, not released: a stream holds it until the last byte. */
async function ladder<R extends Attempt>(
	route: Specialist,
	primary: Specialist,
	call: (t: Specialist) => Promise<R>,
	note: string[],
	errors: string[],
): Promise<{
	result: R;
	used: Specialist;
	fbRelease?: () => void;
	retryAfterMs?: number;
}> {
	let result = await callHonoringRetryAfter(() => call(primary));
	let used = primary;
	let retryAfter =
		result.status === 429 ? (result.retryAfterMs ?? 0) : undefined;
	if (result.ok) return { result, used };
	errors.push(`:${primary.port} ${result.error ?? "empty"}`);
	const fb = fallbackFor(route.port);
	if (!fb) return { result, used, retryAfterMs: retryAfter };
	const fbRelease = admission.tryAcquire(fb.port);
	if (!fbRelease) {
		note.push(`fallback :${fb.port} at max in-flight`);
		return { result, used, retryAfterMs: retryAfter };
	}
	note.push(`fallback → :${fb.port}`);
	result = await callHonoringRetryAfter(() => call(fb));
	used = fb;
	if (result.status === 429)
		retryAfter = Math.max(retryAfter ?? 0, result.retryAfterMs ?? 0);
	if (result.ok) return { result, used, fbRelease };
	fbRelease();
	errors.push(`:${fb.port} ${result.error ?? "empty"}`);
	return { result, used, retryAfterMs: retryAfter };
}

// header = ASCII essentials only (the note carries "→"); full _routing rides
// in message_start
const sseHeaders = (routing: Record<string, unknown>) => ({
	"content-type": "text/event-stream",
	"cache-control": "no-cache",
	"x-belt-routing": JSON.stringify({
		tier: routing.tier,
		category: routing.category,
		port: routing.port,
		model: routing.model,
	}).replace(/[^\x20-\x7e]/g, "?"),
});

Bun.serve({
	port: ROUTER_PORT,
	hostname: "127.0.0.1", // W204/H1: loopback-only — never a raw LAN bind; external access only via an authenticated Caddy hop
	idleTimeout: 0, // streams may idle through a long prefill
	async fetch(req) {
		const url = new URL(req.url);

		if (req.method === "GET" && url.pathname === "/health/liveliness") {
			return Response.json({ status: "alive", router: "complexity-v3" });
		}

		// W271: the full registry (ETag'd); hubs proxy it, spokes pull it
		if (
			(req.method === "GET" || req.method === "HEAD") &&
			url.pathname === "/registry.json"
		)
			return registryResponse(req);

		if (req.method !== "POST" || url.pathname !== "/v1/messages") {
			return Response.json({ error: "not found" }, { status: 404 });
		}

		let body: AnthropicBody;
		try {
			body = await req.json();
		} catch {
			return Response.json({ error: "bad json" }, { status: 400 });
		}

		const startTime = Date.now();
		const text = classifierText(body);
		const wantStream = body.stream === true;

		// score complexity and select specialist:
		//   code-ish → coder; everything non-SIMPLE prose → 27B general; else 4B
		const prefs = await loadPrefs();
		const score = scoreComplexity(text);

		// arithmetic lane — zero tokens, zero model calls
		const arith = arithmeticAnswer(text);
		if (arith !== null) {
			const id = `msg_arith_${Date.now()}`;
			const routing = { tier: "SIMPLE", category: "arithmetic" };
			if (wantStream)
				return new Response(
					anthropicSseFromText(arith, { id, model: body.model, routing }),
					{ headers: sseHeaders(routing) },
				);
			return Response.json({
				id,
				type: "message",
				role: "assistant",
				model: body.model,
				content: [{ type: "text", text: arith }],
				stop_reason: "end_turn",
				usage: { input_tokens: 0, output_tokens: 0 },
				_routing: routing,
			});
		}

		const isCode = score.dimensions.codePresence > 0.5;
		let route = isCode
			? TIER_ROUTES.MEDIUM
			: score.tier === "SIMPLE"
				? TIER_ROUTES.SIMPLE
				: TIER_ROUTES.COMPLEX;

		// ambiguity band → Kev typed-question classifier decides by use case
		// (routing table from prefs); kev down/slow ⇒ regex result stands.
		// Prompts past Kev's context window skip the serial hop (W270).
		let classifier = "";
		const band: [number, number] = prefs.kev?.ambiguity_band ?? [0.25, 0.45];
		const inBand = score.total >= band[0] && score.total <= band[1];
		const kevWanted =
			prefs.kev?.enabled &&
			!isCode &&
			(inBand || score.tier === "VERY_COMPLEX");
		if (kevWanted && !kevEligible(text)) classifier = "kev-skipped:long";
		else if (kevWanted) {
			try {
				const kr = await fetch(
					`http://127.0.0.1:${prefs.kev?.port ?? 8912}/v1/systemone`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						signal: AbortSignal.timeout(4000),
						body: JSON.stringify({
							model: "kev-latest",
							state: text.slice(0, 4000),
							questions: {
								use_case: {
									type: "choice",
									instructions: "Which use-case class is this request?",
									criteria: {
										coding: "Writing, debugging, or reviewing code",
										architecture:
											"System design, trade-offs, technical strategy",
										trading: "Stock market, positions, finance risk decisions",
										business: "Invoices, customers, business administration",
										research: "Multi-source investigation and synthesis",
										product: "Product decisions and roadmaps",
										personal: "Everyday personal assistance, email, chit-chat",
									},
								},
							},
						}),
					},
				);
				const kj = (await kr.json()) as {
					answers?: { use_case?: { choice?: string } };
				};
				const uc = kj.answers?.use_case?.choice;
				const pin = uc ? prefs.routing_table?.[uc] : undefined;
				if (pin) {
					route =
						pin === 8901
							? TIER_ROUTES.MEDIUM
							: pin === 8902
								? TIER_ROUTES.SIMPLE
								: TIER_ROUTES.COMPLEX;
					classifier = `kev:${uc}`;
				}
			} catch {
				/* kev unavailable → keep regex route */
			}
		}

		// Danish/multilingual → the on-demand generalist :8906 (routing rule 5);
		// overrides use-case pins — language beats task class for the 9B specialist.
		if (!isCode && DANISH && route.port !== DANISH.port && isDanish(text)) {
			route = DANISH;
			classifier = classifier ? `${classifier}+danish` : "danish";
		}

		// admission control: bound in-flight per routed port; overflow → 429 +
		// Retry-After so the gateway ladder takes its next hop
		const release = admission.tryAcquire(route.port);
		if (!release) {
			logRouting({
				category: route.role,
				port: route.port,
				...promptFingerprint(text),
				outcome: "overloaded",
			});
			return overloaded(route.port, admission);
		}
		let handedOff = false; // a live stream owns `release` until its last byte
		try {
			const clientMax = Math.min(body.max_tokens ?? 1024, 4096);
			const temperature = body.temperature ?? 0.7;
			const messages = toOpenAiMessages(body);

			let response = "";
			let finish: string | undefined;
			let usedPort: number = route.port;
			let usedModel = route.model;
			const note: string[] = [
				`complexity ${score.total.toFixed(2)} → ${score.tier}${isCode ? "+code" : ""}${classifier ? ` ${classifier}` : ""}`,
			];
			const errors: string[] = [];
			const routingInfo = () => ({
				tier: score.tier,
				complexity: score.total.toFixed(3),
				category: route.role,
				port: usedPort,
				model: usedModel,
				note: note.join("; "),
				prefs: {
					cost_speed: prefs.cost_speed ?? "balanced",
					allow_cloud: prefs.allow_cloud === true,
					profile: prefs.profile ?? [],
				},
				dimensions: Object.fromEntries(
					Object.entries(score.dimensions).map(([k, v]) => [k, v.toFixed(2)]),
				),
			});
			const logDone = (extra: Record<string, unknown>) =>
				logRouting({
					category: route.role,
					model: usedModel,
					port: usedPort,
					duration_ms: Date.now() - startTime,
					...promptFingerprint(text),
					complexity: score.total,
					tier: score.tier,
					stream: wantStream || undefined,
					...extra,
				});

			// selftest hook: _force_dead_port swaps the primary target while keeping
			// route identity — fallbackFor() still maps from the real route
			let primary = route;
			if (Number.isFinite(Number(body._force_dead_port))) {
				primary = {
					...route,
					port: Number(body._force_dead_port) as Specialist["port"],
					model: "selftest-dead",
				};
				note.push(`forced dead primary :${primary.port}`);
			}

			// ondemand tier: spawn on first request (single-flight); residents rely
			// on launchd KeepAlive instead (routing rule 2). Cold load is visible in
			// the note — never a silent fallback (that was the W1 defect).
			if (route.tier === "ondemand") {
				const ens = await ensureUp(route);
				if (ens.up) {
					if (ens.cold)
						note.push(
							`ondemand :${route.port} ready (cold ${(ens.waitedMs / 1000).toFixed(1)}s)`,
						);
				} else {
					note.push(
						`ondemand :${route.port} DOWN (${ens.error ?? "spawn failed"})`,
					);
				}
			}

			// budget policy per target model (thinking off / min budget)
			const budgetFor = (t: Specialist) => {
				const b = applyBudget(t.model, clientMax);
				if (b.note) note.push(b.note);
				return b;
			};

			let retryAfter: number | undefined;
			if (wantStream) {
				// streamed: TTFT = the specialist's first token, not the full answer
				const opened = await ladder(
					route,
					primary,
					(t) => {
						const b = budgetFor(t);
						return openLocalStream(t, messages, b.maxTokens, temperature, {
							extra: b.extra,
						});
					},
					note,
					errors,
				);
				usedPort = opened.used.port;
				usedModel = opened.used.model;
				retryAfter = opened.retryAfterMs;
				if (opened.result.ok) {
					const routing = routingInfo();
					const fbRelease = opened.fbRelease;
					const stream = anthropicSseFromOpenAi(
						opened.result.body,
						{
							id: `msg_${route.role}_${Date.now()}`,
							model: body.model,
							routing,
						},
						(r) => {
							fbRelease?.();
							release();
							logDone({
								outcome: r.error
									? "stream-error"
									: r.chars
										? undefined
										: "empty",
								finish: r.finish,
							});
						},
					);
					handedOff = true;
					return new Response(stream, { headers: sseHeaders(routing) });
				}
			} else {
				const got = await ladder(
					route,
					primary,
					(t) => {
						const b = budgetFor(t);
						return viaLocal(t, messages, b.maxTokens, temperature, {
							extra: b.extra,
						});
					},
					note,
					errors,
				);
				got.fbRelease?.();
				usedPort = got.used.port;
				usedModel = got.used.model;
				retryAfter = got.retryAfterMs;
				if (got.result.ok) {
					response = got.result.response;
					finish = got.result.finish;
				}
			}

			// cloud escalation — prefs-gated, COMPLEX+ only, never in cost mode
			const cloudAllowed =
				prefs.allow_cloud === true && prefs.cost_speed !== "cost";
			const cloudWarranted =
				score.tier === "COMPLEX" ||
				score.tier === "VERY_COMPLEX" ||
				prefs.cost_speed === "quality";
			if (!response && cloudAllowed && cloudWarranted) {
				try {
					const c = await viaCloud(
						body,
						clientMax,
						score.tier !== "VERY_COMPLEX",
					);
					if (c.note) note.push(c.note);
					if (c.status === 429)
						retryAfter = Math.max(retryAfter ?? 0, c.retryAfterMs ?? 0);
					if (c.text) {
						response = c.text;
						usedPort = 0;
						usedModel = `z.ai:${c.model}`;
						note.push("escalated → cloud(z.ai)");
					}
				} catch {
					note.push("cloud escalation failed");
				}
			}

			if (!response) {
				// every hop saturated → 429 with the longest upstream Retry-After so
				// the caller's ladder backs off instead of retrying a 502
				if (retryAfter !== undefined) {
					logDone({ outcome: "upstream-429" });
					const s = Math.max(1, Math.ceil(retryAfter / 1000));
					return Response.json(
						{
							type: "error",
							error: {
								type: "overloaded_error",
								message: `router: upstream 429 (${[...note, ...errors].join("; ")}); retry after ${s}s`,
							},
						},
						{ status: 429, headers: { "retry-after": String(s) } },
					);
				}
				logDone({ outcome: "empty" });
				return Response.json(
					{
						type: "error",
						error: {
							type: "api_error",
							message: `router: all routes empty (${[...note, ...errors].join("; ")})`,
						},
					},
					{ status: 502 },
				);
			}

			logDone({ escalated: usedPort === 0 ? "z.ai" : undefined, finish });
			const id = `msg_${route.role}_${Date.now()}`;
			const routing = routingInfo();
			if (wantStream)
				return new Response(
					anthropicSseFromText(
						response,
						{ id, model: body.model, routing },
						finish,
					),
					{ headers: sseHeaders(routing) },
				);
			return Response.json({
				id,
				type: "message",
				role: "assistant",
				model: body.model,
				content: [{ type: "text", text: response }],
				stop_reason: stopReason(finish),
				usage: { input_tokens: 0, output_tokens: 0 },
				_routing: routing,
			});
		} finally {
			if (!handedOff) release();
		}
	},
});

console.log(
	`router-shim v3 (complexity + prefs + escalation) on :${ROUTER_PORT}`,
);
for (const [tier, r] of Object.entries(TIER_ROUTES)) {
	console.log(
		`  ${tier.padEnd(13)} → :${r.port} ${r.model.replace("mlx-community/", "")}`,
	);
}
console.log(
	`  code → :${CODE.port} · non-SIMPLE prose → :${REASON.port} · SIMPLE → :${EXTRACT.port}`,
);
console.log(
	`  danish/multilingual → :${DANISH.port} (on-demand, spawned on first request)`,
);
console.log(
	`  cloud escalation: allow_cloud=true (COMPLEX+ only, off in cost mode)`,
);
