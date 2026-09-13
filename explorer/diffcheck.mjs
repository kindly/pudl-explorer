// Same queries on both builds: every cell must match.
import { readFileSync } from "node:fs";
import { DIR } from "./engine.js";
const dirs = { old: process.env.TMPDIR + "/facetful-old", new: DIR.replace(/\/$/, "") };
const eng = {};
for (const [t, d] of Object.entries(dirs)) eng[t] = await (await import(`${d}/core.js`)).instantiate(readFileSync(`${d}/facetful_wasm.wasm`));
const dec = new TextDecoder();
const dump = (r) => { const out = []; for (let i = 0; i < r.rowCount; i++) out.push(r.columns.map((c) => c.kind === "text" ? dec.decode(c.bytes.subarray(c.offsets[i], c.offsets[i + 1])) : c.values[i]).join("|")); return out.join("\n"); };
const Y = [...Array(17).keys()].map((i) => 2010 + i);
const agg = (p) => `sum(${Y.map((y) => `coalesce(${p}_${y},0)`).join(" + ")})`;
const suite = {
  plant_tech_year: [
    "select fuel_type_code_pudl as k, count(*) as n, round(sum(net_generation_mwh)/1000000.0,3) as v from t group by fuel_type_code_pudl order by v desc",
    "select state as k, count(*) as n, round(sum(net_generation_mwh)/1000000.0,3) as v from t where fuel_type_code_pudl = 'coal' group by state order by v desc",
    "select year as k, fuel_type_code_pudl as f, round(sum(net_generation_mwh)/1000000.0,3) as v from t group by year, fuel_type_code_pudl order by year, fuel_type_code_pudl",
    "select count(*) as n from t where plant_name_eia like '%diablo%' or utility_name_eia like '%diablo%'",
    "select count(*) as n, count(distinct plant_id_eia) as p, round(sum(net_generation_mwh)/1000000.0,1) as twh, round(sum(co2_tons)/1000000.0,1) as co2 from t",
    "select plant_id_eia as p, fuel_type_code_pudl as f, min(latitude) as lat, round(sum(net_generation_mwh)/1000000.0,3) as v from t where latitude is not null group by plant_id_eia, fuel_type_code_pudl order by v desc limit 500",
    "select technology_description as k, count(*) as n, round(sum(total_fuel_cost)/1000000000.0,3) as v from t where state in ('TX','CA') and year between 2018 and 2024 group by technology_description order by v desc",
  ],
  generator_tech_wide: [
    `select fuel_type_code_pudl as k, count(distinct gen_uid) as n, round(${agg("gen")}/1000000.0,3) as v from t group by fuel_type_code_pudl order by v desc`,
    `select plant_id_eia as p, generator_id as g, round(${agg("gen")}/1000000.0,3) as twh from t group by plant_id_eia, generator_id order by twh desc limit 200`,
    `select count(distinct gen_uid) as gens, round(${agg("co2")}/1000000.0,1) as co2 from t`,
  ],
};
let bad = 0, n = 0;
for (const [table, qs] of Object.entries(suite)) {
  const h = {}; for (const t of ["old", "new"]) h[t] = eng[t].openTable(readFileSync(`../data/${table}.facetful`)).handle;
  for (const sql of qs) {
    n++;
    const a = dump(eng.old.query(h.old, sql)), b = dump(eng.new.query(h.new, sql));
    if (a !== b) { bad++; console.log("MISMATCH:", sql.slice(0, 80)); const A = a.split("\n"), B = b.split("\n");
      for (let i = 0; i < Math.max(A.length, B.length); i++) if (A[i] !== B[i]) { console.log("  old:", A[i], "\n  new:", B[i]); break; } }
  }
}
console.log(bad ? `${bad} of ${n} queries differ` : `all ${n} queries identical between builds`);
