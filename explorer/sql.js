// The only module that writes SQL.
//
// Two tables, and a measure decides which one a panel reads:
//
//   gw  generator_tech_wide   plant x generator x technology, 42,257 rows, yearly series as COLUMNS
//                             (gen_2010..gen_2026, cap_*, co2_*). Drives facets, totals, years,
//                             map and the detail grid for every measure it has columns for.
//   pty plant_tech_year       plant x technology x status x year, 230,891 rows. Keeps the monthly
//                             columns (seasonality), the FERC cost columns and fuel cost / fuel burned.
//
// On `gw` a year-range filter is not a WHERE: it chooses which year columns to add up. That is what
// keeps every measure filter-responsive without storing a row per year, and it is why the sparkline
// series arrives with the row. Columns are zero-filled, so sums are plain `a + b + c` — wrapping them
// in coalesce() costs 3.8x as much (docs/facetful-notes.md).
//
// facetful dialect notes: GROUP BY repeats the expression, no aliases; no scientific notation (1e6);
// LIKE is already case-insensitive and lower() defeats the dictionary fast path; the table is always
// `t` in SQL and the JS `{ table }` option picks which one.

/** Year range the wide table was built over; see scripts/build-generator-wide.sql. */
import { NEAR_PARAM as NEAR, parseNear } from "./near.js";

export const YEARS = Array.from({ length: 17 }, (_, i) => 2010 + i);
export const TABLES = { gw: "generator_tech_wide", pty: "plant_tech_year", places: "places_us" };
// `places` is not a measure table: nothing groups by it. It backs the town autocomplete only,
// and is fetched the first time someone types in the near box.
export { NEAR_PARAM, KM_OPTIONS, DEFAULT_KM, placeLabel, parseNear, formatNear, snapKm, circleRing } from "./near.js";

export const DIMS = [
  { key: "fuel", col: "fuel_type_code_pudl", title: "Fuel type", swatch: true },
  { key: "tech", col: "technology_description", title: "Technology" },
  { key: "status", col: "operational_status", title: "Operational status" },
  { key: "state", col: "state", title: "State" },
  { key: "ba", col: "ba_code", title: "Balancing authority" },
  { key: "utility", col: "utility_name_eia", title: "Utility (top 300)", topN: 300 },
  // `rangeOrder` marks a scale: the buckets only mean anything in order, so sorting is switched off
  // rather than offered and ignored.
  { key: "cap", col: "capacity_bucket", title: "Site capacity", rangeOrder: true, fixedOrder: ["< 1 MW", "1-10 MW", "10-100 MW", "100-500 MW", "500+ MW"] },
  { key: "decade", col: "operating_decade", title: "First commissioned (decade)", orderBy: "dim", numeric: true },
  // measure-specific: shown only while a measure of the same group is selected
  { key: "co2b", col: "co2_intensity_bucket", title: "CO₂ intensity (t/MWh, CEMS)", rangeOrder: true, fixedOrder: ["< 0.2", "0.2-0.4", "0.4-0.6", "0.6-0.9", "0.9+"], group: "cems" },
  { key: "cems", col: "cems_allocation", title: "CEMS coverage", fixedOrder: ["measured", "capacity-split", "plant-fallback", "mixed"], group: "cems" },
  { key: "ferc", col: "ferc_allocation", title: "FERC 1 costs", fixedOrder: ["plant_type match", "largest technology"], group: "ferc" },
];
export const HIDDEN_DIMS = [
  { key: "year", col: "year", title: "Years", numeric: true },
  { key: "plant", col: "plant_id_eia", title: "Plant", numeric: true },
];
export const ALL_DIMS = [...DIMS, ...HIDDEN_DIMS];
export const SEARCH_PARAM = "q";
const SEARCH_COLS = ["plant_name_eia", "utility_name_eia"];
export const NULL_TOKEN = " null";

/**
 * A measure knows which table it can be computed on.
 *   table "gw": `prefix` names the year-column family; sums are built per year range.
 *   table "pty": `expr` is a plain aggregate over the long table.
 * `ratio` divides two families, counting only rows that have the numerator (CEMS coverage).
 * `monthly` names the seasonality columns, which always live on `pty`.
 */
export const MEASURES = {
  twh: { label: "Generation (TWh)", short: "Gen TWh", table: "gw", prefix: "gen", scale: 1000000, unit: "TWh", digits: 1, monthly: { prefix: "gen", scale: 1000000 } },
  gw: { label: "Avg capacity (GW)", short: "Cap GW", table: "gw", prefix: "cap", scale: 1000, unit: "GW", digits: 1, perMonth: true },
  co2: { label: "CO₂ (Mt)", short: "CO₂ Mt", table: "gw", prefix: "co2", scale: 1000000, unit: "Mt", digits: 2, group: "cems", monthly: { prefix: "co2", scale: 1000000 } },
  cf: { label: "Capacity factor (%)", short: "CF %", table: "gw", ratio: ["gen", "cap"], scale: 100 / 730.5, unit: "%", digits: 0,
        nonAdditive: true, sizeBy: "cap" },
  co2_mwh: { label: "CO₂ intensity (t/MWh)", short: "t/MWh", table: "gw", ratio: ["co2", "gen"], gate: "has_cems = 1", scale: 1, unit: "t/MWh", digits: 3, group: "cems",
        nonAdditive: true, sizeBy: "co2" },
  // cap_* is capacity-MW-months, so co2/cap is t per MW-month; x12 gives the t/MW-yr the label
  // promises. This read 1/12, which is 144x low: coal came out at 32 t/MW-yr against the ~4,700
  // implied by its own intensity and capacity factor (explorer/scalecheck.mjs checks this).
  co2_mw: { label: "CO₂ per MW (t/MW·yr)", short: "t/MW·yr", table: "gw", ratio: ["co2", "cap"], gate: "has_cems = 1", scale: 12, unit: "t/MW·yr", digits: 0, group: "cems",
        nonAdditive: true, sizeBy: "co2" },
  cost: { label: "Fuel cost ($bn)", short: "Fuel $bn", table: "pty", expr: "round(sum(total_fuel_cost)/1000000000.0, 3)", unit: "$bn", digits: 2, monthly: { prefix: "cost", scale: 1000000000 } },
  tbtu: { label: "Fuel burned (TBtu)", short: "Fuel TBtu", table: "pty", expr: "round(sum(total_mmbtu)/1000000.0, 3)", unit: "TBtu", digits: 1, monthly: { prefix: "mmbtu", scale: 1000000 } },
  capex: { label: "Plant in service ($bn, FERC 1)", short: "Capex $bn", table: "pty", expr: "round(sum(ferc_capex_total)/1000000000.0, 3)", unit: "$bn", digits: 1, group: "ferc" },
  opex_mwh: { label: "Operating cost ($/MWh, FERC 1)", short: "Opex $/MWh", table: "pty", expr: "round(sum(ferc_opex_total)/sum(case when ferc_opex_total is not null then net_generation_mwh end), 2)", unit: "$/MWh", digits: 1, group: "ferc",
        nonAdditive: true, sizeBy: "gen" },
};

/** Optgroup headings for the measure picker; a measure with no `group` sits above them all. */
export const MEASURE_GROUPS = {
  cems: "Emissions (EPA CEMS, fossil units > 25 MW)",
  ferc: "Costs (FERC Form 1, regulated utilities)",
};

export function ident(name) { return `"${String(name).replace(/"/g, '""')}"`; }
export function lit(v) { return `'${String(v).replace(/'/g, "''")}'`; }
function parseRange(v) {
  const m = /^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Years the current filter selects, as a subset of YEARS. */
export function yearsIn(filters) {
  const vals = filters.get("year") ?? [];
  if (!vals.length) return YEARS;
  const keep = new Set();
  for (const v of vals) {
    const r = parseRange(v);
    if (r) for (const y of YEARS) { if (y >= r[0] && y <= r[1]) keep.add(y); }
    else if (YEARS.includes(Number(v))) keep.add(Number(v));
  }
  return keep.size ? YEARS.filter((y) => keep.has(y)) : YEARS;
}

/** `gen_2018 + gen_2019 + …` over the selected years. Zero-filled, so no coalesce. */
const span = (prefix, years) => years.map((y) => `${prefix}_${y}`).join(" + ");

/** A measure as a scalar expression for one row (the grid), or wrapped in sum() (grouped panels). */
export function measureExpr(measure, years, { grouped = true } = {}) {
  if (measure.table === "pty") return measure.expr;
  const total = (p) => (grouped ? `sum(${span(p, years)})` : `(${span(p, years)})`);
  if (measure.ratio) {
    const [num, den] = measure.ratio;
    // `gate` keeps the denominator to rows that can carry the numerator, so an emissions intensity is
    // not diluted by plant with no monitor. Capacity factor has no gate: it applies to every row.
    const inner = measure.gate ? `case when ${measure.gate} then (${span(den, years)}) else 0 end` : span(den, years);
    const gated = grouped ? `sum(${inner})` : `(${inner})`;
    const scale = measure.scale === 1 ? "" : ` * ${measure.scale}`;
    return `round(${total(num)} / nullif(${gated}, 0)${scale}, 4)`;
  }
  return `round(${total(measure.prefix)}/${measure.scale}.0, 3)`;
}

/**
 * WHERE fragment for the near filter. `geo_distance` is a facetful UDF returning metres; it
 * arrived with the UDF bundle in 0.5 and is on by default, which is what makes this possible
 * without a build step. Both images carry latitude and longitude, so one clause serves both.
 */
export const nearClause = (n) =>
  `geo_distance(latitude, longitude, ${n.lat}, ${n.lon}) <= ${n.km * 1000}`;

/** Autocomplete: "spring" matches names starting with it, largest place first. A comma
 *  narrows by region, so "springfield, mo" finds the Missouri one. */
export function placeSearchSql(text, limit = 8) {
  const needle = (s) => s.trim().replaceAll("%", "").replaceAll("_", "");   // a literal, never a pattern
  const [head, ...quals] = String(text).split(",").map(needle);
  if (!head) return null;
  const conds = [`(name like ${lit(head + "%")} or ascii like ${lit(head + "%")})`];
  for (const qu of quals.filter(Boolean)) conds.push(`region like ${lit("%" + qu + "%")}`);
  return `select id, name, region, lat, lon, population from t where ${conds.join(" and ")} ` +
    `order by population desc limit ${limit}`;
}

function searchClause(q) {
  const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length) return "";
  return words.map((w) => "(" + SEARCH_COLS.map((c) => `${ident(c)} like ${lit("%" + w + "%")}`).join(" or ") + ")").join(" and ");
}

/**
 * filters: Map<key, string[]>. On `gw` the year filter is left out — it picks columns, not rows —
 * but rows with no capacity in the selected window are dropped so the lists stay honest.
 */
export function whereClause(filters, { table = "gw", except, extra } = {}) {
  const parts = [];
  if (extra) parts.push(extra);
  for (const [key, values] of filters) {
    if (key === except || !values?.length) continue;
    if (key === "year" && table === "gw") continue;
    if (key === SEARCH_PARAM) {
      const c = searchClause(values.join(" "));
      if (c) parts.push(c);
      continue;
    }
    if (key === NEAR) {
      const n = parseNear(values[0]);
      if (n) parts.push(nearClause(n));
      continue;
    }
    const dim = ALL_DIMS.find((d) => d.key === key);
    if (!dim) continue;
    const col = ident(dim.col);
    const ranges = values.map(parseRange).filter(Boolean);
    const plain = values.filter((v) => !parseRange(v) && v !== NULL_TOKEN);
    const wantNull = values.includes(NULL_TOKEN);
    for (const [lo, hi] of ranges) parts.push(`${col} between ${lo} and ${hi}`);
    const alts = [];
    if (plain.length === 1) alts.push(`${col} = ${dim.numeric ? Number(plain[0]) : lit(plain[0])}`);
    else if (plain.length > 1) alts.push(`${col} in (${plain.map((v) => (dim.numeric ? Number(v) : lit(v))).join(", ")})`);
    if (wantNull) alts.push(`${col} is null`);
    if (alts.length === 1) parts.push(alts[0]);
    else if (alts.length > 1) parts.push("(" + alts.join(" or ") + ")");
  }
  if (table === "gw" && except !== "year") {
    const years = yearsIn(filters);
    if (years.length < YEARS.length) parts.push(`(${span("cap", years)}) > 0`);
  }
  return parts.length ? `where ${parts.join(" and ")}` : "";
}

/** Counts shown in every facet row and in the totals: plants on the face, generators in the tooltip. */
const COUNTS = { gw: "count(distinct plant_id_eia) as n, count(distinct gen_key) as g", pty: "count(distinct plant_id_eia) as n" };

export function facetSql(dim, filters, measure, sort) {
  const table = measure.table;
  const d = ident(dim.col);
  const [col, dir] = Array.isArray(sort) ? sort : [sort, null];
  const way = dir === "asc" ? "asc" : "desc";
  const order = col === "k" ? `${d} ${dir === "desc" ? "desc" : "asc"}` : col === "n" ? `n ${way}` : `v ${way}`;
  const years = yearsIn(filters);
  return (
    `select ${d} as k, ${COUNTS[table]}, ${measureExpr(measure, years)} as v from t ` +
    `${whereClause(filters, { table, except: dim.key })} group by ${d} order by ${order} limit ${dim.topN ?? 500}`
  );
}

/** Months of data actually reported per year — the final year is partial, so average capacity
 *  must divide by the real period length rather than 12 × years. Run once at boot. */
export function monthsPerYearSql() {
  return `select ${YEARS.map((y) => `max(mon_${y}) as m${y}`).join(", ")} from t`;
}

export function totalsSql(filters, measure) {
  const years = yearsIn(filters);
  if (measure.table === "pty") {
    return `select count(distinct plant_id_eia) as plants, round(sum(net_generation_mwh)/1000000.0, 1) as twh, ` +
      `round(sum(capacity_mw_months)/1000.0, 1) as gw_months, round(sum(net_generation_mwh)/(sum(capacity_mw_months)*730.5), 4) as cf ` +
      `from t ${whereClause(filters, { table: "pty" })}`;
  }
  return (
    `select count(distinct plant_id_eia) as plants, count(distinct gen_key) as gens, ` +
    `round(sum(${span("gen", years)})/1000000.0, 1) as twh, round(sum(${span("cap", years)})/1000.0, 1) as gw_months, ` +
    `round(sum(${span("gen", years)})/(sum(${span("cap", years)})*730.5), 4) as cf from t ${whereClause(filters, { table: "gw" })}`
  );
}

/**
 * Years chart. On `gw` one row per fuel with a column per year (the app unpivots); the year filter is
 * deliberately ignored here so the brushed range shows dimmed rather than vanishing.
 */
export function yearSql(filters, measure) {
  if (measure.table === "pty") {
    return `select year as k, fuel_type_code_pudl as f, ${measure.expr} as v, max(n_months) as m from t ` +
      `${whereClause(filters, { table: "pty", except: "year" })} group by year, fuel_type_code_pudl order by year, fuel_type_code_pudl`;
  }
  const per = (y) => {
    if (measure.ratio) {
      const [num, den] = measure.ratio;
      const scale = measure.scale === 1 ? "" : ` * ${measure.scale}`;
      // The gate belongs to the measure, exactly as in measureExpr. This used to hardcode the CEMS
      // condition, which for capacity factor divided all generation by monitored capacity only:
      // solar read 4,787% in 2023 instead of 18.3%, and fuels with no monitor at all read zero.
      const gated = measure.gate ? `sum(case when ${measure.gate} then ${den}_${y} else 0 end)` : `sum(${den}_${y})`;
      return `round(sum(${num}_${y}) / nullif(${gated}, 0)${scale}, 4) as y${y}`;
    }
    return `round(sum(${measure.prefix}_${y})/${measure.scale}.0, 3) as y${y}`;
  };
  return `select fuel_type_code_pudl as f, ${YEARS.map(per).join(", ")} from t ` +
    `${whereClause(filters, { table: "gw", except: "year" })} group by fuel_type_code_pudl order by fuel_type_code_pudl`;
}

/** Seasonality always reads the monthly columns on `pty`. */
export function seasonSql(filters, measure) {
  if (!measure.monthly) return null;
  const cols = Array.from({ length: 12 }, (_, i) =>
    `round(sum(${measure.monthly.prefix}_m${String(i + 1).padStart(2, "0")})/${measure.monthly.scale}.0, 3) as m${i + 1}`).join(", ");
  return `select fuel_type_code_pudl as f, ${cols} from t ${whereClause(filters, { table: "pty" })} group by fuel_type_code_pudl order by fuel_type_code_pudl`;
}

/**
 * How big a thing is, for a measure that does not say. Circle area tracks this rather than the
 * measure, because a ratio would draw a 2 MW solar site the size of a power station.
 */
function sizeExpr(measure, years) {
  if (!measure.nonAdditive) return null;
  if (measure.table === "pty") return "round(sum(net_generation_mwh)/1000000.0, 4)";
  const p = measure.sizeBy ?? "gen";
  return `round(sum(${span(p, years)})/1000000.0, 4)`;
}

export function mapSql(filters, measure) {
  const table = measure.table;
  const years = yearsIn(filters);
  const size = sizeExpr(measure, years);
  return (
    `select plant_id_eia as p, fuel_type_code_pudl as f, min(latitude) as lat, min(longitude) as lon, ${measureExpr(measure, years)} as v` +
    `${size ? `, ${size} as s` : ""} ` +
    `from t ${whereClause(filters, { table, extra: "latitude is not null" })} group by plant_id_eia, fuel_type_code_pudl order by v desc`
  );
}

/** One plant's card in the map popup. */
export function plantCardSql(plantId, filters, measure) {
  const f = new Map(filters); f.delete("plant");
  const years = yearsIn(f);
  return (
    `select plant_name_eia as name, state as state, utility_name_eia as utility, ba_code as ba, gem_wiki_url as wiki, gem_plant_name as gem, ` +
    `count(distinct gen_key) as gens, min(first_operating_year) as first_year, ` +
    `round(sum(${span("gen", years)})/1000000.0, 2) as twh, round(sum(${span("cap", years)})/1000.0, 3) as gw_months, ` +
    `round(sum(${span("gen", years)})/(sum(${span("cap", years)})*730.5), 3) as cf, ` +
    `round(sum(${span("co2", years)})/1000000.0, 3) as co2_mt, ` +
    `round(sum(${span("co2", years)})/nullif(sum(case when has_cems = 1 then (${span("gen", years)}) else 0 end), 0), 3) as co2_mwh ` +
    `from t ${whereClause(f, { table: "gw", extra: `plant_id_eia = ${Number(plantId)}` })} ` +
    `group by plant_name_eia, state, utility_name_eia, ba_code, gem_wiki_url, gem_plant_name order by twh desc limit 1`
  );
}

export function plantTechSql(plantId, filters) {
  const f = new Map(filters); f.delete("plant");
  const years = yearsIn(f);
  return `select technology_description as k, round(sum(${span("cap", years)}), 1) as cap_months, round(sum(${span("gen", years)})/1000000.0, 3) as twh ` +
    `from t ${whereClause(f, { table: "gw", extra: `plant_id_eia = ${Number(plantId)}` })} group by technology_description order by cap_months desc limit 8`;
}

export function plantNameSql(plantId) {
  return `select plant_name_eia as name, state as state, gem_wiki_url as wiki from t where plant_id_eia = ${Number(plantId)} limit 1`;
}

// ---- the detail grid -------------------------------------------------------
// `series` columns carry the sparkline data back with the row, so there is no second query.

/**
 * The third sparkline, which follows the selected measure. Generation and capacity factor are always
 * columns one and two, so `twh` is absent here; the two FERC measures are absent because their
 * filings are plant-level annual figures with no per-generator yearly series. A measure that is not
 * in this map simply has no third column — there is no fallback.
 *
 * `raw` names the extra yearly series the query must fetch on top of gen and cap. `scalar` is the
 * number beside the sparkline: where the measure's own expression means something for a single
 * generator it is reused verbatim, so the row agrees with the facet panels; where it does not (a
 * measure in GW or $bn is meaningless for one generator) the row carries its own expression.
 */
export const MEASURE_SPARK = {
  // capacity factor is not a default column any more: it appears when it is the selected measure.
  // The CF number stays in the grid either way, so this entry adds only the sparkline.
  cf:      { series: "cf", label: "Capacity factor yearly", scalar: null },
  gw:      { series: "cap_mw", label: "Capacity yearly", raw: "mon",
             scalar: { col: "avg_mw", label: "Avg MW", digits: 1 },
             sql: (y) => `round((${span("cap", y)})/nullif((${span("mon", y)}), 0), 4) as avg_mw` },
  co2:     { series: "co2", label: "CO₂ yearly", raw: "co2", cems: true,
             scalar: { col: "co2_mt", label: "Mt", digits: 2 } },
  co2_mwh: { series: "co2_mwh", label: "CO₂ intensity yearly", raw: "co2", cems: true,
             scalar: { col: "co2_mwh", label: "t/MWh", digits: 3 } },
  co2_mw:  { series: "co2_mw", label: "CO₂ per MW yearly", raw: "co2", cems: true,
             scalar: { col: "co2_mw", label: "t/MW·yr", digits: 1 } },
  cost:    { series: "cost", label: "Fuel cost yearly", raw: "cost",
             scalar: { col: "fuel_cost_m", label: "$m", digits: 1 },
             sql: (y) => `round((${span("cost", y)})/1000000.0, 3) as fuel_cost_m` },
  tbtu:    { series: "mmbtu", label: "Fuel burned yearly", raw: "mmbtu",
             scalar: { col: "tbtu", label: "TBtu", digits: 2 },
             sql: (y) => `round((${span("mmbtu", y)})/1000000.0, 4) as tbtu` },
};

/** The grid's columns for one measure. The measure pair is present only when the measure has one. */
export function gridCols(measureKey) {
  const m = MEASURE_SPARK[measureKey];
  // `scalar: null` means the base columns already carry that number, so only the sparkline is added
  const pair = m
    ? [...(m.scalar ? [{ col: m.scalar.col, label: m.scalar.label, numeric: true, digits: m.scalar.digits, w: "4.2rem", cems: m.cems }] : []),
       { col: `spark_${m.series}`, label: m.label, series: m.series, cemsSeries: m.cems, w: "8.4rem", noSort: true }]
    : [];
  return [
    { col: "plant_name_eia", label: "Plant", link: true, w: "11.5rem", freeze: true },
    { col: "generator_id", label: "Gen", w: "3.2rem", freeze: true },
    { col: "utility_name_eia", label: "Utility", w: "8rem" },
    { col: "technology_description", label: "Technology", w: "8rem" },
    { col: "operational_status", label: "Status", w: "4.8rem", pill: true },
    { col: "capacity_mw", label: "MW", numeric: true, digits: 1, w: "4rem" },
    { col: "twh", label: "TWh", numeric: true, digits: 2, w: "3.8rem" },
    { col: "spark_gen", label: "Generation yearly", series: "gen", w: "8.4rem", noSort: true },
    { col: "cf", label: "CF", numeric: true, pct: true, w: "3rem" },
    ...pair,
    { col: "first_operating_year", label: "Online", numeric: true, digits: 0, plain: true, w: "4rem" },
    { col: "gem_wiki_url", label: "GEM", external: true, w: "3.4rem" },
  ];
}

/** The sort keys a measure's column set offers; anything else falls back to generation. */
export function gridSortable(measureKey) {
  return new Set(gridCols(measureKey).filter((c) => !c.series).map((c) => c.col));
}

export function gridSql(filters, sort, { limit = 100, offset = 0, measure = "twh" } = {}) {
  const years = yearsIn(filters);
  const gen = span("gen", years), cap = span("cap", years);
  const m = MEASURE_SPARK[measure];
  const cols = [
    "plant_id_eia", "gen_key", "plant_name_eia", "state", "generator_id", "utility_name_eia",
    "technology_description", "operational_status", "capacity_mw", "first_operating_year",
    "retirement_year", "gem_wiki_url", "has_cems",
  ].map(ident).join(", ");
  // gen and cap are always needed: they draw the first two sparklines between them.
  const raw = ["gen", "cap", ...(m?.raw ? [m.raw] : [])];
  const series = raw.flatMap((p) => YEARS.map((y) => `${p}_${y}`)).join(", ");
  // the measure's own expression where it reads for one generator, the row's own where it does not
  const extra = !m || !m.scalar ? ""
    : ", " + (m.sql ? m.sql(years) : `${measureExpr(MEASURES[measure], years, { grouped: false })} as ${m.scalar.col}`);
  const [col, dir] = sort;
  const key = gridSortable(measure).has(col) ? col : "twh";
  return (
    `select ${cols}, round((${gen})/1000000.0, 4) as twh, ` +
    `round((${gen})/nullif((${cap})*730.5, 0), 4) as cf${extra}, ${series} ` +
    `from t ${whereClause(filters, { table: "gw" })} ` +
    `order by ${ident(key)} ${dir === "asc" ? "asc" : "desc"} limit ${limit} offset ${offset}`
  );
}

export function gridCountSql(filters) {
  return `select count(*) as rows, count(distinct plant_id_eia) as plants, count(distinct gen_key) as gens from t ${whereClause(filters, { table: "gw" })}`;
}

/** FERC costs for one plant, for the map card (they live on `pty`). */
export function plantFercSql(plantId, filters) {
  const f = new Map(filters); f.delete("plant");
  return `select round(sum(ferc_capex_total)/1000000000.0, 2) as capex_bn, ` +
    `round(sum(ferc_opex_total)/sum(case when ferc_opex_total is not null then net_generation_mwh end), 1) as opex_mwh ` +
    `from t ${whereClause(f, { table: "pty", extra: `plant_id_eia = ${Number(plantId)}` })}`;
}
