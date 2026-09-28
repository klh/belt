#!/usr/bin/env bun
// watchdog.ts — §6 agent progress watchdog for the local-llm coordinator.
//
// Heartbeat contract: agents POST to the daemon or use the CLI:
//   bun watchdog.ts report '{"sid":"a1","task":"refactor x","milestone":"edit-loop","files":["/a.ts"]}'
//   bun watchdog.ts status
//   bun watchdog.ts daemon       (long-running; launchd KeepAlive)
//
// Policy:
//   - overdue  = no heartbeat for 5min → flagged
//   - revoke   = no heartbeat for 7min → leases removed from governor locks
//   - stalled  = same milestone across 3 consecutive reports → flagged
//   - waiting  = heartbeat with {waiting:"user"|"long-task", until:<epoch-ms>}
//                is exempt until that deadline (max 30min)

import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";

const CACHE = `${process.env.HOME}/.cache/claude-governor`;
const HB_FILE = `${CACHE}/heartbeats.json`;
const LOCKS_FILE = `${CACHE}/locks.json`;
const REVOKE_LOG = `${CACHE}/revocations.log`;

type Heartbeat = {
  sid: string;
  task?: string;
  milestone?: string;
  files?: string[];
  waiting?: string;
  until?: number;
  ts: number;             // epoch ms of last report
  seen: number;           // consecutive same-milestone count
  notified?: boolean;     // reserved: flag-once bookkeeping
};

type Locks = Record<string, { sid: string; tool: string; ts: number }>;

const load = <T>(f: string, fallback: T): T => {
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; }
};
const save = (f: string, v: unknown): void => {
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(f, JSON.stringify(v, null, 2));
};

const OVERDUE_MS = 5 * 60_000;
const REVOKE_MS = 7 * 60_000;
const MAX_WAIT_MS = 30 * 60_000;

function revokeLeases(sid: string, reason: string): number {
  const locks = load<Locks>(LOCKS_FILE, {});
  let n = 0;
  for (const [path, lease] of Object.entries(locks)) {
    if (lease.sid === sid) { delete locks[path]; n++; }
  }
  if (n > 0) {
    writeFileSync(LOCKS_FILE, JSON.stringify(locks, null, 2));
    appendFileSync(REVOKE_LOG, JSON.stringify({ ts: new Date().toISOString(), sid, reason, leases_revoked: n }) + "\n");
  }
  return n;
}

function sweep(now = Date.now()): { overdue: string[]; revoked: string[] } {
  const hbs = load<Record<string, Heartbeat>>(HB_FILE, {});
  const overdue: string[] = [];
  const revoked: string[] = [];
  for (const [sid, hb] of Object.entries(hbs)) {
    const age = now - hb.ts;
    const waiting = hb.waiting && (hb.until ?? 0) > now && (hb.until - hb.ts) <= MAX_WAIT_MS;
    if (waiting) continue;
    if (hb.seen != null && hb.seen >= 3) overdue.push(sid);          // stalled: 3× same milestone
    if (age > REVOKE_MS) {
      const n = revokeLeases(sid, `no heartbeat ${Math.round(age / 60000)}min`);
      if (n > 0) revoked.push(sid);
      overdue.push(sid);
    } else if (age > OVERDUE_MS) {
      overdue.push(sid);
    }
  }
  return { overdue, revoked };
}

// ─── CLI ───
const cmd = process.argv[2] ?? "status";
const arg = process.argv[3];

if (cmd === "report") {
  const raw = arg ?? readFileSync(0, "utf8");
  const input = JSON.parse(raw);
  if (!input.sid) { console.error("heartbeat JSON must include sid"); process.exit(1); }
  const hbs = load<Record<string, Heartbeat>>(HB_FILE, {});
  const prev = hbs[input.sid];
  hbs[input.sid] = {
    sid: input.sid,
    task: String(input.task ?? prev?.task ?? ""),
    milestone: String(input.milestone ?? prev?.milestone ?? ""),
    files: Array.isArray(input.files) ? input.files.map(String) : prev?.files ?? [],
    waiting: input.waiting ? String(input.waiting) : undefined,
    until: typeof input.until === "number" ? input.until : undefined,
    ts: Date.now(),
    seen: input.milestone && prev?.milestone === input.milestone ? (prev?.seen ?? 0) + 1 : 1,
    notified: false,
  };

  save(HB_FILE, hbs);
  console.log(`✓ heartbeat recorded: ${input.sid} (streak ${hbs[input.sid].seen})`);
  process.exit(0);
}

if (cmd === "status") {
  const { overdue, revoked } = sweep();
  const hbs = load<Record<string, Heartbeat>>(HB_FILE, {});
  console.log("🐕 watchdog status:");
  const now = Date.now();
  if (Object.keys(hbs).length === 0) console.log("  (no heartbeats)");
  for (const [sid, hb] of Object.entries(hbs)) {
    const age = Math.round((now - hb.ts) / 1000);
    const ageMin = age > 90 ? `${Math.round(age / 60)}min` : `${age}s`;
    const flags = overdue.includes(sid) ? " ⚠️" : revoked.includes(sid) ? " 🚫" : "";
    console.log(`  ${sid}  ${ageMin.padStart(6)}  ${String(hb.task ?? "").slice(0, 40)} @ ${hb.milestone ?? "?"}${flags}`);
  }
  process.exit(0);
}

// ─── daemon (launchd KeepAlive) ───
setInterval(sweep, 30_000);
console.log(`watchdog daemon: sweeping every 30s (overdue ${OVERDUE_MS / 60000}min, revoke ${REVOKE_MS / 60000}min)`);
