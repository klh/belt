# belt

Local LLM fleet: MLX specialists (bin/registry.ts = single source of truth),
deterministic router :4000, dashboard :7791, bench rig. Install deploys to
~/.claude/local-llm/. Companions: suspenders (control plane), klh/local
(Caddy .local services), speedy (config layer).

## LLM Routing Doctrine

Owner directive 2026-09-29: agents ASK BELT what LLMs are available before
dispatching LLM work — `bun bin/remotes.ts check` / `discover`. Cloud is
fastest for most items and stays the default; use remote/local machines
(NAS ollama, the local swarm) to refine a prompt or plan, for long-running
background tasks, or as fallback when cloud is down. The optimization target
is SPEED, not cost. Config model + verbs: docs/multi-machine.md.

## qlty Quality Doctrine

qlty is THE quality tool; `.qlty/` must exist or the governor's on-write
gate silently no-ops. Three moments: (1) on-write — the suspenders post-files
gate runs qlty-fmt + fast lint and blocks with the diff inline; (2) pre-merge
— `qlty fmt` + `qlty check --fix` on staged files; (3) on-stop — the evidence
gate, not lint.

**SPEC FIRST: read `.qlty/qlty.toml` and the biome rule set BEFORE the first
write here, then code to the spec.** Never emit flagged patterns and let the
gate catch them — recurring offenders: non-null `!` (noNonNullAssertion),
string `+ "\n"` concat (useTemplate), comma operator, unused vars/imports,
use-before-declaration. biome owns code formatting; prettier owns markdown
only — never enable both on code (they deadlock).

## UI law

NEVER `innerHTML` / `document.write` (blocked by the write-gate). `document.createElement` only inside web components (lit). UI = Lit components + design tokens per klh-core-components / klh-lit-dev skills.
