import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const port = 9348, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8782", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await sleep(700);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chrome-"));
const chrome = spawn("chromium", ["--headless=new", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--disable-crash-reporter", `--crash-dumps-dir=${profile}`, "--window-size=1800,1100",
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find((x) => x.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (p) { pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:8782/explorer/?m=tbtu" });
for (let i = 0; i < 300; i++) { await sleep(400); if (await ev(`document.querySelectorAll('#grid .grow:not([hidden])').length > 0`).catch(() => false)) break; }
await sleep(2500);
console.log(await ev(`(() => {
  const row = document.querySelector('#grid .grow:not([hidden])');
  const heads = [...document.querySelectorAll('#grid .ghead > span')].map(s => s.firstChild.textContent.trim());
  return [...row.children].map((c, i) => {
    const svg = c.querySelector('svg.spark');
    if (!svg) return heads[i] + ' = ' + c.textContent.trim().slice(0, 22);
    const ps = [...svg.querySelectorAll('path')].map(p => (p.getAttribute('d') || '').length);
    const na = c.querySelector('.na');
    return heads[i] + ' -> svg display=' + (svg.style.display || 'shown') + ' path d lengths=' + ps.join('/') + ' na-hidden=' + (na ? na.hidden : '?');
  }).join('\\n');
})()`));
chrome.kill(); server.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
