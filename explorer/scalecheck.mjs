// Sanity-check the CO2-per-MW measure against physics: a coal unit should be thousands of t/MW.yr.
import { readFileSync } from "node:fs";
import { coreUrl, wasmUrl } from "./engine.js";
const { instantiate } = await import(coreUrl.href);
import { MEASURES, YEARS, measureExpr } from "./sql.js";
const eng = await instantiate(readFileSync(wasmUrl));
const h = eng.openTable(readFileSync("../data/generator_tech_wide.facetful")).handle;
const y = YEARS;
const span = (p) => y.map((k) => `${p}_${k}`).join(" + ");
const dec = new TextDecoder();
const q = (sql) => {
  const res = eng.query(h, sql);
  return Array.from({ length: res.rowCount }, (_, r) => Object.fromEntries(res.columns.map((c) => {
    if (c.kind === "text") return [c.name, dec.decode(c.bytes.subarray(c.offsets[r], c.offsets[r + 1]))];
    return [c.name, c.values[r]];
  })));
};
const asis = measureExpr(MEASURES.co2_mw, y);
const sql = `select fuel_type_code_pudl as f, ${asis} as as_is, ` +
  `round(sum(${span("co2")}) / nullif(sum(case when has_cems = 1 then (${span("cap")}) else 0 end), 0) * 12, 1) as times12, ` +
  `round(sum(${span("co2")}) / nullif(sum(case when has_cems = 1 then (${span("gen")}) else 0 end), 0), 3) as t_per_mwh, ` +
  `round(sum(${span("gen")}) / nullif(sum(case when has_cems = 1 then (${span("cap")}) else 0 end) * 730.5, 0), 3) as cf ` +
  `from t where has_cems = 1 group by fuel_type_code_pudl order by as_is desc limit 6`;
const r = q(sql);
console.log("fuel      as-is (scale 1/12)   x12   t/MWh    CF    implied t/MW.yr = t/MWh x CF x 8766");
for (const row of r) {
  const implied = row.t_per_mwh * row.cf * 8766;
  console.log(`${String(row.f).padEnd(9)} ${String(row.as_is).padStart(12)} ${String(row.times12).padStart(9)} ${String(row.t_per_mwh).padStart(7)} ${String(row.cf).padStart(6)} ${implied.toFixed(0).padStart(14)}`);
}
process.exit(0);
