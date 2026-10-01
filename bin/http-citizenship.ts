// http-citizenship.ts — W155.3: belt's own endpoints code to the fleet HTTP
// citizenship standard (suspenders docs/design/http-citizenship.md):
// OPTIONS → 204 + Allow, 405 + Allow on known paths (problem+json bodies),
// strong ETag + 304 on GET-able JSON, and the rate-limit trio (IETF draft +
// de-facto families) on the authenticated /api/route. Pure helpers plus a
// method gate; dashboard.ts owns the routes and passes its method map in —
// one source of truth, no route table duplicated here.

// ─── problem+json (RFC 9457) — error bodies for the gate and the limiter ───
export const problem = (
	status: number,
	title: string,
	code: string,
	detail: string,
	instance: string,
	why?: string,
	headers?: Record<string, string>,
): Response =>
	new Response(
		JSON.stringify(
			{
				type: "about:blank",
				title,
				status,
				detail,
				instance,
				code,
				...(why ? { why } : {}),
			},
			null,
			2,
		),
		{
			status,
			headers: {
				"content-type": "application/problem+json",
				...(headers ?? {}),
			},
		},
	);

// ─── method introspection — OPTIONS 204+Allow, off-method 405+Allow ───
export type RouteMethods = Record<string, string[]>;

/** Allow value for a path: its methods plus OPTIONS itself. */
export const allowList = (methods: string[]): string =>
	[...new Set([...methods, "OPTIONS"])].join(", ");

/** 204 + Allow — introspection answers without auth, per the standard. */
export const optionsResponse = (methods: string[]): Response =>
	new Response(null, {
		status: 204,
		headers: { allow: allowList(methods) },
	});

/** 405 + Allow — problem+json body carries the allowed set in `detail`. */
export const methodNotAllowed = (path: string, methods: string[]): Response =>
	problem(
		405,
		"Method Not Allowed",
		"belt.method_not_allowed",
		`allowed: ${allowList(methods)}`,
		path,
		"the path exists but not for this method",
		{ allow: allowList(methods) },
	);

/** Method gate: run FIRST in fetch(). OPTIONS on a known path → 204+Allow;
 *  a known path with a method outside its set → 405+Allow; anything else
 *  (known method, unknown path) returns null = fall through to dispatch. */
export const citizenshipGate = (
	req: Request,
	routes: RouteMethods,
): Response | null => {
	const path = new URL(req.url).pathname;
	const methods = routes[path];
	if (!methods) return null; // unknown path → normal dispatch → 404
	if (req.method === "OPTIONS") return optionsResponse(methods);
	if (methods.includes(req.method)) return null;
	return methodNotAllowed(path, methods);
};

// ─── conditional GET — strong ETag (content hash), weak If-None-Match ───
export const etagOf = (body: string): string =>
	`"${new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 32)}"`;

/** If-None-Match weak comparison (RFC 7232 §2.3): the W/ prefix is ignored
 *  and any list entry (or `*`) matches. */
export const ifNoneMatchHits = (
	header: string | null,
	etag: string,
): boolean => {
	if (header === null) return false;
	const bare = etag.replace(/^W\//, "");
	return header
		.split(",")
		.map((t) => t.trim().replace(/^W\//, ""))
		.some((t) => t === "*" || t === bare);
};

/** JSON response with a strong ETag; an If-None-Match hit answers 304 with
 *  the ETag echo and no body (the standard's conditional-GET row). */
export const etagJson = (req: Request, body: string): Response => {
	const etag = etagOf(body);
	const headers: Record<string, string> = {
		"content-type": "application/json",
		etag,
	};
	if (ifNoneMatchHits(req.headers.get("if-none-match"), etag))
		return new Response(null, { status: 304, headers });
	return new Response(body, { status: 200, headers });
};

// ─── rate limiting — fixed 60s window per bearer token on /api/route.
// Budget name `rpm` mirrors the govdb budget shapes (W155 standard). ───
export const WINDOW_MS = 60_000;

export interface RateVerdict {
	ok: boolean;
	/** Both header families, always (the standard's rate-limit rows). */
	headers: Record<string, string>;
	/** Whole seconds until the window resets — set on 429. */
	retryAfter?: number;
}

/** Fixed-window rpm limiter keyed by bearer token. Counts every keyed
 *  request; the window resets lazily on first use after expiry. `now` is
 *  injectable so the window math is testable without sleeping. */
export const rateLimiter = (limit: number, now: () => number = Date.now) => {
	const windows = new Map<string, { count: number; resetAt: number }>();
	return (key: string): RateVerdict => {
		const t = now();
		let w = windows.get(key);
		if (w === undefined || w.resetAt <= t) {
			w = { count: 0, resetAt: t + WINDOW_MS };
			windows.set(key, w);
		}
		w.count += 1;
		const resetIn = Math.max(1, Math.ceil((w.resetAt - t) / 1000));
		const remaining = Math.max(0, limit - w.count);
		const headers: Record<string, string> = {
			"ratelimit-limit": String(limit),
			"ratelimit-remaining": String(remaining),
			"ratelimit-reset": String(resetIn),
			"ratelimit-policy": `rpm;q=${limit}`,
			"x-ratelimit-limit": String(limit),
			"x-ratelimit-remaining": String(remaining),
			"x-ratelimit-reset": String(Math.ceil(w.resetAt / 1000)),
		};
		if (w.count > limit) {
			const retryAfter = resetIn + Math.floor(Math.random() * 3);
			return {
				ok: false,
				retryAfter,
				headers: {
					...headers,
					"ratelimit-remaining": "0",
					"x-ratelimit-remaining": "0",
				},
			};
		}
		return { ok: true, headers };
	};
};
