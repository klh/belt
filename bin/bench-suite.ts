#!/usr/bin/env bun
// bench-suite.ts — standard 4-prompt bench for any mlx_lm port; auto-logs to
// benchmarks.jsonl via bench-log.ts.
//
//   bun bench-suite.ts --port 8901 --model <id> --label <short> [--suite fleet]

const LOG = `${process.env.HOME}/.claude/local-llm/bench-log.ts`;

const args = process.argv.slice(2);
const get = (f: string) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };
const port = Number(get("--port"));
const model = get("--model") ?? "?";
const label = get("--label") ?? model.replace("mlx-community/", "").slice(0, 30);
const suite = get("--suite") ?? "fleet";
const THINK_OFF = process.argv.includes("--thinking-off");
if (!port) { console.error("usage: bench-suite.ts --port N --model <id> [--label L] [--suite S]"); process.exit(1); }

const PROMPTS = [
  { name: "ts-dedupe", content: "Write a TypeScript function that deduplicates an array of objects by id, keeping the last occurrence. Strict types." },
  { name: "web-component", content: "Write a native TypeScript web component <count-badge> with shadow DOM: attribute count, emits badge-click CustomEvent, re-renders on attribute change." },
  { name: "tradeoffs", content: "Analyze the architectural trade-offs of event-driven microservices versus a modular monolith for a three-person team. Be concise." },
  { name: "danish", content: "Skriv en kort og høflig e-mail til min udlejer om at varmen ikke virker." },
];

const sanitize = (s: string) => s.replace(/\n/g, "\\n");

async function ask(content: string) {
  const t0 = performance.now();
  const r = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 350, temperature: 0, stream: false,
      ...(THINK_OFF ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      messages: [{ role: "user", content }] }),
    signal: AbortSignal.timeout(300_000),
  });
  const d = JSON.parse(sanitize(await r.text())) as any;
  const secs = (performance.now() - t0) / 1000;
  const tok = d.usage?.completion_tokens ?? 0;
  const txt: string = d.choices?.[0]?.message?.content ?? "";
  return { secs, tok, tps: tok > 0 ? tok / secs : 0, ok: tok > 0, head: txt.slice(0, 70).replace(/\n/g, " ") };
}

// warmup
await ask("Say READY");

console.log(`${label} (:${port}):`);
const medians: number[] = [];
for (const p of PROMPTS) {
  const r = await ask(p.content);
  medians.push(r.tps);
  console.log(`  ${p.name.padEnd(14)} ${r.tps.toFixed(1).padStart(6)} tok/s (${r.tok} tok, ${r.secs.toFixed(1)}s) ${r.ok ? "" : "EMPTY!"} | ${r.head}`);
  Bun.spawnSync(["bun", LOG, "add", suite, label, `toks_${p.name}`, r.tps.toFixed(1),
    JSON.stringify({ port, model, tokens: r.tok, secs: Number(r.secs.toFixed(2)) })]);
}
const med = medians.sort((a, b) => a - b)[Math.floor(medians.length / 2)] ?? 0;
Bun.spawnSync(["bun", LOG, "add", suite, label, "toks_median", med.toFixed(1), JSON.stringify({ port, model })]);
console.log(`  median: ${med.toFixed(1)} tok/s (logged to benchmarks.jsonl)`);
