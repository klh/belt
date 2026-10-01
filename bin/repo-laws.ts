// bin/repo-laws.ts — W164: repo-scoped routing laws + the BYO-LLM user
// plane, belt side. The resolution chain lives HERE; route-policy.ts only
// wires it in (W159 owns the classifier seams — this module never touches
// hintFit/hintTotal/decide internals).
//
// Precedence (owner law): repo dotfile > user plane > central (W154
// manifest rules[], kind "repo-law") > install default. Company repos:
// central must beats user prefer (entitlements are ceilings); private
// repos: hub not consulted (no matching rule = no central layer at all —
// the local last-known cache is only read, the hub is never called).
// must-no-fit errors honestly at every layer, naming the layer.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { hintFit, hintTotal, type RouteHint } from "./route-policy.ts";

// ─── the .llm grammar (port — one grammar, belt is the enforcer) ───────────
export type DotfileParse =
	| {
			ok: true;
			musts: RouteHint[];
			prefer: RouteHint | null;
			tier: string | null;
			fallback: string[] | null;
	  }
	| { ok: false; errors: { line: number; why: string }[] };

const LAW_KEYS = new Set(["prefer", "must", "tier", "fallback"]);
const TIERS = new Set(["simple", "medium", "complex", "very_complex"]);
const TOKENS_MAX = 12;
const TOKEN_MAX = 64;

/** law expr tokens → RouteHint (W96 token rules; belt parseHint semantics
 *  minus the verb — the verb IS the line key). */
export function lawExprToHint(
	verb: "prefer" | "must",
	expr: string,
): { ok: true; hint: RouteHint } | { ok: false; why: string } {
	const tokens = expr.trim().split(/\s+/).filter(Boolean);
	if (!tokens.length || tokens.length > TOKENS_MAX)
		return {
			ok: false,
			why: `1–${String(TOKENS_MAX)} tokens, e.g. 'local distill reasoning'`,
		};
	const hint: RouteHint = { verb, tags: [] };
	let location = false;
	let model = false;
	for (const tok of tokens) {
		if (tok.length > TOKEN_MAX)
			return { ok: false, why: `token over ${String(TOKEN_MAX)} chars` };
		if (tok === "local" || tok === "cloud") {
			if (location) return { ok: false, why: `duplicate location ('${tok}')` };
			hint.location = { kind: tok };
			location = true;
		} else if (tok.startsWith("host:")) {
			if (location) return { ok: false, why: `duplicate location ('${tok}')` };
			if (tok === "host:")
				return { ok: false, why: "host: needs a server name" };
			hint.location = { host: tok.slice(5) };
			location = true;
		} else if (tok.startsWith("model:")) {
			if (model) return { ok: false, why: "duplicate model:" };
			if (tok === "model:")
				return { ok: false, why: "model: needs an id or glob" };
			hint.model = tok.slice(6);
			model = true;
		} else hint.tags.push(tok);
	}
	return { ok: true, hint };
}

/** Parse a whole .llm dotfile into the routing view: musts[] (AND'd), one
 *  prefer (last one wins? no — FIRST prefer wins; later ones are ignored
 *  loudly? The console serializer keeps order; belt takes the FIRST),
 *  tier, fallback. ALL invalid lines collected with line numbers. */
export function parseLlmDotfile(text: string): DotfileParse {
	const errors: { line: number; why: string }[] = [];
	const musts: RouteHint[] = [];
	let prefer: RouteHint | null = null;
	let tier: string | null = null;
	let fallback: string[] | null = null;
	for (const [i, raw] of text.split("\n").entries()) {
		const n = i + 1;
		const t = raw.trim();
		if (!t || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		const key = eq < 0 ? "" : t.slice(0, eq).trim();
		const val = eq < 0 ? "" : t.slice(eq + 1).trim();
		if (!LAW_KEYS.has(key)) {
			errors.push({
				line: n,
				why: `unknown law key '${key.slice(0, 24)}' — expected prefer=, must=, tier=, fallback=`,
			});
			continue;
		}
		if (key === "prefer" || key === "must") {
			const h = lawExprToHint(key, val);
			if (!h.ok) {
				errors.push({ line: n, why: `${key}=: ${h.why}` });
				continue;
			}
			if (key === "must") musts.push(h.hint);
			else if (prefer === null) prefer = h.hint;
		} else if (key === "tier") {
			const tv = val.toLowerCase();
			if (!TIERS.has(tv)) {
				errors.push({
					line: n,
					why: `tier=: must be one of simple|medium|complex|very_complex, got '${val.slice(0, 24)}'`,
				});
				continue;
			}
			if (tier === null) tier = tv;
			else errors.push({ line: n, why: "tier= set more than once" });
		} else if (key === "fallback") {
			if (fallback !== null) {
				errors.push({ line: n, why: "fallback= set more than once" });
				continue;
			}
			const tiers = val
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			if (!tiers.length) {
				errors.push({
					line: n,
					why: "fallback=: needs a comma-separated tier list",
				});
				continue;
			}
			if (tiers.some((x) => /flashx/i.test(x)))
				errors.push({
					line: n,
					why: "fallback=: flashx is refused (owner directive)",
				});
			else fallback = tiers;
		}
	}
	return finishBeltParse(errors, musts, prefer, tier, fallback);
}

function finishBeltParse(
	errors: { line: number; why: string }[],
	musts: RouteHint[],
	prefer: RouteHint | null,
	tier: string | null,
	fallback: string[] | null,
): DotfileParse {
	if (errors.length) return { ok: false, errors };
	return { ok: true, musts, prefer, tier, fallback };
}

// ─── discovery (git-like upward, repo-root bounded) ────────────────────────
const DOTFILE = ".llm";
const MAX_WALK = 64;

/** Nearest .llm upward from startDir, stopping at the repo root. */
export function findLlmDotfile(startDir: string): string | null {
	let dir = startDir;
	for (let i = 0; i < MAX_WALK; i++) {
		if (existsSync(join(dir, DOTFILE))) return join(dir, DOTFILE);
		if (existsSync(join(dir, ".git"))) return null;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

// ─── the resolution stack (dotfile > user > central > default) ─────────────
export interface CentralLaw {
	id: string;
	laws: string[];
}

/** Resolve the full law stack for a repo — dotfile (git-like discovery),
 *  user config (repo-laws.json entry, exact root match), central (the W154
 *  manifest's kind=repo-law rules from the LAST-KNOWN cache; the hub is
 *  never called at route time). */
export function resolveLawStack(
	repo: string,
	env: NodeJS.ProcessEnv = {},
): LawStack {
	const dotPath = findLlmDotfile(repo);
	const dotText = dotPath === null ? null : readFileSync(dotPath, "utf8");
	const user = readUserRepoLaws(repo, env);
	const central = readCentralRepoLaws(repo, env);
	const layers: string[] = [];
	if (dotText !== null) layers.push("dotfile");
	if (user !== null) layers.push("user");
	if (central.length > 0) layers.push("central");
	return {
		repo,
		dotfile: dotText === null ? null : parseLlmDotfile(dotText),
		user: user === null ? null : parseLlmDotfile(user),
		central,
		company: central.length > 0,
		layers,
	};
}

/** User config: <home>/.claude/local-llm/repo-laws.json — {repos: {<abs
 *  root>: {name, dotfile, source, updated_at}}} — the console's mirror
 *  store (the reconciliation target). Exact-root match; broken file = no
 *  user layer (defaults govern), never a throw. */
export function readUserRepoLaws(
	repo: string,
	env: NodeJS.ProcessEnv = {},
): string | null {
	const home = env.BUCKLE_SECRETS_HOME ?? `${env.HOME ?? ""}/.claude/local-llm`;
	const p = join(home, "repo-laws.json");
	if (!existsSync(p)) return null;
	try {
		const doc = JSON.parse(readFileSync(p, "utf8")) as {
			repos?: Record<string, { dotfile?: string }>;
		};
		const e = doc.repos?.[repo];
		return e === undefined ? null : (e.dotfile ?? null);
	} catch {
		return null;
	}
}

/** Central layer: the W154 manifest's last-known rules[] — kind
 *  "repo-law", shape {id, kind, target, laws[]}; target matches by exact
 *  root, basename, or '*' wildcard; NO match = private repo (hub not
 *  consulted). Broken cache = no central layer, never a throw. */
export function readCentralRepoLaws(
	repo: string,
	env: NodeJS.ProcessEnv = {},
): CentralLaw[] {
	const home = env.BUCKLE_SECRETS_HOME ?? `${env.HOME ?? ""}/.claude/local-llm`;
	const p = join(home, "federation-last-known.json");
	if (!existsSync(p)) return [];
	try {
		const lk = JSON.parse(readFileSync(p, "utf8")) as {
			manifest?: { rules?: Array<Record<string, unknown>> };
		};
		const rules = lk.manifest?.rules;
		if (!Array.isArray(rules)) return [];
		return rules
			.filter(
				(r): r is Record<string, unknown> =>
					typeof r === "object" && r !== null && r.kind === "repo-law",
			)
			.filter((r) =>
				repoMatches(
					r as { id?: unknown; laws?: unknown; target?: unknown },
					repo,
				),
			)
			.map((r) => ({
				id: String(r.id ?? "repo-law"),
				laws: Array.isArray(r.laws)
					? r.laws.filter((x): x is string => typeof x === "string")
					: [],
			}));
	} catch {
		return [];
	}
}

/** Central rule target matching: exact root, basename, or '*' wildcard. */
export function repoMatches(
	rule: { id: string; laws: string[]; target?: unknown },
	repo: string,
): boolean {
	if (rule.target === "*") return true;
	if (typeof rule.target !== "string") return false;
	if (rule.target === repo) return true;
	return rule.target === basename(repo);
}

// ─── compose + apply (musts AND, nearest prefer ranks) ─────────────────────
export interface LawPlan {
	musts: { layer: string; hint: RouteHint }[];
	prefer: { layer: string; hint: RouteHint } | null;
	why: string; // audit trail sentence
}

/** Compose the plan: every layer's musts AND together (central must beats
 *  user prefer structurally — the must filters, the prefer ranks within);
 *  the NEAREST layer carrying a prefer sets the ranking (request hint >
 *  dotfile > user > central). */
export function composeLawPlan(
	stack: LawStack,
	requestHint: RouteHint | null,
): LawPlan {
	const musts: LawPlan["musts"] = [];
	const push = (layer: string, p: DotfileParse): void => {
		if (!p.ok) return; // unparseable layer = honest error below
		for (const m of p.musts) musts.push({ layer, hint: m });
	};
	if (stack.dotfile?.ok === true) push("dotfile", stack.dotfile);
	if (stack.user?.ok === true) push("user", stack.user);
	for (const c of stack.central) {
		const p = parseLlmDotfile(c.laws.join("\n"));
		if (p.ok)
			for (const m of p.musts)
				musts.push({ layer: `central:${c.id}`, hint: m });
	}
	const prefer = firstPrefer(stack, requestHint);
	return { musts, prefer, why: describePlan(musts, prefer, stack) };
}

/** The nearest layer carrying a prefer wins the ranking: request hint >
 *  dotfile > user > central. */
function firstPrefer(
	stack: LawStack,
	requestHint: RouteHint | null,
): LawPlan["prefer"] {
	if (requestHint?.verb === "prefer") {
		return { layer: "request", hint: requestHint };
	}
	if (stack.dotfile?.ok === true && stack.dotfile.prefer !== null)
		return { layer: "dotfile", hint: stack.dotfile.prefer };
	if (stack.user?.ok === true && stack.user.prefer !== null)
		return { layer: "user", hint: stack.user.prefer };
	for (const c of stack.central) {
		const p = parseLlmDotfile(c.laws.join("\n"));
		if (p.ok && p.prefer !== null)
			return { layer: `central:${c.id}`, hint: p.prefer };
	}
	return null;
}

/** One audit sentence naming the layers that contributed. */
function describePlan(
	musts: LawPlan["musts"],
	prefer: LawPlan["prefer"],
	stack: LawStack,
): string {
	if (!musts.length && prefer === null)
		return stack.layers.length
			? `law stack [${stack.layers.join(",")}]: no binding laws — belt default ordering`
			: "no law stack — belt default ordering";
	const m = musts.length
		? musts.map((x) => `${x.layer}:must(${exprOf(x.hint)})`).join(" AND ")
		: "no musts";
	const p =
		prefer === null
			? "no prefer"
			: `${prefer.layer}:prefer(${exprOf(prefer.hint)})`;
	return `law stack [${stack.layers.join(",")}] — ${m}; ranking by ${p}`;
}

function exprOf(h: RouteHint): string {
	const parts: string[] = [];
	if (h.location !== undefined) {
		parts.push(
			"kind" in h.location ? h.location.kind : `host:${h.location.host}`,
		);
	}
	if (h.model !== undefined) parts.push(`model:${h.model}`);
	for (const t of h.tags) parts.push(t);
	return parts.join(" ");
}

// ─── apply (musts filter, prefer ranks; honest at every layer) ────────────
export type LawApplyResult<T> =
	| { ok: true; candidates: T[]; why: string }
	| { ok: false; layer: string; why: string };

/** Apply the plan: every must filters (healthy AND full-fit only); a must
 *  that empties the pool = honest error NAMING THE LAYER. Prefer ranks
 *  within must-fits. */
export function applyLawStack<T extends { healthy: boolean }>(
	pool: T[],
	plan: LawPlan,
	fit: (c: T, h: RouteHint) => number,
	total: (h: RouteHint) => number,
): LawApplyResult<T> {
	let out = pool;
	for (const m of plan.musts) {
		const fits = out.filter(
			(c) => c.healthy && fit(c, m.hint) === total(m.hint),
		);
		if (fits.length === 0)
			return {
				ok: false,
				layer: m.layer,
				why: `${m.layer} must '${exprOf(m.hint)}': no healthy full fit among ${String(pool.length)} candidates — must never substitutes`,
			};
		out = fits;
	}
	if (plan.prefer === null) return { ok: true, candidates: out, why: plan.why };
	const p = plan.prefer;
	out = [...out]
		.map((c) => ({ c, tier: fit(c, p.hint) }))
		.sort((a, b) => b.tier - a.tier)
		.map((x) => x.c);
	return { ok: true, candidates: out, why: plan.why };
}

// ─── BYO user-plane candidates (the spoke menu's user half) ───────────────
export interface UserPlaneCandidate {
	machine: string; // user-<name>
	port: number; // 0 — base-URL endpoints
	model: string;
	protocol: string;
	kind: "remote" | "cloud";
	roles: string[];
	tags: string;
	healthy: boolean;
	estimate_ms: number | null;
	calls: number;
	load_5m: number;
	errors: number;
	last_used: string | null;
	probe_ms: number | null;
	base: string;
	key_name: string | null;
}

/** Probe a user-plane endpoint: ${base}/models, 1200ms cap. */
export async function probeUserPlane(base: string): Promise<boolean> {
	try {
		const r = await fetch(`${base}/models`, {
			signal: AbortSignal.timeout(1200),
		});
		return r.ok;
	} catch {
		return false;
	}
}

/** The user plane's entries → belt candidates. */
export async function userPlaneCandidates(
	env: NodeJS.ProcessEnv = {},
): Promise<UserPlaneCandidate[]> {
	const home = env.BUCKLE_SECRETS_HOME ?? `${env.HOME ?? ""}/.claude/local-llm`;
	const p = join(home, "local-models.json");
	if (!existsSync(p)) return [];
	try {
		const arr: unknown = JSON.parse(readFileSync(p, "utf8"));
		if (!Array.isArray(arr)) return [];
		const out: UserPlaneCandidate[] = [];
		for (const e of arr) {
			out.push(await oneUserCandidate(e));
		}
		return out.filter((c): c is UserPlaneCandidate => c !== null);
	} catch {
		return [];
	}
}

/** One entry → one candidate (probe included). Malformed entries are
 *  skipped — loud entry errors are the console's job; route time never
 *  throws and never guesses. */
async function oneUserCandidate(
	e: unknown,
): Promise<UserPlaneCandidate | null> {
	const o = e as {
		name?: unknown;
		base?: unknown;
		model?: unknown;
		key_name?: unknown;
		roles?: unknown;
	};
	if (typeof o.name !== "string" || typeof o.base !== "string") return null;
	const model = typeof o.model === "string" ? o.model : "";
	const roles = Array.isArray(o.roles)
		? o.roles.filter((x): x is string => typeof x === "string")
		: [];
	const healthy = await probeUserPlane(o.base);
	return candidateOf(o.name, o.base, model, roles, healthy, o.key_name);
}

/** The candidate literal, factored out of the entry walk. */
function candidateOf(
	name: string,
	base: string,
	model: string,
	roles: string[],
	healthy: boolean,
	keyName: unknown,
): UserPlaneCandidate {
	return {
		machine: `user-${name}`,
		port: 0,
		model,
		protocol: "openai",
		kind: base.startsWith("https") ? "cloud" : "remote",
		roles,
		tags: `user-plane ${roles.join(" ")} ${model}`,
		healthy,
		estimate_ms: null,
		calls: 0,
		load_5m: 0,
		errors: 0,
		last_used: null,
		probe_ms: null,
		base,
		key_name: typeof keyName === "string" ? keyName : null,
	};
}

/** Execute one chat call on a user-plane candidate — DIRECT to the base
 *  URL (no gateway: the user plane is sovereign, hub/company infra is not
 *  involved). Bearer key resolved by NAME from the secrets home at call
 *  time; a missing/loose key file is an honest throw the caller renders. */
export async function executeUserPlane(
	c: { base: string; model: string; key_name: string | null },
	body: { messages?: { role: string; content: string }[] },
	env: NodeJS.ProcessEnv = {},
): Promise<string> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (c.key_name !== null) {
		const k = readUserKeyFile(c.key_name, env);
		if (k !== null) headers.authorization = `Bearer ${k}`;
		else
			throw new Error(`user-plane key '${c.key_name}' missing or not mode 600`);
	}
	const r = await fetch(`${c.base}/chat/completions`, {
		method: "POST",
		headers,
		body: JSON.stringify({ model: c.model, messages: body.messages ?? [] }),
		signal: AbortSignal.timeout(120_000),
	});
	if (!r.ok)
		throw new Error(`HTTP ${String(r.status)} from user-plane ${c.base}`);
	const j = (await r.json()) as {
		choices?: { message?: { content?: string } }[];
	};
	return j.choices?.[0]?.message?.content ?? "(empty response)";
}

/** Key file read with the mode law (parity with the console side). */
function readUserKeyFile(name: string, env: NodeJS.ProcessEnv): string | null {
	const p = join(
		env.BUCKLE_SECRETS_HOME ?? `${env.HOME ?? ""}/.claude/local-llm`,
		"keys",
		name,
	);
	if (!existsSync(p)) return null;
	const st = statSync(p);
	if ((st.mode & 0o777) !== 0o600) return null;
	return readFileSync(p, "utf8").trim();
}
