// bin/knowledge-inject.ts — W255: request-time knowledge-injection middleware
// + serve-transparency log. At request time the router may inject the
// governor knowledge hub's top-k active facts (state='active', relevance-
// scored against the request, decay-weighted by recency, confidence-scaled)
// as ONE tail message appended AFTER the last message — the token prefix
// (system + every earlier message) stays byte-identical, so provider and
// mlx prefix caches keep hitting. Facts change per request; the prefix
// never does.
//
// Source: the `knowledge` table in governor.db, read-only (WAL-safe) — the
// W142 verified tier. Candidate/superseded facts are never served; the coord
// `facts` table (activity telemetry, unreviewed lessons) is deliberately
// NOT a source. Belt machines without the hub degrade to a no-op (zero
// facts, zero log lines), never a request failure.
//
// Gate: injection is OPT-IN per request (`_knowledge: true` in the body) —
// silent default-on prompt mutation would surprise the router's consumers.
// BELT_INJECT=on flips the fleet-wide default; BELT_INJECT=off is the kill
// switch and denies even flagged requests.
import { appendFileSync } from "node:fs";
import { Database } from "bun:sqlite";

// ─── config (consts, not knobs) ───
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30-day recency half-life
const TOP_K = 3; // max facts per request
const MIN_SCORE = 0.05; // below this a fact is noise, not signal
const MAX_CANDIDATES = 400; // scan window: the freshest N active facts
const FACT_CHARS = 240; // per-fact truncation inside the tail message
const TOKENS_MAX = 64; // request-side token cap
const TAIL_HEADER =
	"[fleet knowledge — context injected by belt; ignore if irrelevant]";

export interface FactRow {
	id: number;
	topic: string;
	fact: string;
	confidence: number;
	updated_at: number;
}

export interface ServedFact {
	id: number;
	topic: string;
	score: number;
	relevance: number;
	decay: number;
}

export interface Injection {
	tail: { role: string; content: string };
	served: ServedFact[];
	candidates: number;
}

const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"not",
	"are",
	"was",
	"but",
	"has",
	"have",
	"had",
	"you",
	"your",
	"can",
	"how",
	"what",
	"when",
	"where",
	"which",
	"who",
	"why",
	"from",
	"into",
	"about",
	"would",
	"could",
	"should",
	"does",
	"did",
	"its",
	"their",
	"them",
	"then",
	"than",
	"there",
	"here",
	"been",
	"being",
	"also",
	"just",
	"only",
	"over",
	"under",
	"between",
	"after",
	"before",
	"while",
	"both",
	"each",
	"more",
	"most",
	"some",
	"such",
	"very",
	"much",
	"many",
	"will",
	"shall",
	"may",
	"might",
	"must",
	"let",
	"put",
	"get",
	"got",
	"use",
	"used",
	"using",
	"og",
	"er",
	"det",
	"som",
	"til",
	"af",
	"med",
	"der",
	"har",
	"skal",
	"den",
	"de",
	"også",
	"eller",
	"men",
	"hvad",
	"hvordan",
	"hvorfor",
	"hvilken",
]);

/** Lowercase word tokens (danish æøå kept), stopwords/short/numeric dropped,
 *  capped — scoring only needs a bounded bag of signal words. */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	for (const t of text.toLowerCase().split(/[^a-z0-9æøå]+/)) {
		if (t.length < 3 || /^\d+$/.test(t) || STOPWORDS.has(t)) continue;
		out.push(t);
		if (out.length >= TOKENS_MAX) break;
	}
	return out;
}

// ─── scoring: relevance × decay × confidence ───
// relevance: weighted term overlap (topic tokens count double) normalized
// against the fact's own mass — a fact matching 3 of 3 request tokens beats
// one matching the same 3 of 30. decay: 30-day half-life on the fact's
// last update. confidence: the hub's 0..1 judgment, half-weighted.
export function scoreFacts(
	reqTokens: string[],
	facts: FactRow[],
	now: number,
): ServedFact[] {
	const reqSet = new Set(reqTokens);
	const scored: ServedFact[] = [];
	for (const f of facts) {
		const terms = new Map<string, number>();
		let mass = 0;
		for (const t of tokenize(f.topic)) {
			terms.set(t, 2);
			mass += 2;
		}
		for (const t of tokenize(f.fact)) {
			if (!terms.has(t)) {
				terms.set(t, 1);
				mass += 1;
			}
		}
		if (mass === 0) continue;
		let hit = 0;
		for (const t of reqSet) {
			const w = terms.get(t);
			if (w !== undefined) hit += w;
		}
		if (hit === 0) continue;
		const relevance = hit / Math.sqrt(mass);
		const age = Math.max(0, now - f.updated_at);
		const decay = 0.5 ** (age / HALF_LIFE_MS);
		const conf = Number.isFinite(f.confidence)
			? Math.min(1, Math.max(0, f.confidence))
			: 0.5;
		const score = relevance * decay * (0.5 + 0.5 * conf);
		if (score < MIN_SCORE) continue;
		scored.push({ id: f.id, topic: f.topic, score, relevance, decay });
	}
	scored.sort((a, b) => b.score - a.score || a.id - b.id);
	return scored;
}

/** Read active, unsuperseded facts from the hub — bounded to the freshest
 *  MAX_CANDIDATES. Any failure (no hub on this machine, locked, migrating)
 *  degrades to zero facts; belt never fails a request over injection. */
export function readFacts(dbPath: string): FactRow[] {
	try {
		const db = new Database(dbPath, { readonly: true });
		try {
			const rows = db
				.query(
					"SELECT id, topic, fact, confidence, COALESCE(updated_at, created_at, ts) AS updated_at FROM knowledge WHERE state = 'active' AND superseded_by IS NULL ORDER BY COALESCE(updated_at, created_at, ts) DESC LIMIT ?",
				)
				.all(MAX_CANDIDATES) as Array<Record<string, unknown>>;
			const out: FactRow[] = [];
			for (const r of rows) {
				const topic = typeof r.topic === "string" ? r.topic : "";
				const fact = typeof r.fact === "string" ? r.fact : "";
				if (!topic || !fact) continue;
				out.push({
					id: typeof r.id === "number" ? r.id : 0,
					topic,
					fact,
					confidence: typeof r.confidence === "number" ? r.confidence : 0.5,
					updated_at: typeof r.updated_at === "number" ? r.updated_at : 0,
				});
			}
			return out;
		} finally {
			db.close();
		}
	} catch {
		return [];
	}
}

/** The tail message: deterministic for a given fact set (same facts in,
 *  same bytes out) so identical requests stay cache-identical. */
export function buildTailMessage(
	served: ServedFact[],
	byId: Map<number, FactRow>,
): { role: string; content: string } {
	const lines = [TAIL_HEADER];
	for (const s of served) {
		const f = byId.get(s.id);
		if (f === undefined) continue;
		lines.push(`- ${f.topic}: ${f.fact.slice(0, FACT_CHARS)}`);
	}
	return { role: "user", content: lines.join("\n") };
}

/** Hub location: BELT_GOVERNOR_DB overrides (tests, side-by-side hubs),
 *  else the governor's registry default. */
export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.BELT_GOVERNOR_DB ??
		`${env.HOME ?? ""}/.cache/claude-governor/governor.db`
	);
}

/** Score + select + build the tail in one call — pure, no logging. The
 *  router appends `tail` to the outgoing messages and calls logServe()
 *  after route resolution, when port/model are known. */
export function injectKnowledge(opts: {
	text: string;
	enabled: boolean;
	env?: NodeJS.ProcessEnv;
	now?: number;
}): Injection | null {
	if (!opts.enabled) return null;
	const env = opts.env ?? process.env;
	const now = opts.now ?? Date.now();
	const facts = readFacts(defaultDbPath(env));
	if (facts.length === 0) return null;
	const served = scoreFacts(tokenize(opts.text), facts, now).slice(0, TOP_K);
	if (served.length === 0) return null;
	const byId = new Map(facts.map((f) => [f.id, f]));
	return {
		tail: buildTailMessage(served, byId),
		served,
		candidates: facts.length,
	};
}

// ─── serve-transparency log (NDJSON, one line per serving request) ───
export function serveLogPath(env: NodeJS.ProcessEnv = process.env): string {
	return (
		env.KNOWLEDGE_SERVE_LOG ??
		`${env.HOME ?? ""}/.claude-insights/knowledge-serve.log`
	);
}

/** Append one serve line. Returns false (never throws) if the write fails —
 *  callers surface that in the response's _routing instead of 500ing. */
export function logServe(
	env: NodeJS.ProcessEnv,
	entry: Record<string, unknown>,
): boolean {
	try {
		const line = JSON.stringify({
			ts: new Date().toISOString(),
			...entry,
		});
		appendFileSync(serveLogPath(env), `${line}\n`);
		return true;
	} catch {
		return false;
	}
}
