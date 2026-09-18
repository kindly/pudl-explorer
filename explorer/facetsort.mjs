// Every facet header either sorts or does not claim to. A scale must be inert; everything else must
// actually reorder when clicked, in both directions.
import "./stamp.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DIMS } from "./sql.js";
const port = 9355, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8788", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await sleep(700);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chrome-"));
const chrome = spawn("chromium", ["--headless=new", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--disable-crash-reporter", `--crash-dumps-dir=${profile}`, "--window-size=1800,1200",
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
await send("Page.navigate", { url: "http://127.0.0.1:8788/explorer/" });
for (let i = 0; i < 300; i++) { await sleep(400); if (await ev(`document.querySelectorAll('.facet .list .row').length > 0`).catch(() => false)) break; }
await sleep(2000);

const setMeasure = async (k) => { await ev(`(() => { const s=document.getElementById('measure'); s.value=${JSON.stringify(k)}; s.dispatchEvent(new Event('change')); return true; })()`); await sleep(2400); };
const panel = (title) => `[...document.querySelectorAll('.facet')].find(f => f.querySelector('h3').firstChild.textContent.trim() === ${JSON.stringify(title)})`;
const state = (title) => ev(`(() => { const f = ${panel(title)}; if (!f) return null;
  return { tags: [...f.querySelectorAll('.row.head > *')].map(e => e.tagName),
           vals: [...f.querySelectorAll('.list .row .k')].map(e => e.textContent.trim()),
           on: [...f.querySelectorAll('.row.head .on')].map(e => e.textContent.trim()) }; })()`);
const click = (title, i) => ev(`(() => { const f = ${panel(title)}; const h = f.querySelectorAll('.row.head > *')[${i}];
  h.click(); return true; })()`);

let fail = 0;
const say = (ok, m) => { if (!ok) fail++; console.log(`${ok ? "  ok " : "FAIL "} ${m}`); };

for (const [measure, label] of [["twh", "generation"], ["co2", "CO₂"], ["capex", "FERC capex"]]) {
  await setMeasure(measure);
  for (const d of DIMS) {
    if (d.group && !(measure === "co2" && d.group === "cems") && !(measure === "capex" && d.group === "ferc")) continue;
    if (!d.group && measure !== "twh") continue;
    const before = await state(d.title);
    if (!before) { say(false, `${d.title}: panel missing under ${label}`); continue; }
    if (d.rangeOrder) {
      const inert = before.tags.every((t) => t === "SPAN") && before.on.length === 0;
      const order = JSON.stringify(before.vals.filter((v) => d.fixedOrder.includes(v)));
      const want = JSON.stringify(d.fixedOrder.filter((v) => before.vals.includes(v)));
      say(inert && order === want, `${d.title}: headers inert (${[...new Set(before.tags)].join("/")}), rows in range order`);
      continue;
    }
    // click each header twice; both presses must reorder the list
    let good = true, trace = [];
    for (const i of [0, 1, 2]) {
      await click(d.title, i); await sleep(1500); const a = await state(d.title);
      await click(d.title, i); await sleep(1500); const b = await state(d.title);
      const changed = JSON.stringify(a.vals) !== JSON.stringify(b.vals);
      const marked = a.on.length === 1 && b.on.length === 1;
      if (!changed || !marked) { good = false; trace.push(`col ${i}: ${changed ? "marked?" : "no reorder"}`); }
    }
    say(good, `${d.title}: all three headers reverse${trace.length ? " — " + trace.join(", ") : ""} (${before.vals.length} rows)`);
  }
}
console.log(fail ? `\n${fail} FAILURES` : "\nevery facet header either sorts or does not offer to");
chrome.kill(); server.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
