import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const port = 9336, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8770", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
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

let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find((x) => x.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (p) { pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:8770/explorer/" });
for (let i = 0; i < 200; i++) { await sleep(500); if (await ev(`document.querySelectorAll('#grid tbody tr:not(.pad)').length > 0`).catch(() => false)) break; }
await sleep(2500);
// settle into the steady state a user reaches after scrolling a bit
await ev(`(() => { const s = document.getElementById('grid-scroller'); s.scrollTop = s.scrollHeight * 0.5; return true; })()`);
await sleep(1200);
for (let i = 0; i < 120; i++) { await ev(`document.getElementById('grid-scroller').scrollBy(0, 1500); true`); await sleep(35); }
await sleep(800);
console.log(await ev(`(() => {
  const s = document.getElementById('grid-scroller'), sb = s.getBoundingClientRect();
  const trs = [...document.querySelectorAll('#grid .grow:not([hidden])')];
  const visible = trs.filter(tr => { const b = tr.getBoundingClientRect(); return b.bottom > sb.top && b.top < sb.bottom; });
  const grid = document.getElementById('grid');
  return {
    rowsInDom: trs.length,
    growWidth: Math.round(document.querySelector('#grid .grow').getBoundingClientRect().width),
    scrollerWidth: Math.round(s.getBoundingClientRect().width),
    scrollWidth: document.getElementById('grid-scroller').scrollWidth,
    rowsVisible: visible.length,
    wasted: trs.length - visible.length,
    cellsInDom: grid.querySelectorAll('.grow > span').length,
    sparklineSvgs: grid.querySelectorAll('svg.spark').length,
    sparklinePaths: grid.querySelectorAll('svg.spark path').length,
    totalNodesInGrid: grid.querySelectorAll('*').length,
    scrollerHeightPx: Math.round(sb.height),
    rowHeightPx: Math.round(trs[0].getBoundingClientRect().height),
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
    wholeResultInMemory: !!window.__gridAll,
  };
})()`));
chrome.kill(); server.kill(); try { (await import("node:fs")).rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
