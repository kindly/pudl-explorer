// What each count costs, and what each facet's natural unit is.
import { readFileSync } from "node:fs";
import { coreUrl, wasmUrl } from "./engine.js";
const eng = await (await import(coreUrl.href)).instantiate(readFileSync(wasmUrl));
const h = eng.openTable(readFileSync("../data/generator_tech_wide.facetful")).handle;
const Y = [...Array(17).keys()].map((i) => 2010 + i);
const S = `sum(${Y.map((y) => `gen_${y}`).join(" + ")})`;
const t = (sql) => { let b = 1e9; for (let k = 0; k < 9; k++) { const s = performance.now(); eng.query(h, sql); b = Math.min(b, performance.now() - s); } return b; };
const dec = new TextDecoder();
const rows = (sql) => { const r = eng.query(h, sql); const o = []; for (let i = 0; i < r.rowCount; i++) o.push(Object.fromEntries(r.columns.map((c) => [c.name, c.kind === "text" ? dec.decode(c.bytes.subarray(c.offsets[i], c.offsets[i + 1])) : c.values[i]]))); return o; };

console.log("cost per facet, grouped by fuel (10 groups), zero-filled, sum of 17 columns:");
for (const [label, expr] of [
  ["count(*)", "count(*) as n"],
  ["+ count(distinct gen_key)   int", "count(distinct gen_key) as n"],
  ["+ count(distinct gen_uid)   text", "count(distinct gen_uid) as n"],
  ["+ count(distinct plant_id_eia) int", "count(distinct plant_id_eia) as n"],
  ["+ generators and plants, both int", "count(distinct gen_key) as n, count(distinct plant_id_eia) as p"],
]) console.log("  " + label.padEnd(38), (t(`select fuel_type_code_pudl as k, ${expr}, round(${S}/1000000.0,3) as v from t group by fuel_type_code_pudl order by v desc`).toFixed(2) + " ms").padStart(9));

console.log("\ngenerators vs plants per facet (top value of each):");
const DIMS = [["fuel_type_code_pudl", "Fuel type"], ["technology_description", "Technology"], ["operational_status", "Status"],
  ["state", "State"], ["ba_code", "Balancing authority"], ["utility_name_eia", "Utility"],
  ["capacity_bucket", "Site capacity"], ["operating_decade", "Commissioned decade"]];
console.log("  " + "facet".padEnd(22), "top value".padEnd(34), "gens".padStart(7), "plants".padStart(8), "gens/plant".padStart(11));
for (const [col, label] of DIMS) {
  const r = rows(`select "${col}" as k, count(distinct gen_key) as g, count(distinct plant_id_eia) as p, round(${S}/1000000.0,1) as v from t group by "${col}" order by v desc limit 1`)[0];
  console.log("  " + label.padEnd(22), String(r.k).slice(0, 33).padEnd(34), String(r.g).padStart(7), String(r.p).padStart(8), (r.g / r.p).toFixed(2).padStart(11));
}
const tot = rows(`select count(distinct gen_key) as g, count(distinct plant_id_eia) as p from t`)[0];
console.log("  " + "ALL".padEnd(22), "".padEnd(34), String(tot.g).padStart(7), String(tot.p).padStart(8), (tot.g / tot.p).toFixed(2).padStart(11));
