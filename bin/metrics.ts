// metrics.ts — belt-collected endpoint metrics, merged from the two JSONL
// route logs belt already writes:
//   ~/.claude-insights/swarm-routing.log   (locals — router-shim/router-swarm)
//   ~/.claude/local-llm/remotes-routes.log (remotes — bin/remotes.ts route)
// A tally pass ingests only new bytes (per-log byte cursor, rotation-safe:
// shrink → wipe that source and re-read). routes is the source of truth;
// endpoint tallies are derived by SQL aggregate. metrics.db lives in the
// runtime dir (~/.claude/local-llm) — NEVER committed.
//
// CLI: bun metrics.ts [--json] — print the snapshot, then exit.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";

const HOME = process.env.HOME;
export const METRICS_DB = `${HOME}/.claude/local-llm/metrics.db`;
const SWARM_LOG = `${HOME}/.claude-insights/swarm-routing.log`;
const REMOTES_LOG = `${HOME}/.claude/local-llm/remotes-routes.log`;
export const LOCAL_NAME = hostname().replace(/\.local\.?$/, "");

export interface EndpointMetrics {
	calls: number;
	errors: number;
	avg_ms: number | null;
	last_used: string | null;
	load_5m: number;
	last_error?: string | null;
}

export interface MetricsSnapshot {
	endpoints: Record<string, EndpointMetrics>;
	recent: {
		ts: string;
		machine: string;
		port: number;
		model: string;
		role: string;
		duration_ms: number;
		ok: boolean;
	}[];
}

const KEEP_DAYS = 30;
const KEEP_ROWS = 20_000;

let db: Database | null = null;
function openDb(): Database {
	if (db) return db;
	db = new Database(METRICS_DB, { create: true });
	db.run("PRAGMA journal_mode = WAL");
	db.run(`
		CREATE TABLE IF NOT EXISTS routes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts TEXT NOT NULL,
			machine TEXT NOT NULL,
			port INTEGER NOT NULL,
			model TEXT NOT NULL DEFAULT '',
			role TEXT NOT NULL DEFAULT '',
			duration_ms INTEGER NOT NULL DEFAULT 0,
			ok INTEGER NOT NULL DEFAULT 1,
			err TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS routes_ts ON routes(ts);
		CREATE TABLE IF NOT EXISTS cursors (
			path TEXT PRIMARY KEY,
			pos INTEGER NOT NULL DEFAULT 0
		);
	`);
	return db;
}

// ─── ingestion ───

function ingestFile(
	path: string,
	source: string,
	map: (j: Record<string, unknown>) => {
		ts: string;
		machine: string;
		port: number;
		model: string;
		role: string;
		duration_ms: number;
		ok: boolean;
		err: string;
	} | null,
): void {
	const d = openDb();
	const cur = d.query("SELECT pos FROM cursors WHERE path = ?").get(path) as {
		pos: number;
	} | null;
	let pos = cur?.pos ?? 0;
	const size = existsSync(path) ? statSync(path).size : 0;
	if (size < pos) {
		// rotated/truncated — drop this source's rows and re-read everything
		d.run("DELETE FROM routes WHERE source = ?", [source]);
		pos = 0;
	}
	if (size === pos) return;
	const buf = readFileSync(path).subarray(pos);
	const text = `${buf.toString("utf8")}`;
	// last line may be partial — hand the offset back to just after the last \n
	const cut = text.lastIndexOf("\n");
	const whole = cut >= 0 ? text.slice(0, cut + 1) : "";
	for (const line of whole.split("\n")) {
		if (!line.trim()) continue;
		try {
			const row = map(JSON.parse(line) as Record<string, unknown>);
			if (row)
				d.run(
					"INSERT INTO routes (ts, machine, port, model, role, duration_ms, ok, err, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
					[
						row.ts,
						row.machine,
						row.port,
						row.model,
						row.role,
						row.duration_ms,
						row.ok ? 1 : 0,
						row.err,
						source,
					],
				);
		} catch {
			// malformed line — skip, never fail the tally pass
		}
	}
	const newPos = pos + Buffer.byteLength(whole, "utf8");
	if (size < newPos) return; // file shrank mid-read; retry next pass
	d.run(
		"INSERT INTO cursors (path, pos) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET pos = excluded.pos",
		[path, newPos],
	);
}

/** One tally pass: pull new lines from both route logs into the db, prune
 *  old/overflowing rows. Cheap when nothing new (two stat() calls). */
export function tallyMetrics(): void {
	// locals: port 0 = cloud escalation (keep, machine "cloud"); outcome set
	// only on failure ("empty")
	ingestFile(SWARM_LOG, "swarm", (j) => ({
		ts: String(j.ts ?? ""),
		machine: j.port === 0 ? "cloud" : LOCAL_NAME,
		port: Number(j.port ?? 0),
		model: String(j.model ?? ""),
		role: String(j.category ?? ""),
		duration_ms: Number(j.duration_ms ?? 0),
		ok: !j.outcome,
		err: String(j.outcome ?? ""),
	}));
	ingestFile(REMOTES_LOG, "remotes", (j) => {
		const port = Number(
			String(j.endpoint ?? "")
				.split(":")
				.pop(),
		);
		return {
			ts: String(j.ts ?? ""),
			machine: String(j.machine ?? ""),
			port: Number.isFinite(port) ? port : 0,
			// legacy lines carry no model — they key under machine:port with ''
			model: String(j.model ?? ""),
			role: String(j.role ?? ""),
			duration_ms: Number(j.duration_ms ?? 0),
			ok: j.ok !== false,
			err: j.ok === false ? "error" : "",
		};
	});
	const d = openDb();
	const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
	d.run("DELETE FROM routes WHERE ts < ?", [cutoff]);
	d.run(
		"DELETE FROM routes WHERE id NOT IN (SELECT id FROM routes ORDER BY id DESC LIMIT ?)",
		[KEEP_ROWS],
	);
}

/** Weighted merge of several endpoints' metrics (port- or machine-level
 *  aggregates; avg_ms re-averaged by call count). */
function mergeMetrics(list: EndpointMetrics[]): EndpointMetrics {
	let calls = 0;
	let errors = 0;
	let load = 0;
	let totalMs = 0;
	let lastUsed: string | null = null;
	let lastError: string | null = null;
	for (const e of list) {
		calls += e.calls;
		errors += e.errors;
		load += e.load_5m;
		totalMs += (e.avg_ms ?? 0) * e.calls;
		if ((e.last_used ?? "") > (lastUsed ?? "")) lastUsed = e.last_used;
		if ((e.last_error ?? "") > (lastError ?? "")) lastError = e.last_error;
	}
	return {
		calls,
		errors,
		load_5m: load,
		avg_ms: calls ? Math.round(totalMs / calls) : null,
		last_used: lastUsed,
		last_error: lastError,
	};
}

// ─── snapshot ───

const agg = `
	SELECT machine, port, model,
	       COUNT(*) AS calls,
	       SUM(ok = 0) AS errors,
	       AVG(duration_ms) AS avg_ms,
	       MAX(ts) AS last_used
	FROM routes GROUP BY machine, port, model`;

const loadQ = `
	SELECT machine, port, model, COUNT(*) AS n
	FROM routes WHERE ts > ? GROUP BY machine, port, model`;

const lastErrQ = `
	SELECT machine, port, model, err, MAX(ts) AS ets
	FROM routes WHERE ok = 0 GROUP BY machine, port, model`;

const recentQ = `
	SELECT ts, machine, port, model, role, duration_ms, ok
	FROM routes ORDER BY id DESC LIMIT 12`;

function buildSnapshot(): MetricsSnapshot {
	const d = openDb();
	const endpoints: Record<string, EndpointMetrics> = {};
	const key = (m: string, p: number, mod: string): string => `${m}:${p}:${mod}`;
	for (const r of d.query(agg).all() as {
		machine: string;
		port: number;
		model: string;
		calls: number;
		errors: number;
		avg_ms: number;
		last_used: string;
	}[]) {
		endpoints[key(r.machine, r.port, r.model)] = {
			calls: r.calls,
			errors: r.errors,
			avg_ms: Math.round(r.avg_ms),
			last_used: r.last_used,
			load_5m: 0,
			last_error: null,
		};
	}
	const fiveMinAgo = new Date(Date.now() - 300_000).toISOString();
	for (const r of d.query(loadQ).all(fiveMinAgo) as {
		machine: string;
		port: number;
		model: string;
		n: number;
	}[]) {
		const e = endpoints[key(r.machine, r.port, r.model)];
		if (e) e.load_5m = r.n;
	}
	for (const r of d.query(lastErrQ).all() as {
		machine: string;
		port: number;
		model: string;
		err: string;
	}[]) {
		const e = endpoints[key(r.machine, r.port, r.model)];
		if (e) e.last_error = r.err || "error";
	}
	const recent = (
		d.query(recentQ).all() as {
			ts: string;
			machine: string;
			port: number;
			model: string;
			role: string;
			duration_ms: number;
			ok: number;
		}[]
	).map((r) => ({ ...r, ok: !!r.ok }));
	return { endpoints, recent };
}

let cache: { snap: MetricsSnapshot; at: number } | null = null;
const TTL_MS = 5_000;

/** Cached metrics snapshot — one tally pass + aggregate per 5 s max. */
export function metricsSnapshot(): MetricsSnapshot {
	if (cache && Date.now() - cache.at < TTL_MS) return cache.snap;
	tallyMetrics();
	cache = { snap: buildSnapshot(), at: Date.now() };
	return cache.snap;
}

const EMPTY: EndpointMetrics = {
	calls: 0,
	errors: 0,
	avg_ms: null,
	last_used: null,
	load_5m: 0,
	last_error: null,
};

/** Fold metrics for one row: exact (machine, port, model) first, then any
 *  model on that machine:port, then the whole machine (port omitted). */
export function metricsFor(
	machine: string,
	port?: number,
	model?: string | null,
): EndpointMetrics {
	const { endpoints } = metricsSnapshot();
	if (model) {
		const exact = endpoints[`${machine}:${port}:${model}`];
		if (exact) return exact;
	}
	if (port != null) {
		const anyModel = Object.entries(endpoints)
			.filter(([k]) => k.startsWith(`${machine}:${port}:`))
			.map(([, e]) => e);
		if (anyModel.length) return mergeMetrics(anyModel);
	}
	if (port == null) {
		const all = Object.entries(endpoints)
			.filter(([k]) => k.startsWith(`${machine}:`))
			.map(([, e]) => e);
		if (all.length) return mergeMetrics(all);
	}
	return EMPTY;
}

if (import.meta.main) {
	const snap = metricsSnapshot();
	if (process.argv.includes("--json")) console.log(JSON.stringify(snap));
	else
		console.table(
			Object.entries(snap.endpoints).map(([k, e]) => ({ endpoint: k, ...e })),
		);
}
