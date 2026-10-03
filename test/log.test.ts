// test/log.test.ts — W283: level-gated logger (ts+level prefix, LOG_LEVEL gate)
import { describe, expect, test, afterEach } from "bun:test";
import { debug, error, info, warn } from "../bin/log.ts";

describe("w283: level-gated logger", () => {
	const prevLevel = process.env.LOG_LEVEL;
	afterEach(() => {
		if (prevLevel === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = prevLevel;
	});

	function captureStderr(fn: () => void): string[] {
		const lines: string[] = [];
		const orig = console.error;
		console.error = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};
		try {
			fn();
		} finally {
			console.error = orig;
		}
		return lines;
	}

	test("default level (info) gates out debug, passes error/warn/info", () => {
		delete process.env.LOG_LEVEL;
		const lines = captureStderr(() => {
			error("e");
			warn("w");
			info("i");
			debug("d");
		});
		expect(lines.length).toBe(3);
		expect(lines.some((l) => l.includes("d"))).toBe(false);
	});

	test("LOG_LEVEL=debug lets everything through", () => {
		process.env.LOG_LEVEL = "debug";
		const lines = captureStderr(() => {
			error("e");
			debug("d");
		});
		expect(lines.length).toBe(2);
	});

	test("LOG_LEVEL=error silences warn/info/debug", () => {
		process.env.LOG_LEVEL = "error";
		const lines = captureStderr(() => {
			error("only this");
			warn("w");
			info("i");
			debug("d");
		});
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("only this");
	});

	test("every emitted line carries an ISO timestamp + level tag", () => {
		process.env.LOG_LEVEL = "debug";
		const lines = captureStderr(() => info("hello"));
		expect(lines[0]).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[info\] hello$/,
		);
	});

	test("unknown LOG_LEVEL falls back to info", () => {
		process.env.LOG_LEVEL = "bogus";
		const lines = captureStderr(() => {
			info("i");
			debug("d");
		});
		expect(lines.length).toBe(1);
	});
});
