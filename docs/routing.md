# Hybrid LLM Routing Doctrine

> Relocated from global CLAUDE.md (2026-09-14). Consult when building routers, automation, or choosing where to send LLM work. Measured 2026-09-04 on M5 Max 128GB. Owner directive 2026-09-27: **speed-first** — the fastest local model with adequate quality wins over cloud; cloud is the frontier ceiling, and the tokens-expired degradation goes all-local, never the other way.

| Decision point                        | Route                               | Why (measured)                                                                                           |
| ------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Short task, <50 output tokens         | LOCAL :8902 (non-thinking 4B)       | TTFT 138ms vs 400ms remote = 2.4x; 118 tok/s                                                             |
| Code generation (warm)                | LOCAL :8901 (Qwen3-Coder-30B-A3B)   | 311ms vs 485ms remote = 1.6x; 90 tok/s; 13/15 owner-fork replay                                          |
| Deep reasoning, analysis              | LOCAL :8903 (Qwen3.5-35B-A3B)       | 138.5 tok/s (2026-09-23 bench); 12/15 owner-fork replay @ 1.8s (2026-09-27)                              |
| >32k context                          | REMOTE (z.ai)                       | Local RAM-limited                                                                                        |
| Frontier quality, production-critical | REMOTE (z.ai glm-5.3)               | ~750B MoE, 1M ctx; no GLM-5.x fits 128GB (418/204GB at 4bit)                                             |
| Danish/multilingual                   | LOCAL :8906 (Qwen3.5-9B, on demand) | Specialist advantage, 201 langs                                                                          |
| Remote tokens expired / cloud down    | LOCAL everything via router :4000   | `ANTHROPIC_BASE_URL=http://127.0.0.1:4000` → swarm covers every class; 84–118 tok/s; verified 2026-09-27 |

## Survey rejections 2026-09-27

- **Qwen3.8-27B** — already benched 2026-09-23: 28.3 vs 138.5 tok/s at equal probe quality (dense vs MoE); the :8903 slot stays Qwen3.5-35B-A3B.
- **GLM-5.x locally** — Flash 204GB, GLM-5.3 418GB at 4bit; no fit in 128GB. GLM-5.3-Flash relevant only as a cheaper remote (one-tenth price, claimed).
- **Xing4.0-29B-A4B** — MoE speed class matches, but MLA+MTP unproven in MLX and no expected edge over Qwen3.5-35B-A3B; not pulled.
- **Finance fine-tunes** — best of lot (Fastino-Nemotron-3.5-Lightning-Finance) is English-only; no Danish/DKR/skat context. General local model + own documents wins; niche English extraction only.
- **Intern-Decision-4B** — 12/15 vs production's 13/15 on the 2026-09-27 fork replay, CUDA-only serving; revisit only if an MLX port appears (memory: intern-decision-4b-benchmark).

## Rules

1. **Speed-first, local-first** (owner 2026-09-27): the fastest adequate-quality local model wins over cloud — the driver is latency and residency, not cost.
2. **Cold start penalty** (~800ms first hit) — keep specialists resident via launchd KeepAlive.
3. **The router is deterministic** (keyword-based, 0ms) — no LLM overhead for routing decisions.
4. **claude-fast checks the local swarm first** — cloud escalation fires only when local failed twice AND the task is COMPLEX+ (SIMPLE/MEDIUM never leave the machine); falls back cleanly if the local stack is down.
5. **Model selection is task-shaped**: code → :8901, menial → :8902, reasoning → :8903, Danish → :8906, rerank → :8913.
6. **Degraded mode**: remote tokens expire → `ANTHROPIC_BASE_URL=http://127.0.0.1:4000` keeps Claude Code on the local swarm at local speed; every workload class stays covered (verified end-to-end 2026-09-27).
