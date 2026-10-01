// W155.3 — belt http-citizenship unit tests: the method gate (OPTIONS
// 204+Allow, 405+Allow), the ETag/304 conditional GET, the rate-limit trio
// (both header families), and the problem+json shape.
import { describe, expect, test } from "bun:test";
import {
	citizenshipGate,
	etagJson,
	etagOf,
	ifNoneMatchHits,
	problem,
	rateLimiter,
} from "../bin/http-citizenship.ts";

const ROUTES = {
	"/api/status": ["GET", "HEAD"],
	"/api/route": ["POST"],
};

const req = (path: string, method = "GET", headers?: HeadersInit): Request =>
	new Request(`http://belt.local${path}`, { method, headers });

describe("citizenship gate (W155.3)", () => {
	test("OPTIONS on a known path → 204 + Allow (introspection, no auth)", () => {
		const res = citizenshipGate(req("/api/status", "OPTIONS"), ROUTES);
		expect(res?.status).toBe(204);
		expect(res?.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
	});

	test("off-method on a known path → 405 + Allow + problem+json", async () => {
		const res = citizenshipGate(req("/api/status", "DELETE"), ROUTES);
		expect(res?.status).toBe(405);
		expect(res?.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
		expect(res?.headers.get("content-type")).toBe("application/problem+json");
		const body = (await res?.json()) as Record<string, unknown>;
		expect(body.status).toBe(405);
		expect(body.code).toBe("belt.method_not_allowed");
		expect(body.detail).toContain("GET, HEAD, OPTIONS");
	});

	test("known method on a known path falls through to dispatch", () => {
		expect(citizenshipGate(req("/api/status"), ROUTES)).toBeNull();
		expect(citizenshipGate(req("/api/route", "POST"), ROUTES)).toBeNull();
		expect(citizenshipGate(req("/api/route", "HEAD"), ROUTES)).not.toBeNull();
	});

	test("unknown paths fall through (normal dispatch → 404)", () => {
		expect(citizenshipGate(req("/nope"), ROUTES)).toBeNull();
		expect(citizenshipGate(req("/nope", "DELETE"), ROUTES)).toBeNull();
	});
});

describe("problem+json (RFC 9457)", () => {
	test("carries the required fields + code + optional why", async () => {
		const res = problem(
			429,
			"Too Many Requests",
			"belt.rate_limited",
			"slow down",
			"/api/route",
			"rpm window exhausted",
			{ "retry-after": "7" },
		);
		expect(res.status).toBe(429);
		expect(res.headers.get("content-type")).toBe("application/problem+json");
		expect(res.headers.get("retry-after")).toBe("7");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({
			type: "about:blank",
			title: "Too Many Requests",
			status: 429,
			detail: "slow down",
			instance: "/api/route",
			code: "belt.rate_limited",
			why: "rpm window exhausted",
		});
	});
});

describe("conditional GET — ETag/304", () => {
	test("same body → same strong ETag, different body → different", () => {
		expect(etagOf('{"a":1}')).toBe(etagOf('{"a":1}'));
		expect(etagOf('{"a":1}')).not.toBe(etagOf('{"a":2}'));
		expect(etagOf('{"a":1}')).toMatch(/^"[0-9a-f]{32}"$/);
	});

	test("200 carries ETag; matching If-None-Match → 304 + ETag echo", () => {
		const r1 = etagJson(req("/api/status"), '{"ts":"t1"}');
		expect(r1.status).toBe(200);
		const etag = r1.headers.get("etag");
		expect(etag).not.toBeNull();
		const r2 = etagJson(
			req("/api/status", "GET", { "if-none-match": etag ?? "" }),
			'{"ts":"t1"}',
		);
		expect(r2.status).toBe(304);
		expect(r2.headers.get("etag")).toBe(etag);
	});

	test("weak If-None-Match (W/) matches; list and * match", () => {
		expect(ifNoneMatchHits('W/"abc"', '"abc"')).toBe(true);
		expect(ifNoneMatchHits('"x", "abc"', '"abc"')).toBe(true);
		expect(ifNoneMatchHits("*", '"abc"')).toBe(true);
		expect(ifNoneMatchHits('"other"', '"abc"')).toBe(false);
		expect(ifNoneMatchHits(null, '"abc"')).toBe(false);
	});

	test("changed body revalidates to 200, not 304", () => {
		const r1 = etagJson(req("/api/status"), '{"ts":"t1"}');
		const etag = r1.headers.get("etag");
		const r2 = etagJson(
			req("/api/status", "GET", { "if-none-match": etag ?? "" }),
			'{"ts":"t2"}',
		);
		expect(r2.status).toBe(200);
		expect(r2.headers.get("etag")).not.toBe(etag);
	});
});

describe("rate-limit trio on /api/route", () => {
	test("both header families ride every keyed response", () => {
		const check = rateLimiter(5, () => 1_000);
		const v = check("tok-a");
		expect(v.ok).toBe(true);
		expect(v.headers["ratelimit-limit"]).toBe("5");
		expect(v.headers["ratelimit-remaining"]).toBe("4");
		expect(v.headers["ratelimit-policy"]).toBe("rpm;q=5");
		// IETF draft: Reset = seconds until window reset
		expect(Number(v.headers["ratelimit-reset"])).toBe(60);
		// de-facto: Reset = unix epoch of window reset
		expect(Number(v.headers["x-ratelimit-reset"])).toBe(61);
	});

	test("exceeding the window → 429 verdict with Retry-After + remaining 0", () => {
		const check = rateLimiter(2, () => 1_000);
		expect(check("tok-a").ok).toBe(true);
		expect(check("tok-a").ok).toBe(true);
		const v = check("tok-a");
		expect(v.ok).toBe(false);
		expect(v.retryAfter).toBeGreaterThanOrEqual(1);
		expect(v.retryAfter ?? 0).toBeLessThanOrEqual(62);
		expect(v.headers["ratelimit-remaining"]).toBe("0");
		expect(v.headers["x-ratelimit-remaining"]).toBe("0");
		expect(v.headers["ratelimit-limit"]).toBe("2");
	});

	test("windows are per key and reset when the window expires", () => {
		let t = 1_000;
		const check = rateLimiter(1, () => t);
		expect(check("tok-a").ok).toBe(true);
		expect(check("tok-b").ok).toBe(true); // different token, own window
		expect(check("tok-a").ok).toBe(false);
		t = 61_000; // past resetAt → fresh window
		const v = check("tok-a");
		expect(v.ok).toBe(true);
		expect(v.headers["ratelimit-remaining"]).toBe("0");
	});
});
