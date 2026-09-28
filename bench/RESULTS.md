# Bench results — 2026-09-23 fleet runs

Raw record: [`benchmarks.jsonl`](benchmarks.jsonl) (116 entries, standard
4-prompt suite, medians decide). Machine: M5 Max 128 GB, rapid-mlx engine,
prefix + response caching on. Every adoption/rejection in
[`docs/add-a-model.md`](../docs/add-a-model.md) traces to lines in this file.

## Current fleet (medians, tok/s)

| Port | Specialist        | Model                  | Median | Note                        |
| ---- | ----------------- | ---------------------- | ------ | --------------------------- |
| 8901 | ⚡ code           | Qwen3-Coder-30B-A3B    | 123.7  | bf16 KV (int8 KV A/B'd out) |
| 8902 | 🏠 extract        | Qwen3-4B               | 158.9  | fastest port in the fleet   |
| 8903 | 🧠 reason         | Qwen3.5-35B-A3B        | 147.9  | MoE, 3B active              |
| 8906 | 🌐 danish/general | Qwen3.5-9B (think-off) | 85.2   | on-demand tier              |
| 8913 | 🔀 rerank         | Qwen3-Reranker-0.6B    | —      | rerank route, not tok/s     |

## The A/B stories these numbers settled

- **MoE beats dense at equal quality** — Qwen3.5-35B-A3B (147.9) vs the
  Qwen3.8-27B dense incumbent (28.3): 5.2x at equal 6/6 determinate-answer
  probes. The :8903 swap and the Qwen3.8 rejection trace here.
- **bf16 KV beats int8 KV** at short contexts — 87.3 (int8) vs 107.4 (bf16)
  on the coder: dequant overhead dominates at short context, −26%. The
  `--kv-cache-dtype int8` flag is documented-rejected in the registry.
- **Think-off is real speed** — Qwen3.5-9B 85.2 think-off on the on-demand
  tier; the routing doctrine routes short tasks to the extract port instead,
  where 158.9 beats everything anyway.
- **Engine change was the biggest lever** — same model (coder): 97.4
  (mlx_lm) → 123.7 (rapid-mlx, MTP + prefix cache).

## Historical baseline (mlx_lm engine, 2026-09-22)

| Model               | Median | Note                       |
| ------------------- | ------ | -------------------------- |
| Qwen3-Coder-30B-A3B | 97.4   | pre-rapid-mlx              |
| Qwen3-4B            | 148.1  |                            |
| Qwen3.5-9B          | 75.6   |                            |
| Qwen3.8-27B         | 27.7   | later rejected (see above) |

Cross-checks used for adoption quality gates: owner-fork replay (13/15
production, 12/15 Intern-Decision-4B) and determinate-answer probes — see
[docs/routing.md](../docs/routing.md) for the measured routing table.
