// test/federation-cr.test.ts — W160 originate CLI: arg parsing + declare-body
// construction (the hub stays the structural enforcement point; the CLI is
// the operator surface).
import { describe, expect, test } from "bun:test";
import { buildDeclareBody, parseCrArgs } from "../bin/federation-cr.ts";

describe("w160: federation-cr CLI", () => {
	test("parse: declare with all flags; unknown command and flag rejected", () => {
		const good = parseCrArgs([
			"declare",
			"--action",
			"adopt-policy",
			"--target",
			"policy@3",
			"--id",
			"cr-9",
			"--origin-system",
			"suspenders",
			"--actor",
			"kkh",
		]);
		expect(good.ok).toBe(true);
		if (!good.ok) return;
		expect(good.args.command).toBe("declare");
		expect(good.args.action).toBe("adopt-policy");
		expect(good.args.target).toBe("policy@3");
		expect(good.args.originSystem).toBe("suspenders");
		const badCmd = parseCrArgs(["reboot"]);
		expect(badCmd.ok).toBe(false);
		const badFlag = parseCrArgs(["list", "--force"]);
		expect(badFlag.ok).toBe(false);
	});

	test("buildDeclareBody: requires action+target, exclusive payload sources, origin defaults", async () => {
		const missing = await buildDeclareBody(
			{
				command: "declare",
				id: null,
				action: null,
				target: "policy@1",
				payload: null,
				payloadFile: null,
				originSystem: "belt",
				actor: null,
			},
			"op",
		);
		expect(missing.ok).toBe(false);
		const ok = await buildDeclareBody(
			{
				command: "declare",
				id: "cr-1",
				action: "adopt-policy",
				target: "policy@2",
				payload: '{"revision":2}',
				payloadFile: null,
				originSystem: "belt",
				actor: null,
			},
			"op",
		);
		expect(ok.ok).toBe(true);
		if (!ok.ok) return;
		expect(ok.body.action).toBe("adopt-policy");
		expect(ok.body.payload).toEqual({ revision: 2 });
		expect(ok.body.origin).toEqual({ system: "belt", actor: "op" });
	});
});
