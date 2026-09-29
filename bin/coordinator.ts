#!/usr/bin/env bun
// coordinator.ts — §7 unified CLI for the local AI coordinator.
// One command to see (and drive) the whole stack:
//   bun coordinator.ts status | start | stop | restart | prefs [json]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { residentSet } from "./registry.ts";

const HOME = process.env.HOME!;
const CACHE = `${HOME}/.cache/claude-governor`;
const ROUTING_LOG = `${HOME}/.claude-insights/swarm-routing.log`;

type Locks = Record<string, { sid: string; ts: number; hash?: string }>;
type Heartbeats = Record<
	string,
	{
		sid: string;
		task?: string;
		milestone?: string;
		ts: number;
		seen: number;
		waiting?: string;
		until?: number;
	}
>;

const isUp = async (port: number): Promise<boolean> => {
	try {
		const r = await fetch(`http://localhost:${port}/v1/models`, {
			signal: AbortSignal.timeout(800),
		});
		return r.ok;
	} catch {
		return false;
	}
};

const health = async (
	port: number,
): Promise<{ up: boolean; extra?: string }> => {
	try {
		const r = await fetch(`http://localhost:${port}/health/liveliness`, {
			signal: AbortSignal.timeout(800),
		});
		const j = (await r.json()) as any;
		return { up: true, extra: j.router ?? undefined };
	} catch {
		return { up: await isUp(port) };
	}
};

async function cmdStatus(): Promise<void> {
	console.log("╭─ local AI coordinator ─────────────────────────────╮");

	// swarm + router
	const router = await health(4000);
	console.log(
		`│ :4000 router        ${router.up ? "✓" : "✗"}  ${router.extra ?? ""}`,
	);
	let ram = 0;
	for (const s of residentSet()) {
		const up = await isUp(s.port);
		if (up) ram += s.ram_gb;
		console.log(
			`│ :${s.port} ${s.label.padEnd(14)} ${up ? "✓" : "✗"}   ${s.model.replace("mlx-community/", "")}`,
		);
	}
	console.log(`│ RAM (resident)      ~${ram.toFixed(1)}GB / 128GB`);

	// governor locks
	const locks = existsSync(`${CACHE}/locks.json`)
		? (JSON.parse(readFileSync(`${CACHE}/locks.json`, "utf8")) as Locks)
		: {};
	const entries = Object.entries(locks);
	console.log(
		`│ governor            ${entries.length} active lease${entries.length === 1 ? "" : "s"}`,
	);
	for (const [p, l] of entries.slice(0, 5)) {
		console.log(
			`│   🔒 ${p.replace(HOME, "~")}  (session ${l.sid.slice(0, 8)}, ${Math.round((Date.now() - l.ts) / 60000)}min ago)`,
		);
	}

	// heartbeats
	const hbs = existsSync(`${CACHE}/heartbeats.json`)
		? (JSON.parse(
				readFileSync(`${CACHE}/heartbeats.json`, "utf8"),
			) as Heartbeats)
		: {};
	const hbEntries = Object.entries(hbs);
	if (hbEntries.length > 0) {
		console.log(
			`│ agents              ${hbEntries.length} heartbeat${hbEntries.length === 1 ? "" : "s"}`,
		);
		const now = Date.now();
		for (const [sid, hb] of hbEntries.slice(0, 5)) {
			const age = Math.round((now - hb.ts) / 60000);
			const flag = age > 5 ? " ⚠️ overdue" : hb.seen >= 3 ? " ⚠️ stalled" : "";
			console.log(
				`│   🐕 ${sid.slice(0, 8)}  ${age}min  ${String(hb.task ?? "").slice(0, 30)}${flag}`,
			);
		}
	}

	// prefs
	const specs = existsSync(`${HOME}/.claude/local-llm/prefs.json`)
		? (JSON.parse(
				readFileSync(`${HOME}/.claude/local-llm/prefs.json`, "utf8"),
			) as any)
		: {};
	const prefs = specs;
	console.log(
		`│ prefs               ${prefs.cost_speed ?? "balanced"} · cloud ${prefs.allow_cloud === true ? "on" : "off"} · profile: ${(prefs.profile ?? []).join(", ")}`,
	);

	// routing log tail
	if (existsSync(ROUTING_LOG)) {
		const lines = readFileSync(ROUTING_LOG, "utf8").trim().split("\n");
		console.log(`│ recent routing      ${lines.length} requests logged`);
		for (const line of lines.slice(-3)) {
			try {
				const e = JSON.parse(line);
				console.log(
					`│   · ${String(e.model).replace("mlx-community/", "")} ${String(e.duration_ms)}ms ${e.tier ?? ""} ${e.escalated ? " ☁️" : ""}`,
				);
			} catch {}
		}
	}
	console.log("╰─────────────────────────────────────────────────────╯");
}

async function cmdStart(): Promise<void> {
	Bun.spawn(
		["/opt/homebrew/bin/bun", `${HOME}/.claude/local-llm/swarm.ts`, "start"],
		{ stdout: "inherit", stderr: "inherit" },
	);
	console.log("→ swarm start (launched)");
}

async function cmdStop(): Promise<void> {
	Bun.spawn(
		["/opt/homebrew/bin/bun", `${HOME}/.claude/local-llm/swarm.ts`, "stop"],
		{ stdout: "inherit", stderr: "inherit" },
	);
	console.log("→ swarm stop (launched)");
}

// ─── dispatch ───
const cmd = process.argv[2] ?? "status";
if (cmd === "status") await cmdStatus();
else if (cmd === "start") await cmdStart();
else if (cmd === "stop") await cmdStop();
else if (cmd === "restart") {
	await cmdStop();
	await new Promise((r) => setTimeout(r, 2500));
	await cmdStart();
} else if (cmd === "prefs") {
	const f = `${HOME}/.claude/local-llm/prefs.json`;
	if (process.argv[3]) writePrefs(process.argv[3]);
	else console.log(readFileSync(f, "utf8"));
} else {
	console.log(`Usage: bun coordinator.ts {status|start|stop|restart|prefs}`);
}

function writePrefs(json: string): void {
	const f = `${HOME}/.claude/local-llm/prefs.json`;
	const cur = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
	const next = { ...cur, ...JSON.parse(json) };
	writeFileSync(f, JSON.stringify(next, null, 2));
	console.log("✓ prefs updated");
}
