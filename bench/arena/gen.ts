// gen.ts — seeded task generators (arena-gen-1). Byte-for-byte the sealed
// prototype: any change here changes --design output, and gen.test.ts pins
// every generator against the sealed manifest hashes.
import {
	CHARS_PER_TOK_LOG,
	CLASSES,
	type ClassId,
	cap1,
	ch,
	FENCE,
	hex8,
	ints,
	isoDay,
	MONTHS,
	pad,
	pick,
	type R,
	ri,
	rng,
	SEED,
	shuffle,
	strOf,
	type Task,
	TIERS,
} from "./core.ts";

// ---------------------------------------------------------------- (a) short-chat
const TOPICS = `DNS caching|TTL|resolver
TCP congestion control|congestion window|packet loss
database indexing|B-tree|query planner
HTTPS certificates|certificate authority|public key
garbage collection|heap|reachability
load balancing|health check|round robin
rate limiting|token bucket|burst
content delivery networks|edge server|cache hit
Git branching|merge commit|rebase
unit testing|assertion|test fixture
containerization|image|isolation
message queues|consumer|acknowledgement
eventual consistency|replica|convergence
password hashing|salt|work factor
two-factor authentication|one-time code|phishing
REST APIs|endpoint|status code
WebSockets|handshake|full duplex
JSON Web Tokens|signature|expiry
SQL joins|foreign key|result set
caching strategies|invalidation|stale data
binary search|sorted array|midpoint
hash tables|collision|bucket
recursion|base case|call stack
floating-point numbers|precision|rounding error
Unicode|code point|UTF-8
regular expressions|pattern|capture group
compilers|parser|syntax tree
virtual memory|page fault|address space
CPU caches|cache line|latency
multithreading|race condition|mutex
deadlocks|lock ordering|circular wait
backups|restore test|retention
observability|trace|metric
feature flags|rollout|kill switch
blue-green deployment|cutover|rollback
semantic versioning|major version|breaking change
dependency injection|interface|constructor
code review|diff|reviewer
technical debt|refactoring|interest
idempotency|retry|side effect
pagination|cursor|page size
time zones|UTC|offset
accessibility|screen reader|contrast ratio
vector embeddings|cosine similarity|dimension`
	.split("\n")
	.map((l) => l.split("|") as [string, string, string]);
const AUDIENCES = [
	"a new engineering hire",
	"a product manager",
	"a curious teenager",
];

export function genA(): Task[] {
	const r = rng(`${SEED}/a`);
	const all = TOPICS.flatMap(([topic, t1, t2]) =>
		AUDIENCES.map((aud) => ({ topic, t1, t2, aud })),
	);
	return shuffle(r, all)
		.slice(0, CLASSES.a.sealedN)
		.map((x, i) => ({
			id: `a${pad(i)}`,
			prompt: `In 60 to 120 words, explain ${x.topic} to ${x.aud}. Use the exact terms "${x.t1}" and "${x.t2}". Write plain prose in one or two paragraphs: no lists, no headings.`,
			check: { kind: "chat", terms: [x.t1, x.t2], min: 50, max: 150 },
		}));
}

// ---------------------------------------------------------------- (b) code-gen
interface Fam<P> {
	key: string;
	variants: P[];
	name: (p: P) => string;
	sig: string;
	desc: (p: P) => string;
	src: (p: P, n: string) => string;
	args: (r: R, p: P) => unknown[];
}
const fam = <P>(f: Fam<P>) => f as unknown as Fam<unknown>;
function romanOf(n: number): string {
	const t: [number, string][] = [
		[1000, "M"],
		[900, "CM"],
		[500, "D"],
		[400, "CD"],
		[100, "C"],
		[90, "XC"],
		[50, "L"],
		[40, "XL"],
		[10, "X"],
		[9, "IX"],
		[5, "V"],
		[4, "IV"],
		[1, "I"],
	];
	let o = "";
	let x = n;
	for (const [v, s] of t)
		while (x >= v) {
			o += s;
			x -= v;
		}
	return o;
}
const ROMAN_SRC = `const t=[[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],[50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]]`;
const CASES: Record<string, [string, (w: string[]) => string, string]> = {
	camel: [
		"camelCase",
		(w) => `${w[0]}${w.slice(1).map(cap1).join("")}`,
		`s.split(/(?=[A-Z])/).map(x=>x.toLowerCase())`,
	],
	snake: ["snake_case", (w) => w.join("_"), `s.split("_")`],
	kebab: ["kebab-case", (w) => w.join("-"), `s.split("-")`],
};
const caseOf = (k: string) =>
	CASES[k] as [string, (w: string[]) => string, string];
const CASE_JOIN: Record<string, string> = {
	camel: `w[0]+w.slice(1).map(x=>x[0].toUpperCase()+x.slice(1)).join("")`,
	snake: `w.join("_")`,
	kebab: `w.join("-")`,
};
const WORDS = [
	"user",
	"id",
	"max",
	"retry",
	"count",
	"http",
	"status",
	"page",
	"token",
	"cache",
];
type Nested = (number | Nested)[];
function nested(r: R, d: number): Nested {
	return Array.from({ length: ri(r, 0, 4) }, () =>
		d > 0 && r() < 0.4 ? nested(r, d - 1) : ri(r, 0, 9),
	);
}
const pairsOf = (v: string) =>
	Array.from({ length: v.length / 2 }, (_, i) => v.slice(2 * i, 2 * i + 2));

const FAMS: Fam<unknown>[] = [
	fam({
		key: "rotate",
		variants: [1, 2, 3, 5, 7, 10, 13].flatMap((k) => [
			{ k, dir: "left" },
			{ k, dir: "right" },
		]),
		name: (p) => `rotate${cap1(p.dir)}`,
		sig: "arr",
		desc: (p) =>
			`returns a new array equal to \`arr\` rotated ${p.dir} by ${p.k} positions (the shift may exceed the length; an empty array gives []). Do not mutate \`arr\`.`,
		src: (p, n) =>
			`function ${n}(arr){const n=arr.length;if(!n)return [];const k=${p.dir === "left" ? `${p.k}%n` : `(n-${p.k}%n)%n`};return arr.slice(k).concat(arr.slice(0,k));}`,
		args: (r) => [ints(r, 0, 99, 0, 9)],
	}),
	fam({
		key: "caesar",
		variants: [1, 3, 4, 7, 11, 13, 19, 25].flatMap((k) => [
			{ k, dir: "forward" },
			{ k, dir: "backward" },
		]),
		name: () => "caesar",
		sig: "s",
		desc: (p) =>
			`shifts every ASCII letter in the string \`s\` ${p.dir} through the alphabet by ${p.k} places, wrapping around and preserving case; all other characters are unchanged.`,
		src: (p, n) =>
			`function ${n}(s){return s.replace(/[A-Za-z]/g,c=>{const b=c<"a"?65:97;return String.fromCharCode((c.charCodeAt(0)-b+${p.dir === "forward" ? p.k : 26 - p.k})%26+b)})}`,
		args: (r) => [strOf(r, "abxyzABXYZ ,.!1", 0, 14)],
	}),
	fam({
		key: "rle",
		variants: [
			{ cn: true, omit: false },
			{ cn: true, omit: true },
			{ cn: false, omit: false },
			{ cn: false, omit: true },
		],
		name: () => "rle",
		sig: "s",
		desc: (p) =>
			`run-length encodes the string \`s\`: each maximal run of one repeated character becomes ${p.cn ? "the character followed by the run length" : "the run length followed by the character"}${p.omit ? ", except that runs of length 1 are written as the character alone" : ""}. Example: "aaab" becomes "${p.cn ? (p.omit ? "a3b" : "a3b1") : p.omit ? "3ab" : "3a1b"}". The empty string gives "".`,
		src: (p, n) =>
			`function ${n}(s){let o="";for(let i=0;i<s.length;){let j=i;while(j<s.length&&s[j]===s[i])j++;const n=j-i;o+=${p.omit ? "n===1?s[i]:" : ""}${p.cn ? "s[i]+n" : "n+s[i]"};i=j;}return o;}`,
		args: (r) => [
			Array.from({ length: ri(r, 0, 5) }, () =>
				ch(r, "abc").repeat(ri(r, 1, 4)),
			).join(""),
		],
	}),
	fam({
		key: "chunk",
		variants: [2, 3, 4, 5, 6, 7, 8, 9].map((k) => ({ k })),
		name: () => "chunk",
		sig: "arr",
		desc: (p) =>
			`splits \`arr\` into consecutive sub-arrays of length ${p.k}; the last one may be shorter. An empty array gives [].`,
		src: (p, n) =>
			`function ${n}(arr){const o=[];for(let i=0;i<arr.length;i+=${p.k})o.push(arr.slice(i,i+${p.k}));return o;}`,
		args: (r) => [ints(r, 0, 9, 0, 20)],
	}),
	fam({
		key: "fizz",
		variants: (
			[
				[3, 5, "Fizz", "Buzz"],
				[2, 7, "Foo", "Bar"],
				[4, 6, "Ping", "Pong"],
				[3, 4, "Tik", "Tok"],
				[5, 7, "Zig", "Zag"],
				[2, 3, "Hip", "Hop"],
				[3, 8, "Red", "Blue"],
				[6, 9, "Sun", "Moon"],
			] as [number, number, string, string][]
		).map(([a, b, w1, w2]) => ({ a, b, w1, w2 })),
		name: () => "fizz",
		sig: "n",
		desc: (p) =>
			`returns an array of strings for the integers 1..n in order: a multiple of both ${p.a} and ${p.b} becomes "${p.w1}${p.w2}", a multiple of ${p.a} only becomes "${p.w1}", a multiple of ${p.b} only becomes "${p.w2}", and any other number becomes its decimal string. n = 0 gives [].`,
		src: (p, n) =>
			`function ${n}(n){const o=[];for(let i=1;i<=n;i++){const x=i%${p.a}===0,y=i%${p.b}===0;o.push(x&&y?"${p.w1}${p.w2}":x?"${p.w1}":y?"${p.w2}":String(i));}return o;}`,
		args: (r) => [ri(r, 0, 30)],
	}),
	fam({
		key: "dedupe",
		variants: ["id", "sku", "email", "slug"].flatMap((key) => [
			{ key, keep: "last" },
			{ key, keep: "first" },
		]),
		name: () => "dedupeBy",
		sig: "items",
		desc: (p) =>
			`takes an array of objects that each have a \`${p.key}\` property and returns a new array keeping only the ${p.keep} object for each distinct \`${p.key}\` value; surviving objects keep their original relative order.`,
		src: (p, n) =>
			p.keep === "last"
				? `function ${n}(items){const l=new Map();items.forEach((x,i)=>l.set(x.${p.key},i));return items.filter((x,i)=>l.get(x.${p.key})===i);}`
				: `function ${n}(items){const s=new Set();return items.filter(x=>s.has(x.${p.key})?false:(s.add(x.${p.key}),true));}`,
		args: (r, p) => [
			Array.from({ length: ri(r, 0, 8) }, () => ({
				[p.key]: ch(r, "abcd"),
				v: ri(r, 0, 99),
			})),
		],
	}),
	fam({
		key: "roman",
		variants: [{ to: true }, { to: false }],
		name: (p) => (p.to ? "toRoman" : "fromRoman"),
		sig: "x",
		desc: (p) =>
			p.to
				? `converts an integer x (1 ≤ x ≤ 3999) to an uppercase Roman numeral in standard subtractive notation (e.g. 1994 gives "MCMXCIV").`
				: `converts a valid uppercase Roman numeral string x in standard subtractive notation (value 1 to 3999) to an integer.`,
		src: (p, n) =>
			p.to
				? `function ${n}(x){${ROMAN_SRC};let o="";for(const [v,s] of t)while(x>=v){o+=s;x-=v;}return o;}`
				: `function ${n}(x){const v={I:1,V:5,X:10,L:50,C:100,D:500,M:1000};let s=0;for(let i=0;i<x.length;i++){const a=v[x[i]],b=v[x[i+1]]??0;s+=a<b?-a:a;}return s;}`,
		args: (r, p) => [p.to ? ri(r, 1, 3999) : romanOf(ri(r, 1, 3999))],
	}),
	fam({
		key: "kv",
		variants: [";", "&", ",", "|"].flatMap((sep) =>
			["=", ":"].map((a) => ({ sep, a })),
		),
		name: () => "parseKV",
		sig: "s",
		desc: (p) =>
			`parses a string of key${p.a}value pairs separated by "${p.sep}" into a plain object whose values are strings. Split each segment at the first "${p.a}" only; trim whitespace around keys and values; skip segments that contain no "${p.a}" or whose key is empty; when a key repeats, the later value wins.`,
		src: (p, n) =>
			`function ${n}(s){const o={};for(const g of s.split(${JSON.stringify(p.sep)})){const i=g.indexOf(${JSON.stringify(p.a)});if(i<0)continue;const k=g.slice(0,i).trim();if(!k)continue;o[k]=g.slice(i+1).trim();}return o;}`,
		args: (r, p) => [
			Array.from({ length: ri(r, 0, 5) }, () => {
				const k = pick(r, ["a", "b", "id", "name", "x"]);
				const v = pick(r, ["1", "two", "x y", "", "q"]);
				const t = ri(r, 0, 5);
				if (t === 0) return k;
				if (t === 1) return ` ${k} ${p.a} ${v} `;
				if (t === 2) return `${p.a}${v}`;
				if (t === 3) return `${k}${p.a}${v}${p.a}${v}`;
				return `${k}${p.a}${v}`;
			}).join(p.sep),
		],
	}),
	fam({
		key: "flatten",
		variants: [1, 2, 3, 4].map((d) => ({ d })),
		name: () => "flattenDepth",
		sig: "arr",
		desc: (p) =>
			`returns a new array in which nested arrays inside \`arr\` are flattened by at most ${p.d} level${p.d > 1 ? "s" : ""}: array elements are spread into their parent, repeatedly, until ${p.d} level${p.d > 1 ? "s have" : " has"} been removed; deeper arrays stay nested.`,
		src: (p, n) => `function ${n}(arr){return arr.flat(${p.d});}`,
		args: (r) => [nested(r, 4)],
	}),
	fam({
		key: "topk",
		variants: [1, 2, 3, 4, 5, 6].map((k) => ({ k })),
		name: () => "topWords",
		sig: "text",
		desc: (p) =>
			`returns the ${p.k} most frequent words in \`text\` as an array of lowercase strings. A word is a maximal run of letters a-z after lowercasing the text. Order by count descending, ties alphabetically ascending; return fewer if there are fewer distinct words.`,
		src: (p, n) =>
			`function ${n}(text){const m=new Map();for(const w of text.toLowerCase().match(/[a-z]+/g)??[])m.set(w,(m.get(w)??0)+1);return [...m].sort((x,y)=>y[1]-x[1]||(x[0]<y[0]?-1:x[0]>y[0]?1:0)).slice(0,${p.k}).map(x=>x[0]);}`,
		args: (r) => [
			Array.from({ length: ri(r, 0, 15) }, () =>
				pick(r, ["cat", "dog", "Cat", "bird", "the", "a", "DOG", "fish"]),
			).join(pick(r, [" ", ", ", "! ", "-"])),
		],
	}),
	fam({
		key: "matrix",
		variants: ["transpose", "clockwise", "counterclockwise"].map((v) => ({
			v,
		})),
		name: () => "transform",
		sig: "m",
		desc: (p) =>
			`takes a rectangular matrix \`m\` (an array of equal-length non-empty rows) and returns ${p.v === "transpose" ? "its transpose" : `it rotated 90 degrees ${p.v}`} as a new matrix; [] gives [].`,
		src: (p, n) =>
			`function ${n}(m){if(!m.length)return [];return m[0].map((_,j)=>${p.v === "transpose" ? "m.map(r=>r[j])" : p.v === "clockwise" ? "m.map(r=>r[j]).reverse()" : "m.map(r=>r[r.length-1-j])"});}`,
		args: (r) => {
			const rows = ri(r, 0, 4);
			const cols = ri(r, 1, 4);
			return [Array.from({ length: rows }, () => ints(r, 0, 9, cols, cols))];
		},
	}),
	fam({
		key: "pal",
		variants: ["alnum", "exact", "letters"].map((v) => ({ v })),
		name: () => "isPal",
		sig: "s",
		desc: (p) =>
			p.v === "exact"
				? "returns true if the string `s` reads the same forwards and backwards exactly (case-sensitive, every character counts), else false."
				: `returns true if the string \`s\` is a palindrome when only ${p.v === "alnum" ? "ASCII letters and digits" : "ASCII letters"} are considered, ignoring case, else false.`,
		src: (p, n) =>
			p.v === "exact"
				? `function ${n}(s){return s===[...s].reverse().join("");}`
				: `function ${n}(s){const t=s.toLowerCase().replace(/${p.v === "alnum" ? "[^a-z0-9]" : "[^a-z]"}/g,"");return t===[...t].reverse().join("");}`,
		args: (r) => {
			const h = strOf(r, "abAB1 ,", 0, 5);
			return [
				r() < 0.5
					? `${h}${[...h].reverse().join("")}`
					: `${h}${strOf(r, "ab1A", 0, 3)}`,
			];
		},
	}),
	fam({
		key: "gcd",
		variants: [{ g: true }, { g: false }],
		name: (p) => (p.g ? "gcdAll" : "lcmAll"),
		sig: "nums",
		desc: (p) =>
			`returns the ${p.g ? "greatest common divisor" : "least common multiple"} of a non-empty array \`nums\` of positive integers.`,
		src: (p, n) =>
			`function ${n}(nums){const g=(a,b)=>b?g(b,a%b):a;return nums.reduce((a,b)=>${p.g ? "g(a,b)" : "a/g(a,b)*b"});}`,
		args: (r) => [ints(r, 1, 60, 1, 5)],
	}),
	fam({
		key: "brackets",
		variants: ["()", "()[]", "()[]{}", "<>()"].map((v) => ({ v })),
		name: () => "balanced",
		sig: "s",
		desc: (p) =>
			`returns true if every bracket character from the pairs ${pairsOf(p.v)
				.map((x) => `"${x}"`)
				.join(
					", ",
				)} in \`s\` is properly matched and nested, otherwise false; all other characters are ignored.`,
		src: (p, n) =>
			`function ${n}(s){const P=${JSON.stringify(Object.fromEntries(pairsOf(p.v).map((x) => [x[1], x[0]])))};const O=new Set(Object.values(P));const st=[];for(const c of s){if(O.has(c))st.push(c);else if(c in P){if(st.pop()!==P[c])return false;}}return st.length===0;}`,
		args: (r, p) => [strOf(r, `${p.v}${p.v}ab`, 0, 10)],
	}),
	fam({
		key: "bound",
		variants: [{ lo: true }, { lo: false }],
		name: (p) => (p.lo ? "lowerBound" : "upperBound"),
		sig: "arr, x",
		desc: (p) =>
			`given an array \`arr\` of numbers sorted ascending and a number \`x\`, returns the smallest index i such that arr[i] ${p.lo ? ">=" : ">"} x, or arr.length if there is none.`,
		src: (p, n) =>
			`function ${n}(arr,x){let i=0;while(i<arr.length&&arr[i]${p.lo ? "<" : "<="}x)i++;return i;}`,
		args: (r) => [ints(r, 0, 20, 0, 9).sort((a, b) => a - b), ri(r, -1, 21)],
	}),
	fam({
		key: "merge",
		variants: [{ touch: true }, { touch: false }],
		name: () => "mergeIntervals",
		sig: "list",
		desc: (p) =>
			`takes an array of [start, end] integer pairs (start ≤ end, in any order) and returns a new array of merged intervals sorted by start. Two intervals merge when they ${p.touch ? "overlap or share an endpoint (e.g. [1,3] and [3,5] give [1,5])" : "overlap in more than a single point; intervals that only share an endpoint (e.g. [1,3] and [3,5]) stay separate"}.`,
		src: (p, n) =>
			`function ${n}(list){const s=list.map(x=>[x[0],x[1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);const o=[];for(const x of s){const c=o[o.length-1];if(c&&x[0]${p.touch ? "<=" : "<"}c[1])c[1]=Math.max(c[1],x[1]);else o.push(x);}return o;}`,
		args: (r) => [
			Array.from({ length: ri(r, 0, 6) }, () => {
				const a = ri(r, 0, 15);
				return [a, a + ri(r, 0, 4)];
			}),
		],
	}),
	fam({
		key: "base",
		variants: [2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 16, 36].map((b) => ({ b })),
		name: () => "toBase",
		sig: "n",
		desc: (p) =>
			`converts a non-negative integer n to its base-${p.b} representation as a string, using digits 0-9 then lowercase a-z; 0 gives "0".`,
		src: (p, n) => `function ${n}(n){return n.toString(${p.b});}`,
		args: (r) => [ri(r, 0, 100000)],
	}),
	fam({
		key: "digitpow",
		variants: [1, 2, 3, 4, 5].map((e) => ({ e })),
		name: () => "digitPowSum",
		sig: "n",
		desc: (p) =>
			`returns the sum of the decimal digits of the non-negative integer n, each raised to the power ${p.e}.`,
		src: (p, n) =>
			`function ${n}(n){return [...String(n)].reduce((s,d)=>s+Number(d)**${p.e},0);}`,
		args: (r) => [ri(r, 0, 999999)],
	}),
	fam({
		key: "countset",
		variants: ["aeiou", "aeiouy", "ae", "xyz"].map((s) => ({ s })),
		name: () => "countSet",
		sig: "s",
		desc: (p) =>
			`returns how many characters of the string \`s\` belong to the set of letters "${p.s}", case-insensitively.`,
		src: (p, n) =>
			`function ${n}(s){let c=0;for(const x of s.toLowerCase())if(${JSON.stringify(p.s)}.includes(x))c++;return c;}`,
		args: (r) => [strOf(r, "aeiouyxzbAEYX ", 0, 16)],
	}),
	fam({
		key: "movavg",
		variants: [2, 3, 4, 5, 6].map((w) => ({ w })),
		name: () => "movingAvg",
		sig: "arr",
		desc: (p) =>
			`returns the simple moving averages of the integer array \`arr\` over windows of ${p.w} consecutive elements (length arr.length - ${p.w} + 1, or [] if arr is shorter than ${p.w}), each rounded to 2 decimal places and returned as a number.`,
		src: (p, n) =>
			`function ${n}(arr){const o=[];for(let i=0;i+${p.w}<=arr.length;i++){let s=0;for(let j=i;j<i+${p.w};j++)s+=arr[j];o.push(Math.round(s/${p.w}*100)/100);}return o;}`,
		args: (r) => [ints(r, 0, 50, 0, 10)],
	}),
	fam({
		key: "nth",
		variants: [2, 3, 4, 5, 6].map((k) => ({ k })),
		name: () => "everyNth",
		sig: "arr",
		desc: (p) =>
			`returns a new array containing every ${p.k}th element of \`arr\`, starting with the element at index ${p.k - 1}.`,
		src: (p, n) =>
			`function ${n}(arr){return arr.filter((_,i)=>i%${p.k}===${p.k - 1});}`,
		args: (r) => [ints(r, 0, 99, 0, 15)],
	}),
	fam({
		key: "case",
		variants: Object.keys(CASES).flatMap((from) =>
			Object.keys(CASES)
				.filter((t) => t !== from)
				.map((to) => ({ from, to })),
		),
		name: () => "convertCase",
		sig: "s",
		desc: (p) =>
			`converts an identifier from ${caseOf(p.from)[0]} to ${caseOf(p.to)[0]}. Words contain only lowercase letters a-z${p.from === "camel" ? " (in the camelCase input every word after the first starts with one uppercase letter)" : ""}; there is at least one word.`,
		src: (p, n) =>
			`function ${n}(s){const w=${caseOf(p.from)[2]};return ${CASE_JOIN[p.to]};}`,
		args: (r, p) => [
			caseOf(p.from)[1](
				Array.from({ length: ri(r, 1, 4) }, () => pick(r, WORDS)),
			),
		],
	}),
];

export function genB(): Task[] {
	const r = rng(`${SEED}/b`);
	const all = FAMS.flatMap((f) => f.variants.map((p, vi) => ({ f, p, vi })));
	return shuffle(r, all)
		.slice(0, CLASSES.b.sealedN)
		.map(({ f, p, vi }, i) => {
			const name = f.name(p);
			const src = f.src(p, name);
			const ref = new Function(`${src}\nreturn ${name};`)() as (
				...a: unknown[]
			) => unknown;
			const tr = rng(`${SEED}/b/${f.key}/${vi}`);
			const tests = Array.from({ length: 8 }, () => {
				const a = f.args(tr, p);
				return [a, ref(...structuredClone(a))] as [unknown[], unknown];
			});
			return {
				id: `b${pad(i)}`,
				prompt: `Write a JavaScript function \`${name}(${f.sig})\` that ${f.desc(p)}\n\nReturn only the function in a single ${FENCE}js code block. No imports, no I/O, no explanation.`,
				check: { kind: "code", fn: name, tests, ref: src },
				meta: { family: f.key, variant: p },
			};
		});
}

// ---------------------------------------------------------------- (c) extract
const FIRST = [
	"Maja",
	"Lars",
	"Sofie",
	"Jonas",
	"Emma",
	"Oliver",
	"Freja",
	"Noah",
	"Ida",
	"William",
	"Clara",
	"Lucas",
	"Alma",
	"Victor",
	"Ella",
	"Oscar",
	"Nora",
	"Emil",
	"Laura",
	"Felix",
];
const LAST = [
	"Jensen",
	"Nielsen",
	"Hansen",
	"Pedersen",
	"Andersen",
	"Christensen",
	"Larsen",
	"Rasmussen",
	"Petersen",
	"Madsen",
	"Kristensen",
	"Olsen",
	"Thomsen",
	"Poulsen",
	"Johansen",
	"Moller",
];
const CITIES = [
	"Aarhus",
	"Odense",
	"Berlin",
	"Lyon",
	"Malmo",
	"Porto",
	"Ghent",
	"Utrecht",
];

export function genC(): Task[] {
	const r = rng(`${SEED}/c`);
	return Array.from({ length: CLASSES.c.sealedN }, (_, i) => {
		const f = pick(r, FIRST);
		const l = pick(r, LAST);
		const name = `${f} ${l}`;
		const email = `${f.toLowerCase()}.${l.toLowerCase()}${ri(r, 1, 99)}@${pick(r, ["example.com", "mail.test", "shop.example", "corp.test"])}`;
		const oid = `ORD-${ri(r, 10000, 99999)}`;
		let prev = oid;
		while (prev === oid) prev = `ORD-${ri(r, 10000, 99999)}`;
		const total = ri(r, 500, 250000) / 100;
		const cur = pick(r, ["EUR", "USD", "DKK"]);
		const fee = `${ri(r, 2, 15)}.00`;
		const q = ri(r, 1, 12);
		const y = ri(r, 2025, 2026);
		const m = ri(r, 1, 12);
		const d = ri(r, 1, 28);
		const iso = `${y}-${pad(m, 2)}-${pad(d, 2)}`;
		const mon = MONTHS[m - 1];
		const date = pick(r, [
			`${mon} ${d}, ${y}`,
			`${d} ${mon} ${y}`,
			`${y}/${pad(m, 2)}/${pad(d, 2)}`,
		]);
		const phone = `+45 ${ri(r, 10, 99)} ${ri(r, 10, 99)} ${ri(r, 10, 99)} ${ri(r, 10, 99)}`;
		const ticket = `#${ri(r, 1000, 9999)}`;
		const city = pick(r, CITIES);
		const t = total.toFixed(2);
		const msg = [
			`Hi team, this is ${name} from ${city}. My order ${oid}, placed on ${date}, was for ${q} units and came to ${t} ${cur} in total, which includes a ${fee} ${cur} shipping fee. My previous order ${prev} arrived fine. You can reach me at ${email} or on ${phone}.`,
			`Support ticket ${ticket}\nCustomer: ${name} <${email}>\nPhone: ${phone}\nNote: customer references old order ${prev} (closed).\nCurrent order: ${oid} - ${q} item(s), ordered ${date}.\nAmount charged: ${cur} ${t} (shipping ${fee} included).`,
			`${name} placed order ${oid} on ${date} and wrote in ticket ${ticket}: "I paid ${t} ${cur} for ${q} pieces, shipping (${fee} ${cur}) included. Please reply to ${email}." Agent note: do not confuse with ${prev}; callback number ${phone}.`,
			`Order summary\n- ref: ${oid} (replaces cancelled ${prev})\n- date: ${date}\n- quantity: ${q}\n- shipping: ${fee} ${cur}\n- grand total: ${t} ${cur}\n- buyer: ${name}, ${city}\n- contact: ${email} / ${phone}`,
		][i % 4];
		return {
			id: `c${pad(i)}`,
			prompt: `Extract the order details from the message below. Return ONLY a JSON object with exactly these keys: "customer_name" (string), "email" (string), "order_id" (string), "total" (number, the order total), "currency" (ISO 4217 code string), "order_date" (string, YYYY-MM-DD), "quantity" (integer).\n\nMessage:\n"""\n${msg}\n"""`,
			check: {
				kind: "extract",
				expect: {
					customer_name: name,
					email,
					order_id: oid,
					total,
					currency: cur,
					order_date: iso,
					quantity: q,
				},
			},
		};
	});
}

// ---------------------------------------------------------------- (d) reasoning
const D_SUFFIX =
	"\n\nThink it through, then end your reply with exactly two lines:\nANSWER: <answer>\nCONFIDENCE: <integer 0-100>";
const ORD = [
	"tallest",
	"second tallest",
	"third tallest",
	"fourth tallest",
	"shortest",
];
const D_FAMILIES = [
	"discount",
	"ordering",
	"date",
	"inventory",
	"clock",
	"dice",
];
interface DItem {
	q: string;
	ans: string;
	type: string;
}
function dDiscount(r: R): DItem {
	const pc = ri(r, 150, 2500);
	const Q = ri(r, 3, 40);
	const T = ri(r, 5, 25);
	const D = pick(r, [5, 10, 15, 20, 25]);
	const S = ri(r, 3, 12);
	const sub = Q * pc;
	const disc = Q > T ? Math.round((sub * (100 - D)) / 100) : sub;
	return {
		ans: ((disc + S * 100) / 100).toFixed(2),
		type: "num",
		q: `A shop sells notebooks at $${(pc / 100).toFixed(2)} each. Ana buys ${Q} notebooks. Orders of more than ${T} notebooks get ${D}% off the notebook subtotal (rounded to the nearest cent, half-cents round up). A flat $${S}.00 shipping fee is then added. How much does Ana pay in total, in dollars?`,
	};
}
function dOrdering(r: R): DItem {
	const rank = shuffle(r, [
		"Ana",
		"Ben",
		"Cara",
		"Dev",
		"Eli",
		"Fay",
		"Gus",
		"Hal",
	]).slice(0, 5);
	const facts = shuffle(
		r,
		[0, 1, 2, 3].map((j) =>
			r() < 0.5
				? `${rank[j]} is taller than ${rank[j + 1]}.`
				: `${rank[j + 1]} is shorter than ${rank[j]}.`,
		),
	);
	const k = ri(r, 0, 4);
	return {
		ans: rank[k] as string,
		type: "name",
		q: `Five people have different heights. ${facts.join(" ")} Who is the ${ORD[k]}?`,
	};
}
function dDate(r: R): DItem {
	const s = Date.UTC(ri(r, 2025, 2027), ri(r, 0, 11), ri(r, 1, 28));
	const N = ri(r, 20, 400);
	return {
		ans: isoDay(s + (N - 1) * 864e5),
		type: "date",
		q: `A project starts on ${isoDay(s)} and runs for ${N} consecutive calendar days, counting the start date as day 1. What is the date of its last day? Give it as YYYY-MM-DD.`,
	};
}
function dInventory(r: R): DItem {
	let st = ri(r, 20, 200);
	const S0 = st;
	const ev: string[] = [];
	for (let k = ri(r, 4, 6); k > 0; k--) {
		const t = ri(r, 0, 3);
		const x = ri(r, 1, 30);
		if (t === 0) {
			st += x;
			ev.push(`receives a delivery of ${x} units`);
		} else if (t === 1) {
			const y = Math.min(x, st);
			st -= y;
			ev.push(`ships ${y} units to customers`);
		} else if (t === 2) {
			st += x;
			ev.push(
				`gets ${x} units returned in perfect condition and puts them back in stock`,
			);
		} else {
			ev.push(`gets ${x} units returned damaged and discards them`);
		}
	}
	return {
		ans: String(st),
		type: "num",
		q: `A warehouse starts the day with ${S0} units of a product. In order, it ${ev.join(", then ")}. How many units are in stock at the end of the day?`,
	};
}
function dClock(r: R): DItem {
	const h = ri(r, 0, 23);
	const m = ri(r, 0, 59);
	const M = ri(r, 50, 3000);
	const t = (h * 60 + m + M) % 1440;
	return {
		ans: `${pad(Math.floor(t / 60), 2)}:${pad(t % 60, 2)}`,
		type: "time",
		q: `A 24-hour clock shows ${pad(h, 2)}:${pad(m, 2)}. What will it show exactly ${M} minutes later? Answer as HH:MM.`,
	};
}
function dDice(r: R): DItem {
	const v = ri(r, 0, 2);
	let cnt = 0;
	let K: number;
	if (v === 2) K = pick(r, [4, 6, 8, 12, 18, 24, 36]);
	else K = v === 0 ? ri(r, 2, 12) : ri(r, 3, 12);
	for (let a = 1; a <= 6; a++)
		for (let b = 1; b <= 6; b++)
			if (v === 0 ? a + b === K : v === 1 ? a + b >= K : a * b === K) cnt++;
	const what =
		v === 0
			? `a sum of exactly ${K}`
			: v === 1
				? `a sum of at least ${K}`
				: `a product of exactly ${K}`;
	return {
		ans: String(cnt),
		type: "num",
		q: `Two fair six-sided dice, one red and one blue, are rolled. Of the 36 equally likely (red, blue) outcomes, how many have ${what}?`,
	};
}
const D_GENS = [dDiscount, dOrdering, dDate, dInventory, dClock, dDice];

export function genD(): Task[] {
	const r = rng(`${SEED}/d`);
	const out: Omit<Task, "id">[] = [];
	const seen = new Set<string>();
	for (let i = 0; out.length < CLASSES.d.sealedN; i++) {
		const fam = i % 6;
		const { q, ans, type } = (D_GENS[fam] as (r: R) => DItem)(r);
		if (seen.has(q)) continue; // dedupe: dice family has few distinct prompts
		seen.add(q);
		out.push({
			prompt: q + D_SUFFIX,
			check: { kind: "answer", expect: ans, type },
			meta: { family: D_FAMILIES[fam] },
		});
	}
	return shuffle(r, out).map((t, i) => ({ id: `d${pad(i)}`, ...t }));
}

// ---------------------------------------------------------------- (e) decision / routing
const E_SRC: Record<string, [string[], string[], string]> = {
	coder: [
		[
			"Fix the failing unit test in",
			"Refactor",
			"Add strict type annotations to",
			"Write integration tests for",
			"Implement retry with exponential backoff in",
			"Remove the memory leak in",
		],
		[
			"the payment webhook handler.",
			"the CSV importer module.",
			"the auth middleware.",
			"the rate limiter class.",
			"the cron scheduler service.",
		],
		" ",
	],
	extract: [
		[
			"Pull the invoice number and due date out of this email:",
			"Classify this support ticket as billing, shipping or returns:",
			"Convert this YAML snippet to JSON:",
			"List every email address that appears in this note:",
			"Tag the sentiment (positive/negative/neutral) of this review:",
		],
		[
			'"Invoice INV-2231 is due 2026-11-03, contact ap@acme.test."',
			'"My parcel never arrived and I was charged twice."',
			'"name: api\\nreplicas: 3\\nport: 8080"',
			'"Loved the fast delivery, but the box was dented."',
			'"Ping ops@corp.test or lea@corp.test about the outage."',
		],
		" ",
	],
	reason: [
		[
			"Without writing any code, compare the trade-offs of",
			"Plan, step by step and without code, a phased move from",
			"Work out step by step whether it is cheaper to run",
			"Analyze the main risks of",
			"Estimate with explicit arithmetic the server capacity needed for",
		],
		[
			"a modular monolith versus microservices for a three-person team.",
			"a single Postgres primary to a primary with two read replicas.",
			"nightly batch jobs on spot instances versus reserved instances.",
			"letting every team deploy straight to production on Fridays.",
			"40,000 users each making 30 requests per hour at 120 ms per request.",
		],
		" ",
	],
	general: [
		[
			"Write a short, friendly message in German to my neighbour about",
			"Write a short, friendly message in French to my neighbour about",
			"Write a short, friendly message in Spanish to my neighbour about",
			"Write a short, friendly message in Danish to my neighbour about",
			"Write a short, friendly message in Swedish to my neighbour about",
		],
		[
			"the parking situation.",
			"tomorrow's barbecue.",
			"the broken heater in the stairwell.",
			"a lost cat.",
			"the new recycling bins.",
		],
		" ",
	],
	cloud: [
		[
			"Here is our 180k-token monorepo dump; find every caller of",
			"From the attached 95,000-token contract, summarise every clause about",
			"Across the attached 60k-token incident log, list each occurrence of",
			"I explicitly require the frontier cloud model for this, nothing local: review",
			"Use the attached 120k-token specification to explain",
		],
		[
			"the billing API.",
			"data retention.",
			"the retry policy.",
			"the auth token refresh flow.",
			"GDPR obligations.",
		],
		" ",
	],
	none: [
		[
			"Generate a photorealistic image of",
			"Produce a 30-second video clip of",
			"Transcribe the attached 20-minute audio recording of",
			"Browse the live web right now and report the current status of",
			"Phone the venue and ask about",
		],
		[
			"our office dog wearing a party hat.",
			"the product launch keynote.",
			"the quarterly all-hands meeting.",
			"tonight's train departures from Copenhagen.",
			"the wheelchair access for Friday.",
		],
		" ",
	],
};
export const LEGACY_FIT = [
	"fix flaky async test in a scheduler service",
	"write a Danish summary of this quarterly report",
	"generate a React component for a pricing table",
	"refactor the payment reconciliation module",
	"explain this stack trace to a junior dev",
	"classify customer support tickets by urgency",
	"optimize the image pipeline hot loop",
	"draft the API contract for the new export endpoint",
	"migrate the CMS database schema",
	"triage which 8900-range model should serve a chat request",
	"write e2e tests for the checkout flow",
	"translate the onboarding emails to German",
];
export function genE(): Task[] {
	const r = rng(`${SEED}/e`);
	const all = Object.entries(E_SRC).flatMap(([label, [a, b, sep]]) =>
		a.flatMap((x) => b.map((y) => ({ label, text: `${x}${sep}${y}` }))),
	);
	return shuffle(r, all)
		.slice(0, CLASSES.e.sealedN)
		.map((x, i) => ({
			id: `e${pad(i)}`,
			text: x.text,
			label: x.label,
			check: { kind: "tier", expect: x.label },
		}));
}

// ---------------------------------------------------------------- (f) long-context
const VAULTS = [
	"amber-falcon",
	"silent-river",
	"copper-moth",
	"north-gate",
	"velvet-oak",
	"iron-heron",
	"lunar-fern",
	"quiet-ember",
	"polar-wren",
	"cobalt-pine",
	"misty-lynx",
	"solar-reed",
];
const F_SIZES = [8000, 12000, 16000, 24000, 30000];
const KEY_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function genF(): Task[] {
	const r = rng(`${SEED}/f`);
	return Array.from({ length: CLASSES.f.sealedN }, (_, i) => {
		const target = F_SIZES[i % F_SIZES.length] as number;
		const chars = Math.round(target * CHARS_PER_TOK_LOG);
		const lines: string[] = [];
		let len = 0;
		while (len < chars) {
			const l = `2026-${pad(ri(r, 1, 12), 2)}-${pad(ri(r, 1, 28), 2)}T${pad(ri(r, 0, 23), 2)}:${pad(ri(r, 0, 59), 2)}:${pad(ri(r, 0, 59), 2)}Z host-${ri(r, 1, 40)} svc=${pick(r, ["billing", "auth", "search", "media", "ledger", "notify", "export", "gateway"])} user=u${ri(r, 1000, 9999)} req=${hex8(r)} status=${pick(r, ["ok", "ok", "ok", "retry", "error"])} latency_ms=${ri(r, 3, 900)}`;
			lines.push(l);
			len += l.length + 1;
		}
		const [v1, v2] = shuffle(r, VAULTS).slice(0, 2) as [string, string];
		const key = () =>
			`${strOf(r, KEY_ALPHA, 4, 4)}-${strOf(r, KEY_ALPHA, 4, 4)}`;
		const k1 = key();
		const k2 = key();
		const d1 = 0.1 + r() * 0.8;
		const d2 = 0.1 + r() * 0.8;
		// the needle log level is sealed task data, not a code annotation
		// qlty-ignore: ripgrep
		const needle = (v: string, k: string) =>
			`NOTE vault=${v} rotation_key=${k}`;
		lines.splice(Math.floor(lines.length * d1), 0, needle(v1, k1));
		lines.splice(Math.floor(lines.length * d2), 0, needle(v2, k2));
		const ask = (v: string) =>
			`What is the rotation_key recorded for vault "${v}"? Reply with the key only.`;
		return {
			id: `f${pad(i)}`,
			doc: lines.join("\n"),
			q1: ask(v1),
			q2: ask(v2),
			check: { kind: "needle", expect: k1 },
			check2: { kind: "needle", expect: k2 },
			meta: {
				target_tokens: target,
				depth1: +d1.toFixed(2),
				depth2: +d2.toFixed(2),
			},
		};
	});
}

export const GENS: Record<ClassId, () => Task[]> = {
	a: genA,
	b: genB,
	c: genC,
	d: genD,
	e: genE,
	f: genF,
};
export { TIERS };
