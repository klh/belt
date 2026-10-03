# bench/arena — variant-matrix arena

Zero-dependency bun harness comparing **variants** of the belt stack on six
sealed task classes. A variant is one cell of the matrix

    transform (none | condense | enhance | both)  ×  model set (glm | local | kev | mixed | all)

Every leg of a variant receives the same transformed prompt bytes. Every
variant runs against the same sealed tasks. Results are reproducible by
run-id plus manifest.

## Modules

| file                | role                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `core.ts`           | constants, task types, seeded RNG, canonical JSON, prompt framing, stream readers                 |
| `gen.ts`            | deterministic generators for classes a–f (byte-identical to the sealed files)                     |
| `seal.ts`           | `--seal-from` / `--design`, manifest verify, task loading                                         |
| `scoring.ts`        | mechanical checkers; code runs under `sandbox-exec`                                               |
| `legs.ts`           | the 7 backends, `MODEL_SETS`, wire clients (SSE streamed), cost                                   |
| `condense.ts`       | reference condenser (`ref-condense/1`), deterministic and idempotent                              |
| `transforms.ts`     | `Transform` interface, enhance client (:4000), disk cache, `prepareTasks`                         |
| `variant.ts`        | variant hash, run-id, `results/manifest.jsonl`                                                    |
| `runner.ts`         | AC-gated, resumable round for one variant                                                         |
| `report.ts`         | per-run report and spot-check sheet                                                               |
| `report-variant.ts` | cross-variant comparison against a baseline                                                       |
| `dryrun.ts`         | every check a round makes, without running the round                                              |
| `stats.ts`          | quantiles, Wilson, seeded bootstrap, formatters                                                   |
| `run.ts`            | CLI                                                                                               |

## Tasks

`tasks/` is a byte-for-byte copy of the reference seal (`--seal-from`). It is
hash-verified, and its manifest sha256 is `6253f509…`. The generators reproduce
every file exactly, and `seal.test.ts` enforces this. Neither `--design` nor
`--seal-from` will overwrite an existing seal.

## Transforms

- Each class has a transform unit (`FIELDS`):
  - a–d: the user `prompt`.
  - e: the routed request `text`. The fixed router framing is harness, not prompt.
  - f: questions `q1`/`q2` only. The log haystack is data, and rewriting it would move the needles.
- `condense` is deterministic and has no cache. Protected segments are left untouched: `"""` blocks,
  code fences, `<log>` blocks, inline code, quoted strings, `<…>` tokens and `KEY:` format lines.
  The tests also check that every digit sequence survives. `condense.test.ts` pins its output with a
  golden hash per class.
- `enhance` is a local-LLM rewrite through the :4000 router. Its output is cached in
  `cache/enhance/<task>.<field>.json` with the input sha, transform version and routed model.
  A mismatch between the input and the transform version is a hard error unless you pass `--refresh-cache`.
  On a failure the task is skipped, unless you pass `--allow-fallback`; then the sealed prompt is sent,
  flagged per row, and not cached.
- `both` runs condense, then enhance, and is cached as a unit.
- **Plug in your own condenser** with `--condenser path/to/mod.ts`. The default export must be a
  `Transform` (`{id, version, deterministic, transform(id, prompt)}`) or a bare
  `(id, prompt) => prompt`. The module's version string, or the sha of its source, becomes part of the variant hash.

## Reproducibility

- variant hash = sha(canonical {transform, transform version, model set, sorted legs}), first 8 hex characters.
- run-id = `YYYYMMDDTHHMMSSZ-<variant hash>`. Resuming with `--run-id` refuses if the variant hash differs.
- Each run appends one row to `results/manifest.jsonl` with:
  - `{run, variant, variant_hash, transform, transform_version, models, legs, classes, n,`
  - `sealed_manifest_hash, enhance_cache_hash, prompts_hash{class}, started}`
- The same row is written as the run's `meta` line.

## Commands

    bun bench/arena/run.ts --dry-run --transform none,condense --models glm      # matrix dry-run (cartesian)
    bun bench/arena/run.ts --prepare --transform enhance                         # AC: warm enhance cache
    bun bench/arena/run.ts --run --transform condense --models local --n 12      # AC: real round
    bun bench/arena/run.ts --report --run-id <id>                                # per-run report
    bun bench/arena/run.ts --report --variant [--runs a,b] [--baseline <id>]     # compare variants

- `--run` and `--prepare` refuse to start without `/tmp/bench-ac-ok` (exit 3).
- `results/` and `cache/` are gitignored.

The variant report pairs every leg by task against the baseline's `pure-api` leg. The baseline is the latest
`none` run that contains `pure-api`. For each leg the report gives:

- the median wall ratio, with a bootstrap CI
- Δquality, with a δ=0.10 non-inferiority check (needs n≥33)
- prompt chars in→out
- the estimated Δinput-tokens, and Δ$/1k from compression (remote-priced legs only)
- the number of fallbacks
