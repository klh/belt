// bin/knowledge-inject.test.ts — W255: injection gate + scoring order,
// tail shape (single appended message — the prefix-preservation contract),
// hub read filtering, serve log, path resolution. Isolated DB/log via env.
import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
	buildTailMessage,
	defaultDbPath,
	injectKnowledge,
	logServe,
	readFacts,
	scoreFacts,
	serveLogPath,
	tokenize,
	type FactRow,
} from "./knowledge-inject.ts";

const DIR = mkdtempSync(join(tmpdir(), "w255-inject-"));
const DB = join(DIR, "governor.db");
const LOG = join(DIR, "knowledge-serve.log");
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const ENV: NodeJS.ProcessEnv = {
	HOME: DIR,
	BELT_GOVERNOR_DB: DB,
	KNOWLEDGE_SERVE_LOG: LOG,
};

function seed(
	rows: Array<{
		topic: string;
		fact: string;
		confidence?: number;
		state?: string;
		superseded_by?: number | null;
		age_days?: number;
	}>,
): void {
	const db = new Database(DB);
	db.exec(
		"CREATE TABLE IF NOT EXISTS knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, topic TEXT NOT NULL, fact TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, state TEXT NOT NULL DEFAULT 'candidate', superseded_by INTEGER, created_at INTEGER, updated_at INTEGER)",
	);
	const ins = db.query(
		"INSERT INTO knowledge (ts, topic, fact, confidence, state, superseded_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	for (const r of rows) {
		const updated = NOW - (r.age_days ?? 0) * DAY;
		ins.run(
			updated,
			r.topic,
			r.fact,
			r.confidence ?? 0.5,
			r.state ?? "active",
			r.superseded_by ?? null,
			updated,
		);
	}
	db.close();
}

afterAll(() => {
	rmSync(DIR, { recursive: true, force: true });
});

test("tokenize: danish kept, stopwords/short/numeric dropped, capped", () => {
	const toks = tokenize("Hvordan bevarer gateway-cache prefixes? 42 x");
	expect(toks).toContain("bevarer");
	expect(toks).toContain("gateway");
	expect(toks).toContain("cache");
	expect(toks).toContain("prefixes");
	expect(toks).not.toContain("hvordan");
	expect(toks).not.toContain("42");
	expect(toks).not.toContain("x");
	expect(tokenize(Array(100).fill("alpha").join(" ")).length).toBe(64);
});

function row(
	p: Partial<FactRow> & {
		id: number;
		topic: string;
		fact: string;
		age_days?: number;
	},
): FactRow {
	const { age_days = 0, ...rest } = p;
	return {
		confidence: 0.5,
		updated_at: NOW - age_days * DAY,
		...rest,
	};
}

const CACHE_FACT = "prefix injection preserves provider cache hits";

test("scoreFacts: relevance hits, stale decays by half-life, confidence scales", () => {
	const facts = [
		row({ id: 1, topic: "gateway cache", fact: CACHE_FACT }),
		row({
			id: 2,
			topic: "danish vowels",
			fact: "æøå detection covers 201 languages",
		}),
		row({ id: 3, topic: "gateway cache", fact: CACHE_FACT, age_days: 120 }),
		row({ id: 4, topic: "gateway cache", fact: CACHE_FACT, confidence: 0.1 }),
	];
	const req = tokenize("how does the gateway keep the cache prefix stable?");
	const scored = scoreFacts(req, facts, NOW);
	expect(scored[0]?.topic).toBe("gateway cache");
	const fresh = scored.find((s) => s.id === 1);
	const stale = scored.find((s) => s.id === 3);
	const lowconf = scored.find((s) => s.id === 4);
	expect(fresh !== undefined && stale !== undefined).toBe(true);
	if (fresh === undefined || stale === undefined || lowconf === undefined)
		return;
	expect(fresh.score).toBeGreaterThan(stale.score);
	expect(fresh.score).toBeGreaterThan(lowconf.score);
	// 120 days on a 30-day half-life = 4 halvings
	expect(stale.decay).toBeCloseTo(0.5 ** 4, 5);
	expect(scored.some((s) => s.id === 2)).toBe(false);
});

test("scoreFacts: no-hit requests score nothing; stale weak hits fall under MIN_SCORE", () => {
	const facts = [
		row({
			id: 7,
			topic: "quantum tunneling",
			fact: "electron phase coherence",
		}),
	];
	expect(
		scoreFacts(tokenize("totally unrelated grocery shopping"), facts, NOW),
	).toEqual([]);
	// single weak token on a 240-day-old fact: relevance 1/sqrt(7), decay
	// 0.5^8 → far below MIN_SCORE — stale noise never gets served
	expect(
		scoreFacts(
			tokenize("coherence"),
			[
				row({
					id: 8,
					topic: "quantum tunneling",
					fact: "electron phase coherence",
					age_days: 240,
				}),
			],
			NOW,
		),
	).toEqual([]);
	expect(scoreFacts(tokenize("quantum tunneling"), facts, NOW).length).toBe(1);
});

test("readFacts: active-only, superseded excluded, missing hub degrades to []", () => {
	seed([
		{
			topic: "router law",
			fact: "musts filter, prefer ranks",
			state: "active",
		},
		{ topic: "draft note", fact: "half-written candidate", state: "candidate" },
		{
			topic: "old law",
			fact: "superseded by the new one",
			state: "active",
			superseded_by: 1,
		},
	]);
	const facts = readFacts(DB);
	expect(facts.length).toBe(1);
	expect(facts[0]?.topic).toBe("router law");
	expect(readFacts(join(DIR, "no-such-db.db"))).toEqual([]);
});

test("injectKnowledge: gate off → null; on → scored tail, no match → null", () => {
	expect(
		injectKnowledge({
			text: "router law musts",
			enabled: false,
			env: ENV,
			now: NOW,
		}),
	).toBeNull();
	const inj = injectKnowledge({
		text: "router law musts and prefer",
		enabled: true,
		env: ENV,
		now: NOW,
	});
	expect(inj !== null).toBe(true);
	if (inj === null) return;
	expect(inj.served[0]?.topic).toBe("router law");
	expect(inj.tail.role).toBe("user");
	expect(inj.tail.content.startsWith("[fleet knowledge")).toBe(true);
	expect(inj.candidates).toBe(1);
	expect(
		injectKnowledge({
			text: "unrelated grocery list",
			enabled: true,
			env: ENV,
			now: NOW,
		}),
	).toBeNull();
});

test("prefix-preservation contract: injection appends, prefix stays byte-identical", () => {
	const prefix = [
		{ role: "system", content: "/no_think" },
		{ role: "user", content: "earlier turn" },
		{ role: "assistant", content: "earlier answer" },
		{ role: "user", content: "the actual request" },
	];
	const before = JSON.stringify(prefix);
	const inj = injectKnowledge({
		text: "router law musts",
		enabled: true,
		env: ENV,
		now: NOW,
	});
	if (inj === null) throw new Error("expected injection");
	prefix.push(inj.tail);
	expect(JSON.stringify(prefix.slice(0, 4))).toBe(before);
	expect(prefix.length).toBe(5);
	// determinism: same facts → same bytes (cache-stable across requests)
	const again = injectKnowledge({
		text: "router law musts",
		enabled: true,
		env: ENV,
		now: NOW,
	});
	expect(again?.tail.content).toBe(inj.tail.content);
});

test("buildTailMessage: deterministic, header + per-fact lines, truncates at 240", () => {
	const long = "x".repeat(500);
	const byId = new Map<number, FactRow>([
		[
			9,
			{
				id: 9,
				topic: "big fact",
				fact: long,
				confidence: 0.5,
				updated_at: NOW,
			},
		],
	]);
	const tail = buildTailMessage(
		[{ id: 9, topic: "big fact", score: 1, relevance: 1, decay: 1 }],
		byId,
	);
	expect(tail.content).toBe(
		`[fleet knowledge — context injected by belt; ignore if irrelevant]\n- big fact: ${"x".repeat(240)}`,
	);
});

test("logServe: NDJSON one line per serve; failures report false, never throw", () => {
	expect(
		logServe(ENV, {
			prompt: "router laws",
			served: [{ id: 1, topic: "router law" }],
		}),
	).toBe(true);
	expect(existsSync(LOG)).toBe(true);
	const text = readFileSync(LOG, "utf8");
	expect(text.endsWith("\n")).toBe(true);
	expect(JSON.parse(text) as { prompt?: string }).toMatchObject({
		prompt: "router laws",
	});
	const bad = logServe(
		{ KNOWLEDGE_SERVE_LOG: "/nonexistent-dir-zz/x.log" },
		{},
	);
	expect(bad).toBe(false);
});

test("paths: env overrides win over the HOME defaults", () => {
	expect(defaultDbPath(ENV)).toBe(DB);
	expect(serveLogPath(ENV)).toBe(LOG);
	expect(defaultDbPath({})).toBe("/.cache/claude-governor/governor.db");
	expect(serveLogPath({})).toBe("/.claude-insights/knowledge-serve.log");
});
