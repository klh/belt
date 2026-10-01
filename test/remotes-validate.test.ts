// W192 — remotes-validate: field grammars, raw-mDNS distrust, and the
// validated entry builder gateway-config consumes. The injection attempts
// here are the point: a hostile remotes.json entry must be SKIPPED with a
// locator, never interpolated into litellm.yaml.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
	buildRemoteEntries,
	isRawMdnsEntry,
	validateMachine,
	validateRemotes,
	validBase,
	validHost,
	validModel,
	validName,
	validPort,
} from "../bin/remotes-validate.ts";

describe("remotes field grammars (W192)", () => {
	test("name: letters/digits/dot/_/-, starts alphanumeric, ≤64", () => {
		expect(validName("nas")).toBe(true);
		expect(validName("zai")).toBe(true);
		expect(validName("has space")).toBe(false);
		expect(validName("na:s")).toBe(false);
		expect(validName("-lead")).toBe(false);
		expect(validName("x\ny")).toBe(false);
		expect(validName("")).toBe(false);
		expect(validName("a".repeat(65))).toBe(false);
		expect(validName("a".repeat(64))).toBe(true);
	});

	test("host: DNS labels or dotted-quad IPv4; no colons/spaces/gaps", () => {
		expect(validHost("nas.threads.dk")).toBe(true);
		expect(validHost("api.z.ai")).toBe(true);
		expect(validHost("nas.local")).toBe(true); // static .local config is legit — raw mdns is not
		expect(validHost("192.168.1.73")).toBe(true);
		expect(validHost("has space")).toBe(false);
		expect(validHost("host:8080")).toBe(false);
		expect(validHost("a..b")).toBe(false);
		expect(validHost("1.2.3.256")).toBe(false);
		expect(validHost("")).toBe(false);
	});

	test("port: integer 1-65535", () => {
		expect(validPort(1)).toBe(true);
		expect(validPort(443)).toBe(true);
		expect(validPort(65_535)).toBe(true);
		expect(validPort(0)).toBe(false);
		expect(validPort(-1)).toBe(false);
		expect(validPort(443.5)).toBe(false);
		expect(validPort(65_536)).toBe(false);
		expect(validPort("443")).toBe(false);
	});

	test("model: provider id charset (dots/colons/slashes/hyphens), no whitespace", () => {
		expect(validModel("qwen2.5:0.5b")).toBe(true);
		expect(validModel("glm-5.3-flash")).toBe(true);
		expect(validModel("anthropic/glm-5.3")).toBe(true);
		expect(validModel("")).toBe(false);
		expect(validModel("x y")).toBe(false);
		expect(validModel("m\n      api_key: EVIL")).toBe(false);
		expect(validModel("a".repeat(129))).toBe(false);
		expect(validModel("a".repeat(128))).toBe(true);
	});

	test("base: http(s) URL, no whitespace or control characters", () => {
		expect(validBase("https://api.z.ai/api/paas/v4")).toBe(true);
		expect(validBase("http://box.lan:9/v1")).toBe(true);
		expect(validBase("ftp://x/v1")).toBe(false);
		expect(validBase("https://a b/x")).toBe(false);
		expect(validBase("not a url")).toBe(false);
		expect(validBase("https://ok/x")).toBe(true);
		expect(validBase("https://ok/x\ttail")).toBe(false);
	});
});

describe("raw mDNS distrust (W192)", () => {
	test("discover() shape — bare name, .local host, port 0 — is the fingerprint", () => {
		expect(isRawMdnsEntry({ name: "evil", host: "evil.local", port: 0 })).toBe(
			true,
		);
		expect(isRawMdnsEntry({ host: "evil.local" })).toBe(true); // port unset
		expect(
			isRawMdnsEntry({ name: "evil", host: "evil.local", port: 39_281 }),
		).toBe(false);
		expect(isRawMdnsEntry({ name: "e", host: "nas.threads.dk", port: 0 })).toBe(
			false,
		); // plain invalid port, not the mdns shape
	});

	test("raw mdns entries are skipped with the distrust why", () => {
		const v = validateRemotes({
			machines: [
				{ name: "ghost", host: "ghost.local", port: 0, endpoints: [] },
			],
		});
		expect(v.ok).toBe(true);
		if (!v.ok) return;
		expect(v.machines).toHaveLength(0);
		expect(v.skipped).toHaveLength(1);
		expect(v.skipped[0]?.ref).toBe("ghost");
		expect(v.skipped[0]?.why).toContain("raw mDNS discovery entry");
		expect(v.skipped[0]?.why).toContain("probe first");
	});
});

describe("machine/endpoint validation (W192)", () => {
	test("well-formed machine passes with endpoints preserved", () => {
		const v = validateMachine({
			name: "nas",
			host: "nas.threads.dk",
			endpoints: [
				{
					port: 11434,
					protocol: "openai",
					roles: ["general"],
					model: "qwen2.5:0.5b",
				},
			],
		});
		expect(v.ok).toBe(true);
		if (!v.ok) return;
		expect(v.machine.endpoints).toHaveLength(1);
		expect(v.machine.endpoints[0]?.model).toBe("qwen2.5:0.5b");
	});

	test("anthropic-protocol endpoint is structurally valid (live-file reality)", () => {
		const v = validateMachine({
			name: "anthropic",
			host: "api.anthropic.com",
			endpoints: [
				{
					port: 443,
					protocol: "anthropic",
					roles: [],
					base: "https://api.anthropic.com/v1",
				},
			],
		});
		expect(v.ok).toBe(true);
	});

	test("machine-level failures: bad name/host/cloud/endpoints shape", () => {
		for (const m of [
			{ name: "na:s", host: "ok.example", endpoints: [] },
			{ name: "ok", host: "host:8080", endpoints: [] },
			{ name: "ok", host: "ok.example", cloud: "yes", endpoints: [] },
			{ name: "ok", host: "ok.example", endpoints: "all" },
		]) {
			const v = validateMachine(m);
			expect(v.ok).toBe(false);
		}
	});

	test("endpoint-level failure names the endpoint, machine survives the doc", () => {
		const v = validateRemotes({
			machines: [
				{
					name: "nas",
					host: "nas.threads.dk",
					endpoints: [
						{
							port: 70000,
							protocol: "openai",
							roles: [],
							model: "qwen2.5:0.5b",
						},
					],
				},
			],
		});
		expect(v.ok).toBe(true);
		if (!v.ok) return;
		expect(v.machines).toHaveLength(0); // machine contributed nothing
		expect(v.skipped[0]?.ref).toBe("nas.endpoints[0]");
		expect(v.skipped[0]?.why).toContain("port must be an integer 1-65535");
	});
});

describe("document validation (W192)", () => {
	test("fatal when machines is missing or not an array", () => {
		expect(validateRemotes({}).ok).toBe(false);
		expect(validateRemotes({ machines: "all" }).ok).toBe(false);
		expect(validateRemotes(null).ok).toBe(false);
		expect(validateRemotes("junk").ok).toBe(false);
	});

	test("poisoned doc: injection attempts skipped, valid machines survive", () => {
		const v = validateRemotes({
			machines: [
				{
					name: "nas",
					host: "nas.threads.dk",
					endpoints: [
						{
							port: 11434,
							protocol: "openai",
							roles: ["general"],
							model: "qwen2.5:0.5b",
						},
					],
				},
				{
					name: "evil\n  shadowed: true",
					host: "evil.example",
					endpoints: [],
				},
				{ name: "ghost", host: "ghost.local", port: 0, endpoints: [] },
			],
		});
		expect(v.ok).toBe(true);
		if (!v.ok) return;
		expect(v.machines).toHaveLength(1);
		const refs = v.skipped.map((s) => s.ref);
		expect(refs).toContain("machines[1].name");
		expect(refs).toContain("ghost");
	});
});

describe("entry builder (W192)", () => {
	test("entry text matches the pre-W192 shape verbatim (LAN + cloud)", () => {
		const { entries, skipped } = buildRemoteEntries({
			machines: [
				{
					name: "nas",
					host: "nas.threads.dk",
					endpoints: [
						{
							port: 11434,
							protocol: "openai",
							roles: ["general"],
							model: "qwen2.5:0.5b",
						},
					],
				},
				{
					name: "zai",
					host: "api.z.ai",
					cloud: true,
					endpoints: [
						{
							port: 443,
							protocol: "openai",
							roles: ["fast"],
							base: "https://api.z.ai/api/paas/v4",
							model: "glm-5.3-flash",
						},
					],
				},
			],
		});
		expect(skipped).toHaveLength(0);
		expect(entries).toEqual([
			[
				"  - model_name: nas-qwen2.5-0.5b",
				"    litellm_params:",
				"      model: openai/qwen2.5:0.5b",
				"      api_base: http://nas.threads.dk:11434/v1",
				"      api_key: dummy",
			].join("\n"),
			[
				"  - model_name: zai-glm-5.3-flash",
				"    litellm_params:",
				"      model: openai/glm-5.3-flash",
				"      api_base: https://api.z.ai/api/paas/v4",
				"      api_key: os.environ/Z_AI_API_KEY",
			].join("\n"),
		]);
	});

	test("injected model/base values never reach an entry", () => {
		const { entries } = buildRemoteEntries({
			machines: [
				{
					name: "evil",
					host: "evil.example",
					endpoints: [
						{
							port: 8000,
							protocol: "openai",
							roles: [],
							model: "x\n      api_key: EVIL",
						},
						{
							port: 8001,
							protocol: "openai",
							roles: [],
							model: "ok",
							base: "https://ok/x\n  - model_name: shadow",
						},
					],
				},
			],
		});
		expect(entries).toHaveLength(0); // both endpoints invalid → nothing emitted
	});

	test("fatal document shape emits nothing and names the file", () => {
		const { entries, skipped } = buildRemoteEntries({ machines: 3 });
		expect(entries).toHaveLength(0);
		expect(skipped[0]?.ref).toBe("remotes.json");
	});

	test("shipped example validates cleanly and yields both tiers", () => {
		const example = JSON.parse(
			readFileSync(
				new URL("../bin/remotes.example.json", import.meta.url).pathname,
				"utf8",
			),
		);
		const v = validateRemotes(example);
		expect(v.ok).toBe(true);
		if (!v.ok) return;
		expect(v.skipped).toHaveLength(0);
		const { entries } = buildRemoteEntries(example);
		expect(entries.join("\n")).toContain("model_name: nas-qwen2.5-0.5b");
		expect(entries.join("\n")).toContain(
			"model_name: cloud-provider-example-flash",
		);
	});
});
