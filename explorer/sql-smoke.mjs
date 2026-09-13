// Every panel's SQL, as the app builds it, against both images.
import { readFileSync } from "node:fs";
import { instantiate } from "./vendor/facetful/core.js";
import { DIMS, MEASURES, TABLES, NULL_TOKEN, facetSql, totalsSql, yearSql, seasonSql, mapSql,
  gridSql, gridCountSql, plantCardSql, plantTechSql, plantFercSql, plantNameSql } from "./sql.js";
const eng = await instantiate(readFileSync(new URL("./vendor/facetful/facetful_wasm.wasm", import.meta.url)));
const H = {};
for (const [k, f] of Object.entries(TABLES)) H[k] = eng.openTable(readFileSync(`../data/${f}.facetful`)).handle;
const states = [
  ["no filters", new Map()],
  ["fuel+year", new Map([["fuel", ["gas", "coal"]], ["year", ["2018..2024"]]])],
  ["state+search", new Map([["state", ["TX"]], ["q", ["wind"]]])],
  ["blanks+plant", new Map([["decade", ["2010", NULL_TOKEN]], ["cap", ["500+ MW"]], ["ba", [NULL_TOKEN]], ["plant", ["3"]]])],
];
let fails = 0, n = 0, slow = [];
for (const [mk, m] of Object.entries(MEASURES)) for (const [sl, f] of states) {
  const plan = [
    [m.table, totalsSql(f, m)], [m.table, yearSql(f, m)], ["pty", seasonSql(f, m)], [m.table, mapSql(f, m)],
    ["gw", gridCountSql(f)], ["gw", gridSql(f, ["twh", "desc"])], ["gw", gridSql(f, ["plant_name_eia", "asc"], { offset: 2000 })],
    ["gw", plantCardSql(3, f)], ["gw", plantTechSql(3, f)], ["pty", plantFercSql(3, f)], ["gw", plantNameSql(3)],
    ...DIMS.filter((d) => !d.group || d.group === m.group).flatMap((d) => ["k", "n", "v"].map((s) => [m.table, facetSql(d, f, m, s)])),
  ].filter(([, sql]) => sql);
  let tot = 0;
  for (const [tbl, sql] of plan) {
    n++;
    try { const t = performance.now(); eng.query(H[tbl], sql); const ms = performance.now() - t; tot += ms; slow.push([ms, sql.slice(0, 70)]); }
    catch (e) { fails++; console.log(`FAIL [${mk} / ${sl} / ${tbl}]\n  ${sql.slice(0, 150)}\n  ${e.message.split("\n")[0]}`); }
  }
  console.log(`${mk.padEnd(9)} ${sl.padEnd(14)} ${String(plan.length).padStart(3)} queries ${tot.toFixed(0).padStart(5)} ms`);
}
slow.sort((a, b) => b[0] - a[0]);
console.log("\nslowest:\n  " + slow.slice(0, 4).map(([ms, s]) => `${ms.toFixed(1)}ms ${s}`).join("\n  "));
console.log(fails ? `\n${fails} of ${n} FAILED` : `\nall ${n} queries ok`);
