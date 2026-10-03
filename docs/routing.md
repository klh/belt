# Hybrid LLM Routing Doctrine

> Relocated from global CLAUDE.md (2026-09-14). Consult when building routers, automation, or choosing where to send LLM work. Measured 2026-09-04 on M5 Max 128GB. Owner directive 2026-09-27: **speed-first** — the fastest local model with adequate quality wins over cloud; cloud is the frontier ceiling, and the tokens-expired degradation goes all-local, never the other way. Measured numbers behind every "why" below: [benchmarks.md](../benchmarks.md) (canonical since 2026-10-02 — no bench data in this doc).

| Decision point                        | Route                               | Why                                                                                                       |
| ------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Short task, <50 output tokens         | LOCAL :8902 (non-thinking 4B)       | fastest TTFT in the fleet (see benchmarks.md)                                                             |
| Code generation (warm)                | LOCAL :8901 (Qwen3-Coder-30B-A3B)   | specialist coder speed at fork-replay parity                                                              |
| Deep reasoning, analysis              | LOCAL :8903 (Qwen3.5-35B-A3B)       | best local quality×speed                                                                                  |
| >32k context                          | REMOTE (z.ai)                       | Local RAM-limited                                                                                         |
| Frontier quality, production-critical | REMOTE (z.ai glm-5.3)               | ~750B MoE, 1M ctx; no GLM-5.x fits 128GB (418/204GB at 4bit)                                              |
| Danish/multilingual                   | LOCAL :8906 (Qwen3.5-9B, on demand) | Specialist advantage, 201 langs                                                                           |
| Remote tokens expired / cloud down    | LOCAL everything via router :4000   | `ANTHROPIC_BASE_URL=http://127.0.0.1:4000` → swarm covers every class (degraded mode verified 2026-09-27) |

## Survey rejections 2026-09-27

Moved to the [rejection log in benchmarks.md](../benchmarks.md#rejection-log)
(canonical since 2026-10-02). Sweep outcome: Qwen3.8-27B, GLM-5.x local,
Xing4.0-29B-A4B, finance fine-tunes and Intern-Decision-4B all rejected —
reasons per row there.

## Rules

1. **Speed-first, local-first** (owner 2026-09-27): the fastest adequate-quality local model wins over cloud — the driver is latency and residency, not cost.
2. **Cold start penalty** (~800ms first hit) — keep specialists resident via launchd KeepAlive.
3. **The router is deterministic** (keyword-based, 0ms) — no LLM overhead for routing decisions.
4. **claude-fast checks the local swarm first** — cloud escalation fires only when local failed twice AND the task is COMPLEX+ (SIMPLE/MEDIUM never leave the machine); falls back cleanly if the local stack is down.
5. **Model selection is task-shaped**: code → :8901, menial → :8902, reasoning → :8903, Danish → :8906, rerank → :8913.
6. **Degraded mode**: remote tokens expire → `ANTHROPIC_BASE_URL=http://127.0.0.1:4000` keeps Claude Code on the local swarm at local speed; every workload class stays covered (verified end-to-end 2026-09-27).

## Router-shim bench fixes (W270, REPORT.md 2026-10-02)

- **Code signal**: strong signals (fence, language, "write a function",
  call signature, declarations) route to `:8901`; generic weak words
  (`api`, `return`, `debug`…) need 2 distinct hits and never count past
  1500 words — log haystacks stay on `:8903`.
- **`system` forwarded**: the Anthropic `system` prompt reaches the
  specialist (was dropped); a short one (≤2000 chars) is also classified.
- **Kev gate**: the Kev pre-hop runs only when the prompt fits Kev's
  context (registry `contextTokens`, 384) — no serial hop ahead of a long prefill.
- **Streaming**: `stream:true` pipes specialist SSE as Anthropic SSE
  (TTFT = first token); `_routing` rides in `message_start`, ASCII essentials in
  `x-belt-routing`. `finish_reason: length` → `stop_reason: max_tokens`.
- **Budget policy** (`BUDGET_RULES` in `bin/router-core.ts`): Qwen3.5 →
  thinking off; always-thinking GLM-5.3(-flash) below 2048 tokens → budget raised.
- **Upstream 429**: Retry-After ≤ `BELT_RETRY_WAIT_CAP_MS` (2 s) is waited out
  on the same specialist; longer → fallback; all hops 429 → router answers 429
  with the longest Retry-After.
- **Direct tiers**: `routing-policy.yaml` `direct:` lists hot local aliases that
  skip the LiteLLM hop (`resolveTarget()`; `direct-tiers.json` for non-TS clients).
## Model registration (W271)
Every servable LLM is registered in ONE place: `bin/registry.ts`
(`SPECIALISTS` + `EXTERNAL`, each with an `alias`). Everything downstream is
generated, hash-stable (same registry → byte-identical output):
```sh
bun bin/registry-emit.ts litellm   # LiteLLM model_list (:4100 engine)
bun bin/registry-emit.ts direct    # routing-policy `direct:` tiers
bun bin/registry-emit.ts buckle    # buckle upstreams.yaml groups (merge via BUCKLE_UPSTREAMS)
bun bin/registry-emit.ts json      # registry document
bun bin/registry-emit.ts all --out DIR
```
`bin/gateway-config.ts` builds its local tiers from the registry (live
`/v1/models` only warns on drift). The router shim serves
`GET /registry.json` with a strong `ETag` (`If-None-Match` → 304). Each row
and the document carry `source: local | hub:<name>` — hub-fed mode (a hub
serves its registry, spokes pull) is designed, not yet wired.
