// W5: dashboard.ts/swarm.ts/coordinator.ts now delegate liveness checks to
// supervisor.ts's httpProbe instead of each reimplementing a bare 1-shot
// fetch() — this guards the two regressions that motivated the change:
// (1) a 404 response (e.g. the router's /v1/models) must still count as
//     "up" (no okStatus narrowing by default), and
// (2) a listening-but-slow server must not be an instant false negative —
//     httpProbe's timeout is 2000ms, not the old 800/1000ms.
import { describe, expect, test } from "bun:test";
import { httpProbe } from "../bin/supervisor.ts";

describe("W5: shared httpProbe semantics (dashboard/swarm/coordinator isUp)", () => {
	test("a 404 response counts as up — matches the router's documented /v1/models behavior", async () => {
		await using server = Bun.serve({
			port: 0,
			fetch: () => new Response("not found", { status: 404 }),
		});
		const up = await httpProbe(server.port, "/v1/models", "127.0.0.1", 2000);
		expect(up).toBe(true);
	});

	test("nothing listening on the port is down", async () => {
		// an unused high port — no server bound
		const up = await httpProbe(65100, "/v1/models", "127.0.0.1", 500);
		expect(up).toBe(false);
	});

	test("a slow (but alive) server within the 2000ms budget still counts as up", async () => {
		await using server = Bun.serve({
			port: 0,
			fetch: async () => {
				await new Promise((r) => setTimeout(r, 1200)); // > the old 800/1000ms timeouts, < 2000ms
				return new Response("ok");
			},
		});
		const up = await httpProbe(server.port, "/v1/models", "127.0.0.1", 2000);
		expect(up).toBe(true);
	});
});
