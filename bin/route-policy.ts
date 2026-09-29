// route-policy.ts — POST /api/route on the dashboard server (W89.1).
//
// POLICY: pick the target for a role (or model id) from local specialists
// (registry.ts) + remote endpoints (remotes.json), scored by belt's OWN
// metrics.db data — proven avg_ms beats probe RTT; unproven candidates rank
// below proven ones (conservative: never-measured is not fast), with
// load_5m and error count as penalties and freshness as tiebreak.
//
// EXECUTE: proxy the call. Locals go direct to 127.0.0.1:<port>/v1;
// remotes/cloud go through the LiteLLM gateway (GATEWAY_URL, master key in
// ~/.claude/local-llm/litellm.key) using the alias rule machine-model with
// ':' → '-' (nas-qwen2.5-0.5b, zai-glm-5.3). WoL-ensure runs before any LAN
// gateway call. Every decision — allowed AND denied — lands in the
// metrics.db audit table (timestamp, token label, target, why); the audit
// trail is a product feature, not debugging residue.
//
// AUTH: /api/route is the product surface — bearer token required. Tokens
// live in ~/.claude/local-llm/belt-tokens.json (never committed), shape
// {token: {label, created}}; a bootstrap token is generated on first boot.
// Errors are product surfaces: 401 vs 403 vs 503, all {error, why}.
//
// CONFIG (no localhost hardcoding): GATEWAY_URL and BELT_PUBLIC_URL come
// from env with current values as defaults.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { SPECIALISTS } from "./registry.ts";
import {
	loadStatic,
	probeEndpoint,
	logRoute,
	wakeIfNeeded,
	type RemoteMachine,
	type RemoteEndpoint,
} from "./remotes.ts";
import { metricsFor, auditRoute, LOCAL_NAME } from "./metrics.ts";

// ─── config (env overridable, current values as defaults) ───
export const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:4100";
export const BELT_PUBLIC_URL =
	process.env.BELT_PUBLIC_URL ?? "http://127.0.0.1:7791";
const TOKENS_PATH = `${process.env.HOME}/.claude/local-llm/belt-tokens.json`;
const GATEWAY_KEY_PATH = `${process.env.HOME}/.claude/local-llm/litellm.key`;
const SWARM_LOG = `${process.env.HOME}/.claude-insights/swarm-routing.log`;

// ─── auth ───
interface Tokens {
	[token: string]: { label: string; created: string };
}

/** First-boot bootstrap: generate a token if the keys file is missing. The
 *  token itself is never logged — only the file path. */
function ensureTokenFile(): void {
	if (existsSync(TOKENS_PATH)) return;
	const token = crypto.randomUUID().replace(/-/g, "");
	const doc: Tokens = {
		[token]: { label: "bootstrap", created: new Date().toISOString() },
	};
	try {
		appendFileSync(TOKENS_PATH, `${JSON.stringify(doc, null, "\t")}\n`);
	} catch {
		console.error(`belt route-policy: cannot write ${TOKENS_PATH}`);
		return;
	}
	console.log(
		`belt route-policy: bootstrap token written to ${TOKENS_PATH} (label: bootstrap)`,
	);
}

function readTokens(): Tokens {
	try {
		return JSON.parse(readFileSync(TOKENS_PATH, "utf8")) as Tokens;
	} catch {
		return {};
	}
}

/** 401 = no/malformed credential; 403 = credential present but unknown. */
function checkAuth(
	req: Request,
): { ok: true; label: string } | { ok: false; status: 401 | 403; why: string } {
	ensureTokenFile();
	const raw = req.headers.get("authorization") ?? "";
	const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
	if (!token)
		return {
			ok: false,
			status: 401,
			why: "missing bearer token — operators issue tokens from ~/.claude/local-llm/belt-tokens.json",
		};
	const label = readTokens()[token]?.label;
	if (!label)
		return {
			ok: false,
			status: 403,
			why: "token not recognized — ask the belt operator for a valid token",
		};
	return { ok: true, label };
}

// ─── candidates ───
interface Candidate {
	machine: string;
	port: number;
	model: string;
	protocol: string;
	kind: "local" | "remote" | "cloud";
	roles: string[];
	healthy: boolean;
	// measured avg latency from metrics.db; null = unproven (never called)
	estimate_ms: number | null;
	calls: number;
	load_5m: number;
	errors: number;
	last_used: string | null;
	probe_ms: number | null; // remote probe RTT (locals: null)
	m?: RemoteMachine;
	ep?: RemoteEndpoint;
}

/** Audit one decision into metrics.db — allowed AND denied alike. */
function audit(
	tokenLabel: string,
	action: string,
	decision: string,
	why: string,
	target?: { machine?: string; port?: number; model?: string },
): void {
	auditRoute({
		ts: new Date().toISOString(),
		token_label: tokenLabel,
		action,
		machine: target?.machine,
		port: target?.port ?? null,
		model: target?.model,
		decision,
		why,
		belt_url: BELT_PUBLIC_URL,
		gateway_url: GATEWAY_URL,
	});
}

const localProbe = async (port: number): Promise<boolean> => {
	try {
		await fetch(`http://127.0.0.1:${port}/v1/models`, {
			signal: AbortSignal.timeout(1200),
		});
		return true;
	} catch {
		return false;
	}
};

async function localCandidates(): Promise<Candidate[]> {
	return Promise.all(
		SPECIALISTS.map(async (s) => {
			const met = metricsFor(LOCAL_NAME, s.port, s.model);
			return {
				machine: LOCAL_NAME,
				port: s.port,
				model: s.model,
				protocol: "openai",
				kind: "local" as const,
				roles: [s.role],
				healthy: await localProbe(s.port),
				estimate_ms: met.calls > 0 ? met.avg_ms : null,
				calls: met.calls,
				load_5m: met.load_5m,
				errors: met.errors,
				last_used: met.last_used,
				probe_ms: null,
			};
		}),
	);
}

/** OpenAI-protocol endpoints only — immich cannot chat and the anthropic
 *  protocol takes a different request shape (no gateway alias either). */
async function remoteCandidates(): Promise<Candidate[]> {
	const flat = loadStatic().flatMap((m) =>
		m.endpoints.filter((e) => e.protocol === "openai").map((ep) => ({ m, ep })),
	);
	return Promise.all(
		flat.map(async ({ m, ep }) => {
			const t0 = Date.now();
			const healthy = await probeEndpoint(m, ep);
			const probe_ms = Date.now() - t0;
			const met = metricsFor(m.name, ep.port, ep.model ?? "");
			return {
				machine: m.name,
				port: ep.port,
				model: ep.model ?? "",
				protocol: ep.protocol,
				kind: (m.cloud ? "cloud" : "remote") as "remote" | "cloud",
				roles: ep.roles,
				healthy,
				estimate_ms: met.calls > 0 ? met.avg_ms : null,
				calls: met.calls,
				load_5m: met.load_5m,
				errors: met.errors,
				last_used: met.last_used,
				probe_ms,
				m,
				ep,
			};
		}),
	);
}

/** Role/model filter: exact model wins; else role membership, with the
 *  model id itself accepted as a role-ish selector. */
function applies(c: Candidate, role?: string, model?: string): boolean {
	if (model) return c.model === model;
	if (!role) return true;
	return (
		c.roles.includes(role) || c.model.toLowerCase().includes(role.toLowerCase())
	);
}

/** Proven average with a load penalty; unproven candidates sort to the
 *  back via +inf (never-measured is not fast — conservative on purpose). */
const effMs = (c: Candidate): number =>
	(c.estimate_ms ?? Number.POSITIVE_INFINITY) * (1 + 0.1 * c.load_5m);

function compareCandidates(a: Candidate, b: Candidate): number {
	if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
	const provenA = a.calls > 0 && a.estimate_ms != null;
	const provenB = b.calls > 0 && b.estimate_ms != null;
	if (provenA !== provenB) return provenA ? -1 : 1;
	if (effMs(a) !== effMs(b))
		return effMs(a) === Number.POSITIVE_INFINITY
			? (a.probe_ms ?? 9e9) - (b.probe_ms ?? 9e9)
			: effMs(a) - effMs(b);
	if (a.errors !== b.errors) return a.errors - b.errors;
	return (b.last_used ?? "").localeCompare(a.last_used ?? "");
}

/** One honest sentence naming the metric that actually decided it. */
function decideWhy(
	best: Candidate,
	alt: Candidate | undefined,
	role?: string,
): string {
	const meas = (c: Candidate): string =>
		c.estimate_ms != null
			? `${c.estimate_ms}ms avg over ${c.calls} call(s)`
			: `unproven (probe ${c.probe_ms ?? "?"}ms)`;
	const head = `${best.machine}:${best.port} ${best.model || best.protocol}`;
	if (!alt || alt === best)
		return `${head} — only healthy candidate serving '${role ?? "*"}'`;
	if (best.estimate_ms != null && alt.estimate_ms != null)
		return `${head} — fastest measured avg (${meas(best)} vs ${meas(alt)})`;
	if (best.estimate_ms != null)
		return `${head} — only candidate with measured latency (${meas(best)}); alternatives unproven`;
	return `${head} — no measured candidate; fastest probe (${meas(best)})`;
}

// ─── execute ───
interface RouteBody {
	role?: string;
	model?: string;
	messages?: { role: string; content: string }[];
	max_tokens?: number;
	temperature?: number;
	execute?: boolean;
}

/** Local executes append the swarm routing log (category "route", the real
 *  role in note) so metrics.db tallies them; failures carry outcome. */
function logLocalRoute(
	c: Candidate,
	role: string,
	ms: number,
	ok: boolean,
): void {
	try {
		appendFileSync(
			SWARM_LOG,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				category: "route",
				model: c.model,
				port: c.port,
				duration_ms: ms,
				ok,
				outcome: ok ? undefined : "error",
				note: `role=${role}`,
			})}\n`,
		);
	} catch {
		// best-effort — a failed log write must never fail the route
	}
}

function logRemoteRoute(
	c: Candidate,
	role: string,
	ms: number,
	ok: boolean,
	woke?: boolean,
): void {
	logRoute({
		ts: new Date().toISOString(),
		machine: c.machine,
		endpoint: `${c.m?.host ?? c.machine}:${c.port}`,
		protocol: c.protocol,
		role,
		duration_ms: ms,
		ok,
		model: c.model || undefined,
		woke,
	});
}

/** Execute one chat call on the chosen candidate. Locals go direct; remotes
 *  go through the gateway — WoL-ensure first for silent LAN machines. */
async function executeOn(
	c: Candidate,
	body: RouteBody,
	role: string,
): Promise<{ reply: string; ms: number }> {
	const t0 = Date.now();
	const payload = {
		model: c.model,
		messages: body.messages ?? [],
		max_tokens: body.max_tokens,
		temperature: body.temperature,
	};
	if (c.kind === "local") {
		const r = await fetch(`http://127.0.0.1:${c.port}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(120_000),
		});
		const ms = Date.now() - t0;
		if (!r.ok) throw new Error(`HTTP ${r.status} from local :${c.port}`);
		const j = (await r.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		logLocalRoute(c, role, ms, true);
		return {
			reply: j.choices?.[0]?.message?.content ?? "(empty response)",
			ms,
		};
	}
	return executeRemote(c, body, role, t0);
}

/** Gateway path for remote/cloud candidates — WoL-ensure first, master key
 *  from the runtime key file, alias rule machine-model (':' → '-'). */
async function executeRemote(
	c: Candidate,
	body: RouteBody,
	role: string,
	t0: number,
): Promise<{ reply: string; ms: number }> {
	if (!c.m || !c.ep)
		throw new Error(`cannot execute on ${c.machine} — no endpoint handle`);
	await wakeIfNeeded(c.m, c.ep);
	const alias = `${c.machine}-${(c.ep.model ?? "").replace(/:/g, "-")}`;
	const key = readFileSync(GATEWAY_KEY_PATH, "utf8").trim();
	const r = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${key}`,
		},
		body: JSON.stringify({
			model: alias,
			messages: body.messages ?? [],
			max_tokens: body.max_tokens,
			temperature: body.temperature,
		}),
		signal: AbortSignal.timeout(120_000),
	});
	const ms = Date.now() - t0;
	if (!r.ok) throw new Error(`HTTP ${r.status} from gateway for ${alias}`);
	const j = (await r.json()) as {
		choices?: {
			message?: { content?: string };
			finish_reason?: string;
		}[];
	};
	// thinking models spend max_tokens ON reasoning (glm-5.3 burned 497/500
	// in one probe → empty content, finish "length") — one retry at 4× budget
	let out = j.choices?.[0];
	if (out && !out.message?.content && out.finish_reason === "length") {
		const r2 = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${key}`,
			},
			body: JSON.stringify({
				model: alias,
				messages: body.messages ?? [],
				max_tokens: (body.max_tokens ?? 500) * 4,
				temperature: body.temperature,
			}),
			signal: AbortSignal.timeout(180_000),
		});
		if (r2.ok) {
			const j2 = (await r2.json()) as {
				choices?: { message?: { content?: string } }[];
			};
			out = j2.choices?.[0];
		}
	}
	logRemoteRoute(c, role, ms, true);
	return {
		reply: out?.message?.content || "(empty response)",
		ms: Date.now() - t0,
	};
}

// ─── the endpoint ───
const respond = (status: number, body: Record<string, unknown>): Response =>
	new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "content-type": "application/json" },
	});

export async function handleRoute(req: Request): Promise<Response> {
	ensureTokenFile();
	const auth = checkAuth(req);
	if (!auth.ok) {
		audit("unknown", "route", "denied", auth.why);
		return respond(auth.status, {
			error: auth.status === 401 ? "unauthorized" : "forbidden",
			why: auth.why,
		});
	}
	return routeDecide(req, auth.label);
}

/** Post-auth decision + execute path (split from handleRoute for size). */
async function routeDecide(req: Request, label: string): Promise<Response> {
	let body: RouteBody;
	try {
		body = (await req.json()) as RouteBody;
	} catch {
		audit(label, "route", "denied", "request body is not valid JSON");
		return respond(400, {
			error: "bad request",
			why: "request body is not valid JSON",
		});
	}
	const role = typeof body.role === "string" ? body.role : undefined;
	const model = typeof body.model === "string" ? body.model : undefined;
	if (!role && !model) {
		audit(label, "route", "denied", "neither role nor model in body");
		return respond(400, {
			error: "bad request",
			why: "pass role (e.g. 'reasoning') or model (e.g. 'glm-5.3')",
		});
	}
	const all = [...(await localCandidates()), ...(await remoteCandidates())];
	const matching = all
		.filter((c) => applies(c, role, model))
		.sort(compareCandidates);
	if (!matching.length) {
		const why = `no candidate serves ${model ? `model ${model}` : `role '${role}'`} (locals + remotes.json)`;
		audit(label, "route", "denied", why);
		return respond(404, { error: "no route", why });
	}
	return pickAndRun(body, matching, label, role);
}

/** Policy decision → advisory reply, or hand off to the execute branch. */
function pickAndRun(
	body: RouteBody,
	matching: Candidate[],
	label: string,
	role?: string,
): Promise<Response> {
	const best = matching[0];
	const why = decideWhy(best, matching[1], role);
	const target = {
		machine: best.machine,
		port: best.port,
		model: best.model || null,
		protocol: best.protocol,
		kind: best.kind,
	};
	audit(label, "route", "policy", why, {
		machine: best.machine,
		port: best.port,
		model: best.model,
	});
	const estimate =
		best.estimate_ms ?? (best.probe_ms ? Math.round(best.probe_ms * 3) : null);
	if (body.execute !== true && !Array.isArray(body.messages))
		return respond(200, { target, why, latency_estimate_ms: estimate });
	return runExecute(body, best, label, role, why, target, estimate);
}

/** Execute branch of the policy path — 400 without messages, honest 503 via
 *  failRoute (audit + routing-log both record the failure). */
async function runExecute(
	body: RouteBody,
	best: Candidate,
	label: string,
	role: string | undefined,
	why: string,
	target: Record<string, unknown>,
	estimate: number | null,
): Promise<Response> {
	if (!Array.isArray(body.messages) || body.messages.length === 0) {
		audit(label, "route", "denied", "execute without messages", {
			machine: best.machine,
			port: best.port,
			model: best.model,
		});
		return respond(400, {
			error: "bad request",
			why: "execute:true needs a messages array",
		});
	}
	try {
		const { reply, ms } = await executeOn(best, body, role ?? "route");
		audit(label, "route", "executed", why, {
			machine: best.machine,
			port: best.port,
			model: best.model,
		});
		return respond(200, {
			target,
			why,
			latency_estimate_ms: estimate,
			reply,
			ms,
		});
	} catch (err) {
		return failRoute(best, label, role, why, err);
	}
}

/** The honest 503: audit + routing-log + machine-readable error. */
function failRoute(
	best: Candidate,
	label: string,
	role: string | undefined,
	why: string,
	err: unknown,
): Response {
	const msg = err instanceof Error ? err.message : String(err);
	const whyFail = `${why}; execute failed: ${msg}`;
	audit(label, "route", "failed", whyFail, {
		machine: best.machine,
		port: best.port,
		model: best.model,
	});
	try {
		if (best.kind === "local") logLocalRoute(best, role ?? "route", 0, false);
		else logRemoteRoute(best, role ?? "route", 0, false);
	} catch {
		// best-effort on the failure path
	}
	return respond(503, { error: "route failed", why: whyFail });
}
