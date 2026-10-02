# Local LLM fleet — findings from the speed campaign (Sep 2026)

An optional layer on top of speedy: a local MLX specialist swarm behind an
Anthropic-compatible router, so most agent traffic never leaves the machine.
This doc records what we measured, what we swapped, and the gotchas that cost us
time — so a new Mac can skip straight to the good config.

Measured on an M5 Max 128GB, macOS 26. **All benchmark numbers live in
[benchmarks.md](../benchmarks.md)** (owner law, 2026-10-02) — do not store
bench data in this doc; raw records in bench/benchmarks.jsonl.

## Runner: rapid-mlx over mlx_lm.server

A/B on identical prompts (4-prompt battery, warm, temp 0, 350 max tokens):
numbers in [benchmarks.md → Measured A/B results](../benchmarks.md#measured-ab-results).
Short version: rapid-mlx wins (code +33%, reason +19%, extract even).

Why it is faster, concretely:

- **MTP actually works.** `mlx_lm` 0.31.x silently strips weights whose names
  start with `mtp.` at load, so `-mtp` checkpoints give zero speedup there.
  rapid-mlx auto-detects MTP eligibility and uses it.
- Continuous batching + radix prefix cache: repeated prompt prefixes are
  near-free across requests (watch the `cache_fetch HIT` lines in the log).
- KV stays bf16 by default; int4/int8 KV quant is available if RAM-bound.
- Native `/v1/messages` (Anthropic) in addition to `/v1/chat/completions`.

Gotcha: rapid-mlx prints a scary _kernel-panic warning_ whenever projected RAM
use is high. It is a firmware-amcc heuristic, not a hard limit — on a 128GB
machine a 16GB model with 86GB in use is fine, but read the numbers before
dismissing it.

## The fleet (single source of truth)

One registry file holds port↔model↔flags; lifecycle and routing both import it.
Change a model in one place, everything follows.

| Port | Model                             | Role                       | RAM    | Engine |
| ---- | --------------------------------- | -------------------------- | ------ | ------ |
| 8901 | Qwen3-Coder-30B-A3B-Instruct-4bit | code (MoE, 3B active)      | ~18GB  | rapid  |
| 8902 | Qwen3-4B-Instruct-2507-4bit       | extract/simple             | ~2.5GB | rapid  |
| 8903 | Qwen3.5-35B-A3B-4bit              | reason/architecture        | ~20GB  | rapid  |
| 8906 | Qwen3.5-9B-4bit                   | danish/general (on demand) | ~5GB   | rapid  |
| 8912 | Kev-4B decision model             | classifier leg             | ~8GB   | kev    |
| 8913 | Qwen3-Reranker-0.6B-4bit          | rerank (prompt protocol)   | ~0.5GB | rapid  |

Gotcha found live: rapid-mlx 0.15.x serves `/v1/embeddings` but has **no
`/v1/rerank`**. The 0.6B reranker still works — Qwen3-Reranker's native
protocol is a yes/no relevance prompt over `/v1/chat/completions` — but a
server that loads the model is not the same as a server that serves the
route. Probe before documenting.

Model-swap discipline: every swap lives behind one registry line, and the
rollback is reverting that line. Bench before and after with the same battery.

Rerank status: the gap from the mlx_lm 0.31.x retirement is **closed** —
Qwen3-Reranker-0.6B is back as a resident specialist on :8913 (rapid 0.15.x),
consumed via the chat/completions prompt protocol. Embeddings: rapid 0.15.x
serves `/v1/embeddings` natively again, so the on-demand embed server pattern
may be replaceable by the fleet itself — probe before migrating.

## Routing: regex pre-filter, then a small classifier for the ambiguity band

Request flow (all local, ~0 overhead for the common case):

1. **Regex scorer (0ms)** — 7 cheap dimensions (code markers, length, prose
   ratio, …) classify SIMPLE → extract model, code → coder, everything else →
   reason model. Most traffic never leaves this stage.
2. **Ambiguity band** — scores in a calibrated band (we run [0.14, 0.30];
   measure your own distribution first — our first band was dead code because
   prose never scored above 0.25) go to a **typed classifier**.
3. **Kev-4B** (LoRA + pointer head, OpenAI-compatible server, ~1s) answers
   structured questions: `use_case` over 7 classes → a routing table pin
   (coding→coder, architecture/trading/research→reason, personal/business→extract).
4. Bounded fallbacks between neighbors; optional cloud escalation for genuinely
   hard prompts (off in cost mode).

Calibration notes from real traffic: trivial asks → 4B end-to-end in ~0.9s;
architecture prose → classified → 27B; personal email asks never touch the 27B.

## Classifier shootout (Jev-style typed routing)

Numbers and verdicts moved to
[benchmarks.md → Decision-model backends](../benchmarks.md#decision-model-backends)
(owner law 2026-10-02: bench data lives only there). The durable lessons:
a 40% misroute rate beats any speed gain; Kev's `needs_strong` head comes
back mushy — use `use_case` only unless you calibrate that head yourself.

## Benchmarking discipline

Moved to [bench-questions.md](../bench-questions.md) — per-class question
sets, sample-size laws and runner contracts live there; curated tables in
[benchmarks.md](../benchmarks.md); raw append-only records in
bench/benchmarks.jsonl.

## System-level notes (Apple Silicon / Metal)

- `powermode` High Power was already active — check before chasing it.
- MLX can use ~75% of unified RAM as GPU-recommended max; wired-limit raising
  prevents paging stalls on big batches (wire it before long-context serving).
- rapid-mlx evicts UBC for weights at load and sets Metal memory limits
  automatically (`allocation_limit = 90%`, `cache_limit = 20%`).
- **uv tool fragility**: when brew pythons move, uv tool python symlinks die.
  Pin explicitly: `uv tool install --force --python 3.13 mlx-lm` and
  `uv run --python 3.13 …`.
- **launchd gotchas**: `bun` resolves to `~/.local/bin/bun` in some installs
  and vanishes for launchd — use the absolute `/opt/homebrew/bin/bun`;
  LM Studio's `lms` CLI needs the GUI app running once.
- **mlx-community phantom repos**: auto-conversion placeholders exist with
  0–12K of content. Before benchmarking a repo, check the tree size, not the
  name.

## From-scratch setup on a new Mac

```bash
bun setup/llm-stack.ts              # deps + models + smoke bench
bun setup/llm-stack.ts --with-launchd   # also install KeepAlive plists
bun setup/llm-stack.ts --dry-run    # print the commands, run nothing
```

Idempotent, argument-array spawns only, everything under `$HOME`.
