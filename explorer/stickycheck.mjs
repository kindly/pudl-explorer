// Both hold modes must keep the header and rows pinned to the top of the scroller while scrolling.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import "./stamp.mjs";   // assets carry a content hash; never serve an unstamped tree
const port = 9345, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8779", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await sleep(700);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chrome-"));
const chrome = spawn("chromium", ["--headless=new", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--disable-crash-reporter", `--crash-dumps-dir=${profile}`, "--window-size=430,900",
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
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });

const probe = `(() => {
  const s = document.getElementById('grid-scroller'), h = document.querySelector('#grid .ghead');
  const rows = [...document.querySelectorAll('#grid .grow')].filter(r => getComputedStyle(r).display !== 'none');
  const sb = s.getBoundingClientRect(), hb = h.getBoundingClientRect();
  const inside = rows.filter(r => { const b = r.getBoundingClientRect(); return b.top >= sb.top - 1 && b.bottom <= sb.bottom + 1; });
  return { drift: +(hb.top - sb.top).toFixed(1), vis: rows.length, inside: inside.length,
           mode: s.classList.contains('nosticky') ? 'transform' : 'sticky',
           left: Math.round(document.querySelector('#grid .grow > span.freeze').getBoundingClientRect().left - sb.left) };
})()`;

let fail = 0;
for (const [q, label] of [["", "sticky (default)"], ["?gridsticky=off", "transform (fallback)"]]) {
  await send("Page.navigate", { url: `http://127.0.0.1:8779/explorer/${q}` });
  for (let i = 0; i < 300; i++) { await sleep(400); if (await ev(`document.querySelectorAll('#grid .grow:not([hidden])').length > 0`).catch(() => false)) break; }
  await sleep(1500);
  let worstDrift = 0, minInside = 99, mode = "?", minVis = 99, lefts = new Set();
  for (let i = 0; i < 30; i++) {
    await ev(`document.getElementById('grid-scroller').scrollBy(0, ${250 + i * 173}); true`);
    await sleep(70);
    const p = await ev(probe);
    worstDrift = Math.max(worstDrift, Math.abs(p.drift));
    minInside = Math.min(minInside, p.inside); minVis = Math.min(minVis, p.vis); mode = p.mode; lefts.add(p.left);
  }
  // horizontal scroll must still work and the frozen column must stay put
  await ev(`document.getElementById('grid-scroller').scrollLeft = 400; true`); await sleep(200);
  const hz = await ev(probe); lefts.add(hz.left);
  const ok = worstDrift <= 3 && minInside === minVis && lefts.size === 1;
  if (!ok) fail++;
  console.log(`${ok ? "  ok " : "FAIL "} ${label.padEnd(22)} mode=${mode} worst header drift ${worstDrift}px, rows visible ${minVis}, all inside the box ${minInside === minVis}, frozen col left ${[...lefts].join("/")}`);
}
console.log(fail ? `\n${fail} FAILURES` : "\nboth hold modes keep every row inside the box");
chrome.kill(); server.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
