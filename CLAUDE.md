# belt

Local LLM fleet: MLX specialists (bin/registry.ts = single source of truth),
deterministic router :4000, dashboard :7791, bench rig. Install deploys to
~/.claude/local-llm/. Companions: suspenders (control plane), klh/local
(Caddy .local services), speedy (config layer).

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
