#!/usr/bin/env bun
// dashboard.ts — belt fleet status board: one JSON endpoint + one small page.
// All data derives from registry.ts (single source of truth) and the same
// liveness probes swarm.ts/coordinator.ts use. GET / serves an embedded page
// (vanilla JS, auto-refresh 3s); GET /api/status is the JSON behind it. On
// boot the dashboard advertises itself on the LAN via dns-sd as belt.local.
// Page styling follows the threads.dk instrument spec: warm near-black
// ground, mono throughout, one rust accent, rows not cards.
//
// Usage:
//   bun dashboard.ts                  — serve on :7791 (env BELT_PORT overrides)
//   curl 127.0.0.1:7791/api/status    — raw snapshot

import { existsSync, readFileSync } from "node:fs";
import { SPECIALISTS, DOWNLOAD_MODELS } from "./registry.ts";
import {
	checkAll,
	discover,
	tailRoutes,
	type CheckRow,
	type RouteLogEntry,
} from "./remotes.ts";

const HOME = process.env.HOME;
const LOG_DIR = `${HOME}/.claude-insights`;
const PREFS = `${HOME}/.claude/local-llm/prefs.json`;
const ROUTING_LOG = `${LOG_DIR}/swarm-routing.log`;
const PORT = Number(process.env.BELT_PORT ?? 7791);

const readPrefs = (): Record<string, unknown> => {
	try {
		return existsSync(PREFS)
			? (JSON.parse(readFileSync(PREFS, "utf8")) as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
};

// ─── liveness — same probes as swarm.ts / coordinator.ts ───
const isUp = async (port: number): Promise<boolean> => {
	try {
		// Any HTTP response = listening. The router (:4000) answers 404 on
		// /v1/models by design — it only implements Anthropic /v1/messages.
		await fetch(`http://localhost:${port}/v1/models`, {
			signal: AbortSignal.timeout(1000),
		});
		return true;
	} catch {
		return false;
	}
};

const getModel = async (port: number): Promise<string> => {
	try {
		const r = await fetch(`http://localhost:${port}/v1/models`, {
			signal: AbortSignal.timeout(1000),
		});
		const j = (await r.json()) as { data?: { id?: string }[] };
		return j.data?.[0]?.id ?? "?";
	} catch {
		return "down";
	}
};

// mlx_lm /v1/models lists the whole HF cache (first id ≠ served model) —
// verify the actually-loaded model from the process args instead.
const psModel = (port: number): string | null => {
	const pid = Bun.spawnSync(["lsof", "-ti", `:${port}`])
		.stdout.toString()
		.trim()
		.split("\n")[0];
	if (!pid) return null;
	const cmd = Bun.spawnSync([
		"ps",
		"-o",
		"command",
		"-p",
		pid,
	]).stdout.toString();
	return cmd.match(/--model\s+(\S+)/)?.[1] ?? null;
};

// ─── status snapshot ───
async function status() {
	const router = { up: await isUp(4000), port: 4000 };

	// Probe every registry port in parallel; remember which models are live so
	// "available to load" = DOWNLOAD_MODELS minus whatever is currently served.
	const served = new Set<string>();
	const specialists = await Promise.all(
		SPECIALISTS.map(async (s) => {
			const up = await isUp(s.port);
			let model_served: string | null = null;
			if (up) {
				model_served =
					s.engine === "rapid"
						? await getModel(s.port)
						: (psModel(s.port) ?? null);
				if (model_served && model_served !== "?") served.add(model_served);
			}
			return {
				port: s.port,
				label: s.label,
				role: s.role,
				model: s.model,
				tier: s.tier,
				engine: s.engine ?? "mlx_lm",
				ram_gb: s.ram_gb,
				up,
				model_served,
			};
		}),
	);

	const available = DOWNLOAD_MODELS.filter((m) => !served.has(m));
	const ram = {
		resident_gb: specialists
			.filter((s) => s.up)
			.reduce((a, s) => a + s.ram_gb, 0),
		total_note: "128GB unified memory",
	};

	const prefs = readPrefs();
	const raw = existsSync(ROUTING_LOG)
		? readFileSync(ROUTING_LOG, "utf8").trim()
		: "";
	const routing_tail = raw ? raw.split("\n").slice(-12) : [];

	return {
		router,
		specialists,
		ram,
		prefs,
		routing_tail,
		available,
		ts: new Date().toISOString(),
	};
}

// ─── remotes / multi-machine — static remotes.json + DNS-SD ads ───
interface RemotesSnapshot {
	rows: (CheckRow & { fastest_for: string[] })[];
	discovered: { name: string; host: string; port: number }[];
	cloud_fallback: boolean;
	mode: string;
	routes: RouteLogEntry[];
	ts: string;
}

const REMOTES_TTL_MS = 20_000;

async function buildRemotes(): Promise<RemotesSnapshot> {
	const rows = await checkAll();
	const byRow = new Map<CheckRow, string[]>();
	for (const role of new Set(rows.flatMap((r) => r.roles))) {
		const live = rows.filter((r) => r.ok && r.roles.includes(role));
		if (!live.length) continue;
		const best = live.reduce((a, b) => (b.ms < a.ms ? b : a));
		byRow.set(best, [...(byRow.get(best) ?? []), role]);
	}
	const prefs = readPrefs();
	return {
		rows: rows.map((r) => ({ ...r, fastest_for: byRow.get(r) ?? [] })),
		discovered: discover(),
		cloud_fallback: prefs.allow_cloud === true,
		mode: typeof prefs.cost_speed === "string" ? prefs.cost_speed : "balanced",
		routes: tailRoutes(8),
		ts: new Date().toISOString(),
	};
}

let remotesCache: RemotesSnapshot | null = null;
let remotesPending: Promise<RemotesSnapshot> | null = null;

/** Cached remotes snapshot — probes can be slow (dead host: 4s timeout each),
 *  so /api/remotes serves fresh-enough state instead of blocking every call. */
const remotesSnapshot = (): Promise<RemotesSnapshot> => {
	const fresh =
		remotesCache && Date.now() - Date.parse(remotesCache.ts) < REMOTES_TTL_MS;
	if (fresh && remotesCache) return Promise.resolve(remotesCache);
	if (!remotesPending) {
		remotesPending = buildRemotes()
			.then((snap) => {
				remotesCache = snap;
				return snap;
			})
			.finally(() => {
				remotesPending = null;
			});
	}
	return remotesPending;
};

// ─── page — embedded, no frameworks, no external assets (works offline) ───
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>belt — local LLM fleet</title>
<style>
:root { color-scheme: dark; --ground:#191614; --panel:#201d1a; --text:#e8e2d9; --mut:#8a857e;
  --rust:#e05a2b; --ok:#4a7c4e; --hair:rgba(232,226,217,.12); --track:rgba(255,255,255,.08);
  --rust-mark:#e05a2b; }
* { box-sizing: border-box; }
body { background:var(--ground); color:var(--text); font:12.5px/1.5 ui-monospace,Menlo,Consolas,monospace; margin:0; padding:18px 22px 26px; }
header { display:flex; align-items:baseline; gap:10px; margin-bottom:6px; }
header .mark { font-weight:700; font-size:13px; }
header .sub { color:var(--mut); font-size:11px; }
header .right { margin-left:auto; display:flex; align-items:center; gap:8px; font-size:11px; color:var(--mut); font-variant-numeric:tabular-nums; }
.dot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--rust); }
.blink { animation:blip 1s steps(1,end) infinite; }
@keyframes blip { 0%{opacity:1} 50%{opacity:.15} 100%{opacity:1} }
h2 { font-size:10px; font-weight:400; text-transform:uppercase; letter-spacing:.14em; color:var(--mut); margin:20px 0 2px; }
table { width:100%; border-collapse:collapse; }
th { text-align:left; font-weight:400; font-size:10px; text-transform:uppercase; letter-spacing:.14em; color:var(--mut); padding:8px 8px 6px 0; border-bottom:1px solid var(--hair); }
td { padding:9px 8px 9px 0; border-bottom:1px solid var(--hair); font-size:12.5px; }
td.r, th.r { text-align:right; padding-right:0; }
td .u { color:var(--mut); }
td.model { word-break:break-word; }
td .mut, .mut { color:var(--mut); }
.ok { color:var(--ok); }
.scroll { overflow-x:auto; }
.bar { height:3px; background:var(--track); border-radius:2px; overflow:hidden; }
.bar i { display:block; height:100%; width:0; background:#6f6a63; }
.bar i.hot { background:var(--rust); }
.memrow { display:flex; align-items:baseline; gap:10px; margin:6px 0 14px; }
.memrow .n { margin-left:auto; color:var(--mut); font-variant-numeric:tabular-nums; }
.mrow { display:grid; grid-template-columns:1fr 64px; gap:10px; align-items:baseline; max-width:560px; margin:8px 0 4px; font-size:11px; }
.mrow .n { text-align:right; color:var(--mut); font-variant-numeric:tabular-nums; }
.chip { display:inline-block; border:1px solid var(--hair); border-radius:2px; padding:2px 8px; font-size:11px; color:var(--mut); margin:6px 6px 0 0; background:transparent; }
.rhead { display:flex; align-items:center; margin:6px 0 0; }
.rhead button { margin-left:auto; }
button { border:1px solid var(--hair); border-radius:2px; background:transparent; color:var(--mut); font:inherit; font-size:11px; padding:2px 10px; cursor:pointer; letter-spacing:.04em; }
button:hover { color:var(--text); border-color:var(--rust); }
.badge { display:inline-block; border:1px solid var(--hair); border-radius:2px; padding:0 6px; font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--mut); }
.badge.immich { color:var(--rust); border-color:rgba(224,90,43,.5); }
.fast { color:var(--ok); }
#remoteslog { font-size:11px; line-height:1.75; color:var(--mut); white-space:pre-wrap; word-break:break-word; margin:4px 0 0; }
#log { font-size:11px; line-height:1.75; color:var(--mut); white-space:pre-wrap; word-break:break-word; margin:4px 0 0; }
#prefsline { margin-top:12px; font-size:11px; color:var(--mut); }
footer { border-top:1px solid var(--hair); margin-top:22px; padding-top:12px; display:flex; align-items:center; font-size:11px; color:var(--mut); }
footer .right { margin-left:auto; font-size:10px; letter-spacing:.14em; text-transform:uppercase; }
threads-mark { vertical-align:middle; margin:0 3px 0 0; }
.empty { color:var(--mut); margin:8px 0 0; }
</style></head>
<body>
<style>
#klh-topbar{display:flex;gap:1.1em;align-items:center;padding:.4em 1em;border-bottom:1px solid #232326;background:rgba(10,10,12,.6);font:500 12px/1.4 -apple-system,sans-serif;letter-spacing:.02em}
#klh-topbar .tb-brand{color:#6b6b70;text-transform:uppercase;font-size:10px;letter-spacing:.12em}
#klh-topbar a{color:#8ab4ff;text-decoration:none}
#klh-topbar a.down{opacity:.35}
</style>
<div id="klh-topbar">
  <span class="tb-brand">klh fleet</span>
  <a class="tb-link" data-probe="https://belt.local" data-repo="https://github.com/klh/belt" href="https://belt.local">belt</a>
  <a class="tb-link" data-probe="https://suspenders.local" data-repo="https://github.com/klh/suspenders" href="https://suspenders.local">suspenders</a>
  <a class="tb-link" data-probe="https://bar.local" data-repo="https://klh/local" href="https://bar.local">local</a>
</div>
<script>
(function () {
  var probe = function () {
    var links = document.querySelectorAll("#klh-topbar .tb-link");
    for (var i = 0; i < links.length; i++) {
      (function (a) {
        var url = a.getAttribute("data-probe");
        fetch(url + "/ping", { mode: "no-cors", cache: "no-store" })
          .then(function () {
            a.classList.remove("direct");
            a.classList.add("direct");
            a.classList.remove("down");
            a.href = url;
          })
          .catch(function () {
            a.classList.remove("direct");
            a.classList.add("down");
            a.href = a.getAttribute("data-repo");
          });
      })(links[i]);
    }
  };
  probe();
  setInterval(probe, 5000);
})();
</script>

<header><span class="mark">belt</span><span class="sub">local LLM fleet</span>
  <span class="right"><i class="dot blink" id="live"></i><span id="clockbox">—</span></span></header>
<h2>Fleet</h2>
<div class="scroll"><table id="fleet"></table></div>
<h2>Memory</h2>
<div class="memrow"><span class="mut">resident</span><span class="n" id="memnum">—</span></div>
<div class="bar"><i id="memfill"></i></div>
<div id="models"></div>
<h2>Available</h2>
<div id="avail"></div>
<h2>Routing log</h2>
<div id="log">—</div>
<h2>Remotes — multi-machine</h2>
<div class="rhead"><span id="remotesnote" class="mut">loading…</span><button id="remotesbtn" type="button">refresh</button></div>
<div class="scroll"><table id="remotes"></table></div>
<div id="remotesdisc"></div>
<div id="remoteslog"></div>
<div id="prefsline"></div>
<footer><span>a <threads-mark size="20" transparent></threads-mark> Threads thing</span>
  <span class="right">belt.local:7791 · refresh 3s</span></footer>
<script src="/threads-mark.js"></script>
<script>
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
function short(m){return String(m||'').replace('mlx-community/','');}
function age(iso,now){
  if(!iso)return '—';
  var t=Math.max(0,(now-Date.parse(iso))/1000);
  if(t<3600)return Math.max(1,Math.round(t/60))+'m';
  if(t<86400)return Math.round(t/3600)+'h';
  return Math.round(t/86400)+'d';
}
function hhmmss(ts){
  var d=new Date(ts),p=function(n){return (n<10?'0':'')+n;};
  return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
}
function fmt(line){
  try{var e=JSON.parse(line);
    return e.ts.slice(11,19)+'  '+e.category+'  '+short(e.model)+'  :'+e.port+'  '+e.duration_ms+'ms  '+e.tier+(e.escalated?'  cloud':'');
  }catch(_){return line;}
}
function tick(){
  fetch('/api/status').then(function(r){return r.json();}).then(function(s){
    var now=Date.parse(s.ts);
    clockbox.textContent=hhmmss(s.ts);
    live.className='dot blink';
    var last={};
    s.routing_tail.slice().reverse().forEach(function(l){
      try{var e=JSON.parse(l); if(e.port!=null&&!(e.port in last))last[e.port]=e.ts;}catch(_){}
    });
    var rows=[{port:4000,model:'router — anthropic shim',role:'router',engine:'bun',ram_gb:null,model_served:null,up:s.router.up}]
      .concat(s.specialists);
    fleet.innerHTML='<tr><th>port</th><th>model</th><th>role</th><th>engine</th>'
      +'<th class="r">ram</th><th>state</th><th class="r">last used</th></tr>'
      +rows.map(function(x){
        var st=x.up?'<span class="ok">loaded</span>':'<span class="mut">offline</span>';
        var ram=x.ram_gb==null?'<span class="mut">—</span>':'<span>'+x.ram_gb+'</span> <span class="u">GB</span>';
        return '<tr><td>:'+x.port+'</td><td class="model">'+esc(short(x.model_served||x.model))
          +'</td><td class="mut">'+esc(x.role||'')+'</td><td class="mut">'+esc(x.engine||'—')
          +'</td><td class="r">'+ram+'</td><td>'+st+'</td><td class="r mut">'+age(last[x.port],now)+'</td></tr>';
      }).join('');
    var pct=s.ram.resident_gb/128*100;
    memfill.style.width=Math.min(100,pct)+'%';
    memfill.className=pct>80?'hot':'';
    memnum.textContent=s.ram.resident_gb.toFixed(1)+' / 128 GB unified memory';
    models.innerHTML=s.specialists.filter(function(x){return x.up;}).map(function(x){
      return '<div class="mrow"><span>'+esc(short(x.model_served||x.model))+'</span><span class="n">'+x.ram_gb+' GB</span></div>'
        +'<div class="bar"><i style="width:'+(x.ram_gb/128*100)+'%"></i></div>';
    }).join('');
    avail.innerHTML=s.available.length
      ?s.available.map(function(m){return '<span class="chip">'+esc(short(m))+'</span>';}).join('')
      :'<p class="empty">All registry models resident.</p>';
    log.textContent=s.routing_tail.length?s.routing_tail.map(fmt).join('\\n'):'No requests logged yet.';
    prefsline.textContent='mode '+(s.prefs.cost_speed||'balanced')
      +' · cloud '+(s.prefs.allow_cloud?'on':'off')
      +' · profile: '+((s.prefs.profile||[]).join(', ')||'—');
  }).catch(function(){
    clockbox.textContent='—';
    live.className='dot';
  });
}
tick();setInterval(tick,3000);
</script>
<script>
function tickRemotes(){
  fetch('/api/remotes').then(function(r){return r.json();}).then(function(s){
    var rows=s.rows||[];
    remotes.innerHTML=rows.length
      ?'<tr><th>machine</th><th>endpoint</th><th>protocol</th><th>roles</th><th>model</th><th>state</th><th class="r">latency</th></tr>'
       +rows.map(function(x){
        var st=x.ok?'<span class="ok">up</span>':'<span class="mut">down</span>';
        var fast=(x.fastest_for||[]).map(function(r){return '<span class="fast">fastest '+esc(r)+'</span>';}).join(' ');
        var lat=x.ok?x.ms+'ms':'<span class="mut">—</span>';
        return '<tr><td>'+esc(x.machine)+'</td>'
          +'<td>'+esc(x.host)+':'+x.port+'</td>'
          +'<td><span class="badge '+esc(x.protocol)+'">'+esc(x.protocol)+'</span></td>'
          +'<td class="mut">'+esc((x.roles||[]).join(', ')||'—')+'</td>'
          +'<td class="mut">'+esc(x.model||'—')+'</td>'
          +'<td>'+st+' '+fast+'</td>'
          +'<td class="r">'+lat+'</td></tr>';
      }).join('')
      :'<p class="empty">No remote machines — add ~/.claude/local-llm/remotes.json (remotes.example.json shows the shape).</p>';
    var disc=s.discovered||[];
    remotesdisc.innerHTML=disc.length
      ?disc.map(function(d){return '<span class="chip">'+esc(d.name)+'.local <span class="u">discovered · not configured</span></span>';}).join('')
      :'';
    var routes=s.routes||[];
    remoteslog.textContent=routes.length
      ?routes.map(function(e){
        return e.ts.slice(11,19)+'  '+e.role+'  →  '+e.machine+' ('+e.endpoint+', '+e.protocol+')  '+e.duration_ms+'ms'+(e.ok?'':'  FAILED');
      }).join('\\n')
      :'No remote routes yet — bun bin/remotes.ts route <role> <prompt>.';
    remotesnote.textContent='LAN-local, routed for SPEED — not cost · cloud fallback '
      +(s.cloud_fallback?'on':'off')+' · '+s.mode+' mode · auto-refresh 30s';
  }).catch(function(){remotesnote.textContent='remotes: unreachable';});
}
tickRemotes();setInterval(tickRemotes,30000);
remotesbtn.onclick=function(){remotesbtn.disabled=true;tickRemotes();setTimeout(function(){remotesbtn.disabled=false;},600);};
</script>
</body></html>`;

// ─── llms.txt — static description for LLM crawlers/agents ───
const LLMS = `# belt

Local MLX specialist fleet for macOS (Apple Silicon). A swarm of small models
served on localhost ports, fronted by a deterministic keyword router. No
requests leave the machine unless cloud fallback is enabled.

## Ports

- :4000  router — Anthropic-compatible /v1/messages shim in front of the fleet (cloud fallback configurable via prefs)
- :8901  code — Qwen3-Coder-30B-A3B-Instruct-4bit, 16 GB RAM, resident
- :8902  extract — Qwen3-4B-Instruct-2507-4bit, 2 GB, resident
- :8903  reason — Qwen3.5-35B-A3B-4bit, 20 GB, resident
- :8906  danish/general — Qwen3.5-9B-MLX-4bit, 5.6 GB, on-demand
- :8912  kev — jaredpalmer/kev-4b typed-question classifier, ~8 GB, resident (external, via ~/dev/kev)
- :8913  rerank — Qwen3-Reranker-0.6B-4bit, 1 GB, resident
- :8907  embeddings — context-rag embed_server.py, started on demand (not part of belt)
- :7791  this dashboard (GET / page, GET /api/status JSON snapshot)

## Machine-readable status

GET /api/status on this port returns JSON: per-port liveness, the model each
port is actually serving, resident RAM, available (downloaded, not loaded)
models, routing-log tail, current prefs.

GET /api/remotes on this port returns JSON: every static multi-machine
endpoint (~/.claude/local-llm/remotes.json) with live health + probe latency,
the fastest endpoint per routing role, DNS-SD discovered _klh-llm._tcp
advertisements, recent remote routes, and the cloud-vs-local posture.

## Notes

- Agent backend: belt provides local model endpoints for agent clients.
  Use the specialists' OpenAI-compatible API or the router's Anthropic API
  according to the client's supported protocol. suspenders provides the
  agent control plane (sessions, claims, work graph, and fleet board).
- BELT_TIER=minimal scopes the resident fleet to models with ram_gb <= 4
  (:8902 + :8913) — the fleet a 16 GB machine holds. A filter, not a variant.
- Specialists speak OpenAI-compatible /v1/chat/completions (rapid-mlx /
  mlx_lm servers). The router speaks Anthropic /v1/messages.
- Source: https://github.com/klh/belt
- A Threads thing — http://www.threads.dk
`;

// ─── server ───
const json = (x: unknown): Response =>
	new Response(JSON.stringify(x, null, 2), {
		headers: { "content-type": "application/json" },
	});

Bun.serve({
	port: PORT,
	hostname: "0.0.0.0",
	async fetch(req): Promise<Response> {
		const path = new URL(req.url).pathname;
		if (path === "/api/status") return json(await status());
		if (path === "/api/remotes") return json(await remotesSnapshot());
		if (path === "/")
			return new Response(PAGE, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		if (path === "/llms.txt")
			return new Response(LLMS, {
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		if (path === "/threads-mark.js")
			return new Response(Bun.file(`${import.meta.dir}/threads-mark.js`), {
				headers: { "content-type": "text/javascript; charset=utf-8" },
			});
		return new Response("not found\n", { status: 404 });
	},
});

// ─── LAN advertisement: Bonjour "belt" + the belt.local A record ───
// -P (register proxy) is the dns-sd mode that also creates the belt.local
// host record, so the name resolves from other LAN devices. The plain -R
// with "belt.local" as the DOMAIN arg registers into a bogus domain and
// never appears in .local browse (measured 2026-09-28). dns-sd runs under a
// sh intermediary that stays its parent — as a direct Bun child it lives
// but never completes registration. "Name conflicts" from a lingering
// previous registration is expected and harmless (output goes to the log).
try {
	Bun.spawnSync(["/usr/bin/pkill", "-f", "dns-sd -R belt"]);
} catch {}
try {
	Bun.spawnSync(["/usr/bin/pkill", "-f", "dns-sd -P belt "]);
} catch {}
let lanIp = "";
try {
	lanIp = Bun.spawnSync(["/usr/sbin/ipconfig", "getifaddr", "en0"])
		.stdout.toString()
		.trim();
} catch {}
const mdnsCmd = lanIp
	? `/usr/bin/dns-sd -P belt _http._tcp local ${PORT} belt.local ${lanIp} >> ${LOG_DIR}/belt-mdns.log 2>&1`
	: `/usr/bin/dns-sd -R belt _http._tcp local ${PORT} >> ${LOG_DIR}/belt-mdns.log 2>&1`;
const mdns = Bun.spawn(["/bin/sh", "-c", mdnsCmd], {
	stdin: "ignore",
	stdout: "ignore",
	stderr: "ignore",
});
mdns.unref();

console.log(
	`belt dashboard → http://127.0.0.1:${PORT} · LAN: http://belt.local:${PORT}`,
);
