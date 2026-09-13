// Real wheel events go through the compositor, which scrolls without waiting for the main thread.
// That is the path a user takes and the one my earlier scrollTop tests never exercised.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const port = 9339, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8773", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await sleep(800);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chrome-"));
const chrome = spawn("chromium", ["--headless=new", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--disable-crash-reporter", `--crash-dumps-dir=${profile}`, "--window-size=1500,1000",
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find((x) => x.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (p) { pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:8773/explorer/" });
for (let i = 0; i < 200; i++) { await sleep(500); if (await ev(`document.querySelectorAll('#grid .grow:not([hidden])').length > 0`).catch(() => false)) break; }
await sleep(2500);
const box = await ev(`(() => { const r = document.getElementById('grid-scroller').getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), h: Math.round(r.height) }; })()`);
console.log("whole result in memory:", await ev(`!!window.__gridAll`), "| scroller", box.h, "px tall");

// start a sampler that records, every frame, how much of the viewport the painted rows actually cover
await ev(`(() => {
  window.__samples = [];
  const s = document.getElementById('grid-scroller');
  const tick = () => {
    // the row area is a sticky element: measure how much of the scrollport it actually covers
    const vp = document.querySelector('#grid .gviewport').getBoundingClientRect();
    const sb = s.getBoundingClientRect();
    const covered = Math.max(0, Math.min(vp.bottom, sb.bottom) - Math.max(vp.top, sb.top));
    window.__samples.push(Math.round(100 * covered / sb.height));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`);

for (const [label, delta, count, gap] of [["slow wheel", 120, 25, 60], ["fast wheel", 600, 30, 16], ["flick", 2000, 25, 8]]) {
  await ev(`window.__samples = []; document.getElementById('grid-scroller').scrollTop = 0; true`);
  await sleep(400);
  await ev(`window.__samples = []; true`);
  for (let i = 0; i < count; i++) {
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: delta });
    await sleep(gap);
  }
  await sleep(500);
  const s = await ev(`(() => { const a = window.__samples; const sorted = [...a].sort((x,y)=>x-y);
    return { frames: a.length, blankFrames: a.filter(v => v < 50).length, median: sorted[sorted.length>>1], worst: Math.min(...a) }; })()`);
  console.log(`${label.padEnd(11)} Δ${String(delta).padStart(4)}px ×${count}: ${String(s.frames).padStart(3)} frames, ${String(s.blankFrames).padStart(3)} more than half blank, median coverage ${s.median}%, worst ${s.worst}%`);
}
chrome.kill(); server.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
