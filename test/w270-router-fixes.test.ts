// W270 — bench-informed router fixes: code-signal classifier, Anthropic
// `system` passthrough, Kev context gate, budget policy, upstream 429
// Retry-After, SSE streaming, direct-tier bypass policy. Stub servers only —
// never the live :890x fleet.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byPort } from "../bin/registry.ts";
import {
	anthropicSseFromOpenAi,
	applyBudget,
	callHonoringRetryAfter,
	classifierText,
	codeSignal,
	kevEligible,
	retryAfterMs,
	SYSTEM_CLASSIFY_MAX_CHARS,
	scoreComplexity,
	stopReason,
	thinkFilter,
	toOpenAiMessages,
	viaLocal,
} from "../bin/router-core.ts";
import {
	loadDirectTiers,
	parseDirect,
	resolveTarget,
} from "../bin/router-policy.ts";

// bench class b shapes: 22 JS function families, sealed in bench-arena
const CODE_GEN = [
	"Write a JavaScript function rotate(arr, k) that rotates the array right by k.",
	"Implement caesar(s, n) that shifts letters by n, preserving case.",
	"rle(s) should return the run-length encoding of s, e.g. aaab -> a3b1.",
	"Write chunk(arr, size) which splits arr into arrays of length size.",
	"Create a function named toRoman that converts an integer to a Roman numeral.",
	"Reply with only a ```js block defining flattenDepth(arr, d).",
	"mergeIntervals(list) returns the merged overlapping intervals.",
	"Write the function gcd(a, b) and lcm(a, b) in JavaScript.",
];
const LOG_LINE = (i: number) =>
	`2026-10-02T21:${String(i % 60).padStart(2, "0")}:00Z INFO api-gateway request id=${i} endpoint=/v2/orders latency=${i % 97}ms return=200 debug=false docker=web-${i % 5}`;
const HAYSTACK = `[ref:0a1b2c3d]\n${Array.from({ length: 400 }, (_, i) => LOG_LINE(i)).join("\n")}\nWhich request id had latency 42ms? Reply with the id only.`;

describe("code signal (bench b misplacement)", () => {
	test("every code-gen family shape is code → coder tier", () => {
		for (const p of CODE_GEN) {
			expect({ p, code: codeSignal(p).isCode }).toEqual({ p, code: true });
			expect(scoreComplexity(p).tier).toBe("MEDIUM");
		}
	});

	test("a long log haystack full of api/return/debug is NOT code", () => {
		const s = codeSignal(HAYSTACK);
		expect(s.strong).toEqual([]);
		expect(s.isCode).toBe(false);
		expect(scoreComplexity(HAYSTACK).dimensions.codePresence).toBe(0);
	});

	test("prose that merely says 'let me' / 'return' is not code", () => {
		for (const p of [
			"Let me know what is a good gift for my mother.",
			"When should I return the rented car?",
			"Explain in 60-120 words why the sky looks blue to children.",
		])
			expect({ p, code: codeSignal(p).isCode }).toEqual({ p, code: false });
	});

	test("two distinct weak hits in a short prompt still count as code", () => {
		expect(codeSignal("debug my docker endpoint please").isCode).toBe(true);
		expect(codeSignal("the api is slow").isCode).toBe(false);
	});

	test("plural '(s)' prose does not read as a call signature", () => {
		expect(codeSignal("list the item(s) that should ship").isCode).toBe(false);
	});
});

describe("Anthropic system passthrough", () => {
	const body = {
		system: "Reply with one JavaScript code block only.",
		messages: [{ role: "user", content: "rotate an array right by k" }],
	};

	test("system is forwarded first with /no_think appended", () => {
		const m = toOpenAiMessages(body);
		expect(m[0]).toEqual({
			role: "system",
			content: "Reply with one JavaScript code block only. /no_think",
		});
		expect(m[1]).toEqual({
			role: "user",
			content: "rotate an array right by k",
		});
	});

	test("no system → bare /no_think system (pre-W270 shape)", () => {
		expect(toOpenAiMessages({ messages: [] })[0]).toEqual({
			role: "system",
			content: "/no_think",
		});
	});

	test("block-array system is flattened", () => {
		const m = toOpenAiMessages({
			system: [
				{ type: "text", text: "A" },
				{ type: "text", text: "B" },
			],
		});
		expect(m[0]?.content).toBe("AB /no_think");
	});

	test("a short system is classified; a harness-sized one is not", () => {
		expect(codeSignal(classifierText(body)).isCode).toBe(true);
		const harness = `${"You are Claude Code. Write a function when asked. ".repeat(60)}`;
		expect(harness.length).toBeGreaterThan(SYSTEM_CLASSIFY_MAX_CHARS);
		expect(
			classifierText({
				system: harness,
				messages: [{ role: "user", content: "hi" }],
			}),
		).toBe("hi");
	});
});

describe("Kev context gate (bench f TTFT)", () => {
	test("short prompts are Kev-eligible, long ones skip the serial hop", () => {
		expect(kevEligible("Which tier fits a quarterly invoice summary?")).toBe(
			true,
		);
		expect(kevEligible(HAYSTACK)).toBe(false);
		expect(kevEligible("x".repeat(384 * 4))).toBe(true);
		expect(kevEligible("x".repeat(384 * 4 + 1))).toBe(false);
	});
});

describe("budget policy (bench a truncation)", () => {
	test("always-thinking GLM below min budget is raised, with a note", () => {
		const b = applyBudget("glm-5.3-flash", 1024);
		expect(b.maxTokens).toBe(2048);
		expect(b.note).toContain("always thinks");
		expect(applyBudget("glm-5.3[1m]", 512).maxTokens).toBe(2048);
	});

	test("enough budget is left alone", () => {
		expect(applyBudget("glm-5.3-flash", 4096)).toEqual({
			maxTokens: 4096,
			extra: {},
		});
	});

	test("Qwen3.5 specialists get thinking off (was a port branch)", () => {
		for (const port of [8903, 8906]) {
			const s = byPort(port);
			expect(s).toBeDefined();
			expect(applyBudget(s?.model ?? "", 100).extra).toEqual({
				chat_template_kwargs: { enable_thinking: false },
			});
		}
	});

	test("models without a rule pass through", () => {
		expect(applyBudget(byPort(8901)?.model ?? "", 64)).toEqual({
			maxTokens: 64,
			extra: {},
		});
	});

	test("finish_reason length surfaces as stop_reason max_tokens", () => {
		expect(stopReason("length")).toBe("max_tokens");
		expect(stopReason("stop")).toBe("end_turn");
		expect(stopReason(undefined)).toBe("end_turn");
	});
});

describe("Retry-After", () => {
	test("delta-seconds, HTTP-date, junk", () => {
		expect(retryAfterMs("2")).toBe(2000);
		expect(retryAfterMs("0.5")).toBe(500);
		const now = Date.parse("2026-10-02T00:00:00Z");
		expect(retryAfterMs("Fri, 02 Oct 2026 00:00:03 GMT", now)).toBe(3000);
		expect(retryAfterMs("soon")).toBeUndefined();
		expect(retryAfterMs(null)).toBeUndefined();
		expect(retryAfterMs("-1")).toBeUndefined();
	});

	test("short Retry-After is waited out and retried once", async () => {
		const slept: number[] = [];
		let n = 0;
		const r = await callHonoringRetryAfter(
			async () =>
				++n === 1
					? { ok: false, status: 429, retryAfterMs: 300 }
					: { ok: true, status: 200 },
			2000,
			async (ms) => slept.push(ms),
		);
		expect(r.ok).toBe(true);
		expect(slept).toEqual([300]);
		expect(n).toBe(2);
	});

	test("Retry-After past the cap returns the 429 without waiting", async () => {
		const slept: number[] = [];
		let n = 0;
		const r = await callHonoringRetryAfter(
			async () => {
				n++;
				return { ok: false, status: 429, retryAfterMs: 30_000 };
			},
			2000,
			async (ms) => slept.push(ms),
		);
		expect(r.status).toBe(429);
		expect(slept).toEqual([]);
		expect(n).toBe(1);
	});
});

describe("think filter", () => {
	test("drops think spans split across chunks", () => {
		const f = thinkFilter();
		const out = ["he", "llo <thi", "nk>secret</th", "ink> wor", "ld"]
			.map(f)
			.join("");
		expect(out).toBe("hello  world");
	});
});

// ─── stub specialist (OpenAI wire) ───
type Mode = "ok" | "429-short" | "429-long" | "length";
let mode: Mode = "ok";
let hits429 = 0;
const seen: Array<{
	model: string;
	messages: Array<{ role: string; content: string }>;
	stream: boolean;
	extra: Record<string, unknown>;
}> = [];
let stub: ReturnType<typeof Bun.serve>;
let stubBase = "";
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

beforeAll(() => {
	stub = Bun.serve({
		port: 0,
		async fetch(req) {
			const b = (await req.json()) as {
				model: string;
				messages: Array<{ role: string; content: string }>;
				stream?: boolean;
				chat_template_kwargs?: unknown;
			};
			seen.push({
				model: b.model,
				messages: b.messages,
				stream: b.stream === true,
				extra: b.chat_template_kwargs
					? { chat_template_kwargs: b.chat_template_kwargs }
					: {},
			});
			if (mode === "429-long" || (mode === "429-short" && hits429 === 0)) {
				hits429++;
				return Response.json(
					{ error: { message: "busy" } },
					{
						status: 429,
						headers: { "retry-after": mode === "429-long" ? "30" : "0" },
					},
				);
			}
			const finish = mode === "length" ? "length" : "stop";
			if (!b.stream)
				return Response.json({
					choices: [
						{
							finish_reason: finish,
							message: { content: `answer from ${b.model}` },
						},
					],
				});
			const stream = new ReadableStream({
				async start(c) {
					const enc = new TextEncoder();
					c.enqueue(
						enc.encode(sse({ choices: [{ delta: { role: "assistant" } }] })),
					);
					c.enqueue(
						enc.encode(
							sse({ choices: [{ delta: { content: "<think>x</think>par" } }] }),
						),
					);
					await Bun.sleep(150);
					c.enqueue(
						enc.encode(
							sse({
								choices: [
									{ delta: { content: "tial" }, finish_reason: finish },
								],
							}),
						),
					);
					c.enqueue(
						enc.encode(sse({ choices: [], usage: { completion_tokens: 2 } })),
					);
					c.enqueue(enc.encode("data: [DONE]\n\n"));
					c.close();
				},
			});
			return new Response(stream, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	stubBase = `http://127.0.0.1:${stub.port}`;
});
afterAll(() => stub.stop(true));

describe("viaLocal against a stub", () => {
	test("429 + Retry-After is reported, not swallowed as an error body", async () => {
		mode = "429-long";
		const r = await viaLocal({ port: 1, model: "m" }, [], 10, 0, {
			base: stubBase,
		});
		expect(r.ok).toBe(false);
		expect(r.status).toBe(429);
		expect(r.retryAfterMs).toBe(30_000);
	});

	test("finish_reason and extra kwargs round-trip", async () => {
		mode = "length";
		seen.length = 0;
		const r = await viaLocal({ port: 1, model: "m" }, [], 10, 0, {
			base: stubBase,
			extra: { chat_template_kwargs: { enable_thinking: false } },
		});
		expect(r.ok).toBe(true);
		expect(r.finish).toBe("length");
		expect(seen[0]?.extra).toEqual({
			chat_template_kwargs: { enable_thinking: false },
		});
	});
});

async function readSse(res: Response): Promise<{
	events: Array<{ event: string; data: Record<string, unknown> }>;
	firstAt: number;
}> {
	const t0 = performance.now();
	let firstAt = -1;
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	const reader = res.body?.getReader();
	const dec = new TextDecoder();
	let buf = "";
	for (;;) {
		const { value, done } = (await reader?.read()) ?? {
			done: true,
			value: undefined,
		};
		if (done) break;
		if (firstAt < 0) firstAt = performance.now() - t0;
		buf += dec.decode(value, { stream: true });
		const parts = buf.split("\n\n");
		buf = parts.pop() ?? "";
		for (const p of parts) {
			const ev = /^event: (.+)$/m.exec(p)?.[1] ?? "";
			const data = /^data: (.+)$/m.exec(p)?.[1] ?? "{}";
			events.push({ event: ev, data: JSON.parse(data) });
		}
	}
	return { events, firstAt };
}

describe("OpenAI SSE → Anthropic SSE", () => {
	test("event order, think stripped, max_tokens stop, streamed not buffered", async () => {
		mode = "length";
		const up = await fetch(`${stubBase}/v1/chat/completions`, {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [], stream: true }),
		});
		let done: { chars: number; finish?: string } | undefined;
		const t0 = performance.now();
		const res = new Response(
			anthropicSseFromOpenAi(
				up.body ?? new ReadableStream(),
				{ id: "msg_t", model: "x", routing: { port: 8901 } },
				(r) => {
					done = r;
				},
			),
		);
		const { events, firstAt } = await readSse(res);
		const total = performance.now() - t0;
		expect(events.map((e) => e.event)).toEqual([
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
			"message_stop",
		]);
		const text = events
			.filter((e) => e.event === "content_block_delta")
			.map((e) => (e.data.delta as { text: string }).text)
			.join("");
		expect(text).toBe("partial");
		const md = events.find((e) => e.event === "message_delta")?.data as {
			delta: { stop_reason: string };
			usage: { output_tokens: number };
		};
		expect(md.delta.stop_reason).toBe("max_tokens");
		expect(md.usage.output_tokens).toBe(2);
		const msg = events[0]?.data.message as { _routing: unknown } | undefined;
		expect(msg?._routing).toEqual({ port: 8901 });
		expect(done).toEqual({ chars: 7, finish: "length", error: undefined });
		// first bytes arrive before the stub's 150 ms mid-stream pause ends
		expect(firstAt).toBeLessThan(total - 100);
	});
});

// ─── router-shim end-to-end against the stub (BELT_UPSTREAM_BASE) ───
let shim: ReturnType<typeof Bun.spawn> | undefined;
let shimBase = "";
let home = "";

async function freePort(): Promise<number> {
	const s = Bun.serve({ port: 0, fetch: () => new Response("") });
	const p = s.port ?? 0;
	s.stop(true);
	return p;
}

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "w270-"));
	mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
	writeFileSync(
		join(home, ".claude", "local-llm", "prefs.json"),
		JSON.stringify({ allow_cloud: false, kev: { enabled: false } }),
	);
	const port = await freePort();
	shimBase = `http://127.0.0.1:${port}`;
	shim = Bun.spawn({
		cmd: [
			process.execPath,
			new URL("../bin/router-shim.ts", import.meta.url).pathname,
		],
		env: {
			...process.env,
			HOME: home,
			BELT_ROUTER_PORT: String(port),
			BELT_UPSTREAM_BASE: stubBase,
			BELT_RETRY_WAIT_CAP_MS: "500",
		},
		stdout: "ignore",
		stderr: "ignore",
	});
	for (let i = 0; i < 100; i++) {
		const up = await fetch(`${shimBase}/health/liveliness`)
			.then((r) => r.ok)
			.catch(() => false);
		if (up) return;
		await Bun.sleep(50);
	}
	throw new Error("router-shim did not come up");
});
afterAll(() => {
	shim?.kill();
	rmSync(home, { recursive: true, force: true });
});

const post = (body: Record<string, unknown>) =>
	fetch(`${shimBase}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model: "glm-5.3-flash",
			max_tokens: 2048,
			temperature: 0,
			...body,
		}),
	});

describe("router-shim end-to-end (stub upstream)", () => {
	test("code-gen lands on the coder with the system prompt intact", async () => {
		mode = "ok";
		seen.length = 0;
		const r = await post({
			system: "Reply with one ```js block only.",
			messages: [
				{
					role: "user",
					content: "rotate(arr, k) returns arr rotated right by k",
				},
			],
		});
		const j = (await r.json()) as { _routing: { port: number } };
		expect(r.status).toBe(200);
		expect(j._routing.port).toBe(8901);
		expect(seen[0]?.model).toBe(byPort(8901)?.model ?? "");
		expect(seen[0]?.messages[0]).toEqual({
			role: "system",
			content: "Reply with one ```js block only. /no_think",
		});
	});

	test("long log haystack goes to reason, not coder", async () => {
		mode = "ok";
		seen.length = 0;
		const r = await post({ messages: [{ role: "user", content: HAYSTACK }] });
		const j = (await r.json()) as { _routing: { port: number } };
		expect(j._routing.port).toBe(8903);
		expect(seen[0]?.extra).toEqual({
			chat_template_kwargs: { enable_thinking: false },
		});
	});

	test("stream:true is piped as Anthropic SSE", async () => {
		mode = "ok";
		const r = await post({
			stream: true,
			messages: [
				{ role: "user", content: "Write a JavaScript function add(a, b)." },
			],
		});
		expect(r.headers.get("content-type")).toContain("text/event-stream");
		expect(JSON.parse(r.headers.get("x-belt-routing") ?? "{}").port).toBe(8901);
		const { events } = await readSse(r);
		expect(events.at(-1)?.event).toBe("message_stop");
		const text = events
			.filter((e) => e.event === "content_block_delta")
			.map((e) => (e.data.delta as { text: string }).text)
			.join("");
		expect(text).toBe("partial");
	});

	test("finish length → stop_reason max_tokens (non-stream)", async () => {
		mode = "length";
		const r = await post({
			messages: [
				{ role: "user", content: "Write a JavaScript function add(a, b)." },
			],
		});
		expect(((await r.json()) as { stop_reason: string }).stop_reason).toBe(
			"max_tokens",
		);
	});

	test("short upstream 429 is waited out on the same specialist", async () => {
		mode = "429-short";
		hits429 = 0;
		seen.length = 0;
		const r = await post({
			messages: [
				{ role: "user", content: "Write a JavaScript function add(a, b)." },
			],
		});
		const j = (await r.json()) as { _routing: { port: number; note: string } };
		expect(r.status).toBe(200);
		expect(j._routing.port).toBe(8901);
		expect(j._routing.note).not.toContain("fallback");
		expect(seen.map((s) => s.model)).toEqual([
			byPort(8901)?.model,
			byPort(8901)?.model,
		]);
	});

	test("long upstream 429 everywhere → router 429 with Retry-After", async () => {
		mode = "429-long";
		const r = await post({
			messages: [
				{ role: "user", content: "Write a JavaScript function add(a, b)." },
			],
		});
		expect(r.status).toBe(429);
		expect(r.headers.get("retry-after")).toBe("30");
		const j = (await r.json()) as { error: { type: string } };
		expect(j.error.type).toBe("overloaded_error");
	});
});

describe("direct-tier bypass policy (engine hop)", () => {
	test("committed policy bypasses the hot local tiers, not on-demand general", () => {
		const d = loadDirectTiers(
			new URL("../bin/routing-policy.yaml", import.meta.url).pathname,
		);
		expect(d).toEqual({
			"local-coder": "http://127.0.0.1:8901/v1",
			"local-extract": "http://127.0.0.1:8902/v1",
			"local-reason": "http://127.0.0.1:8903/v1",
		});
		expect(d["local-general"]).toBeUndefined();
	});

	test("resolveTarget: direct alias → port, everything else → gateway", () => {
		const d = { "local-coder": "http://127.0.0.1:8901/v1" };
		expect(resolveTarget("local-coder", "http://127.0.0.1:4100", d)).toEqual({
			base: "http://127.0.0.1:8901/v1",
			direct: true,
		});
		expect(resolveTarget("glm-5.3-flash", "http://127.0.0.1:4100", d)).toEqual({
			base: "http://127.0.0.1:4100",
			direct: false,
		});
	});

	test("non-loopback bases are rejected; /v1 is normalised", () => {
		expect(() =>
			parseDirect("direct:\n  x: https://evil.example/v1\n"),
		).toThrow(/loopback/);
		expect(parseDirect("direct:\n  x: http://localhost:8902\n")).toEqual({
			x: "http://localhost:8902/v1",
		});
	});
});
