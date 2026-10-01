import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	emitRouterSettings,
	loadGatewayPolicy,
	parsePolicy,
} from "../bin/router-policy.ts";

const REPO_POLICY = new URL("../bin/routing-policy.yaml", import.meta.url)
	.pathname;

describe("routing policy (W124)", () => {
	test("committed default carries the owner ladder + native knobs", () => {
		const p = loadGatewayPolicy(REPO_POLICY);
		expect(p.num_retries).toBe(1);
		expect(p.allowed_fails).toBe(3);
		expect(p.cooldown_time).toBe(30);
		expect(p.fallbacks).toEqual({
			"glm-5.3-flash": ["local-swarm", "gpt-5.2", "claude-sonnet-5"],
		});
	});

	test("never flashx anywhere in the policy (owner directive)", () => {
		const p = loadGatewayPolicy(REPO_POLICY);
		expect(JSON.stringify(p).toLowerCase().includes("flashx")).toBe(false);
	});

	test("fallback order is local → OpenAI → Anthropic", () => {
		const p = loadGatewayPolicy(REPO_POLICY);
		const ladder = p.fallbacks?.["glm-5.3-flash"];
		expect(ladder).toEqual(["local-swarm", "gpt-5.2", "claude-sonnet-5"]);
		expect(ladder?.indexOf("local-swarm")).toBeLessThan(
			ladder?.indexOf("gpt-5.2"),
		);
		expect(ladder?.indexOf("gpt-5.2")).toBeLessThan(
			ladder?.indexOf("claude-sonnet-5"),
		);
	});

	test("emit → YAML round-trip preserves ladder + knobs", () => {
		const p = loadGatewayPolicy(REPO_POLICY);
		const doc = Bun.YAML.parse(emitRouterSettings(p)) as {
			router_settings: {
				fallbacks?: Record<string, string[]>[];
			} & Record<string, unknown>;
		};
		expect(doc.router_settings).toEqual({
			routing_strategy: "latency-based-routing",
			num_retries: 1,
			allowed_fails: 3,
			cooldown_time: 30,
			fallbacks: [
				{ "glm-5.3-flash": ["local-swarm", "gpt-5.2", "claude-sonnet-5"] },
			],
		});
	});

	test("emitted ladder line is verbatim LiteLLM fallback shape", () => {
		const out = emitRouterSettings(loadGatewayPolicy(REPO_POLICY));
		expect(out).toContain(
			"    - glm-5.3-flash: [local-swarm, gpt-5.2, claude-sonnet-5]",
		);
	});

	test("runtime copy overrides the committed default", () => {
		const dir = mkdtempSync(join(tmpdir(), "w124-policy-"));
		const path = join(dir, "routing-policy.yaml");
		writeFileSync(
			path,
			[
				"version: 1",
				"gateway:",
				"  num_retries: 2",
				"  allowed_fails: 5",
				"  cooldown_time: 60",
				"  fallbacks:",
				"    glm-5.3-flash: [local-swarm]",
			].join("\n"),
		);
		const p = loadGatewayPolicy(path);
		expect(p.num_retries).toBe(2);
		expect(p.allowed_fails).toBe(5);
		expect(p.cooldown_time).toBe(60);
		expect(p.fallbacks).toEqual({ "glm-5.3-flash": ["local-swarm"] });
		rmSync(dir, { recursive: true, force: true });
	});

	test("defaults apply when the gateway section is absent", () => {
		const p = parsePolicy("version: 1\n");
		expect(p.num_retries).toBe(1);
		expect(p.allowed_fails).toBe(3);
		expect(p.cooldown_time).toBe(30);
		expect(p.fallbacks).toBeUndefined();
	});

	test("emit omits the fallbacks key when none are configured", () => {
		const out = emitRouterSettings(parsePolicy("version: 1\n"));
		expect(out.includes("fallbacks")).toBe(false);
		expect(out).toContain("routing_strategy: latency-based-routing");
	});
});
