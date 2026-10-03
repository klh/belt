// scoring.ts — mechanical checkers (only `content` is scored) + the
// sandbox-exec code runner + gold/garbage answers for the self-test.
import {
	existsSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Check,
	type ClassId,
	FENCE,
	pad,
	readCapped,
	sha,
	stripThink,
	TIERS,
	type Task,
} from "./core.ts";

export interface Score {
	score: number;
	pass: boolean;
	conf?: number | null;
	detail?: string;
}
const EXTRACT_KEYS = [
	"customer_name",
	"email",
	"order_id",
	"total",
	"currency",
	"order_date",
	"quantity",
];
const crit = (c: boolean[], detail: string): Score => {
	const k = c.filter(Boolean).length;
	return { score: k / c.length, pass: k === c.length, detail };
};

export function checkChat(
	text: string,
	c: Extract<Check, { kind: "chat" }>,
): Score {
	const t = stripThink(text);
	const wc = t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
	const lo = t.toLowerCase();
	const terms = c.terms.map((x) => lo.includes(x.toLowerCase()));
	const noList = !/^\s*([-*•]|\d+[.)])\s/m.test(t) && !/^\s*#/m.test(t);
	return crit(
		[wc >= c.min && wc <= c.max, ...terms, noList],
		`wc=${wc} terms=${terms.map(Number).join("")} nolist=${+noList}`,
	);
}
function parseJsonLoose(t: string): unknown {
	const s = stripThink(t).replace(/```(?:json)?/gi, "");
	const a = s.indexOf("{");
	const b = s.lastIndexOf("}");
	if (a < 0 || b <= a) return undefined;
	try {
		return JSON.parse(s.slice(a, b + 1));
	} catch {
		return undefined;
	}
}
export function checkExtract(
	text: string,
	c: Extract<Check, { kind: "extract" }>,
): Score {
	const raw = parseJsonLoose(text);
	const e = c.expect;
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		return { score: 0, pass: false, detail: "no JSON object" };
	const j = raw as Record<string, unknown>;
	const str = (k: string) =>
		typeof j[k] === "string" ? (j[k] as string).trim() : null;
	const f = [
		str("customer_name")?.toLowerCase() === e.customer_name.toLowerCase(),
		str("email")?.toLowerCase() === e.email,
		str("order_id")?.toUpperCase() === e.order_id,
		typeof j.total === "number" && Math.abs(j.total - e.total) < 0.005,
		str("currency")?.toUpperCase() === e.currency,
		str("order_date") === e.order_date,
		Number.isInteger(j.quantity) && j.quantity === e.quantity,
		Object.keys(j).sort().join() === [...EXTRACT_KEYS].sort().join(),
	];
	return crit(f, `fields=${f.map(Number).join("")}`);
}
export function lastMatch(t: string, re: RegExp): string | null {
	let last: string | null = null;
	for (const m of t.matchAll(new RegExp(re.source, "gim"))) last = m[1] ?? null;
	return last;
}
export function checkAnswer(
	text: string,
	c: Extract<Check, { kind: "answer" }>,
): Score {
	const t = stripThink(text);
	const raw = lastMatch(t, /^\W*ANSWER\W*:\s*(.+)$/);
	const cs = lastMatch(t, /^\W*CONFIDENCE\W*:\s*([\d.]+)/);
	const cn = cs === null ? Number.NaN : +cs;
	const conf = Number.isFinite(cn)
		? Math.min(1, Math.max(0, cn > 1 ? cn / 100 : cn))
		: null;
	if (raw === null)
		return { score: 0, pass: false, conf, detail: "no ANSWER line" };
	const a = raw.replace(/[*`]/g, "").trim().replace(/\.$/, "").toLowerCase();
	const e = String(c.expect).toLowerCase();
	let ok: boolean;
	if (c.type === "num") {
		const n = Number.parseFloat(a.replace(/[$,\s]|usd|dollars?|units?/g, ""));
		ok = Number.isFinite(n) && Math.abs(n - +e) < 0.005;
	} else if (c.type === "time") {
		const m = a.match(/(\d{1,2}):(\d{2})/);
		ok = !!m && `${pad(+(m[1] ?? 0), 2)}:${m[2]}` === e;
	} else if (c.type === "date")
		ok = (a.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "") === e;
	else ok = a.replace(/[^a-z]/g, "") === e;
	return { score: +ok, pass: ok, conf, detail: `got=${a.slice(0, 40)}` };
}
export function tierOf(answer: string): string | null {
	const t = stripThink(answer).toLowerCase();
	return (
		lastMatch(t, /tier\W*:\s*\W*([a-z]+)/) ??
		(Object.keys(TIERS).includes(t.trim()) ? t.trim() : null)
	);
}
export function checkTier(
	answer: string,
	c: Extract<Check, { kind: "tier" }>,
): Score {
	const m = tierOf(answer);
	return { score: +(m === c.expect), pass: m === c.expect, detail: `got=${m}` };
}
export function checkNeedle(
	text: string,
	c: Extract<Check, { kind: "needle" }>,
): Score {
	const ok = stripThink(text).toUpperCase().includes(c.expect);
	return { score: +ok, pass: ok, detail: ok ? "found" : "missing" };
}

// Code checker: model-generated code runs under macOS sandbox-exec (no
// network, no writes outside a temp dir, no exec), 10 s cap.
interface Sbx {
	bun: string;
	ok: boolean;
	why: string;
}
let SBX: Sbx | null = null;
export function sandboxInfo(): Sbx {
	if (!SBX) {
		const bun = realpathSync(process.execPath);
		const ok =
			process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
		SBX = {
			bun,
			ok,
			why: ok
				? "sandbox-exec"
				: "sandbox-exec unavailable — code checks refuse to execute",
		};
	}
	return SBX;
}
function extractCode(t: string, fn: string): string {
	const blocks = [
		...stripThink(t).matchAll(/```[\w+-]*\s*\n([\s\S]*?)```/g),
	].map((m) => m[1] ?? "");
	return (
		blocks.find((b) => b.includes(fn)) ??
		(blocks.length ? blocks.join("\n") : stripThink(t))
	);
}
export async function checkCode(
	text: string,
	c: { fn: string; tests: [unknown[], unknown][] },
): Promise<Score> {
	const sb = sandboxInfo();
	if (!sb.ok) return { score: 0, pass: false, detail: sb.why };
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "arena-sbx-")));
	const tag = `__ARENA_${sha(`${dir}${Math.random()}`).slice(0, 12)}__`;
	const code = extractCode(text, c.fn).replace(
		/^\s*export\s+(default\s+)?/gm,
		"",
	);
	const harness = `${code}\n;(()=>{const T=${JSON.stringify(c.tests)};let p=0;for(const [a,e] of T){try{const g=(${c.fn})(...structuredClone(a));if(JSON.stringify(g)===JSON.stringify(e))p++}catch{}}process.stdout.write("\\n${tag}"+JSON.stringify({p,n:T.length})+"\\n")})();\n`;
	writeFileSync(join(dir, "c.ts"), harness);
	const prof = `(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath "${dir}") (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))(deny process-exec)(allow process-exec (literal "${sb.bun}"))`;
	try {
		const p = Bun.spawn(
			[
				"/usr/bin/sandbox-exec",
				"-p",
				prof,
				sb.bun,
				"run",
				"--no-install",
				join(dir, "c.ts"),
			],
			{
				cwd: dir,
				env: { PATH: "/usr/bin:/bin", HOME: dir },
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		const timer = setTimeout(() => p.kill(9), 10_000);
		const out = await readCapped(p.stdout, 256 * 1024);
		await p.exited;
		clearTimeout(timer);
		const line = out
			.split("\n")
			.reverse()
			.find((l) => l.startsWith(tag));
		if (!line)
			return {
				score: 0,
				pass: false,
				detail:
					p.exitCode === null || p.signalCode
						? "timeout/killed"
						: "no result (compile/runtime error)",
			};
		const { p: k, n } = JSON.parse(line.slice(tag.length)) as {
			p: number;
			n: number;
		};
		return { score: k / n, pass: k === n, detail: `${k}/${n} asserts` };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
export async function scoreText(c: Check, text: string): Promise<Score> {
	switch (c.kind) {
		case "chat":
			return checkChat(text, c);
		case "code":
			return checkCode(text, c);
		case "extract":
			return checkExtract(text, c);
		case "answer":
			return checkAnswer(text, c);
		case "tier":
			return checkTier(text, c);
		case "needle":
			return checkNeedle(text, c);
	}
}
export function goldFor(t: Task, cls: ClassId): { gold: string; junk: string } {
	const c = t.check;
	if (c.kind === "chat")
		return {
			gold: `${c.terms[0]} and ${c.terms[1]} matter here. ${"This plain sentence keeps the explanation going for the reader. ".repeat(7)}`,
			junk: "- no",
		};
	if (c.kind === "code")
		return {
			gold: `${FENCE}js\n${c.ref}\n${FENCE}`,
			junk: `${FENCE}js\nfunction ${c.fn}(){return null}\n${FENCE}`,
		};
	if (c.kind === "extract")
		return { gold: JSON.stringify(c.expect), junk: "{}" };
	if (c.kind === "answer")
		return {
			gold: `Working...\nANSWER: ${c.expect}\nCONFIDENCE: 90`,
			junk: "ANSWER: zzz-unknown",
		};
	if (c.kind === "tier")
		return { gold: `TIER: ${c.expect}`, junk: "TIER: banana" };
	if (cls !== "f") throw new Error(`no gold for class ${cls}`);
	return { gold: c.expect, junk: "I could not find it." };
}
