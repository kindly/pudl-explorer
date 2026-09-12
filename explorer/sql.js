// The only module that writes SQL. Mirrors gem-explorer's sql.ts: one filter
// state -> a WHERE clause; every panel is a GROUP BY over that clause, with
// the option of leaving out one dimension ("except") so a facet never
// collapses to its own selection.
//
// Two tables share the dimension column names, so the same WHERE works on both:
//   plant_tech_year (plant x technology x status x year) - facets, totals, charts, map
//   generator_year  (generator x year)                    - grid / drill-down
//
// facetful dialect notes learned the hard way (see ../README.md):
//   - GROUP BY must repeat the expression, aliases are not accepted there
//   - no scientific notation literals (1e6) - write 1000000.0
//   - LIKE is already case-insensitive; lower() defeats the dictionary fast path
//   - table is always `t` in SQL; the JS `{ table }` option picks which one

export const TABLES = {
  pty: { file: "plant_tech_year", label: "plant × technology × year" },
  gy: { file: "generator_year", label: "generator × year" },
};

export const DIMS = [
  { key: "fuel", col: "fuel_type_code_pudl", title: "Fuel type", swatch: true },
  { key: "tech", col: "technology_description", title: "Technology" },
  { key: "status", col: "operational_status", title: "Operational status" },
  { key: "state", col: "state", title: "State" },
  { key: "ba", col: "ba_code", title: "Balancing authority" },
  { key: "utility", col: "utility_name_eia", title: "Utility (top 300)", topN: 300 },
  { key: "cap", col: "capacity_bucket", title: "Site capacity (plant × technology)", fixedOrder: ["< 1 MW", "1-10 MW", "10-100 MW", "100-500 MW", "500+ MW"] },
  { key: "decade", col: "operating_decade", title: "First commissioned (decade)", orderBy: "dim", numeric: true },
  // measure-specific facets: shown only while a measure of the same group is selected
  { key: "co2b", col: "co2_intensity_bucket", title: "CO₂ intensity (t/MWh, CEMS)", fixedOrder: ["< 0.2", "0.2-0.4", "0.4-0.6", "0.6-0.9", "0.9+"], group: "cems" },
  { key: "cems", col: "cems_allocation", title: "CEMS coverage", fixedOrder: ["measured", "capacity-split", "plant-fallback", "mixed"], group: "cems" },
  { key: "ferc", col: "ferc_allocation", title: "FERC 1 costs", fixedOrder: ["plant_type match", "largest technology"], group: "ferc" },
];
// Dimensions with no facet list: the year brush and the plant drill-down.
export const HIDDEN_DIMS = [
  { key: "year", col: "year", title: "Years", numeric: true },
  { key: "plant", col: "plant_id_eia", title: "Plant", numeric: true },
];
export const ALL_DIMS = [...DIMS, ...HIDDEN_DIMS];
export const SEARCH_PARAM = "q";
const SEARCH_COLS = ["plant_name_eia", "utility_name_eia"];

export const MEASURES = {
  twh: { label: "Generation (TWh)", short: "Gen TWh", expr: "round(sum(net_generation_mwh)/1000000.0, 3)", unit: "TWh", digits: 1, monthly: { prefix: "gen", scale: 1000000 } },
  gw: { label: "Avg capacity (GW)", short: "Cap GW", expr: "round(sum(capacity_mw_months)/1000.0, 3)", unit: "GW", digits: 1, perMonth: true },
  cost: { label: "Fuel cost ($bn)", short: "Fuel $bn", expr: "round(sum(total_fuel_cost)/1000000000.0, 3)", unit: "$bn", digits: 2, monthly: { prefix: "cost", scale: 1000000000 } },
  tbtu: { label: "Fuel burned (TBtu)", short: "Fuel TBtu", expr: "round(sum(total_mmbtu)/1000000.0, 3)", unit: "TBtu", digits: 1, monthly: { prefix: "mmbtu", scale: 1000000 } },
  co2: { label: "CO₂ (Mt)", short: "CO₂ Mt", expr: "round(sum(co2_tons)/1000000.0, 3)", unit: "Mt", digits: 2, monthly: { prefix: "co2", scale: 1000000 }, group: "cems" },
  co2_mwh: { label: "CO₂ intensity (t/MWh)", short: "t/MWh", expr: "round(sum(co2_tons)/sum(case when co2_tons is not null then net_generation_mwh end), 4)", unit: "t/MWh", digits: 3, ratio: true, group: "cems" },
  co2_mw: { label: "CO₂ per MW (t/MW·yr)", short: "t/MW·yr", expr: "round(sum(co2_tons)/(sum(case when co2_tons is not null then capacity_mw_months end)/12.0), 2)", unit: "t/MW·yr", digits: 0, ratio: true, group: "cems" },
  capex: { label: "Plant in service ($bn, FERC 1)", short: "Capex $bn", expr: "round(sum(ferc_capex_total)/1000000000.0, 3)", unit: "$bn", digits: 1, group: "ferc" },
  opex_mwh: { label: "Operating cost ($/MWh, FERC 1)", short: "Opex $/MWh", expr: "round(sum(ferc_opex_total)/sum(case when ferc_opex_total is not null then net_generation_mwh end), 2)", unit: "$/MWh", digits: 1, ratio: true, group: "ferc" },
  plants: { label: "Plants", short: "Plants", expr: "count(distinct plant_id_eia)", unit: "plants", digits: 0 },
};

export function ident(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}
export function lit(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}
function parseRange(v) {
  const m = /^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
export const NULL_TOKEN = " null";

/** Free-text search: words are AND'ed, each matched across the search columns. */
function searchClause(q) {
  const words = q.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!words.length) return "";
  return words
    .map((w) => "(" + SEARCH_COLS.map((c) => `${ident(c)} like ${lit("%" + w + "%")}`).join(" or ") + ")")
    .join(" and ");
}

/**
 * filters: Map<key, string[]>  where key is a DIM key or SEARCH_PARAM.
 * Values: plain literals, "lo..hi" ranges (BETWEEN), or NULL_TOKEN for blanks.
 */
export function whereClause(filters, { except, extra } = {}) {
  const parts = [];
  if (extra) parts.push(extra);
  for (const [key, values] of filters) {
    if (key === except || !values?.length) continue;
    if (key === SEARCH_PARAM) {
      const c = searchClause(values.join(" "));
      if (c) parts.push(c);
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
  return parts.length ? `where ${parts.join(" and ")}` : "";
}

/** One facet list: value, row count, measure. */
export function facetSql(dim, filters, measure, sort) {
  const d = ident(dim.col);
  const order = sort === "k" ? `${d}` : sort === "n" ? "n desc" : "v desc";
  return (
    `select ${d} as k, count(*) as n, ${measure.expr} as v from t ` +
    `${whereClause(filters, { except: dim.key })} group by ${d} order by ${order} limit ${dim.topN ?? 500}`
  );
}

/** Header totals. `maxYear` lets us learn how many months the final (partial) year holds. */
export function totalsSql(filters, maxYear) {
  return (
    `select count(*) as n, count(distinct plant_id_eia) as plants, min(year) as y0, max(year) as y1, ` +
    `max(case when year = ${Number(maxYear)} then n_months else 0 end) as m_last, ` +
    `round(sum(net_generation_mwh)/1000000.0, 1) as twh, round(sum(capacity_mw_months)/1000.0, 1) as gw_months, ` +
    `round(sum(net_generation_mwh)/(sum(capacity_mw_months)*730.5), 4) as cf from t ${whereClause(filters)}`
  );
}

/** Stacked year chart: year x fuel; `m` = months reported in that year so avg GW is right for partial years. */
export function yearSql(filters, measure) {
  return (
    `select year as k, fuel_type_code_pudl as f, ${measure.expr} as v, max(n_months) as m from t ` +
    `${whereClause(filters, { except: "year" })} group by year, fuel_type_code_pudl order by year, fuel_type_code_pudl`
  );
}

/** Seasonality from the twelve monthly columns, stacked by fuel. Null for measures without monthly columns. */
export function seasonSql(filters, measure) {
  if (!measure.monthly) return null;
  const cols = Array.from({ length: 12 }, (_, i) => `round(sum(${measure.monthly.prefix}_m${String(i + 1).padStart(2, "0")})/${measure.monthly.scale}.0, 3) as m${i + 1}`).join(", ");
  return `select fuel_type_code_pudl as f, ${cols} from t ${whereClause(filters)} group by fuel_type_code_pudl order by fuel_type_code_pudl`;
}

export function mapSql(filters, measure) {
  return (
    `select plant_id_eia as p, fuel_type_code_pudl as f, min(latitude) as lat, min(longitude) as lon, ${measure.expr} as v ` +
    `from t ${whereClause(filters, { extra: "latitude is not null" })} group by plant_id_eia, fuel_type_code_pudl order by v desc`
  );
}

/** Everything the map popup shows for one plant, under the current filters (except the plant filter itself). */
export function plantCardSql(plantId, filters) {
  const f = new Map(filters); f.delete("plant");
  return (
    `select plant_name_eia as name, state as state, utility_name_eia as utility, ba_code as ba, gem_wiki_url as wiki, gem_plant_name as gem, ` +
    `min(year) as y0, max(year) as y1, max(n_months) as m_last, ` +
    `round(sum(net_generation_mwh)/1000000.0, 2) as twh, round(sum(capacity_mw_months)/1000.0, 3) as gw_months, ` +
    `round(sum(net_generation_mwh)/(sum(capacity_mw_months)*730.5), 3) as cf, round(sum(co2_tons)/1000000.0, 3) as co2_mt, ` +
    `round(sum(co2_tons)/sum(case when co2_tons is not null then net_generation_mwh end), 3) as co2_mwh, ` +
    `round(sum(ferc_opex_total)/sum(case when ferc_opex_total is not null then net_generation_mwh end), 1) as opex_mwh, ` +
    `min(first_operating_year) as first_year ` +
    `from t ${whereClause(f, { extra: `plant_id_eia = ${Number(plantId)}` })} ` +
    `group by plant_name_eia, state, utility_name_eia, ba_code, gem_wiki_url, gem_plant_name order by twh desc limit 1`
  );
}

/** Technology mix of one plant under the current filters: avg MW per technology (capacity-months / months later). */
export function plantTechSql(plantId, filters) {
  const f = new Map(filters); f.delete("plant");
  return (
    `select technology_description as k, round(sum(capacity_mw_months), 1) as cap_months, round(sum(net_generation_mwh)/1000000.0, 3) as twh ` +
    `from t ${whereClause(f, { extra: `plant_id_eia = ${Number(plantId)}` })} group by technology_description order by cap_months desc limit 8`
  );
}

export function plantNameSql(plantId) {
  return `select plant_name_eia as name, state as state, gem_wiki_url as wiki, gem_plant_name as gem from t where plant_id_eia = ${Number(plantId)} order by year desc limit 1`;
}

export const GRID_COLS = [
  { col: "year", label: "Year", numeric: true, digits: 0, plain: true },
  { col: "plant_name_eia", label: "Plant", link: true },
  { col: "generator_id", label: "Gen" },
  { col: "utility_name_eia", label: "Utility" },
  { col: "state", label: "State" },
  { col: "technology_description", label: "Technology" },
  { col: "fuel_type_code_pudl", label: "Fuel" },
  { col: "operational_status", label: "Status" },
  { col: "generator_operating_date", label: "Online", date: true },
  { col: "generator_retirement_date", label: "Retired", date: true },
  { col: "capacity_mw", label: "MW", numeric: true, digits: 1 },
  { col: "net_generation_mwh", label: "Net MWh", numeric: true, digits: 0 },
  { col: "capacity_factor", label: "CF", numeric: true, digits: 2 },
  { col: "heat_rate_mmbtu_per_mwh", label: "Heat rate", numeric: true, digits: 2 },
  { col: "fuel_cost_per_mwh", label: "$/MWh", numeric: true, digits: 1 },
  { col: "co2_tons", label: "CO₂ t", numeric: true, digits: 0 },
  { col: "co2_tons_per_mwh", label: "t/MWh", numeric: true, digits: 3 },
  { col: "gem_wiki_url", label: "GEM", external: true },
];

export function gridSql(filters, sort, limit = 100) {
  const cols = [...GRID_COLS.map((c) => ident(c.col)), ident("plant_id_eia")].join(", ");
  const [col, dir] = sort;
  return `select ${cols} from t ${whereClause(filters)} order by ${ident(col)} ${dir === "asc" ? "asc" : "desc"} limit ${limit}`;
}
