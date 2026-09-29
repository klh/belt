// bin/remotes.ts — remote LLM providers: belt's multi-machine layer.
//
// Two configuration sources (owner directive 2026-09-29):
//   1. STATIC — hard config like the Immich entry: a JSON file at
//      ~/.claude/local-llm/remotes.json (runtime dir, NEVER committed —
//      real hosts/IPs stay local). The repo ships remotes.example.json.
//   2. DYNAMIC — DNS-SD advertisement browse (service type _klh-llm._tcp):
//      linux providers advertise via avahi, macOS via dns-sd. A discovered
//      endpoint is probed for protocol (openai / llama.cpp / immich) before
//      it is trusted.
//
// DNS FIRST, IP as fallback (owner directive): every health check resolves
// the configured hostname; the static ip_fallback is used only when
// resolution fails. Liveness = periodic ping; last state cached.
//
// CLI: list | check | route <role> <prompt> | watch --every <s>
//   route  = the multi-machine proof: send one task to a remote provider
//            and report the result back when done.
import { existsSync, readFileSync } from "node:fs";

const RUNTIME = `${process.env.HOME}/.claude/local-llm`;
const STATIC_PATH = `${RUNTIME}/remotes.json`;
const SERVICE_TYPE = "_klh-llm._tcp";

export interface RemoteEndpoint {
	port: number;
	// openai = /v1/chat/completions + /v1/models; llama = llama.cpp server
	// (/health, /props, /v1/...); immich = Immich ML (/predict form-encoded).
	protocol: "openai" | "llama" | "immich";
	roles: string[]; // routing roles this endpoint serves (code/extract/...)
	model?: string; // openai-protocol model id, if the provider needs one
}

export interface RemoteMachine {
	name: string;
	host: string; // DNS name — resolved FIRST on every health check
	ip_fallback?: string; // used only when DNS resolution fails
	mac?: string; // WoL target — the NAS hibernates; ARP answers, TCP silent
	endpoints: RemoteEndpoint[];
}

export interface RemoteState {
	last_ok?: number;
	last_error?: string;
	resolved_ip?: string;
}

export type RemoteProvider = RemoteMachine & { state: RemoteState };

const states = new Map<string, RemoteState>();
const stateFor = (name: string): RemoteState => {
	if (!states.has(name)) states.set(name, {});
	return states.get(name) as RemoteState;
};

export function loadStatic(): RemoteMachine[] {
	if (!existsSync(STATIC_PATH)) return [];
	try {
		const parsed = JSON.parse(readFileSync(STATIC_PATH, "utf8")) as {
			machines?: RemoteMachine[];
		};
		return parsed.machines ?? [];
	} catch {
		console.error(
			`remotes: ${STATIC_PATH} is not valid JSON — run: bun remotes.ts check`,
		);
		return [];
	}
}

/** DNS first, IP fallback — resolves via the system resolver (mDNS names
 *  like foo.local work too). Returns null when both fail. */
export function resolveHost(machine: RemoteMachine): string | null {
	const look = (host: string): string | null => {
		try {
			const r = Bun.spawnSync([
				"/usr/bin/dscacheutil",
				"-q",
				"host",
				"-a",
				"name",
				host,
			]);
			const out = r.stdout.toString();
			const ip = out.split("\n").find((l) => l.startsWith("ip_address:"));
			return ip ? (ip.split(" ")[1] ?? "").trim() || null : null;
		} catch {
			return null;
		}
	};
	if (!machine.host) return null;
	const ip = look(machine.host);
	if (ip) {
		stateFor(machine.name).resolved_ip = ip;
		return ip;
	}
	if (machine.ip_fallback) {
		stateFor(machine.name).resolved_ip = machine.ip_fallback;
		return machine.ip_fallback;
	}
	return null;
}

/** Protocol-aware health probe: openai → GET /v1/models; llama → GET
 *  /health; immich → GET /predict. Any HTTP answer = alive; only transport
 *  failure = dead. */
export async function probeEndpoint(
	machine: RemoteMachine,
	ep: RemoteEndpoint,
): Promise<boolean> {
	const ip = resolveHost(machine);
	if (!ip) return false;
	const path =
		ep.protocol === "openai"
			? "/v1/models"
			: ep.protocol === "llama"
				? "/health"
				: "/predict";
	try {
		const r = await fetch(`http://${ip}:${ep.port}${path}`, {
			signal: AbortSignal.timeout(4000),
		});
		return r.status < 600;
	} catch {
		return false;
	}
}

/** One health pass over every static machine's endpoints. DNS first, IP
 *  fallback; updates cached liveness state and returns a report. */
export async function checkAll(): Promise<
	{ machine: string; port: number; ok: boolean; ip?: string }[]
> {
	const rows: {
		machine: string;
		port: number;
		ok: boolean;
		ip?: string;
	}[] = [];
	for (const m of loadStatic()) {
		for (const ep of m.endpoints) {
			const ok = await probeEndpoint(m, ep);
			const st = stateFor(m.name);
			if (ok) st.last_ok = Date.now();
			else st.last_error = new Date().toISOString();
			rows.push({ machine: m.name, port: ep.port, ok, ip: st.resolved_ip });
		}
	}
	return rows;
}

/** DNS-SD advertisement browse for _klh-llm._tcp (avahi on linux publishes,
 *  dns-sd on macOS browses). Raw entries only — probe before trust. */
export function discover(): { name: string; host: string; port: number }[] {
	const found: { name: string; host: string; port: number }[] = [];
	try {
		const p = Bun.spawnSync(["/usr/bin/dns-sd", "-B", SERVICE_TYPE, "local."], {
			timeout: 3000,
		});
		for (const line of p.stdout.toString().split("\n")) {
			const m = line.match(/(\S+)\._klh-llm\._tcp\.?/);
			if (m?.[1]) found.push({ name: m[1], host: `${m[1]}.local`, port: 0 });
		}
	} catch {
		// no dns-sd or browse timeout — dynamic layer simply empty
	}
	return found;
}

/** Send one task to a remote openai-protocol endpoint; resolves with the
 *  answer when done — the report-back. Long timeout for slow NAS CPUs. */
export async function routeTask(
	machine: RemoteMachine,
	ep: RemoteEndpoint,
	prompt: string,
): Promise<string> {
	const ip = resolveHost(machine);
	if (!ip) throw new Error(`cannot resolve ${machine.host}`);
	const r = await fetch(`http://${ip}:${ep.port}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: ep.model ?? "default",
			messages: [{ role: "user", content: prompt }],
		}),
		signal: AbortSignal.timeout(600_000),
	});
	if (!r.ok)
		throw new Error(`HTTP ${r.status} from ${machine.host}:${ep.port}`);
	const j = (await r.json()) as {
		choices?: { message?: { content?: string } }[];
	};
	return j.choices?.[0]?.message?.content ?? "(empty response)";
}

async function main() {
	const cmd = process.argv[2] ?? "check";
	if (cmd === "check") {
		for (const row of await checkAll())
			console.log(
				`${row.ok ? "✓" : "✗"} ${row.machine}:${row.port} ${row.ip ?? "unresolved"}`,
			);
		return;
	}
	if (cmd === "discover") {
		const found = discover();
		console.log(
			found.length
				? JSON.stringify(found, null, 2)
				: `no ${SERVICE_TYPE} advertisements`,
		);
		return;
	}
	if (cmd === "route") {
		const [role, ...rest] = process.argv.slice(3);
		const prompt = rest.join(" ");
		if (!role || !prompt) {
			console.error("usage: remotes.ts route <role> <prompt>");
			process.exit(1);
		}
		for (const m of loadStatic())
			for (const ep of m.endpoints)
				if (ep.roles.includes(role)) {
					console.log(`→ ${m.name}:${ep.port} (${ep.protocol})`);
					console.log(await routeTask(m, ep, prompt));
					return;
				}
		console.error(`no remote endpoint serves role '${role}'`);
		process.exit(1);
	}
	console.log("usage: remotes.ts check|discover|route <role> <prompt>");
}

if (import.meta.main) void main();
