# Multi-machine belt — remote LLM providers

> Owner directive 2026-09-29. [`bin/remotes.ts`](../bin/remotes.ts) is belt's
> multi-machine layer: the fleet no longer stops at the Mac's NIC edge.
> Routing doctrine (cloud vs local vs remote) lives in
> [`docs/routing.md`](routing.md); this doc is the configuration model, the
> CLI, and the suspenders design sketch.

## Two configuration sources

1. **STATIC** — a JSON file at `~/.claude/local-llm/remotes.json` (the
   runtime dir `install.sh` deploys to). **Never committed**: real hosts,
   IPs, and MACs stay local. The repo ships
   [`bin/remotes.example.json`](../bin/remotes.example.json) with RFC-5737
   placeholder addresses (`192.0.2.0/24`, `.example.lan`).
2. **DYNAMIC** — a DNS-SD browse for `_klh-llm._tcp`. Linux providers
   announce via avahi; macOS browses via `dns-sd`. The NAS announces through
   its zeroconf container (reference stack:
   [`deploy/nas-llm/`](../deploy/nas-llm/) — ollama + a `zeroconf` announcer
   on host networking). Raw advertisements are **probed for protocol before
   they are trusted**.

Machine + endpoint shape (see the example file for a full entry):

| Field                  | Meaning                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `name`                 | display name (`check` output keys on it)                         |
| `host`                 | DNS name — resolved **first** on every health check              |
| `ip_fallback`          | static IP, used **only** when DNS resolution fails               |
| `mac`                  | WoL target — hibernating machines answer ARP, not TCP            |
| `endpoints[].port`     | TCP port (`11434` for ollama)                                    |
| `endpoints[].protocol` | `openai` \| `llama` \| `immich` — picks the probe and call shape |
| `endpoints[].roles`    | routing roles this endpoint serves (`route <role>` matches here) |
| `endpoints[].model`    | openai-protocol model id, when the provider needs one            |

## Resolution, liveness, wake-up

- **DNS first, IP fallback.** Every health check resolves `host` through the
  system resolver (`dscacheutil` — mDNS `foo.local` names work too);
  `ip_fallback` fires only when resolution fails. The resolved IP is cached
  in per-process state alongside last-ok / last-error.
- **Protocol-aware probes.** `openai` → `GET /v1/models`, `llama` →
  `GET /health`, `immich` → `GET /ping` — Immich ML v3.1 answers `pong`
  there, while `/predict` needs multipart and is broken upstream — 4 s
  timeout. Any HTTP answer = alive; only a transport failure = dead. A
  sleeping machine fails honestly (✗) instead of hanging.
- **Hibernation + WoL.** The NAS hibernates: ARP answers, TCP goes silent.
  `mac` records the wake target for that moment. A magic-packet sender is not
  wired into `remotes.ts` yet — wake the machine first, then `check`.

## CLI

```bash
bun bin/remotes.ts check                    # liveness pass over static machines (default verb)
bun bin/remotes.ts discover                 # raw _klh-llm._tcp advertisements — probe before trust
bun bin/remotes.ts route <role> "<prompt>"  # one task to the first endpoint serving <role>
```

- `check` — resolves + probes every static machine's endpoints; prints
  `✓/✗ machine:port resolved-ip`.
- `discover` — browse only; discovered entries carry no protocol or roles
  until probed.
- `route` — the report-back proof: send one task to a remote provider, print
  the answer when done. Posts `/v1/chat/completions` with the endpoint's
  model (or `default`); 600 s timeout, sized for slow NAS CPUs.
- `--json` flags for machine-readable output (raw JSON arrays, the belt
  dashboard is the consumer) are being added by a parallel lane — in flight
  as this doc lands.

## The first machine: a Synology NAS

Ollama on `:11434` speaking the openai protocol, model `qwen2.5:0.5b`, roles
`general` + `research`. The machine hibernates; discovery rides the zeroconf
announcer container; wake-up uses the stored MAC. `deploy/nas-llm/` is the
reference Container Manager project (compose + announcer script) — copy it,
swap the placeholder host/IP/MAC for the real values in the local
`remotes.json`, and `bun bin/remotes.ts check` should show the endpoint green.

## Design sketch: suspenders target

No code in this section — direction only. suspenders'
[fleet-loop](https://github.com/klh/suspenders) dispatches work items to
headless lanes on this machine; every dispatch carries an
`origin` (`<hostname>:<agent>`), which is the recorded multi-machine seam.
The target: **a work item whose leaf task is "answer this prompt" can be
executed by a remote LLM** instead of a full worktree lane.

The sketch: fleet-loop dispatch gains an **executor mode**. Instead of
spawning `claude -p` in a worktree, the dispatcher shells belt's CLI and
posts the answer back into the work item's coord thread:

```bash
bun belt/bin/remotes.ts route research "summarize these three RSS items for item W42"
```

1. **Claim** — the executor claims the item as its own session
   (`work take <id> --as <executor-sid> --origin <host>:remote-llm`) so the
   board shows ownership and the pid guard has something to guard.
2. **Dispatch** — belt resolves the role to a machine: DNS first, wake if
   hibernating, probe, then the call. suspenders never talks HTTP to the NAS
   itself; belt owns machines.
3. **Timeout** — the executor wraps the `route` call in its own hard timeout
   (watchdog discipline: never wait unbounded). `route` already times out at
   600 s, but the wrapper owns the deadline so a hung NAS cannot wedge a
   fleet-loop cycle past its `--cycle-timeout`.
4. **Report back** — the answer lands in the work item's coord thread
   (`coord emit llm.result --scope <item> --note …`; coord is by-reference,
   so long answers go to a capsule or field, not the event body). Leaf tasks
   with no git artifact end here — claim released, no `work done --sha`,
   since there is nothing to merge.
5. **Heartbeat semantics** — a remote LLM is an HTTP call, not a session: it
   cannot heart-beat the work graph. The heartbeat source stays the **local
   executor process** that shelled the call. That is exactly why the wrapper
   timeout matters: zombie detection (claim + stale heartbeat + stale
   transcript beyond `fleet.zombie_after_ms`, 45 min default) must never fire
   on a healthy-but-slow NAS. Long jobs are either chunked (progress emit
   between chunks) or given a wrapper timeout safely under the zombie
   horizon, failing honestly with the FAIL tail — a reasonless FAIL is a bug.

Not the default path: cloud stays fastest for most items, and the routing
doctrine's optimization target is speed, not cost. The executor mode serves
the same three cases the doctrine names — prompt/plan refinement,
long-running background tasks, and cloud-down fallback — plus anything that
should not wake a 300 W Mac for a 0.5 B question.
