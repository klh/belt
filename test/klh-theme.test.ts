// klh-theme.test.ts — W281: belt wears the shared klh theme.
// bin/klh-theme.ts is a byte-identical vendored copy of klh/suspenders
// hooks/lib/theme.ts (see suspenders docs/theme-tokens.md, "Vendoring"):
// never hand-edit it, re-vendor it and bump PIN together. The page test boots
// the real dashboard on a free port (mDNS off, scratch HOME) and checks the
// served HTML: tokens in <head>, one klh·fleet strip, the theme gear, and no
// private palette left behind.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	FLEET_NAV_CSS,
	FLEET_NAV_JS,
	fleetNav,
	KLH_THEME_VERSION,
	THEME_HEAD,
	THEME_SETTINGS_CSS,
	THEME_SETTINGS_JS,
} from "../bin/klh-theme.ts";

const VENDORED = join(import.meta.dir, "..", "bin", "klh-theme.ts");
const PIN = {
	version: "1.1.0",
	sha256: "5941ab1ba3ce1b25af38cd46ff68a70182dd2be8d55a0ef739f65f87a80b6d99",
};

const sha256 = (bytes: Uint8Array | string): string =>
	createHash("sha256").update(bytes).digest("hex");

const versionOf = (src: string): string =>
	/KLH_THEME_VERSION = "([^"]+)"/.exec(src)?.[1] ?? "";

// The MERGED theme (origin/main) of a klh/suspenders checkout beside this
// repo, or beside the repo a worktree hangs off. Uncommitted edits or a stale
// local branch there never count; a lone clone skips the drift check.
const mergedSource = (): Buffer | null => {
	let dir = import.meta.dir;
	for (let i = 0; i < 6; i++) {
		const repo = join(dir, "suspenders");
		if (existsSync(join(repo, "hooks", "lib", "theme.ts"))) {
			const show = ["show", "origin/main:hooks/lib/theme.ts"];
			const git = Bun.spawnSync(["git", "-C", repo, ...show]);
			return git.exitCode === 0 ? git.stdout : null;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
};

const count = (hay: string, needle: string): number =>
	hay.split(needle).length - 1;

describe("vendored klh theme (W281)", () => {
	test("pinned: version + sha256 of bin/klh-theme.ts", () => {
		expect(KLH_THEME_VERSION).toBe(PIN.version);
		expect(sha256(readFileSync(VENDORED))).toBe(PIN.sha256);
	});

	const source = mergedSource();
	const sameVersion =
		source !== null && versionOf(source.toString()) === KLH_THEME_VERSION;
	// A newer suspenders theme only means "re-vendor when convenient"; the
	// same version with different bytes is real drift.
	test.skipIf(!sameVersion)(
		"no drift: same version as suspenders theme.ts means same bytes",
		() => {
			expect(sha256(source ?? "")).toBe(sha256(readFileSync(VENDORED)));
		},
	);
});

describe("belt dashboard page wears the klh theme (W281)", () => {
	let proc: ReturnType<typeof Bun.spawn> | null = null;
	let html = "";

	beforeAll(async () => {
		const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
		const port = probe.port;
		probe.stop(true);
		proc = Bun.spawn(
			[process.execPath, join(import.meta.dir, "..", "bin", "dashboard.ts")],
			{
				env: {
					...process.env,
					BELT_PORT: String(port),
					BELT_MDNS: "off",
					HOME: join(import.meta.dir, ".no-home"),
				},
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		for (let i = 0; i < 80 && !html; i++) {
			try {
				const res = await fetch(`http://127.0.0.1:${port}/`);
				if (res.ok) html = await res.text();
			} catch {
				await Bun.sleep(50);
			}
		}
	});

	afterAll(() => {
		proc?.kill();
	});

	test("theme tokens + pre-paint lead <head>, before the page's own style", () => {
		const at = html.indexOf(THEME_HEAD);
		expect(at).toBeGreaterThan(-1);
		expect(at).toBeLessThan(html.indexOf("<style>"));
		expect(at).toBeLessThan(html.indexOf("</head>"));
	});

	test("exactly one klh·fleet strip, belt current, first in <body>", () => {
		const nav = fleetNav("belt");
		expect(count(html, nav)).toBe(1);
		expect(count(html, 'class="klh-fleetnav"')).toBe(1);
		expect(html.indexOf(nav)).toBeGreaterThan(html.indexOf("<body>"));
		expect(html.indexOf(nav)).toBeLessThan(html.indexOf("<header>"));
		expect(html).toContain(FLEET_NAV_CSS);
		expect(html).toContain(FLEET_NAV_JS);
	});

	test("theme gear mounted once with its CSS + JS", () => {
		expect(count(html, 'id="klh-settings"')).toBe(1);
		expect(html).toContain(THEME_SETTINGS_CSS);
		expect(html).toContain(THEME_SETTINGS_JS);
	});

	test("the old one-off topbar and private palette are gone", () => {
		for (const gone of [
			"klh-topbar",
			"tb-link",
			"https://klh/local",
			"#191614",
			"#201d1a",
			"#e8e2d9",
			"#8a857e",
			"#e05a2b",
			"#4a7c4e",
			"#6f6a63",
			"#8ab4ff",
		])
			expect(html).not.toContain(gone);
	});

	test("outside the shared theme, the page hard-codes no colour", () => {
		const own = [THEME_HEAD, FLEET_NAV_CSS, THEME_SETTINGS_CSS].reduce(
			(s, part) => s.split(part).join(""),
			html,
		);
		expect(own).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|color-scheme/i);
	});
});
