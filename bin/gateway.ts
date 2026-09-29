// bin/gateway.ts — launchd wrapper for the LiteLLM gateway. Keeps secrets
// out of the plist: reads Z_AI_API_KEY from ~/.claude.json at spawn time and
// execs the uv-installed litellm with the generated config. LITELLM_KEY
// (proxy master key) is read from ~/.claude/local-llm/litellm.key.
import { readFileSync } from "node:fs";

const HOME = process.env.HOME ?? "/Users/kk";
const cfg = JSON.parse(readFileSync(`${HOME}/.claude.json`, "utf8")) as Record<
	string,
	unknown
>;
let zaiKey: string | undefined;
const walk = (o: unknown): void => {
	for (const [k, v] of Object.entries(o ?? {})) {
		if (k === "Z_AI_API_KEY" && typeof v === "string") zaiKey = v;
		else if (v && typeof v === "object") walk(v);
	}
};
walk(cfg);
if (!zaiKey) {
	console.error("[gateway] Z_AI_API_KEY not found in ~/.claude.json — exiting");
	process.exit(1);
}
const masterKey = readFileSync(
	`${HOME}/.claude/local-llm/litellm.key`,
	"utf8",
).trim();

const child = Bun.spawn({
	cmd: [
		`${HOME}/.local/bin/litellm`,
		"--config",
		`${HOME}/.claude/local-llm/litellm.yaml`,
		"--port",
		"4100",
	],
	env: { ...process.env, Z_AI_API_KEY: zaiKey, LITELLM_KEY: masterKey },
	stdout: "inherit",
	stderr: "inherit",
});
process.on("SIGTERM", () => child.kill());
await child.exited;
