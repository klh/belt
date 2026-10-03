// seal.ts — sealed task sets: --design (generate once), --seal-from (verified
// byte-identical copy of a reference seal), manifest verification, loading.
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	CLASSES,
	type ClassId,
	GEN,
	pad,
	SEED,
	sha,
	TASK_DIR,
	type TaskFile,
	TIERS,
} from "./core.ts";
import { GENS, LEGACY_FIT } from "./gen.ts";

export const NOTES: Record<ClassId, string> = {
	a: "instruction-following proxy (length band, required terms, no lists) — not a helpfulness judgement",
	b: "assertion-checked JS; expected values computed from the sealed reference at design time; executed under sandbox-exec",
	c: "7-field JSON exact match + exact key set/types",
	d: "rubric: ANSWER exact (normalised), CONFIDENCE self-report for Brier; human spot-check sheet emitted by --report",
	e: "labels by construction against the sealed `criteria` text; `legacy` = bench-fit 12, no ground truth, unscored",
	f: "needle retrieval; TTFT is the metric; q2 is the --warm follow-up on the same prefix",
};

interface ManifestEntry {
	class: ClassId;
	n: number;
	bytes: number;
	sha256: string;
}
interface Manifest {
	generator: string;
	seed: string;
	sealed_at: string;
	rule: string;
	files: Record<string, ManifestEntry>;
}

const ALREADY =
	"tasks/ is already sealed (MANIFEST.json exists). Re-sealing invalidates every prior comparison;\ndelete tasks/ by hand if you really mean it.";

/** Serialise one class exactly as the sealed prototype did. */
export function taskFileBody(c: ClassId): string {
	const s = CLASSES[c];
	const tf: TaskFile = {
		class: s.id,
		name: s.name,
		generator: GEN,
		seed: SEED,
		max_tokens: s.maxTokens,
		effort: s.effort,
		note: NOTES[c],
		tasks: GENS[c](),
	};
	if (c === "e") {
		tf.criteria = TIERS;
		tf.legacy = LEGACY_FIT.map((t, i) => ({
			id: `fit${pad(i + 1, 2)}`,
			text: t,
			scored: false,
		}));
	}
	return `${JSON.stringify(tf, null, 1)}\n`;
}

export function design(dir = TASK_DIR, log = console.log): void {
	if (existsSync(join(dir, "MANIFEST.json"))) throw new Error(ALREADY);
	mkdirSync(dir, { recursive: true });
	const files: Record<string, ManifestEntry> = {};
	for (const c of Object.values(CLASSES)) {
		const body = taskFileBody(c.id);
		writeFileSync(join(dir, c.file), body);
		const n = (JSON.parse(body) as TaskFile).tasks.length;
		// `bytes` is the JS string length (prototype semantics, kept for parity)
		files[c.file] = { class: c.id, n, bytes: body.length, sha256: sha(body) };
		log(`sealed ${c.file.padEnd(22)} n=${n} sha256=${sha(body).slice(0, 16)}`);
	}
	const manifest: Manifest = {
		generator: GEN,
		seed: SEED,
		sealed_at: new Date().toISOString(),
		rule: "never edit; --n k takes the first k tasks",
		files,
	};
	const mb = `${JSON.stringify(manifest, null, 1)}\n`;
	writeFileSync(join(dir, "MANIFEST.json"), mb);
	log(`manifest sha256=${sha(mb).slice(0, 16)}`);
}

/** Copy a reference seal byte-for-byte, verifying every hash first. */
export function sealFrom(src: string, dir = TASK_DIR, log = console.log) {
	if (existsSync(join(dir, "MANIFEST.json"))) throw new Error(ALREADY);
	const srcV = verifyManifest(src);
	if (!srcV.ok)
		throw new Error(
			`reference seal ${src} fails its own manifest:\n${srcV.rows.join("\n")}`,
		);
	mkdirSync(dir, { recursive: true });
	const m = JSON.parse(
		readFileSync(join(src, "MANIFEST.json"), "utf8"),
	) as Manifest;
	for (const f of Object.keys(m.files))
		copyFileSync(join(src, f), join(dir, f));
	copyFileSync(join(src, "MANIFEST.json"), join(dir, "MANIFEST.json"));
	const v = verifyManifest(dir);
	if (!v.ok || v.hash !== srcV.hash)
		throw new Error("copied seal does not verify — refusing");
	log(
		`sealed from ${src}: manifest ${v.hash}, ${Object.keys(m.files).length} files byte-identical`,
	);
	return v;
}

export interface ManifestCheck {
	ok: boolean;
	rows: string[];
	hash: string;
}
export function verifyManifest(dir = TASK_DIR): ManifestCheck {
	const p = join(dir, "MANIFEST.json");
	if (!existsSync(p))
		return {
			ok: false,
			rows: ["MANIFEST.json missing — run --seal-from or --design"],
			hash: "",
		};
	const raw = readFileSync(p, "utf8");
	const m = JSON.parse(raw) as Manifest;
	let ok = true;
	const rows: string[] = [];
	for (const [f, e] of Object.entries(m.files)) {
		const fp = join(dir, f);
		const h = existsSync(fp) ? sha(readFileSync(fp, "utf8")) : "missing";
		const good = h === e.sha256;
		ok &&= good;
		rows.push(
			`| ${f} | ${e.class} | ${e.n} | ${(e.bytes / 1024).toFixed(0)} KiB | \`${e.sha256.slice(0, 16)}\` | ${good ? "PASS" : "FAIL (hash mismatch)"} |`,
		);
	}
	return { ok, rows, hash: sha(raw).slice(0, 16) };
}

const taskCache = new Map<string, TaskFile>();
export function loadTasks(c: ClassId, dir = TASK_DIR): TaskFile {
	const k = `${dir}|${c}`;
	let tf = taskCache.get(k);
	if (!tf) {
		tf = JSON.parse(
			readFileSync(join(dir, CLASSES[c].file), "utf8"),
		) as TaskFile;
		taskCache.set(k, tf);
	}
	return tf;
}
