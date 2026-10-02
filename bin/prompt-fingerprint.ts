// prompt-fingerprint.ts — what the routing log may know about a prompt: a
// sha256 prefix (dedupe / correlate repeats) and its length. Never the text —
// the log is read by LAN-exposed endpoints.
import { createHash } from "node:crypto";

export function promptFingerprint(text: string): {
	prompt_sha256: string;
	prompt_len: number;
} {
	return {
		prompt_sha256: createHash("sha256").update(text).digest("hex").slice(0, 16),
		prompt_len: text.length,
	};
}
