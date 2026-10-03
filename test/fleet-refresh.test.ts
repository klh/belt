import { describe, expect, test } from "bun:test";
import {
	verdictOf,
	parseMedian,
	parseLoadavg,
	isStalled,
	priorTried,
	type TriedRow,
} from "../bin/fleet-refresh.ts";

describe("priorTried", () => {
	const rows: TriedRow[] = [
		{ id: "a/model", verdict: "lose", date: "2026-10-03", note: "slow" },
		{ id: "b/model", verdict: "win", date: "2026-10-03", slot: 8903 },
	];
	test("finds prior verdict by exact id", () => {
		expect(priorTried(rows, "a/model")?.verdict).toBe("lose");
	});
	test("undefined for untried id", () => {
		expect(priorTried(rows, "c/model")).toBeUndefined();
	});
});

describe("verdictOf", () => {
	test("win above margin", () => {
		expect(verdictOf(100, 87, 0.05)).toBe("win");
	});
	test("lose below margin", () => {
		expect(verdictOf(68.5, 87.0, 0.05)).toBe("lose");
	});
	test("tie inside margin", () => {
		expect(verdictOf(86.0, 87.0, 0.05)).toBe("tie");
	});
	test("exact margin boundary is tie", () => {
		expect(verdictOf(87.0 * 1.05, 87.0, 0.05)).toBe("tie");
	});
});

describe("parseMedian", () => {
	test("parses bench-suite median line", () => {
		expect(
			parseMedian("  median: 68.5 tok/s (logged to benchmarks.jsonl)"),
		).toBe(68.5);
	});
	test("throws on missing median", () => {
		expect(() => parseMedian("no output")).toThrow();
	});
});

describe("parseLoadavg", () => {
	test("parses sysctl vm.loadavg triple", () => {
		expect(parseLoadavg("{ 9.68 7.45 7.98 }")).toBe(9.68);
	});
	test("returns -1 on garbage", () => {
		expect(parseLoadavg("none")).toBe(-1);
	});
});

describe("isStalled", () => {
	const base = { prevBytes: 1e9, expectedBytes: 22.2e9 };
	test("stalled: flat + >15min + incomplete", () => {
		expect(
			isStalled({ ...base, nowBytes: 1e9, prevTs: 0, nowTs: 20 * 60_000 }),
		).toBe(true);
	});
	test("not stalled while growing", () => {
		expect(
			isStalled({ ...base, nowBytes: 1.1e9, prevTs: 0, nowTs: 90 * 60_000 }),
		).toBe(false);
	});
	test("not stalled inside 15min window", () => {
		expect(
			isStalled({ ...base, nowBytes: 1e9, prevTs: 0, nowTs: 10 * 60_000 }),
		).toBe(false);
	});
	test("not stalled when complete", () => {
		expect(
			isStalled({ ...base, nowBytes: 22.2e9, prevTs: 0, nowTs: 90 * 60_000 }),
		).toBe(false);
	});
});
