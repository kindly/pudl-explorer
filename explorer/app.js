// PUDL generator explorer on facetful. One filter state (the URL query
// string) drives every panel; each panel is one GROUP BY over the same
// WHERE. Two tables: plant_tech_year for facets/charts/map, generator_year
// for the grid. No build step: plain ES modules, vendored facetful.
import { Facetful } from "./vendor/facetful/index.js";
import { createPlantMap } from "./map.js";
import {
  TABLES, DIMS, ALL_DIMS, MEASURES, SEARCH_PARAM, NULL_TOKEN, GRID_COLS,
  facetSql, totalsSql, yearSql, seasonSql, mapSql, gridSql, plantNameSql, plantCardSql, plantTechSql,
} from "./sql.js";

// ---------------------------------------------------------------- config
const DATA_DIR = "../data/";
const OPFS_DIR = "pudl"; // our OPFS images live here, one per table per data-file version

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
const fmtInt = new Intl.NumberFormat("en-US");
const fmtN = (v, d = 1) => (v == null || Number.isNaN(v) ? "" : new Intl.NumberFormat("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }).format(v));
// measures: keep 4-5 significant figures below 100k, abbreviate above
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
// row counts: integers, abbreviated only when long
const compactInt = (v) => (v == null ? "" : Math.abs(v) >= 1e6 ? fmtN(v / 1e6, 2) + "M" : Math.abs(v) >= 1e5 ? fmtN(v / 1e3, 0) + "k" : fmtInt.format(v));

// ---------------------------------------------------------------- state
/** Filters live in the URL. Map<key, string[]> for dims + q; scalar params separately. */
function readState() {
  const p = new URLSearchParams(location.search);
  const filters = new Map();
  for (const d of ALL_DIMS) if (p.has(d.key)) filters.set(d.key, p.getAll(d.key));
  if (p.get(SEARCH_PARAM)) filters.set(SEARCH_PARAM, [p.get(SEARCH_PARAM)]);
  const [sc, sd] = (p.get("sort") ?? "net_generation_mwh:desc").split(":");
  return {
    filters,
    measure: MEASURES[p.get("m")] ? p.get("m") : "twh",
    sort: [GRID_COLS.some((c) => c.col === sc) ? sc : "net_generation_mwh", sd === "asc" ? "asc" : "desc"],
    facetSort: Object.fromEntries((p.get("fs") ?? "").split(",").filter(Boolean).map((s) => s.split(":"))),
  };
}
let state = readState();

function writeState({ replace = false } = {}) {
  const p = new URLSearchParams();
  for (const [k, vals] of state.filters) for (const v of vals) p.append(k, v);
  if (state.measure !== "twh") p.set("m", state.measure);
  if (state.sort.join(":") !== "net_generation_mwh:desc") p.set("sort", state.sort.join(":"));
  const fs = Object.entries(state.facetSort).filter(([, v]) => v && v !== "v").map((e) => e.join(":")).join(",");
  if (fs) p.set("fs", fs);
  const url = "?" + p.toString();
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
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
function setRange(key, lo, hi) {
  if (lo == null) state.filters.delete(key);
  else state.filters.set(key, [`${lo}..${hi}`]);
  writeState();
}
function clearKey(key) { state.filters.delete(key); writeState(); }
function clearAll() { state.filters.clear(); writeState(); }

// ---------------------------------------------------------------- db
let db = null;
const loaded = new Set(); // table handles that are open
let maxYear = 2026; // learned from the data at boot
const perf = { panels: new Map(), settleStart: 0, settleMs: 0 };
const plantNames = new Map(); // plant_id_eia -> "Name, ST" for chips and tooltips

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let got = 0;
  const counted = res.body.pipeThrough(new TransformStream({
    transform(chunk, ctrl) { got += chunk.byteLength; onProgress(got, total); ctrl.enqueue(chunk); },
  }));
  if (!url.endsWith(".gz")) return new Response(counted).arrayBuffer();
  // Some hosts serve .gz with Content-Encoding: gzip, in which case the browser has already inflated it.
  // Peek at the first two bytes: only gunzip ourselves when the gzip magic (1f 8b) is still there.
  const reader = counted.getReader();
  const first = await reader.read();
  if (first.done) return new ArrayBuffer(0);
  const isGzip = first.value[0] === 0x1f && first.value[1] === 0x8b;
  const rest = new ReadableStream({
    start(ctrl) { ctrl.enqueue(first.value); },
    async pull(ctrl) { const { done, value } = await reader.read(); if (done) ctrl.close(); else ctrl.enqueue(value); },
  });
  return new Response(isGzip ? rest.pipeThrough(new DecompressionStream("gzip")) : rest).arrayBuffer();
}

/** A short version token for a served file: ETag if present, else size + last-modified. */
async function fileVersion(url) {
  try {
    const r = await fetch(url, { method: "HEAD" });
    if (!r.ok) return null;
    const key = r.headers.get("etag") || `${r.headers.get("content-length")}-${r.headers.get("last-modified")}`;
    return key.replace(/[^A-Za-z0-9]+/g, "").slice(-24) || "v0";
  } catch { return null; }
}

/** Delete files in our OPFS dir whose names start with `prefix` but are not `keep` (old data versions). */
async function pruneOpfsDir(dirName, prefix, keep) {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(dirName, { create: true });
    for await (const name of dir.keys()) {
      if (name.startsWith(prefix) && name !== keep) { try { await dir.removeEntry(name); console.info("removed stale OPFS image", name); } catch {} }
    }
  } catch { /* no OPFS: nothing to prune */ }
}

/** Open one table: OPFS image if the current version is cached, else fetch .facetful.gz, gunzip, store, open. */
async function openTable(key, status) {
  const t0 = performance.now();
  const file = TABLES[key].file;
  const gzUrl = `${DATA_DIR}${file}.facetful.gz`;
  const version = (await fileVersion(gzUrl)) ?? "v0";
  const name = `${file}-${version}.facetful`;
  const path = `${OPFS_DIR}/${name}`;
  await pruneOpfsDir(OPFS_DIR, `${file}-`, name);
  let info;
  try {
    info = await db.loadOpfs(key, path);
    info.source = "OPFS";
  } catch {
    status(`fetching ${file}.facetful.gz`);
    const buf = await fetchWithProgress(gzUrl, (got, total) => status(null, total ? got / total : null, `${(got / 1e6).toFixed(0)}${total ? " / " + (total / 1e6).toFixed(0) : ""} MB`));
    try {
      await db.storeOpfs(path, buf.slice(0));
      info = await db.loadOpfs(key, path);
      info.source = "fetched → OPFS";
    } catch {
      info = await db.load(key, buf);
      info.source = "fetched, in memory (no OPFS)";
    }
  }
  loaded.add(key);
  info.openMs = performance.now() - t0;
  return info;
}

/** Run one query against a table; returns rows + worker time. */
async function q(sql, table = "pty") {
  const r = await db.query(sql, { table });
  return { rows: [...r.rows()], ms: r.elapsedMs, raw: r };
}

const plantWiki = new Map(); // plant_id_eia -> GEM wiki URL (when GEM knows the plant)
async function plantLabel(id) {
  if (plantNames.has(id)) return plantNames.get(id);
  try {
    const { rows } = await q(plantNameSql(id));
    const label = rows[0] ? `${rows[0].name}, ${rows[0].state}` : `plant ${id}`;
    plantNames.set(id, label);
    if (rows[0]?.wiki) plantWiki.set(id, rows[0].wiki);
    return label;
  } catch { return `plant ${id}`; }
}

// ---------------------------------------------------------------- panels
const panels = []; // { name, table, sql(state) -> string|null, render(rows, ms), node }
let runId = 0;

async function refresh(only = null) {
  const id = ++runId;
  perf.settleStart = performance.now();
  renderChips();
  const nf = [...state.filters.values()].reduce((a, v) => a + v.length, 0);
  for (const b of document.querySelectorAll(".clear-all")) {
    b.hidden = nf === 0;
    b.replaceChildren(`Clear ${nf === 1 ? "filter" : "filters"}`, el("span", { class: "count" }, String(nf)));
  }
  const measure = MEASURES[state.measure];
  for (const p of panels) {
    if (id !== runId) return;
    if (only && !only.includes(p.name)) continue;
    // panels that only make sense for some measures: hide, and skip their queries
    const hide = (p.group && p.group !== measure.group) || (p.needsMonthly && !measure.monthly);
    p.node.hidden = hide;
    if (hide) continue;
    if (!loaded.has(p.table)) { p.pending?.(); continue; }
    const sql = p.sql(state);
    if (!sql) { p.empty?.(); continue; }
    try {
      const { rows, ms, raw } = await q(sql, p.table);
      if (id !== runId) return;
      perf.panels.set(p.name, ms);
      p.render(rows, ms, raw);
      const badge = p.node.querySelector(".ms");
      if (badge) badge.textContent = `${ms.toFixed(1)} ms`;
    } catch (e) {
      console.error(p.name, sql, e);
      p.node.querySelector(".body")?.replaceChildren(el("div", { class: "empty" }, `query failed: ${e.message.split("\n")[0]}`));
    }
  }
  perf.settleMs = performance.now() - perf.settleStart;
  const total = [...perf.panels.values()].reduce((a, b) => a + b, 0);
  $("#settle").textContent = `${panels.length} panels settled in ${perf.settleMs.toFixed(0)} ms (${total.toFixed(0)} ms in the engine)`;
}

// ---- totals (header)
let lastTotals = null;
/** Calendar months covered by the current year filter, for turning capacity-months into average GW. */
function monthsInRange(t) {
  if (!t || !t.n) return 1;
  const full = (t.y1 - t.y0 + (t.y1 === maxYear ? 0 : 1)) * 12;
  return full + (t.y1 === maxYear ? (t.m_last || 12) : 0);
}
panels.push({
  name: "totals", table: "pty", node: $("#totals"),
  sql: (s) => totalsSql(s.filters, maxYear),
  render(rows) {
    const r = rows[0] ?? {};
    lastTotals = r;
    const empty = !r.n;
    $("#t-plants").textContent = fmtInt.format(r.plants ?? 0);
    $("#t-twh").textContent = empty ? "–" : fmtN(r.twh, 0);
    $("#t-gw").textContent = empty ? "–" : fmtN((r.gw_months ?? 0) / monthsInRange(r), 0);
    $("#t-cf").textContent = empty || r.cf == null ? "–" : fmtN(r.cf * 100, 0) + "%";
    $("#t-range").textContent = empty ? "–" : r.y0 === r.y1 ? `${r.y0}` : `${r.y0}–${r.y1}`;
  },
});

// ---- facets
function facetPanel(dim) {
  const list = el("div", { class: "list body" });
  const hdr = {};
  const curSort = () => state.facetSort[dim.key] ?? (dim.orderBy === "dim" || dim.fixedOrder ? "k" : "v");
  const head = el("div", { class: "row head" },
    ...[["k", "value", "k"], ["n", "rows", "n"], ["v", "", "v"]].map(([s, label, cls]) =>
      (hdr[s] = el("button", { class: cls, title: "sort by this column", onclick: () => { state.facetSort[dim.key] = s; writeState({ replace: true }); } }, label))));
  const clear = el("a", { class: "clear", href: "#", onclick: (e) => { e.preventDefault(); clearKey(dim.key); } }, "clear");
  const node = el("section", { class: "panel facet" }, el("h3", {}, dim.title, clear, el("span", { class: "ms" })), head, list);
  return {
    name: dim.key, table: "pty", node, group: dim.group,
    sql: (s) => facetSql(dim, s.filters, MEASURES[s.measure], curSort()),
    render(rows) {
      const sel = new Set(state.filters.get(dim.key) ?? []);
      clear.hidden = sel.size === 0;
      const measure = MEASURES[state.measure];
      hdr.v.textContent = measure.short;
      for (const [s, b] of Object.entries(hdr)) b.classList.toggle("on", curSort() === s);
      if (dim.fixedOrder) { const ix = (k) => { const i = dim.fixedOrder.indexOf(k); return i < 0 ? 99 : i; }; rows.sort((a, b) => ix(a.k) - ix(b.k)); }
      const months = measure.perMonth ? monthsInRange(lastTotals) : 1;
      if (measure.ratio) rows = rows.filter((r) => r.v != null);
      const maxV = Math.max(1e-9, ...rows.map((r) => (r.v ?? 0) / months));
      list.replaceChildren(...rows.map((r) => {
        const isNull = r.k === null || r.k === undefined || r.k === "";
        const token = isNull ? NULL_TOKEN : String(r.k);
        const v = (r.v ?? 0) / months;
        return el("div", { class: "row" + (sel.has(token) ? " selected" : "") + (isNull ? " blank" : ""), onclick: () => toggle(dim.key, token) },
          el("span", { class: "bar", style: `width:${(100 * v / maxV).toFixed(2)}%` }),
          el("span", { class: "k", title: isNull ? "(blank)" : String(r.k) },
            dim.swatch ? el("i", { class: "swatch", style: `background:${fuelColor(r.k)}` }) : null,
            isNull ? "(blank)" : dim.key === "decade" ? `${r.k}s` : String(r.k)),
          el("span", { class: "n" }, compactInt(r.n)),
          el("span", { class: "v" }, compact(v, measure.digits)),
        );
      }));
      if (!rows.length) list.replaceChildren(el("div", { class: "empty" }, "no values match"));
    },
  };
}
for (const d of DIMS) {
  const p = facetPanel(d);
  $("#facets").append(p.node);
  panels.push(p);
}

// ---- shared stacked-bar renderer
// series: Map<key, { parts: Map<fuel, value>, total }>; keys drawn in `ks` order.
function stackedBars(svg, series, ks, { labelOf, onClick, brushKey, h = 220, w = 640, unit = "" }) {
  const pad = { l: 46, r: 8, t: 8, b: 22 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const maxT = Math.max(1e-9, ...ks.map((k) => series.get(k)?.total ?? 0));
  const bw = iw / Math.max(1, ks.length);
  const y = (v) => pad.t + ih - (v / maxT) * ih;
  const sel = brushKey ? (state.filters.get(brushKey) ?? []) : [];
  const range = sel.length === 1 && /\.\./.test(sel[0]) ? sel[0].split("..").map(Number) : null;
  const ns = "http://www.w3.org/2000/svg";
  const mk = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  };
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  for (let i = 0; i <= 4; i++) {
    const v = (maxT * i) / 4;
    svg.append(mk("line", { x1: pad.l, x2: w - pad.r, y1: y(v), y2: y(v), stroke: "#edf1f2" }));
    svg.append(mk("text", { x: pad.l - 6, y: y(v) + 3, "text-anchor": "end", "font-size": 9, fill: "#6e8c91" }, compact(v, 0)));
  }
  ks.forEach((k, i) => {
    const g = series.get(k);
    const x = pad.l + i * bw;
    const dim = range && (k < range[0] || k > range[1]);
    let acc = 0;
    const grp = mk("g", { opacity: dim ? 0.3 : 1, style: onClick ? "cursor:pointer" : "" });
    if (g) for (const f of FUEL_ORDER) {
      const v = g.parts.get(f);
      if (!v) continue;
      grp.append(mk("rect", { x: x + 1, y: y(acc + v), width: Math.max(1, bw - 2), height: Math.max(0, y(acc) - y(acc + v)), fill: fuelColor(f) }));
      acc += v;
    }
    grp.append(mk("title", {}, `${labelOf(k)}: ${compact(g?.total ?? 0, 2)} ${unit}`));
    if (onClick) grp.addEventListener("click", () => onClick(k));
    svg.append(grp);
    if (ks.length <= 20 || i % 2 === 0) svg.append(mk("text", { x: x + bw / 2, y: h - 7, "text-anchor": "middle", "font-size": 9.5, fill: "#4c6267" }, labelOf(k)));
  });
  return { bw, pad, mk };
}

// ---- year chart (stacked by fuel; drag to brush a year range)
const yearSvg = $("#year-chart svg");
panels.push({
  name: "years", table: "pty", node: $("#year-chart"),
  sql: (s) => yearSql(s.filters, MEASURES[s.measure]),
  render(rows) {
    const measure = MEASURES[state.measure];
    $("#year-chart .sub").textContent = `${measure.label} by year, stacked by fuel type. Drag to select a year range.`;
    const series = new Map();
    for (const r of rows) {
      if (!series.has(r.k)) series.set(r.k, { parts: new Map(), total: 0 });
      const g = series.get(r.k);
      const v = (r.v ?? 0) / (measure.perMonth ? (r.m || 12) : 1);
      g.parts.set(r.f ?? "", v); g.total += v;
    }
    const ks = [...series.keys()].sort((a, b) => a - b);
    const { bw, pad, mk } = stackedBars(yearSvg, series, ks, { labelOf: String, brushKey: "year", h: 230, unit: measure.unit });
    let x0 = null, rect = null;
    const idx = (ev) => {
      const pt = yearSvg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
      const p = pt.matrixTransform(yearSvg.getScreenCTM().inverse());
      return Math.max(0, Math.min(ks.length - 1, Math.floor((p.x - pad.l) / bw)));
    };
    yearSvg.onpointerdown = (ev) => {
      x0 = idx(ev); rect = mk("rect", { class: "brush", y: pad.t, height: 230 - pad.t - pad.b }); yearSvg.append(rect);
      yearSvg.setPointerCapture(ev.pointerId);
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
      if (a === 0 && b === ks.length - 1) setRange("year", null);
      else setRange("year", ks[a], ks[b]);
    };
    const sel = new Set(state.filters.get("fuel") ?? []);
    $("#year-chart .legend").replaceChildren(...FUEL_ORDER.filter((f) => rows.some((r) => (r.f ?? "") === f)).map((f) =>
      el("span", { class: sel.has(f || NULL_TOKEN) ? "selected" : "", onclick: () => toggle("fuel", f || NULL_TOKEN) },
        el("i", { style: `background:${fuelColor(f)}` }), f || "(blank)")));
  },
});

// ---- seasonality (twelve monthly columns summed under the current filter, stacked by fuel)
const monthSvg = $("#month-chart svg");
panels.push({
  name: "season", table: "pty", node: $("#month-chart"), needsMonthly: true,
  sql: (s) => seasonSql(s.filters, MEASURES[s.measure]),
  render(rows) {
    const measure = MEASURES[state.measure];
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

// ---- map (MapLibre; hover = quick tooltip, click = pinned card with details, GEM wiki link and a drill-in button)
let plantMap = null, lastMapPoints = null;
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
function hoverHtml(props) {
  const m = MEASURES[state.measure];
  const body = `${esc(props.f || "(blank)")} · ${esc(compact(props.v, 2))} ${esc(m.unit)}<br><span class="pp-hint">click for details</span>`;
  if (!plantNames.has(props.p)) {
    // name not cached yet: show a placeholder and swap it in when the lookup returns
    plantLabel(props.p).then((label) => plantMap?.refreshHover(props.p, `<b>${esc(label)}</b><br>${body}`));
    return `<b>…</b><br>${body}`;
  }
  return `<b>${esc(plantNames.get(props.p))}</b><br>${body}`;
}
async function clickHtml(props) {
  const id = props.p;
  const [{ rows }, techs] = await Promise.all([q(plantCardSql(id, state.filters)), q(plantTechSql(id, state.filters))]);
  const r = rows[0];
  if (!r) return `<b>plant ${id}</b><br>no rows under the current filters`;
  plantNames.set(id, `${r.name}, ${r.state}`);
  if (r.wiki) plantWiki.set(id, r.wiki);
  const months = r.y1 === maxYear ? (r.y1 - r.y0) * 12 + (r.m_last || 12) : (r.y1 - r.y0 + 1) * 12;
  const row = (k, v) => (v == null || v === "" ? "" : `<div><span>${k}</span><span>${v}</span></div>`);
  const card = el("div", { class: "pp-card" });
  card.innerHTML =
    `<h4>${esc(r.name)} <small>${esc(r.state)}</small></h4>` +
    `<div class="pp-sub">${esc(r.utility ?? "")}${r.ba ? " · " + esc(r.ba) : ""}</div>` +
    `<div class="pp-rows">` +
    row("technology", techs.rows.map((t) => `${esc(t.k ?? "(blank)")} ${t.cap_months ? "· " + fmtN((t.cap_months / months), 0) + " MW" : ""}`).join("<br>")) +
    row("years", r.y0 === r.y1 ? r.y0 : `${r.y0}–${r.y1}`) +
    row("first online", r.first_year) +
    row("avg capacity", r.gw_months != null ? `${fmtN((r.gw_months / months) * 1000, 0)} MW` : null) +
    row("generation", r.twh != null ? `${fmtN(r.twh, 2)} TWh` : null) +
    row("capacity factor", r.cf != null ? fmtN(r.cf * 100, 0) + "%" : null) +
    row("CO₂ (CEMS)", r.co2_mt != null ? `${fmtN(r.co2_mt, 2)} Mt · ${fmtN(r.co2_mwh, 2)} t/MWh` : null) +
    row("opex (FERC 1)", r.opex_mwh != null ? `$${fmtN(r.opex_mwh, 1)}/MWh` : null) +
    `</div>`;
  const actions = el("div", { class: "pp-actions" });
  if (r.wiki) actions.append(el("a", { href: r.wiki, target: "_blank", rel: "noopener", class: "pp-btn" }, `GEM wiki: ${r.gem && r.gem !== r.name ? r.gem : "page"} ↗`));
  actions.append(el("button", { type: "button", class: "pp-btn secondary", onclick: () => toggle("plant", String(id)) }, "show only this plant"));
  card.append(actions);
  return card;
}
createPlantMap($("#map .mapbox"), { hoverHtml, clickHtml })
  .then((m) => { plantMap = m; window.__plantMap = m; if (lastMapPoints) m.update(lastMapPoints); })
  .catch((e) => { console.error("map failed", e); $("#map .sub").textContent = `map unavailable: ${e.message}`; });
$("#map .legend").replaceChildren(...FUEL_ORDER.filter((f) => f).map((f) => el("span", {}, el("i", { style: `background:${fuelColor(f)}` }), f)));
panels.push({
  name: "map", table: "pty", node: $("#map"),
  sql: (s) => mapSql(s.filters, MEASURES[s.measure]),
  render(rows) {
    const measure = MEASURES[state.measure];
    const months = measure.perMonth ? monthsInRange(lastTotals) : 1;
    const maxV = Math.max(1e-9, ...rows.map((r) => r.v ?? 0)) / months;
    // plants with nothing to show for this measure (0 or null) stay off the map
    lastMapPoints = rows.filter((r) => r.lat != null && r.lon != null && r.v != null && r.v > 0).map((r) => {
      const v = (r.v ?? 0) / months;
      return { p: r.p, f: r.f, lat: r.lat, lon: r.lon, v, r: 1.5 + 9 * Math.sqrt(Math.max(0, v) / maxV), c: fuelColor(r.f) };
    });
    plantMap?.update(lastMapPoints);
    $("#map .sub").textContent = `${fmtInt.format(lastMapPoints.length)} plant × fuel points with ${measure.label.toLowerCase()} > 0, area ∝ value. Hover for a summary, click for details.`;
  },
});

// ---- grid (generator x year, top 100 for the current sort; plant name drills in)
const thead = $("#grid thead tr"), tbody = $("#grid tbody");
thead.replaceChildren(...GRID_COLS.map((c) => el("th", {
  class: (c.numeric ? "numeric " : "") + (state.sort[0] === c.col ? "sorted" : ""),
  onclick: () => {
    const dir = state.sort[0] === c.col ? (state.sort[1] === "desc" ? "asc" : "desc") : c.numeric ? "desc" : "asc";
    state.sort = [c.col, dir]; writeState({ replace: true });
  },
}, c.label, el("span", { class: "arrow" }))));
panels.push({
  name: "grid", table: "gy", node: $("#grid"),
  sql: (s) => gridSql(s.filters, s.sort),
  pending() { $("#grid .count").textContent = "loading generator table…"; },
  render(rows) {
    for (const [i, th] of [...thead.children].entries()) {
      const c = GRID_COLS[i];
      th.classList.toggle("sorted", state.sort[0] === c.col);
      th.querySelector(".arrow").textContent = state.sort[0] === c.col ? (state.sort[1] === "desc" ? "▼" : "▲") : "";
    }
    for (const r of rows) {
      if (r.plant_name_eia) plantNames.set(r.plant_id_eia, `${r.plant_name_eia}, ${r.state}`);
      if (r.gem_wiki_url) plantWiki.set(r.plant_id_eia, r.gem_wiki_url);
    }
    tbody.replaceChildren(...rows.map((r) => el("tr", {}, ...GRID_COLS.map((c) => {
      let v = r[c.col];
      if (c.date && v) v = String(v).slice(0, 7);
      else if (c.plain) v = v == null ? "" : String(v);
      else if (c.numeric) v = v == null ? "" : fmtN(v, c.digits);
      const cell = el("td", { class: c.numeric ? "numeric" : "", title: v == null ? "" : String(r[c.col]) }, v == null ? "" : String(v));
      if (c.link && v != null) { cell.replaceChildren(el("a", { href: "#", title: "show only this plant", onclick: (e) => { e.preventDefault(); toggle("plant", String(r.plant_id_eia)); } }, String(v))); }
      if (c.external) cell.replaceChildren(v ? el("a", { href: String(v), target: "_blank", rel: "noopener", class: "ext", title: `GEM wiki: ${String(v).split("/").pop().replace(/_/g, " ")}` }, "wiki ↗") : "");
      return cell;
    }))));
    $("#grid .count").textContent = rows.length ? `top ${rows.length} generator-years by ${GRID_COLS.find((c) => c.col === state.sort[0]).label} ${state.sort[1]}` : "";
    if (!rows.length) tbody.replaceChildren(el("tr", {}, el("td", { colspan: GRID_COLS.length }, el("div", { class: "empty" }, "no generator-years match these filters"))));
  },
});

// ---------------------------------------------------------------- controls
function renderChips() {
  const chips = [];
  for (const [k, vals] of state.filters) {
    const dim = ALL_DIMS.find((d) => d.key === k);
    for (const v of vals) {
      let label;
      if (k === SEARCH_PARAM) label = `search: ${v}`;
      else if (k === "plant") {
        const id = Number(v);
        label = `plant: ${plantNames.get(id) ?? v}`;
        if (!plantNames.has(id) && db) plantLabel(id).then(renderChips);
        if (plantWiki.has(id)) {
          chips.push(el("span", { class: "chip" }, label, " ",
            el("a", { href: plantWiki.get(id), target: "_blank", rel: "noopener", class: "ext", title: "open the GEM wiki page" }, "GEM wiki ↗"),
            el("button", { class: "x", type: "button", title: "remove this filter", onclick: () => toggle(k, v) }, "×")));
          continue;
        }
      } else label = `${dim?.title ?? k}: ${v === NULL_TOKEN ? "(blank)" : k === "decade" ? v + "s" : v.replace("..", "–")}`;
      chips.push(el("span", { class: "chip" }, label, el("button", { class: "x", type: "button", title: "remove this filter", onclick: () => toggle(k, v) }, "×")));
    }
  }
  $("#chips").replaceChildren(...chips);
}
function syncControls() {
  $("#measure").value = state.measure;
  $("#q").value = state.filters.get(SEARCH_PARAM)?.[0] ?? "";
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
for (const b of document.querySelectorAll(".clear-all")) b.addEventListener("click", clearAll);
$("#q").addEventListener("keydown", (e) => { if (e.key === "Escape" && e.target.value) { e.target.value = ""; e.target.dispatchEvent(new Event("input")); } });
$("#show-ms").addEventListener("change", (e) => { document.body.classList.toggle("show-ms", e.target.checked); try { localStorage.setItem("showMs", e.target.checked ? "1" : ""); } catch {} });
try { if (localStorage.getItem("showMs")) { $("#show-ms").checked = true; document.body.classList.add("show-ms"); } } catch {}
$("#reset").addEventListener("click", async () => {
  db?.close();
  try {
    const root = await navigator.storage.getDirectory();
    for (const name of ["facetful-cache", OPFS_DIR]) { try { await root.removeEntry(name, { recursive: true }); } catch {} }
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
      wasmUrl: new URL("./vendor/facetful/facetful_wasm.wasm", import.meta.url),
      workerUrl: new URL("./vendor/facetful/worker.js", import.meta.url),
    });
    // 1. the small table first: the page becomes interactive as soon as it is open
    const a = await openTable("pty", status);
    maxYear = (await q("select max(year) as y from t")).rows[0]?.y ?? maxYear;
    loading.hidden = true;
    const info = (i) => `${compactInt(i.rows)} rows via ${i.source} in ${(i.openMs / 1000).toFixed(1)} s`;
    $("#open-info").textContent = `${TABLES.pty.file}: ${info(a)}`;
    await refresh();
    // 2. the generator table in the background, then the grid
    const b = await openTable("gy", status);
    $("#open-info").textContent += ` · ${TABLES.gy.file}: ${info(b)}`;
    await refresh(["grid"]);
  } catch (e) {
    console.error(e);
    steps.textContent = "";
    bar.remove();
    $("#loading .err").textContent = `Could not open the data.\n${e.message}\n\nServe the pudl directory statically and open /explorer/. Needs data/plant_tech_year.facetful.gz and data/generator_year.facetful.gz.`;
  }
})();
