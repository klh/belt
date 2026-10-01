// bin/gateway-config.ts — generate the LiteLLM gateway config from belt's runtime
// config + live local ports (single source of truth: remotes.json; local ids
// discovered from each port's /v1/models, never invented). Output is PRIVATE:
// ~/.claude/local-llm/litellm.yaml (mode 600 — carries the zai key reference,
// resolved at runtime via os.environ/Z_AI_API_KEY, never inline).
import { readFileSync } from "node:fs";
import { emitRouterSettings, loadGatewayPolicy } from "./router-policy.ts";

const HOME = process.env.HOME ?? "/Users/kk";
const remotes = JSON.parse(
	readFileSync(`${HOME}/.claude/local-llm/remotes.json`, "utf8"),
) as {
	machines: {
		name: string;
		cloud?: boolean;
		endpoints: {
			port: number;
			protocol: string;
			roles: string[];
			model?: string;
			base?: string;
			tls?: boolean;
		}[];
	}[];
};

const LOCAL_PORTS: [number, string, string][] = [
	// port, belt-facing alias, role note — reranker (:8913) excluded: rerank
	// API, not chat; :4000 shim excluded: it is Anthropic INGRESS for Claude
	[8901, "local-coder", "code generation, multi-file edits, refactors"],
	[8902, "local-extract", "menial extraction, short drafts, cheap tasks"],
	[8903, "local-reason", "reasoning, planning, hard problems"],
	[8906, "local-general", "general, Danish, multilingual"],
];

const discovered: { port: number; id: string }[] = [];
for (const [port] of LOCAL_PORTS) {
	const r = await fetch(`http://127.0.0.1:${port}/v1/models`).then((x) =>
		x.json(),
	);
	discovered.push({ port, id: r.data[0].id });
}

const entries: string[] = [];
for (const [port, alias] of LOCAL_PORTS) {
	const id = discovered.find((d) => d.port === port)?.id;
	if (!id) continue;
	entries.push(
		`  - model_name: ${alias}\n` +
			`    litellm_params:\n` +
			`      model: openai/${id}\n` +
			`      api_base: http://127.0.0.1:${port}/v1\n` +
			`      api_key: local`,
	);
}
for (const m of remotes.machines) {
	for (const ep of m.endpoints) {
		if (ep.protocol !== "openai" || !ep.model) continue;
		if (ep.base) {
			entries.push(
				`  - model_name: ${m.name}-${ep.model.replace(/[^a-zA-Z0-9.-]/g, "-")}\n` +
					`    litellm_params:\n` +
					`      model: openai/${ep.model}\n` +
					`      api_base: ${ep.base}\n` +
					`      api_key: os.environ/Z_AI_API_KEY`,
			);
		} else {
			entries.push(
				`  - model_name: ${m.name}-${ep.model.replace(/[^a-zA-Z0-9.-]/g, "-")}\n` +
					`    litellm_params:\n` +
					`      model: openai/${ep.model}\n` +
					`      api_base: http://${m.host}:${ep.port}/v1` +
					(m.cloud ? "" : "\n      api_key: dummy"),
			);
		}
	}
}

// (openai-dialect draft above is superseded by fullYaml — kept variables
// merged there; this block intentionally removed)

// Anthropic-dialect upstreams — the Claude-Code drop-in path. model_name
// MUST equal the id Claude sends verbatim ([1m] included). z.ai anthropic
// endpoint is keyed today; api.anthropic.com activates when ANTHROPIC_API_KEY
// lands. Appended AFTER the yaml build above? No — rebuild with both lists:
const anth = [
	// [1m] never hits the wire — Claude Code strips it client-side as a
	// context hint; the wire id is bare (proven: [1m] 1211s on z.ai directly,
	// bare id works). Same model_name as the openai-dialect entries = one
	// group, two dialects; LiteLLM load-balances/fallbacks across them.
	{
		name: "glm-5.3-flash",
		model: "anthropic/glm-5.3-flash",
		base: "https://api.z.ai/api/anthropic",
		key: "os.environ/Z_AI_API_KEY",
	},
	{
		name: "glm-5.3",
		model: "anthropic/glm-5.3",
		base: "https://api.z.ai/api/anthropic",
		key: "os.environ/Z_AI_API_KEY",
	},
	{
		name: "glm-5.2",
		model: "anthropic/glm-5.2",
		base: "https://api.z.ai/api/anthropic",
		key: "os.environ/Z_AI_API_KEY",
	},
	{
		name: "claude-sonnet-5",
		model: "anthropic/claude-sonnet-5",
		base: "https://api.anthropic.com",
		key: "os.environ/ANTHROPIC_API_KEY",
	},
	{
		name: "claude-haiku-4-5",
		model: "anthropic/claude-haiku-4-5",
		base: "https://api.anthropic.com",
		key: "os.environ/ANTHROPIC_API_KEY",
	},
	{
		// Degradation tier: the local swarm ingress (:4000). LiteLLM POSTs
		// Anthropic-shape requests to any base — the shim accepts glm ids and
		// routes by complexity (audit row: anthropic/<name> + api_base).
		name: "local-swarm",
		model: "anthropic/local-swarm",
		base: "http://127.0.0.1:4000",
		key: "dummy",
	},
	{
		// Dormant until OPENAI_API_KEY lands; ladder falls through a group
		// whose upstream fails, so the empty key just skips this tier.
		name: "gpt-5.2",
		model: "openai/gpt-5.2",
		base: "https://api.openai.com/v1",
		key: "os.environ/OPENAI_API_KEY",
	},
];
const anthEntries = anth
	.map(
		(a) =>
			`  - model_name: ${a.name}\n` +
			`    litellm_params:\n` +
			`      model: ${a.model}\n` +
			`      api_base: ${a.base}\n` +
			`      api_key: ${a.key}`,
	)
	.join("\n");
// Router policy (fallbacks, retries, cooldowns) comes from
// bin/routing-policy.yaml — owner directives 2026-10-01: flash →
// local(:4000) → OpenAI → Anthropic, never flashx; operators edit the YAML,
// never code. Activation BETWEEN fan-outs (a reload drops in-flight streams):
//   bun bin/gateway-config.ts && launchctl kickstart -k gui/$(id -u)/com.belt.gateway
const fullYaml =
	`# GENERATED by belt gateway tooling (${new Date().toISOString()}) — do not edit by hand.\n` +
	`# PRIVATE: lives in ~/.claude/local-llm/, never committed.\n` +
	`model_list:\n${entries.join("\n")}\n${anthEntries}\n\n` +
	emitRouterSettings(loadGatewayPolicy()) +
	`general_settings:\n  master_key: os.environ/LITELLM_KEY\n`;
const out = `${HOME}/.claude/local-llm/litellm.yaml`;
await Bun.write(out, fullYaml);
console.log(
	`wrote ${out}: ${entries.length} models — ${discovered.map((d) => `${d.port}=${d.id.slice(13, 40)}`).join(", ")}`,
);
