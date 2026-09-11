// Node harness: parquet -> facetful image (same code path as the browser worker),
// saves data/<name>.facetful and runs the explorer's candidate queries with timings.
import { readFileSync, writeFileSync } from "node:fs";
import { instantiate } from "./vendor/facetful/core.js";
import { parquetToColumns } from "./vendor/facetful/parquet.js";
import * as hp from "./vendor/hyparquet/src/index.js";

const src = process.argv[2] ?? "../data/eia_generator_month_2010plus.parquet";
const out = src.replace(/\.parquet$/, ".facetful");
const engine = await instantiate(readFileSync(new URL("./vendor/facetful/facetful_wasm.wasm", import.meta.url)));
let t0 = performance.now();
const buf = readFileSync(src);
const { rows, columns } = await parquetToColumns(hp, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
console.log(`decoded ${rows} rows x ${columns.length} cols in ${(performance.now()-t0)|0} ms; heap ${(process.memoryUsage().heapUsed/1e6)|0} MB`);
t0 = performance.now();
const img = engine.compileTable(rows, columns);
console.log(`compiled in ${(performance.now()-t0)|0} ms`);
const bytes = engine.imageBytes(img);
writeFileSync(out, bytes);
console.log(`wrote ${out} ${(bytes.length/1e6).toFixed(1)} MB`);
const { handle } = engine.openImage(img);
const dec = new TextDecoder();
const cell = (c, i) => {
  if (c.validity && !((c.validity[i >> 3] >> (i & 7)) & 1) && !(c.validity.length === c.rowCount)) {}
  if (c.kind === "text") return dec.decode(c.bytes.subarray(c.offsets[i], c.offsets[i + 1]));
  return c.values[i];
};
const Q = process.argv[3] ? [process.argv[3]] : [
  `select fuel_type_code_pudl as k, count(*) as n, count(distinct plant_id_eia) as plants, round(sum(net_generation_mwh)/1e6,2) as twh, round(sum(capacity_mw)/count(distinct report_date)/1000,2) as gw from t group by k order by n desc`,
  `select technology_description as k, count(*) as n, round(sum(net_generation_mwh)/1e6,2) as twh from t where state in ('TX','CA') and year between 2018 and 2024 group by k order by twh desc limit 50`,
  `select case when capacity_mw < 1 then 'a <1 MW' when capacity_mw < 10 then 'b 1-10' when capacity_mw < 100 then 'c 10-100' when capacity_mw < 500 then 'd 100-500' else 'e 500+' end as k, count(*) as n, round(sum(net_generation_mwh)/1e6,2) as twh from t group by k order by k`,
  `select (year(generator_operating_date)/10)*10 as k, count(*) as n, round(sum(net_generation_mwh)/1e6,2) as twh from t group by k order by k`,
  `select year as k, fuel_type_code_pudl as f, round(sum(net_generation_mwh)/1e6,3) as twh, round(sum(capacity_mw)/count(distinct report_date)/1000,3) as gw from t group by k, f order by k, f`,
  `select month as k, round(sum(net_generation_mwh)/1e6,3) as twh from t where year between 2015 and 2024 group by k order by k`,
  `select plant_id_eia as p, latitude as lat, longitude as lon, fuel_type_code_pudl as f, round(sum(net_generation_mwh)/1e6,3) as twh, max(capacity_mw) as mw from t where latitude is not null group by p, lat, lon, f order by twh desc`,
  `select count(*) as n from t where lower(plant_name_eia) like '%diablo%' or lower(utility_name_eia) like '%diablo%'`,
  `select report_date, plant_name_eia, generator_id, utility_name_eia, state, ba_code, technology_description, fuel_type_code_pudl, operational_status, capacity_mw, net_generation_mwh, round(capacity_factor,3) as cf, round(unit_heat_rate_mmbtu_per_mwh,2) as hr, round(fuel_cost_per_mwh,2) as fc from t where year = 2024 order by net_generation_mwh desc limit 100`,
  `select count(*) as n, count(distinct plant_id_eia) as plants, round(sum(net_generation_mwh)/1e6,1) as twh, round(sum(capacity_mw)/count(distinct report_date)/1000,1) as gw, round(avg(capacity_factor),3) as cf, min(report_date) as d0, max(report_date) as d1 from t`,
  `select utility_name_eia as k, count(*) as n, round(sum(net_generation_mwh)/1e6,2) as twh from t group by k order by twh desc limit 200`,
  `select strftime('%Y-%m', report_date) as k, round(sum(net_generation_mwh)/1e6,3) as twh from t where fuel_type_code_pudl = 'solar' group by k order by k`,
];
for (const sql of Q) {
  try {
    const t = performance.now();
    const r = engine.query(handle, sql);
    const ms = (performance.now() - t).toFixed(1);
    console.log(`\n[${ms} ms] ${r.rowCount} rows  ${sql.slice(0, 110)}`);
    console.log("   " + r.columns.map(c => `${c.name}:${c.kind}`).join("  "));
    for (let i = 0; i < Math.min(4, r.rowCount); i++) console.log("   " + r.columns.map(c => cell(c, i)).join(" | "));
  } catch (e) { console.log(`\nERROR ${sql.slice(0, 110)}\n${e.message}`); }
}
