// condense.ts — deterministic reference prompt condenser. Pure function of
// its input: no seed, no clock, no locale, no I/O — byte-stable forever for
// a given CONDENSE_VERSION. Bump the version whenever output may change.
//
// Strips filler and redundancy from PROSE only. Verbatim-protected:
// """…""" blocks, ```…``` fences, `code`, "quoted strings", <placeholders>,
// <log>…</log>, and FORMAT: lines (e.g. "ANSWER: <answer>"). Numbers,
// technical terms and imperative verbs are never removed.

export const CONDENSE_VERSION = "ref-condense/1";

const OPEN = "\uE001";
const CLOSE = "\uE002";
const CAP = "\uE003"; // marks "capitalise the next letter" after a removal
const PROTECT =
	/"""[\s\S]*?"""|```[\s\S]*?```|<log>[\s\S]*?<\/log>|`[^`\n]*`|"[^"\n]*"|<[^<>\n]{1,40}>|^[A-Z][A-Z_]+:.*$/gm;

// Verbose phrase → concise phrase (case-insensitive, whole words).
const PHRASES: [string, string][] = [
	["it is important to note that", ""],
	["it should be noted that", ""],
	["please note that", ""],
	["note that", ""],
	["i would like you to", ""],
	["i want you to", ""],
	["i need you to", ""],
	["could you please", ""],
	["would you please", ""],
	["could you", ""],
	["would you", ""],
	["can you", ""],
	["feel free to", ""],
	["be sure to", ""],
	["make sure to", ""],
	["make sure that", "ensure"],
	["due to the fact that", "because"],
	["at this point in time", "now"],
	["for the purpose of", "for"],
	["in the event that", "if"],
	["with regard to", "about"],
	["with respect to", "about"],
	["in regard to", "about"],
	["in order to", "to"],
	["each and every", "each"],
	["as well as", "and"],
	["a number of", "several"],
	["is able to", "can"],
	["are able to", "can"],
];
const FILLER = [
	"please",
	"kindly",
	"basically",
	"actually",
	"really",
	"simply",
	"just",
	"very",
	"quite",
	"literally",
	"certainly",
	"definitely",
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PHRASE_RES: [RegExp, string][] = PHRASES.map(([from, to]) => [
	new RegExp(`\\b${from.split(" ").map(esc).join("\\s+")}\\b,?[ \\t]*`, "gi"),
	to,
]);
const FILLER_RE = new RegExp(`\\b(?:${FILLER.join("|")})\\b,?[ \\t]*`, "gi");

/** Replace keeping the case of the first letter; an empty replacement of a
 *  capitalised match capitalises whatever follows. */
function replaceCased(s: string, re: RegExp, to: string): string {
	return s.replace(re, (m: string) => {
		const upper = /^[A-Z]/.test(m);
		if (!to) return upper ? CAP : "";
		const tail = /[ \t]$/.test(m) ? " " : "";
		const word = upper ? `${to.charAt(0).toUpperCase()}${to.slice(1)}` : to;
		return `${word}${tail}`;
	});
}

function condenseProse(s: string): string {
	let t = s;
	for (const [re, to] of PHRASE_RES) t = replaceCased(t, re, to);
	t = replaceCased(t, FILLER_RE, "");
	t = t.replace(/\bthe[ \t]+(?=[a-z0-9])/g, "");
	t = t.replace(/(?<=[ \t])an?[ \t]+(?=[a-z])(?!(?:and|or|is|are|b)\b)/g, "");
	t = t.replace(new RegExp(`${CAP}[ \\t]*([a-z])`, "g"), (_m, c: string) =>
		c.toUpperCase(),
	);
	t = t.replaceAll(CAP, "");
	return t
		.replace(/[ \t]{2,}/g, " ")
		.replace(/[ \t]+([,.;:!?)])/g, "$1")
		.replace(/\([ \t]+/g, "(")
		.replace(/^[ \t]+|[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n");
}

/** Drop repeated sentences (≥3 words), keeping the first occurrence. */
function dedupeSentences(s: string): string {
	const parts = s.split(/(?<=[.!?])(\s+)/);
	const seen = new Set<string>();
	const out: string[] = [];
	for (let i = 0; i < parts.length; i += 2) {
		const sent = parts[i] ?? "";
		const sep = parts[i + 1] ?? "";
		const key = sent.toLowerCase().replace(/\s+/g, " ").trim();
		if (key.split(" ").length >= 3 && seen.has(key)) continue;
		seen.add(key);
		out.push(sent, sep);
	}
	return out.join("");
}

function condenseOnce(input: string): string {
	const slots: string[] = [];
	const index = new Map<string, number>();
	const masked = input.replace(PROTECT, (m: string) => {
		let i = index.get(m);
		if (i === undefined) {
			i = slots.length;
			slots.push(m);
			index.set(m, i);
		}
		return `${OPEN}${i}${CLOSE}`;
	});
	const prose = dedupeSentences(condenseProse(masked));
	return prose
		.replace(
			new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"),
			(_m, i: string) => slots[Number(i)] ?? "",
		)
		.trim();
}

/** Condense to a fixpoint (idempotent: condense(condense(x)) === condense(x)).
 *  Inputs that already contain the private-use sentinels pass through. */
export function condense(input: string): string {
	if (/[\uE001-\uE003]/.test(input)) return input;
	let cur = input;
	for (let i = 0; i < 5; i++) {
		const next = condenseOnce(cur);
		if (next === cur) break;
		cur = next;
	}
	return cur;
}
