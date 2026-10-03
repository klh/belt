# REPORT — bench-arena run `2026-10-02T22-09-09`

Host `Muramasa.localdomain`, bun 1.4.2, started 2026-10-02T22:10:15.405Z, ended 2026-10-02T23:55:51.776Z. Manifest `6253f5092545542e` (matches sealed tasks). Prices: docs.z.ai/guides/overview/pricing (fetched 2026-10-02). Dropped legs: none.

Labels: quality n≥130 moderate, 33–129 weak, <33 insufficient (no claims); speed n≥12 strong. `est` = tokens estimated from chars (router reports 0). `$0 electricity` = local tiers, no marginal API cost, not free. `polluted` = wall p95/p50 > 3 (contention).

## e — decision

| leg | n | err% | trunc% | wall p50 | wall p95 | TTFT p50 | TTFC p50 | in/out tok (mean) | cache% | pass% [Wilson 95%] | mean score [boot 95%] | label | $/1k tasks | out tok/s | load1 | flags |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pure-api | 33 | 0 | 0 | 3,575 | 7,309 | 2,600 | 3,575 | 211/136 | 0 | 100 [90, 100] | 1.00 [1.00, 1.00] | weak | $0.0994  | 1,806 | 27.2 |  |
| stack-anthropic | 33 | 0 | 0 | 4,519 | 22,187 | 4,519 | 4,519 | 249/4 | 0 | 97 [85, 99] | 0.97 [0.91, 1.00] | weak | $0 electricity | — | 27.1 | polluted est n/s |
| stack-engine-zai | 33 | 0 | 0 | 3,244 | 5,787 | 2,590 | 3,234 | 211/115 | 0 | 100 [90, 100] | 1.00 [1.00, 1.00] | weak | $0.0893  | 1,979 | 27.7 |  |
| stack-engine-local | 33 | 0 | 0 | 1,225 | 5,044 | 1,203 | 1,203 | 210/5 | 3 | 85 [69, 93] | 0.85 [0.73, 0.97] | weak | $0 electricity | 243 | 27.6 | polluted |
| local-direct | 33 | 0 | 0 | 148 | 5,466 | 124 | 124 | 210/5 | 3 | 85 [69, 93] | 0.85 [0.70, 0.97] | weak | $0 electricity | 232 | 27.5 | polluted |
| kev-direct | 33 | 0 | 0 | 1,005 | 3,547 | — | — | 174/82 | 0 | 91 [76, 97] | 0.91 [0.82, 1.00] | weak | $0 electricity | 84 | 27.0 | polluted n/s |
| stack-router | 33 | 0 | 0 | 159 | 931 | 159 | 159 | 29/1 | 0 | 9 [3, 24] | 0.09 [0.00, 0.21] | weak | $0 electricity | — | 27.0 | polluted est n/s |

| comparison (A − B, paired by task) | n | Δquality [95% CI] | δ=0.10 | wall ratio A/B median [CI] | Δ$/1k | verdict |
|---|---|---|---|---|---|---|
| stack-anthropic − pure-api | 33 | -0.030 [-0.091, 0.000] | **non-inferior** | 1.01× [0.64, 1.77] | $-0.0994 | Δ$/1k = $-0.0994 claimable (weak) |
| stack-engine-zai − pure-api | 33 | 0.000 [0.000, 0.000] | **non-inferior** | 0.81× [0.68, 1.00] | $-0.0101 | Δ$/1k = $-0.0101 claimable (weak) |
| stack-engine-local − pure-api | 33 | -0.152 [-0.273, -0.030] | not shown | 0.40× [0.18, 0.57] | $-0.0994 | Δ$ not claimable (quality not shown non-inferior) |
| local-direct − pure-api | 33 | -0.152 [-0.273, -0.030] | not shown | 0.05× [0.04, 0.06] | $-0.0994 | Δ$ not claimable (quality not shown non-inferior) |
| kev-direct − pure-api | 33 | -0.091 [-0.212, 0.000] | not shown | 0.41× [0.17, 0.64] | $-0.0994 | Δ$ not claimable (quality not shown non-inferior) |
| stack-router − pure-api | 33 | -0.909 [-1.000, -0.788] | not shown | 0.05× [0.03, 0.12] | $-0.0994 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − local-direct (real router vs oracle placement) | 33 | 0.121 [0.030, 0.242] | **non-inferior** | 25.54× [10.29, 36.98] | $0 | Δ$/1k = $0 claimable (weak) |
| decomp: stack-anthropic − stack-engine-zai (router vs same model via gateway) | 33 | -0.030 [-0.091, 0.000] | **non-inferior** | 1.05× [0.65, 1.53] | $-0.0893 | Δ$/1k = $-0.0893 claimable (weak) |
| decomp: stack-engine-zai − pure-api (litellm hop) | 33 | 0.000 [0.000, 0.000] | **non-inferior** | 0.81× [0.68, 1.00] | $-0.0101 | Δ$/1k = $-0.0101 claimable (weak) |
| decomp: stack-engine-local − local-direct (litellm on local) | 33 | 0.000 [0.000, 0.000] | **non-inferior** | 5.48× [3.32, 11.05] | $0 | Δ$/1k = $0 claimable (weak) |

Routing accuracy per gold label (cold):

| leg | coder | extract | reason | general | cloud | none | Kev conf when right / wrong |
|---|---|---|---|---|---|---|---|
| pure-api | 6/6 | 1/1 | 7/7 | 4/4 | 7/7 | 8/8 |  |
| stack-anthropic | 6/6 | 1/1 | 7/7 | 4/4 | 6/7 | 8/8 |  |
| stack-engine-zai | 6/6 | 1/1 | 7/7 | 4/4 | 7/7 | 8/8 |  |
| stack-engine-local | 6/6 | 1/1 | 7/7 | 4/4 | 2/7 | 8/8 |  |
| local-direct | 6/6 | 1/1 | 7/7 | 4/4 | 2/7 | 8/8 |  |
| kev-direct | 6/6 | 1/1 | 7/7 | 4/4 | 4/7 | 8/8 | 0.47 / 0.10 |
| stack-router | 2/6 | 1/1 | 0/7 | 0/4 | 0/7 | 0/8 |  |

stack-router can only emit coder/extract/reason/general/cloud; `none` rows are unwinnable for it by design and are counted.

## d — reasoning

| leg | n | err% | trunc% | wall p50 | wall p95 | TTFT p50 | TTFC p50 | in/out tok (mean) | cache% | pass% [Wilson 95%] | mean score [boot 95%] | label | $/1k tasks | out tok/s | load1 | flags |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pure-api | 33 | 0 | 0 | 7,103 | 18,528 | 2,804 | 5,934 | 105/356 | 0 | 94 [80, 98] | 0.94 [0.85, 1.00] | weak | $0.19  | 88 | 62.4 |  |
| stack-anthropic | 33 | 0 | 0 | 3,838 | 13,183 | 3,838 | 3,838 | 94/315 | 0 | 79 [62, 89] | 0.79 [0.64, 0.91] | weak | $0 electricity | — | 61.6 | polluted est n/s |
| stack-engine-zai | 33 | 0 | 0 | 6,898 | 18,010 | 2,965 | 5,450 | 105/352 | 0 | 94 [80, 98] | 0.94 [0.85, 1.00] | weak | $0.19  | 84 | 64.6 |  |
| stack-engine-local | 33 | 0 | 0 | 10,301 | 40,236 | 2,398 | 2,398 | 116/511 | 0 | 88 [73, 95] | 0.88 [0.76, 0.97] | weak | $0 electricity | 54 | 66.7 | polluted |
| local-direct | 33 | 0 | 0 | 8,910 | 27,566 | 234 | 234 | 116/574 | 0 | 91 [76, 97] | 0.91 [0.82, 1.00] | weak | $0 electricity | 53 | 65.4 | polluted |

| comparison (A − B, paired by task) | n | Δquality [95% CI] | δ=0.10 | wall ratio A/B median [CI] | Δ$/1k | verdict |
|---|---|---|---|---|---|---|
| stack-anthropic − pure-api | 33 | -0.152 [-0.303, -0.030] | not shown | 0.61× [0.45, 0.80] | $-0.1939 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-zai − pure-api | 33 | 0.000 [0.000, 0.000] | **non-inferior** | 1.02× [0.68, 1.19] | $-0.0024 | Δ$/1k = $-0.0024 claimable (weak) |
| stack-engine-local − pure-api | 33 | -0.061 [-0.152, 0.000] | not shown | 1.27× [0.99, 1.64] | $-0.1939 | Δ$ not claimable (quality not shown non-inferior) |
| local-direct − pure-api | 33 | -0.030 [-0.091, 0.000] | **non-inferior** | 1.04× [0.86, 1.34] | $-0.1939 | Δ$/1k = $-0.1939 claimable (weak) |
| decomp: stack-anthropic − local-direct (real router vs oracle placement) | 33 | -0.121 [-0.242, -0.030] | not shown | 0.52× [0.47, 0.75] | $0 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − stack-engine-zai (router vs same model via gateway) | 33 | -0.152 [-0.273, -0.030] | not shown | 0.60× [0.47, 0.69] | $-0.1915 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-zai − pure-api (litellm hop) | 33 | 0.000 [0.000, 0.000] | **non-inferior** | 1.02× [0.68, 1.19] | $-0.0024 | Δ$/1k = $-0.0024 claimable (weak) |
| decomp: stack-engine-local − local-direct (litellm on local) | 33 | -0.030 [-0.091, 0.000] | **non-inferior** | 1.19× [1.04, 1.48] | $0 | Δ$/1k = $0 claimable (weak) |

| leg | Brier (self-reported CONFIDENCE vs correct) | n with confidence |
|---|---|---|
| pure-api | 0.061 | 33 |
| stack-anthropic | 0.212 | 33 |
| stack-engine-zai | 0.059 | 33 |
| stack-engine-local | 0.121 | 33 |
| local-direct | 0.091 | 33 |

## a — short-chat

| leg | n | err% | trunc% | wall p50 | wall p95 | TTFT p50 | TTFC p50 | in/out tok (mean) | cache% | pass% [Wilson 95%] | mean score [boot 95%] | label | $/1k tasks | out tok/s | load1 | flags |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pure-api | 33 | 0 | 70 | 18,148 | 20,264 | 2,511 | 15,003 | 65/973 | 0 | 33 [20, 50] | 0.52 [0.41, 0.64] | weak | $0.50  | 65 | 83.5 |  |
| stack-anthropic | 33 | 0 | 0 | 3,005 | 6,394 | 3,005 | 3,005 | 55/173 | 0 | 94 [80, 98] | 0.98 [0.96, 1.00] | weak | $0 electricity | — | 84.2 | est n/s |
| stack-engine-zai | 33 | 0 | 76 | 17,832 | 19,451 | 2,500 | 14,518 | 65/986 | 0 | 24 [13, 41] | 0.44 [0.33, 0.55] | weak | $0.50  | 67 | 84.7 |  |
| stack-engine-local | 33 | 0 | 0 | 6,021 | 11,631 | 3,366 | 3,366 | 71/134 | 0 | 100 [90, 100] | 1.00 [1.00, 1.00] | weak | $0 electricity | 49 | 83.2 |  |
| local-direct | 33 | 0 | 0 | 3,204 | 8,272 | 246 | 246 | 71/140 | 0 | 94 [80, 98] | 0.98 [0.96, 1.00] | weak | $0 electricity | 49 | 83.0 |  |

| comparison (A − B, paired by task) | n | Δquality [95% CI] | δ=0.10 | wall ratio A/B median [CI] | Δ$/1k | verdict |
|---|---|---|---|---|---|---|
| stack-anthropic − pure-api | 33 | 0.462 [0.341, 0.568] | **non-inferior** | 0.17× [0.15, 0.19] | $-0.4965 | Δ$/1k = $-0.4965 claimable (weak) |
| stack-engine-zai − pure-api | 33 | -0.083 [-0.227, 0.061] | not shown | 1.01× [0.92, 1.03] | $0.0065 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-local − pure-api | 33 | 0.477 [0.356, 0.591] | **non-inferior** | 0.34× [0.30, 0.37] | $-0.4965 | Δ$/1k = $-0.4965 claimable (weak) |
| local-direct − pure-api | 33 | 0.462 [0.326, 0.583] | **non-inferior** | 0.17× [0.16, 0.22] | $-0.4965 | Δ$/1k = $-0.4965 claimable (weak) |
| decomp: stack-anthropic − local-direct (real router vs oracle placement) | 33 | 0.000 [-0.030, 0.030] | **non-inferior** | 0.87× [0.71, 1.02] | $0 | Δ$/1k = $0 claimable (weak) |
| decomp: stack-anthropic − stack-engine-zai (router vs same model via gateway) | 33 | 0.545 [0.432, 0.644] | **non-inferior** | 0.17× [0.15, 0.19] | $-0.5030 | Δ$/1k = $-0.5030 claimable (weak) |
| decomp: stack-engine-zai − pure-api (litellm hop) | 33 | -0.083 [-0.227, 0.068] | not shown | 1.01× [0.92, 1.03] | $0.0065 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-local − local-direct (litellm on local) | 33 | 0.015 [0.000, 0.038] | **non-inferior** | 1.92× [1.42, 2.36] | $0 | Δ$/1k = $0 claimable (weak) |

## c — extract

| leg | n | err% | trunc% | wall p50 | wall p95 | TTFT p50 | TTFC p50 | in/out tok (mean) | cache% | pass% [Wilson 95%] | mean score [boot 95%] | label | $/1k tasks | out tok/s | load1 | flags |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pure-api | 33 | 0 | 0 | 4,173 | 6,555 | 2,093 | 3,517 | 194/257 | 0 | 100 [90, 100] | 1.00 [1.00, 1.00] | weak | $0.16  | 126 | 67.4 |  |
| stack-anthropic | 33 | 0 | 0 | 5,237 | 7,969 | 5,237 | 5,237 | 164/52 | 0 | 73 [56, 85] | 0.93 [0.89, 0.97] | weak | $0 electricity | — | 68.2 | est n/s |
| stack-engine-zai | 33 | 0 | 0 | 4,749 | 5,934 | 2,209 | 3,734 | 194/243 | 0 | 100 [90, 100] | 1.00 [1.00, 1.00] | weak | $0.15  | 125 | 68.4 |  |
| stack-engine-local | 33 | 0 | 0 | 1,101 | 3,874 | 578 | 578 | 212/88 | 3 | 100 [90, 100] | 1.00 [1.00, 1.00] | weak | $0 electricity | 169 | 68.0 | polluted |
| local-direct | 33 | 0 | 0 | 629 | 2,973 | 129 | 129 | 212/88 | 3 | 100 [90, 100] | 1.00 [1.00, 1.00] | weak | $0 electricity | 174 | 67.8 | polluted |

| comparison (A − B, paired by task) | n | Δquality [95% CI] | δ=0.10 | wall ratio A/B median [CI] | Δ$/1k | verdict |
|---|---|---|---|---|---|---|
| stack-anthropic − pure-api | 33 | -0.068 [-0.106, -0.030] | not shown | 1.08× [0.69, 1.26] | $-0.1577 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-zai − pure-api | 33 | 0.000 [0.000, 0.000] | **non-inferior** | 1.08× [0.91, 1.19] | $-0.0070 | Δ$/1k = $-0.0070 claimable (weak) |
| stack-engine-local − pure-api | 33 | 0.000 [0.000, 0.000] | **non-inferior** | 0.28× [0.26, 0.44] | $-0.1577 | Δ$/1k = $-0.1577 claimable (weak) |
| local-direct − pure-api | 33 | 0.000 [0.000, 0.000] | **non-inferior** | 0.16× [0.15, 0.19] | $-0.1577 | Δ$/1k = $-0.1577 claimable (weak) |
| decomp: stack-anthropic − local-direct (real router vs oracle placement) | 33 | -0.068 [-0.106, -0.030] | not shown | 4.25× [3.71, 7.05] | $0 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − stack-engine-zai (router vs same model via gateway) | 33 | -0.068 [-0.106, -0.030] | not shown | 1.01× [0.69, 1.19] | $-0.1507 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-zai − pure-api (litellm hop) | 33 | 0.000 [0.000, 0.000] | **non-inferior** | 1.08× [0.91, 1.19] | $-0.0070 | Δ$/1k = $-0.0070 claimable (weak) |
| decomp: stack-engine-local − local-direct (litellm on local) | 33 | 0.000 [0.000, 0.000] | **non-inferior** | 1.69× [1.55, 1.93] | $0 | Δ$/1k = $0 claimable (weak) |

## b — code-gen

| leg | n | err% | trunc% | wall p50 | wall p95 | TTFT p50 | TTFC p50 | in/out tok (mean) | cache% | pass% [Wilson 95%] | mean score [boot 95%] | label | $/1k tasks | out tok/s | load1 | flags |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pure-api | 33 | 0 | 3 | 9,789 | 26,753 | 2,217 | 8,658 | 91/574 | 0 | 97 [85, 99] | 0.97 [0.91, 1.00] | weak | $0.30  | 84 | 80.3 |  |
| stack-anthropic | 33 | 0 | 0 | 3,017 | 7,057 | 3,017 | 3,017 | 88/90 | 0 | 70 [53, 83] | 0.72 [0.56, 0.86] | weak | $0 electricity | — | 80.8 | est n/s |
| stack-engine-zai | 33 | 0 | 6 | 8,746 | 36,240 | 2,369 | 7,710 | 91/587 | 0 | 94 [80, 98] | 0.94 [0.85, 1.00] | weak | $0.31  | 89 | 81.6 | polluted |
| stack-engine-local | 33 | 0 | 0 | 2,582 | 6,900 | 948 | 948 | 89/98 | 7 | 79 [62, 89] | 0.82 [0.68, 0.94] | weak | $0 electricity | 62 | 82.2 |  |
| local-direct | 33 | 0 | 0 | 1,949 | 3,379 | 250 | 250 | 89/94 | 7 | 79 [62, 89] | 0.81 [0.66, 0.93] | weak | $0 electricity | 63 | 82.8 |  |

| comparison (A − B, paired by task) | n | Δquality [95% CI] | δ=0.10 | wall ratio A/B median [CI] | Δ$/1k | verdict |
|---|---|---|---|---|---|---|
| stack-anthropic − pure-api | 33 | -0.250 [-0.417, -0.083] | not shown | 0.37× [0.25, 0.47] | $-0.3006 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-zai − pure-api | 33 | -0.030 [-0.152, 0.061] | not shown | 0.79× [0.72, 1.27] | $0.0067 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-local − pure-api | 33 | -0.152 [-0.303, -0.008] | not shown | 0.29× [0.19, 0.47] | $-0.3006 | Δ$ not claimable (quality not shown non-inferior) |
| local-direct − pure-api | 33 | -0.163 [-0.314, -0.011] | not shown | 0.23× [0.13, 0.26] | $-0.3006 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − local-direct (real router vs oracle placement) | 33 | -0.087 [-0.208, 0.030] | not shown | 1.37× [1.29, 1.50] | $0 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − stack-engine-zai (router vs same model via gateway) | 33 | -0.220 [-0.394, -0.038] | not shown | 0.36× [0.28, 0.46] | $-0.3073 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-zai − pure-api (litellm hop) | 33 | -0.030 [-0.152, 0.061] | not shown | 0.79× [0.72, 1.28] | $0.0067 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-local − local-direct (litellm on local) | 33 | 0.011 [-0.083, 0.106] | **non-inferior** | 1.47× [1.27, 1.54] | $0 | Δ$/1k = $0 claimable (weak) |

## f — long-context

| leg | n | err% | trunc% | wall p50 | wall p95 | TTFT p50 | TTFC p50 | in/out tok (mean) | cache% | pass% [Wilson 95%] | mean score [boot 95%] | label | $/1k tasks | out tok/s | load1 | flags |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pure-api | 33 | 0 | 0 | 2,687 | 6,704 | 2,673 | 2,687 | 13,527/77 | 0 | 100 [90, 100] | 1.00 [1.00, 1.00] | weak | $2.07  | 12,898 | 58.5 |  |
| stack-anthropic | 33 | 0 | 0 | 9,662 | 25,952 | 9,662 | 9,662 | 17,614/3 | 0 | 94 [80, 98] | 0.94 [0.85, 1.00] | weak | $0 electricity | — | 57.2 | est n/s |
| stack-engine-zai | 33 | 0 | 0 | 3,073 | 5,506 | 2,709 | 3,064 | 13,528/80 | 0 | 100 [90, 100] | 1.00 [1.00, 1.00] | weak | $2.07  | 3,656 | 57.2 |  |
| stack-engine-local | 33 | 0 | 0 | 2,425 | 7,791 | 2,294 | 2,294 | 17,520/8 | 0 | 97 [85, 99] | 0.97 [0.91, 1.00] | weak | $0 electricity | 55 | 56.4 | polluted |
| local-direct | 33 | 0 | 0 | 1,536 | 7,430 | 1,395 | 1,395 | 17,520/8 | 0 | 97 [85, 99] | 0.97 [0.91, 1.00] | weak | $0 electricity | 55 | 57.7 | polluted |

| comparison (A − B, paired by task) | n | Δquality [95% CI] | δ=0.10 | wall ratio A/B median [CI] | Δ$/1k | verdict |
|---|---|---|---|---|---|---|
| stack-anthropic − pure-api | 33 | -0.061 [-0.152, 0.000] | not shown | 3.49× [2.65, 4.80] | $-2.0674 | Δ$ not claimable (quality not shown non-inferior) |
| stack-engine-zai − pure-api | 33 | 0.000 [0.000, 0.000] | **non-inferior** | 1.07× [0.95, 1.13] | $0.0019 | Δ$/1k = $0.0019 claimable (weak) |
| stack-engine-local − pure-api | 33 | -0.030 [-0.091, 0.000] | **non-inferior** | 0.79× [0.68, 1.31] | $-2.0674 | Δ$/1k = $-2.0674 claimable (weak) |
| local-direct − pure-api | 33 | -0.030 [-0.091, 0.000] | **non-inferior** | 0.53× [0.44, 0.79] | $-2.0674 | Δ$/1k = $-2.0674 claimable (weak) |
| decomp: stack-anthropic − local-direct (real router vs oracle placement) | 33 | -0.030 [-0.122, 0.061] | not shown | 5.66× [4.69, 6.37] | $0 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-anthropic − stack-engine-zai (router vs same model via gateway) | 33 | -0.061 [-0.152, 0.000] | not shown | 3.11× [2.68, 3.73] | $-2.0693 | Δ$ not claimable (quality not shown non-inferior) |
| decomp: stack-engine-zai − pure-api (litellm hop) | 33 | 0.000 [0.000, 0.000] | **non-inferior** | 1.07× [0.95, 1.13] | $0.0019 | Δ$/1k = $0.0019 claimable (weak) |
| decomp: stack-engine-local − local-direct (litellm on local) | 33 | 0.000 [0.000, 0.000] | **non-inferior** | 1.47× [1.30, 1.81] | $0 | Δ$/1k = $0 claimable (weak) |

Spot-check sheet: `results/2026-10-02T22-09-09-spotcheck.md` (120 rows).
