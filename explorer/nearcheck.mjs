// The "near a town" filter: autocomplete, the filter it applies, the shared link, and the
// promise that the places image is not fetched unless someone uses it.
import "./stamp.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const port = 9357, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8790", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await sleep(700);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chrome-"));
const chrome = spawn("chromium", ["--headless=new", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--disable-crash-reporter", `--crash-dumps-dir=${profile}`, "--window-size=1600,1100",
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });

const cleanUp = () => {
  try { chrome.kill(); } catch {}
  try { server?.kill(); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
};
process.on("exit", cleanUp);
process.on("uncaughtException", (e) => { console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });

let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find((x) => x.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const errs = []; let fetched = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Network.requestWillBeSent") fetched.push(m.params.request.url);
  if (m.method === "Runtime.exceptionThrown") errs.push(m.params.exceptionDetails.exception?.description?.split("\n")[0] ?? "?");
  const p = pend.get(m.id); if (p) { pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
};
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");

let fail = 0;
const say = (ok, m) => { if (!ok) fail++; console.log(`${ok ? "  ok " : "FAIL "} ${m}`); };
const settled = async () => { for (let i = 0; i < 300; i++) { await sleep(400); if (await ev(`document.querySelectorAll('#grid .grow:not([hidden])').length > 0`).catch(() => false)) return true; } return false; };
const plants = () => ev(`document.querySelector('#t-plants').textContent`);
const placesFetched = () => fetched.filter((u) => u.includes("places_us")).length;

// --- a visitor who never touches the box must not pay for the places image ---------------
await send("Page.navigate", { url: "http://127.0.0.1:8790/explorer/" });
await settled(); await sleep(2500);
const before = await plants();
say(placesFetched() === 0, `cold load fetches no places image (all plants: ${before})`);

// --- type, pick, filter -------------------------------------------------------------------
await ev(`(() => { const i = document.getElementById('near-q'); i.focus(); i.value = 'austin';
  i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
for (let i = 0; i < 60; i++) { await sleep(250); if (await ev(`!document.getElementById('near-hits').hidden`)) break; }
const hits = await ev(`[...document.querySelectorAll('#near-hits .hit')].map(h => h.textContent.trim()).slice(0,3)`);
say(hits.length > 0 && /Austin, Texas/.test(hits[0]), `autocomplete, largest first: ${JSON.stringify(hits)}`);
say(placesFetched() > 0, "the places image is fetched only once someone types");

await ev(`document.querySelector('#near-hits .hit').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
await sleep(3000);
const after = await plants();
const url = await ev(`decodeURIComponent(location.search).replaceAll("+", " ")`);
say(/near=30\.267,-97\.743,50,Austin, Texas/.test(url), `URL carries the whole filter: ${url}`);
say(after !== before && Number(after.replace(/,/g, "")) > 0, `plant count fell from ${before} to ${after}`);
const chip = await ev(`[...document.querySelectorAll('.chip')].map(c => c.textContent).join(' ; ')`);
say(/within 50 km of Austin, Texas/.test(chip), `chip reads: ${chip}`);
const ring = await ev(`window.__map ? 1 : (document.querySelector('#map canvas') ? 1 : 0)`);
say(ring === 1, "the map is still rendering");

// --- the radius dropdown re-filters --------------------------------------------------------
await ev(`(() => { const s = document.getElementById('near-km'); s.value = '200';
  s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
await sleep(3000);
const wider = await plants();
say(Number(wider.replace(/,/g, "")) > Number(after.replace(/,/g, "")), `200 km widens ${after} to ${wider}`);

// --- a shared link filters without anyone typing --------------------------------------------
fetched = [];
await send("Page.navigate", { url: "http://127.0.0.1:8790/explorer/?near=30.267%2C-97.743%2C50%2CAustin%2C%20Texas" });
await settled(); await sleep(2500);
const shared = await plants();
const box = await ev(`document.getElementById('near-q').value`);
say(shared === after, `shared link gives the same ${after} plants`);
say(box === "Austin, Texas", `the box is restored from the URL: "${box}"`);

// --- clearing it ---------------------------------------------------------------------------
await ev(`[...document.querySelectorAll('.chip .x')].pop().click(); true`);
await sleep(3000);
say((await plants()) === before, `removing the chip restores ${before}`);

if (errs.length) { console.log("page errors:"); errs.slice(0, 4).forEach((e) => console.log("  " + e)); fail += errs.length; }
console.log(fail ? `\n${fail} FAILURES` : "\nthe near filter works, and costs nothing until it is used");
process.exit(fail ? 1 : 0);
