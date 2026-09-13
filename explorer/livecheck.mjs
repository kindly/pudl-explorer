// Does the deployed site actually boot and render, not just serve the right files?
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const URL_ = process.argv[2] ?? "https://kindly.github.io/pudl-explorer/explorer/";
const port = 9352, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chrome-"));
const chrome = spawn("chromium", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--disable-crash-reporter", `--crash-dumps-dir=${profile}`, "--window-size=1600,1000",
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find((x) => x.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") errs.push(m.params.exceptionDetails.exception?.description?.split("\n")[0] ?? "?");
  const p = pend.get(m.id); if (p) { pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
await send("Page.enable"); await send("Runtime.enable");
console.log("loading", URL_);
await send("Page.navigate", { url: URL_ });
let ok = false;
for (let i = 0; i < 240; i++) { await sleep(500); if (await ev(`document.querySelectorAll('#grid .grow:not([hidden])').length > 0`).catch(() => false)) { ok = true; break; } }
await sleep(1500);
const out = await ev(`({
  build: (document.querySelector('script[src*="app.js"]')||{}).src || '',
  rows: document.querySelectorAll('#grid .grow:not([hidden])').length,
  first: (document.querySelector('#grid .grow:not([hidden])')||{}).innerText?.replace(/\\s+/g,' ').slice(0,70),
  totals: [...document.querySelectorAll('#totals .total')].map(t=>t.textContent.trim().replace(/\\s+/g,' ')).join(' | '),
  open: (document.querySelector('#open-info')||{}).textContent,
  stale: !!document.querySelector('.stale-shell'),
  facets: document.querySelectorAll('.facet').length,
})`);
console.log(JSON.stringify(out, null, 2));
if (errs.length) { console.log("page errors:"); errs.slice(0,4).forEach(e => console.log("  " + e)); }
const bad = !ok || out.rows === 0 || out.stale || errs.length;
console.log(bad ? "\nLIVE SITE PROBLEM" : "\nlive site boots and renders");
chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(bad ? 1 : 0);
