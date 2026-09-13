// Fair comparison: the whole panel set as the page actually runs it, on each shape.
import { readFileSync } from "node:fs";
import { coreUrl, wasmUrl } from "./engine.js";
const eng = await (await import(coreUrl.href)).instantiate(readFileSync(wasmUrl));
const H = {};
for (const [k, f] of [["pty", "plant_tech_year"], ["gy", "generator_year"], ["zf", "generator_tech_wide"]])
  H[k] = eng.openTable(readFileSync(`../data/${f}.facetful`)).handle;
const Y = [...Array(17).keys()].map((i) => 2010 + i);
const S = `sum(${Y.map((y) => `gen_${y}`).join(" + ")})`;
const t = (h, sql) => { let b = 1e9; for (let k = 0; k < 7; k++) { const s = performance.now(); eng.query(h, sql); b = Math.min(b, performance.now() - s); } return b; };
const FACETS = [["fuel_type_code_pudl", 500], ["technology_description", 500], ["operational_status", 500],
  ["state", 500], ["ba_code", 500], ["utility_name_eia", 300], ["capacity_bucket", 500], ["operating_decade", 500]];
function run(label, where) {
  const out = {};
  // current page: facets + totals + year + season + map on plant_tech_year, grid on generator_year
  let a = 0;
  for (const [c, lim] of FACETS) a += t(H.pty, `select "${c}" as k, count(*) as n, round(sum(net_generation_mwh)/1000000.0,3) as v from t ${where} group by "${c}" order by v desc limit ${lim}`);
  a += t(H.pty, `select count(*) as n, count(distinct plant_id_eia) as p, round(sum(net_generation_mwh)/1000000.0,1) as twh, round(sum(capacity_mw_months)/1000.0,1) as gw from t ${where}`);
  a += t(H.pty, `select year as k, fuel_type_code_pudl as f, round(sum(net_generation_mwh)/1000000.0,3) as v, max(n_months) as m from t ${where} group by year, fuel_type_code_pudl order by year, fuel_type_code_pudl`);
  a += t(H.pty, `select fuel_type_code_pudl as f, ${[...Array(12).keys()].map((i) => `round(sum(gen_m${String(i + 1).padStart(2, "0")})/1000000.0,3) as m${i + 1}`).join(", ")} from t ${where} group by fuel_type_code_pudl`);
  a += t(H.pty, `select plant_id_eia as p, fuel_type_code_pudl as f, min(latitude) as lat, min(longitude) as lon, round(sum(net_generation_mwh)/1000000.0,3) as v from t ${where ? where + " and" : "where"} latitude is not null group by plant_id_eia, fuel_type_code_pudl order by v desc`);
  a += t(H.gy, `select plant_id_eia, generator_id, plant_name_eia, state, utility_name_eia, technology_description, operational_status, capacity_mw, net_generation_mwh, capacity_factor from t ${where} order by net_generation_mwh desc limit 100`);
  out.current = a;
  // wide page: everything on the zero-filled wide table except seasonality (still plant_tech_year)
  let b = 0;
  for (const [c, lim] of FACETS) b += t(H.zf, `select "${c}" as k, count(distinct gen_key) as n, count(distinct plant_id_eia) as np, round(${S}/1000000.0,3) as v from t ${where} group by "${c}" order by v desc limit ${lim}`);
  b += t(H.zf, `select count(distinct gen_key) as g, count(distinct plant_id_eia) as p, round(${S}/1000000.0,1) as twh from t ${where}`);
  b += t(H.zf, `select fuel_type_code_pudl as f, ${Y.map((y) => `round(sum(gen_${y})/1000000.0,3) as y${y}`).join(", ")} from t ${where} group by fuel_type_code_pudl`);
  b += t(H.pty, `select fuel_type_code_pudl as f, ${[...Array(12).keys()].map((i) => `round(sum(gen_m${String(i + 1).padStart(2, "0")})/1000000.0,3) as m${i + 1}`).join(", ")} from t ${where} group by fuel_type_code_pudl`);
  b += t(H.zf, `select plant_id_eia as p, fuel_type_code_pudl as f, min(latitude) as lat, min(longitude) as lon, round(${S}/1000000.0,3) as v from t ${where ? where + " and" : "where"} latitude is not null group by plant_id_eia, fuel_type_code_pudl order by v desc`);
  b += t(H.zf, `select plant_id_eia as p, generator_id as g, plant_name_eia as nm, state as st, utility_name_eia as u, technology_description as tc, operational_status as os, capacity_mw as mw, round((${Y.map((y) => `gen_${y}`).join(" + ")})/1000000.0,3) as twh, ${Y.map((y) => `gen_${y}`).join(", ")}, ${Y.map((y) => `cap_${y}`).join(", ")}, ${Y.map((y) => `co2_${y}`).join(", ")} from t ${where} order by twh desc limit 100`);
  out.wide = b;
  console.log(label.padEnd(32), ("current " + a.toFixed(0) + " ms").padStart(18), ("wide " + b.toFixed(0) + " ms").padStart(16));
}
console.log("13 panels, engine time".padEnd(32), "plant_tech_year + generator_year".padStart(18), "wide + both counts".padStart(18));
run("no filters", "");
run("fuel = coal", "where fuel_type_code_pudl = 'coal'");
run("state in TX, CA", "where state in ('TX','CA')");
run("search LIKE", "where plant_name_eia like '%energy%'");
