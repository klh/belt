// bin/remotes-validate.ts — W192: validate remotes.json fields BEFORE any
// litellm.yaml interpolation. The dynamic layer of remotes.json descends
// from DNS-SD/mDNS advertisements, which any LAN peer can spoof, and the
// file is operator-edited on top of that — so raw discovery output (bare
// service name, host := name.local, port 0) is distrusted on sight and
// every field gateway-config interpolates into the YAML is grammar-checked
// here. A hostile or corrupt entry can then only be SKIPPED, never injected
// as YAML keys, a redirected api_base, or a shadowed model group in the
// config LiteLLM loads. Pure module (type-only import): tests feed it
// poisoned shapes directly; gateway-config.ts consumes buildRemoteEntries.

import type { RemoteMachine } from "./remotes.ts";

// ─── field grammars — what each interpolated field may contain ────────────
// name → model_name prefix + log refs; host → inside http://<host>:<port>;
// port → TCP int; model → `model: openai/<id>`; base → api_base verbatim.

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const HOST_RE =
	/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;
const MODEL_RE = /^[a-z0-9][a-z0-9._:/-]{0,127}$/i;
const CTRL_RE = /\p{C}/u; // any control/invisible character anywhere

export const validName = (v: unknown): v is string =>
	typeof v === "string" && NAME_RE.test(v);

export const validHost = (v: unknown): v is string => {
	if (typeof v !== "string") return false;
	const quads = v.split(".");
	const looksIp = quads.length === 4 && quads.every((q) => /^\d{1,3}$/.test(q));
	if (looksIp) return quads.every((q) => Number(q) < 256); // strict quad check wins over label grammar
	return HOST_RE.test(v);
};

export const validPort = (v: unknown): v is number =>
	typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65_535;

export const validModel = (v: unknown): v is string =>
	typeof v === "string" && MODEL_RE.test(v);

/** api_base goes in verbatim: must parse as an http(s) URL and carry no
 *  whitespace/control characters — a newline would inject YAML keys, a
 *  scheme switch would redirect gateway traffic. */
export const validBase = (v: unknown): v is string => {
	if (typeof v !== "string" || /\s/.test(v) || CTRL_RE.test(v)) return false;
	try {
		const u = new URL(v);
		return u.protocol === "https:" || u.protocol === "http:";
	} catch {
		return false;
	}
};

export interface ValidationIssue {
	ref: string; // "nas.endpoints[0].port" style locator
	why: string;
}

const RAW_MDNS_WHY =
	"raw mDNS discovery entry (port 0/unset) — unprobed and spoofable; probe first (`bun bin/remotes.ts check`) and configure a real host + port before trust";

/** The raw `discover()` shape (remotes.ts): bare service name, host :=
 *  `${name}.local`, port 0 — "probe before trust" starts by never letting
 *  this shape past validation (W192 distrust law). */
export const isRawMdnsEntry = (m: unknown): boolean => {
	if (typeof m !== "object" || m === null) return false;
	const rec = m as Record<string, unknown>;
	const portUnset = rec.port === undefined || rec.port === 0;
	return (
		portUnset &&
		typeof rec.host === "string" &&
		rec.host.toLowerCase().endsWith(".local")
	);
};

type MachineVerdict =
	| { ok: true; machine: RemoteMachine }
	| { ok: false; issues: ValidationIssue[] };

/** Structural + grammar validation of one machine record. Machine-level
 *  fields (name, host, cloud, endpoints shape) fail the whole machine; a
 *  bad endpoint fails only itself. Fields gateway-config never
 *  interpolates (mac, wol_broadcast, ip_fallback, api_key*) are not
 *  grammar-checked here. protocol is accepted as any non-empty string —
 *  it gates emission (only "openai" is emitted) and is never interpolated;
 *  the runtime file already carries "anthropic", beyond remotes.ts's
 *  declared union. */
export function validateMachine(m: unknown): MachineVerdict {
	if (typeof m !== "object" || m === null)
		return { ok: false, issues: [{ ref: "(self)", why: "not an object" }] };
	const rec = m as Record<string, unknown>;
	const issues: ValidationIssue[] = [];
	if (!validName(rec.name))
		issues.push({
			ref: "name",
			why: "must be 1-64 chars of letters/digits/dot/underscore/hyphen, starting alphanumeric",
		});
	if (!validHost(rec.host))
		issues.push({
			ref: "host",
			why: "must be a DNS hostname or IPv4 literal (IPv6/cloud hosts go in a base URL)",
		});
	if (rec.cloud !== undefined && typeof rec.cloud !== "boolean")
		issues.push({ ref: "cloud", why: "must be boolean when present" });
	if (!Array.isArray(rec.endpoints)) {
		issues.push({ ref: "endpoints", why: "must be an array" });
		return { ok: false, issues };
	}
	const endpoints: RemoteMachine["endpoints"] = [];
	rec.endpoints.forEach((e, i) => {
		const bad = (why: string): void => {
			issues.push({ ref: `endpoints[${String(i)}]`, why });
		};
		if (typeof e !== "object" || e === null) {
			bad("not an object");
			return;
		}
		const ep = e as Record<string, unknown>;
		const errs: string[] = [];
		if (!validPort(ep.port)) errs.push("port must be an integer 1-65535");
		if (typeof ep.protocol !== "string" || ep.protocol.length === 0)
			errs.push("protocol must be a non-empty string");
		if (!Array.isArray(ep.roles) || ep.roles.some((r) => typeof r !== "string"))
			errs.push("roles must be an array of strings");
		if (ep.model !== undefined && !validModel(ep.model))
			errs.push(
				"model must be a provider model id (letters/digits/._:/-, 1-128 chars)",
			);
		if (ep.base !== undefined && !validBase(ep.base))
			errs.push(
				"base must be an http(s) URL without whitespace or control characters",
			);
		if (ep.tls !== undefined && typeof ep.tls !== "boolean")
			errs.push("tls must be boolean when present");
		if (errs.length) bad(errs.join("; "));
		else endpoints.push(ep as unknown as RemoteMachine["endpoints"][number]);
	});
	if (issues.length) return { ok: false, issues };
	return {
		ok: true,
		machine: { ...(rec as unknown as RemoteMachine), endpoints },
	};
}

export type RemotesVerdict =
	| { ok: true; machines: RemoteMachine[]; skipped: ValidationIssue[] }
	| { ok: false; fatal: string; skipped: ValidationIssue[] };

/** Validate a parsed remotes.json document. Fatal (not ok) = the document
 *  shape itself is broken — callers must not write a gateway config at
 *  all. Per-machine/endpoint failures come back as skipped, with locators. */
export function validateRemotes(parsed: unknown): RemotesVerdict {
	const machinesRaw = (parsed as { machines?: unknown } | null)?.machines;
	if (!Array.isArray(machinesRaw))
		return {
			ok: false,
			fatal: "remotes.json must be an object with a machines array",
			skipped: [],
		};
	const machines: RemoteMachine[] = [];
	const skipped: ValidationIssue[] = [];
	machinesRaw.forEach((raw, i) => {
		const named = validName((raw as { name?: unknown } | null)?.name);
		const ref = named
			? String((raw as { name: unknown }).name)
			: `machines[${String(i)}]`;
		if (isRawMdnsEntry(raw)) {
			skipped.push({ ref, why: RAW_MDNS_WHY });
			return;
		}
		const v = validateMachine(raw);
		if (v.ok) machines.push(v.machine);
		else
			for (const issue of v.issues)
				skipped.push({ ref: `${ref}.${issue.ref}`, why: issue.why });
	});
	return { ok: true, machines, skipped };
}

export interface BuiltRemotes {
	entries: string[];
	skipped: ValidationIssue[];
}

/** The openai-dialect model_list entries for every VALID remote endpoint —
 *  validation happens BEFORE any string interpolation (W192). Entry shape
 *  matches the pre-W192 gateway-config loop verbatim: base endpoints carry
 *  the z.ai key ref, plain LAN endpoints api_key dummy unless cloud. */
export function buildRemoteEntries(parsed: unknown): BuiltRemotes {
	const v = validateRemotes(parsed);
	if (!v.ok)
		return { entries: [], skipped: [{ ref: "remotes.json", why: v.fatal }] };
	const entries: string[] = [];
	for (const m of v.machines)
		for (const ep of m.endpoints) {
			if (ep.protocol !== "openai" || !ep.model) continue;
			const safe = ep.model.replace(/[^a-zA-Z0-9.-]/g, "-");
			const head =
				`  - model_name: ${m.name}-${safe}\n` +
				`    litellm_params:\n` +
				`      model: openai/${ep.model}\n`;
			entries.push(
				ep.base
					? `${head}      api_base: ${ep.base}\n      api_key: os.environ/Z_AI_API_KEY`
					: `${head}      api_base: http://${m.host}:${String(ep.port)}/v1` +
							(m.cloud ? "" : "\n      api_key: dummy"),
			);
		}
	return { entries, skipped: v.skipped };
}
