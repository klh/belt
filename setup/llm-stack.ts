#!/usr/bin/env bun
// llm-stack.ts — from-scratch local LLM fleet setup for a new Apple Silicon Mac.
//
// Idempotent: safe to re-run; every step checks before it acts.
// All external processes are spawned with argument arrays (no shell strings).
//
//   bun setup/llm-stack.ts                  # deps + models + metal smoke check
//   bun setup/llm-stack.ts --with-launchd   # + fleet plists + coordination plane
//   bun setup/llm-stack.ts --dry-run        # print commands, run nothing
//   bun setup/llm-stack.ts --skip-download  # deps only (models already present)

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SPECIALISTS as FLEET, DOWNLOAD_MODELS } from "../bin/registry.ts";

const DRY = process.argv.includes("--dry-run");
const SKIP_DL = process.argv.includes("--skip-download");
const WITH_LAUNCHD = process.argv.includes("--with-launchd");

const HOME = homedir();
const UV = "/opt/homebrew/bin/uv";
const BREW = "/opt/homebrew/bin/brew";
const MLX_PY = `${HOME}/.local/share/uv/tools/mlx-lm/bin/python`;
const HF_PY = "3.13"; // pin: brew python moves break uv tool symlinks otherwise

function sh(cmd: string[]): Promise<number> {
  const printable = cmd.join(" ");
  if (DRY) {
    console.log(`  [dry] ${printable}`);
    return Promise.resolve(0);
  }
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  return p.exited;
}

async function which(name: string): Promise<string | null> {
  const p = Bun.spawn(["which", name], { stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([
    new Response(p.stdout).text(),
    p.exited,
  ]);
  return code === 0 ? out.trim() : null;
}

// ─── steps ───

async function stepDeps(): Promise<void> {
  console.log("\n1) Homebrew deps (bun, uv)");
  if (!existsSync(BREW)) {
    console.error(
      "  Homebrew not found at /opt/homebrew. Install it first: https://brew.sh",
    );
    process.exit(1);
  }
  for (const [name, path] of [
    ["bun", "/opt/homebrew/bin/bun"],
    ["uv", UV],
  ] as const) {
    if (existsSync(path)) {
      console.log(`  ✓ ${name}`);
      continue;
    }
    console.log(`  → installing ${name}`);
    if ((await sh([BREW, "install", name])) !== 0) process.exit(1);
  }
}

async function stepTools(): Promise<void> {
  console.log(
    "\n2) Python tooling via uv (python pinned — see uv symlink gotcha)",
  );
  const mlxInstalled = existsSync(MLX_PY);
  if (mlxInstalled) console.log("  ✓ mlx-lm");
  else if (
    (await sh([
      UV,
      "tool",
      "install",
      "--force",
      "--python",
      HF_PY,
      "mlx-lm",
    ])) !== 0
  )
    process.exit(1);
  if (await which("rapid-mlx")) console.log("  ✓ rapid-mlx");
  else if (
    (await sh([
      UV,
      "tool",
      "install",
      "--force",
      "--python",
      HF_PY,
      "rapid-mlx",
    ])) !== 0
  )
    process.exit(1);
}

async function stepModels(): Promise<void> {
  if (SKIP_DL) {
    console.log("\n3) Models — skipped (--skip-download)");
    return;
  }
  console.log("\n3) Model downloads (parallel, ~40-60GB total)");
  const models = [...new Set(DOWNLOAD_MODELS)];
  const procs = models.map((m) => {
    console.log(`  → ${m.replace("mlx-community/", "")}`);
    return Bun.spawn(
      [
        MLX_PY,
        "-c",
        `from huggingface_hub import snapshot_download; snapshot_download("${m}")`,
      ],
      { stdout: "inherit", stderr: "inherit" },
    ).exited;
  });
  const codes = DRY ? [] : await Promise.all(procs);
  if (codes.some((c) => c !== 0)) {
    console.error("  one or more downloads failed");
    process.exit(1);
  }
}

async function stepMetalCheck(): Promise<void> {
  if (DRY || !existsSync(MLX_PY)) return;
  console.log("\n4) Metal smoke check");
  const p = Bun.spawn(
    [MLX_PY, "-c", "import mlx.core as mx; print(mx.default_device())"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(p.stdout).text();
  await p.exited;
  console.log(`  default device: ${out.trim() || "(mlx import failed)"}`);
  console.log("  tip: raise the wired limit before long-context serving —");
  console.log(
    "  mx.metal.set_wired_limit(...) prevents paging stalls on big batches.",
  );
}

async function stepLaunchd(): Promise<void> {
  if (!WITH_LAUNCHD) return;
  console.log("\n5) launchd plists (KeepAlive) → ~/Library/LaunchAgents");
  const logDir = `${HOME}/.claude-insights`;
  if (!DRY) await Bun.$`mkdir -p ${logDir}`.quiet().catch(() => {});
  for (const f of FLEET.filter((x) => x.engine === "rapid" && x.tier === "resident")) {
    const label = `com.belt.llm-${f.port}`;
    const plistPath = join(HOME, "Library", "LaunchAgents", `${label}.plist`);
    const args = [
      "rapid-mlx",
      "serve",
      f.model,
      "--host",
      "127.0.0.1",
      "--port",
      String(f.port),
      ...(f.flags ?? []),
    ];
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${a}</string>`).join("")}</array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${logDir}/mlx-${f.port}.log</string>
  <key>StandardErrorPath</key><string>${logDir}/mlx-${f.port}.log</string>
</dict></plist>`;
    console.log(`  → ${plistPath}`);
    if (!DRY) {
      await Bun.write(plistPath, plist);
      await sh(["/bin/launchctl", "load", plistPath]);
    }
  }
  console.log(
    "  note: keep ProgramArguments absolute — launchd does not inherit your PATH.",
  );
}

// ─── coordination plane: governor.db + coord CLIs + launchd agents ───
// All of this ships in klh/suspenders (extracted from speedy 2026-09-25) —
// speedy never installs its own copies: it verifies the namespaced install
// and delegates missing launchd agents to suspenders' installer.
async function stepCoordination(): Promise<void> {
  console.log(
    "\n6) coordination plane (governor.db, coord CLIs, launchd agents — via klh/suspenders)",
  );
  const bun = "/opt/homebrew/bin/bun";
  const prefix = join(HOME, ".claude", "hooks", "suspenders");
  const govdb = join(prefix, "lib", "govdb.ts");
  const coord = join(prefix, "bin", "coord.ts");
  const agents = [
    "com.suspenders.fleet-monitor",
    "com.suspenders.llm-keepwarm",
    "com.suspenders.board",
    "com.suspenders.db-backup",
  ];

  if (DRY) {
    console.log(
      "  → would verify the klh/suspenders install under ~/.claude/hooks/suspenders/",
    );
    console.log(
      "  → would bootstrap governor.db and delegate missing launchd agents",
    );
    return;
  }

  if (!existsSync(govdb) || !existsSync(coord)) {
    console.error(`  ✗ suspenders is not installed (expected ${prefix}/)`);
    console.error(
      "    install it first: git clone https://github.com/klh/suspenders && cd suspenders && ./install.sh --wire --with-launchd",
    );
    process.exitCode = 1;
    return;
  }

  // 1) control-plane DB: suspenders' govdb.ts is the single schema definer —
  //    it creates the schema and runs migrations; nothing is created here.
  await sh([
    bun,
    "-e",
    `import { openGovernorDb } from "${govdb}"; openGovernorDb(); console.log("  ✓ governor.db ready");`,
  ]);

  // 2) launchd agents (fleet monitor, LLM keepwarm, board keep-alive, db
  //    backups) belong to suspenders — delegate to its installer when the
  //    com.suspenders.* labels are missing. Its installer supersedes the
  //    legacy com.klh.llm-keepwarm / com.klh.fleet-monitor jobs.
  const missing = agents.filter(
    (a) => !existsSync(join(HOME, "Library", "LaunchAgents", `${a}.plist`)),
  );
  if (missing.length > 0) {
    console.log(`  → missing launchd agents: ${missing.join(", ")}`);
    const src = join(HOME, ".cache", "suspenders-src");
    const fresh =
      existsSync(join(src, "install.sh")) &&
      (await sh(["/usr/bin/git", "-C", src, "pull", "--ff-only"])) === 0;
    if (!fresh) {
      await sh([
        "/usr/bin/git",
        "clone",
        "--depth",
        "1",
        "https://github.com/klh/suspenders",
        src,
      ]);
    }
    // install.sh resolves its own dir — safe from any cwd
    if ((await sh(["/bin/bash", join(src, "install.sh"), "--with-launchd"])) !== 0) {
      console.error("  ✗ suspenders install.sh --with-launchd failed");
      process.exitCode = 1;
      return;
    }
  } else {
    console.log("  ✓ com.suspenders.* launchd agents installed");
  }

  // 3) smoke: one fact write through the real path
  await sh([
    bun,
    coord,
    "fact",
    "set",
    "setup.done",
    new Date().toISOString(),
    "--source",
    "llm-stack",
  ]).catch(() => {});
  console.log("  ✓ coordination plane ready — provided by klh/suspenders");
}

// ─── run ───
console.log("Local LLM fleet setup (docs/routing.md, docs/add-a-model.md)");
await stepDeps();
await stepTools();
await stepModels();
await stepMetalCheck();
await stepLaunchd();
await stepCoordination();
console.log(
  "\n✓ done. Next: start the fleet (`rapid-mlx serve …` per model or via your",
);
console.log(
  "  registry-driven swarm script) and run the 4-prompt bench to log a baseline.",
);
