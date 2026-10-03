// W271 — one registration source: registry schema, emitter determinism +
// shape, /registry.json (ETag, 304, HEAD) via the handler AND the real
// router shim on a scratch port (never :4000, never touches :890x).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	emitBuckleUpstreams,
	emitDirectTiers,
	emitLitellmModelList,
	EMITTERS,
	registryEtag,
	registryJson,
	registryResponse,
} from "../bin/registry-emit.ts";
import {
	chatEntries,
	EXTERNAL,
	type RegistryDoc,
	registryDoc,
	registryEntries,
	SPECIALISTS,
} from "../bin/registry.ts";

const EMIT = new URL("../bin/registry-emit.ts", import.meta.url).pathname;
const SHIM = new URL("../bin/router-shim.ts", import.meta.url).pathname;

describe("registry schema (W271)", () => {
	const entries = registryEntries();

	test("one row per specialist + external member, port-sorted", () => {
		expect(entries.length).toBe(SPECIALISTS.length + EXTERNAL.length);
		const ports = entries.map((e) => e.port);
		expect(ports).toEqual([...ports].sort((a, b) => a - b));
		expect(new Set(ports).size).toBe(ports.length);
	});

	test("aliases are unique, gateway-safe, and keep the legacy names", () => {
		const aliases = entries.map((e) => e.alias);
		expect(new Set(aliases).size).toBe(aliases.length);
		for (const a of aliases) expect(a).toMatch(/^[a-z0-9-]+$/);
		expect(chatEntries().map((e) => [e.port, e.alias])).toEqual([
			[8901, "local-coder"],
			[8902, "local-extract"],
			[8903, "local-reason"],
			[8906, "local-general"],
		]);
	});

	test("every row carries the full field set", () => {
		for (const e of entries) {
			expect(e.model.length).toBeGreaterThan(0);
			expect(e.contextTokens).toBeGreaterThan(0);
			expect(["chat", "embed", "rerank", "classify"]).toContain(e.class);
			expect(["resident", "ondemand"]).toContain(e.tier);
			expect(["mlx_lm", "rapid", "external"]).toContain(e.engine);
			expect(e.source).toBe("local");
		}
	});

	test("externals are flagged: Kev :8912 classify, embeddings :8907", () => {
		const kev = entries.find((e) => e.port === 8912);
		const emb = entries.find((e) => e.port === 8907);
		expect(kev?.external).toBe(true);
		expect(kev?.class).toBe("classify");
		expect(emb?.external).toBe(true);
		expect(emb?.class).toBe("embed");
		expect(entries.find((e) => e.port === 8913)?.class).toBe("rerank");
	});

	test("hub source is threaded through every row", () => {
		const doc = registryDoc("hub:nas");
		expect(doc.source).toBe("hub:nas");
		for (const e of doc.entries) expect(e.source).toBe("hub:nas");
	});
});

describe("emitters (W271)", () => {
	test("in-process: same registry → byte-identical output", () => {
		for (const fn of Object.values(EMITTERS)) expect(fn()).toBe(fn());
	});

	test("CLI: two `all --out` runs are byte-identical", () => {
		const dirs = [0, 1].map(() => mkdtempSync(join(tmpdir(), "w271-")));
		try {
			for (const d of dirs) {
				const r = Bun.spawnSync(["bun", EMIT, "all", "--out", d]);
				expect(r.exitCode).toBe(0);
			}
			const [a, b] = dirs.map((d) =>
				readdirSync(d)
					.sort()
					.map((f) => `${f}\n${readFileSync(join(d, f), "utf8")}`)
					.join("\n"),
			);
			expect(readdirSync(dirs[0] ?? "").length).toBe(4);
			expect(a).toBe(b);
		} finally {
			for (const d of dirs) rmSync(d, { recursive: true, force: true });
		}
	});

	test("CLI: stdout emit matches the in-process emitter", () => {
		const r = Bun.spawnSync(["bun", EMIT, "litellm"]);
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toString()).toBe(EMITTERS.litellm());
		expect(Bun.spawnSync(["bun", EMIT, "bogus"]).exitCode).toBe(2);
	});

	test("litellm model_list = chat rows, OpenAI base, placeholder key", () => {
		const doc = Bun.YAML.parse(emitLitellmModelList()) as {
			model_list: {
				model_name: string;
				litellm_params: { model: string; api_base: string; api_key: string };
			}[];
		};
		expect(doc.model_list.map((m) => m.model_name)).toEqual(
			chatEntries().map((e) => e.alias),
		);
		const coder = doc.model_list[0];
		expect(coder?.litellm_params).toEqual({
			model: "openai/mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit",
			api_base: "http://127.0.0.1:8901/v1",
			api_key: "local",
		});
	});

	test("direct tiers cover every servable row, keyed by alias", () => {
		const doc = Bun.YAML.parse(emitDirectTiers()) as {
			direct: Record<string, { url: string; class: string; external: boolean }>;
		};
		expect(Object.keys(doc.direct)).toEqual(
			registryEntries().map((e) => e.alias),
		);
		expect(doc.direct["local-kev"]).toMatchObject({
			url: "http://127.0.0.1:8912",
			class: "classify",
			external: true,
		});
		expect(doc.direct["local-embed"]?.url).toBe("http://127.0.0.1:8907/v1");
	});

	test("buckle upstreams: per-alias groups + local-swarm pool", () => {
		const doc = Bun.YAML.parse(emitBuckleUpstreams()) as {
			version: number;
			groups: Record<
				string,
				{ url: string; dialect: string; adapter: string; model: string }[]
			>;
		};
		expect(doc.version).toBe(1);
		const aliases = chatEntries().map((e) => e.alias);
		expect(Object.keys(doc.groups)).toEqual([...aliases, "local-swarm"]);
		expect(doc.groups["local-swarm"]?.map((d) => d.url)).toEqual(
			chatEntries().map((e) => `http://127.0.0.1:${e.port}`),
		);
		for (const deps of Object.values(doc.groups))
			for (const d of deps) {
				expect(d.dialect).toBe("openai");
				expect(d.adapter).toBe("openai-compat");
			}
	});

	test("no secrets: no inline keys, no env values", () => {
		const all = Object.values(EMITTERS)
			.map((f) => f())
			.join("\n");
		expect(all).not.toMatch(/sk-[A-Za-z0-9]/);
		expect(all).not.toMatch(/os\.environ/);
		for (const m of all.matchAll(/api_key: (\S+)/g)) expect(m[1]).toBe("local");
	});
});

describe("/registry.json handler (W271)", () => {
	const get = (headers: Record<string, string> = {}, method = "GET") =>
		registryResponse(
			new Request("http://x/registry.json", { method, headers }),
		);

	test("200 with full registry + strong ETag over the body", async () => {
		const r = get();
		expect(r.status).toBe(200);
		expect(r.headers.get("content-type")).toContain("application/json");
		const body = await r.text();
		expect(r.headers.get("etag")).toBe(registryEtag(body));
		expect(r.headers.get("etag")).toMatch(/^"sha256-[0-9a-f]{32}"$/);
		const doc = JSON.parse(body) as RegistryDoc;
		expect(doc.version).toBe(1);
		expect(doc.source).toBe("local");
		expect(doc.router.port).toBe(4000);
		expect(doc.entries).toEqual(registryEntries());
	});

	test("If-None-Match → 304 (also in a list, and *)", () => {
		const etag = get().headers.get("etag") ?? "";
		expect(get({ "if-none-match": etag }).status).toBe(304);
		expect(get({ "if-none-match": `"other", ${etag}` }).status).toBe(304);
		expect(get({ "if-none-match": "*" }).status).toBe(304);
		expect(get({ "if-none-match": '"stale"' }).status).toBe(200);
	});

	test("HEAD carries the ETag without a body", async () => {
		const r = get({}, "HEAD");
		expect(r.headers.get("etag")).toBe(get().headers.get("etag"));
		expect(await r.text()).toBe("");
	});

	test("ETag tracks content: a different registry → a different tag", () => {
		const local = registryEtag(registryJson());
		const hub = registryEtag(registryJson(registryDoc("hub:nas")));
		expect(hub).not.toBe(local);
		expect(registryEtag(registryJson())).toBe(local);
	});
});

describe("router shim serves /registry.json (scratch port)", () => {
	let proc: ReturnType<typeof Bun.spawn> | undefined;
	let base = "";
	let home = "";

	beforeAll(async () => {
		const probe = Bun.serve({ port: 0, fetch: () => new Response() });
		const port = probe.port;
		probe.stop(true);
		home = mkdtempSync(join(tmpdir(), "w271-home-"));
		proc = Bun.spawn(["bun", SHIM], {
			env: { ...process.env, HOME: home, BELT_ROUTER_PORT: String(port) },
			stdout: "ignore",
			stderr: "ignore",
		});
		base = `http://127.0.0.1:${port}`;
		for (let i = 0; i < 100; i++) {
			try {
				const r = await fetch(`${base}/health/liveliness`);
				if (r.ok) return;
			} catch {}
			await Bun.sleep(50);
		}
		throw new Error("shim did not start");
	});

	afterAll(() => {
		proc?.kill();
		rmSync(home, { recursive: true, force: true });
	});

	test("GET → 200 + ETag; conditional GET → 304", async () => {
		const r = await fetch(`${base}/registry.json`);
		expect(r.status).toBe(200);
		const etag = r.headers.get("etag") ?? "";
		expect(await r.text()).toBe(registryJson());
		expect(etag).toBe(registryEtag(registryJson()));
		const again = await fetch(`${base}/registry.json`, {
			headers: { "if-none-match": etag },
		});
		expect(again.status).toBe(304);
	});

	test("POST /registry.json is not served", async () => {
		const r = await fetch(`${base}/registry.json`, { method: "POST" });
		expect(r.status).toBe(404);
	});
});
