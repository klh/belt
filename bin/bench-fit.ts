// belt/bin/bench-fit.ts — W225: fit classification with and without Kev in
// the loop. Replays task hints through both backends — chat-JSON on :8902
// (flash 4B) vs SystemOne typed on :8912 (Kev-4B 1.0) — same candidates,
// unique signature per task (no cache hits), records wall latency, usage
// tokens and verdict agreement.
import { classifyAndCache } from "./fit-classifier.ts";

const KEV_PORT = process.env.KEV_PORT ?? 8912;
const LLM_PORT = 8902;
const N = Number(process.env.BENCH_N ?? 12);

type Row = {
	task: string;
	backend: "llm" | "kev";
	verdict: unknown;
	latency_ms: number;
	in_tok: number;
	out_tok: number;
	ok: boolean;
};

const tasks = [
	"fix flaky async test in a scheduler service",
	"write a Danish summary of this quarterly report",
	"generate a React component for a pricing table",
	"refactor the payment reconciliation module",
	"explain this stack trace to a junior dev",
	"classify customer support tickets by urgency",
	"optimize the image pipeline hot loop",
	"draft the API contract for the new export endpoint",
	"migrate the CMS database schema",
	"triage which 8900-range model should serve a chat request",
	"write e2e tests for the checkout flow",
	"translate the onboarding emails to German",
];

const candidates = [
	{ machine: "muramasa", port: 8901, model: "qwen3-coder-30b", kind: "code", tags: "mlx 28GB code" },
	{ machine: "muramasa", port: 8902, model: "mlx-community/Qwen3-4B-Instruct-2507-4bit", kind: "extract", tags: "mlx 4GB fast" },
	{ machine: "mur shaped", port: 8903, model: "qwen3.5-35b", kind: "reason", tags: "mlx 35B deep" },
	{ machine: "muramasa", port: 8906, model: "qwen3.5-8b-dk", kind: "danish", tags: "mlx danish" },
];

const sigOf = (task: string, b: string): string => `bench-${b}-${task.slice(0, 24)}`;
const llmCaller = async (prompt: string): Promise<string> => {
	const r = await fetch(`http://127.0.0.1:${LLM_PORT}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
			messages: [
				{
					role: "system",
					content: "You output ONLY compact JSON. No prose, no markdown fences.",
				},
				{ role: "user", content: prompt },
			],
			max_tokens: 120,
			temperature: 0,
		}),
		signal: AbortSignal.timeout(20_000),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status} from :${LLM_PORT}`);
	const w = (await r.json()) as {
		choices?: { message?: { content?: string } }[];
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};
	lastUsage = {
		in: w.usage?.prompt_tokens ?? 0,
		out: w.usage?.completion_tokens ?? 0,
	};
	return w.choices?.[0]?.message?.content ?? "";
};

let lastUsage = { in: 0, out: 0 };
let kevUsage = { in: 0, out: 0 };
const kevCaller = async (prompt: string): Promise<string> => {
	const { hint, candidates } = parsePromptLocal(prompt);
	const r = await fetch(`http://127.0.0.1:${KEV_PORT}/v1/systemone`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			state: JSON.stringify({ hint, candidates }),
			model: "kev-latest",
			questions: {
				placement: {
					type: "choice",
					instructions:
						"Which placement class best fits this task for long-running work?",
					criteria: {
						local: "runs on this machine's swarm",
						remote: "another machine on the LAN",
						cloud: "paid cloud API",
					},
				},
				longrun: {
					type: "noul",
					instructions: "Is this long-running work? true or false",
				},
				confidence: {
					type: "score",
					instructions: "Confidence in the placement choice",
					criteria: ["none", "low", "medium", "high", "certain"],
				},
			},
		}),
		signal: AbortSignal.timeout(20_000),
	});
	if (!r.ok) throw new Error(`HTTP ${r.status} from :${KEV_PORT}`);
	const w = (await r.json()) as {
		answers?: Record<string, { choice?: string; noul?: number; score?: number }>;
		usage?: { input_tokens?: number; output_tokens?: number };
	};
	kevUsage = {
		in: w.usage?.input_tokens ?? 0,
		out: w.usage?.output_tokens ?? 0,
	};
	const a = w.answers ?? {};
	return JSON.stringify({
		placement: a.placement?.choice ?? "local",
		model_glob: null,
		longrun: (a.longrun?.noul ?? 0) >= 0.5,
		confidence: Math.round(Math.min(1, Math.max(0, (a.confidence?.score ?? 0) / 4)) * 100) / 100,
	});
};

function parsePromptLocal(
	prompt: string,
): { hint: string; candidates: string[] } {
	const hint = /^Task hint: "(.+)"$/m.exec(prompt)?.[1] ?? "";
	const candidates = prompt
		.split("\n")
		.filter((l) => l.startsWith("- "))
		.map((l) => l.slice(2));
	return { hint, candidates };
}

function buildPrompt(hint: string, candidates: typeof candidates): string {
	const lines = candidates.map(
		(c) => `- ${c.machine}:${c.port} ${c.model} [${c.kind}] ${c.tags}`,
	);
	return [
		`Task hint: "${hint}"`,
		"Candidate models (machine, model, class, capabilities):",
		...lines,
		"Which placement class best fits this task for LONG-RUNNING work?",
		'Reply ONLY: {"placement":"local|remote|cloud","model_glob":"<glob|null>","longrun":true|false,"confidence":0-1}',
	].join("\n");
}

const rows: Row[] = [];
for (const task of tasks) {
	const prompt = buildPrompt(task, candidates);
	for (const backend of ["llm", "kev"] as const) {
		const t0 = performance.now();
		try {
			const raw =
				backend === "llm" ? await llmCaller(prompt) : await kevCaller(prompt);
			const latency = Math.round(performance.now() - t0);
			const u = backend === "llm" ? lastUsage : kevUsage;
			const m = raw.match(/\{[\s\S]*\}/);
			const verdict = m ? JSON.parse(m[0]) : null;
			rows.push({
				task,
				backend,
				verdict,
				latency_ms: latency,
				in_tok: u.in,
				out_tok: u.out,
				ok: verdict !== null,
			});
		} catch (e) {
			rows.push({
				task,
				backend,
				verdict: null,
				latency_ms: Math.round(performance.now() - t0),
				in_tok: 0,
				out_tok: 0,
				ok: false,
			});
		}
	}
}

// summary
const sum = (b: "llm" | "kev") => {
	const rs = rows.filter((r) => r.backend === b);
	const ok = rs.filter((r) => r.ok);
	const lat = ok.map((r) => r.latency_ms).sort((a, b) => a - b);
	return {
		backend: b,
		n: rs.length,
		okRate: ok.length / rs.length,
		p50: lat[Math.floor(lat.length / 2)] ?? 0,
		p95: lat[Math.floor(lat.length * 0.95)] ?? 0,
		tokens: rs.reduce((a, r) => a + r.in_tok + r.out_tok, 0),
	};
};
const agree = (() => {
	let same = 0;
	let n = 0;
	for (const t of tasks) {
		const l = rows.find((r) => r.task === t && r.backend === "llm" && r.ok);
		const k = rows.find((r) => r.task === t && r.backend === "kev" && r.ok);
		if (!l || !k) continue;
		n++;
		if (
			(l.verdict as { placement?: string })?.placement ===
			(k.verdict as { placement?: string })?.placement
		)
			same++;
	}
	return `${same}/${n}`;
})();
const out = { rows, summary: [sum("llm"), sum("kev")], placementAgreement: agree };
console.log(JSON.stringify(out.summary));
console.log("placement agreement llm↔kev:", agree);
console.log("total tokens llm:", sum("llm").tokens, "| kev:", sum("kev").tokens);
await Bun.write("/tmp/bench-fit.jsonl", rows.map((r) => JSON.stringify(r)).join("\n"));
