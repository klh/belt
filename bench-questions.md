# bench-questions.md — what we ask of each model class

Executable source of truth is the code (`bin/bench-suite.ts`,
`bin/bench-fit.ts`); this file pins the exact question text so results stay
comparable. Changing a question invalidates cross-version comparisons — note
the change date inline.

Sample-size law (beri.net, 2026-10-02): 33 questions → ±15pts CI, ~130 →
±7, ~530 → ±4; repeats kill model noise, not question-sampling noise; below
~300 datapoints the normal approximation UNDERestimates uncertainty. Suites
below labelled _smoke_ are exactly that.

## Chat tier — 4-prompt fleet suite (smoke; speed only)

Runner: `bun bin/bench-suite.ts --port <port> --model <id> --label <short>`
Params: `max_tokens: 350`, `temperature: 0`, `stream: false`, "Say READY"
warmup. Median tok/s across the 4 prompts is the logged metric — it ranks
SPEED, never quality.

1. `ts-dedupe` — Write a TypeScript function that deduplicates an array of objects by id, keeping the last occurrence. Strict types.
2. `web-component` — Write a native TypeScript web component `<count-badge>` with shadow DOM: attribute count, emits badge-click CustomEvent, re-renders on attribute change.
3. `tradeoffs` — Analyze the architectural trade-offs of event-driven microservices versus a modular monolith for a three-person team. Be concise.
4. `danish` — Skriv en kort og høflig e-mail til min udlejer om at varmen ikke virker.

## Fit-classifier — 12 placement tasks (smoke)

Runner: `bun bin/bench-fit.ts` (env: `KEV_PORT`, `BENCH_N`). Same candidate
fixture for every task; unique cache signature per task (no cache hits).
Metrics: p50/p95 wall latency, tokens, placement agreement vs the default
backend. n=12 — never rank quality on it.

Tasks:

1. fix flaky async test in a scheduler service
2. write a Danish summary of this quarterly report
3. generate a React component for a pricing table
4. refactor the payment reconciliation module
5. explain this stack trace to a junior dev
6. classify customer support tickets by urgency
7. optimize the image pipeline hot loop
8. draft the API contract for the new export endpoint
9. migrate the CMS database schema
10. triage which 8900-range model should serve a chat request
11. write e2e tests for the checkout flow
12. translate the onboarding emails to German

Verdict schema: `{"placement":"local|remote|cloud","model_glob":null,"longrun":bool,"confidence":0-1}`

Calibration law (beri.net 2026-10-02): choice/score answers are overconfident
out of distribution — always offer an explicit "none of these"; treat only
the top confidence band as automation-grade; refit temperatures before
reading score fields as probabilities.

## Reranker (:8913, Qwen3-Reranker-0.6B) — starter set (smoke, n=10)

Form: `query | candidate card | expected relevant (1/0)` — relevance judged
as "would this candidate serve the request" for belt routing. Rerankers
score relevance, not content. Metric: accuracy at 0.5 (or AUC). Grow to
≥130 pairs before claiming quality separation.

Run 2026-10-03 (smoke): acc@0.5 4/10 under every instruct wording; ranking
within a query 3/3; p50 22ms warm. Bare card labels score degenerate
all-no — candidates must carry text. Full findings: the reranker section
in benchmarks.md.

1. fix flaky async test in a scheduler service | coder-30B card | 1
2. fix flaky async test in a scheduler service | danish-9B card | 0
3. write a Danish summary of this quarterly report | danish-9B card | 1
4. write a Danish summary of this quarterly report | coder-30B card | 0
5. optimize the image pipeline hot loop | coder-30B card | 1
6. draft the API contract for the new export endpoint | reason-35B card | 1
7. draft the API contract for the new export endpoint | extract-4B card | 0
8. translate the onboarding emails to German | danish-9B card | 1
9. migrate the CMS database schema | coder-30B card | 1
10. explain this stack trace to a junior dev | reason-35B card | 1

## Decision models (SystemOne / kev / hosted decision APIs)

Standing placement template as used by the fit class above. Protocol for
any hosted decision model (e.g. Jev), per the beri.net full evaluation
(2026-10-02):

1. Shadow eval on OUR labelled dispatch log before any production routing —
   decomposition plus fitted weights, not zero-shot alone.
2. Pin the version (`jev-1.13.0`, never `-latest`); re-run the suite on any
   version bump.
3. Report calibration (ECE), not just accuracy; expect choice/score fields
   overconfident out of distribution; add a "none of these" option to every
   forced choice.
4. Wrong criteria text can score below random (16.7% on a 4-way choice) —
   the question text is the program; diff it like code.
5. State is data, not treated as hostile — anything user-authored inside
   the state (task hints) needs an injection check in front.
