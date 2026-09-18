// Grid invariants: fixed height, stable row count, last row reachable, empty slots truly blank.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import "./stamp.mjs";   // assets carry a content hash; never serve an unstamped tree
const port = 9343, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8777", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await sleep(700);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chrome-"));
const chrome = spawn("chromium", ["--headless=new", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--disable-crash-reporter", `--crash-dumps-dir=${profile}`, "--window-size=1400,1000",
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
const viewport = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: w < 500 ? 3 : 1, mobile: w < 500 });
await viewport(1400, 1000);
await send("Page.navigate", { url: "http://127.0.0.1:8777/explorer/" });
for (let i = 0; i < 250; i++) { await sleep(400); if (await ev(`document.querySelectorAll('#grid .grow:not([hidden])').length > 0`).catch(() => false)) break; }
await sleep(2500);

const probe = `(() => {
  const s = document.getElementById('grid-scroller');
  const rows = [...document.querySelectorAll('#grid .grow')];
  const shown = rows.filter(r => getComputedStyle(r).display !== 'none');
  const hiddenVisible = rows.filter(r => r.hidden && getComputedStyle(r).display !== 'none').length;
  return { h: Math.round(s.getBoundingClientRect().height), inline: s.style.height || '(none)',
           slots: rows.length, shown: shown.length, hiddenVisible,
           rng: (document.querySelector('#grid .count')||{}).textContent || '' };
})()`;
let fail = 0;
const say = (ok, msg) => { if (!ok) fail++; console.log(`${ok ? "  ok " : "FAIL "} ${msg}`); };

const heights = new Set(), counts = new Set();
let last;
for (let i = 0; i < 25; i++) {
  await ev(`document.getElementById('grid-scroller').scrollBy(0, ${400 + i * 37}); true`);
  await sleep(110);
  last = await ev(probe);
  heights.add(last.h); counts.add(last.shown);
  if (last.hiddenVisible) say(false, `hidden row still displayed at step ${i}`);
}
console.log(`desktop: heights seen ${[...heights].join(",")}  visible-row counts ${[...counts].join(",")}  inline height ${last.inline}`);
say(heights.size === 1, "scroller height constant across 25 scrolls");
say(counts.size === 1, "visible row count constant across 25 scrolls");
say(last.inline === "(none)", "no inline height written by JS");

// can we reach the final row?
await ev(`const s=document.getElementById('grid-scroller'); s.scrollTop = s.scrollHeight; true`);
await sleep(400);
const bottom = await ev(probe);
const total = await ev(`window.__rendered && document.querySelector('#grid .count').textContent`);
console.log(`bottom: ${bottom.rng}`);
const m = bottom.rng.match(/([\d,]+) generators .* rows ([\d,]+)–([\d,]+)/);
say(m && m[3].replace(/,/g, "") === m[1].replace(/,/g, ""), "scrolled to the end shows the last row");

for (const [w, h, label] of [[390, 664, "iPhone portrait"], [390, 844, "URL bar hidden"], [844, 390, "landscape"]]) {
  await viewport(w, h); await sleep(900);
  const a = await ev(probe);
  for (let i = 0; i < 10; i++) { await ev(`document.getElementById('grid-scroller').scrollBy(0, 260); true`); await sleep(90); }
  const b = await ev(probe);
  console.log(`${label.padEnd(16)} ${w}×${h}: height ${a.h}→${b.h}, rows ${a.shown}→${b.shown}, hidden-but-displayed ${b.hiddenVisible}`);
  say(a.h === b.h && a.shown === b.shown && b.hiddenVisible === 0, `${label}: stable while scrolling`);
}
// a filter with only a handful of rows: the rest of the grid must be blank, height unchanged
await ev(`location.hash = ''; location.search = '?plant=6002'; true`).catch(() => {});
await sleep(3000);
const few = await ev(probe);
console.log(`filtered: height ${few.h}, slots ${few.slots}, visible ${few.shown}, hidden-but-displayed ${few.hiddenVisible}`);
say(few.h === [...heights][0], "height unchanged when few rows match");
say(few.hiddenVisible === 0, "unused slots render as blank space");

console.log(fail ? `\n${fail} FAILURES` : "\nall grid invariants hold");
chrome.kill(); server.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
