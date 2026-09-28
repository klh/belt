# Adding a new model

The complete loop: **registry → download → serve → bench → adopt or reject**.
Nothing enters the fleet on vibes; every adoption has a bench line, every
rejection has a reason. (Survey rejections live at the bottom.)

## 0. Prerequisites

- The fleet is running: `bun ~/.claude/local-llm/coordinator.ts status`
- Free RAM ≥ model size + 4 GB headroom (check `coordinator.ts status` totals
  against your machine); consider stopping the on-demand `:8906` if you need
  the room
- an [mlx-community](https://huggingface.co/mlx-community) conversion of the
  model exists (4-bit unless there's a reason otherwise)

## 1. Claim a port

Ports are the fleet's identity. `registry.ts` is the single source of truth:

- 8901-8906, 8911-8913 are named in `SPECIALIST_PORTS`
- 8904/8905 are **retired** (mlx_lm 0.31.x dropped /v1/embeddings + /v1/rerank
  routes — see the registry comments)
- 8912 is Kev (external, `~/dev/kev`) — never reassign

Claim an unused port in `bin/registry.ts` and fill in role, RAM, tier, engine.
If it replaces an existing specialist, keep the old entry around as a comment
with the date and the bench numbers that justified the swap (house style — see
the 8901/8903 comments in the registry).

## 2. Download

```bash
bun ~/.claude/local-llm/coordinator.ts start <port>   # first start downloads via mlx_lm
```

…or explicitly:

```bash
~/.local/share/uv/tools/mlx-lm/bin/python -c \
  'from huggingface_hub import snapshot_download; snapshot_download("mlx-community/<model-id>")'
```

## 3. Serve + smoke

```bash
bun ~/.claude/local-llm/swarm.ts start <port>
bun ~/.claude/local-llm/coordinator.ts status       # port up, correct model
curl -s http://localhost:PORT/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"<id>","messages":[{"role":"user","content":"Say READY"}],"max_tokens":5}'
```

## 4. Bench it

The standard rig is the 4-prompt suite (TS dedupe, web component, trade-offs,
Danish email — the Danish prompt is deliberate: multilingual is a fleet
requirement).

```bash
cd ~/.claude/local-llm
bun bench-suite.ts --port <port> --model <id> --label <short>
bun bench-log.ts list                       # entries
bun bench-log.ts report                     # trend table + HTML graph
```

House rules:

- **Median of the 4 prompts decides** — single-prompt wins are noise
- **A/B against the incumbent at equal probe quality** — speed alone never
  justifies a swap; quality probes (owner-fork replay, determinate-answer
  probes) gate adoption
- **A/B engine flags too** — e.g. the 8901 kv-cache A/B: `--kv-cache-dtype
int8` benched −26% at short contexts (dequant overhead dominates; bf16 KV
  stays). Comment the numbers in the registry.

## 5. Adopt or reject

- **Adopt**: edit `bin/registry.ts`, keep the old entry as a dated comment with
  the bench numbers, let `swarm.ts`/`router-shim.ts` follow the registry
- **Reject**: add a line to the rejection log below — the reason is the value

## Rejection log

| Date       | Model                                  | Verdict                                                                                                |
| ---------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 2026-09-27 | Qwen3.8-27B (dense)                    | 28.3 vs 138.5 tok/s at equal probe quality — the :8903 slot stays Qwen3.5-35B-A3B                      |
| 2026-09-27 | GLM-5.x locally                        | 204–418 GB at 4-bit; no fit in 128 GB — remote-only                                                    |
| 2026-09-27 | Xing4.0-29B-A4B                        | MLA+MTP unproven in MLX, no expected edge over Qwen3.5-35B-A3B                                         |
| 2026-09-27 | Fastino-Nemotron-3.5-Lightning-Finance | English-only; no Danish context. General local model + own docs wins for niche extraction              |
| 2026-09-27 | Intern-Decision-4B                     | 12/15 vs production's 13/15 on the fork replay, CUDA-only serving; revisit only if an MLX port appears |

## Tips

- Keep specialists **resident** (launchd KeepAlive): cold start ≈800ms first
  hit, idle page-out costs 27–50s on first touch — suspenders' keepwarm exists
  to prevent exactly this
- `mx.metal.set_wired_limit(...)` up before long-context serving (prevents
  paging stalls on big batches)
- Engine flags are benchable surface: prefix cache + response cache flags are
  on every specialist for a reason
- The Danish prompt in the bench suite is non-negotiable: multilingual is a
  fleet requirement, and English-only fine-tunes have been rejected on it
