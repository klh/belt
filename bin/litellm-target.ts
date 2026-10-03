// litellm-target.ts — the :4100 LiteLLM engine as an OWNED supervisor target
// (W277). Before this it ran under gateway.ts / com.belt.gateway, outside the
// supervisor: no backoff, no breaker, no status. That plist must stay unloaded
// now — the supervisor is the single restarter for :4100.
//
// Secrets: Z_AI_API_KEY + LITELLM_KEY are resolved at SPAWN time — the
// inherited env wins, else the 0600 files (~/.config/zai/config.json apiKey,
// ~/.claude/local-llm/litellm.key). litellm.yaml references them as
// os.environ/… so key values never appear in code, argv, logs or status.
//
// Liveness: GET /v1/models with the master key. 200 = serving + authorized,
// 401 = serving (endpoint alive, key mismatch); anything else = not serving.
//
// Preflight: `prisma` must import in the litellm uv tool env (the 2026-10-03
// root cause). Missing → log + alert status. Never auto-installed in-process.

import { openSync, readFileSync } from "node:fs";
import type { Child, Target } from "./supervisor.ts";

const HOME = process.env.HOME ?? "";

export const LITELLM_PORT = 4100;
export const LITELLM_OK_STATUS = [200, 401];

export interface LitellmPaths {
	bin: string;
	python: string;
	config: string;
	zaiConfig: string;
	masterKeyFile: string;
	log: string;
}

export const DEFAULT_PATHS: LitellmPaths = {
	bin: `${HOME}/.local/bin/litellm`,
	python: `${HOME}/.local/share/uv/tools/litellm/bin/python`,
	config: `${HOME}/.claude/local-llm/litellm.yaml`,
	zaiConfig: `${HOME}/.config/zai/config.json`,
	masterKeyFile: `${HOME}/.claude/local-llm/litellm.key`,
	log: `${HOME}/.claude/local-llm/litellm-gateway.log`,
};

export interface LitellmKeys {
	Z_AI_API_KEY: string;
	LITELLM_KEY: string;
}

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => string;

const readText: ReadFile = (path) => readFileSync(path, "utf8");

const tryRead = (read: ReadFile, path: string): string | null => {
	try {
		return read(path);
	} catch {
		return null;
	}
};

function zaiKeyFromFile(read: ReadFile, path: string): string | null {
	const raw = tryRead(read, path);
	if (!raw) return null;
	try {
		const key = (JSON.parse(raw) as { apiKey?: unknown }).apiKey;
		return typeof key === "string" && key.trim() ? key.trim() : null;
	} catch {
		return null;
	}
}

/** Env first, then the 0600 files. Throws naming the SOURCE, never a value. */
export function loadKeys(
	paths: LitellmPaths = DEFAULT_PATHS,
	env: Env = process.env,
	read: ReadFile = readText,
): LitellmKeys {
	const zai = env.Z_AI_API_KEY || zaiKeyFromFile(read, paths.zaiConfig);
	const master =
		env.LITELLM_KEY || tryRead(read, paths.masterKeyFile)?.trim() || null;
	const missing: string[] = [];
	if (!zai) missing.push(`Z_AI_API_KEY (env or ${paths.zaiConfig} apiKey)`);
	if (!master) missing.push(`LITELLM_KEY (env or ${paths.masterKeyFile})`);
	if (!zai || !master) throw new Error(`missing ${missing.join(", ")}`);
	return { Z_AI_API_KEY: zai, LITELLM_KEY: master };
}

export const litellmArgv = (
	paths: LitellmPaths = DEFAULT_PATHS,
	port = LITELLM_PORT,
): string[] => [paths.bin, "--config", paths.config, "--port", String(port)];

/** null = prisma importable; otherwise the alert reason. */
export function prismaPreflight(python = DEFAULT_PATHS.python): string | null {
	const fix = "fix: uv tool install --force --with prisma litellm[proxy]";
	try {
		const r = Bun.spawnSync([python, "-c", "import prisma"], {
			stdout: "ignore",
			stderr: "pipe",
		});
		if (r.exitCode === 0) return null;
		const tail = r.stderr.toString().trim().split("\n").pop() ?? "";
		return `prisma not importable in litellm tool env (${tail}) — ${fix}`;
	} catch (e) {
		return `litellm tool python unusable at ${python} (${String(e)}) — ${fix}`;
	}
}

export interface LitellmTargetDeps {
	paths?: LitellmPaths;
	port?: number;
	env?: Env;
	read?: ReadFile;
	/** Override the server argv (tests run a stub on a free port). */
	argv?: string[];
	preflight?: () => string | null;
}

export function litellmTarget(deps: LitellmTargetDeps = {}): Target {
	const paths = deps.paths ?? DEFAULT_PATHS;
	const port = deps.port ?? LITELLM_PORT;
	const env = deps.env ?? process.env;
	const read = deps.read ?? readText;
	return {
		name: "litellm",
		port,
		kind: "gateway",
		owned: true,
		healthPath: "/v1/models",
		okStatus: LITELLM_OK_STATUS,
		probeHeaders: () => {
			try {
				const { LITELLM_KEY } = loadKeys(paths, env, read);
				return { Authorization: `Bearer ${LITELLM_KEY}` };
			} catch {
				return {}; // unauthenticated probe: 401 still proves liveness
			}
		},
		// litellm can wedge with the port bound — restart after hungThreshold.
		killHung: true,
		bindTimeoutMs: 120_000,
		preflight: deps.preflight ?? (() => prismaPreflight(paths.python)),
		spawn: (): Child => {
			const keys = loadKeys(paths, env, read);
			const fd = openSync(paths.log, "a");
			return Bun.spawn(deps.argv ?? litellmArgv(paths, port), {
				stdin: "ignore",
				stdout: fd,
				stderr: fd,
				env: { ...env, ...keys },
			});
		},
	};
}
