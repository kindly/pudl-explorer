#!/bin/bash
# EPA CEMS hourly -> unit x month, one DuckDB process per year (bounded memory, restartable).
# Usage: scripts/cems-years.sh   (inside the Claude sandbox: DUCKDB_INIT=proxy.sql for the proxy SETs)
cd "$(dirname "$0")/.."
for y in $(seq 2010 2026); do
  out=/home/david/projects/pudl/data/cems/$y.parquet
  [ -s "$out" ] && { echo "$y done already"; continue; }
  t0=$(date +%s)
  duckdb -init "${DUCKDB_INIT:-/dev/null}" -csv <<SQL 2>&1 | grep -v Loading
INSTALL httpfs; LOAD httpfs;
CREATE OR REPLACE MACRO s3(t) AS 'https://s3.us-west-2.amazonaws.com/pudl.catalyst.coop/stable/' || t || '.parquet';
SET threads=4; SET memory_limit='3GB'; SET preserve_insertion_order=false;
COPY (
  SELECT plant_id_eia, plant_id_epa, emissions_unit_id_epa, year, month(operating_datetime_utc) AS month,
         count(*) AS hours, sum(operating_time_hours) AS operating_hours,
         sum(gross_load_mw * operating_time_hours) AS gross_load_mwh,
         sum(heat_content_mmbtu) AS heat_content_mmbtu,
         sum(co2_mass_tons) AS co2_mass_tons, sum(so2_mass_lbs) AS so2_mass_lbs, sum(nox_mass_lbs) AS nox_mass_lbs
  FROM read_parquet(s3('core_epacems__hourly_emissions'))
  WHERE year = $y
  GROUP BY 1, 2, 3, 4, 5
) TO '$out.tmp' (FORMAT parquet, COMPRESSION snappy);
SQL
  if [ -s "$out.tmp" ]; then mv "$out.tmp" "$out"; echo "$y ok $(( $(date +%s) - t0 ))s $(stat -c %s "$out") bytes"; else echo "$y FAILED"; fi
done
echo ALL-DONE
