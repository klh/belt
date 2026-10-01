#!/usr/bin/env bun
// federation-cr.ts — W160 originate CLI: declare + list hub change requests
// on the buckle CR queue. Declaring is a HUB-ADMIN capability
// (buckle:admin:WRITE_ — spokes can only report status). belt originates
// LLM-policy CRs (policy revision N, model/entitlement changes); central
// suspenders originates work-graph/rules CRs (--origin-system suspenders).
// Same queue, same lifecycle: declared → delivered → applied → verified →
// reported-up (or failed + escalation note). The private-domain guard is
// structural hub-side (declareCR); this CLI just posts and prints honestly.
//
//   BUCKLE_HUB_URL    default http://127.0.0.1:4101 (buckle shadow router)
//   BUCKLE_ADMIN_KEY  bearer holding buckle:admin (required)
//
//   bun bin/federation-cr.ts declare --action adopt-policy --target policy@3 \
//       [--id cr-...] [--payload '{"revision":3}'] [--payload-file p.json] \
//       [--origin-system belt|suspenders] [--actor who]
//   bun bin/federation-cr.ts list
//   bun bin/federation-cr.ts get <id>

export interface CrArgs {
	command: "declare" | "list" | "get";
	id: string | null;
	action: string | null;
	target: string | null;
	payload: string | null;
	payloadFile: string | null;
	originSystem: string;
	actor: string | null;
}

export type CrParse = { ok: true; args: CrArgs } | { ok: false; error: string };

/** Arg parsing, pure for tests. */
export function parseCrArgs(argv: string[]): CrParse {
	if (argv.length === 0)
		return {
			ok: false,
			error: "usage: federation-cr.ts declare|list|get … (see file header)",
		};
	const command = argv[0];
	if (command !== "declare" && command !== "list" && command !== "get")
		return { ok: false, error: `unknown command: ${String(command)}` };
	const args: CrArgs = {
		command,
		id: null,
		action: null,
		target: null,
		payload: null,
		payloadFile: null,
		originSystem: "belt",
		actor: null,
	};
	for (let i = 1; i < argv.length; i += 2) {
		const flag = argv[i];
		const value = argv[i + 1] ?? null;
		if (flag === "--id") args.id = value;
		else if (flag === "--action") args.action = value;
		else if (flag === "--target") args.target = value;
		else if (flag === "--payload") args.payload = value;
		else if (flag === "--payload-file") args.payloadFile = value;
		else if (flag === "--origin-system") args.originSystem = value ?? "belt";
		else if (flag === "--actor") args.actor = value;
		else
			return {
				ok: false,
				error: `unknown flag: ${String(flag)} (--id --action --target --payload --payload-file --origin-system --actor)`,
			};
	}
	return { ok: true, args };
}

/** The POST /federation/cr body for a declare; validates what the hub would
 *  400 on anyway so the operator learns at the CLI, not in the round-trip. */
export async function buildDeclareBody(
	args: CrArgs,
	fallbackActor: string,
): Promise<
	{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }
> {
	if (args.action === null || args.action.length === 0)
		return { ok: false, error: "declare requires --action" };
	if (args.target === null || args.target.length === 0)
		return { ok: false, error: "declare requires --target" };
	let payload: unknown = null;
	if (args.payload !== null && args.payloadFile !== null)
		return {
			ok: false,
			error: "--payload and --payload-file are exclusive",
		};
	if (args.payload !== null) {
		try {
			payload = JSON.parse(args.payload) as unknown;
		} catch {
			return { ok: false, error: "--payload is not valid JSON" };
		}
	} else if (args.payloadFile !== null) {
		const text = await Bun.file(args.payloadFile).text();
		try {
			payload = JSON.parse(text) as unknown;
		} catch {
			return {
				ok: false,
				error: `--payload-file ${args.payloadFile} is not valid JSON`,
			};
		}
	}
	return {
		ok: true,
		body: {
			id: args.id,
			action: args.action,
			target: args.target,
			payload,
			origin: {
				system: args.originSystem,
				actor: args.actor ?? fallbackActor,
			},
		},
	};
}

async function main(): Promise<number> {
	const parsed = parseCrArgs(process.argv.slice(2));
	if (!parsed.ok) {
		console.error(parsed.error);
		return 2;
	}
	const hub = process.env.BUCKLE_HUB_URL ?? "http://127.0.0.1:4101";
	const key = process.env.BUCKLE_ADMIN_KEY ?? "";
	if (key.length === 0) {
		console.error("BUCKLE_ADMIN_KEY is required (buckle:admin bearer)");
		return 2;
	}
	if (parsed.args.command === "declare") {
		const body = await buildDeclareBody(
			parsed.args,
			process.env.USER ?? "unknown",
		);
		if (!body.ok) {
			console.error(body.error);
			return 2;
		}
		const res = await fetch(`${hub}/federation/cr`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}` },
			body: JSON.stringify(body.body),
		});
		console.log(JSON.stringify(await res.json(), null, 2));
		return res.ok ? 0 : 1;
	}
	const res = await fetch(`${hub}/federation/cr`, {
		headers: { authorization: `Bearer ${key}` },
	});
	const out = (await res.json()) as {
		cr_queue?: Array<Record<string, unknown>>;
	};
	const rows = out.cr_queue ?? [];
	const picked =
		parsed.args.command === "get" && parsed.args.id !== null
			? rows.filter((r) => r.id === parsed.args?.id)
			: rows;
	if (parsed.args.command === "get" && picked.length === 0) {
		console.error(`no such CR: ${String(parsed.args.id)}`);
		return 1;
	}
	console.log(JSON.stringify(picked, null, 2));
	return res.ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
