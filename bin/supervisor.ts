// supervisor.ts — self-heal engine for the belt fleet (W272).
//
// One async loop per target port. Owned targets (the :4000 router-shim and the
// resident :890x specialists the swarm launches) are respawned when they die;
// external / on-demand targets are probed and reported only — never touched.
//
// litellm (:4100, W277) is owned too: spawned with keys read from the 0600
// files at spawn time, probed on /v1/models WITH auth (200/401 = serving),
// and preflighted for its prisma dependency (litellm-target.ts).
//
// Owned-target loop (per port, independent — a 90s model load on :8903 never
// delays healing :4000):
//   probe (TCP connect, then HTTP GET healthPath; any HTTP reply = serving)
//     tcp+http        → up        (reset backoff after stableMs of uptime)
//     tcp, no http    → degraded  (killHung targets restart after hungThreshold)
//     no tcp          → down      (restart after failThreshold misses, or at
//                                  once when our own child exited / never up)
//   restart: breaker check (max N restarts / window → `unhealthy`, keep
//   probing, no spawn) → backoff sleep (base·2^attempt, capped) → re-probe
//   (someone else may have healed it) → free the port if held (orphan/hung)
//   → argument-array spawn → wait for the port to BIND (TCP probe, not pid)
//   within bindTimeoutMs, aborting early if the child exits.
// Every state change appends one line to the transition log; every probe
// rewrites the status JSON (tmp + rename, atomic) the dashboard polls.

import {
	appendFileSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import { EXTERNAL, residentSet, SPECIALISTS } from "./registry.ts";
import { litellmTarget } from "./litellm-target.ts";
import { mlxLogPath, spawnArgs } from "./spawner.ts";

const HOME = process.env.HOME ?? "";
const LOG_DIR = `${HOME}/.claude-insights`;
export const STATUS_FILE =
	process.env.BELT_SUPERVISOR_STATUS ?? `${LOG_DIR}/belt-supervisor.json`;
export const TRANSITION_LOG =
	process.env.BELT_SUPERVISOR_LOG ?? `${LOG_DIR}/belt-supervisor.log`;
export const ROUTER_SCRIPT = `${HOME}/.claude/local-llm/router-shim.ts`;

export type Kind =
	| "router"
	| "specialist"
	| "gateway"
	| "ondemand"
	| "external";
export type State =
	| "unknown"
	| "up"
	| "degraded"
	| "down"
	| "backoff"
	| "starting"
	| "unhealthy"
	| "idle";

/** Minimal child handle — Bun.Subprocess satisfies it. */
export interface Child {
	pid: number;
	exited: Promise<unknown>;
	kill(signal?: number | NodeJS.Signals): void;
}

export interface Target {
	name: string;
	port: number;
	kind: Kind;
	owned: boolean;
	host?: string;
	healthPath?: string;
	spawn?: () => Child;
	bindTimeoutMs?: number;
	killHung?: boolean;
	/** Extra probe headers (e.g. auth), built per probe — never logged. */
	probeHeaders?: () => Record<string, string>;
	/** HTTP statuses that count as serving; omitted = any reply. */
	okStatus?: number[];
	/** Startup dependency check: null = ok, string = alert reason. */
	preflight?: () => string | null;
}

export interface ProbeResult {
	tcp: boolean;
	http: boolean;
}

export interface TargetStatus {
	name: string;
	port: number;
	kind: Kind;
	owned: boolean;
	state: State;
	alert: boolean;
	since: string;
	lastProbe: string | null;
	lastOk: string | null;
	restarts: number;
	restartsLastWindow: number;
	pid: number | null;
	nextRetryAt: string | null;
	lastError: string | null;
	preflightError?: string | null;
}

export interface StatusDoc {
	version: 1;
	supervisorPid: number;
	updated: string;
	intervalMs: number;
	targets: TargetStatus[];
}

export interface SupervisorOptions {
	statusFile: string;
	logFile: string;
	intervalMs: number;
	failThreshold: number;
	hungThreshold: number;
	backoffBaseMs: number;
	backoffCapMs: number;
	maxRestarts: number;
	windowMs: number;
	stableMs: number;
	bindPollMs: number;
	probe: (t: Target) => Promise<ProbeResult>;
	killPort: (port: number) => void;
	now: () => number;
}

export const DEFAULTS: Omit<SupervisorOptions, "statusFile" | "logFile"> = {
	intervalMs: 5_000,
	failThreshold: 2,
	hungThreshold: 3,
	backoffBaseMs: 500,
	backoffCapMs: 30_000,
	maxRestarts: 6,
	windowMs: 3_600_000,
	stableMs: 60_000,
	bindPollMs: 250,
	probe: (t) => probeTarget(t),
	killPort: (port) => killPortPids(port),
	now: () => Date.now(),
};

// ─── pure policy ───

/** 0.5s → 1s → 2s → … capped. attempt is 0-based. */
export const backoffMs = (attempt: number, baseMs = 500, capMs = 30_000) =>
	Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));

/** Sliding-window restart budget: at most `max` restarts per `windowMs`. */
export class RestartBreaker {
	private stamps: number[] = [];
	constructor(
		private readonly max: number,
		private readonly windowMs: number,
	) {}
	private prune(now: number): void {
		this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
	}
	allow(now: number): boolean {
		this.prune(now);
		return this.stamps.length < this.max;
	}
	record(now: number): void {
		this.stamps.push(now);
	}
	count(now: number): number {
		this.prune(now);
		return this.stamps.length;
	}
}

const ALERT_OWNED: State[] = ["down", "backoff", "unhealthy", "degraded"];
const ALERT_EXTERNAL: State[] = ["down", "degraded"];
export const isAlert = (kind: Kind, owned: boolean, state: State): boolean => {
	if (owned) return ALERT_OWNED.includes(state);
	if (kind === "external") return ALERT_EXTERNAL.includes(state);
	return false; // on-demand specialists are allowed to be idle
};

// ─── probes ───

export const tcpProbe = (
	port: number,
	host = "127.0.0.1",
	timeoutMs = 1000,
): Promise<boolean> =>
	new Promise((resolve) => {
		const sock = connect({ port, host });
		const done = (ok: boolean) => {
			clearTimeout(timer);
			sock.destroy();
			resolve(ok);
		};
		const timer = setTimeout(() => done(false), timeoutMs);
		sock.once("connect", () => done(true));
		sock.once("error", () => done(false));
	});

export interface HttpProbeOptions {
	headers?: Record<string, string>;
	/** Statuses that count as serving; omitted = any reply (even 404). */
	okStatus?: number[];
}

/** Any HTTP response (even 404) means the server's request loop is alive,
 *  unless okStatus narrows what counts as healthy. */
export const httpProbe = async (
	port: number,
	path = "/health",
	host = "127.0.0.1",
	timeoutMs = 2000,
	opts: HttpProbeOptions = {},
): Promise<boolean> => {
	try {
		const r = await fetch(`http://${host}:${port}${path}`, {
			headers: opts.headers,
			signal: AbortSignal.timeout(timeoutMs),
		});
		await r.body?.cancel();
		return opts.okStatus ? opts.okStatus.includes(r.status) : true;
	} catch {
		return false;
	}
};

export async function probeTarget(t: Target): Promise<ProbeResult> {
	const host = t.host ?? "127.0.0.1";
	if (!(await tcpProbe(t.port, host))) return { tcp: false, http: false };
	const http = await httpProbe(t.port, t.healthPath, host, 2000, {
		headers: t.probeHeaders?.(),
		okStatus: t.okStatus,
	});
	return { tcp: true, http };
}

/** SIGKILL whatever listens on the port (argument-array lsof, no shell). */
export function killPortPids(port: number): void {
	const out = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"])
		.stdout.toString()
		.trim();
	for (const pid of out.split("\n").filter(Boolean)) {
		try {
			process.kill(Number(pid), "SIGKILL");
		} catch {}
	}
}

// ─── status file ───

export function readStatus(file = STATUS_FILE): StatusDoc | null {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as StatusDoc;
	} catch {
		return null;
	}
}

export const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** True when a different, live process is already supervising (lock). */
export function otherSupervisorAlive(file = STATUS_FILE): number | null {
	const doc = readStatus(file);
	const pid = doc?.supervisorPid;
	if (!pid || pid === process.pid) return null;
	return pidAlive(pid) ? pid : null;
}

// ─── engine ───

interface Runtime {
	attempt: number;
	fails: number;
	hung: number;
	seenUp: boolean;
	upSince: number | null;
	child: Child | null;
	childDead: boolean;
	exitInfo: string;
	breaker: RestartBreaker;
}

const iso = (ms: number) => new Date(ms).toISOString();

export class Supervisor {
	readonly opts: SupervisorOptions;
	private readonly status = new Map<number, TargetStatus>();
	private readonly rt = new Map<number, Runtime>();
	private stopped = false;
	private readonly sleepers = new Set<() => void>();

	constructor(
		readonly targets: Target[],
		opts: Partial<SupervisorOptions> &
			Pick<SupervisorOptions, "statusFile" | "logFile">,
	) {
		this.opts = { ...DEFAULTS, ...opts };
		const now = this.opts.now();
		for (const t of targets) {
			this.status.set(t.port, {
				name: t.name,
				port: t.port,
				kind: t.kind,
				owned: t.owned,
				state: "unknown",
				alert: false,
				since: iso(now),
				lastProbe: null,
				lastOk: null,
				restarts: 0,
				restartsLastWindow: 0,
				pid: null,
				nextRetryAt: null,
				lastError: null,
			});
			this.rt.set(t.port, {
				attempt: 0,
				fails: 0,
				hung: 0,
				seenUp: false,
				upSince: null,
				child: null,
				childDead: false,
				exitInfo: "",
				breaker: new RestartBreaker(this.opts.maxRestarts, this.opts.windowMs),
			});
		}
		mkdirSync(dirname(this.opts.statusFile), { recursive: true });
		mkdirSync(dirname(this.opts.logFile), { recursive: true });
		for (const t of targets) this.preflight(t);
	}

	/** Startup dependency check: log + alert, never auto-fix in-process. */
	private preflight(t: Target): void {
		if (!t.preflight) return;
		let err: string | null;
		try {
			err = t.preflight();
		} catch (e) {
			err = `preflight threw: ${String(e)}`;
		}
		const s = this.status.get(t.port) as TargetStatus;
		s.preflightError = err;
		s.alert = isAlert(t.kind, t.owned, s.state) || err !== null;
		if (err)
			appendFileSync(
				this.opts.logFile,
				`${iso(this.opts.now())} :${t.port} ${t.name} PREFLIGHT FAIL (${err})\n`,
			);
	}

	async run(): Promise<void> {
		this.flush();
		await Promise.all(this.targets.map((t) => this.loop(t)));
		this.flush();
	}

	/** Stop the loops. Children stay up unless killChildren (tests, `stop`). */
	stop(killChildren = false): void {
		this.stopped = true;
		for (const wake of this.sleepers) wake();
		if (!killChildren) return;
		for (const r of this.rt.values()) {
			try {
				r.child?.kill("SIGKILL");
			} catch {}
		}
	}

	snapshot(): StatusDoc {
		const now = this.opts.now();
		const targets = this.targets.map((t) => {
			const s = this.status.get(t.port) as TargetStatus;
			const r = this.rt.get(t.port) as Runtime;
			s.restartsLastWindow = r.breaker.count(now);
			return { ...s };
		});
		return {
			version: 1,
			supervisorPid: process.pid,
			updated: iso(now),
			intervalMs: this.opts.intervalMs,
			targets,
		};
	}

	private flush(): void {
		const tmp = `${this.opts.statusFile}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2));
		renameSync(tmp, this.opts.statusFile);
	}

	private sleep(ms: number): Promise<void> {
		if (this.stopped) return Promise.resolve();
		return new Promise((resolve) => {
			const wake = () => {
				clearTimeout(timer);
				this.sleepers.delete(wake);
				resolve();
			};
			const timer = setTimeout(wake, ms);
			this.sleepers.add(wake);
		});
	}

	private transition(
		t: Target,
		state: State,
		extra: Partial<TargetStatus> = {},
	): void {
		const s = this.status.get(t.port) as TargetStatus;
		Object.assign(s, extra);
		if (s.state !== state) {
			const now = this.opts.now();
			const why = extra.lastError ? ` (${extra.lastError})` : "";
			const pid = extra.pid ? ` pid=${extra.pid}` : "";
			appendFileSync(
				this.opts.logFile,
				`${iso(now)} :${t.port} ${t.name} ${s.state}→${state}${pid}${why}\n`,
			);
			s.state = state;
			s.since = iso(now);
		}
		s.alert = isAlert(t.kind, t.owned, s.state) || Boolean(s.preflightError);
		this.flush();
	}

	private async probe(t: Target): Promise<ProbeResult> {
		const p = await this.opts.probe(t);
		const s = this.status.get(t.port) as TargetStatus;
		const now = iso(this.opts.now());
		s.lastProbe = now;
		if (p.tcp && p.http) s.lastOk = now;
		return p;
	}

	private loop(t: Target): Promise<void> {
		return t.owned && t.spawn ? this.loopOwned(t) : this.loopReport(t);
	}

	private async loopReport(t: Target): Promise<void> {
		while (!this.stopped) {
			const p = await this.probe(t);
			const downState: State = t.kind === "ondemand" ? "idle" : "down";
			const state: State = !p.tcp ? downState : p.http ? "up" : "degraded";
			this.transition(t, state);
			await this.sleep(this.opts.intervalMs);
		}
	}

	private async loopOwned(t: Target): Promise<void> {
		const r = this.rt.get(t.port) as Runtime;
		while (!this.stopped) {
			const p = await this.probe(t);
			const now = this.opts.now();
			if (p.tcp && p.http) {
				r.fails = 0;
				r.hung = 0;
				r.seenUp = true;
				r.upSince ??= now;
				if (now - r.upSince >= this.opts.stableMs) r.attempt = 0;
				this.transition(t, "up", { lastError: null, nextRetryAt: null });
				await this.sleep(this.opts.intervalMs);
				continue;
			}
			r.upSince = null;
			if (p.tcp) {
				r.hung++;
				if (!t.killHung || r.hung < this.opts.hungThreshold) {
					this.transition(t, "degraded", {
						lastError: "port bound, HTTP not answering",
					});
					await this.sleep(this.opts.intervalMs);
					continue;
				}
				await this.restart(t, r, `hung: no HTTP for ${r.hung} probes`);
				continue;
			}
			r.fails++;
			const dead = r.child !== null && r.childDead;
			if (dead || !r.seenUp || r.fails >= this.opts.failThreshold) {
				const reason = dead
					? `child exited ${r.exitInfo}`
					: r.seenUp
						? `no TCP on :${t.port} for ${r.fails} probes`
						: `not running on :${t.port}`;
				await this.restart(t, r, reason);
				continue;
			}
			await this.sleep(this.opts.intervalMs);
		}
	}

	private async restart(t: Target, r: Runtime, reason: string): Promise<void> {
		const s = this.status.get(t.port) as TargetStatus;
		if (!r.breaker.allow(this.opts.now())) {
			this.transition(t, "unhealthy", {
				lastError: `circuit open: ${this.opts.maxRestarts} restarts within ${Math.round(this.opts.windowMs / 60_000)}min — not respawning (${reason})`,
				nextRetryAt: null,
			});
			await this.sleep(this.opts.intervalMs);
			return;
		}
		this.transition(t, "down", { lastError: reason });
		const delay = backoffMs(
			r.attempt,
			this.opts.backoffBaseMs,
			this.opts.backoffCapMs,
		);
		r.attempt++;
		this.transition(t, "backoff", {
			lastError: reason,
			nextRetryAt: iso(this.opts.now() + delay),
		});
		await this.sleep(delay);
		if (this.stopped) return;

		const before = await this.probe(t);
		if (before.tcp && before.http) return; // healed by someone else
		if (before.tcp) this.opts.killPort(t.port); // orphan / hung holder

		r.breaker.record(this.opts.now());
		s.restarts++;
		const spawn = t.spawn as () => Child;
		let child: Child;
		try {
			child = spawn();
		} catch (e) {
			this.transition(t, "down", { lastError: `spawn failed: ${String(e)}` });
			return;
		}
		r.child = child;
		r.childDead = false;
		r.exitInfo = "";
		child.exited.then(
			(code) => {
				if (r.child !== child) return;
				r.childDead = true;
				r.exitInfo = `code=${String(code)}`;
			},
			() => {
				if (r.child === child) r.childDead = true;
			},
		);
		this.transition(t, "starting", {
			pid: child.pid,
			nextRetryAt: null,
			lastError: reason,
		});

		const bound = await this.waitBind(t, r, child);
		if (bound) {
			r.fails = 0;
			r.hung = 0;
			r.seenUp = true;
			r.upSince = this.opts.now();
			this.transition(t, "up", { lastError: null });
			return;
		}
		const why = r.childDead
			? `exited before binding :${t.port} (${r.exitInfo})`
			: `no bind on :${t.port} within ${t.bindTimeoutMs ?? 30_000}ms`;
		try {
			child.kill("SIGKILL");
		} catch {}
		r.childDead = true;
		r.exitInfo = why;
		this.transition(t, "down", { lastError: why });
	}

	/** Port must actually accept TCP — a live pid alone proves nothing. */
	private async waitBind(
		t: Target,
		r: Runtime,
		child: Child,
	): Promise<boolean> {
		const deadline = this.opts.now() + (t.bindTimeoutMs ?? 30_000);
		while (!this.stopped && this.opts.now() < deadline) {
			if (r.child === child && r.childDead) return false;
			if ((await this.opts.probe(t)).tcp) return true;
			await this.sleep(this.opts.bindPollMs);
		}
		return false;
	}
}

// ─── fleet wiring (registry → targets) ───

const spawnLogged = (argv: string[], log: string): Child => {
	mkdirSync(dirname(log), { recursive: true });
	const fd = openSync(log, "a");
	return Bun.spawn(argv, { stdin: "ignore", stdout: fd, stderr: fd });
};

/** Every port the fleet occupies. Owned = what `swarm.ts` launches. */
export function fleetTargets(): Target[] {
	const resident = new Set(residentSet().map((s) => s.port));
	const targets: Target[] = [
		{
			name: "router-shim",
			port: 4000,
			kind: "router",
			owned: true,
			healthPath: "/health/liveliness",
			killHung: true,
			bindTimeoutMs: 15_000,
			spawn: () =>
				spawnLogged(
					[process.execPath, ROUTER_SCRIPT],
					`${LOG_DIR}/mlx-router.log`,
				),
		},
	];
	for (const s of SPECIALISTS) {
		const owned = resident.has(s.port);
		targets.push({
			name: s.label,
			port: s.port,
			kind: owned ? "specialist" : "ondemand",
			owned,
			healthPath: "/health",
			// mlx_lm may stall HTTP mid-generation — never kill on a slow
			// /health; only a closed port triggers a respawn.
			killHung: false,
			bindTimeoutMs: 180_000,
			spawn: owned
				? () => spawnLogged(spawnArgs(s), mlxLogPath(s.port))
				: undefined,
		});
	}
	for (const e of EXTERNAL) {
		targets.push({
			name: e.label,
			port: e.port,
			kind: e.tier === "ondemand" ? "ondemand" : "external",
			owned: false,
			healthPath: "/health",
		});
	}
	targets.push(litellmTarget());
	return targets;
}
