-- EPA CEMS emissions allocated to generators and to plant × technology × status × year (item 3 of the plan).
-- Inputs: data/cems_unit_month_2010plus.parquet (unit × month sums from the hourly table),
--         data/core_epa__assn_eia_epacamd.parquet (EPA unit -> EIA generator crosswalk, 2018-2024),
--         data/generator_year.parquet (for capacity shares and technology).
-- Rules (plan round 1): a stack feeding several generators is split by nameplate capacity; rows carry a
-- cems_allocation flag ('measured' when every stack behind the row maps to exactly one generator, else 'capacity-split').
-- Units with no crosswalk entry fall back to the plant: split across the plant's fossil generators by capacity ('plant-fallback').
-- Crosswalk years outside 2018-2024 use the nearest available year.

CREATE OR REPLACE VIEW cems AS
  SELECT plant_id_eia, emissions_unit_id_epa, year, month,
         co2_mass_tons, so2_mass_lbs / 2000.0 AS so2_tons, nox_mass_lbs / 2000.0 AS nox_tons,
         gross_load_mwh, heat_content_mmbtu, operating_hours
  FROM 'data/cems/*.parquet'
  WHERE plant_id_eia IS NOT NULL;

CREATE OR REPLACE TABLE xw AS
  SELECT DISTINCT report_year, plant_id_eia, emissions_unit_id_epa, generator_id
  FROM 'data/core_epa__assn_eia_epacamd.parquet'
  WHERE plant_id_eia IS NOT NULL AND generator_id IS NOT NULL;

CREATE OR REPLACE TABLE gy AS
  SELECT plant_id_eia, generator_id, year, technology_description, operational_status, fuel_type_code_pudl, capacity_mw
  FROM 'data/generator_year.parquet';

-- nearest crosswalk year for each data year
CREATE OR REPLACE TABLE xw_year AS
  SELECT y.year, (SELECT report_year FROM (SELECT DISTINCT report_year FROM xw) ORDER BY abs(report_year - y.year), report_year LIMIT 1) AS xw_year
  FROM (SELECT DISTINCT year FROM cems) y;

-- unit-year -> generators (with that year's capacity), one row per (unit, generator)
CREATE OR REPLACE TABLE unit_gen AS
  SELECT c.plant_id_eia, c.emissions_unit_id_epa, c.year, x.generator_id, g.capacity_mw,
         count(*) OVER (PARTITION BY c.plant_id_eia, c.emissions_unit_id_epa, c.year) AS n_gens
  FROM (SELECT DISTINCT plant_id_eia, emissions_unit_id_epa, year FROM cems) c
  JOIN xw_year USING (year)
  JOIN xw x ON x.report_year = xw_year.xw_year AND x.plant_id_eia = c.plant_id_eia AND x.emissions_unit_id_epa = c.emissions_unit_id_epa
  LEFT JOIN gy g ON g.plant_id_eia = x.plant_id_eia AND g.generator_id = x.generator_id AND g.year = c.year;

-- shares: by capacity among mapped generators; equal split when capacity unknown
CREATE OR REPLACE TABLE unit_share AS
  SELECT *,
         CASE WHEN sum(capacity_mw) OVER w > 0 THEN coalesce(capacity_mw, 0) / sum(capacity_mw) OVER w ELSE 1.0 / n_gens END AS share,
         CASE WHEN n_gens = 1 THEN 'measured' ELSE 'capacity-split' END AS allocation
  FROM unit_gen
  WINDOW w AS (PARTITION BY plant_id_eia, emissions_unit_id_epa, year);

-- fallback for units with no crosswalk row: split across the plant's fossil generators that year by capacity
CREATE OR REPLACE TABLE unit_fallback AS
  SELECT c.plant_id_eia, c.emissions_unit_id_epa, c.year, g.generator_id, g.capacity_mw,
         g.capacity_mw / nullif(sum(g.capacity_mw) OVER (PARTITION BY c.plant_id_eia, c.emissions_unit_id_epa, c.year), 0) AS share,
         'plant-fallback' AS allocation
  FROM (SELECT DISTINCT plant_id_eia, emissions_unit_id_epa, year FROM cems) c
  ANTI JOIN unit_share u USING (plant_id_eia, emissions_unit_id_epa, year)
  JOIN gy g ON g.plant_id_eia = c.plant_id_eia AND g.year = c.year AND g.fuel_type_code_pudl IN ('coal','gas','oil','waste','other') AND g.capacity_mw > 0;

CREATE OR REPLACE TABLE shares AS
  SELECT plant_id_eia, emissions_unit_id_epa, year, generator_id, share, allocation FROM unit_share WHERE share > 0
  UNION ALL
  SELECT plant_id_eia, emissions_unit_id_epa, year, generator_id, share, allocation FROM unit_fallback WHERE share > 0;

-- generator × month emissions
CREATE OR REPLACE TABLE gen_month AS
  SELECT s.plant_id_eia, s.generator_id, c.year, c.month, s.allocation,
         sum(c.co2_mass_tons * s.share) AS co2_tons, sum(c.so2_tons * s.share) AS so2_tons, sum(c.nox_tons * s.share) AS nox_tons,
         sum(c.gross_load_mwh * s.share) AS cems_gross_mwh, sum(c.heat_content_mmbtu * s.share) AS cems_heat_mmbtu
  FROM cems c JOIN shares s USING (plant_id_eia, emissions_unit_id_epa, year)
  GROUP BY 1, 2, 3, 4, 5;

-- generator × year
COPY (
  SELECT plant_id_eia, generator_id, year,
         round(sum(co2_tons)) AS co2_tons, round(sum(so2_tons), 1) AS so2_tons, round(sum(nox_tons), 1) AS nox_tons,
         round(sum(cems_gross_mwh)) AS cems_gross_mwh, round(sum(cems_heat_mmbtu)) AS cems_heat_mmbtu,
         CASE WHEN count(DISTINCT allocation) = 1 THEN any_value(allocation) ELSE 'mixed' END AS cems_allocation
  FROM gen_month GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
) TO 'data/cems_generator_year.parquet' (FORMAT parquet, COMPRESSION snappy);

-- plant × technology × status × year, with 12 monthly CO2 columns
COPY (
  SELECT m.plant_id_eia, g.technology_description, g.operational_status, m.year,
         round(sum(co2_tons)) AS co2_tons, round(sum(so2_tons), 1) AS so2_tons, round(sum(nox_tons), 1) AS nox_tons,
         round(sum(cems_gross_mwh)) AS cems_gross_mwh, round(sum(cems_heat_mmbtu)) AS cems_heat_mmbtu,
         CASE WHEN count(DISTINCT allocation) = 1 THEN any_value(allocation) ELSE 'mixed' END AS cems_allocation,
         round(sum(co2_tons) FILTER (WHERE month = 1)) AS co2_m01, round(sum(co2_tons) FILTER (WHERE month = 2)) AS co2_m02,
         round(sum(co2_tons) FILTER (WHERE month = 3)) AS co2_m03, round(sum(co2_tons) FILTER (WHERE month = 4)) AS co2_m04,
         round(sum(co2_tons) FILTER (WHERE month = 5)) AS co2_m05, round(sum(co2_tons) FILTER (WHERE month = 6)) AS co2_m06,
         round(sum(co2_tons) FILTER (WHERE month = 7)) AS co2_m07, round(sum(co2_tons) FILTER (WHERE month = 8)) AS co2_m08,
         round(sum(co2_tons) FILTER (WHERE month = 9)) AS co2_m09, round(sum(co2_tons) FILTER (WHERE month = 10)) AS co2_m10,
         round(sum(co2_tons) FILTER (WHERE month = 11)) AS co2_m11, round(sum(co2_tons) FILTER (WHERE month = 12)) AS co2_m12
  FROM gen_month m
  JOIN gy g ON g.plant_id_eia = m.plant_id_eia AND g.generator_id = m.generator_id AND g.year = m.year
  GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4
) TO 'data/cems_plant_tech_year.parquet' (FORMAT parquet, COMPRESSION snappy);

SELECT 'source unit-months' AS what, count(*) AS n, round(sum(co2_mass_tons)/1e6) AS co2_mt FROM cems
UNION ALL SELECT 'allocated to generators', count(*), round(sum(co2_tons)/1e6) FROM gen_month
UNION ALL SELECT 'plant-tech-year rows', count(*), round(sum(co2_tons)/1e6) FROM 'data/cems_plant_tech_year.parquet';
SELECT cems_allocation, count(*) AS n, round(sum(co2_tons)/1e6) AS co2_mt FROM 'data/cems_plant_tech_year.parquet' GROUP BY 1 ORDER BY 2 DESC;
