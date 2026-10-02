// W267 — bench-suite TTFT mode against a stub streaming server, router
// admission control (concurrent → 429 + Retry-After), prompt fingerprinting,
// and the registry schema (contextTokens, declared external members).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admit, createAdmission } from "../bin/admission.ts";
import {
	buildPrompt,
	type Logger,
	measureTtft,
	median,
	ttftMain,
} from "../bin/bench-ttft.ts";
import { promptFingerprint } from "../bin/prompt-fingerprint.ts";
import { EXTERNAL, fallbackFor, SPECIALISTS } from "../bin/registry.ts";

// stub OpenAI streaming server: prefill delay scales with prompt length
// unless the prompt's first line (the nonce'd prefix head) was seen before.
const seen = new Set<string>();
const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
let stub: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
	stub = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/v1/models")
				return Response.json({ data: [{ id: "stub", owned_by: "stub-mlx" }] });
			const body = (await req.json()) as {
				stream?: boolean;
				messages: Array<{ content: string }>;
			};
			const content = body.messages[0]?.content ?? "";
			const head = content.split("\n")[0] ?? "";
			const hit = seen.has(head);
			seen.add(head);
			const promptTokens = Math.ceil(content.length / 4);
			const delay = hit ? 2 : Math.min(5 + promptTokens / 100, 60);
			const stream = new ReadableStream({
				async start(c) {
					const enc = new TextEncoder();
					c.enqueue(
						enc.encode(sse({ choices: [{ delta: { role: "assistant" } }] })),
					);
					await Bun.sleep(delay);
					c.enqueue(
						enc.encode(sse({ choices: [{ delta: { content: "ok" } }] })),
					);
					c.enqueue(
						enc.encode(
							sse({ choices: [], usage: { prompt_tokens: promptTokens } }),
						),
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
	base = `http://localhost:${stub.port}`;
});
afterAll(() => stub.stop(true));

describe("bench-suite --ttft (stub server)", () => {
	test("buildPrompt approximates the token budget and leads with the nonce", () => {
		const p = buildPrompt(2000, "abc");
		expect(p.startsWith("Session abc.")).toBe(true);
		expect(p.length).toBeGreaterThanOrEqual(8000);
		expect(p.length).toBeLessThan(8200);
	});

	test("median picks the middle value", () => {
		expect(median([5, 1, 3])).toBe(3);
		expect(median([])).toBe(0);
	});

	test("measureTtft reads the stream to the first token + usage", async () => {
		const r = await measureTtft(
			{ baseUrl: base, model: "stub", sizes: [], reps: 1 },
			buildPrompt(2000, "m1"),
		);
		expect(r.ttftMs).toBeGreaterThan(0);
		expect(r.promptTokens).toBeGreaterThan(1900);
	});

	test("ttftMain logs cold/cached/prefill medians per size with meta", async () => {
		const dir = mkdtempSync(join(tmpdir(), "belt-ttft-"));
		const flag = join(dir, "bench-ac-ok");
		writeFileSync(flag, "");
		const rows: Array<{
			metric: string;
			value: number;
			meta: Record<string, unknown>;
		}> = [];
		const log: Logger = (metric, value, meta) =>
			rows.push({ metric, value, meta });
		const code = await ttftMain(
			["--ttft", "--port", "8903", "--sizes", "2000,8000", "--reps", "3"],
			{ acFlag: flag, log, baseUrl: base },
		);
		rmSync(dir, { recursive: true });
		expect(code).toBe(0);
		const metrics = rows.map((r) => r.metric);
		for (const s of [2000, 8000]) {
			expect(metrics).toContain(`ttft_cold_ms_${s}`);
			expect(metrics).toContain(`ttft_cached_ms_${s}`);
			expect(metrics).toContain(`prefill_tps_${s}`);
			const cold = rows.find((r) => r.metric === `ttft_cold_ms_${s}`);
			const hit = rows.find((r) => r.metric === `ttft_cached_ms_${s}`);
			expect(hit?.value ?? Infinity).toBeLessThan(cold?.value ?? 0);
		}
		const meta = rows[0]?.meta ?? {};
		for (const k of ["engine", "revision", "flags", "power", "thermal", "n"])
			expect(meta).toHaveProperty(k);
		expect(meta.engine).toBe("rapid");
		expect(meta.served_by).toBe("stub-mlx");
		expect(meta.n).toBe(3);
	});

	test("refuses to run without the AC-power flag", async () => {
		const log: Logger = () => {
			throw new Error("must not log");
		};
		const code = await ttftMain(["--ttft", "--port", "8903"], {
			acFlag: "/nonexistent/bench-ac-ok",
			log,
			baseUrl: base,
		});
		expect(code).toBe(2);
	});
});

describe("router admission control", () => {
	test("per-port cap: concurrent overflow → 429 + Retry-After, other ports free", async () => {
		const a = createAdmission(4, 3);
		const gates: Array<() => void> = [];
		const slow = () =>
			new Promise<Response>((res) => {
				gates.push(() => res(new Response("ok")));
			});
		const inflight = Array.from({ length: 4 }, () => admit(a, 8901, slow));
		const over = await admit(a, 8901, slow);
		expect(over.status).toBe(429);
		expect(over.headers.get("retry-after")).toBe("3");
		const body = (await over.json()) as { error: { type: string } };
		expect(body.error.type).toBe("overloaded_error");
		expect(a.inflight(8901)).toBe(4);

		const other = admit(a, 8902, async () => new Response("ok"));
		expect((await other).status).toBe(200);

		for (const g of gates) g();
		const done = await Promise.all(inflight);
		expect(done.every((r) => r.status === 200)).toBe(true);
		expect(a.inflight(8901)).toBe(0);
		expect((await admit(a, 8901, async () => new Response("ok"))).status).toBe(
			200,
		);
	});

	test("slot is released when the handler throws; release is idempotent", async () => {
		const a = createAdmission(1, 1);
		await expect(
			admit(a, 8903, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(a.inflight(8903)).toBe(0);
		const rel = a.tryAcquire(8903);
		expect(a.tryAcquire(8903)).toBeNull();
		rel?.();
		rel?.();
		expect(a.inflight(8903)).toBe(0);
	});

	test("env default is 4 in-flight", () => {
		expect(createAdmission().max).toBe(
			Number(process.env.BELT_MAX_INFLIGHT ?? 4),
		);
	});
});

describe("routing log privacy", () => {
	test("fingerprint is a sha256 prefix + length, never text", () => {
		const fp = promptFingerprint("secret source code");
		expect(fp.prompt_sha256).toMatch(/^[0-9a-f]{16}$/);
		expect(fp.prompt_len).toBe(18);
		expect(JSON.stringify(fp)).not.toContain("secret");
	});
});

describe("registry schema", () => {
	test("every specialist and external member declares contextTokens", () => {
		for (const s of [...SPECIALISTS, ...EXTERNAL]) {
			expect(Number.isInteger(s.contextTokens)).toBe(true);
			expect(s.contextTokens).toBeGreaterThan(0);
		}
	});

	test("Kev :8912 is declared as an external resident (~8GB)", () => {
		const kev = EXTERNAL.find((e) => e.port === 8912);
		expect(kev?.model).toBe("jaredpalmer/kev-4b");
		expect(kev?.ram_gb).toBe(8);
		expect(kev?.owner).toContain("~/dev/kev");
	});

	test("no port is claimed twice across specialists + external", () => {
		const ports = [...SPECIALISTS, ...EXTERNAL].map((s) => s.port);
		expect(new Set(ports).size).toBe(ports.length);
	});

	test("small models fall up to the 35B-A3B reasoner", () => {
		expect(fallbackFor(8902)?.model).toBe("mlx-community/Qwen3.5-35B-A3B-4bit");
		expect(fallbackFor(8906)?.port).toBe(8903);
	});
});
