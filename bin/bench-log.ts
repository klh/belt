#!/usr/bin/env bun
// bench-log.ts — persistent benchmark history for local inference.
//
//   bun bench-log.ts add <suite> <model> <metric> <value> [meta-json]
//   bun bench-log.ts list [suite]          — recent entries
//   bun bench-log.ts report [suite]        — trend table + self-contained HTML graph
//
// Store: ~/.claude-insights/benchmarks.jsonl (one JSON object per line)

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const STORE = `${process.env.HOME}/.claude-insights/benchmarks.jsonl`;
const HTML = `${process.env.HOME}/.claude-insights/benchmarks.html`;

type Entry = { ts: string; suite: string; model: string; metric: string; value: number; meta?: Record<string, unknown> };

const load = (): Entry[] =>
  existsSync(STORE)
    ? readFileSync(STORE, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
    : [];

const cmd = process.argv[2] ?? "list";

if (cmd === "add") {
  const [, , , suite, model, metric, value, metaJson] = process.argv;
  if (!suite || !model || !metric || Number.isNaN(Number(value))) {
    console.error("usage: bench-log.ts add <suite> <model> <metric> <value> [meta-json]");
    process.exit(1);
  }
  const e: Entry = {
    ts: new Date().toISOString(),
    suite, model, metric, value: Number(value),
    ...(metaJson ? { meta: JSON.parse(metaJson) } : {}),
  };
  appendFileSync(STORE, JSON.stringify(e) + "\n");
  console.log(`✓ ${suite}/${model}/${metric} = ${value}`);
  process.exit(0);
}

const all = load();
const suite = process.argv[3];
const rows = suite ? all.filter(e => e.suite === suite) : all;

if (cmd === "list") {
  for (const e of rows.slice(-30)) {
    console.log(`${e.ts.slice(0, 16)}  ${e.suite.padEnd(14)} ${e.model.padEnd(44)} ${e.metric}=${e.value}`);
  }
  if (rows.length === 0) console.log("(no entries)");
  process.exit(0);
}

if (cmd === "report") {
  // group by suite+model+metric, print first→latest with delta
  const groups = new Map<string, Entry[]>();
  for (const e of rows) {
    const k = `${e.suite}|${e.model}|${e.metric}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(e);
  }
  const lines: string[] = [];
  for (const [k, es] of groups) {
    es.sort((a, b) => a.ts.localeCompare(b.ts));
    const first = es[0], last = es[es.length - 1];
    const delta = first.value !== 0 ? (((last.value - first.value) / first.value) * 100).toFixed(1) : "n/a";
    const line = `${k}  ${first.value} → ${last.value} (${delta}%, n=${es.length})`;
    console.log(line);
    lines.push(line);
  }
  if (groups.size === 0) { console.log("(no entries)"); process.exit(0); }

  // self-contained HTML: per group, SVG polyline of value over time
  const svg = (es: Entry[], w: number, h: number): string => {
    if (es.length < 2) return `<p>${es[0]?.value} (single point)</p>`;
    const vs = es.map(e => e.value);
    const min = Math.min(...vs), max = Math.max(...vs);
    const span = max - min || 1;
    const pts = es.map((e, i) =>
      `${(i / (es.length - 1)) * (w - 40) + 20},${h - 20 - ((e.value - min) / span) * (h - 40)}`).join(" ");
    return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><polyline points="${pts}" fill="none" stroke="#07f" stroke-width="2"/><text x="20" y="14" font-size="11">${max}</text><text x="20" y="${h - 4}" font-size="11">${min}</text></svg>`;
  };
  const sections = [...groups.entries()].map(([k, es]) => {
    es.sort((a, b) => a.ts.localeCompare(b.ts));
    return `<h3>${k}</h3>${svg(es, 600, 180)}<p>latest ${es[es.length - 1].value} @ ${es[es.length - 1].ts.slice(0, 16)}</p>`;
  }).join("\n");
  writeFileSync(HTML, `<!doctype html><meta charset="utf-8"><title>local inference benchmarks</title><body style="font-family:-apple-system,sans-serif;max-width:720px;margin:2rem auto"><h1>Local inference benchmarks</h1>${sections}</body>`);
  console.log(`\ngraph → ${HTML}`);
  process.exit(0);
}

console.error("usage: add | list [suite] | report [suite]");
process.exit(1);
