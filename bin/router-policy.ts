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
}

interface PolicyDoc {
	version?: number;
	gateway?: GatewayPolicy;
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
	return { ...DEFAULTS, ...(doc.gateway ?? {}) };
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

// ─── direct-tier bypass (W270) ───
// Bench 2026-10-02 (REPORT.md, n=12, speed STRONG): stack-engine-local vs
// local-direct = 1.35-3.92× wall, +0.5-2.2 s TTFT per call — the LiteLLM
// proxy hop itself (Python request path + latency-based-routing bookkeeping),
// not belt code. Hot local classes therefore skip :4100 and hit the
// specialist port directly; the gateway keeps cloud ladders + fallbacks.
// Policy data lives in routing-policy.yaml `direct:` (alias → base URL).

export type DirectTiers = Record<string, string>;

const LOOPBACK =
	/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}(\/v1)?\/?$/;

/** Parse the `direct:` section. Only loopback http bases are accepted — a
 *  bypass skips the gateway's auth + accounting, so it must stay on-box. */
export function parseDirect(text: string): DirectTiers {
	const doc = YAML.parse(text) as { direct?: Record<string, unknown> };
	const out: DirectTiers = {};
	for (const [alias, base] of Object.entries(doc.direct ?? {})) {
		if (typeof base !== "string" || !LOOPBACK.test(base))
			throw new Error(
				`router-policy: direct.${alias} must be a loopback http base, got ${JSON.stringify(base)}`,
			);
		out[alias] = base.replace(/\/$/, "").replace(/(\/v1)?$/, "/v1");
	}
	return out;
}

export function loadDirectTiers(explicitPath?: string): DirectTiers {
	const candidates = [
		explicitPath,
		process.env.BELT_POLICY,
		`${process.env.HOME}/.claude/local-llm/routing-policy.yaml`,
		new URL("./routing-policy.yaml", import.meta.url).pathname,
	].filter((p): p is string => typeof p === "string" && p.length > 0);
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		return parseDirect(readFileSync(p, "utf8"));
	}
	return {};
}

/** Where an OpenAI-wire client should send `model`: the specialist port for
 *  a direct tier, else the gateway. */
export function resolveTarget(
	model: string,
	gatewayBase: string,
	direct: DirectTiers = loadDirectTiers(),
): { base: string; direct: boolean } {
	const d = direct[model];
	return d ? { base: d, direct: true } : { base: gatewayBase, direct: false };
}
