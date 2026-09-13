import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const port = 9340, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8774", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
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
await send("Page.navigate", { url: "http://127.0.0.1:8774/explorer/sticky-proto.html" });
await sleep(1200);

console.log("1. sub-row scrolling (is it Excel-snapped?)");
for (const top of [0, 7, 13, 25, 38, 12345, 12351]) {
  await ev(`document.getElementById('s').scrollTop = ${top}; true`);
  await sleep(60);
  const st = await ev(`window.__state`);
  console.log(`   scrollTop ${String(top).padStart(6)} → first row ${String(st.first).padStart(6)}, sub-row offset ${String(st.offset).padStart(3)} px, paint ${st.paintMs.toFixed(2)} ms`);
}

console.log("2. hit-testing: does the fake scroll area swallow clicks?");
for (const top of [0, 5000, 900000]) {
  await ev(`document.getElementById('s').scrollTop = ${top}; window.__clicked = null; true`);
  await sleep(80);
  const box = await ev(`(() => { const a = document.querySelectorAll('#rows a')[6]; const r = a.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: a.textContent, row: a.dataset.row }; })()`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(120);
  const got = await ev(`window.__clicked`);
  console.log(`   at scrollTop ${String(top).padStart(6)}: clicked link for row ${box.row} → handler got ${got} ${String(got) === String(box.row) ? "OK" : "MISSED"}`);
}

console.log("3. do the rows ever leave the viewport?");
const cover = await ev(`(async () => {
  const s = document.getElementById('s'), out = [];
  const frame = () => new Promise(r => requestAnimationFrame(r));
  for (let k = 0; k < 40; k++) {
    s.scrollTop = (s.scrollHeight - s.clientHeight) * (k / 40);
    await frame();
    const vp = document.querySelector('.viewport').getBoundingClientRect(), sb = s.getBoundingClientRect();
    const covered = Math.max(0, Math.min(vp.bottom, sb.bottom) - Math.max(vp.top, sb.top));
    out.push(Math.round(100 * covered / sb.height));
  }
  return { worst: Math.min(...out), median: out.sort((a,b)=>a-b)[out.length>>1] };
})()`);
console.log(`   viewport coverage across 40 jumps: worst ${cover.worst}%, median ${cover.median}%`);
chrome.kill(); server.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
