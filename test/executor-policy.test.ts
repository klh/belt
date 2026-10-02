import { describe, expect, test } from "bun:test";
import {
	applyExecutorPolicy,
	emitRouterSettings,
	executorOfModelName,
	loadGatewayPolicy,
	parsePolicy,
	pruneFallbacks,
} from "../bin/router-policy.ts";

const REPO_POLICY = new URL("../bin/routing-policy.yaml", import.meta.url)
	.pathname;

describe("executor policy (W201.1)", () => {
	test("committed default: claude + openai disabled (owner 2026-10-02)", () => {
		const p = loadGatewayPolicy(REPO_POLICY);
		expect(p.executor_policy.disabled_executors).toEqual(["claude", "openai"]);
	});

	test("model-list matching attributes executors by model_name prefix", () => {
		expect(executorOfModelName("claude-sonnet-5")).toBe("claude");
		expect(executorOfModelName("gpt-5.2")).toBe("openai");
		expect(executorOfModelName("glm-5.3-flash")).toBe("zai");
		expect(executorOfModelName("glm-5.3")).toBe("zai");
		expect(executorOfModelName("local-swarm")).toBe("local");
		expect(executorOfModelName("nas-coder")).toBe("local");
		expect(executorOfModelName("local-coder")).toBe("local");
	});

	test("policy drops disabled-executor entries + reports the dropped", () => {
		const policy = parsePolicy(
			"version: 1\nexecutor_policy:\n  disabled_executors: [claude, openai]\n",
		);
		const entries = [
			{ name: "glm-5.3-flash" },
			{ name: "claude-sonnet-5" },
			{ name: "gpt-5.2" },
			{ name: "local-swarm" },
		];
		const { kept, dropped } = applyExecutorPolicy(entries, policy);
		expect(kept.map((e) => e.name)).toEqual(["glm-5.3-flash", "local-swarm"]);
		expect(dropped).toEqual(["claude-sonnet-5", "gpt-5.2"]);
	});

	test("ladder rungs referencing dropped models prune; dead head kills", () => {
		const policy = parsePolicy(
			"version: 1\nexecutor_policy:\n  disabled_executors: [openai]\ngateway:\n  fallbacks:\n    glm-5.3-flash: [local-swarm, gpt-5.2, claude-sonnet-5]\n    gpt-5.2: [local-swarm]\n",
		);
		const alive = new Set(["glm-5.3-flash", "local-swarm"]);
		const pruned = pruneFallbacks(policy, alive);
		expect(pruned.fallbacks).toEqual({ "glm-5.3-flash": ["local-swarm"] });
	});

	test("empty survivor list drops the ladder line entirely", () => {
		const policy = parsePolicy(
			"version: 1\ngateway:\n  fallbacks:\n    glm-5.3-flash: [local-swarm]\n",
		);
		const pruned = pruneFallbacks(policy, new Set(["other"]));
		expect(pruned.fallbacks).toEqual({});
	});

	test("regen shape: emitted ladder prunes to survivors, knobs intact", () => {
		const policy = loadGatewayPolicy(REPO_POLICY);
		const cloud = [
			{ name: "glm-5.3-flash" },
			{ name: "glm-5.3" },
			{ name: "glm-5.2" },
			{ name: "claude-sonnet-5" },
			{ name: "claude-haiku-4-5" },
			{ name: "local-swarm" },
			{ name: "gpt-5.2" },
		];
		const { kept, dropped } = applyExecutorPolicy(cloud, policy);
		expect(dropped).toEqual(["claude-sonnet-5", "claude-haiku-4-5", "gpt-5.2"]);
		const alive = new Set([
			...kept.map((e) => e.name),
			"local-coder",
			"nas-coder",
		]);
		const out = emitRouterSettings(pruneFallbacks(policy, alive));
		expect(out).toContain("    - glm-5.3-flash: [local-swarm]");
		expect(out.includes("gpt-5.2")).toBe(false);
		expect(out.includes("claude-sonnet-5")).toBe(false);
	});

	test("policy flip → regen restores the full ladder", () => {
		const policy = parsePolicy(
			"version: 1\nexecutor_policy:\n  disabled_executors: []\ngateway:\n  fallbacks:\n    glm-5.3-flash: [local-swarm, gpt-5.2, claude-sonnet-5]\n",
		);
		const alive = new Set([
			"glm-5.3-flash",
			"local-swarm",
			"gpt-5.2",
			"claude-sonnet-5",
		]);
		const out = emitRouterSettings(pruneFallbacks(policy, alive));
		expect(out).toContain(
			"    - glm-5.3-flash: [local-swarm, gpt-5.2, claude-sonnet-5]",
		);
	});
});
