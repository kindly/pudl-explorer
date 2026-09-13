// The third sparkline must follow the measure, and be absent when the measure has no row series.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const port = 9347, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8781", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await sleep(700);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chrome-"));
const chrome = spawn("chromium", ["--headless=new", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--disable-crash-reporter", `--crash-dumps-dir=${profile}`, "--window-size=1800,1100",
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find((x) => x.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") errs.push(m.params.exceptionDetails.exception?.description ?? "?");
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push(m.params.args.map(a=>a.value).join(" "));
  const p = pend.get(m.id); if (p) { pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate", { url: "http://127.0.0.1:8781/explorer/" });
for (let i = 0; i < 300; i++) { await sleep(400); if (await ev(`document.querySelectorAll('#grid .grow:not([hidden])').length > 0`).catch(() => false)) break; }
await sleep(2000);

const probe = `(() => {
  const heads = [...document.querySelectorAll('#grid .ghead > span')].map(s => s.firstChild.textContent.trim());
  const sparks = heads.filter(h => /yearly$/.test(h));
  const row = document.querySelector('#grid .grow:not([hidden])');
  const cells = [...row.children];
  // two paths per sparkline (dimmed years, selected years); either may legitimately be empty
  const drawn = cells.filter(c => { const s = c.querySelector('svg.spark');
    return s && s.style.display !== 'none' && [...s.querySelectorAll('path')].some(p => (p.getAttribute('d') || '').length > 0); }).length;
  const tracks = getComputedStyle(document.getElementById('grid')).getPropertyValue('--grid-cols').trim().split(/\\s+/).length;
  return { heads, sparks, cols: cells.length, tracks, drawn };
})()`;

const expect = { twh: null, gw: "Capacity yearly", co2: "CO₂ yearly", co2_mwh: "CO₂ intensity yearly",
  co2_mw: "CO₂ per MW yearly", cost: "Fuel cost yearly", tbtu: "Fuel burned yearly", capex: null, opex_mwh: null };
let fail = 0;
for (const [mk, want] of Object.entries(expect)) {
  await ev(`(() => { const s = document.getElementById('measure'); s.value = ${JSON.stringify(mk)};
    s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(2200);
  const p = await ev(probe);
  const third = p.sparks[2] ?? null;
  const ok = third === want && p.cols === p.tracks && p.sparks.length === (want ? 3 : 2)
    && p.sparks[0] === "Generation yearly" && p.sparks[1] === "Capacity factor yearly";
  if (!ok) fail++;
  console.log(`${ok ? "  ok " : "FAIL "} ${mk.padEnd(9)} sparklines=${p.sparks.length} third=${third ?? "(none)"} cols=${p.cols} tracks=${p.tracks} drawn-in-row-1=${p.drawn}`);
}
// sorting by a column that only one measure has must survive switching away
await ev(`(() => { const s=document.getElementById('measure'); s.value='tbtu'; s.dispatchEvent(new Event('change')); return true; })()`);
await sleep(2000);
await ev(`[...document.querySelectorAll('#grid .ghead > span')].find(s=>s.textContent.trim().startsWith('TBtu')).click(); true`);
await sleep(1800);
const sortedBy = await ev(`new URLSearchParams(location.search).get('sort')`);
await ev(`(() => { const s=document.getElementById('measure'); s.value='twh'; s.dispatchEvent(new Event('change')); return true; })()`);
await sleep(2200);
const after = await ev(probe);
const rows = await ev(`document.querySelectorAll('#grid .grow:not([hidden])').length`);
const okSort = after.sparks.length === 2 && rows > 5;
if (!okSort) fail++;
console.log(`${okSort ? "  ok " : "FAIL "} sorted by ${sortedBy} then switched to generation: ${after.sparks.length} sparklines, ${rows} rows`);
if (errs.length) { console.log("\nconsole errors:"); errs.slice(0, 5).forEach((e) => console.log("  " + e.split("\n")[0])); fail += errs.length; }
console.log(fail ? `\n${fail} FAILURES` : "\nthe third sparkline follows the measure and vanishes when there is none");
chrome.kill(); server.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
