// log.ts — W283: level-gated logger for the belt fleet.
//
// launchd captures stdout/stderr to flat files with no level info; this
// gives every call site a ts+level prefix and a single LOG_LEVEL knob
// (error < warn < info < debug, default info) so noisy debug output can be
// silenced fleet-wide without touching call sites.
//
//   import { error, warn, info, debug } from "./log.ts";
//   info("swarm starting", { port: 8901 });
//
// All levels write to stderr — stdout stays reserved for command output
// callers may want to pipe (e.g. `swarm.ts status --json`).

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;

function currentLevel(): Level {
	const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
	return raw in LEVELS ? (raw as Level) : "info";
}

function emit(level: Level, args: unknown[]): void {
	if (LEVELS[level] > LEVELS[currentLevel()]) return;
	const ts = new Date().toISOString();
	console.error(`${ts} [${level}]`, ...args);
}

export const error = (...args: unknown[]): void => emit("error", args);
export const warn = (...args: unknown[]): void => emit("warn", args);
export const info = (...args: unknown[]): void => emit("info", args);
export const debug = (...args: unknown[]): void => emit("debug", args);
