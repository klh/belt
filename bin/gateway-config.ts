// bin/gateway-config.ts — generate the LiteLLM gateway config from belt's runtime
// config + live local ports (single source of truth: remotes.json; local ids
// discovered from each port's /v1/models, never invented). Output is PRIVATE:
// ~/.claude/local-llm/litellm.yaml (mode 600 — carries the zai key reference,
// resolved at runtime via os.environ/Z_AI_API_KEY, never inline).
import { readFileSync } from "node:fs";
import {
	applyExecutorPolicy,
	emitRouterSettings,
	loadGatewayPolicy,
	pruneFallbacks,
} from "./router-policy.ts";
import { buildRemoteEntries } from "./remotes-validate.ts";

const HOME = process.env.HOME ?? "/Users/kk";
const REMOTES_PATH = `${HOME}/.claude/local-llm/remotes.json`;

// W192: remotes.json is parsed but NEVER trusted — grammar validation and
// entry building live in remotes-validate.ts. Unparseable config aborts the
// regen loudly (the last good litellm.yaml stays); per-entry validation
// failures are skipped + warned on stderr below.
let remotesRaw: unknown;
try {
	remotesRaw = JSON.parse(readFileSync(REMOTES_PATH, "utf8"));
} catch (err) {
	console.error(
		`gateway-config: ${REMOTES_PATH} unreadable or invalid JSON — not writing litellm.yaml (${err instanceof Error ? err.message : String(err)})`,
	);
	process.exit(1);
}

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
// Remote tiers: validated + built by remotes-validate (W192) — invalid
// machines/endpoints are skipped + warned on stderr, never interpolated.
const remotesBuilt = buildRemoteEntries(remotesRaw);
for (const s of remotesBuilt.skipped)
	console.error(`gateway-config: skipped ${s.ref}: ${s.why}`);
entries.push(...remotesBuilt.entries);

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
// W201 executor policy: the deny-list in bin/routing-policy.yaml drops
// cloud-tier model_list entries by model-name match (claude* → claude,
// gpt* → openai, glm* → zai); local-tier entries are executor "local" by
// construction and stay. Ladders prune to the survivors at regen.
const policy = loadGatewayPolicy();
const anthFiltered = applyExecutorPolicy(anth, policy);
for (const n of anthFiltered.dropped)
	console.error(`gateway-config: executor policy drops ${n}`);
const anthEntries = anthFiltered.kept
	.map(
		(a) =>
			`  - model_name: ${a.name}\n` +
			`    litellm_params:\n` +
			`      model: ${a.model}\n` +
			`      api_base: ${a.base}\n` +
			`      api_key: ${a.key}`,
	)
	.join("\n");

// W201: the full surviving model_list — ladders prune against ALL of it
// (locals + remotes + filtered cloud tier).
const aliveNames = new Set<string>();
for (const [port, alias] of LOCAL_PORTS)
	if (discovered.some((d) => d.port === port)) aliveNames.add(alias);
for (const e of remotesBuilt.entries) {
	const m = /^ {2}- model_name: (\S+)/.exec(e);
	if (m?.[1]) aliveNames.add(m[1]);
}
for (const a of anthFiltered.kept) aliveNames.add(a.name);
// Router policy (fallbacks, retries, cooldowns) comes from
// bin/routing-policy.yaml — owner directives 2026-10-01: flash →
// local(:4000) → OpenAI → Anthropic, never flashx; operators edit the YAML,
// never code. Activation BETWEEN fan-outs (a reload drops in-flight streams):
//   bun bin/gateway-config.ts && launchctl kickstart -k gui/$(id -u)/com.belt.gateway
const fullYaml =
	`# GENERATED by belt gateway tooling (${new Date().toISOString()}) — do not edit by hand.\n` +
	`# PRIVATE: lives in ~/.claude/local-llm/, never committed.\n` +
	`model_list:\n${entries.join("\n")}\n${anthEntries}\n\n` +
	emitRouterSettings(pruneFallbacks(policy, aliveNames)) +
	`general_settings:\n  master_key: os.environ/LITELLM_KEY\n`;
const out = `${HOME}/.claude/local-llm/litellm.yaml`;
await Bun.write(out, fullYaml);
console.log(
	`wrote ${out}: ${entries.length} models — ${discovered.map((d) => `${d.port}=${d.id.slice(13, 40)}`).join(", ")}`,
);
