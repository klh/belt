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
// CLI: check [--json] | discover [--json] | route <role> <prompt>
//   --json = raw machine-readable JSON array (the belt dashboard consumes it);
//   default output stays human-readable.
//   route  = the multi-machine proof: send one task to a remote provider
//            and report the result back when done.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const RUNTIME = `${process.env.HOME}/.claude/local-llm`;
const STATIC_PATH = `${RUNTIME}/remotes.json`;
const SERVICE_TYPE = "_klh-llm._tcp";

export interface RemoteEndpoint {
	port: number;
	// openai = /v1/chat/completions + /v1/models; llama = llama.cpp server
	// (/health, /props, /v1/...); immich = Immich ML (/ping answers "pong" on
	// v3.1+ — /predict needs multipart and is broken upstream). Routing an
	// immich endpoint talks to the Immich SERVER smart-search: routeImmich.
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
 *  /health; immich → GET /ping (Immich ML v3.1 answers "pong"; /predict
 *  requires multipart and is broken upstream). Any HTTP answer = alive; only
 *  transport failure = dead. */
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
				: "/ping";
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
 *  fallback; updates cached liveness state and returns a report carrying
 *  per-endpoint metadata + probe latency (ms) — the shape behind both the
 *  human `check` output and `check --json`. */
export interface CheckRow {
	machine: string;
	host: string;
	port: number;
	protocol: RemoteEndpoint["protocol"];
	roles: string[];
	model?: string;
	ok: boolean;
	ms: number;
	ip?: string;
}

export async function checkAll(): Promise<CheckRow[]> {
	const rows: CheckRow[] = [];
	for (const m of loadStatic()) {
		for (const ep of m.endpoints) {
			const t0 = Date.now();
			const ok = await probeEndpoint(m, ep);
			const st = stateFor(m.name);
			if (ok) st.last_ok = Date.now();
			else st.last_error = new Date().toISOString();
			rows.push({
				machine: m.name,
				host: m.host,
				port: ep.port,
				protocol: ep.protocol,
				roles: ep.roles,
				model: ep.model,
				ok,
				ms: Date.now() - t0,
				ip: st.resolved_ip,
			});
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

// ─── route log — JSONL at the runtime dir (never committed); the dashboard
// tails it for the "recently routed" pane of the remotes panel ───
export interface RouteLogEntry {
	ts: string;
	machine: string;
	endpoint: string;
	protocol: string;
	role: string;
	duration_ms: number;
	ok: boolean;
}

const ROUTE_LOG = `${RUNTIME}/remotes-routes.log`;

export function logRoute(entry: RouteLogEntry): void {
	try {
		appendFileSync(ROUTE_LOG, `${JSON.stringify(entry)}\n`);
	} catch {
		// best-effort — a failed log write must never fail the route itself
	}
}

export function tailRoutes(n: number): RouteLogEntry[] {
	if (!existsSync(ROUTE_LOG)) return [];
	try {
		const lines = readFileSync(ROUTE_LOG, "utf8")
			.trim()
			.split("\n")
			.filter((l) => l.length > 0);
		return lines.slice(-n).flatMap((line) => {
			try {
				return [JSON.parse(line) as RouteLogEntry];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

/** Immich SERVER smart-search: POST /api/search/smart with {"q": prompt} and
 *  x-api-key auth. Throws with a clear message when IMMICH_API_KEY is unset. */
async function immichSmartSearch(
	ip: string,
	port: number,
	prompt: string,
): Promise<{ assets?: { total?: number; items?: Record<string, unknown>[] } }> {
	const key = process.env.IMMICH_API_KEY;
	if (!key)
		throw new Error(
			"IMMICH_API_KEY is not set — export the Immich server API key to route immich-protocol tasks",
		);
	const r = await fetch(`http://${ip}:${port}/api/search/smart`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": key },
		body: JSON.stringify({ q: prompt }),
		signal: AbortSignal.timeout(30_000),
	});
	if (!r.ok)
		throw new Error(`HTTP ${r.status} from ${ip}:${port}/api/search/smart`);
	return (await r.json()) as {
		assets?: { total?: number; items?: Record<string, unknown>[] };
	};
}

/** immich-protocol route: the ML container answers the /ping probe, but the
 *  task goes to the Immich SERVER smart-search — natural-language query in,
 *  matching assets out. Response shape explored at runtime — if the expected
 *  fields are missing, the top-level keys are logged so the shape can be
 *  learned. */
async function routeImmich(
	machine: RemoteMachine,
	ep: RemoteEndpoint,
	prompt: string,
): Promise<string> {
	const ip = resolveHost(machine);
	if (!ip) throw new Error(`cannot resolve ${machine.host}`);
	const j = await immichSmartSearch(ip, ep.port, prompt);
	const items = j.assets?.items;
	if (!Array.isArray(items)) {
		console.error(
			`immich smart-search: unexpected response shape — top-level keys: ${Object.keys(j).join(", ")}`,
		);
		return "(unexpected smart-search response shape — top-level keys on stderr)";
	}
	const count =
		typeof j.assets?.total === "number" ? j.assets.total : items.length;
	const names = items
		.slice(0, 5)
		.map(
			(a) => `${a.originalFileName ?? a.deviceAssetId ?? a.id ?? "(unnamed)"}`,
		)
		.join(", ");
	return `${count} assets match '${prompt}' — first: ${names}`;
}

/** Send one task to a remote endpoint: openai-protocol gets chat completions,
 *  immich-protocol gets an Immich smart-search. Resolves with the answer
 *  when done — the report-back. Long timeout for slow NAS CPUs. */
export async function routeTask(
	machine: RemoteMachine,
	ep: RemoteEndpoint,
	prompt: string,
): Promise<string> {
	if (ep.protocol === "immich") return routeImmich(machine, ep, prompt);
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
	const json = process.argv.includes("--json");
	if (cmd === "check") {
		const rows = await checkAll();
		if (json) {
			console.log(JSON.stringify(rows));
			return;
		}
		for (const row of rows)
			console.log(
				`${row.ok ? "✓" : "✗"} ${row.machine}:${row.port} ${row.ip ?? "unresolved"}`,
			);
		return;
	}
	if (cmd === "discover") {
		const found = discover();
		if (json) {
			console.log(JSON.stringify(found));
			return;
		}
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
					const t0 = Date.now();
					const entry: RouteLogEntry = {
						ts: new Date().toISOString(),
						machine: m.name,
						endpoint: `${m.host}:${ep.port}`,
						protocol: ep.protocol,
						role,
						duration_ms: 0,
						ok: false,
					};
					try {
						const answer = await routeTask(m, ep, prompt);
						entry.ok = true;
						entry.duration_ms = Date.now() - t0;
						logRoute(entry);
						console.log(answer);
					} catch (err) {
						entry.duration_ms = Date.now() - t0;
						logRoute(entry);
						console.error(
							`route failed: ${err instanceof Error ? err.message : String(err)}`,
						);
						process.exit(1);
					}
					return;
				}
		console.error(`no remote endpoint serves role '${role}'`);
		process.exit(1);
	}
	console.log(
		"usage: remotes.ts check [--json] | discover [--json] | route <role> <prompt>",
	);
}

if (import.meta.main) void main();
