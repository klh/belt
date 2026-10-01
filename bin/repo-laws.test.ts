// bin/repo-laws.test.ts — W164 belt: the resolution chain (dotfile > user
// > central > default), must-no-fit honest errors, and the user plane.
// Pure tests — temp files only (BUCKLE_SECRETS_HOME pinned), no network
// (candidates here are literal fixtures, not probed endpoints).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyLawStack,
	composeLawPlan,
	lawExprToHint,
	parseLlmDotfile,
	resolveLawStack,
	type CentralLaw,
	type LawStack,
} from "./repo-laws.ts";
import { hintFit, hintTotal, parseHint } from "./route-policy.ts";

const TMP = mkdtempSync(join(tmpdir(), "w164-belt-"));
const ENV = { ...process.env, BUCKLE_SECRETS_HOME: join(TMP, "secrets") };
const CAND = (
	kind: string,
	machine: string,
	model: string,
	tags: string,
	healthy = true,
) => ({ kind, machine, model, tags, healthy });

describe("dotfile parse (belt port)", () => {
	test("musts AND, first prefer wins, invalid lines loud", () => {
		const p = parseLlmDotfile("prefer=model:qwen*\nmust=cloud\nprefer=local\n");
		expect(p.ok).toBe(true);
		if (!p.ok) return;
		expect(p.musts).toHaveLength(1);
		expect(p.prefer).not.toBeNull();
		expect(p.tier).toBeNull();
	});

	test("invalid line keeps its number", () => {
		const p = parseLlmDotfile("# c\nwrongo=1\n");
		expect(p.ok).toBe(false);
		if (p.ok) return;
		expect(p.errors).toEqual([
			{
				line: 2,
				why: "unknown law key 'wrongo' — expected prefer=, must=, tier=, fallback=",
			},
		]);
	});
});

describe("resolution order (dotfile > user > central > default)", () => {
	// two candidates: a local qwen and a cloud glm — the pool ordering tells
	// the layers apart
	const pool = [
		CAND(
			"local",
			"box",
			"mlx-community/Qwen3.5-35B-A3B-4bit",
			"reasoning qwen35",
		),
		CAND("cloud", "hub", "glm-5.3", "reasoning glm"),
	];

	const hintOf = (verb: "prefer" | "must", expr: string) => {
		const h = lawExprToHint(verb, expr);
		if (!h.ok) throw new Error(h.why);
		return h.hint;
	};
	const stackOf = (over: Partial<LawStack>): LawStack => ({
		repo: "/r",
		dotfile: null,
		user: null,
		central: [],
		company: false,
		layers: [],
		...over,
	});

	test("dotfile prefer beats user prefer beats central prefer", () => {
		const stack = stackOf({
			dotfile: {
				ok: true,
				musts: [],
				prefer: hintOf("prefer", "local"),
				tier: null,
				fallback: null,
			},
			layers: ["dotfile"],
		});
		const plan = composeLawPlan(stack, null);
		const r = applyLawStack(pool, plan, hintFit, hintTotal);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.candidates[0].machine).toBe("box"); // local first
	});

	test("user prefer applies when the dotfile is absent", () => {
		const stack = stackOf({
			user: {
				ok: true,
				musts: [],
				prefer: hintOf("prefer", "local"),
				tier: null,
				fallback: null,
			},
			layers: ["user"],
		});
		const plan = composeLawPlan(stack, null);
		const r = applyLawStack(pool, plan, hintFit, hintTotal);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.candidates[0].machine).toBe("box");
	});

	test("dotfile prefer OVERRIDES user prefer (repo wins)", () => {
		const stack = stackOf({
			dotfile: {
				ok: true,
				musts: [],
				prefer: hintOf("prefer", "cloud"),
				tier: null,
				fallback: null,
			},
			user: {
				ok: true,
				musts: [],
				prefer: hintOf("prefer", "local"),
				tier: null,
				fallback: null,
			},
			layers: ["dotfile", "user"],
		});
		const plan = composeLawPlan(stack, null);
		const r = applyLawStack(pool, plan, hintFit, hintTotal);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.candidates[0].machine).toBe("hub"); // the dotfile's cloud wins
	});

	test("no laws → belt's own default ordering", () => {
		const plan = composeLawPlan(stackOf({ layers: [] }), null);
		const r = applyLawStack(pool, plan, hintFit, hintTotal);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.candidates[0].machine).toBe("box"); // belt default: locals first
	});

	test("central must beats user prefer (entitlement ceilings) — honestly", () => {
		const stack = stackOf({
			user: {
				ok: true,
				musts: [],
				prefer: hintOf("prefer", "local"),
				tier: null,
				fallback: null,
			},
			central: [{ id: "repos.corp", laws: ["must=cloud"] }],
			company: true,
			layers: ["user", "central"],
		});
		const plan = composeLawPlan(stack, null);
		const r = applyLawStack(pool, plan, hintFit, hintTotal);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		// the cloud glm survives the central must; the local qwen is filtered
		expect(r.candidates.map((c) => c.machine)).toEqual(["hub"]);
	});

	test("must-no-fit errors honestly, NAMING the layer", () => {
		const stack = stackOf({
			central: [{ id: "repos.corp", laws: ["must=model:secret-model"] }],
			company: true,
			layers: ["central"],
		});
		const plan = composeLawPlan(stack, null);
		const r = applyLawStack(pool, plan, hintFit, hintTotal);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.layer).toBe("central:repos.corp");
		expect(r.why).toContain("no healthy full fit");
		expect(r.why).toContain("must never substitutes");
	});

	test("request-hint prefer outranks the dotfile prefer", () => {
		const stack = stackOf({
			dotfile: {
				ok: true,
				musts: [],
				prefer: hintOf("prefer", "cloud"),
				tier: null,
				fallback: null,
			},
			layers: ["dotfile"],
		});
		const req = parseHint("prefer local");
		expect(req.ok).toBe(true);
		if (!req.ok) return;
		const plan = composeLawPlan(stack, req.hint);
		const r = applyLawStack(pool, plan, hintFit, hintTotal);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.candidates[0].machine).toBe("box"); // the request wins
	});
});

describe("resolveLawStack (file-backed)", () => {
	test("dotfile + user config + central last-known all read", () => {
		const repo = mkdtempSync(join(tmpdir(), "w164-brepro-"));
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(repo, ".llm"), "prefer=local\n");
		const home = join(TMP, "stack-home");
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(home, "repo-laws.json"),
			JSON.stringify({
				repos: {
					[repo]: {
						name: "r",
						dotfile: "prefer=cloud\n",
						source: "dotfile",
						updated_at: "",
					},
				},
			}),
		);
		writeFileSync(
			join(home, "federation-last-known.json"),
			JSON.stringify({
				manifest: {
					rules: [
						{
							id: "repos.corp",
							kind: "repo-law",
							target: repo,
							laws: ["must=cloud"],
						},
					],
				},
			}),
		);
		const s = resolveLawStack(repo, { ...ENV, BUCKLE_SECRETS_HOME: home });
		expect(s.dotfile).not.toBeNull();
		expect(s.user).not.toBeNull();
		expect(s.company).toBe(true);
		expect(s.layers).toEqual(["dotfile", "user", "central"]);
	});

	test("private repo: no matching central rule → company false (hub not consulted)", () => {
		const repo = mkdtempSync(join(tmpdir(), "w164-brepprivate-"));
		mkdirSync(repo, { recursive: true });
		const s = resolveLawStack(repo, ENV);
		expect(s.company).toBe(false);
		expect(s.central).toEqual([]);
	});
});
