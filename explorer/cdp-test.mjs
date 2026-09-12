// Headless Chromium driver over the DevTools protocol (no puppeteer): loads the explorer,
// waits for the data to open, screenshots, checks the DOM, clicks a facet, screenshots again.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2] ?? "http://127.0.0.1:8767/explorer/";
const outDir = process.argv[3] ?? ".";
const port = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// fixed profile so OPFS (and facetful's cache) persists between runs; pass FRESH=1 to start clean
const profile = process.env.FRESH ? mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chrome-")) : join(process.env.TMPDIR ?? tmpdir(), "explorer-chrome-profile");
const server = spawn("python3", ["-m", "http.server", "8767", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await sleep(800);
const chrome = spawn("chromium", [
  "--headless=new", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", `--window-size=${process.env.WIDTH ?? 1400},1800`, `--crash-dumps-dir=${profile}`, "--disable-crash-reporter",
  "--js-flags=--max-old-space-size=6144", "--enable-features=FileSystemAccessAPI",
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
chrome.stderr.on("data", (d) => { const s = String(d); if (/error|fatal/i.test(s) && !/dbus|gpu|vaapi/i.test(s)) process.stderr.write(s); });
let targets;
for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const logs = [];
// watchdog: never hang forever (a crashed renderer leaves CDP promises pending)
const die = (why) => { console.log(`\nWATCHDOG: ${why}\n--- browser console ---\n` + logs.slice(0, 40).join("\n")); try { chrome.kill(); } catch {} try { server.kill(); } catch {} process.exit(2); };
const watchdog = setTimeout(() => die("test exceeded 240 s"), 240000);
ws.onclose = () => die("devtools socket closed");
ws.onerror = (e) => die("devtools socket error " + (e.message ?? ""));
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  else if (m.method === "Runtime.consoleAPICalled") logs.push(`[console.${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
  else if (m.method === "Runtime.exceptionThrown") logs.push(`[exception] ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  else if (m.method === "Log.entryAdded") logs.push(`[${m.params.entry.level}] ${m.params.entry.text}`);
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed"); return r.result.value; };
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }); writeFileSync(join(outDir, name), Buffer.from(r.data, "base64")); console.log("screenshot", name); };
await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: Number(process.env.WIDTH ?? 1400), height: 1800, deviceScaleFactor: 1, mobile: false });
const t0 = performance.now();
await send("Page.navigate", { url });
// wait for loading overlay to hide (or error)
let ready = false;
for (let i = 0; i < 900; i++) {
  await sleep(1000);
  const s = await evalJs(`(() => { const l = document.getElementById('loading'); if (!l) return { hidden: false, steps: 'navigating', err: '', bytes: '' }; return { hidden: l.hidden, steps: l.querySelector('.steps').textContent, err: l.querySelector('.err').textContent, bytes: l.querySelector('.bytes').textContent }; })()`);
  if (i % 10 === 0) console.log(`${((performance.now() - t0) / 1000).toFixed(0)}s`, s.steps.split("\n").pop(), s.bytes);
  if (s.err) { console.log("LOAD ERROR:", s.err); break; }
  if (s.hidden) { ready = true; break; }
}
console.log(`ready=${ready} after ${((performance.now() - t0) / 1000).toFixed(1)}s`);
if (ready) {
  // wait for settle text
  for (let i = 0; i < 120; i++) { await sleep(500); if (await evalJs(`document.getElementById('settle').textContent`)) break; }
  console.log("open-info:", await evalJs(`document.getElementById('open-info').textContent`));
  console.log("settle:", await evalJs(`document.getElementById('settle').textContent`));
  console.log("totals:", await evalJs(`[...document.querySelectorAll('#totals .total')].map(t => t.textContent.trim().replace(/\\s+/g,' ')).join(' | ')`));
  console.log("facets:", await evalJs(`[...document.querySelectorAll('.facet')].map(f => f.querySelector('h3').firstChild.textContent + ':' + f.querySelectorAll('.row').length).join(', ')`));
  console.log("fuel rows:", await evalJs(`[...document.querySelectorAll('.facet .row')].slice(0,10).map(r => r.textContent.trim().replace(/\\s+/g,' ')).join(' ; ')`));
  for (let i = 0; i < 60; i++) { await sleep(500); if (await evalJs(`document.querySelectorAll('#grid tbody tr').length > 0`)) break; }
  console.log("grid rows:", await evalJs(`document.querySelectorAll('#grid tbody tr').length`), "first:", await evalJs(`document.querySelector('#grid tbody tr')?.textContent.trim().replace(/\\s+/g,' ').slice(0,200)`));
  console.log("map points:", await evalJs(`document.querySelector('#map .sub').textContent`), "| maplibre canvas:", await evalJs(`!!document.querySelector('#map canvas.maplibregl-canvas')`));
  console.log("season sub:", await evalJs(`document.querySelector('#month-chart .sub').textContent`), "| bars:", await evalJs(`document.querySelectorAll('#month-chart svg rect').length`));
  await evalJs(`document.getElementById('show-ms').click(); true`);
  await sleep(4000); // let basemap tiles arrive
  console.log("maplibre log:", logs.filter((l) => /maplibre/.test(l)).join(" | ").slice(0, 300));
  await shot("shot-1-initial.png");
  // viewport-only capture of the map element (full-page capture can drop WebGL tile content)
  await evalJs(`document.getElementById('map').scrollIntoView({block: 'start'}); true`);
  await sleep(2500);
  { const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); writeFileSync(join(outDir, "shot-map.png"), Buffer.from(r.data, "base64")); console.log("screenshot shot-map.png"); }
  // click Grand Gulf (nuclear, MS) on the map through a real mouse event; expect the pinned card with a GEM wiki link
  {
    const pt = await evalJs(`(() => { const m = window.__plantMap?.map; if (!m) return null; const p = m.project([-91.048, 32.007]); const r = m.getCanvas().getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; })()`);
    if (pt) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
      await sleep(600);
      console.log("hover tip:", await evalJs(`document.querySelector('.plant-hover')?.innerText.replace(/\\s+/g, ' ').slice(0, 120) ?? 'none'`));
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
      await sleep(1500);
      console.log("map card:", await evalJs(`document.querySelector('.plant-pin .pp-card')?.innerText.replace(/\\s+/g, ' ').slice(0, 260) ?? 'no card'`), "| wiki link:", await evalJs(`document.querySelector('.plant-pin a.pp-btn')?.href ?? 'none'`), "| url still:", await evalJs(`location.search`));
    } else console.log("map card: no map");
  }
  console.log("map canvas:", await evalJs(`(() => { const c = document.querySelector('#map canvas'); return c ? c.width + 'x' + c.height : 'no canvas'; })()`), "| maplibre logs:", logs.filter((l) => /maplibre/.test(l)).length);
  // click the "coal" fuel facet row, then a state, and re-check
  await evalJs(`(() => { const r = [...document.querySelectorAll('.facet .row')].find(r => r.textContent.trim().startsWith('coal')); r.click(); return !!r; })()`);
  await sleep(4000);
  console.log("after coal click url:", await evalJs(`location.search`));
  console.log("settle:", await evalJs(`document.getElementById('settle').textContent`));
  console.log("totals:", await evalJs(`[...document.querySelectorAll('#totals .total')].map(t => t.textContent.trim().replace(/\\s+/g,' ')).join(' | ')`));
  console.log("panel ms:", await evalJs(`[...document.querySelectorAll('.panel')].map(p => (p.querySelector('h3')?.firstChild.textContent.trim() || p.id) + '=' + (p.querySelector('.ms')?.textContent || '?')).join(', ')`));
  await evalJs(`(() => { const s = document.getElementById('measure'); s.value = 'gw'; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(4000);
  console.log("gw measure fuel rows:", await evalJs(`[...document.querySelectorAll('.facet .row')].slice(0,5).map(r => r.textContent.trim().replace(/\\s+/g,' ')).join(' ; ')`));
  for (const m of ["co2", "co2_mwh", "opex_mwh"]) {
    await evalJs(`(() => { const s = document.getElementById('measure'); s.value = '${m}'; s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(2500);
    console.log(`${m} fuel rows:`, await evalJs(`[...document.querySelectorAll('.facet .row')].slice(0,6).map(r => r.textContent.trim().replace(/\\s+/g,' ')).join(' ; ')`), "| season:", await evalJs(`document.querySelector('#month-chart .sub').textContent.slice(0,60)`), "| visible facets:", await evalJs(`[...document.querySelectorAll('.facet')].filter(f => !f.hidden).length`), "| season hidden:", await evalJs(`document.getElementById('month-chart').hidden`), "| map:", await evalJs(`document.querySelector('#map .sub').textContent.slice(0,40)`));
  }
  await evalJs(`(() => { const s = document.getElementById('measure'); s.value = 'twh'; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(1500);
  await evalJs(`(() => { const i = document.getElementById('q'); i.value = 'diablo'; i.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(4000);
  console.log("search totals:", await evalJs(`[...document.querySelectorAll('#totals .total')].map(t => t.textContent.trim().replace(/\\s+/g,' ')).join(' | ')`));
  await shot("shot-2-filtered.png");
  // drill-down: clear filters, click the first plant link in the grid, check chips + totals, then remove it
  await evalJs(`document.getElementById('clear-all').click(); true`);
  await sleep(1500);
  for (let i = 0; i < 40; i++) { await sleep(250); if (await evalJs(`document.querySelectorAll('#grid tbody a').length > 0`)) break; }
  await evalJs(`document.querySelector('#grid tbody a').click(); true`);
  await sleep(2500);
  console.log("drill-down chips:", await evalJs(`[...document.querySelectorAll('.chip')].map(c => c.textContent).join(' ; ')`), "| totals:", await evalJs(`[...document.querySelectorAll('#totals .total')].map(t => t.textContent.trim().replace(/\s+/g,' ')).join(' | ')`), "| grid rows:", await evalJs(`document.querySelectorAll('#grid tbody tr').length`));
  console.log("settle:", await evalJs(`document.getElementById('settle').textContent`));
  await sleep(1500); // map fly-to
  await shot("shot-3-drilldown.png");
  // with the map flown to Grand Gulf, click its (now isolated) dot: card must carry the GEM wiki link
  {
    await evalJs(`document.getElementById('map').scrollIntoView({block: 'start'}); true`);
    await sleep(800);
    const pt = await evalJs(`(() => { const m = window.__plantMap?.map; if (!m) return null; const p = m.project([-91.048, 32.007]); const r = m.getCanvas().getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; })()`);
    if (pt) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
      await sleep(800);
      console.log("hover tip (zoomed):", await evalJs(`document.querySelector('.plant-hover')?.innerText.replace(/\\s+/g, ' ').slice(0, 120) ?? 'none'`));
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
      await sleep(1500);
      console.log("card (zoomed):", await evalJs(`document.querySelector('.plant-pin .pp-card')?.innerText.replace(/\\s+/g, ' ').slice(0, 200) ?? 'no card'`), "| wiki link:", await evalJs(`document.querySelector('.plant-pin a.pp-btn')?.href ?? 'none'`));
      const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); writeFileSync(join(outDir, "shot-card.png"), Buffer.from(r.data, "base64")); console.log("screenshot shot-card.png");
    }
  }
  await evalJs(`document.getElementById('clear-all').click(); true`);
  await sleep(1500);
  // Barry Steam Plant (EIA 3, AL): a plant GEM knows — card must show the GEM wiki link
  await evalJs(`location.search = '?plant=3'; true`);
  for (let i = 0; i < 100; i++) { await sleep(300); if (await evalJs(`document.getElementById('loading')?.hidden && document.getElementById('settle').textContent && !!window.__plantMap`)) break; }
  await sleep(2000);
  {
    await evalJs(`document.getElementById('map').scrollIntoView({block: 'start'}); true`);
    await sleep(800);
    const pt = await evalJs(`(() => { const m = window.__plantMap?.map; if (!m) return null; const p = m.project([-88.0103, 31.0069]); const r = m.getCanvas().getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; })()`);
    if (pt) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
      await sleep(1500);
      console.log("Barry card:", await evalJs(`document.querySelector('.plant-pin .pp-card')?.innerText.replace(/\\s+/g, ' ').slice(0, 160) ?? 'no card'`), "| wiki link:", await evalJs(`document.querySelector('.plant-pin a.pp-btn')?.href ?? 'none'`), "| chip:", await evalJs(`document.querySelector('.chip')?.innerText.replace(/\\s+/g, ' ')`));
      const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); writeFileSync(join(outDir, "shot-card.png"), Buffer.from(r.data, "base64")); console.log("screenshot shot-card.png (Barry)");
    }
  }
  // year-range filter: measures the cost of losing row-group pruning on the generator-sorted image
  await evalJs(`location.search = '?year=2018..2024'; true`);
  for (let i = 0; i < 300; i++) { await sleep(500); if (await evalJs(`document.getElementById('loading')?.hidden && document.getElementById('settle').textContent`)) break; }
  console.log("year-range settle:", await evalJs(`document.getElementById('settle').textContent`), "|", await evalJs(`[...document.querySelectorAll('#totals .total')].slice(0,3).map(t => t.textContent.trim().replace(/\s+/g,' ')).join(' | ')`));
  // reload to test the cached reopen path
  const t1 = performance.now();
  await send("Page.reload");
  for (let i = 0; i < 300; i++) { await sleep(500); if (await evalJs(`document.getElementById('loading').hidden`)) break; }
  console.log(`reload ready in ${((performance.now() - t1) / 1000).toFixed(1)}s;`, await evalJs(`document.getElementById('open-info').textContent`));
}
console.log("\n--- browser console ---\n" + logs.slice(0, 40).join("\n"));
clearTimeout(watchdog); chrome.kill(); server.kill();
process.exit(0);
