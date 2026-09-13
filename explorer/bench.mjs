// Old vs new facetful on the exact queries this page runs.
import { readFileSync } from "node:fs";
import { DIR } from "./engine.js";
const OLD = process.env.TMPDIR + "/facetful-old";
const engines = {};
for (const [tag, dir] of [["old", OLD], ["new", DIR.replace(/\/$/, "")]]) {
  const { instantiate } = await import(`${dir}/core.js`);
  engines[tag] = await instantiate(readFileSync(`${dir}/facetful_wasm.wasm`));
}
const Y = [...Array(17).keys()].map((i) => 2010 + i);
const inner = (p) => Y.map((y) => `coalesce(${p}_${y},0)`).join(" + ");
const agg = (p) => `sum(${inner(p)})`;
const W = "where state in ('TX','CA') and fuel_type_code_pudl = 'gas'";
const SUITE = {
  "plant_tech_year": [
    ["facet fuel", "select fuel_type_code_pudl as k, count(*) as n, round(sum(net_generation_mwh)/1000000.0,3) as v from t group by fuel_type_code_pudl order by v desc limit 500"],
    ["facet state", "select state as k, count(*) as n, round(sum(net_generation_mwh)/1000000.0,3) as v from t group by state order by v desc limit 500"],
    ["facet utility 300", "select utility_name_eia as k, count(*) as n, round(sum(net_generation_mwh)/1000000.0,3) as v from t group by utility_name_eia order by v desc limit 300"],
    ["facet fuel, filtered", `select fuel_type_code_pudl as k, count(*) as n, round(sum(net_generation_mwh)/1000000.0,3) as v from t ${W} group by fuel_type_code_pudl order by v desc limit 500`],
    ["totals", "select count(*) as n, count(distinct plant_id_eia) as plants, round(sum(net_generation_mwh)/1000000.0,1) as twh, round(sum(capacity_mw_months)/1000.0,1) as gw from t"],
    ["year chart", "select year as k, fuel_type_code_pudl as f, round(sum(net_generation_mwh)/1000000.0,3) as v, max(n_months) as m from t group by year, fuel_type_code_pudl order by year, fuel_type_code_pudl"],
    ["map", "select plant_id_eia as p, fuel_type_code_pudl as f, min(latitude) as lat, min(longitude) as lon, round(sum(net_generation_mwh)/1000000.0,3) as v from t where latitude is not null group by plant_id_eia, fuel_type_code_pudl order by v desc"],
    ["search LIKE", "select count(*) as n from t where plant_name_eia like '%diablo%' or utility_name_eia like '%diablo%'"],
  ],
  "generator_tech_wide": [
    ["facet fuel (count distinct)", `select fuel_type_code_pudl as k, count(distinct gen_key) as n, round(${agg("gen")}/1000000.0,3) as v from t group by fuel_type_code_pudl order by v desc limit 500`],
    ["facet state", `select state as k, count(distinct gen_key) as n, round(${agg("gen")}/1000000.0,3) as v from t group by state order by v desc limit 500`],
    ["facet utility 300", `select utility_name_eia as k, count(distinct gen_key) as n, round(${agg("gen")}/1000000.0,3) as v from t group by utility_name_eia order by v desc limit 300`],
    ["facet fuel, filtered", `select fuel_type_code_pudl as k, count(distinct gen_key) as n, round(${agg("gen")}/1000000.0,3) as v from t ${W} group by fuel_type_code_pudl order by v desc limit 500`],
    ["totals", `select count(distinct gen_key) as gens, count(distinct plant_id_eia) as plants, round(${agg("gen")}/1000000.0,1) as twh from t`],
    ["grid page 100", `select plant_id_eia as p, generator_id as g, plant_name_eia as name, state as st, utility_name_eia as u, technology_description as tech, operational_status as s, capacity_mw as mw, round((${inner("gen")})/1000000.0,3) as twh, ${Y.map((y) => `gen_${y}`).join(", ")} from t order by twh desc limit 100`],
    ["grid page offset 20k", `select plant_id_eia as p, generator_id as g, plant_name_eia as name, round((${inner("gen")})/1000000.0,3) as twh, ${Y.map((y) => `gen_${y}`).join(", ")} from t order by twh desc limit 100 offset 20000`],
    ["map", `select plant_id_eia as p, fuel_type_code_pudl as f, min(latitude) as lat, min(longitude) as lon, round(${agg("gen")}/1000000.0,3) as v from t where latitude is not null group by plant_id_eia, fuel_type_code_pudl order by v desc`],
  ],
};
const pad = (s, n) => String(s).padEnd(n);
for (const [table, qs] of Object.entries(SUITE)) {
  const h = {};
  for (const tag of ["old", "new"]) h[tag] = engines[tag].openTable(readFileSync(`../data/${table}.facetful`)).handle;
  console.log(`\n=== ${table} ===`);
  console.log(pad("query", 30), pad("old", 10), pad("new", 10), "change");
  let to = 0, tn = 0;
  for (const [label, sql] of qs) {
    const t = {};
    for (const tag of ["old", "new"]) {
      let best = 1e9;
      for (let k = 0; k < 7; k++) { const s = performance.now(); engines[tag].query(h[tag], sql); best = Math.min(best, performance.now() - s); }
      t[tag] = best;
    }
    to += t.old; tn += t.new;
    const f = t.old / t.new;
    console.log(pad(label, 30), pad(t.old.toFixed(1) + " ms", 10), pad(t.new.toFixed(1) + " ms", 10), f >= 1 ? `${f.toFixed(2)}x faster` : `${(1 / f).toFixed(2)}x SLOWER`);
  }
  console.log(pad("TOTAL", 30), pad(to.toFixed(1) + " ms", 10), pad(tn.toFixed(1) + " ms", 10), `${(to / tn).toFixed(2)}x`);
}
