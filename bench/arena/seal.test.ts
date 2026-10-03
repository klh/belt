import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASS_IDS, CLASSES, sha, TASK_DIR } from "./core.ts";
import { GENS } from "./gen.ts";
import { checkAnswer, checkExtract, goldFor, scoreText } from "./scoring.ts";
import {
	design,
	loadTasks,
	sealFrom,
	taskFileBody,
	verifyManifest,
} from "./seal.ts";

const quiet = () => {};

describe("seal", () => {
	test("tasks/ verifies and carries the reference manifest hash", () => {
		const v = verifyManifest();
		expect(v.ok).toBe(true);
		expect(v.hash).toBe("6253f5092545542e");
	});
	test("generators reproduce every sealed file byte-for-byte", () => {
		const m = JSON.parse(
			readFileSync(join(TASK_DIR, "MANIFEST.json"), "utf8"),
		) as {
			files: Record<string, { sha256: string }>;
		};
		for (const c of CLASS_IDS) {
			const f = CLASSES[c].file;
			expect([c, sha(taskFileBody(c))]).toEqual([
				c,
				m.files[f]?.sha256 ?? "missing",
			]);
			expect(GENS[c]().length).toBe(CLASSES[c].sealedN);
		}
	});
	test("design and sealFrom refuse to overwrite a seal", () => {
		expect(() => design(TASK_DIR, quiet)).toThrow();
		expect(() => sealFrom(TASK_DIR, TASK_DIR, quiet)).toThrow();
	});
	test("sealFrom copies a verified seal into a fresh dir", () => {
		const dir = join(mkdtempSync(join(tmpdir(), "arena-seal-")), "t");
		try {
			const v = sealFrom(TASK_DIR, dir, quiet);
			expect(v.hash).toBe("6253f5092545542e");
			expect(verifyManifest(dir).ok).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("scoring (non-code classes)", () => {
	for (const c of CLASS_IDS.filter((x) => x !== "b"))
		test(`${c}: gold scores 1, junk fails`, async () => {
			for (const t of loadTasks(c).tasks.slice(0, 20)) {
				const { gold, junk } = goldFor(t, c);
				expect((await scoreText(t.check, gold)).score).toBe(1);
				expect((await scoreText(t.check, junk)).pass).toBe(false);
			}
		});
	test("answer takes the LAST ANSWER line; extract tolerates fences", () => {
		const t = loadTasks("d").tasks[0];
		if (t?.check.kind !== "answer") throw new Error("d check");
		const exp = t.check.expect;
		expect(checkAnswer(`ANSWER: wrong\nANSWER: ${exp}`, t.check).pass).toBe(
			true,
		);
		const x = loadTasks("c").tasks[0];
		if (x?.check.kind !== "extract") throw new Error("c check");
		expect(
			checkExtract(
				`\`\`\`json\n${JSON.stringify(x.check.expect)}\n\`\`\``,
				x.check,
			).pass,
		).toBe(true);
	});
});
