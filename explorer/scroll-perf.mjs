import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const port = 9335, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8769", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await sleep(800);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chrome-"));
const chrome = spawn("chromium", ["--headless=new", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--disable-crash-reporter", `--crash-dumps-dir=${profile}`, "--window-size=1500,1000",
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });

// Clean up however this run ends. Cleanup used to sit only on the success path, so a failing
// assertion left the profile directory and the headless browser behind; enough runs filled /tmp
// and left orphaned browsers resident.
const cleanUp = () => {
  try { chrome.kill(); } catch {}
  try { server?.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on("exit", cleanUp);
process.on("SIGINT", () => process.exit(130));
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });

let targets;
for (let i = 0; i < 60; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "fail"); return r.result.value; };
await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:8769/explorer/" });
for (let i = 0; i < 200; i++) { await sleep(500); if (await ev(`document.querySelectorAll('#grid tbody tr:not(.pad)').length > 0`).catch(() => false)) break; }
await sleep(2500);   // let the background full-set fetch land

// instrument: wrap the scroll path and count queries + measure DOM work
await ev(`(() => {
  window.__m = { queries: 0, paints: [], rowBuilds: [] };
  const s = document.querySelector('#grid .scroller');
  const obs = new MutationObserver(() => {});
  // measure a full tbody rebuild by timing a forced reflow after each mutation batch
  const tb = document.querySelector('#grid tbody');
  const orig = tb.replaceChildren.bind(tb);
  tb.replaceChildren = function (...args) {
    const t0 = performance.now();
    orig(...args);
    void tb.offsetHeight;               // force layout so the cost is real
    window.__m.paints.push(performance.now() - t0);
    window.__m.rowBuilds.push(args.length - 2);
  };
  return true;
})()`);

console.log("rows in DOM:", await ev(`document.querySelectorAll('#grid tbody tr:not(.pad)').length`),
  "| whole result in memory:", await ev(`!!window.__gridAll`));

// A realistic scrollbar drag: many scroll events over ~700 ms, then release and wait.
async function drag(fromFrac, toFrac, steps = 30) {
  await ev(`window.__m.paints = []; window.__m.rowBuilds = []; window.__m.queries = 0; true`);
  const t0 = Date.now();
  for (let i = 1; i <= steps; i++) {
    const f = fromFrac + (toFrac - fromFrac) * (i / steps);
    await ev(`(() => { const s = document.querySelector('#grid .scroller'); s.scrollTop = s.scrollHeight * ${f}; return true; })()`);
    await sleep(22);
  }
  const released = Date.now() - t0;
  let settled = -1;
  for (let i = 0; i < 160; i++) {
    await sleep(40);
    const ok = await ev(`(() => {
      const s = document.querySelector('#grid .scroller');
      const want = Math.floor(s.scrollTop / 25);
      const trs = [...document.querySelectorAll('#grid tbody tr:not(.pad)')];
      if (!trs.length) return false;
      const sb = s.getBoundingClientRect();
      return trs.some(tr => { const b = tr.getBoundingClientRect(); return b.bottom > sb.top && b.top < sb.bottom; });
    })()`);
    if (ok) { settled = Date.now() - t0 - released; break; }
  }
  const m = await ev(`({ paints: window.__m.paints.map(x => Math.round(x)), rows: window.__m.rowBuilds,
                        shown: document.querySelector('#grid .count').textContent.match(/rows ([\\d,]+)/)?.[1],
                        at: Math.floor(document.querySelector('#grid .scroller').scrollTop / 25) + 1 })`);
  console.log(`drag ${(fromFrac*100).toFixed(0)}%→${(toFrac*100).toFixed(0)}%: rows visible ${String(settled).padStart(4)} ms after release · viewport row ${String(m.at).padStart(6)}, window at ${String(m.shown).padStart(6)} · ${m.paints.length} tbody rebuilds ${JSON.stringify(m.paints)} ms`);
}
await drag(0.0, 0.45);
await drag(0.45, 0.92);
await drag(0.92, 0.10);
await drag(0.10, 0.55);
// and a slow continuous scroll, the sentinel path
await ev(`window.__m.paints = []; true`);
{
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) { await ev(`document.querySelector('#grid .scroller').scrollBy(0, 400); true`); await sleep(30); }
  await sleep(600);
  const m = await ev(`({ paints: window.__m.paints.map(x => Math.round(x)), shown: document.querySelector('#grid .count').textContent })`);
  console.log(`continuous scroll (40 × 400px): ${Date.now() - t0} ms, ${m.paints.length} rebuilds, worst ${Math.max(...m.paints, 0)} ms · ${m.shown}`);
}
chrome.kill(); server.kill(); try { (await import("node:fs")).rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
