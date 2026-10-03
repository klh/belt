// stats.ts — pure statistics + formatters shared by the reports.
import { rng } from "./core.ts";

export const qualLabel = (n: number) =>
	n >= 130 ? "moderate" : n >= 33 ? "weak" : "insufficient";
export const speedLabel = (n: number) =>
	n >= 12 ? "strong" : n >= 5 ? "weak" : "insufficient";
/** Non-inferiority margin on paired Δquality and its minimum n. */
export const DELTA = 0.1;
export const NONINF_MIN_N = 33;

export function quant(xs: number[], q: number): number | null {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const i = (s.length - 1) * q;
	const lo = Math.floor(i);
	const a = s[lo] ?? 0;
	const b = s[Math.min(lo + 1, s.length - 1)] ?? a;
	return a + (b - a) * (i - lo);
}
export function wilson(k: number, n: number): [number, number] | null {
	if (!n) return null;
	const z = 1.96;
	const ph = k / n;
	const d = 1 + (z * z) / n;
	const c = (ph + (z * z) / (2 * n)) / d;
	const h = (z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n))) / d;
	return [Math.max(0, c - h), Math.min(1, c + h)];
}
export const mean = (xs: number[]) =>
	xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
/** Seeded percentile bootstrap — reproducible CIs for a given seed. */
export function boot(
	xs: number[],
	stat: (s: number[]) => number | null,
	seed: string,
	B = 2000,
): [number, number] | null {
	if (xs.length < 2) return null;
	const r = rng(seed);
	const v: number[] = [];
	for (let b = 0; b < B; b++) {
		const s = Array.from(
			{ length: xs.length },
			() => xs[Math.floor(r() * xs.length)] ?? 0,
		);
		const x = stat(s);
		if (x !== null) v.push(x);
	}
	const lo = quant(v, 0.025);
	const hi = quant(v, 0.975);
	return lo === null || hi === null ? null : [lo, hi];
}
export const median = (s: number[]) => quant(s, 0.5);

const fin = (x: number | null | undefined): x is number =>
	typeof x === "number" && Number.isFinite(x);
export const f0 = (x: number | null | undefined) =>
	fin(x) ? Math.round(x).toLocaleString("en-US") : "—";
export const f2 = (x: number | null | undefined, d = 2) =>
	fin(x) ? x.toFixed(d) : "—";
export const ci = (c: [number, number] | null, d = 2) =>
	c ? `[${f2(c[0], d)}, ${f2(c[1], d)}]` : "—";
export const usd = (x: number | null) =>
	x === null
		? "—"
		: x === 0
			? "$0"
			: `$${x.toFixed(Math.abs(x) < 0.1 ? 4 : 2)}`;
export const pct = (x: number | null, d = 1) =>
	fin(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}%` : "—";
/** Markdown table helpers. */
export const row = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
export const sep = (n: number) => `|${"---|".repeat(n)}`;
