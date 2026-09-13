// PUDL generator explorer on facetful. One filter state (the URL query string) drives every panel;
// each panel is one GROUP BY over the same WHERE. Two images in one worker — see sql.js for which
// table serves which measure. No build step: plain ES modules, vendored facetful and maplibre.
import { wasmUrl, workerUrl, indexUrl } from "./engine.js?v=441f6806";
// the engine path carries its version, so the entry point is reached by dynamic import
const { Facetful } = await import(indexUrl.href);
import { createPlantMap } from "./map.js?v=441f6806";
import {
  TABLES, YEARS, DIMS, ALL_DIMS, MEASURES, SEARCH_PARAM, NULL_TOKEN, gridCols, gridSortable, MEASURE_SPARK,
  yearsIn, facetSql, totalsSql, yearSql, seasonSql, mapSql, gridSql, gridCountSql, monthsPerYearSql,
  plantCardSql, plantTechSql, plantFercSql, plantNameSql,
} from "./sql.js?v=441f6806";

const DATA_DIR = "../data/";
const OPFS_DIR = "pudl";
const PAGE = 100;        // grid rows per query
const MAX_PAGES = 4;     // rows kept in the DOM: a sliding window over ~420 pages
const ROW_H = 25;        // must match .grow height in theme.css
const OVERSCAN = 12;     // rows rendered beyond the viewport, so a flick does not show blanks

export const FUEL_COLORS = {
  coal: "#7F142A", gas: "#CA4A50", oil: "#E5893B", nuclear: "#4A57A8", hydro: "#099ED8",
  wind: "#65BD8B", solar: "#FFE366", waste: "#A0AAE5", other: "#969696", "": "#cfd8dc",
};
const FUEL_ORDER = ["coal", "gas", "oil", "nuclear", "hydro", "wind", "solar", "waste", "other", ""];
const fuelColor = (f) => FUEL_COLORS[f ?? ""] ?? FUEL_COLORS.other;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined) e.append(k);
  return e;
};
const svg = (tag, attrs = {}) => {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
/** Write to an element that may be absent: a browser holding a cached index.html against a newer
 *  app.js would otherwise throw here and take the whole panel down. Warn once, visibly. */
let shellWarned = false;
function setText(sel, value) {
  const e = $(sel);
  if (e) { e.textContent = value; return; }
  if (shellWarned) return;
  shellWarned = true;
  console.warn(`${sel} is missing: this page's HTML is older than its script.`);
  document.body.prepend(el("div", { class: "stale-shell" },
    "This page's HTML is out of date, so some figures are missing. Reload with Ctrl+Shift+R (⌘⇧R) to update."));
}

const fmtInt = new Intl.NumberFormat("en-US");
const fmtN = (v, d = 1) => (v == null || Number.isNaN(v) ? "" : new Intl.NumberFormat("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }).format(v));
const compact = (v, d = 1) => {
  if (v == null) return "";
  const a = Math.abs(v);
  if (a >= 1e9) return fmtN(v / 1e9, d) + "bn";
  if (a >= 1e6) return fmtN(v / 1e6, d) + "M";
  if (a >= 1e5) return fmtN(v / 1e3, 0) + "k";
  if (a >= 1e3) return fmtN(v, 0);
  if (a === 0) return "0";
  return fmtN(v, a < 10 ? 2 : d);
};
const compactInt = (v) => (v == null ? "" : Math.abs(v) >= 1e6 ? fmtN(v / 1e6, 2) + "M" : Math.abs(v) >= 1e5 ? fmtN(v / 1e3, 0) + "k" : fmtInt.format(v));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------------------------------------------------------------- state
function readState() {
  const p = new URLSearchParams(location.search);
  const filters = new Map();
  for (const d of ALL_DIMS) if (p.has(d.key)) filters.set(d.key, p.getAll(d.key));
  if (p.get(SEARCH_PARAM)) filters.set(SEARCH_PARAM, [p.get(SEARCH_PARAM)]);
  const [sc, sd] = (p.get("sort") ?? "twh:desc").split(":");
  return {
    filters,
    measure: MEASURES[p.get("m")] ? p.get("m") : "twh",
    sort: [sc || "twh", sd === "asc" ? "asc" : "desc"],
    facetSort: Object.fromEntries((p.get("fs") ?? "").split(",").filter(Boolean).map((s) => s.split(":"))),
  };
}
let state = readState();

function writeState({ replace = false } = {}) {
  const p = new URLSearchParams();
  for (const [k, vals] of state.filters) for (const v of vals) p.append(k, v);
  if (state.measure !== "twh") p.set("m", state.measure);
  if (state.sort.join(":") !== "twh:desc") p.set("sort", state.sort.join(":"));
  const fs = Object.entries(state.facetSort).filter(([, v]) => v && v !== "v").map((e) => e.join(":")).join(",");
  if (fs) p.set("fs", fs);
  const url = "?" + p.toString();
  if (replace) history.replaceState(null, "", url); else history.pushState(null, "", url);
  syncControls();
  refresh();
}
window.addEventListener("popstate", () => { state = readState(); syncControls(); refresh(); });

function toggle(key, value) {
  const cur = new Set(state.filters.get(key) ?? []);
  cur.has(value) ? cur.delete(value) : cur.add(value);
  cur.size ? state.filters.set(key, [...cur]) : state.filters.delete(key);
  writeState();
}
const setRange = (key, lo, hi) => { lo == null ? state.filters.delete(key) : state.filters.set(key, [`${lo}..${hi}`]); writeState(); };
const clearKey = (key) => { state.filters.delete(key); writeState(); };
const clearAll = () => { state.filters.clear(); writeState(); };

// ---------------------------------------------------------------- db
let db = null;
const loaded = new Set();
const perf = { panels: new Map() };
const plantNames = new Map();
const plantWiki = new Map();
/** year -> months of data present; learned at boot. Average capacity divides by these, not by 12. */
let monthsPerYear = Object.fromEntries(YEARS.map((y) => [y, 12]));
const monthsInRange = () => yearsIn(state.filters).reduce((a, y) => a + (monthsPerYear[y] ?? 0), 0) || 1;

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0;
  const counted = res.body.pipeThrough(new TransformStream({
    transform(chunk, ctrl) { got += chunk.byteLength; onProgress(got, total); ctrl.enqueue(chunk); },
  }));
  if (!url.endsWith(".gz")) return new Response(counted).arrayBuffer();
  // some hosts serve .gz with Content-Encoding: gzip and hand us inflated bytes; check the magic
  const reader = counted.getReader();
  const first = await reader.read();
  if (first.done) return new ArrayBuffer(0);
  const isGzip = first.value[0] === 0x1f && first.value[1] === 0x8b;
  const rest = new ReadableStream({
    start(c) { c.enqueue(first.value); },
    async pull(c) { const { done, value } = await reader.read(); done ? c.close() : c.enqueue(value); },
  });
  return new Response(isGzip ? rest.pipeThrough(new DecompressionStream("gzip")) : rest).arrayBuffer();
}

async function fileVersion(url) {
  try {
    const r = await fetch(url, { method: "HEAD" });
    if (!r.ok) return null;
    const key = r.headers.get("etag") || `${r.headers.get("content-length")}-${r.headers.get("last-modified")}`;
    return key.replace(/[^A-Za-z0-9]+/g, "").slice(-24) || "v0";
  } catch { return null; }
}

async function pruneOpfsDir(dir, prefix, keep) {
  try {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle(dir, { create: true });
    for await (const name of d.keys()) {
      if (name.startsWith(prefix) && name !== keep) { try { await d.removeEntry(name); console.info("removed stale OPFS image", name); } catch {} }
    }
  } catch {}
}

async function openTable(key, status) {
  const t0 = performance.now();
  const file = TABLES[key];
  const gz = `${DATA_DIR}${file}.facetful.gz`;
  const name = `${file}-${(await fileVersion(gz)) ?? "v0"}.facetful`;
  const path = `${OPFS_DIR}/${name}`;
  await pruneOpfsDir(OPFS_DIR, `${file}-`, name);
  let info;
  try {
    info = await db.loadOpfs(key, path);
    info.source = "OPFS";
  } catch {
    status(`fetching ${file}.facetful.gz`);
    const buf = await fetchWithProgress(gz, (got, total) => status(null, total ? got / total : null, `${(got / 1e6).toFixed(0)}${total ? " / " + (total / 1e6).toFixed(0) : ""} MB`));
    try {
      await db.storeOpfs(path, buf.slice(0));
      info = await db.loadOpfs(key, path);
      info.source = "fetched → OPFS";
    } catch {
      info = await db.load(key, buf);
      info.source = "fetched, in memory";
    }
  }
  loaded.add(key);
  info.openMs = performance.now() - t0;
  return info;
}

async function q(sql, table) {
  const r = await db.query(sql, { table });
  return { rows: [...r.rows()], ms: r.elapsedMs };
}

/**
 * Read one row out of a Result without materialising every row as an object. `columnRaw` hands back
 * the worker's transferred typed arrays with no copy, so the whole 42,257-row grid can live in
 * memory as ~26 MB of buffers while only the ~46 rows on screen ever become JS objects.
 */
function makeReader(result) {
  const cols = [];
  for (const c of result.columns) cols.push([c.name, result.columnRaw(c.name)]);
  const dec = new TextDecoder();
  return (i) => {
    const o = {};
    for (const [name, c] of cols) {
      if (c.validity && !((c.validity[i >> 3] >> (i & 7)) & 1)) { o[name] = null; continue; }
      o[name] = c.kind === "text" ? dec.decode(c.bytes.subarray(c.offsets[i], c.offsets[i + 1])) : c.values[i];
    }
    return o;
  };
}

async function plantLabel(id) {
  if (plantNames.has(id)) return plantNames.get(id);
  try {
    const { rows } = await q(plantNameSql(id), "gw");
    const label = rows[0] ? `${rows[0].name}, ${rows[0].state}` : `plant ${id}`;
    plantNames.set(id, label);
    if (rows[0]?.wiki) plantWiki.set(id, rows[0].wiki);
    return label;
  } catch { return `plant ${id}`; }
}

// ---------------------------------------------------------------- panels
const panels = [];
let runId = 0;

async function refresh(only = null) {
  const id = ++runId;
  const t0 = performance.now();
  // the measure decides the third sparkline, so the columns may have to change before anything is
  // queried; this covers a control change, a back/forward, and the first load alike
  fixSort();
  if (colsFor !== state.measure) buildColumns();
  renderChips();
  const nf = [...state.filters.values()].reduce((a, v) => a + v.length, 0);
  for (const b of document.querySelectorAll(".clear-all")) {
    b.hidden = nf === 0;
    b.replaceChildren(`Clear ${nf === 1 ? "filter" : "filters"}`, el("span", { class: "count" }, String(nf)));
  }
  const measure = MEASURES[state.measure];
  let engineMs = 0, ran = 0;
  for (const p of panels) {
    if (id !== runId) return;
    if (only && !only.includes(p.name)) continue;
    const hide = (p.group && p.group !== measure.group) || (p.needsMonthly && !measure.monthly);
    p.node.hidden = hide;
    if (hide) continue;
    const table = typeof p.table === "function" ? p.table(measure) : p.table;
    if (!loaded.has(table)) { p.pending?.(); continue; }
    const sql = p.sql(state, measure);
    if (!sql) { p.empty?.(); continue; }
    try {
      const { rows, ms } = await q(sql, table);
      if (id !== runId) return;
      perf.panels.set(p.name, ms);
      engineMs += ms; ran++;
      p.render(rows, measure);
      const badge = p.node.querySelector(".ms");
      if (badge) badge.textContent = `${ms.toFixed(1)} ms`;
    } catch (e) {
      console.error(p.name, sql, e);
      p.node.querySelector(".body")?.replaceChildren(el("div", { class: "empty" }, `query failed: ${e.message.split("\n")[0]}`));
    }
  }
  // only a full pass gets to claim a settle time; a partial one (e.g. seasonality arriving late)
  // would otherwise report its own wall clock against every panel's engine time
  if (!only) setText("#settle", `${ran} panels settled in ${(performance.now() - t0).toFixed(0)} ms (${engineMs.toFixed(0)} ms in the engine)`);
}

// ---- totals
let lastTotals = null;
panels.push({
  name: "totals", table: (m) => m.table, node: $("#totals"),
  sql: (s, m) => totalsSql(s.filters, m),
  render(rows) {
    const r = rows[0] ?? {};
    lastTotals = r;
    const months = monthsInRange();
    const empty = !r.plants;
    const ys = yearsIn(state.filters);
    setText("#t-plants", fmtInt.format(r.plants ?? 0));
    setText("#t-gens", r.gens == null ? "–" : fmtInt.format(r.gens));
    setText("#t-twh", empty ? "–" : fmtN(r.twh, 0));
    setText("#t-gw", empty ? "–" : fmtN((r.gw_months ?? 0) / months, 0));
    setText("#t-cf", empty || r.cf == null ? "–" : fmtN(r.cf * 100, 0) + "%");
    setText("#t-range", empty ? "–" : ys.length === 1 ? `${ys[0]}` : `${ys[0]}–${ys.at(-1)}`);
  },
});

// ---- facets: the face shows plants, the tooltip adds generators
function facetPanel(dim) {
  const list = el("div", { class: "list body" });
  const hdr = {};
  const curSort = () => state.facetSort[dim.key] ?? (dim.orderBy === "dim" || dim.fixedOrder ? "k" : "v");
  const head = el("div", { class: "row head" },
    ...[["k", "value", "k"], ["n", "plants", "n"], ["v", "", "v"]].map(([s, label, cls]) =>
      (hdr[s] = el("button", { class: cls, title: "sort by this column", onclick: () => { state.facetSort[dim.key] = s; writeState({ replace: true }); } }, label))));
  const clear = el("a", { class: "clear", href: "#", onclick: (e) => { e.preventDefault(); clearKey(dim.key); } }, "clear");
  const node = el("section", { class: "panel facet" }, el("h3", {}, dim.title, clear, el("span", { class: "ms" })), head, list);
  return {
    name: dim.key, table: (m) => m.table, node, group: dim.group,
    sql: (s, m) => facetSql(dim, s.filters, m, curSort()),
    render(rows, measure) {
      const sel = new Set(state.filters.get(dim.key) ?? []);
      clear.hidden = sel.size === 0;
      hdr.v.textContent = measure.short;
      for (const [s, b] of Object.entries(hdr)) b.classList.toggle("on", curSort() === s);
      if (measure.ratio) rows = rows.filter((r) => r.v != null);
      if (dim.fixedOrder) { const ix = (k) => { const i = dim.fixedOrder.indexOf(k); return i < 0 ? 99 : i; }; rows.sort((a, b) => ix(a.k) - ix(b.k)); }
      const months = measure.perMonth ? monthsInRange() : 1;
      const maxV = Math.max(1e-9, ...rows.map((r) => (r.v ?? 0) / months));
      list.replaceChildren(...rows.map((r) => {
        const isNull = r.k === null || r.k === undefined || r.k === "";
        const token = isNull ? NULL_TOKEN : String(r.k);
        const v = (r.v ?? 0) / months;
        const label = isNull ? "(blank)" : dim.key === "decade" ? `${r.k}s` : String(r.k);
        const tip = r.g == null
          ? `${label}: ${compactInt(r.n)} plants`
          : `${label}: ${compactInt(r.n)} plants · ${compactInt(r.g)} generators`;
        return el("div", {
          class: "row" + (sel.has(token) ? " selected" : "") + (isNull ? " blank" : ""),
          title: tip, onclick: () => toggle(dim.key, token),
        },
          el("span", { class: "bar", style: `width:${(100 * v / maxV).toFixed(2)}%` }),
          el("span", { class: "k" }, dim.swatch ? el("i", { class: "swatch", style: `background:${fuelColor(r.k)}` }) : null, label),
          el("span", { class: "n" }, compactInt(r.n)),
          el("span", { class: "v" }, compact(v, measure.digits)),
        );
      }));
      if (!rows.length) list.replaceChildren(el("div", { class: "empty" }, "no values match"));
    },
  };
}
for (const d of DIMS) { const p = facetPanel(d); $("#facets").append(p.node); panels.push(p); }

// ---- stacked bars, shared by the years and seasonality charts
function stackedBars(target, series, ks, { labelOf, onClick, brushKey, h = 220, w = 640, unit = "" }) {
  const pad = { l: 46, r: 8, t: 8, b: 22 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const maxT = Math.max(1e-9, ...ks.map((k) => series.get(k)?.total ?? 0));
  const bw = iw / Math.max(1, ks.length);
  const y = (v) => pad.t + ih - (v / maxT) * ih;
  const sel = brushKey ? (state.filters.get(brushKey) ?? []) : [];
  const range = sel.length === 1 && /\.\./.test(sel[0]) ? sel[0].split("..").map(Number) : null;
  target.replaceChildren();
  target.setAttribute("viewBox", `0 0 ${w} ${h}`);
  for (let i = 0; i <= 4; i++) {
    const v = (maxT * i) / 4;
    target.append(svg("line", { x1: pad.l, x2: w - pad.r, y1: y(v), y2: y(v), stroke: "#edf1f2" }));
    const t = svg("text", { x: pad.l - 6, y: y(v) + 3, "text-anchor": "end", "font-size": 9, fill: "#6e8c91" });
    t.textContent = compact(v, 0); target.append(t);
  }
  ks.forEach((k, i) => {
    const g = series.get(k), x = pad.l + i * bw;
    const dim = range && (k < range[0] || k > range[1]);
    let acc = 0;
    const grp = svg("g", { opacity: dim ? 0.3 : 1, style: onClick ? "cursor:pointer" : "" });
    if (g) for (const f of FUEL_ORDER) {
      const v = g.parts.get(f);
      if (!v) continue;
      grp.append(svg("rect", { x: x + 1, y: y(acc + v), width: Math.max(1, bw - 2), height: Math.max(0, y(acc) - y(acc + v)), fill: fuelColor(f) }));
      acc += v;
    }
    const title = svg("title"); title.textContent = `${labelOf(k)}: ${compact(g?.total ?? 0, 2)} ${unit}`; grp.append(title);
    if (onClick) grp.addEventListener("click", () => onClick(k));
    target.append(grp);
    if (ks.length <= 20 || i % 2 === 0) {
      const t = svg("text", { x: x + bw / 2, y: h - 7, "text-anchor": "middle", "font-size": 9.5, fill: "#4c6267" });
      t.textContent = labelOf(k); target.append(t);
    }
  });
  return { bw, pad };
}

// ---- years (drag to brush a range; the wide table returns one row per fuel, so unpivot)
const yearSvg = $("#year-chart svg");
panels.push({
  name: "years", table: (m) => m.table, node: $("#year-chart"),
  sql: (s, m) => yearSql(s.filters, m),
  render(rows, measure) {
    $("#year-chart .sub").textContent = `${measure.label} by year, stacked by fuel type. Drag to select a year range.`;
    const series = new Map();
    const add = (year, fuel, v) => {
      if (!v) return;
      if (!series.has(year)) series.set(year, { parts: new Map(), total: 0 });
      const g = series.get(year);
      g.parts.set(fuel ?? "", (g.parts.get(fuel ?? "") ?? 0) + v);
      g.total += v;
    };
    if (measure.table === "pty") for (const r of rows) add(r.k, r.f, (r.v ?? 0) / (measure.perMonth ? (r.m || 12) : 1));
    else for (const r of rows) for (const y of YEARS) add(y, r.f, (r[`y${y}`] ?? 0) / (measure.perMonth ? (monthsPerYear[y] || 12) : 1));
    const ks = YEARS.filter((y) => series.has(y));
    const { bw, pad } = stackedBars(yearSvg, series, ks, { labelOf: String, brushKey: "year", h: 230, unit: measure.unit });
    let x0 = null, rect = null;
    const idx = (ev) => {
      const pt = yearSvg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
      const p = pt.matrixTransform(yearSvg.getScreenCTM().inverse());
      return Math.max(0, Math.min(ks.length - 1, Math.floor((p.x - pad.l) / bw)));
    };
    yearSvg.onpointerdown = (ev) => {
      x0 = idx(ev); rect = svg("rect", { class: "brush", y: pad.t, height: 230 - pad.t - 22 });
      yearSvg.append(rect); yearSvg.setPointerCapture(ev.pointerId);
    };
    yearSvg.onpointermove = (ev) => {
      if (x0 === null) return;
      const x1 = idx(ev), a = Math.min(x0, x1), b = Math.max(x0, x1);
      rect.setAttribute("x", pad.l + a * bw); rect.setAttribute("width", (b - a + 1) * bw);
    };
    yearSvg.onpointerup = (ev) => {
      if (x0 === null) return;
      const x1 = idx(ev), a = Math.min(x0, x1), b = Math.max(x0, x1);
      x0 = null; rect.remove();
      (a === 0 && b === ks.length - 1) ? setRange("year", null) : setRange("year", ks[a], ks[b]);
    };
    const sel = new Set(state.filters.get("fuel") ?? []);
    $("#year-chart .legend").replaceChildren(...FUEL_ORDER.filter((f) => [...series.values()].some((g) => g.parts.has(f))).map((f) =>
      el("span", { class: sel.has(f || NULL_TOKEN) ? "selected" : "", onclick: () => toggle("fuel", f || NULL_TOKEN) },
        el("i", { style: `background:${fuelColor(f)}` }), f || "(blank)")));
  },
});

// ---- seasonality (monthly columns, always on plant_tech_year)
const monthSvg = $("#month-chart svg");
panels.push({
  name: "season", table: "pty", node: $("#month-chart"), needsMonthly: true,
  sql: (s, m) => seasonSql(s.filters, m),
  pending() { $("#month-chart .sub").textContent = "loading the monthly table…"; },
  render(rows, measure) {
    $("#month-chart .sub").textContent = `${measure.label} by calendar month, summed over the selected years, stacked by fuel type.`;
    const series = new Map();
    for (let m = 1; m <= 12; m++) {
      const g = { parts: new Map(), total: 0 };
      for (const r of rows) { const v = r[`m${m}`] ?? 0; if (v) { g.parts.set(r.f ?? "", v); g.total += v; } }
      series.set(m, g);
    }
    stackedBars(monthSvg, series, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], { labelOf: (k) => MONTHS[k - 1], h: 170, unit: measure.unit });
  },
});

// ---- map
let plantMap = null, lastMapPoints = null;
function hoverHtml(props) {
  const m = MEASURES[state.measure];
  const body = `${esc(props.f || "(blank)")} · ${esc(compact(props.v, 2))} ${esc(m.unit)}<br><span class="pp-hint">click for details</span>`;
  if (!plantNames.has(props.p)) {
    plantLabel(props.p).then((l) => plantMap?.refreshHover(props.p, `<b>${esc(l)}</b><br>${body}`));
    return `<b>…</b><br>${body}`;
  }
  return `<b>${esc(plantNames.get(props.p))}</b><br>${body}`;
}
async function clickHtml(props) {
  const id = props.p;
  const [card, techs, ferc] = await Promise.all([
    q(plantCardSql(id, state.filters), "gw"),
    q(plantTechSql(id, state.filters), "gw"),
    loaded.has("pty") ? q(plantFercSql(id, state.filters), "pty").catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] }),
  ]);
  const r = card.rows[0];
  if (!r) return `<b>plant ${id}</b><br>no rows under the current filters`;
  plantNames.set(id, `${r.name}, ${r.state}`);
  if (r.wiki) plantWiki.set(id, r.wiki);
  const months = monthsInRange();
  const f = ferc.rows[0] ?? {};
  const row = (k, v) => (v == null || v === "" ? "" : `<div><span>${k}</span><span>${v}</span></div>`);
  const node = el("div", { class: "pp-card" });
  node.innerHTML =
    `<h4>${esc(r.name)} <small>${esc(r.state)}</small></h4>` +
    `<div class="pp-sub">${esc(r.utility ?? "")}${r.ba ? " · " + esc(r.ba) : ""}</div>` +
    `<div class="pp-rows">` +
    row("technology", techs.rows.map((t) => `${esc(t.k ?? "(blank)")}${t.cap_months ? " · " + fmtN(t.cap_months / months, 0) + " MW" : ""}`).join("<br>")) +
    row("generators", r.gens) +
    row("first online", r.first_year) +
    row("avg capacity", r.gw_months != null ? `${fmtN((r.gw_months / months) * 1000, 0)} MW` : null) +
    row("generation", r.twh != null ? `${fmtN(r.twh, 2)} TWh` : null) +
    row("capacity factor", r.cf != null ? fmtN(r.cf * 100, 0) + "%" : null) +
    row("CO₂ (CEMS)", r.co2_mt ? `${fmtN(r.co2_mt, 2)} Mt · ${fmtN(r.co2_mwh, 2)} t/MWh` : null) +
    row("plant in service", f.capex_bn != null ? `$${fmtN(f.capex_bn, 2)}bn (FERC 1)` : null) +
    row("operating cost", f.opex_mwh != null ? `$${fmtN(f.opex_mwh, 1)}/MWh (FERC 1)` : null) +
    `</div>`;
  const actions = el("div", { class: "pp-actions" });
  if (r.wiki) actions.append(el("a", { href: r.wiki, target: "_blank", rel: "noopener", class: "pp-btn" }, `GEM wiki: ${r.gem && r.gem !== r.name ? r.gem : "page"} ↗`));
  actions.append(el("button", { type: "button", class: "pp-btn secondary", onclick: () => toggle("plant", String(id)) }, "show only this plant"));
  node.append(actions);
  return node;
}
createPlantMap($("#map .mapbox"), { hoverHtml, clickHtml })
  .then((m) => { plantMap = m; window.__plantMap = m; if (lastMapPoints) m.update(lastMapPoints); })
  .catch((e) => { console.error("map failed", e); $("#map .sub").textContent = `map unavailable: ${e.message}`; });
$("#map .legend").replaceChildren(...FUEL_ORDER.filter((f) => f).map((f) => el("span", {}, el("i", { style: `background:${fuelColor(f)}` }), f)));
panels.push({
  name: "map", table: (m) => m.table, node: $("#map"),
  sql: (s, m) => mapSql(s.filters, m),
  render(rows, measure) {
    const months = measure.perMonth ? monthsInRange() : 1;
    const maxV = Math.max(1e-9, ...rows.map((r) => r.v ?? 0)) / months;
    lastMapPoints = rows.filter((r) => r.lat != null && r.lon != null && r.v != null && r.v > 0).map((r) => {
      const v = (r.v ?? 0) / months;
      return { p: r.p, f: r.f, lat: r.lat, lon: r.lon, v, r: 1.5 + 9 * Math.sqrt(Math.max(0, v) / maxV), c: fuelColor(r.f) };
    });
    plantMap?.update(lastMapPoints);
    $("#map .sub").textContent = `${fmtInt.format(lastMapPoints.length)} plant × fuel points with ${measure.label.toLowerCase()} > 0, area ∝ value. Hover for a summary, click for details.`;
  },
});

// ---- the grid: one row per generator, sparklines, windowed infinite scroll
const ghead = $("#grid .ghead"), grows = $("#grid .grows"), gtall = $("#grid .tall"), scroller = $("#grid-scroller");
const gview = $("#grid .gviewport");
const BUILD = "441f6806";

/**
 * A stale shell announces itself.
 *
 * index.html cannot carry a cache-busting query of its own, and the static host sends no
 * Cache-Control, so a browser is free to keep an old copy of the page and go on loading the asset
 * URLs that copy names. version.json is fetched uncached and compared with the stamp compiled into
 * this file: if they differ, the HTML in front of you is older than this script.
 */
(async function checkBuild() {
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
    const { build } = await r.json();
    if (!build || build === BUILD) return;
    console.warn(`page is build ${BUILD}, the server has ${build}`);
    document.body.prepend(el("div", { class: "stale-shell" },
      `This page is an old copy (${BUILD}); the server has ${build}. `,
      el("a", { href: "#", onclick: (e) => { e.preventDefault(); location.reload(); } }, "Reload"),
      " to update it."));
  } catch {}
})();
let HEAD_H = 26;   // measured after the first paint; the scroll height allows for it
// `dom` caches the built <tr>s per page so re-entering a page costs nothing; `want` is the page a
// drag is heading for, so a scrollbar drag issues one query at the end rather than one per event.
const grid = { pages: new Map(), dom: new Map(), inflight: new Set(), lo: 0, hi: -1, total: 0, token: 0, seq: 0, want: null, timer: 0,
  // `read` is the whole filtered result as typed arrays. Until it arrives the paged window serves the
  // grid; once it does, scrolling never queries again.
  read: null, allTimer: 0 };

/**
 * Generation and capacity factor are always the first two sparklines. The third follows the selected
 * measure and is simply absent when that measure has nothing per-generator to draw — no stand-in.
 * Changing the measure therefore changes the column set, so the header, the frozen-column offsets,
 * the track widths and the row pool are all rebuilt together.
 */
let GCOLS = gridCols(state.measure);
let FREEZE_LEFT = [];
let colsFor = null;      // the measure GCOLS was built for
const freezeClass = (i) => (GCOLS[i].freeze ? " freeze" + (FREEZE_LEFT[i + 1] ? "" : " freeze-last") : "");

function buildColumns() {
  colsFor = state.measure;
  GCOLS = gridCols(state.measure);
  $("#grid").style.setProperty("--grid-cols", GCOLS.map((c) => c.w ?? "1fr").join(" "));
  // Plant and Gen stay put when the grid is scrolled sideways: each frozen column is stuck at the
  // running width of the ones before it.
  let left = 0;
  FREEZE_LEFT = GCOLS.map((c) => {
    if (!c.freeze) return null;
    const at = left;
    left += parseFloat(c.w) || 0;
    return `${at}rem`;
  });
  ghead.replaceChildren(...GCOLS.map((c, i) => el("span", {
    class: (c.numeric ? "numeric " : "") + (c.series ? "seriescol" : "") + freezeClass(i),
    style: FREEZE_LEFT[i] ? `left:${FREEZE_LEFT[i]}` : "",
    title: c.series ? `${c.label}, ${YEARS[0]}–${YEARS.at(-1)}; bars outside the selected years are dimmed` : `sort by ${c.label}`,
    onclick: c.noSort ? null : () => {
      const dir = state.sort[0] === c.col ? (state.sort[1] === "desc" ? "asc" : "desc") : c.numeric ? "desc" : "asc";
      state.sort = [c.col, dir]; writeState({ replace: true });
    },
  }, c.label, c.noSort ? null : el("span", { class: "arrow" }))));
  measureAt = MEASURE_AT[MEASURE_SPARK[state.measure]?.series] ?? null;
  // the pool's cells are built per column, so it cannot survive a column change
  pool.length = 0;
  grows.replaceChildren();
  rendered = { first: 0, last: -1 };
}

/** The sort column can vanish with the measure; fall back to generation when it does. */
function fixSort() {
  if (!gridSortable(state.measure).has(state.sort[0])) state.sort = ["twh", "desc"];
}

/** Bars for one 17-year series as a single path; years outside the filter are dimmed. */
function sparkline(values, colour, { max = null, w = 62, h = 16 } = {}) {
  const sel = new Set(yearsIn(state.filters));
  const peak = max ?? Math.max(...values.filter((v) => v > 0), 0);
  const s = svg("svg", { class: "spark", viewBox: `0 0 ${w} ${h}`, width: w, height: h });
  if (!(peak > 0)) return s;
  const bw = w / YEARS.length;
  const d = { on: "", off: "" };
  values.forEach((v, i) => {
    if (!(v > 0)) return;
    const bh = Math.max(1, (v / peak) * (h - 1));
    d[sel.has(YEARS[i]) ? "on" : "off"] += `M${(i * bw).toFixed(1)},${(h - bh).toFixed(1)}h${(bw - 0.8).toFixed(1)}v${bh.toFixed(1)}h-${(bw - 0.8).toFixed(1)}Z`;
  });
  if (d.off) s.append(svg("path", { d: d.off, fill: colour, opacity: 0.22 }));
  if (d.on) s.append(svg("path", { d: d.on, fill: colour }));
  return s;
}

// ---- row pool -------------------------------------------------------------
// Scrolling never creates or inserts DOM. A fixed pool of <tr>s stays attached in order and only
// their contents are rewritten, so a scroll frame costs a few hundred property writes instead of
// building ~46 rows (which is what made fast drags white out).
const pool = [];

function buildSlot() {
  const cells = GCOLS.map((c, i) => {
    const cell = el("span", { class: (c.numeric ? "numeric" : "") + freezeClass(i), style: FREEZE_LEFT[i] ? `left:${FREEZE_LEFT[i]}` : "" });
    const parts = {};
    if (c.link) { parts.a = el("a", { href: "#" }); parts.small = el("small"); cell.append(parts.a, parts.small); }
    else if (c.external) { parts.a = el("a", { target: "_blank", rel: "noopener", class: "ext" }, "wiki ↗"); cell.append(parts.a); }
    else if (c.pill) { parts.pill = el("span", { class: "pill" }); cell.append(parts.pill); }
    else if (c.series) {
      // only a CO₂ series is empty *because* there is no monitor; say so there and nowhere else
      parts.na = el("span", { class: "na" }, c.cemsSeries ? "no CEMS" : "no data");
      parts.svg = svg("svg", { class: "spark", viewBox: "0 0 110 16", width: 110, height: 16 });
      parts.dim = svg("path", { opacity: 0.22 });
      parts.on = svg("path", {});
      parts.svg.append(parts.dim, parts.on);
      cell.append(parts.na, parts.svg);
    } else { parts.text = document.createTextNode(""); cell.append(parts.text); }
    return { cell, parts };
  });
  return { row: el("div", { class: "grow" }, ...cells.map((c) => c.cell)), cells, plant: null };
}

/** Bar path for one 17-year series, split into in-range and out-of-range years. */
function sparkPaths(values, peak, sel, w = 110, h = 16) {
  let on = "", dim = "";
  if (!(peak > 0)) return ["", ""];
  const bw = w / YEARS.length;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!(v > 0)) continue;
    const bh = Math.max(1, (v / peak) * (h - 1));
    const seg = `M${(i * bw).toFixed(1)},${(h - bh).toFixed(1)}h${(bw - 0.8).toFixed(1)}v${bh.toFixed(1)}h-${(bw - 0.8).toFixed(1)}Z`;
    if (sel.has(YEARS[i])) on += seg; else dim += seg;
  }
  return [on, dim];
}

// scratch arrays reused for every row, so filling a row allocates nothing
const gen = new Array(YEARS.length), cap = new Array(YEARS.length), cf = new Array(YEARS.length),
      msr = new Array(YEARS.length);

/**
 * Per-year value for the third sparkline. Bars are normalised to the row's own peak, so these only
 * have to get the shape right; the number beside the sparkline carries the units.
 */
const MEASURE_AT = {
  cap_mw:  (r, y) => { const m = r[`mon_${y}`] ?? 0; return m > 0 ? (r[`cap_${y}`] ?? 0) / m : 0; },
  co2:     (r, y) => r[`co2_${y}`] ?? 0,
  co2_mwh: (r, y) => { const g = r[`gen_${y}`] ?? 0; return g > 0 ? (r[`co2_${y}`] ?? 0) / g : 0; },
  co2_mw:  (r, y) => { const c = r[`cap_${y}`] ?? 0; return c > 0 ? (r[`co2_${y}`] ?? 0) / c : 0; },
  cost:    (r, y) => r[`cost_${y}`] ?? 0,
  mmbtu:   (r, y) => r[`mmbtu_${y}`] ?? 0,
};
let measureAt = null;   // set by buildColumns(); null when the measure has no third sparkline

function fillSlot(slot, r, sel) {
  slot.row.hidden = false;
  slot.plant = r.plant_id_eia;
  const colour = fuelColor(guessFuel(r));
  for (let i = 0; i < YEARS.length; i++) {
    const y = YEARS[i];
    gen[i] = r[`gen_${y}`] ?? 0; cap[i] = r[`cap_${y}`] ?? 0;
    cf[i] = cap[i] > 0 ? gen[i] / (cap[i] * 730.5) : 0;
    if (measureAt) msr[i] = measureAt(r, y);
  }
  if (r.plant_name_eia) plantNames.set(r.plant_id_eia, `${r.plant_name_eia}, ${r.state}`);
  if (r.gem_wiki_url) plantWiki.set(r.plant_id_eia, r.gem_wiki_url);
  for (let ci = 0; ci < GCOLS.length; ci++) {
    const c = GCOLS[ci], { parts } = slot.cells[ci];
    const v = r[c.col];
    if (c.link) { parts.a.textContent = v ?? ""; parts.small.textContent = r.state ? " " + r.state : ""; continue; }
    if (c.external) { if (v) { parts.a.href = String(v); parts.a.hidden = false; } else parts.a.hidden = true; continue; }
    if (c.pill) { parts.pill.textContent = v ?? ""; parts.pill.className = `pill ${String(v ?? "").replace(/\W/g, "")}`; continue; }
    if (c.series) {
      const series = c.series === "gen" ? gen : c.series === "cf" ? cf : msr;
      const none = (c.cemsSeries && !r.has_cems) || !series.some((x) => x > 0);
      parts.na.hidden = !none; parts.svg.style.display = none ? "none" : "";
      if (!none) {
        let peak = c.series === "cf" ? 1 : 0;
        if (c.series !== "cf") for (const x of series) if (x > peak) peak = x;
        const [on, dim] = sparkPaths(series, peak, sel);
        parts.on.setAttribute("d", on); parts.on.setAttribute("fill", colour);
        parts.dim.setAttribute("d", dim); parts.dim.setAttribute("fill", colour);
      }
      continue;
    }
    if (c.pct) { parts.text.nodeValue = v == null ? "" : fmtN(v * 100, 0) + "%"; continue; }
    if (c.cems && !r.has_cems) { parts.text.nodeValue = ""; continue; }   // no monitor is not zero
    parts.text.nodeValue = v == null ? "" : c.plain ? String(v) : c.numeric ? fmtN(v, c.digits) : String(v);
  }
}

/**
 * No row behind this slot, so it must read as empty.
 *
 * `row.hidden = true` alone was not enough: the UA's `[hidden] { display: none }` is one selector,
 * and `.grid .grow { display: grid }` outranks it, so a "hidden" row kept showing whatever it last
 * held — the stale rows that looked like placeholders past the end of the data. theme.css now
 * carries an explicit `.grid .grow[hidden]` rule; the cells are cleared too so nothing can leak.
 */
function blankSlot(slot) {
  if (slot.row.hidden) return;                 // already blank; do not touch the DOM again
  slot.row.hidden = true;
  slot.plant = null;
  for (let ci = 0; ci < GCOLS.length; ci++) {
    const { parts } = slot.cells[ci];
    if (parts.text) parts.text.nodeValue = "";
    if (parts.small) parts.small.textContent = "";
    if (parts.pill) { parts.pill.textContent = ""; parts.pill.className = "pill"; }
    if (parts.a) { parts.a.hidden = true; if (GCOLS[ci].link) parts.a.textContent = ""; }
    if (parts.svg) parts.svg.style.display = "none";
    if (parts.na) parts.na.hidden = true;
  }
}

// one delegated listener instead of one per row
grows.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (!a || a.classList.contains("ext")) return;
  e.preventDefault();
  const row = a.closest(".grow");
  const slot = pool.find((s) => s.row === row);
  if (slot?.plant != null) toggle("plant", String(slot.plant));
});

// the grid query does not select fuel (it is implied by technology); colour by technology keyword
function guessFuel(r) {
  const t = (r.technology_description ?? "").toLowerCase();
  if (t.includes("coal") || t.includes("petroleum coke")) return "coal";
  if (t.includes("nuclear")) return "nuclear";
  if (t.includes("hydro") || t.includes("pumped")) return "hydro";
  if (t.includes("wind")) return "wind";
  if (t.includes("solar")) return "solar";
  if (t.includes("gas") || t.includes("combined cycle") || t.includes("combustion turbine")) return "gas";
  if (t.includes("petroleum")) return "oil";
  return "other";
}

let rendered = { first: 0, last: -1 };   // absolute row indices currently shown by the pool

// first build, now that the pool and the rendered range exist for buildColumns() to reset
fixSort();
buildColumns();

function rowData(i) {
  if (grid.read) return grid.read(i);
  const p = Math.floor(i / PAGE), k = i - p * PAGE;
  return grid.pages.get(p)?.[k] ?? null;
}

/** Fetch the entire filtered result once, so scrolling stops touching the engine. */
async function loadAll() {
  const token = grid.token;
  if (!grid.total || grid.read) return;
  try {
    const t0 = performance.now();
    const r = await db.query(gridSql(state.filters, state.sort, { limit: grid.total, measure: state.measure }), { table: "gw" });
    if (token !== grid.token) return;
    grid.read = makeReader(r);
    window.__gridAll = true;
    grid.lo = 0; grid.hi = Math.ceil(grid.total / PAGE) - 1;
    console.info(`grid: all ${grid.total} rows in memory, ${(performance.now() - t0).toFixed(0)} ms`);
    paint();
  } catch (e) { console.warn("full grid fetch failed, staying paged", e); }
}

function headArrows() {
  for (const [k, span] of [...ghead.children].entries()) {
    const c = GCOLS[k];
    const arrow = span.querySelector(".arrow");      // sparkline columns have no sort arrow
    if (!arrow) continue;
    span.classList.toggle("sorted", state.sort[0] === c.col);
    arrow.textContent = state.sort[0] === c.col ? (state.sort[1] === "desc" ? "▼" : "▲") : "";
  }
}

/**
 * The scroller's height comes from CSS and is never written back, so the grid never changes size.
 *
 * An earlier version sized the pool from `scroller.clientHeight` and then set `scroller.style.height`
 * to a whole number of rows. With `box-sizing: border-box` the 1px top border comes out of the height
 * we set, so every pass measured a pixel less than the last; after 25 passes that is a whole row
 * gone, and it kept ratcheting down to the `Math.max(1, ...)` floor. On a phone, where a scroll
 * gesture fires many paints, the grid walked itself down to a single row. Measure on resize only.
 */
let availH = 0, slackH = 0;
const measureAvail = () => { availH = scroller.clientHeight; };

/**
 * Size the pool to the viewport and attach it once; afterwards paint() only rewrites contents.
 * Whole rows only: the leftover strip under the last row stays empty rather than showing a half row.
 */
function ensurePool() {
  if (!availH) measureAvail();
  if (forceNoSticky && !stickyBroken) { stickyBroken = true; scroller.classList.add("nosticky"); }
  const need = Math.max(1, Math.floor((availH - HEAD_H) / ROW_H));
  slackH = Math.max(0, availH - HEAD_H - need * ROW_H);
  if (pool.length === need && grows.firstChild) return false;
  while (pool.length < need) pool.push(buildSlot());
  pool.length = need;
  grows.replaceChildren(...pool.map((s) => s.row));
  return true;
}

/**
 * Rows are pinned by `position: sticky` on `.gviewport`, which the compositor normally handles for
 * free. WebKit does not always honour that inside a scroller that also scrolls horizontally: during
 * a momentum flick the sticky block can be left behind, so the row block slides up out of the box
 * and you are left looking at one row, or none, with blank space under it. That is not something
 * Blink reproduces, so instead of trusting sticky we check it and fall back.
 *
 * The check is two rect reads: the header's top should sit on the scroller's top. If it has drifted,
 * switch the viewport to absolute positioning driven by a transform, which no engine gets wrong.
 */
let stickyBroken = false, stickyTick = 0, stickyBad = 0;
const forceNoSticky = new URLSearchParams(location.search).get("gridsticky") === "off";

function holdViewport() {
  if (stickyBroken) {
    gview.style.transform = `translate3d(0,${scroller.scrollTop}px,0)`;
    return;
  }
  if (scroller.scrollTop < ROW_H) return;        // at the top there is nothing to detect
  if (stickyTick++ % 8) return;                  // sampled, so scrolling stays cheap
  const drift = ghead.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  // A few pixels is a transient: the rect is read mid-scroll, before the compositor has settled the
  // sticky offset, and Blink shows that routinely. A real failure leaves the block a row or more
  // behind and keeps doing it, so only switch after it is out by a whole row twice running.
  if (Math.abs(drift) < ROW_H) { stickyBad = 0; return; }
  if (++stickyBad < 2) return;
  stickyBroken = true;
  scroller.classList.add("nosticky");
  gview.style.transform = `translate3d(0,${scroller.scrollTop}px,0)`;
  console.warn(`grid: sticky header drifted ${drift.toFixed(0)}px twice, switching to transform positioning`);
}

function paint() {
  headArrows();
  if (!grid.total) {
    grows.replaceChildren(el("div", { class: "empty" }, "no generators match these filters"));
    pool.length = 0;
    rendered = { first: 0, last: -1 };
    setText("#grid .count", "");
    gtall.style.height = "0px";
    return;
  }
  HEAD_H = ghead.offsetHeight || HEAD_H;      // taller when the labels wrap on a narrow screen
  const rebuilt = ensurePool();
  // The slack is the sub-row strip the pool does not cover. Adding it to the scroll height keeps the
  // last row reachable; without it the bottom of the list stops one row short.
  gtall.style.height = `${HEAD_H + grid.total * ROW_H + slackH}px`;
  const availFirst = grid.read ? 0 : grid.lo * PAGE;
  const availLast = grid.read ? grid.total - 1 : Math.min(grid.total, (grid.hi + 1) * PAGE) - 1;
  let first = Math.max(availFirst, Math.round(scroller.scrollTop / ROW_H));
  first = Math.min(first, Math.max(availFirst, availLast - pool.length + 1));
  const last = Math.min(availLast, first + pool.length - 1);
  if (last < first) return;                      // mid-jump: leave what is on screen
  holdViewport();                                // before the early-out: position must track scroll
  if (!rebuilt && first === rendered.first && last === rendered.last) return;
  const sel = new Set(yearsIn(state.filters));
  for (let s = 0; s < pool.length; s++) {
    const i2 = first + s;
    const d = i2 <= last ? rowData(i2) : null;
    if (d) fillSlot(pool[s], d, sel); else blankSlot(pool[s]);
  }
  rendered = { first, last };
  window.__rendered = rendered;
  if (dbg) showDebug();
  setText("#grid .count", `${fmtInt.format(grid.total)} generators · rows ${fmtInt.format(first + 1)}–${fmtInt.format(last + 1)} by ${GCOLS.find((c) => c.col === state.sort[0])?.label ?? "generation"} ${state.sort[1]}`);
}

async function loadPage(p) {
  if (p < 0 || grid.pages.has(p) || grid.inflight.has(p)) return;
  if (grid.total && p * PAGE >= grid.total) return;
  const token = grid.token, seq = grid.seq;   // a filter change or a scroll jump invalidates this fetch
  grid.inflight.add(p);
  try {
    const { rows, ms } = await q(gridSql(state.filters, state.sort, { limit: PAGE, offset: p * PAGE, measure: state.measure }), "gw");
    if (token !== grid.token || seq !== grid.seq) return;
    grid.pages.set(p, rows);
    grid.lo = Math.min(grid.lo, p); grid.hi = Math.max(grid.hi, p);
    // sliding window: drop whichever end is furthest from the page just loaded
    while (grid.hi - grid.lo + 1 > MAX_PAGES) {
      const drop = Math.abs(grid.hi - p) > Math.abs(p - grid.lo) ? grid.hi-- : grid.lo++;
      grid.pages.delete(drop); grid.dom.delete(drop);
    }
    if (grid.want === p) grid.want = null;
    perf.panels.set("grid", ms);
    const badge = $("#grid .ms"); if (badge) badge.textContent = `${ms.toFixed(1)} ms`;
    paint();
  } finally { grid.inflight.delete(p); }
}

panels.push({
  name: "grid", table: "gw", node: $("#grid"),
  sql: (s) => gridCountSql(s.filters),
  pending() { $("#grid .count").textContent = "loading…"; },
  async render(rows) {
    grid.token++; grid.seq++;
    clearTimeout(grid.timer); clearTimeout(grid.allTimer); grid.want = null;
    grid.read = null; window.__gridAll = false;
    grid.pages.clear(); grid.dom.clear(); grid.inflight.clear(); grid.lo = 0; grid.hi = -1; rendered = { first: 0, last: -1 }; pool.length = 0; grows.replaceChildren();
    grid.total = rows[0]?.rows ?? 0;
    scroller.scrollTop = 0;
    paint();
    await loadPage(0);
    // the first page shows immediately; the rest arrives in the background a moment later, so a burst
    // of facet clicks is not stuck behind a 250 ms full fetch
    clearTimeout(grid.allTimer);
    grid.allTimer = setTimeout(loadAll, 350);
  },
});

/**
 * `?griddebug=1` pins a readout of every number the row count depends on, so a device I cannot
 * attach a debugger to can still say what it is measuring.
 */
const dbg = new URLSearchParams(location.search).get("griddebug") === "1"
  ? Object.assign(document.createElement("div"), { id: "griddebug" }) : null;
if (dbg) document.body.append(dbg);
function showDebug() {
  const shown = pool.filter((s) => !s.row.hidden).length;
  dbg.textContent = [
    `build ${BUILD}`,
    `scroller ${scroller.clientHeight}px (rect ${scroller.getBoundingClientRect().height.toFixed(0)}) head ${HEAD_H} slack ${slackH}`,
    `pool ${pool.length} · showing ${shown} · rows ${rendered.first}-${rendered.last} of ${grid.total}`,
    `scrollTop ${scroller.scrollTop.toFixed(0)} · hold ${stickyBroken ? "transform" : "sticky"}`,
    `viewport ${innerWidth}x${innerHeight} visual ${(visualViewport?.width ?? 0).toFixed(0)}x${(visualViewport?.height ?? 0).toFixed(0)} dpr ${devicePixelRatio}`,
    `whole result in memory: ${!!grid.read}`,
  ].join("\n");
}

// A resize changes how many rows fit. iOS Safari growing or shrinking the page as the URL bar
// slides is exactly this case, and it reports through visualViewport rather than window resize on
// some versions, so listen to both. Debounced, and it re-measures rather than guessing.
let resizeTimer = 0;
function onViewportChange() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    measureAvail();
    rendered = { first: 0, last: -1 };   // force a repaint even if the row range is unchanged
    paint();
  }, 150);
}
window.addEventListener("resize", onViewportChange);
window.addEventListener("orientationchange", onViewportChange);
window.visualViewport?.addEventListener("resize", onViewportChange);

// The data window follows the rendered rows: when the visible slice nears either edge of what is
// loaded, pull in the neighbouring page. Only matters before the whole result lands.
function topUpWindow() {
  if (grid.read || grid.hi < grid.lo) return;
  if (rendered.last >= (grid.hi + 1) * PAGE - OVERSCAN) loadPage(grid.hi + 1);
  if (rendered.first <= grid.lo * PAGE + OVERSCAN && grid.lo > 0) loadPage(grid.lo - 1);
}

// The sentinels only ever reach the neighbouring page, so dragging the scrollbar across thousands of
// rows landed in an empty region. On any scroll that leaves the loaded window, move the window to
// wherever we actually are and fetch that page.
let scrollRaf = 0;
scroller.addEventListener("scroll", () => {
  if (!grid.total) return;
  // Paint synchronously here rather than in requestAnimationFrame. The scroll event fires before the
  // frame is composited, so the rows land in the same frame as the movement; deferring to rAF puts
  // the DOM a frame behind, and at speed a frame behind composites as blank.
  paint();
  if (grid.read) return;                       // whole result in memory: no paging, no queries
  topUpWindow();
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const page = Math.min(Math.floor(scroller.scrollTop / (ROW_H * PAGE)), Math.floor((grid.total - 1) / PAGE));
    if (page >= grid.lo && page <= grid.hi) { grid.want = null; clearTimeout(grid.timer); return; }
    // instant feedback: the rows cannot arrive for ~160 ms, but the position can
    setText("#grid .count", `${fmtInt.format(grid.total)} generators · row ${fmtInt.format(Math.floor(scroller.scrollTop / ROW_H) + 1)}…`);
    if (page === grid.want) return;            // a jump to here is already scheduled
    // Note this deliberately does NOT check whether a fetch is in flight: a drag keeps moving, and
    // the newest position must win. Debounce so one drag issues one query instead of thirty.
    grid.want = page;
    clearTimeout(grid.timer);
    grid.timer = setTimeout(() => jumpTo(page), 90);
  });
});

/** Move the window to `page`. Old rows stay on screen until the new ones land, so there is no flash. */
function jumpTo(page) {
  if (page >= grid.lo && page <= grid.hi) return;
  grid.seq++;                                   // discard anything already in flight
  grid.inflight.clear();
  grid.pages.clear(); grid.dom.clear();
  grid.lo = page; grid.hi = page - 1;
  loadPage(page);
}

// ---------------------------------------------------------------- controls
function renderChips() {
  const chips = [];
  for (const [k, vals] of state.filters) {
    const dim = ALL_DIMS.find((d) => d.key === k);
    for (const v of vals) {
      if (k === "plant") {
        const id = Number(v);
        const label = `plant: ${plantNames.get(id) ?? v}`;
        if (!plantNames.has(id) && db) plantLabel(id).then(renderChips);
        const chip = el("span", { class: "chip" }, label);
        if (plantWiki.has(id)) chip.append(" ", el("a", { href: plantWiki.get(id), target: "_blank", rel: "noopener", class: "ext", title: "open the GEM wiki page" }, "GEM wiki ↗"));
        chip.append(el("button", { class: "x", type: "button", title: "remove this filter", onclick: () => toggle(k, v) }, "×"));
        chips.push(chip);
        continue;
      }
      const label = k === SEARCH_PARAM ? `search: ${v}`
        : `${dim?.title ?? k}: ${v === NULL_TOKEN ? "(blank)" : k === "decade" ? v + "s" : v.replace("..", "–")}`;
      chips.push(el("span", { class: "chip" }, label, el("button", { class: "x", type: "button", title: "remove this filter", onclick: () => toggle(k, v) }, "×")));
    }
  }
  $("#chips").replaceChildren(...chips);
}
function syncControls() {
  $("#measure").value = state.measure;
  if ($("#q") !== document.activeElement) $("#q").value = state.filters.get(SEARCH_PARAM)?.[0] ?? "";
}
$("#measure").addEventListener("change", (e) => { state.measure = e.target.value; writeState({ replace: true }); });
let qTimer = null;
$("#q").addEventListener("input", (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    const v = e.target.value.trim();
    v ? state.filters.set(SEARCH_PARAM, [v]) : state.filters.delete(SEARCH_PARAM);
    writeState({ replace: true });
  }, 250);
});
$("#q").addEventListener("keydown", (e) => { if (e.key === "Escape" && e.target.value) { e.target.value = ""; e.target.dispatchEvent(new Event("input")); } });
for (const b of document.querySelectorAll(".clear-all")) b.addEventListener("click", clearAll);
$("#show-ms").addEventListener("change", (e) => { document.body.classList.toggle("show-ms", e.target.checked); try { localStorage.setItem("showMs", e.target.checked ? "1" : ""); } catch {} });
try { if (localStorage.getItem("showMs")) { $("#show-ms").checked = true; document.body.classList.add("show-ms"); } } catch {}
$("#reset").addEventListener("click", async () => {
  db?.close();
  try {
    const root = await navigator.storage.getDirectory();
    for (const n of ["facetful-cache", OPFS_DIR]) { try { await root.removeEntry(n, { recursive: true }); } catch {} }
  } catch {}
  location.reload();
});

// ---------------------------------------------------------------- boot
(async () => {
  const loading = $("#loading"), steps = $("#loading .steps"), bar = $("#loading progress"), sub = $("#loading .bytes");
  const log = [];
  const status = (msg, frac, bytes) => {
    if (msg) { log.push(msg); steps.textContent = log.slice(-4).join("\n"); }
    if (frac == null) bar.removeAttribute("value"); else bar.value = frac;
    if (bytes != null) sub.textContent = bytes;
  };
  syncControls();
  try {
    status("starting facetful worker");
    db = await Facetful.open({
      wasmUrl, workerUrl,
    });
    window.__db = db;   // for the measurement harnesses; the OPFS image is an exclusive handle
    const info = (i) => `${compactInt(i.rows)} rows via ${i.source} in ${(i.openMs / 1000).toFixed(1)} s`;
    // the 3 MB generator table first: the page is interactive before the monthly table arrives
    const a = await openTable("gw", status);
    try {
      const m = (await q(monthsPerYearSql(), "gw")).rows[0] ?? {};
      monthsPerYear = Object.fromEntries(YEARS.map((y) => [y, m[`m${y}`] || 12]));
    } catch (e) { console.warn("month counts unavailable, assuming 12 per year", e); }
    loading.hidden = true;
    $("#open-info").textContent = `${TABLES.gw}: ${info(a)}`;
    await refresh();
    const b = await openTable("pty", status);
    $("#open-info").textContent += ` · ${TABLES.pty}: ${info(b)}`;
    await refresh(["season"]);
  } catch (e) {
    console.error(e);
    steps.textContent = ""; bar.remove();
    $("#loading .err").textContent = `Could not open the data.\n${e.message}\n\nServe the pudl directory statically and open /explorer/. Needs data/${TABLES.gw}.facetful.gz and data/${TABLES.pty}.facetful.gz.`;
  }
})();
