// W272 — self-heal: supervisor death detection, backoff, circuit breaker,
// probe-after-respawn, orphan adoption, report-only externals, liveness
// report. Stub children + stub ports only — never touches live :4000/:890x.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { livenessReport, renderLiveness } from "../bin/liveness.ts";
import {
	backoffMs,
	type Child,
	isAlert,
	type ProbeResult,
	RestartBreaker,
	type StatusDoc,
	Supervisor,
	type Target,
	tcpProbe,
} from "../bin/supervisor.ts";

const dir = mkdtempSync(join(tmpdir(), "w272-"));
const STUB = join(dir, "stub-server.ts");
writeFileSync(
	STUB,
	`Bun.serve({ port: Number(process.argv[2]), hostname: "127.0.0.1", fetch: () => new Response("ok") });\n`,
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
const files = () => {
	seq++;
	return {
		statusFile: join(dir, `status-${seq}.json`),
		logFile: join(dir, `transitions-${seq}.log`),
	};
};

const freePort = (): number => {
	const s = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = s.port as number;
	s.stop(true);
	return port;
};

const waitFor = async (pred: () => boolean, ms = 8000): Promise<void> => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
		await Bun.sleep(20);
	}
};

const stateOf = (sup: Supervisor, port: number) =>
	sup.snapshot().targets.find((t) => t.port === port);

/** A fake child that exits as soon as it is spawned (crash loop). */
const crashingChild = (): Child => ({
	pid: 999_999,
	exited: Promise.resolve(1),
	kill: () => {},
});

const fast = {
	intervalMs: 30,
	failThreshold: 2,
	hungThreshold: 3,
	backoffBaseMs: 20,
	backoffCapMs: 2000,
	stableMs: 60_000,
	bindPollMs: 20,
};

const running: Supervisor[] = [];
afterEach(() => {
	for (const s of running.splice(0)) s.stop(true);
});
const start = (sup: Supervisor): Promise<void> => {
	running.push(sup);
	return sup.run();
};

describe("policy", () => {
	test("backoff doubles from 0.5s and caps at 30s", () => {
		expect([0, 1, 2, 3, 4, 5, 6, 7].map((a) => backoffMs(a))).toEqual([
			500, 1000, 2000, 4000, 8000, 16000, 30000, 30000,
		]);
		expect(backoffMs(50)).toBe(30_000);
	});

	test("breaker opens after N restarts per window and closes as it ages", () => {
		const b = new RestartBreaker(3, 1000);
		for (const t of [0, 10, 20]) {
			expect(b.allow(t)).toBe(true);
			b.record(t);
		}
		expect(b.allow(30)).toBe(false);
		expect(b.count(30)).toBe(3);
		expect(b.allow(1005)).toBe(true); // first stamp aged out
	});

	test("alerts: owned down/unhealthy, external down, on-demand idle never", () => {
		expect(isAlert("router", true, "down")).toBe(true);
		expect(isAlert("router", true, "unhealthy")).toBe(true);
		expect(isAlert("router", true, "up")).toBe(false);
		expect(isAlert("external", false, "down")).toBe(true);
		expect(isAlert("ondemand", false, "idle")).toBe(false);
	});
});

describe("supervisor — real stub children on stub ports", () => {
	test("orphan adopted, then its death is detected and the shim respawned + bound", async () => {
		const port = freePort();
		// pre-existing server NOT spawned by the supervisor (the PPID-1 orphan)
		const orphan = Bun.serve({
			port,
			hostname: "127.0.0.1",
			fetch: () => new Response("orphan"),
		});
		let spawns = 0;
		const t: Target = {
			name: "router-shim",
			port,
			kind: "router",
			owned: true,
			healthPath: "/health/liveliness",
			bindTimeoutMs: 5000,
			spawn: () => {
				spawns++;
				return Bun.spawn([process.execPath, STUB, String(port)], {
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				});
			},
		};
		const f = files();
		const sup = new Supervisor([t], { ...f, ...fast });
		const done = start(sup);

		await waitFor(() => stateOf(sup, port)?.state === "up");
		expect(spawns).toBe(0); // adopted, not double-spawned

		orphan.stop(true); // the incident: shim killed, :4000 dark
		await waitFor(() => spawns === 1 && stateOf(sup, port)?.state === "up");
		expect(await tcpProbe(port)).toBe(true);
		const firstPid = stateOf(sup, port)?.pid as number;
		expect(firstPid).toBeGreaterThan(0);

		// now kill OUR child — death via child exit, respawned again
		process.kill(firstPid, "SIGKILL");
		await waitFor(
			() =>
				spawns === 2 &&
				stateOf(sup, port)?.state === "up" &&
				stateOf(sup, port)?.pid !== firstPid,
		);
		expect(await tcpProbe(port)).toBe(true);
		expect(stateOf(sup, port)?.restarts).toBe(2);

		const log = readFileSync(f.logFile, "utf8");
		expect(log).toContain("up→down");
		expect(log).toContain("backoff→starting");
		expect(log).toContain("starting→up");
		expect(log.trim().split("\n").length).toBeGreaterThanOrEqual(6);

		const doc = JSON.parse(readFileSync(f.statusFile, "utf8")) as StatusDoc;
		expect(doc.supervisorPid).toBe(process.pid);
		expect(doc.targets[0]?.port).toBe(port);
		expect(doc.targets[0]?.lastProbe).not.toBeNull();

		sup.stop(true);
		await done;
	}, 20_000);

	test("probe-after-respawn: a live pid that never binds is NOT up", async () => {
		const port = freePort();
		const kills: number[] = [];
		const t: Target = {
			name: "spec",
			port,
			kind: "specialist",
			owned: true,
			bindTimeoutMs: 200,
			spawn: () => {
				// real process that stays alive but never listens
				const c = Bun.spawn(
					[process.execPath, "-e", "setInterval(() => {}, 1000)"],
					{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
				);
				return {
					pid: c.pid,
					exited: c.exited,
					kill: (sig) => {
						kills.push(c.pid);
						c.kill(sig);
					},
				};
			},
		};
		const sup = new Supervisor([t], { ...files(), ...fast });
		const done = start(sup);
		await waitFor(() => kills.length >= 1);
		const s = stateOf(sup, port);
		expect(s?.state).not.toBe("up");
		expect(sup.snapshot().targets[0]?.lastError ?? "").toMatch(
			/no bind|not running|exited/,
		);
		sup.stop(true);
		await done;
	}, 10_000);
});

describe("supervisor — stub probes + fake children", () => {
	const down = async (): Promise<ProbeResult> => ({ tcp: false, http: false });

	test("crash loop backs off exponentially", async () => {
		const at: number[] = [];
		const t: Target = {
			name: "crashy",
			port: 1,
			kind: "specialist",
			owned: true,
			bindTimeoutMs: 100,
			spawn: () => {
				at.push(Date.now());
				return crashingChild();
			},
		};
		const sup = new Supervisor([t], {
			...files(),
			...fast,
			backoffBaseMs: 40,
			maxRestarts: 50,
			probe: down,
		});
		const done = start(sup);
		await waitFor(() => at.length >= 5, 10_000);
		sup.stop();
		await done;
		const gaps = at.slice(1).map((v, i) => v - (at[i] as number));
		// 80 → 160 → 320 → 640 (base·2^n), each strictly longer than the last
		for (let i = 1; i < gaps.length; i++)
			expect(gaps[i] as number).toBeGreaterThan(gaps[i - 1] as number);
		expect(gaps[3] as number).toBeGreaterThanOrEqual(600);
	}, 15_000);

	test("circuit breaker stops respawning after N restarts and marks unhealthy", async () => {
		let spawns = 0;
		const t: Target = {
			name: "router-shim",
			port: 2,
			kind: "router",
			owned: true,
			bindTimeoutMs: 50,
			spawn: () => {
				spawns++;
				return crashingChild();
			},
		};
		const f = files();
		const sup = new Supervisor([t], {
			...f,
			...fast,
			backoffBaseMs: 5,
			maxRestarts: 3,
			probe: down,
		});
		const done = start(sup);
		await waitFor(() => stateOf(sup, 2)?.state === "unhealthy");
		await Bun.sleep(300); // many more intervals: no fork-bomb
		expect(spawns).toBe(3);
		const s = stateOf(sup, 2);
		expect(s?.state).toBe("unhealthy");
		expect(s?.alert).toBe(true);
		expect(s?.restartsLastWindow).toBe(3);
		expect(s?.lastError).toContain("circuit open");
		// unhealthy logged once, not once per interval
		const log = readFileSync(f.logFile, "utf8");
		expect(log.match(/→unhealthy/g)?.length).toBe(1);
		sup.stop();
		await done;
	});

	test("hung router (port bound, no HTTP) is killed and respawned; specialists are not", async () => {
		let healthy = false;
		const killed: number[] = [];
		const spawned: number[] = [];
		const mk = (port: number, killHung: boolean): Target => ({
			name: `t${port}`,
			port,
			kind: port === 10 ? "router" : "specialist",
			owned: true,
			killHung,
			bindTimeoutMs: 100,
			spawn: () => {
				spawned.push(port);
				if (port === 10) healthy = true;
				return { pid: 1234, exited: new Promise(() => {}), kill: () => {} };
			},
		});
		const sup = new Supervisor([mk(10, true), mk(11, false)], {
			...files(),
			...fast,
			probe: async (t) => ({
				tcp: true,
				http: t.port === 10 ? healthy : false,
			}),
			killPort: (p) => killed.push(p),
		});
		const done = start(sup);
		await waitFor(() => stateOf(sup, 10)?.state === "up" && healthy);
		await Bun.sleep(200);
		expect(killed).toEqual([10]);
		expect(spawned).toEqual([10]);
		expect(stateOf(sup, 11)?.state).toBe("degraded");
		sup.stop();
		await done;
	});

	test("external + on-demand targets are report-only — never spawned", async () => {
		const sup = new Supervisor(
			[
				{ name: "kev", port: 20, kind: "external", owned: false },
				{ name: "gateway", port: 21, kind: "external", owned: false },
				{ name: "danish", port: 22, kind: "ondemand", owned: false },
			],
			{ ...files(), ...fast, probe: down },
		);
		const done = start(sup);
		await waitFor(() => stateOf(sup, 22)?.state === "idle");
		await waitFor(() => stateOf(sup, 20)?.state === "down");
		expect(stateOf(sup, 20)?.alert).toBe(true);
		expect(stateOf(sup, 22)?.alert).toBe(false);
		expect(stateOf(sup, 20)?.restarts).toBe(0);
		sup.stop();
		await done;
	});
});

describe("watchdog liveness report", () => {
	const targets: Target[] = [
		{ name: "router-shim", port: 4000, kind: "router", owned: true },
		{ name: "kev", port: 8912, kind: "external", owned: false },
		{ name: "danish", port: 8906, kind: "ondemand", owned: false },
	];
	const probe = async (t: Target): Promise<ProbeResult> =>
		t.port === 4000 ? { tcp: true, http: true } : { tcp: false, http: false };

	test("no supervisor → loud alert; external down alerts; on-demand idle quiet", async () => {
		const r = await livenessReport({ targets, probe, status: null });
		expect(r.supervisor.stale).toBe(true);
		expect(r.alerts[0]).toContain("supervisor not running");
		expect(r.alerts.some((a) => a.includes(":8912"))).toBe(true);
		expect(r.alerts.some((a) => a.includes(":8906"))).toBe(false);
		expect(renderLiveness(r)).toContain("supervisor: DOWN");
	});

	test("fresh supervisor status merges restarts + breaker state", async () => {
		const now = Date.parse("2026-10-03T08:45:00Z");
		const status: StatusDoc = {
			version: 1,
			supervisorPid: 4242,
			updated: new Date(now - 1000).toISOString(),
			intervalMs: 5000,
			targets: [
				{
					name: "router-shim",
					port: 4000,
					kind: "router",
					owned: true,
					state: "unhealthy",
					alert: true,
					since: new Date(now - 60_000).toISOString(),
					lastProbe: null,
					lastOk: null,
					restarts: 6,
					restartsLastWindow: 6,
					pid: null,
					nextRetryAt: null,
					lastError: "circuit open",
				},
			],
		};
		const r = await livenessReport({
			targets,
			probe,
			status,
			now,
			alive: () => true,
		});
		expect(r.supervisor).toEqual({ pid: 4242, alive: true, stale: false });
		const row = r.rows.find((x) => x.port === 4000);
		expect(row?.restarts).toBe(6);
		expect(row?.alert).toBe(true);
		expect(r.alerts.some((a) => a.includes("circuit open"))).toBe(true);
	});
});
