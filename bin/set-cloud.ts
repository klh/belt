#!/usr/bin/env bun
// set-cloud.ts — flip the router's cloud escalation. Used by /local command.
//   bun ~/.claude/local-llm/set-cloud.ts off|on|status

import { readFileSync, writeFileSync } from "node:fs";

const PREFS = `${process.env.HOME}/.claude/local-llm/prefs.json`;
const mode = process.argv[2] ?? "status";

const prefs = JSON.parse(readFileSync(PREFS, "utf8")) as { allow_cloud?: boolean };

if (mode === "off") {
  prefs.allow_cloud = false;
  writeFileSync(PREFS, JSON.stringify(prefs, null, 2) + "\n");
  console.log("allow_cloud → false · router is LOCAL-ONLY: no z.ai escalation, clients must not call cloud endpoints directly");
} else if (mode === "on") {
  prefs.allow_cloud = true;
  writeFileSync(PREFS, JSON.stringify(prefs, null, 2) + "\n");
  console.log("allow_cloud → true · cloud escalation re-enabled (COMPLEX+ only, never in cost mode)");
} else {
  console.log("allow_cloud:", prefs.allow_cloud === false ? "false (local-only)" : String(prefs.allow_cloud ?? true));
}
