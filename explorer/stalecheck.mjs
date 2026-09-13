// The stale-shell banner must appear only when version.json disagrees with the built-in stamp.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import "./stamp.mjs";   // assets carry a content hash; never serve an unstamped tree
const port = 9351, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8785", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await sleep(700);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chrome-"));
const chrome = spawn("chromium", ["--headless=new", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--disable-crash-reporter", `--crash-dumps-dir=${profile}`, "--window-size=1200,900",
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find((x) => x.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (p) { pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
await send("Page.enable");
const vj = new URL("./version.json", import.meta.url);
const original = readFileSync(vj, "utf8");
const banner = () => ev(`document.querySelector('.stale-shell')?.textContent.trim().slice(0, 90) ?? null`);
let fail = 0;
const say = (ok, m) => { if (!ok) fail++; console.log(`${ok ? "  ok " : "FAIL "} ${m}`); };
try {
  await send("Page.navigate", { url: "http://127.0.0.1:8785/explorer/" });
  for (let i = 0; i < 200; i++) { await sleep(300); if (await ev(`!!document.querySelector('#grid')`).catch(() => false)) break; }
  await sleep(1500);
  say((await banner()) === null, `stamps agree: no banner (built ${JSON.parse(original).build})`);

  writeFileSync(vj, JSON.stringify({ build: "deadbeef" }) + "\n");
  await send("Page.navigate", { url: "http://127.0.0.1:8785/explorer/?x=1" });
  for (let i = 0; i < 200; i++) { await sleep(300); if (await ev(`!!document.querySelector('#grid')`).catch(() => false)) break; }
  await sleep(1500);
  const b = await banner();
  say(b !== null && b.includes("deadbeef"), `server ahead of the page: ${b ? JSON.stringify(b) : "NO BANNER"}`);
} finally { writeFileSync(vj, original); }
console.log(fail ? `\n${fail} FAILURES` : "\nthe stale-shell banner fires exactly when it should");
chrome.kill(); server.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
