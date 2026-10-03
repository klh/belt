# REPORT — bench-arena run `2026-10-02T21-31-09`

Host `Muramasa.localdomain`, bun 1.4.2, started 2026-10-02T21:31:28.377Z, ended 2026-10-02T22:06:24.866Z. Manifest `6253f5092545542e` (matches sealed tasks). Prices: docs.z.ai/guides/overview/pricing (fetched 2026-10-02). Dropped legs: none.

Labels: quality n≥130 moderate, 33–129 weak, <33 insufficient (no claims); speed n≥12 strong. `est` = tokens estimated from chars (router reports 0). `$0 electricity` = local tiers, no marginal API cost, not free. `polluted` = wall p95/p50 > 3 (contention).

## e — decision

| leg | n | err% | trunc% | wall p50 | wall p95 | TTFT p50 | TTFC p50 | in/out tok (mean) | cache% | pass% [Wilson 95%] | mean score [boot 95%] | label | $/1k tasks | out tok/s | load1 | flags |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pure-api | 12 | 0 | 0 | 3,495 | 5,463 | 2,365 | 3,494 | 213/134 | 0 | 100 [76, 100] | 1.00 [1.00, 1.00] | insufficient | $0.0987  | 3,617 | 39.9 |  |
| stack-anthropic | 12 | 0 | 0 | 3,269 | 9,685 | 3,269 | 3,269 | 250/4 | 0 | 100 [76, 100] | 1.00 [1.00, 1.00] | insufficient | $0 electricity | — | 40.0 | est n/s |
| stack-engine-zai | 12 | 0 | 0 | 3,447 | 5,195 | 2,516 | 3,430 | 213/122 | 0 | 100 [76, 100] | 1.00 [1.00, 1.00] | insufficient | $0.0931  | 1,594 | 41.2 |  |
| stack-engine-local | 12 | 0 | 0 | 1,360 | 2,918 | 1,334 | 1,334 | 213/5 | 3 | 75 [47, 91] | 0.75 [0.50, 1.00] | insufficient | $0 electricity | 175 | 40.6 |  |
| local-direct | 12 | 0 | 0 | 146 | 2,621 | 124 | 124 | 213/5 | 3 | 75 [47, 91] | 0.75 [0.50, 1.00] | insufficient | $0 electricity | 219 | 39.3 | polluted |
| kev-direct | 12 | 0 | 0 | 657 | 1,826 | — | — | 177/81 | 0 | 83 [55, 95] | 0.83 [0.58, 1.00] | insufficient | $0 electricity | 111 | 40.1 | n/s |
| stack-router | 12 | 0 | 0 | 102 | 1,251 | 102 | 102 | 30/1 | 0 | 8 [1, 35] | 0.08 [0.00, 0.25] | insufficient | $0 electricity | — | 39.8 | polluted est n/s |

| comparison (A − B, paired by task) | n | Δquality [95% CI] | δ=0.10 | wall ratio A/B median [CI] | Δ$/1k | verdict |
|---|---|---|---|---|---|---|
| stack-anthropic − pure-api | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 1.11× [0.72, 2.00] | $-0.0987 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-zai − pure-api | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 0.89× [0.74, 1.47] | $-0.0056 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-local − pure-api | 12 | -0.250 [-0.500, 0.000] | n<33 — no claim | 0.46× [0.13, 0.63] | $-0.0987 | Δ$ not claimable (quality not shown non-inferior) |
| local-direct − pure-api | 12 | -0.250 [-0.500, 0.000] | n<33 — no claim | 0.05× [0.03, 0.10] | $-0.0987 | Δ$ not claimable (quality not shown non-inferior) |
| kev-direct − pure-api | 12 | -0.167 [-0.417, 0.000] | n<33 — no claim | 0.21× [0.15, 0.35] | $-0.0987 | Δ$ not claimable (quality not shown non-inferior) |
| stack-router − pure-api | 12 | -0.917 [-1.000, -0.750] | n<33 — no claim | 0.04× [0.03, 0.09] | $-0.0987 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − local-direct (real router vs oracle placement) | 12 | 0.250 [0.000, 0.500] | n<33 — no claim | 19.65× [8.24, 43.26] | $0 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − stack-engine-zai (router vs same model via gateway) | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 1.18× [0.56, 1.91] | $-0.0931 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-zai − pure-api (litellm hop) | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 0.89× [0.74, 1.47] | $-0.0056 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-local − local-direct (litellm on local) | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 3.92× [2.79, 12.49] | $0 | Δ$ not claimable (quality not shown non-inferior) |

Routing accuracy per gold label (cold):

| leg | coder | extract | reason | general | cloud | none | Kev conf when right / wrong |
|---|---|---|---|---|---|---|---|
| pure-api | 1/1 | 1/1 | 3/3 | 3/3 | 4/4 | — |  |
| stack-anthropic | 1/1 | 1/1 | 3/3 | 3/3 | 4/4 | — |  |
| stack-engine-zai | 1/1 | 1/1 | 3/3 | 3/3 | 4/4 | — |  |
| stack-engine-local | 1/1 | 1/1 | 3/3 | 3/3 | 1/4 | — |  |
| local-direct | 1/1 | 1/1 | 3/3 | 3/3 | 1/4 | — |  |
| kev-direct | 1/1 | 1/1 | 3/3 | 3/3 | 2/4 | — | 0.47 / 0.12 |
| stack-router | 0/1 | 1/1 | 0/3 | 0/3 | 0/4 | — |  |

stack-router can only emit coder/extract/reason/general/cloud; `none` rows are unwinnable for it by design and are counted.

## d — reasoning

| leg | n | err% | trunc% | wall p50 | wall p95 | TTFT p50 | TTFC p50 | in/out tok (mean) | cache% | pass% [Wilson 95%] | mean score [boot 95%] | label | $/1k tasks | out tok/s | load1 | flags |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pure-api | 12 | 0 | 0 | 5,893 | 12,748 | 2,561 | 5,023 | 107/294 | 0 | 100 [76, 100] | 1.00 [1.00, 1.00] | insufficient | $0.16  | 79 | 16.9 |  |
| stack-anthropic | 12 | 0 | 0 | 4,321 | 14,919 | 4,321 | 4,321 | 96/264 | 0 | 83 [55, 95] | 0.83 [0.58, 1.00] | insufficient | $0 electricity | — | 16.8 | polluted est n/s |
| stack-engine-zai | 12 | 0 | 0 | 7,040 | 15,421 | 2,660 | 5,664 | 107/322 | 0 | 92 [65, 99] | 0.92 [0.75, 1.00] | insufficient | $0.18  | 120 | 17.0 |  |
| stack-engine-local | 12 | 0 | 0 | 6,493 | 16,598 | 971 | 971 | 119/446 | 0 | 92 [65, 99] | 0.92 [0.75, 1.00] | insufficient | $0 electricity | 80 | 17.1 |  |
| local-direct | 12 | 0 | 0 | 6,106 | 13,949 | 212 | 212 | 119/463 | 0 | 92 [65, 99] | 0.92 [0.75, 1.00] | insufficient | $0 electricity | 81 | 16.6 |  |

| comparison (A − B, paired by task) | n | Δquality [95% CI] | δ=0.10 | wall ratio A/B median [CI] | Δ$/1k | verdict |
|---|---|---|---|---|---|---|
| stack-anthropic − pure-api | 12 | -0.167 [-0.417, 0.000] | n<33 — no claim | 0.73× [0.51, 1.01] | $-0.1630 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-zai − pure-api | 12 | -0.083 [-0.250, 0.000] | n<33 — no claim | 1.00× [0.77, 1.11] | $0.0139 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-local − pure-api | 12 | -0.083 [-0.250, 0.000] | n<33 — no claim | 1.13× [0.64, 1.48] | $-0.1630 | Δ$ not claimable (quality not shown non-inferior) |
| local-direct − pure-api | 12 | -0.083 [-0.250, 0.000] | n<33 — no claim | 0.97× [0.57, 1.38] | $-0.1630 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − local-direct (real router vs oracle placement) | 12 | -0.083 [-0.250, 0.000] | n<33 — no claim | 0.78× [0.54, 1.31] | $0 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − stack-engine-zai (router vs same model via gateway) | 12 | -0.083 [-0.250, 0.000] | n<33 — no claim | 0.76× [0.53, 1.16] | $-0.1769 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-zai − pure-api (litellm hop) | 12 | -0.083 [-0.250, 0.000] | n<33 — no claim | 1.00× [0.77, 1.11] | $0.0139 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-local − local-direct (litellm on local) | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 1.10× [0.96, 1.24] | $0 | Δ$ not claimable (quality not shown non-inferior) |

| leg | Brier (self-reported CONFIDENCE vs correct) | n with confidence |
|---|---|---|
| pure-api | 0.000 | 12 |
| stack-anthropic | 0.167 | 12 |
| stack-engine-zai | 0.083 | 12 |
| stack-engine-local | 0.083 | 12 |
| local-direct | 0.083 | 12 |

## a — short-chat

| leg | n | err% | trunc% | wall p50 | wall p95 | TTFT p50 | TTFC p50 | in/out tok (mean) | cache% | pass% [Wilson 95%] | mean score [boot 95%] | label | $/1k tasks | out tok/s | load1 | flags |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pure-api | 12 | 0 | 100 | 16,544 | 17,255 | 2,400 | 16,469 | 65/1,024 | 0 | 0 [0, 24] | 0.25 [0.25, 0.25] | insufficient | $0.52  | 73 | 13.4 |  |
| stack-anthropic | 12 | 0 | 0 | 2,526 | 4,936 | 2,526 | 2,526 | 54/169 | 0 | 100 [76, 100] | 1.00 [1.00, 1.00] | insufficient | $0 electricity | — | 13.7 | est n/s |
| stack-engine-zai | 12 | 0 | 67 | 16,774 | 19,649 | 2,664 | 14,096 | 65/963 | 0 | 42 [19, 68] | 0.56 [0.38, 0.75] | insufficient | $0.49  | 71 | 13.0 |  |
| stack-engine-local | 12 | 0 | 0 | 4,235 | 6,223 | 2,435 | 2,435 | 71/140 | 0 | 100 [76, 100] | 1.00 [1.00, 1.00] | insufficient | $0 electricity | 73 | 13.0 |  |
| local-direct | 12 | 0 | 0 | 2,603 | 4,859 | 221 | 221 | 71/145 | 0 | 92 [65, 99] | 0.98 [0.94, 1.00] | insufficient | $0 electricity | 71 | 13.3 |  |

| comparison (A − B, paired by task) | n | Δquality [95% CI] | δ=0.10 | wall ratio A/B median [CI] | Δ$/1k | verdict |
|---|---|---|---|---|---|---|
| stack-anthropic − pure-api | 12 | 0.750 [0.750, 0.750] | n<33 — no claim | 0.15× [0.10, 0.18] | $-0.5218 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-zai − pure-api | 12 | 0.313 [0.125, 0.500] | n<33 — no claim | 1.03× [0.95, 1.07] | $-0.0307 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-local − pure-api | 12 | 0.750 [0.750, 0.750] | n<33 — no claim | 0.25× [0.21, 0.34] | $-0.5218 | Δ$ not claimable (quality not shown non-inferior) |
| local-direct − pure-api | 12 | 0.729 [0.688, 0.750] | n<33 — no claim | 0.16× [0.13, 0.19] | $-0.5218 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − local-direct (real router vs oracle placement) | 12 | 0.021 [0.000, 0.063] | n<33 — no claim | 0.89× [0.63, 1.18] | $0 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − stack-engine-zai (router vs same model via gateway) | 12 | 0.438 [0.250, 0.625] | n<33 — no claim | 0.14× [0.10, 0.22] | $-0.4910 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-zai − pure-api (litellm hop) | 12 | 0.313 [0.125, 0.500] | n<33 — no claim | 1.03× [0.95, 1.07] | $-0.0307 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-local − local-direct (litellm on local) | 12 | 0.021 [0.000, 0.063] | n<33 — no claim | 1.71× [1.24, 2.19] | $0 | Δ$ not claimable (quality not shown non-inferior) |

## c — extract

| leg | n | err% | trunc% | wall p50 | wall p95 | TTFT p50 | TTFC p50 | in/out tok (mean) | cache% | pass% [Wilson 95%] | mean score [boot 95%] | label | $/1k tasks | out tok/s | load1 | flags |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pure-api | 12 | 0 | 0 | 3,795 | 5,391 | 2,076 | 3,232 | 196/238 | 0 | 100 [76, 100] | 1.00 [1.00, 1.00] | insufficient | $0.15  | 140 | 12.2 |  |
| stack-anthropic | 12 | 0 | 0 | 3,341 | 13,013 | 3,341 | 3,341 | 164/51 | 0 | 67 [39, 86] | 0.92 [0.85, 0.98] | insufficient | $0 electricity | — | 12.8 | polluted est n/s |
| stack-engine-zai | 12 | 0 | 0 | 4,532 | 5,897 | 2,137 | 4,336 | 195/251 | 0 | 100 [76, 100] | 1.00 [1.00, 1.00] | insufficient | $0.15  | 125 | 13.0 |  |
| stack-engine-local | 12 | 0 | 0 | 2,265 | 7,021 | 1,401 | 1,401 | 213/88 | 3 | 100 [76, 100] | 1.00 [1.00, 1.00] | insufficient | $0 electricity | 131 | 13.4 | polluted |
| local-direct | 12 | 0 | 0 | 680 | 1,489 | 134 | 134 | 213/88 | 3 | 100 [76, 100] | 1.00 [1.00, 1.00] | insufficient | $0 electricity | 150 | 13.1 |  |

| comparison (A − B, paired by task) | n | Δquality [95% CI] | δ=0.10 | wall ratio A/B median [CI] | Δ$/1k | verdict |
|---|---|---|---|---|---|---|
| stack-anthropic − pure-api | 12 | -0.083 [-0.146, -0.021] | n<33 — no claim | 0.96× [0.41, 1.93] | $-0.1482 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-zai − pure-api | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 1.15× [1.10, 1.31] | $0.0068 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-local − pure-api | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 0.77× [0.29, 0.93] | $-0.1482 | Δ$ not claimable (quality not shown non-inferior) |
| local-direct − pure-api | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 0.19× [0.16, 0.28] | $-0.1482 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − local-direct (real router vs oracle placement) | 12 | -0.083 [-0.146, -0.021] | n<33 — no claim | 4.23× [2.23, 11.38] | $0 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − stack-engine-zai (router vs same model via gateway) | 12 | -0.083 [-0.146, -0.021] | n<33 — no claim | 0.74× [0.36, 1.58] | $-0.1550 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-zai − pure-api (litellm hop) | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 1.15× [1.10, 1.31] | $0.0068 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-local − local-direct (litellm on local) | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 3.49× [1.55, 4.60] | $0 | Δ$ not claimable (quality not shown non-inferior) |

## b — code-gen

| leg | n | err% | trunc% | wall p50 | wall p95 | TTFT p50 | TTFC p50 | in/out tok (mean) | cache% | pass% [Wilson 95%] | mean score [boot 95%] | label | $/1k tasks | out tok/s | load1 | flags |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pure-api | 12 | 0 | 0 | 6,733 | 19,419 | 2,108 | 6,453 | 91/498 | 0 | 100 [76, 100] | 1.00 [1.00, 1.00] | insufficient | $0.26  | 90 | 14.9 |  |
| stack-anthropic | 12 | 0 | 0 | 2,033 | 7,084 | 2,033 | 2,033 | 89/95 | 0 | 58 [32, 81] | 0.60 [0.33, 0.85] | insufficient | $0 electricity | — | 15.5 | polluted est n/s |
| stack-engine-zai | 12 | 0 | 0 | 8,388 | 26,357 | 2,267 | 7,900 | 91/605 | 0 | 100 [76, 100] | 1.00 [1.00, 1.00] | insufficient | $0.32  | 112 | 14.9 | polluted |
| stack-engine-local | 12 | 0 | 0 | 2,709 | 7,307 | 711 | 711 | 89/108 | 7 | 75 [47, 91] | 0.77 [0.54, 1.00] | insufficient | $0 electricity | 80 | 15.0 |  |
| local-direct | 12 | 0 | 0 | 1,591 | 2,766 | 186 | 186 | 89/105 | 7 | 75 [47, 91] | 0.77 [0.54, 1.00] | insufficient | $0 electricity | 85 | 15.1 |  |

| comparison (A − B, paired by task) | n | Δquality [95% CI] | δ=0.10 | wall ratio A/B median [CI] | Δ$/1k | verdict |
|---|---|---|---|---|---|---|
| stack-anthropic − pure-api | 12 | -0.396 [-0.667, -0.146] | n<33 — no claim | 0.21× [0.14, 0.49] | $-0.2626 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-zai − pure-api | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 1.02× [0.75, 1.39] | $0.0535 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-local − pure-api | 12 | -0.229 [-0.479, 0.000] | n<33 — no claim | 0.33× [0.18, 0.62] | $-0.2626 | Δ$ not claimable (quality not shown non-inferior) |
| local-direct − pure-api | 12 | -0.229 [-0.479, 0.000] | n<33 — no claim | 0.17× [0.13, 0.36] | $-0.2626 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − local-direct (real router vs oracle placement) | 12 | -0.167 [-0.417, 0.000] | n<33 — no claim | 1.31× [1.09, 1.42] | $0 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − stack-engine-zai (router vs same model via gateway) | 12 | -0.396 [-0.667, -0.146] | n<33 — no claim | 0.29× [0.15, 0.46] | $-0.3161 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-zai − pure-api (litellm hop) | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 1.02× [0.75, 1.39] | $0.0535 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-local − local-direct (litellm on local) | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 1.35× [1.16, 2.97] | $0 | Δ$ not claimable (quality not shown non-inferior) |

## f — long-context

| leg | n | err% | trunc% | wall p50 | wall p95 | TTFT p50 | TTFC p50 | in/out tok (mean) | cache% | pass% [Wilson 95%] | mean score [boot 95%] | label | $/1k tasks | out tok/s | load1 | flags |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pure-api | 12 | 0 | 0 | 3,223 | 4,651 | 2,811 | 3,223 | 12,932/92 | 0 | 100 [76, 100] | 1.00 [1.00, 1.00] | insufficient | $1.99  | 275 | 29.0 |  |
| stack-anthropic | 12 | 0 | 0 | 8,811 | 21,293 | 8,811 | 8,811 | 16,826/3 | 0 | 83 [55, 95] | 0.83 [0.58, 1.00] | insufficient | $0 electricity | — | 29.8 | est n/s |
| stack-engine-zai | 12 | 0 | 0 | 2,560 | 5,269 | 2,547 | 2,550 | 12,933/84 | 0 | 100 [76, 100] | 1.00 [1.00, 1.00] | insufficient | $1.98  | 4,924 | 28.6 |  |
| stack-engine-local | 12 | 0 | 0 | 3,603 | 6,627 | 3,472 | 3,472 | 16,747/8 | 0 | 92 [65, 99] | 0.92 [0.75, 1.00] | insufficient | $0 electricity | 76 | 30.1 |  |
| local-direct | 12 | 0 | 0 | 1,481 | 12,282 | 1,334 | 1,334 | 16,747/7 | 0 | 92 [65, 99] | 0.92 [0.75, 1.00] | insufficient | $0 electricity | 64 | 29.5 | polluted |

| comparison (A − B, paired by task) | n | Δquality [95% CI] | δ=0.10 | wall ratio A/B median [CI] | Δ$/1k | verdict |
|---|---|---|---|---|---|---|
| stack-anthropic − pure-api | 12 | -0.167 [-0.417, 0.000] | n<33 — no claim | 2.74× [1.78, 4.03] | $-1.9860 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-zai − pure-api | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 0.82× [0.71, 0.91] | $-0.0039 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-local − pure-api | 12 | -0.083 [-0.250, 0.000] | n<33 — no claim | 0.93× [0.54, 1.86] | $-1.9860 | Δ$ not claimable (quality not shown non-inferior) |
| local-direct − pure-api | 12 | -0.083 [-0.250, 0.000] | n<33 — no claim | 0.38× [0.30, 1.30] | $-1.9860 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − local-direct (real router vs oracle placement) | 12 | -0.083 [-0.333, 0.167] | n<33 — no claim | 5.70× [2.78, 8.15] | $0 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − stack-engine-zai (router vs same model via gateway) | 12 | -0.167 [-0.417, 0.000] | n<33 — no claim | 3.48× [2.57, 4.23] | $-1.9821 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-zai − pure-api (litellm hop) | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 0.82× [0.71, 0.91] | $-0.0039 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-local − local-direct (litellm on local) | 12 | 0.000 [0.000, 0.000] | n<33 — no claim | 1.71× [0.95, 3.10] | $0 | Δ$ not claimable (quality not shown non-inferior) |

| leg | warm (f q2 on same prefix): n | TTFT p50 cold → warm | wall p50 cold → warm | cache% | quality |
|---|---|---|---|---|---|
| pure-api | 12 | 2,811 → 2,462 | 3,223 → 2,488 | 0 | 1.00 |
| stack-anthropic | 12 | 8,811 → 725 | 8,811 → 725 | 0 | 1.00 |
| stack-engine-zai | 12 | 2,547 → 2,694 | 2,560 → 2,739 | 0 | 1.00 |
| stack-engine-local | 12 | 3,472 → 831 | 3,603 → 953 | 10 | 0.92 |
| local-direct | 12 | 1,334 → 941 | 1,481 → 1,061 | 10 | 1.00 |

Spot-check sheet: `results/2026-10-02T21-31-09-spotcheck.md` (120 rows).
