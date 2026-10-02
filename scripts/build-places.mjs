// Build data/places_us.facetful(.gz) — the towns table behind the "near" filter — from
// GeoNames cities1000 (every populated place with population >= 1000, CC BY 4.0).
//
//   mkdir -p .geonames && cd .geonames
//   curl -LO https://download.geonames.org/export/dump/cities1000.zip && unzip cities1000.zip
//   curl -LO https://download.geonames.org/export/dump/admin1CodesASCII.txt
//   cd .. && node scripts/build-places.mjs .geonames
//
// Adapted from gem-explorer's script. The differences: this page is US-only, so the
// country column goes (it would be the same string on every row) and the region is the
// state name; and the output lands in data/ next to the other images.
//
// Rows are written largest population first, so a prefix match's first hits are the
// places people most likely mean (Springfield, Missouri before Springfield, Vermont).
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { DIR } from "../explorer/engine.js";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node scripts/build-places.mjs <geonames dir>");

const admin1 = new Map();
for (const line of readFileSync(`${dir}/admin1CodesASCII.txt`, "utf8").split("\n")) {
  const [code, name] = line.split("\t");
  if (code && name) admin1.set(code, name);
}

const rows = [];
for (const line of readFileSync(`${dir}/cities1000.txt`, "utf8").split("\n")) {
  const f = line.split("\t");
  if (f.length < 15) continue;
  const [id, name, ascii, , lat, lon, , , cc, , a1] = f;
  if (cc !== "US") continue;
  rows.push({
    id: Number(id),
    name,
    // only where it differs, so a plain-ASCII search still finds Cañon City; blank otherwise
    ascii: ascii === name ? "" : ascii,
    region: admin1.get(`${cc}.${a1}`) ?? "",
    // 3 decimals is about 100 m: far below the smallest radius, and it gzips much better
    lat: Math.round(Number(lat) * 1e3) / 1e3,
    lon: Math.round(Number(lon) * 1e3) / 1e3,
    population: Number(f[14]) || 0,
  });
}
rows.sort((a, b) => b.population - a.population || a.id - b.id);

const csvCell = (v) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const cols = ["id", "name", "ascii", "region", "lat", "lon", "population"];
const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
const csvPath = `${dir}/places_us.csv`;
writeFileSync(csvPath, csv);

const out = "data/places_us.facetful";
const cli = fileURLToPath(new URL(DIR + "bin/facetful.mjs", new URL("../explorer/", import.meta.url)));
execFileSync(process.execPath, [cli, "convert", csvPath, out], { stdio: "inherit" });
writeFileSync(`${out}.gz`, gzipSync(readFileSync(out), { level: 9 }));
console.log(`${rows.length} US places -> ${out} (+ .gz)`);
