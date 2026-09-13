// Nothing scrolling under the frozen columns may be visible through them. Hit-test every point
// inside the frozen region: the topmost element must always be a frozen cell or its child.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const port = 9350, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn("python3", ["-m", "http.server", "8784", "--bind", "127.0.0.1"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore" });
await sleep(700);
const profile = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "chrome-"));
const chrome = spawn("chromium", ["--headless=new", "--no-proxy-server", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--disable-gpu", "--disable-crash-reporter", `--crash-dumps-dir=${profile}`, "--window-size=900,900",
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "about:blank"], { stdio: ["ignore", "ignore", "ignore"] });
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find((x) => x.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (p) { pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value; };
await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:8784/explorer/" });
for (let i = 0; i < 300; i++) { await sleep(400); if (await ev(`document.querySelectorAll('#grid .grow:not([hidden])').length > 0`).catch(() => false)) break; }
await sleep(2000);
await ev(`document.getElementById('grid').scrollIntoView({ block: 'center' }); true`);
await sleep(400);

// `blank` empties the frozen cells of every other row: the worst case the user described
const hitTest = (blank) => ev(`(() => {
  const rows = [...document.querySelectorAll('#grid .grow:not([hidden])')];
  if (${blank}) rows.forEach((r, i) => { if (i % 2) [...r.children].slice(0, 2).forEach(c => {
    const a = c.querySelector('a'); if (a) a.textContent = ''; const s = c.querySelector('small');
    if (s) s.textContent = ''; if (!a && !s) c.firstChild.nodeValue = ''; }); });
  const frozen = [...document.querySelectorAll('#grid .grow > span.freeze')];
  const right = Math.max(...frozen.map(f => f.getBoundingClientRect().right));
  const x0 = document.getElementById('grid-scroller').getBoundingClientRect().left;
  const bad = [];
  let hits = 0;
  for (const row of rows) {
    const b = row.getBoundingClientRect();
    for (const y of [b.top + 0.5, b.top + b.height / 2, b.bottom - 1.5]) {
      for (const x of [x0 + 2, x0 + 40, x0 + 120, x0 + 200, right - 2]) {
        const el = document.elementFromPoint(x, y);
        if (!el) continue;                    // outside the window: not a sample
        hits++;
        const cell = el.closest('span');
        const ok = el.closest('.freeze') || el.classList.contains('grow') || el.classList.contains('gviewport')
          || el.classList.contains('tall') || el.id === 'grid-scroller';
        if (!ok) bad.push(\`x=\${(x - x0).toFixed(0)} y=\${(y - b.top).toFixed(0)}px into row -> \${(cell || el).className || el.tagName} "\${(cell||el).textContent.trim().slice(0,18)}"\`);
      }
    }
  }
  return { right: Math.round(right), checked: hits, bad: bad.slice(0, 6), n: bad.length };
})()`);

let fail = 0;
for (const left of [0, 300, 900]) {
  await ev(`document.getElementById('grid-scroller').scrollLeft = ${left}; true`);
  await sleep(300);
  for (const blank of [false, true]) {
    const r = await hitTest(blank);
    const ok = r.n === 0 && r.checked > 100;
    if (!ok) fail++;
    console.log(`${ok ? "  ok " : "FAIL "} scrollLeft=${String(left).padStart(3)} ${blank ? "with blanked Plant/Gen" : "with normal values  "}: ${r.checked} points sampled inside the frozen region, ${r.n} leaked`);
    r.bad.forEach((b) => console.log(`         ${b}`));
  }
  await ev(`window.__refreshRows && window.__refreshRows(); true`).catch(() => {});
  await ev(`document.getElementById('grid-scroller').scrollBy(0, 50); document.getElementById('grid-scroller').scrollBy(0, -50); true`);
  await sleep(200);
}
// negative control: put the old shrink-wrapped cells back and confirm this test would have caught it
await ev(`(() => { const st = document.createElement('style');
  st.textContent = '.grid .grow > span.freeze { align-self: auto !important; line-height: normal !important; }';
  document.head.append(st); return true; })()`);
await ev(`document.getElementById('grid-scroller').scrollLeft = 300; true`);
await sleep(300);
console.log("\ncontrol diagnostics:", JSON.stringify(await ev(`(() => {
  const rows = [...document.querySelectorAll('#grid .grow:not([hidden])')];
  const r = rows[1]; const cells = [...r.children];
  const a = cells[0].querySelector('a'); if (a) a.textContent = '';
  const s = cells[0].querySelector('small'); if (s) s.textContent = '';
  const rb = r.getBoundingClientRect();
  const mid = rb.top + rb.height / 2;
  const hit = document.elementFromPoint(120, mid);
  return { plantH: cells[0].getBoundingClientRect().height, plantText: cells[0].textContent,
           alignSelf: getComputedStyle(cells[0]).alignSelf,
           hitAt120: (hit && (hit.className || hit.tagName)) + ' | ' + (hit && hit.textContent.trim().slice(0,20)),
           hitIsFrozen: !!(hit && hit.closest('.freeze')) };
})()`)));
const ctl = await hitTest(true);
console.log(`\ncontrol, rule removed: ${ctl.n} leaked (this test is only meaningful if that is > 0)`);
ctl.bad.slice(0, 3).forEach((b) => console.log(`         ${b}`));
if (ctl.n === 0) { console.log("  the check cannot detect the bug it is meant to catch"); fail++; }

console.log(fail ? `\n${fail} FAILURES` : "\nnothing leaks through the frozen columns");
chrome.kill(); server.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(fail ? 1 : 0);
