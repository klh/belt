#!/usr/bin/env bun
// enhance.ts — §3 prompt enhancer for the local-llm coordinator.
// Preserves meaning while adding structure; NEVER invents requirements.
//
// Usage:
//   bun enhance.ts "raw prompt text"            → structured JSON to stdout
//   bun enhance.ts --serve                      → POST :4010/enhance {"prompt": "..."}

import { byPort, fallbackFor } from "./registry.ts";

const EXTRACT = byPort(8902)!;
const PORT = 4010;

type Enhanced = {
	original: string;
	enhanced: string;
	inferred_intent: string;
	addressee: string; // "user" (asked, gets answer) | "agent" (will execute)
	assumptions: string[];
	ambiguities: string[];
	category: string;
	complexity: "SIMPLE" | "MEDIUM" | "COMPLEX" | "VERY_COMPLEX";
	parse_error?: string;
};

const SYSTEM = `You are a prompt-enhancement assistant. Rules, in order of priority:
1. Preserve the original meaning exactly. Never invent requirements, constraints, or details.
2. Add structure (goal, context, output format) only from what the text implies.
3. List every assumption the text forces you to make in "assumptions".
4. List what is genuinely underspecified in "ambiguities" — no fabrication.
5. Output ONLY valid JSON, no markdown fences:
{"enhanced": "...", "inferred_intent": "...", "addressee": "user|agent", "assumptions": [], "ambiguities": [], "category": "coding|architecture|product|business|finance|personal|trading|research", "complexity": "SIMPLE|MEDIUM|COMPLEX"}`;

function parseLoose(text: string): any {
	const t = text.replace(/```json|```/g, "").trim();
	try {
		return JSON.parse(t);
	} catch {}
	const m = t.match(/\{[\s\S]*\}/);
	if (m) {
		try {
			return JSON.parse(m[0]);
		} catch {}
	}
	return null;
}

async function enhance(raw: string): Promise<Enhanced> {
	const res = await fetch(
		`http://localhost:${EXTRACT.port}/v1/chat/completions`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			signal: AbortSignal.timeout(90_000),
			body: JSON.stringify({
				model: EXTRACT.model,
				messages: [
					{ role: "system", content: SYSTEM },
					{
						role: "user",
						content: `Enhance this prompt. Output only JSON:\n${raw}`,
					},
				],
				max_tokens: 800,
				temperature: 0.2,
				stream: false,
			}),
		},
	);
	const j = JSON.parse((await res.text()).replace(/\n/g, "\\n"));
	const out = parseLoose(j.choices?.[0]?.message?.content ?? "");
	if (!out) {
		return {
			original: raw,
			enhanced: raw,
			inferred_intent: "parse failure — passthrough",
			addressee: "user",
			assumptions: [],
			ambiguities: ["enhancer could not structure the prompt"],
			category: "general",
			complexity: "MEDIUM",
			parse_error: (j.choices?.[0]?.message?.content ?? "").slice(0, 200),
		};
	}
	return {
		original: raw,
		enhanced: String(out.enhanced ?? raw),
		inferred_intent: String(out.inferred_intent ?? ""),
		addressee: out.addressee === "agent" ? "agent" : "user",
		assumptions: Array.isArray(out.assumptions)
			? out.assumptions.map(String)
			: [],
		ambiguities: Array.isArray(out.ambiguities)
			? out.ambiguities.map(String)
			: [],
		category: String(out.category ?? "general"),
		complexity: (
			["SIMPLE", "MEDIUM", "COMPLEX", "VERY_COMPLEX"] as const
		).includes(out.complexity)
			? out.complexity
			: "MEDIUM",
	};
}

// ─── CLI ───
const arg = process.argv[2];
if (arg !== "--serve") {
	const raw = process.argv.slice(2).join(" ");
	if (!raw) {
		console.error('Usage: bun enhance.ts "prompt" | bun enhance.ts --serve');
		process.exit(1);
	}
	console.log(JSON.stringify(await enhance(raw), null, 2));
	process.exit(0);
}

// ─── serve mode ───
Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/health")
			return Response.json({ status: "alive", enhancer: "v1", port: PORT });
		if (req.method === "POST" && url.pathname === "/enhance") {
			const body = await req.json().catch(() => ({}));
			const raw = String((body as any).prompt ?? "").slice(0, 8000);
			if (!raw)
				return Response.json({ error: "missing prompt" }, { status: 400 });
			try {
				return Response.json(await enhance(raw));
			} catch (e: any) {
				return Response.json(
					{ original: raw, enhanced: raw, error: e?.message ?? String(e) },
					{ status: 502 },
				);
			}
		}
		return Response.json({ error: "not found" }, { status: 404 });
	},
});
console.log(`enhance.ts serving on :${PORT}`);
