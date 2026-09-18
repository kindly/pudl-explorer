// Is count(distinct) itself faster? Isolates it the same way docs/facetful-count-distinct.md did.
// FACETFUL_OLD=<dir> node countperf.mjs   compares that build against the vendored one.
import { readFileSync } from "node:fs";
import { coreUrl, wasmUrl } from "./engine.js";
import { YEARS } from "./sql.js";

const OLD = process.env.FACETFUL_OLD;
const builds = {};
{
  const { instantiate } = await import(coreUrl.href);
  builds.new = { eng: await instantiate(readFileSync(wasmUrl)), H: {} };
}
if (OLD) {
  const { instantiate } = await import(`${OLD}/core.js`);
  builds.old = { eng: await instantiate(readFileSync(`${OLD}/facetful_wasm.wasm`)), H: {} };
}
for (const b of Object.values(builds)) {
  b.H.gw = b.eng.openTable(readFileSync("../data/generator_tech_wide.facetful")).handle;
  b.H.pty = b.eng.openTable(readFileSync("../data/plant_tech_year.facetful")).handle;
}
const span = (p) => YEARS.map((y) => `${p}_${y}`).join(" + ");
const MEAS = { gw: `round(sum(${span("gen")})/1000000.0, 3)`, pty: "round(sum(net_generation_mwh)/1000000.0, 3)" };
const best = (b, tbl, sql, n = 15) => {
  let t = Infinity;
  for (let i = 0; i < n; i++) { const s = performance.now(); b.eng.query(b.H[tbl], sql); t = Math.min(t, performance.now() - s); }
  return t;
};
const tags = OLD ? ["old", "new"] : ["new"];
const head = "variant".padEnd(30) + tags.map((t) => t.padStart(10)).join("") + (OLD ? "change".padStart(12) : "");
for (const [tbl, rows] of [["gw", "42,257"], ["pty", "230,891"]]) {
  console.log(`\n=== ${tbl} (${rows} rows), group by fuel ===`);
  console.log(head);
  const m = MEAS[tbl];
  // a bare literal is not a legal select item next to a GROUP BY, so the counts-only
  // variants drop the measure and the ORDER BY with it
  const byV = (sel) => `select fuel_type_code_pudl as k, ${sel} from t group by fuel_type_code_pudl order by v desc limit 500`;
  const plain = (sel) => `select fuel_type_code_pudl as k, ${sel} from t group by fuel_type_code_pudl limit 500`;
  const variants = [
    ["count(*) + measure", byV(`count(*) as n, ${m} as v`)],
    ["1 distinct + measure", byV(`count(distinct plant_id_eia) as n, ${m} as v`)],
    ...(tbl === "gw" ? [["2 distinct + measure", byV(`count(distinct plant_id_eia) as n, count(distinct gen_key) as g, ${m} as v`)]] : []),
    ["measure only", byV(`${m} as v`)],
    ["count(*) only", plain("count(*) as n")],
    ["1 distinct only", plain("count(distinct plant_id_eia) as n")],
    ...(tbl === "gw" ? [["2 distinct only", plain("count(distinct plant_id_eia) as n, count(distinct gen_key) as g")]] : []),
  ];
  for (const [label, sql] of variants) {
    const t = Object.fromEntries(tags.map((g) => [g, best(builds[g], tbl, sql)]));
    const change = OLD ? `${(t.old / t.new).toFixed(2)}x ${t.new <= t.old ? "faster" : "SLOWER"}` : "";
    console.log(label.padEnd(30) + tags.map((g) => t[g].toFixed(1).padStart(10)).join("") + "   " + change);
  }
}
console.log("\nbest-of-15, milliseconds");
