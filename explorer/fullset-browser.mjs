import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const port = 9337, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8771", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await sleep(800);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chrome-"));
const chrome = spawn("chromium", ["--headless=new", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--disable-crash-reporter", `--crash-dumps-dir=${profile}`, "--window-size=1500,1000",
  "--js-flags=--expose-gc", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find((x) => x.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (p) { pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:8771/explorer/" });
for (let i = 0; i < 200; i++) { await sleep(500); if (await ev(`document.querySelectorAll('#grid tbody tr:not(.pad)').length > 0`).catch(() => false)) break; }
await sleep(1500);

// reach into the module: the app exposes the map; grab the db via a fresh Facetful on the same image? No —
// instead drive the existing worker by re-importing sql.js and using the page's own module instance.
await ev(`(async () => {
  const m = await import('./sql.js');
  window.__sql = m;
  return Object.keys(m).length;
})()`);
console.log("sql module loaded:", await ev(`Object.keys(window.__sql).length`));
console.log("db present:", await ev(`typeof window.__db`), "| map:", await ev(`typeof window.__plantMap`), "| open-info:", await ev(`document.getElementById('open-info').textContent.slice(0,60)`));

console.log(await ev(`(async () => {
  const db = window.__db, out = {};
  const q = async (limit) => {
    const sql = window.__sql.gridSql(new Map(), ['twh','desc'], { limit });
    const t0 = performance.now();
    const r = await db.query(sql, { table: 'gw' });
    return [Math.round(performance.now() - t0), r];
  };
  let [ms, r] = await q(100);
  out.page100_queryMs = ms;
  [ms, r] = await q(42257);
  out.full_queryAndTransferMs = ms;
  out.rows = r.rowCount; out.cols = r.columns.length;
  let t0 = performance.now();
  const raw = r.columnRaw('gen_2020');
  out.columnRaw_oneColumnMs = Math.round(performance.now() - t0);
  t0 = performance.now();
  let bytes = 0;
  for (const c of r.columns) { const x = r.columnRaw(c.name); bytes += (x.values?.byteLength ?? 0) + (x.bytes?.byteLength ?? 0) + (x.offsets?.byteLength ?? 0); }
  out.columnRaw_allColumnsMs = Math.round(performance.now() - t0);
  out.bufferMB = Math.round(bytes / 1e5) / 10;
  t0 = performance.now();
  const all = [...r.rows()];
  out.materialise_rowObjectsMs = Math.round(performance.now() - t0);
  out.firstPlant = all[0].plant_name_eia;
  if (performance.memory) out.heapMB = Math.round(performance.memory.usedJSHeapSize / 1e6);
  return out;
})()`));
chrome.kill(); server.kill(); try { (await import("node:fs")).rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
