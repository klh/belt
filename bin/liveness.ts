// liveness.ts — report-only fleet liveness for watchdog.ts (W272).
// Fresh probes of every fleet port merged with the supervisor's status file
// (restart counts, breaker state). Never restarts anything: `swarm.ts
// supervise` is the single restarter.

import {
	type Kind,
	type ProbeResult,
	pidAlive,
	probeTarget,
	readStatus,
	type StatusDoc,
	type Target,
	fleetTargets,
	isAlert,
	type State,
} from "./supervisor.ts";

export interface LivenessRow {
	name: string;
	port: number;
	kind: Kind;
	owned: boolean;
	state: State;
	alert: boolean;
	restarts: number;
	since: string | null;
	supervisorState: State | null;
	lastError: string | null;
	preflightError: string | null;
}

export interface LivenessReport {
	ts: string;
	supervisor: { pid: number | null; alive: boolean; stale: boolean };
	rows: LivenessRow[];
	alerts: string[];
}

export interface LivenessDeps {
	targets?: Target[];
	probe?: (t: Target) => Promise<ProbeResult>;
	status?: StatusDoc | null;
	now?: number;
	alive?: (pid: number) => boolean;
}

export async function livenessReport(
	deps: LivenessDeps = {},
): Promise<LivenessReport> {
	const targets = deps.targets ?? fleetTargets();
	const probe = deps.probe ?? probeTarget;
	const doc = deps.status === undefined ? readStatus() : deps.status;
	const now = deps.now ?? Date.now();
	const alive = deps.alive ?? pidAlive;
	const pid = doc?.supervisorPid ?? null;
	const supAlive = pid !== null && alive(pid);
	const stale =
		!doc ||
		!supAlive ||
		now - Date.parse(doc.updated) > 3 * Math.max(doc.intervalMs, 5_000);

	const rows = await Promise.all(
		targets.map(async (t): Promise<LivenessRow> => {
			const p = await probe(t);
			const down: State = t.kind === "ondemand" ? "idle" : "down";
			const state: State = !p.tcp ? down : p.http ? "up" : "degraded";
			const sup = doc?.targets.find((x) => x.port === t.port);
			const supState = sup?.state ?? null;
			const preflightError = sup?.preflightError ?? null;
			return {
				name: t.name,
				port: t.port,
				kind: t.kind,
				owned: t.owned,
				state,
				alert:
					isAlert(t.kind, t.owned, state) ||
					(t.owned && supState === "unhealthy") ||
					preflightError !== null,
				restarts: sup?.restarts ?? 0,
				since: sup?.since ?? null,
				supervisorState: supState,
				lastError: sup?.lastError ?? null,
				preflightError,
			};
		}),
	);
	const alerts = rows
		.filter((r) => r.alert)
		.map(
			(r) =>
				`:${r.port} ${r.name} ${r.supervisorState === "unhealthy" ? "unhealthy (circuit open)" : r.state}${r.owned ? "" : " [external — report only]"}${r.preflightError ? ` preflight: ${r.preflightError}` : ""}`,
		);
	if (stale && rows.some((r) => r.owned))
		alerts.unshift(
			"supervisor not running — owned ports will NOT self-heal (bun swarm.ts supervise)",
		);
	return {
		ts: new Date(now).toISOString(),
		supervisor: { pid, alive: supAlive, stale },
		rows,
		alerts,
	};
}

const ICON: Record<State, string> = {
	unknown: "?",
	up: "✓",
	degraded: "~",
	down: "✗",
	backoff: "…",
	starting: "↻",
	unhealthy: "⛔",
	idle: "·",
};

export function renderLiveness(r: LivenessReport): string {
	const sup = r.supervisor.stale
		? `supervisor: DOWN${r.supervisor.pid ? ` (last pid ${r.supervisor.pid})` : ""}`
		: `supervisor: pid ${r.supervisor.pid}`;
	const lines = [`🩺 fleet liveness — ${sup}`];
	for (const row of r.rows) {
		const owner = row.owned ? "owned" : row.kind;
		const restarts = row.restarts ? ` restarts=${row.restarts}` : "";
		lines.push(
			`  ${ICON[row.state]} :${String(row.port).padEnd(5)} ${row.name.padEnd(14)} ${row.state.padEnd(9)} ${owner}${restarts}`,
		);
	}
	for (const a of r.alerts) lines.push(`  ⚠️  ${a}`);
	return lines.join("\n");
}
