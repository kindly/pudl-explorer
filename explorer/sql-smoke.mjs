// Runs every panel's SQL (as the app would build it) against both images, with a few filter states.
import { readFileSync } from "node:fs";
import { instantiate } from "./vendor/facetful/core.js";
import { DIMS, MEASURES, facetSql, totalsSql, yearSql, seasonSql, mapSql, gridSql, plantNameSql, NULL_TOKEN } from "./sql.js";
const engine = await instantiate(readFileSync(new URL("./vendor/facetful/facetful_wasm.wasm", import.meta.url)));
const pty = engine.openTable(readFileSync("../data/plant_tech_year.facetful")).handle;
const gy = engine.openTable(readFileSync("../data/generator_year.facetful")).handle;
const states = [
  new Map(),
  new Map([["fuel", ["gas", "coal"]], ["year", ["2018..2024"]]]),
  new Map([["state", ["TX"]], ["q", ["wind"]]]),
  new Map([["decade", ["2010", NULL_TOKEN]], ["cap", ["500+ MW"]], ["ba", [NULL_TOKEN]], ["plant", ["6008"]]]),
];
let fails = 0, worst = [];
for (const m of Object.keys(MEASURES)) for (const [i, f] of states.entries()) {
  const measure = MEASURES[m];
  const plan = [[pty, totalsSql(f, 2026)], [pty, yearSql(f, measure)], [pty, seasonSql(f, measure)], [pty, mapSql(f, measure)], [pty, plantNameSql(6008)],
    [gy, gridSql(f, ["net_generation_mwh", "desc"])], [gy, gridSql(f, ["plant_name_eia", "asc"])],
    ...DIMS.flatMap((d) => ["k", "n", "v"].map((s) => [pty, facetSql(d, f, measure, s)]))].filter(([, sql]) => sql);
  let tot = 0;
  for (const [h, sql] of plan) {
    try { const t = performance.now(); const r = engine.query(h, sql); const ms = performance.now() - t; tot += ms; worst.push([ms, sql.slice(0, 90)]);
      if (m === "twh" && i === 0 && sql.startsWith("select count(*)")) console.log("totals:", r.columns.map((c) => `${c.name}=${c.values?.[0]}`).join(" "));
    } catch (e) { fails++; console.log(`FAIL [${m} state${i}] ${sql}\n   ${e.message.split("\n")[0]}`); }
  }
  console.log(`${m} state${i}: ${plan.length} queries, ${tot.toFixed(0)} ms total`);
}
worst.sort((a, b) => b[0] - a[0]);
console.log("slowest:", worst.slice(0, 5).map(([ms, s]) => `${ms.toFixed(1)}ms ${s}`).join("\n         "));
console.log(fails ? `${fails} failures` : "all panel SQL ok");
