// Does the viewport ever show blank while scrolling fast? Sample every frame during a hard drag.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const port = 9338, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8772", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
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
await send("Page.enable"); await send("Runtime.enable"); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.method === "Runtime.consoleAPICalled") console.log("  [page]", m.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0,120)); });
await ev(`window.__errs=[]; window.addEventListener("error", e => window.__errs.push(e.message)); true`).catch(()=>{});
await send("Page.navigate", { url: "http://127.0.0.1:8772/explorer/" });
for (let i = 0; i < 200; i++) { await sleep(500); if (await ev(`document.querySelectorAll('#grid tbody tr:not(.pad)').length > 0`).catch(() => false)) break; }
await sleep(2500);
console.log("PAGE ERRORS:", await ev(`(window.__errs||[]).join(" | ")`));
console.log("whole result in memory:", await ev(`!!window.__gridAll`), "| pool rows:", await ev(`document.querySelectorAll('#grid tbody tr:not(.pad)').length`));

// Drive the scroller hard from inside the page and sample coverage every animation frame.
const r = await ev(`(async () => {
  const s = document.querySelector('#grid .scroller');
  const nextFrame = () => new Promise(r => requestAnimationFrame(r));
  const coverage = () => {
    const sb = s.getBoundingClientRect();
    let covered = 0;
    for (const tr of document.querySelectorAll('#grid tbody tr:not(.pad)')) {
      if (tr.hidden) continue;
      const b = tr.getBoundingClientRect();
      const top = Math.max(b.top, sb.top), bot = Math.min(b.bottom, sb.bottom);
      if (bot > top) covered += bot - top;
    }
    return 100 * covered / sb.height;
  };
  const max = s.scrollHeight - s.clientHeight;
  const behind = [];
  // 25 hard jumps across the whole list; count frames until the viewport is covered again
  for (let k = 1; k <= 25; k++) {
    s.scrollTop = max * (k / 26);
    let frames = 0;
    while (frames < 30) { await nextFrame(); frames++; if (coverage() >= 95) break; }
    behind.push(frames);
  }
  const sorted = [...behind].sort((a, b) => a - b);
  return { jumps: behind.length, framesBehind: behind, median: sorted[sorted.length >> 1], worst: Math.max(...behind),
           instant: behind.filter(f => f <= 1).length };
})()`);
console.log("frames until the viewport is covered after a hard jump:", r);
chrome.kill(); server.kill(); try { (await import("node:fs")).rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
