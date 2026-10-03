#!/usr/bin/env bun
// fleet-refresh.ts — mechanized W228 fleet-refresh flow (W295). Repeatable,
// tunable A/B of challenger weights vs the slot incumbent:
//
//   bun bin/fleet-refresh.ts status --gb <id>=<n>[,<id>=<n>…]
//   bun bin/fleet-refresh.ts pull <model-id>
//   bun bin/fleet-refresh.ts ab --candidate <id> --incumbent-port <p> \
//        --incumbent-model <id> [--candidate-gb <n>] [--candidate-port 8916] \
//        [--margin 0.05] [--keep]
//
// Laws encoded (2026-10-03): AC power only; the incumbent is RE-BENCHED
// same-day under recorded load (an old median is not a fair baseline);
// medians decide with a noise margin; the loser's weights are DELETED from
// the HF cache (rapid-mlx rm -y) unless --keep; a candidate identical to the
// incumbent is never deleted (self-A/B guard). Winner swap into the slot
// stays a manual registry/service step — printed, not guessed.

import {
	mkdirSync,
	existsSync,
	readFileSync,
	writeFileSync,
	openSync,
} from "node:fs";

const HF_HUB = `${process.env.HOME}/.cache/huggingface/hub`;
const STATE = `${process.env.HOME}/.cache/rapid-mlx/fleet-refresh-state.json`;
const BIN = import.meta.dir;

interface Model {
	id: string;
	org: string;
	name: string;
}
function model(id: string): Model {
	const [org, name] = id.split("/");
	if (!org || !name) throw new Error(`model id must be org/name, got: ${id}`);
	return { id, org, name };
}
const cacheDir = (m: Model) => `${HF_HUB}/models--${m.org}--${m.name}`;

function runOut(argv: string[]): string {
	return Bun.spawnSync(argv).stdout.toString().trim();
}

// ---- pure helpers (unit-tested) ----

export type Verdict = "win" | "lose" | "tie";
export function verdictOf(cand: number, inc: number, margin: number): Verdict {
	if (cand > inc * (1 + margin)) return "win";
	if (cand < inc * (1 - margin)) return "lose";
	return "tie";
}

export function parseMedian(stdout: string): number {
	const m = stdout.match(/median: ([\d.]+) tok\/s/);
	if (!m) throw new Error(`no median line in bench-suite output`);
	return Number(m[1]);
}

export function parseLoadavg(stdout: string): number {
	const m = stdout.match(/[\d.]+/);
	return m ? Number(m[0]) : -1;
}

export interface StallInput {
	prevBytes: number;
	nowBytes: number;
	prevTs: number;
	nowTs: number;
	expectedBytes: number;
}
export function isStalled(i: StallInput): boolean {
	const grew = i.nowBytes > i.prevBytes * 1.005;
	const gapMs = i.nowTs - i.prevTs;
	const incomplete = i.nowBytes < i.expectedBytes * 0.95;
	return !grew && gapMs > 15 * 60_000 && incomplete;
}

// ---- infra checks ----

function assertAcPower(): void {
	const ps = runOut(["pmset", "-g", "ps"]);
	if (!/AC Power/i.test(ps)) {
		console.error("fleet-refresh: on battery — benching is AC-only, abort.");
		process.exit(1);
	}
	const gate = "/tmp/bench-ac-ok";
	if (!existsSync(gate)) writeFileSync(gate, "ac\n");
}

function loadavg(): number {
	return parseLoadavg(runOut(["sysctl", "-n", "vm.loadavg"]));
}

function cacheBytes(m: Model): number {
	// hf 2.x layout: snapshot → blob symlink → real shard. Plain du sees 416K
	// (symlink inodes); du -L double-counts. Sum RESOLVED sizes of snapshot
	// entries, deduped by target. BSD stat (macOS fleet).
	const snap = `${cacheDir(m)}/snapshots`;
	const find = Bun.spawnSync(["find", snap, "-type", "f", "-o", "-type", "l"]);
	const seen = new Set<string>();
	let bytes = 0;
	for (const e of find.stdout.toString().split("\n")) {
		if (!e) continue;
		const rl = Bun.spawnSync(["readlink", "-f", e]);
		const key = rl.exitCode === 0 ? rl.stdout.toString().trim() : e;
		if (!key || seen.has(key)) continue;
		seen.add(key);
		const st = Bun.spawnSync(["stat", "-f", "%z", key]);
		if (st.exitCode === 0) bytes += Number(st.stdout.toString().trim()) || 0;
	}
	return bytes;
}

interface StateRow {
	bytes: number;
	ts: number;
}
type StateFile = Record<string, StateRow>;
function loadState(): StateFile {
	if (!existsSync(STATE)) return {};
	return JSON.parse(readFileSync(STATE, "utf8")) as StateFile;
}
function saveState(s: StateFile): void {
	mkdirSync(`${process.env.HOME}/.cache/rapid-mlx`, { recursive: true });
	writeFileSync(STATE, JSON.stringify(s, null, 2));
}

// A/B benches are nonce-cold: identical temp-0 prompts hit rapid-mlx's
// response cache and return absurd tok/s (239k tok/s observed 2026-10-03).
// Same 4 fleet prompts as bench-suite, each leg nonce-stamped so no response
// cache can serve a previous answer.
const AB_PROMPTS = [
	"Write a TypeScript function that deduplicates an array of objects by id, keeping the last occurrence. Strict types.",
	"Write a native TypeScript web component <count-badge> with shadow DOM: attribute count, emits badge-click CustomEvent, re-renders on attribute change.",
	"Analyze the architectural trade-offs of event-driven microservices versus a modular monolith for a three-person team. Be concise.",
	"Skriv en kort og høflig e-mail til min udlejer om at varmen ikke virker.",
];

async function benchMedianNonce(port: number, id: string): Promise<number> {
	const nonce = crypto.randomUUID().slice(0, 8);
	const tps: number[] = [];
	for (const p of AB_PROMPTS) {
		const t0 = performance.now();
		const r = await fetch(`http://localhost:${port}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: id,
				max_tokens: 350,
				temperature: 0,
				stream: false,
				messages: [{ role: "user", content: `${p}\n\n[bench-nonce ${nonce}]` }],
			}),
			signal: AbortSignal.timeout(300_000),
		});
		const d = (await r.json()) as {
			usage?: { completion_tokens?: number };
		};
		const secs = (performance.now() - t0) / 1000;
		const tok = d.usage?.completion_tokens ?? 0;
		if (tok <= 0)
			throw new Error(`empty completion on :${port} — see server log`);
		tps.push(tok / secs);
	}
	return tps.sort((a, b) => a - b)[Math.floor(tps.length / 2)] ?? 0;
}

function cmdStatus(gbPairs: string[]): void {
	const state = loadState();
	const now = Date.now();
	for (const pair of gbPairs) {
		const [id, gbStr] = pair.split("=");
		const m = model(id);
		const expectedBytes = Number(gbStr) * 1e9;
		if (!expectedBytes) throw new Error(`--gb needs id=gb pairs, got: ${pair}`);
		const bytes = cacheBytes(m);
		const prev = state[id];
		let line = `${id}: ${(bytes / 1e9).toFixed(2)}/${gbStr}GB `;
		if (bytes >= expectedBytes * 0.95) {
			line += "COMPLETE";
		} else if (
			prev &&
			isStalled({
				prevBytes: prev.bytes,
				nowBytes: bytes,
				prevTs: prev.ts,
				nowTs: now,
				expectedBytes,
			})
		) {
			line += `STALLED since ${Math.round((now - prev.ts) / 60_000)}min — run: fleet-refresh pull ${id}`;
		} else if (bytes === 0) {
			line += "NOT DOWNLOADED";
		} else {
			line += "downloading";
		}
		console.log(line);
		state[id] = { bytes, ts: now };
	}
	saveState(state);
}

function cmdPull(id: string): void {
	const m = model(id);
	const log = `/tmp/rmq-pull-${m.name}.log`;
	const fd = openSync(log, "w");
	// hf download RESUMES partial blobs across restarts; rapid-mlx pull does
	// not (a dead pull loses all partial bytes — lost 13GB of the 35B twice
	// on 2026-10-03). rapid-mlx serve reads the same HF cache either way.
	const hasHf = Bun.spawnSync(["which", "hf"]).exitCode === 0;
	const argv = hasHf ? ["hf", "download", id] : ["rapid-mlx", "pull", id];
	const proc = Bun.spawn(argv, { stdout: fd, stderr: fd });
	console.log(`pull ${id} → pid ${proc.pid} (${argv[0]}), log ${log}`);
}

async function freePort(preferred: number): Promise<number> {
	for (let p = preferred; p < preferred + 10; p++) {
		try {
			const r = await fetch(`http://127.0.0.1:${p}/v1/models`, {
				signal: AbortSignal.timeout(1500),
			});
			if (r.ok) continue; // listener present, try next
		} catch {
			return p; // no listener → free
		}
	}
	throw new Error(`no free port in ${preferred}..${preferred + 9}`);
}

async function waitHealthy(port: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`http://127.0.0.1:${port}/v1/models`, {
				signal: AbortSignal.timeout(2000),
			});
			if (r.ok) return true;
		} catch {
			// not up yet
		}
		await new Promise((r) => setTimeout(r, 2000));
	}
	return false;
}

interface AbArgs {
	candidate: string;
	candidateGb?: number;
	candidatePort: number;
	incumbentPort: number;
	incumbentModel: string;
	margin: number;
	keep: boolean;
}

async function cmdAb(a: AbArgs): Promise<void> {
	assertAcPower();
	const cand = model(a.candidate);
	const inc = model(a.incumbentModel);
	const selfAb = cand.id === inc.id;
	const bytes = cacheBytes(cand);
	if (a.candidateGb && bytes < a.candidateGb * 1e9 * 0.95) {
		console.error(
			`candidate incomplete: ${(bytes / 1e9).toFixed(2)}/${a.candidateGb}GB — pull first`,
		);
		process.exit(1);
	}
	const port = await freePort(a.candidatePort);
	const log = `/tmp/rmq-${port}.log`;
	console.log(`serving ${cand.id} on :${port} (log ${log})`);
	const fd = openSync(log, "w");
	const server = Bun.spawn(
		["rapid-mlx", "serve", cand.id, "--port", String(port)],
		{
			stdout: fd,
			stderr: fd,
		},
	);
	let benchOut = "";
	try {
		if (!(await waitHealthy(port, 150_000))) {
			throw new Error(`candidate on :${port} never got healthy — see ${log}`);
		}
		const load = loadavg();
		console.log(`candidate bench (load1 ${load}):`);
		const candMed = await benchMedianNonce(port, cand.id);
		console.log(
			`incumbent re-bench :${a.incumbentPort} (same-day, nonce-cold):`,
		);
		const incMed = await benchMedianNonce(a.incumbentPort, inc.id);
		const v = verdictOf(candMed, incMed, a.margin);
		const del = !a.keep && !selfAb && v !== "win" && cand.id !== inc.id;
		console.log(
			`verdict: ${v.toUpperCase()} — candidate ${candMed.toFixed(1)} vs incumbent ${incMed.toFixed(1)} tok/s (margin ±${(a.margin * 100).toFixed(0)}%)`,
		);
		if (v === "win") {
			console.log(
				`WINNER: swap the slot to ${cand.id} (registry/service change), rerun bench-suite on the slot, then update benchmarks.md`,
			);
		} else if (del) {
			const rm = Bun.spawnSync(["rapid-mlx", "rm", cand.id, "-y"]);
			console.log(
				rm.exitCode === 0
					? `loser weights deleted: ${cand.id}`
					: `rapid-mlx rm failed (exit ${rm.exitCode}) — delete manually`,
			);
		} else if (selfAb) {
			console.log("self-A/B: deletion guard held — nothing removed");
		} else {
			console.log("--keep set — weights left in place");
		}
		benchOut = JSON.stringify({
			ts: new Date().toISOString(),
			suite: "fleet-refresh",
			model: cand.id,
			metric: "ab_verdict",
			value: candMed,
			meta: {
				incumbent: inc.id,
				incumbent_median: incMed,
				margin: a.margin,
				verdict: v,
				deleted: del,
				loadavg1: loadavg(),
				candidate_port: port,
				incumbent_port: a.incumbentPort,
			},
		});
		writeFileSync("/tmp/fleet-refresh-last.json", benchOut);
		const logAdd = Bun.spawnSync([
			"bun",
			`${BIN}/bench-log.ts`,
			"add",
			"fleet-refresh",
			cand.name.slice(0, 30),
			"ab_verdict",
			String(candMed),
			JSON.stringify({
				incumbent: inc.id,
				incumbent_median: incMed,
				verdict: v,
				deleted: del,
			}),
		]);
		if (logAdd.exitCode !== 0)
			console.error(
				"bench-log add failed (record in /tmp/fleet-refresh-last.json)",
			);
	} finally {
		server.kill();
	}
	console.log("done (record also in benchmarks.jsonl via bench-log)");
}

// ---- argv (dispatch only when run directly, not under bun test) ----

if (import.meta.main) {
	const args = process.argv.slice(2);
	const cmd = args[0];
	const get = (f: string) => {
		const i = args.indexOf(f);
		return i !== -1 ? args[i + 1] : undefined;
	};

	if (cmd === "status") {
		const gi = args.indexOf("--gb");
		const pairs =
			gi !== -1 ? (args[gi + 1] ?? "").split(",").filter(Boolean) : [];
		if (pairs.length === 0) {
			console.error(
				"usage: fleet-refresh.ts status --gb <id>=<gb>[,<id>=<gb>…]",
			);
			process.exit(1);
		}
		cmdStatus(pairs);
	} else if (cmd === "pull") {
		cmdPull(args[1] ?? "");
	} else if (cmd === "ab") {
		const cand = get("--candidate");
		const incModel = get("--incumbent-model");
		const incPort = Number(get("--incumbent-port"));
		if (!cand || !incModel || !incPort) {
			console.error(
				"usage: fleet-refresh.ts ab --candidate <id> --incumbent-port <p> --incumbent-model <id> [--candidate-gb n] [--candidate-port 8916] [--margin 0.05] [--keep]",
			);
			process.exit(1);
		}
		await cmdAb({
			candidate: cand,
			candidateGb: get("--candidate-gb")
				? Number(get("--candidate-gb"))
				: undefined,
			candidatePort: Number(get("--candidate-port") ?? 8916),
			incumbentPort: incPort,
			incumbentModel: incModel,
			margin: Number(get("--margin") ?? 0.05),
			keep: args.includes("--keep"),
		});
	} else {
		console.error("usage: fleet-refresh.ts <status|pull|ab> …");
		process.exit(1);
	}
}
