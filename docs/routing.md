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
