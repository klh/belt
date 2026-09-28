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

import { spawn, execSync } from "node:child_process";
import { SPECIALISTS, DOWNLOAD_MODELS, residentSet } from "./registry.ts";

const HOME = process.env.HOME;
const MLX_PYTHON = `${HOME}/.local/share/uv/tools/mlx-lm/bin/python`;
// rapid-mlx 0.15.0 via uv tool env — absolute path so launchd never needs PATH
// (brew formula still on 0.14.3; benched 2026-09-23: 115.9 vs 107.4 tok/s
// under load, flat vs quiet-machine — adopted for flags/aliases, not speed).
const RAPID = `${HOME}/.local/share/uv/tools/rapid-mlx/bin/rapid-mlx`;
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
    const log = `${LOG_DIR}/mlx-${s.port}.log`;
    if (s.engine === "rapid") {
      const args = [
        RAPID,
        "serve",
        s.model,
        "--host",
        "127.0.0.1",
        "--port",
        String(s.port),
        ...(s.flags ?? []),
      ];
      Bun.spawn(["/bin/sh", "-c", `nohup ${args.join(" ")} >> ${log} 2>&1 &`], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    } else {
      const args = [
        MLX_PYTHON,
        "-m",
        "mlx_lm.server",
        "--port",
        String(s.port),
        "--model",
        s.model,
        "--prompt-cache-size",
        "10",
        "--prompt-cache-bytes",
        "4GB",
        ...(s.flags ?? []),
      ];
      const shellCmd = `nohup ${args.join(" ")} >> ${log} 2>&1 &`;
      Bun.spawn(["/bin/sh", "-c", shellCmd], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
    }
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

async function cmdStop(): Promise<void> {
  console.log("🛑 Stopping swarm…");
  killPort(4000);
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
  default:
    console.log(`Usage: bun swarm.ts {start|stop|status|restart|download}\n`);
    console.log(`Specialists (from registry.ts):`);
    for (const s of SPECIALISTS) {
      console.log(`  :${s.port}  ${s.label}  (${s.ram_gb}GB, ${s.tier})`);
    }
    console.log(`  :4000  router (Anthropic API entrypoint)`);
}
