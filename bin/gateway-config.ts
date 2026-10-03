// bin/gateway-config.ts — generate the LiteLLM gateway config from belt's
// registry (local tiers: bin/registry.ts via registry-emit) + remotes.json
// (remote tiers). Output is PRIVATE:
// ~/.claude/local-llm/litellm.yaml (mode 600 — carries the zai key reference,
// resolved at runtime via os.environ/Z_AI_API_KEY, never inline).
import { readFileSync } from "node:fs";
import {
	emitRouterSettings,
	loadDirectTiers,
	loadGatewayPolicy,
} from "./router-policy.ts";
import { buildRemoteEntries } from "./remotes-validate.ts";
import { chatEntries } from "./registry.ts";
import { litellmRows } from "./registry-emit.ts";

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

// W271: local tiers are GENERATED from the registry (bin/registry.ts) — the
// one place an LLM is registered. Chat-class rows only (reranker / embed /
// classify speak other APIs; the :4000 shim is Anthropic INGRESS for Claude).
// A best-effort live probe warns on registry↔served drift, never decides.
const locals = chatEntries();
const discovered: { port: number; id: string }[] = [];
for (const e of locals) {
	try {
		const r = (await fetch(`http://127.0.0.1:${e.port}/v1/models`, {
			signal: AbortSignal.timeout(2000),
		}).then((x) => x.json())) as { data?: { id?: string }[] };
		const id = r.data?.[0]?.id;
		if (id) discovered.push({ port: e.port, id });
		if (id && id !== e.model)
			console.error(
				`gateway-config: drift :${e.port} serves ${id}, registry says ${e.model}`,
			);
	} catch {
		console.error(
			`gateway-config: :${e.port} not answering (registry row kept)`,
		);
	}
}

const entries: string[] = litellmRows(locals);
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
	`wrote ${out}: ${locals.length} local + ${remotesBuilt.entries.length} remote models — live ${discovered.map((d) => `${d.port}=${d.id.slice(13, 40)}`).join(", ")}`,
);
// W270 direct-tier bypass map for non-TS clients (TS uses resolveTarget()).
const directOut = `${HOME}/.claude/local-llm/direct-tiers.json`;
await Bun.write(directOut, `${JSON.stringify(loadDirectTiers(), null, 2)}\n`);
console.log(`wrote ${directOut}`);
