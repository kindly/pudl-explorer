// Reproduce the iPhone symptom: mobile viewport + heavy CPU throttling + aggressive scrolling.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const port = 9344, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8778", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await sleep(700);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chrome-"));
const chrome = spawn("chromium", ["--headless=new", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--disable-crash-reporter", `--crash-dumps-dir=${profile}`, "--window-size=390,844",
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find((x) => x.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (p) { pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Page.navigate", { url: "http://127.0.0.1:8778/explorer/" });
for (let i = 0; i < 300; i++) { await sleep(400); if (await ev(`document.querySelectorAll('#grid .grow:not([hidden])').length > 0`).catch(() => false)) break; }
await sleep(1200);

const probe = `(() => {
  const s = document.getElementById('grid-scroller');
  const rows = [...document.querySelectorAll('#grid .grow')];
  const vis = rows.filter(r => getComputedStyle(r).display !== 'none').length;
  return { clientH: s.clientHeight, rectH: Math.round(s.getBoundingClientRect().height),
           headH: document.querySelector('#grid .ghead').offsetHeight,
           slots: rows.length, vis, all: !!window.__gridAll,
           top: Math.round(s.scrollTop), rng: window.__rendered ? window.__rendered.first + '-' + window.__rendered.last : '-' };
})()`;

// throttle hard so the whole-result fetch stays slow and we live in the paged window, like a phone
await send("Emulation.setCPUThrottlingRate", { rate: 20 });
console.log("throttled 20x; scrolling hard\n");
const seen = new Map();
for (let round = 0; round < 5; round++) {
  // a burst of touch-like scrolls with no idle time between them
  for (let i = 0; i < 14; i++) {
    await ev(`document.getElementById('grid-scroller').scrollBy(0, ${300 + i * 211}); true`);
    const p = await ev(probe);
    const key = `${p.vis} visible / ${p.slots} slots  clientH=${p.clientH} headH=${p.headH} all=${p.all}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  // a big jump, the case that empties the page window
  await ev(`document.getElementById("grid-scroller").scrollTop = ${200000 + round * 90000}; true`);
  for (let i = 0; i < 6; i++) {
    const p = await ev(probe);
    const key = `${p.vis} visible / ${p.slots} slots  clientH=${p.clientH} headH=${p.headH} all=${p.all}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    await sleep(60);
  }
  await ev(`window.dispatchEvent(new Event('resize')); true`);
  await sleep(250);
}
await send("Emulation.setCPUThrottlingRate", { rate: 1 });
console.log("states observed (count × state):");
for (const [k, n] of [...seen].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)} × ${k}`);
const bad = [...seen.keys()].filter((k) => /^([0-9]|1[0-2]) visible/.test(k));
console.log(bad.length ? `\nREPRODUCED: ${bad.length} degraded state(s)` : "\nno degraded states seen");
chrome.kill(); server.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
