# benchmarks.md — belt model fleet (curated)

THE canonical benchmark table for belt (owner law, 2026-10-02). Not an LLM
dump — one curated row per model, few params, medians decide. The questions
we ask of each model class live in
[bench-questions.md](bench-questions.md); raw append-only records in
[bench/benchmarks.jsonl](bench/benchmarks.jsonl).

**Do not store bench data in other .md files** — update this table instead.

Laws: run on **AC power only** (never battery); medians over N≥12 unless
noted; speed rows are solid, quality rows need ≥130 paired questions
(33 → ±15pts, 130 → ±7, 530 → ±4) — anything smaller is a smoke test; score
per class, never blended; one lever at a time; re-run after any model bump.
Runner: `bun bin/bench-suite.ts --port <port> --model <id> --label <short>`.
TTFT/prefill: `bun bin/bench-suite.ts --ttft --port <port> --sizes 2000,8000,32000`
(cold + prefix-cache-hit TTFT medians; meta: engine, revision, flags, power,
thermal; refuses without `/tmp/bench-ac-ok`).
Fit bench: `bun bin/bench-fit.ts`.

## Chat tiers — M5 Max 128GB (fleet medians, 2026-09-23)

| Port | Role           | Model                       | GB  | tok/s (median) | Verdict                                |
| ---- | -------------- | --------------------------- | --- | -------------- | -------------------------------------- |
| 8901 | code           | Qwen3-Coder-30B-A3B-4bit    | 18  | 123.7          | current coder tier                     |
| 8902 | extract/menial | Qwen3-4B-Instruct-2507-4bit | 2.5 | 158.9          | fastest port in fleet                  |
| 8903 | reason/best    | Qwen3.5-35B-A3B-4bit        | 20  | 147.9          | best quality×speed                     |
| 8906 | danish/general | Qwen3.5-9B-MLX-4bit         | 5   | 85.2           | on-demand                              |
| 8913 | rerank         | Qwen3-Reranker-0.6B         | 0.5 | —              | unbenchmarked (see bench-questions.md) |

## Measured A/B results

| Comparison                                          | Result                     | Verdict                     |
| --------------------------------------------------- | -------------------------- | --------------------------- |
| MoE 35B-A3B vs dense Qwen3.8-27B                    | 147.9 vs 28.3 tok/s (5.2×) | MoE wins at equal quality   |
| bf16 KV vs int8 KV (Coder-30B)                      | 107.4 vs 87.3 tok/s        | bf16 KV wins                |
| rapid-mlx 0.14.3 vs mlx_lm.server (code, Coder-30B) | 121.8 vs 91.9 tok/s (+33%) | rapid-mlx runner wins       |
| rapid-mlx vs mlx_lm.server (reason, dense 27B)      | 29.5 vs 24.8 tok/s (+19%)  | rapid-mlx runner wins       |
| Engine swap (Coder-30B, mlx_lm → rapid-mlx)         | 97.4 → 123.7 tok/s         | biggest single lever so far |

## Fit-classifier backends (W225, 2026-10-02, 12 tasks — smoke test)

| Backend                    |     p50 |     p95 | tokens/12 | agreement | Verdict                             |
| -------------------------- | ------: | ------: | --------: | --------- | ----------------------------------- |
| Qwen3-4B chat JSON (:8902) |   357ms |   876ms |     3,025 | baseline  | KEEP — default fit backend          |
| kev-4B SystemOne (:8912)   | 1,290ms | 1,463ms |     4,744 | 4/12      | REJECT for local fit (cost+latency) |

## Decision-model backends (classifier shootout, 2026-09, 5-task probe — smoke)

| Model                      | Accuracy                                                  | Latency | RAM  | Verdict                                            |
| -------------------------- | --------------------------------------------------------- | ------- | ---- | -------------------------------------------------- |
| Kev-9B                     | 5/5, p 0.98–1.00                                          | ~800ms  | 18GB | OOM-killed by macOS in a RAM spike                 |
| Kev-4B                     | 5/5, p 0.98–1.00                                          | ~1s     | ~8GB | in production, launchd-managed                     |
| Laya-MLX 421M (ModernBERT) | 3/5 — personal collapses into "coding" at 0.94 confidence | 9–28ms  | <1GB | rejected: a 40% misroute rate beats any speed gain |
| Laya-multilingual 322M     | 3/5                                                       | 9–28ms  | <1GB | rejected                                           |

`needs_strong`-style questions come back mushy from Kev (0.17–0.44) — use
`use_case` only unless you calibrate that head yourself.

## W228 fleet refresh — pending (bench when: AC power + downloads done)

| Candidate                   |   GB | Challenging           | Status      |
| --------------------------- | ---: | --------------------- | ----------- |
| Qwen3.5-35B-A3B-OptiQ-4bit  | 22.2 | 8903 incumbent (20GB) | downloading |
| Qwopus3.6-27B-Coder-oQ4-mtp | 17.0 | 8901 incumbent (18GB) | downloading |
| Qwen3.5-9B-OptiQ-4bit       |  7.1 | 8906 incumbent (5GB)  | downloading |

Protocol: one-by-one A/B vs the incumbent; winner keeps the slot and this
table, loser weights get DELETED from the HF cache; rerun the full suite on
any model bump (managed-router lesson: the fleet changes underneath you).

## Rejection log

| Date       | Model                                  | Verdict                                                                            |
| ---------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| 2026-09-23 | Qwen3.8-27B (dense)                    | 28.3 vs 138.5 tok/s at equal probe quality — the :8903 slot stays Qwen3.5-35B-A3B  |
| 2026-09-27 | GLM-5.x locally                        | 204–418GB at 4-bit; no fit in 128GB — remote-only                                  |
| 2026-09-27 | Xing4.0-29B-A4B                        | MLA+MTP unproven in MLX, no expected edge over Qwen3.5-35B-A3B                     |
| 2026-09-27 | Fastino-Nemotron-3.5-Lightning-Finance | English-only; no Danish context — general local model + own docs wins              |
| 2026-09-27 | Intern-Decision-4B                     | 12/15 vs 13/15 fork replay, CUDA-only serving; revisit only if an MLX port appears |
| 2026-10-02 | kev-4B as belt fit-classifier          | 4/12 agreement, 3.6× latency, 1.6× tokens vs :8902 chat-JSON (W225)                |
