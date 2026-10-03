# RESULTS.md — historical stub

Moved per owner law (2026-10-02): curated tables live in
[benchmarks.md](../../benchmarks.md), questions in
[bench-questions.md](../../bench-questions.md). **Do not store bench data
here.** The 2026-09-23 fleet snapshot is preserved below for provenance.

## Dated run log (pointers only — tables live in benchmarks.md)

- `2026-10-02T21-31-09` — bench-arena n=12, 7 legs × 6 classes, load1 13–41;
  speed strong / quality insufficient → [REPORT-n12.md](../REPORT-n12.md).
- `2026-10-02T22-09-09` — bench-arena n=33, same legs, load1 27–84; speed
  strong / quality weak → [REPORT-n33.md](../REPORT-n33.md).
- post-W270-fix rerun — in flight at W274 compile time; REPORT-postw270.md
  not yet copied in (gap, see benchmarks.md).
- `2026-10-03T07:31Z` W274 AS-IS live probes (55 requests, single-stream,
  load1 6.7–7.5, AC): `:4000/registry.json` 404 (W271 not live); 1-token
  `local-extract` direct `:8902` p50 91 ms vs `:4100` p50 100 ms (n=10 each,
  1.10×); W270 `resolveTarget()` alias sent to `:8902` → 10/10 404
  `model_not_found`; Kev `:8912` 200 <1 ms; embeddings `:8907` down. →
  [benchmarks.md](../benchmarks.md#stack-vs-pure-api--bench-arena-findings-w274-all-setups-as-is).

---

## Historical snapshot (2026-09-23 fleet runs)

Raw record: [`benchmarks.jsonl`](benchmarks.jsonl). Machine: M5 Max 128 GB,
rapid-mlx engine, prefix + response caching on.

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
