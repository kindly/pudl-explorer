-- Two-table model for the explorer, built from data/eia_generator_month_2010plus.parquet
-- (itself built by build-generator-month.sql). Run from the pudl directory:
--   duckdb < scripts/build-aggregates.sql
--
-- plant_tech_year: one row per plant x technology x operational status x year (~231K rows). Drives
--   facets, totals, years chart, map and seasonality. Additive quantities only (capacity-months,
--   generation, cost, MMBtu) so ratios are computed at query time and stay right under any filter.
--   Twelve monthly columns each for generation, fuel cost and fuel burned feed the seasonality chart.
-- generator_year: one row per generator x year (~485K rows). Drives the grid / plant drill-down.
-- Both share the dimension column names so one WHERE clause works on either table.
-- Requires build-costs.sql (FERC) and build-emissions.sql (CEMS) outputs in data/ first.

CREATE OR REPLACE VIEW g AS SELECT * FROM 'data/eia_generator_month_2010plus.parquet';

CREATE OR REPLACE MACRO bucket(mw) AS
  CASE WHEN mw IS NULL THEN NULL WHEN mw < 1 THEN '< 1 MW' WHEN mw < 10 THEN '1-10 MW'
       WHEN mw < 100 THEN '10-100 MW' WHEN mw < 500 THEN '100-500 MW' ELSE '500+ MW' END;

-- group-level attributes shared by both tables, so a filter means the same thing in each
CREATE OR REPLACE TABLE grp AS
  SELECT plant_id_eia, technology_description, operational_status, year,
         sum(capacity_mw) / count(DISTINCT report_date) AS grp_avg_mw,
         min(year(generator_operating_date)) AS first_operating_year
  FROM g GROUP BY 1, 2, 3, 4;

-- GEM wiki links: data/gem_us_plants_eia.csv is exported from GEM's database (US plants carrying an EIA plant id).
-- GEM often splits a site by technology, so pick, per EIA plant x PUDL fuel type, the GEM plant whose fuel
-- categories match (largest first), else the largest GEM plant at that EIA id.
CREATE OR REPLACE TABLE gem_raw AS
  SELECT try_cast(trim(eia_plant_id) AS BIGINT) AS plant_id_eia, gem_plant_id, gem_plant_name, gem_wiki_url,
         gem_total_mw, gem_operating_mw,
         regexp_split_to_array(trim(both '{}' FROM fuel_categories), ',') AS cats
  FROM read_csv('data/gem_us_plants_eia.csv', header = true, all_varchar = true)
  WHERE gem_wiki_url <> '';
CREATE OR REPLACE TABLE fuel_cat AS SELECT * FROM (VALUES
  ('coal','2'), ('gas','3'), ('oil','4'), ('solar','7'), ('wind','8'), ('nuclear','9'), ('hydro','11'),
  ('waste','1'), ('other','5'), ('other','6'), ('other','10')) t(fuel_type_code_pudl, cat);
CREATE OR REPLACE TABLE gem_link AS
  WITH fuels AS (SELECT DISTINCT plant_id_eia, fuel_type_code_pudl FROM g),
  cand AS (
    SELECT f.plant_id_eia, f.fuel_type_code_pudl, r.gem_plant_id, r.gem_plant_name, r.gem_wiki_url,
           CASE WHEN EXISTS (SELECT 1 FROM fuel_cat fc WHERE fc.fuel_type_code_pudl = f.fuel_type_code_pudl AND list_contains(r.cats, fc.cat)) THEN 1 ELSE 2 END AS match_rank,
           try_cast(r.gem_total_mw AS DOUBLE) AS mw
    FROM fuels f JOIN gem_raw r USING (plant_id_eia))
  SELECT plant_id_eia, fuel_type_code_pudl, gem_plant_id, gem_plant_name, gem_wiki_url
  FROM (SELECT *, row_number() OVER (PARTITION BY plant_id_eia, fuel_type_code_pudl ORDER BY match_rank, mw DESC NULLS LAST) AS rn FROM cand)
  WHERE rn = 1;

COPY (
  WITH base AS (
  SELECT g.plant_id_eia, g.technology_description, g.operational_status, g.year,
         any_value(plant_id_pudl) AS plant_id_pudl, any_value(plant_name_eia) AS plant_name_eia, any_value(state) AS state, any_value(county) AS county,
         any_value(ba_code) AS ba_code, any_value(utility_id_eia) AS utility_id_eia, any_value(utility_name_eia) AS utility_name_eia,
         any_value(fuel_type_code_pudl) AS fuel_type_code_pudl, any_value(prime_mover_code) AS prime_mover_code,
         any_value(latitude) AS latitude, any_value(longitude) AS longitude,
         bucket(any_value(grp_avg_mw)) AS capacity_bucket,
         CAST((any_value(first_operating_year) // 10) * 10 AS INTEGER) AS operating_decade,
         any_value(first_operating_year) AS first_operating_year,
         max(year(generator_retirement_date)) AS last_retirement_year,
         count(DISTINCT generator_id) AS generators,
         count(DISTINCT report_date) AS n_months,
         round(sum(capacity_mw), 1) AS capacity_mw_months,
         round(sum(net_generation_mwh)) AS net_generation_mwh,
         round(sum(total_fuel_cost)) AS total_fuel_cost,
         round(sum(total_mmbtu)) AS total_mmbtu,
         round(sum(net_generation_mwh) FILTER (WHERE month = 1)) AS gen_m01, round(sum(net_generation_mwh) FILTER (WHERE month = 2)) AS gen_m02,
         round(sum(net_generation_mwh) FILTER (WHERE month = 3)) AS gen_m03, round(sum(net_generation_mwh) FILTER (WHERE month = 4)) AS gen_m04,
         round(sum(net_generation_mwh) FILTER (WHERE month = 5)) AS gen_m05, round(sum(net_generation_mwh) FILTER (WHERE month = 6)) AS gen_m06,
         round(sum(net_generation_mwh) FILTER (WHERE month = 7)) AS gen_m07, round(sum(net_generation_mwh) FILTER (WHERE month = 8)) AS gen_m08,
         round(sum(net_generation_mwh) FILTER (WHERE month = 9)) AS gen_m09, round(sum(net_generation_mwh) FILTER (WHERE month = 10)) AS gen_m10,
         round(sum(net_generation_mwh) FILTER (WHERE month = 11)) AS gen_m11, round(sum(net_generation_mwh) FILTER (WHERE month = 12)) AS gen_m12,
         round(sum(total_fuel_cost) FILTER (WHERE month = 1)) AS cost_m01, round(sum(total_fuel_cost) FILTER (WHERE month = 2)) AS cost_m02,
         round(sum(total_fuel_cost) FILTER (WHERE month = 3)) AS cost_m03, round(sum(total_fuel_cost) FILTER (WHERE month = 4)) AS cost_m04,
         round(sum(total_fuel_cost) FILTER (WHERE month = 5)) AS cost_m05, round(sum(total_fuel_cost) FILTER (WHERE month = 6)) AS cost_m06,
         round(sum(total_fuel_cost) FILTER (WHERE month = 7)) AS cost_m07, round(sum(total_fuel_cost) FILTER (WHERE month = 8)) AS cost_m08,
         round(sum(total_fuel_cost) FILTER (WHERE month = 9)) AS cost_m09, round(sum(total_fuel_cost) FILTER (WHERE month = 10)) AS cost_m10,
         round(sum(total_fuel_cost) FILTER (WHERE month = 11)) AS cost_m11, round(sum(total_fuel_cost) FILTER (WHERE month = 12)) AS cost_m12,
         round(sum(total_mmbtu) FILTER (WHERE month = 1)) AS mmbtu_m01, round(sum(total_mmbtu) FILTER (WHERE month = 2)) AS mmbtu_m02,
         round(sum(total_mmbtu) FILTER (WHERE month = 3)) AS mmbtu_m03, round(sum(total_mmbtu) FILTER (WHERE month = 4)) AS mmbtu_m04,
         round(sum(total_mmbtu) FILTER (WHERE month = 5)) AS mmbtu_m05, round(sum(total_mmbtu) FILTER (WHERE month = 6)) AS mmbtu_m06,
         round(sum(total_mmbtu) FILTER (WHERE month = 7)) AS mmbtu_m07, round(sum(total_mmbtu) FILTER (WHERE month = 8)) AS mmbtu_m08,
         round(sum(total_mmbtu) FILTER (WHERE month = 9)) AS mmbtu_m09, round(sum(total_mmbtu) FILTER (WHERE month = 10)) AS mmbtu_m10,
         round(sum(total_mmbtu) FILTER (WHERE month = 11)) AS mmbtu_m11, round(sum(total_mmbtu) FILTER (WHERE month = 12)) AS mmbtu_m12
  FROM g JOIN grp ON grp.plant_id_eia = g.plant_id_eia AND grp.year = g.year
       AND grp.technology_description IS NOT DISTINCT FROM g.technology_description
       AND grp.operational_status IS NOT DISTINCT FROM g.operational_status
  GROUP BY 1, 2, 3, 4
  ),
  ferc AS (SELECT * FROM 'data/ferc_plant_tech_year.parquet'),
  cems AS (SELECT * FROM 'data/cems_plant_tech_year.parquet')
  SELECT base.*, gem.gem_plant_name, gem.gem_wiki_url,
         ferc.ferc_capex_total, ferc.ferc_opex_fuel, ferc.ferc_opex_nonfuel, ferc.ferc_opex_total, ferc.ferc_records, ferc.ferc_allocation,
         cems.co2_tons, cems.so2_tons, cems.nox_tons, cems.cems_gross_mwh, cems.cems_heat_mmbtu, cems.cems_allocation,
         CASE WHEN cems.co2_tons IS NULL OR base.net_generation_mwh IS NULL OR base.net_generation_mwh <= 0 THEN NULL
              WHEN cems.co2_tons / base.net_generation_mwh < 0.2 THEN '< 0.2'
              WHEN cems.co2_tons / base.net_generation_mwh < 0.4 THEN '0.2-0.4'
              WHEN cems.co2_tons / base.net_generation_mwh < 0.6 THEN '0.4-0.6'
              WHEN cems.co2_tons / base.net_generation_mwh < 0.9 THEN '0.6-0.9'
              ELSE '0.9+' END AS co2_intensity_bucket,
         cems.co2_m01, cems.co2_m02, cems.co2_m03, cems.co2_m04, cems.co2_m05, cems.co2_m06,
         cems.co2_m07, cems.co2_m08, cems.co2_m09, cems.co2_m10, cems.co2_m11, cems.co2_m12
  FROM base
  LEFT JOIN ferc ON ferc.plant_id_eia = base.plant_id_eia AND ferc.year = base.year
       AND ferc.technology_description IS NOT DISTINCT FROM base.technology_description
       AND ferc.operational_status IS NOT DISTINCT FROM base.operational_status
  LEFT JOIN cems ON cems.plant_id_eia = base.plant_id_eia AND cems.year = base.year
       AND cems.technology_description IS NOT DISTINCT FROM base.technology_description
       AND cems.operational_status IS NOT DISTINCT FROM base.operational_status
  LEFT JOIN gem_link gem ON gem.plant_id_eia = base.plant_id_eia AND gem.fuel_type_code_pudl IS NOT DISTINCT FROM base.fuel_type_code_pudl
  ORDER BY base.plant_id_eia, base.technology_description, base.operational_status, base.year
) TO 'data/plant_tech_year.parquet' (FORMAT parquet, COMPRESSION snappy, ROW_GROUP_SIZE 65536);

COPY (
  WITH base AS (
  SELECT g.plant_id_eia, g.generator_id, g.year,
         any_value(plant_name_eia) AS plant_name_eia, any_value(state) AS state, any_value(county) AS county,
         any_value(ba_code) AS ba_code, any_value(utility_id_eia) AS utility_id_eia, any_value(utility_name_eia) AS utility_name_eia,
         g.technology_description, any_value(prime_mover_code) AS prime_mover_code,
         any_value(fuel_type_code_pudl) AS fuel_type_code_pudl, any_value(energy_source_code_1) AS energy_source_code_1,
         g.operational_status,
         bucket(any_value(grp_avg_mw)) AS capacity_bucket,
         CAST((any_value(first_operating_year) // 10) * 10 AS INTEGER) AS operating_decade,
         any_value(generator_operating_date) AS generator_operating_date,
         any_value(generator_retirement_date) AS generator_retirement_date,
         any_value(latitude) AS latitude, any_value(longitude) AS longitude,
         count(DISTINCT report_date) AS n_months,
         round(sum(capacity_mw) / count(DISTINCT report_date), 1) AS capacity_mw,
         round(sum(capacity_mw), 1) AS capacity_mw_months,
         round(sum(net_generation_mwh)) AS net_generation_mwh,
         round(sum(net_generation_mwh) / nullif(sum(capacity_mw) * 730.5, 0), 3) AS capacity_factor,
         round(sum(total_fuel_cost)) AS total_fuel_cost,
         round(sum(total_mmbtu)) AS total_mmbtu,
         round(sum(total_mmbtu) / nullif(sum(net_generation_mwh), 0), 2) AS heat_rate_mmbtu_per_mwh,
         round(sum(total_fuel_cost) / nullif(sum(net_generation_mwh), 0), 2) AS fuel_cost_per_mwh,
         round(sum(net_generation_mwh) FILTER (WHERE month = 1)) AS gen_m01, round(sum(net_generation_mwh) FILTER (WHERE month = 2)) AS gen_m02,
         round(sum(net_generation_mwh) FILTER (WHERE month = 3)) AS gen_m03, round(sum(net_generation_mwh) FILTER (WHERE month = 4)) AS gen_m04,
         round(sum(net_generation_mwh) FILTER (WHERE month = 5)) AS gen_m05, round(sum(net_generation_mwh) FILTER (WHERE month = 6)) AS gen_m06,
         round(sum(net_generation_mwh) FILTER (WHERE month = 7)) AS gen_m07, round(sum(net_generation_mwh) FILTER (WHERE month = 8)) AS gen_m08,
         round(sum(net_generation_mwh) FILTER (WHERE month = 9)) AS gen_m09, round(sum(net_generation_mwh) FILTER (WHERE month = 10)) AS gen_m10,
         round(sum(net_generation_mwh) FILTER (WHERE month = 11)) AS gen_m11, round(sum(net_generation_mwh) FILTER (WHERE month = 12)) AS gen_m12
  FROM g JOIN grp ON grp.plant_id_eia = g.plant_id_eia AND grp.year = g.year
       AND grp.technology_description IS NOT DISTINCT FROM g.technology_description
       AND grp.operational_status IS NOT DISTINCT FROM g.operational_status
  GROUP BY g.plant_id_eia, g.generator_id, g.year, g.technology_description, g.operational_status
  )
  SELECT base.*, c.co2_tons, c.so2_tons, c.nox_tons, c.cems_gross_mwh, c.cems_allocation,
         round(c.co2_tons / nullif(base.net_generation_mwh, 0), 4) AS co2_tons_per_mwh,
         gem.gem_plant_name, gem.gem_wiki_url
  FROM base LEFT JOIN 'data/cems_generator_year.parquet' c USING (plant_id_eia, generator_id, year)
  LEFT JOIN gem_link gem ON gem.plant_id_eia = base.plant_id_eia AND gem.fuel_type_code_pudl IS NOT DISTINCT FROM base.fuel_type_code_pudl
  ORDER BY base.plant_id_eia, base.generator_id, base.year
) TO 'data/generator_year.parquet' (FORMAT parquet, COMPRESSION snappy, ROW_GROUP_SIZE 65536);

SELECT 'plant_tech_year' AS t, count(*) AS n FROM 'data/plant_tech_year.parquet'
UNION ALL SELECT 'generator_year', count(*) FROM 'data/generator_year.parquet'
UNION ALL SELECT 'plant_tech_year rows with GEM wiki', count(gem_wiki_url) FROM 'data/plant_tech_year.parquet'
UNION ALL SELECT 'plants with GEM wiki', count(DISTINCT plant_id_eia) FILTER (WHERE gem_wiki_url IS NOT NULL) FROM 'data/plant_tech_year.parquet';
