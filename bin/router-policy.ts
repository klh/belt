// bin/router-policy.ts — load + emit belt's LiteLLM routing policy. The
// single config source is bin/routing-policy.yaml (committed default); a
// runtime copy at ~/.claude/local-llm/routing-policy.yaml overrides it, and
// BELT_POLICY overrides both. bin/gateway-config.ts emits the `gateway`
// section verbatim as LiteLLM router_settings into the private litellm.yaml.
//
// Everything the policy expresses is NATIVE LiteLLM 1.103.0 router behavior
// (pinned-source verified, W126 audit docs/research/
// litellm-enterprise-audit-2026-10-01.md): fallbacks = ordered cross-group
// ladders tried after num_retries; allowed_fails + cooldown_time = passive
// outlier ejection; num_retries = per-call retries whose backoff honors the
// upstream retry-after header with jitter (utils.py::_calculate_retry_after).
// Owner directives 2026-10-01: ladder flash → local(:4000) → OpenAI →
// Anthropic, never flashx; operators edit the YAML, never code.
import { YAML } from "bun";
import { existsSync, readFileSync } from "node:fs";

export interface GatewayPolicy {
	num_retries?: number;
	allowed_fails?: number;
	cooldown_time?: number;
	fallbacks?: Record<string, string[]>;
	executor_policy: { disabled_executors: string[] };
}

interface PolicyDoc {
	version?: number;
	gateway?: GatewayPolicy;
	executor_policy?: { disabled_executors?: string[] };
}

/** Native-free defaults; the committed YAML carries the same values. */
const DEFAULTS: Required<Omit<GatewayPolicy, "fallbacks">> = {
	num_retries: 1,
	allowed_fails: 3,
	cooldown_time: 30,
};

/** Parse a policy document (tests + loader share this path). */
export function parsePolicy(text: string): GatewayPolicy {
	const doc = YAML.parse(text) as PolicyDoc;
	return {
		...DEFAULTS,
		...(doc.gateway ?? {}),
		executor_policy: {
			disabled_executors: (doc.executor_policy?.disabled_executors ?? []).map(
				(s) => s.toLowerCase(),
			),
		},
	};
}

/** Resolution order: explicit path → BELT_POLICY → runtime copy in the
 *  local-llm dir → the committed default in bin/. */
export function loadGatewayPolicy(explicitPath?: string): GatewayPolicy {
	const candidates = [
		explicitPath,
		process.env.BELT_POLICY,
		`${process.env.HOME}/.claude/local-llm/routing-policy.yaml`,
		new URL("./routing-policy.yaml", import.meta.url).pathname,
	].filter((p): p is string => typeof p === "string" && p.length > 0);
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		return parsePolicy(readFileSync(p, "utf8"));
	}
	throw new Error(
		"router-policy: no routing-policy.yaml (BELT_POLICY, ~/.claude/local-llm/, bin/)",
	);
}

/** Emit the router_settings YAML block (newline-terminated, LiteLLM
 *  semantics: in-order fallback ladders after num_retries, allowed_fails +
 *  cooldown as passive outlier ejection). */
export function emitRouterSettings(p: GatewayPolicy): string {
	const fallbackLines = Object.entries(p.fallbacks ?? {})
		.map(([group, list]) => `    - ${group}: [${(list ?? []).join(", ")}]`)
		.join("\n");
	return (
		"router_settings:\n" +
		"  routing_strategy: latency-based-routing\n" +
		`  num_retries: ${p.num_retries}\n` +
		`  allowed_fails: ${p.allowed_fails}\n` +
		`  cooldown_time: ${p.cooldown_time}\n` +
		(fallbackLines ? `  fallbacks:\n${fallbackLines}\n` : "")
	);
}

// ─── W201 executor policy — model-list matching + ladder coherence ────────
/** Attribute a model_name to its executor by prefix — the same matching the
 *  :4100 model_list itself uses. claude* → claude, gpt* → openai, glm* →
 *  zai; everything else (local MLX ports, LAN remotes, local-swarm) is
 *  local-executor by construction. */
export function executorOfModelName(name: string): string {
	const n = name.toLowerCase();
	if (n.startsWith("claude")) return "claude";
	if (n.startsWith("gpt")) return "openai";
	if (n.startsWith("glm")) return "zai";
	return "local";
}

/** Drop entries whose executor is disabled by the policy; the dropped names
 *  come back for stderr logging + ladder pruning. */
export function applyExecutorPolicy<T extends { name: string }>(
	entries: T[],
	policy: GatewayPolicy,
): { kept: T[]; dropped: string[] } {
	const disabled = new Set(policy.executor_policy.disabled_executors);
	const kept: T[] = [];
	const dropped: string[] = [];
	for (const e of entries) {
		if (disabled.has(executorOfModelName(e.name))) dropped.push(e.name);
		else kept.push(e);
	}
	return { kept, dropped };
}

/** Keep the emitted ladders coherent with the surviving model_list: rungs
 *  referencing dropped names vanish; a dropped group head kills its whole
 *  ladder line (an emptied line drops entirely). */
export function pruneFallbacks(
	policy: GatewayPolicy,
	alive: Set<string>,
): GatewayPolicy {
	const fb = policy.fallbacks;
	if (!fb) return policy;
	const fallbacks: Record<string, string[]> = {};
	for (const [head, rungs] of Object.entries(fb)) {
		if (!alive.has(head)) continue;
		const kept = rungs.filter((r) => alive.has(r));
		if (kept.length === 0) continue;
		fallbacks[head] = kept;
	}
	return { ...policy, fallbacks };
}
