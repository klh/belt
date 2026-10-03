#!/usr/bin/env bun
// swarm.ts — unified LLM specialist swarm manager.
// Bun/TS only. Model/ports come from registry.ts (single source of truth).
//
// Usage:
//   bun swarm.ts start       — start all specialists + router
//   bun swarm.ts stop        — stop everything
//   bun swarm.ts status      — show running specialists
//   bun swarm.ts download    — download all specialist models
//   bun swarm.ts restart     — stop + start
//   bun swarm.ts supervise   — long-running self-heal loop (launchd KeepAlive):
//                              respawns the :4000 shim, resident specialists
//                              and the :4100 litellm engine with backoff +
//                              circuit breaker (supervisor.ts). `serve` is an
//                              alias (com.suspenders.local-llm runs `serve`).

import { spawn, execSync } from "node:child_process";
import { SPECIALISTS, DOWNLOAD_MODELS, residentSet } from "./registry.ts";
import { LITELLM_PORT } from "./litellm-target.ts";
import { spawnArgs, mlxLogPath } from "./spawner.ts";
import {
	fleetTargets,
	otherSupervisorAlive,
	readStatus,
	STATUS_FILE,
	Supervisor,
	TRANSITION_LOG,
} from "./supervisor.ts";
import { info } from "./log.ts";

const HOME = process.env.HOME;
// download-only — server argv lives in spawner.ts (spawnArgs), shared with the
// router's on-demand path so boot and demand can't drift.
const MLX_PYTHON = `${HOME}/.local/share/uv/tools/mlx-lm/bin/python`;
const LOG_DIR = `${HOME}/.claude-insights`;
const ROUTER = `${HOME}/.claude/local-llm/router-shim.ts`;

// ─── helpers ───
const isUp = async (port: number): Promise<boolean> => {
	try {
		// Any HTTP response = listening. The router (:4000) answers 404 on
		// /v1/models by design — it only implements Anthropic /v1/messages.
		await fetch(`http://localhost:${port}/v1/models`, {
			signal: AbortSignal.timeout(1000),
		});
		return true;
	} catch {
		return false;
	}
};

const getModel = async (port: number): Promise<string> => {
	try {
		const r = await fetch(`http://localhost:${port}/v1/models`, {
			signal: AbortSignal.timeout(1000),
		});
		const j = await r.json();
		return j.data?.[0]?.id ?? "?";
	} catch {
		return "down";
	}
};

const killPort = (port: number): void => {
	try {
		execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null`, {
			stdio: "pipe",
		});
	} catch {}
};

// mlx_lm /v1/models lists the whole HF cache (first id ≠ served model) —
// verify the actually-loaded model from the process args instead.
const psModel = (port: number): string | null => {
	const pid = Bun.spawnSync(["lsof", "-ti", `:${port}`])
		.stdout.toString()
		.trim()
		.split("\n")[0];
	if (!pid) return null;
	const cmd = Bun.spawnSync([
		"ps",
		"-o",
		"command",
		"-p",
		pid,
	]).stdout.toString();
	return cmd.match(/--model\s+(\S+)/)?.[1] ?? null;
};

// ─── lifecycle ───
async function cmdStart(): Promise<void> {
	console.log("🚀 Starting specialist swarm…");

	// Fire-and-forget: spawn all MLX servers + router, then exit immediately.
	// Specialists load in the background; check readiness with `swarm.ts status`.
	// BELT_TIER=minimal scopes this to the ≤4GB residents (extract + rerank).
	const resident = residentSet();

	for (const s of resident) {
		if (await isUp(s.port)) {
			console.log(`  ✓ :${s.port} ${s.label} (already running)`);
			continue;
		}
		console.log(`  → :${s.port} ${s.label} (loading in background)`);
		const log = mlxLogPath(s.port);
		const shellCmd = `nohup ${spawnArgs(s).join(" ")} >> ${log} 2>&1 &`;
		Bun.spawn(["/bin/sh", "-c", shellCmd], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
	}

	// Router
	const routerUp = await isUp(4000);
	if (!routerUp) {
		console.log("  → :4000 router-swarm (starting)");
		const shellCmd = `nohup bun ${ROUTER} >> ${LOG_DIR}/mlx-router.log 2>&1 &`;
		Bun.spawn(["/bin/sh", "-c", shellCmd], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
	} else {
		console.log("  ✓ :4000 router (already running)");
	}

	console.log("\n  All specialists spawning in background.");
	console.log("  Check readiness: bun ~/.claude/local-llm/swarm.ts status");
	process.exit(0);
}

async function cmdSupervise(): Promise<void> {
	const other = otherSupervisorAlive();
	if (other) {
		info(`supervisor already running (pid ${other}) — exiting`);
		return;
	}
	const sup = new Supervisor(fleetTargets(), {
		statusFile: STATUS_FILE,
		logFile: TRANSITION_LOG,
	});
	// Children are services, not session state: leave them running on
	// SIGTERM so a supervisor restart adopts them (probe-up) instead of
	// reloading 40GB of weights.
	for (const sig of ["SIGTERM", "SIGINT"] as const)
		process.on(sig, () => sup.stop());
	info(`🩺 supervising → ${STATUS_FILE}`);
	await sup.run();
}

async function cmdStop(): Promise<void> {
	console.log("🛑 Stopping swarm…");
	// Stop the supervisor first or it would respawn what we kill.
	const sup = readStatus()?.supervisorPid;
	if (sup && sup !== process.pid) {
		try {
			process.kill(sup, "SIGTERM");
		} catch {}
	}
	killPort(4000);
	killPort(LITELLM_PORT);
	for (const s of SPECIALISTS) killPort(s.port);
	console.log("  All stopped.");
}

async function cmdStatus(): Promise<void> {
	console.log("📊 Swarm status:\n");
	let total_ram = 0;
	for (const s of SPECIALISTS) {
		const up = await isUp(s.port);
		const model = up
			? s.engine === "rapid"
				? await getModel(s.port)
				: (psModel(s.port) ?? "down")
			: "down";
		const tier = s.tier === "resident" ? "" : " (on demand)";
		if (up) total_ram += s.ram_gb;
		console.log(
			`  ${up ? "✓" : "✗"} :${s.port}  ${s.label.padEnd(15)} ${model.replace("mlx-community/", "")}${tier}`,
		);
	}
	const routerUp = await isUp(4000);
	console.log(`  ${routerUp ? "✓" : "✗"} :4000  router (Anthropic API)`);
	console.log(`\n  RAM in use: ~${total_ram.toFixed(1)}GB / 128GB`);
}

async function cmdDownload(): Promise<void> {
	console.log(
		`📥 Downloading ${DOWNLOAD_MODELS.length} models (~61GB total)…\n`,
	);
	const procs = DOWNLOAD_MODELS.map((model) => {
		const name = model.split("/")[1];
		console.log(`  → ${name}…`);
		return spawn(
			MLX_PYTHON,
			[
				"-c",
				`from huggingface_hub import snapshot_download; snapshot_download("${model}")`,
			],
			{ stdio: "pipe" },
		);
	});
	await Promise.all(
		procs.map((p) => new Promise((resolve) => p.on("exit", resolve))),
	);
	console.log("\n✓ All downloads complete");
}

// ─── dispatch ───
const cmd = process.argv[2] ?? "status";
switch (cmd) {
	case "start":
		await cmdStart();
		break;
	case "stop":
		await cmdStop();
		break;
	case "status":
		await cmdStatus();
		break;
	case "restart":
		await cmdStop();
		await new Promise((r) => setTimeout(r, 2000));
		await cmdStart();
		break;
	case "download":
		await cmdDownload();
		break;
	case "supervise":
	case "serve":
		await cmdSupervise();
		break;
	default:
		console.log(
			`Usage: bun swarm.ts {start|stop|status|restart|download|supervise}\n`,
		);
		console.log(`Specialists (from registry.ts):`);
		for (const s of SPECIALISTS) {
			console.log(`  :${s.port}  ${s.label}  (${s.ram_gb}GB, ${s.tier})`);
		}
		console.log(`  :4000  router (Anthropic API entrypoint)`);
}
