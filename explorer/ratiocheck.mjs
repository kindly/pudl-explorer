// Non-additive measures must not be stacked or size the map; facet headers must reverse.
import "./stamp.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const port = 9353, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8786", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await sleep(700);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chrome-"));
const chrome = spawn("chromium", ["--headless=new", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--disable-crash-reporter", `--crash-dumps-dir=${profile}`, "--window-size=1800,1100",
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
await send("Page.navigate", { url: "http://127.0.0.1:8786/explorer/" });
for (let i = 0; i < 300; i++) { await sleep(400); if (await ev(`document.querySelectorAll('#grid .grow:not([hidden])').length > 0`).catch(() => false)) break; }
await sleep(2000);
let fail = 0;
const say = (ok, m) => { if (!ok) fail++; console.log(`${ok ? "  ok " : "FAIL "} ${m}`); };
const setMeasure = async (k) => { await ev(`(() => { const s=document.getElementById('measure'); s.value=${JSON.stringify(k)}; s.dispatchEvent(new Event('change')); return true; })()`); await sleep(2400); };

const chart = `({
  bars: document.querySelectorAll('#year-chart svg rect').length,
  lines: document.querySelectorAll('#year-chart svg path').length,
  sub: document.querySelector('#year-chart .sub').textContent.slice(0, 70),
  mapSub: document.querySelector('#map .sub').textContent.slice(0, 90),
  sparks: [...document.querySelectorAll('#grid .ghead > span')].map(s=>s.firstChild.textContent.trim()).filter(h=>/yearly$/.test(h)),
  axisTop: Math.max(...[...document.querySelectorAll('#year-chart svg text')]
    .map(t => parseFloat(String(t.textContent).replace(/[^0-9.]/g, ''))).filter(n => !isNaN(n) && n < 1900)),
})`;

console.log("--- measures that can be added up ---");
for (const k of ["twh", "co2"]) {
  await setMeasure(k); const c = await ev(chart);
  say(c.bars > 10 && c.lines === 0, `${k}: ${c.bars} bars, ${c.lines} line paths — "${c.sub}"`);
}
console.log("--- measures that cannot ---");
for (const k of ["cf", "co2_mwh", "co2_mw"]) {
  await setMeasure(k); const c = await ev(chart);
  say(c.lines >= 3 && c.bars <= 17, `${k}: ${c.lines} line paths, ${c.bars} dim rects — "${c.sub}"`);
  say(/area ∝ (capacity|CO₂|generation)/.test(c.mapSub), `${k}: map — "${c.mapSub}"`);
  // a capacity factor is a percentage; a gate on the wrong side of the ratio once put it in the thousands
  if (k === "cf") say(c.axisTop > 40 && c.axisTop <= 100, `cf: year axis tops out at ${c.axisTop}%`);
}
console.log("--- the capacity factor sparkline is measure-driven ---");
await setMeasure("twh");
let c = await ev(chart);
say(!c.sparks.includes("Capacity factor yearly") && c.sparks.includes("Generation yearly"), `generation selected: ${c.sparks.join(" + ")}`);
await setMeasure("cf");
c = await ev(chart);
say(c.sparks.includes("Capacity factor yearly"), `capacity factor selected: ${c.sparks.join(" + ")}`);

console.log("--- facet headers reverse ---");
const readFacet = () => ev(`(() => {
  const f = document.querySelector('.facet');
  const heads = [...f.querySelectorAll('.row.head button')].map(b => b.textContent.trim());
  const on = [...f.querySelectorAll('.row.head button.on')].map(b => b.textContent.trim());
  const vals = [...f.querySelectorAll('.list .row')].slice(0, 4).map(r => r.querySelector('.k').textContent.trim());
  return { heads, on: on[0] ?? null, vals };
})()`);
for (const [idx, name] of [[0, "value"], [1, "plants"], [2, "measure"]]) {
  const click = () => ev(`document.querySelectorAll('.facet .row.head button')[${idx}].click(); true`);
  await click(); await sleep(1600); const first = await readFacet();
  await click(); await sleep(1600); const second = await readFacet();
  const reversed = JSON.stringify(first.vals) !== JSON.stringify(second.vals)
    && JSON.stringify(first.vals.slice().reverse().slice(0, 2)) !== JSON.stringify([]);
  say(reversed && first.on && second.on, `${name}: ${first.on} ${JSON.stringify(first.vals)} then ${second.on} ${JSON.stringify(second.vals)}`);
}
if (errs.length) { console.log("page errors:"); errs.slice(0, 4).forEach(e => console.log("  " + e)); fail += errs.length; }
console.log(fail ? `\n${fail} FAILURES` : "\nratio measures behave, and every facet header reverses");
chrome.kill(); server.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
