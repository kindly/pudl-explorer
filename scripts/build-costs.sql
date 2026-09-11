-- FERC Form 1 plant costs allocated to plant × technology × year (item 4 of the plan).
-- Input: data/out_ferc1__yearly_all_plants.parquet (PUDL), data/plant_tech_year.parquet, data/eia_generator_month_2010plus.parquet
-- Output: data/ferc_plant_tech_year.parquet — one row per (plant_id_eia, technology_description, year) that received FERC dollars.
-- Rules (plan round 1): sum co-owner records per FERC plant-year; a PUDL plant that maps to several EIA plants is split
-- by EIA capacity; within a plant, dollars go to technology rows whose family matches FERC plant_type (split by
-- capacity), else to the largest technology row. Existing rows are preferred over retired/proposed ones.

CREATE OR REPLACE VIEW ferc AS
  SELECT plant_id_pudl, report_year AS year,
         mode(plant_type) AS plant_type, count(*) AS ferc_records,
         sum(capex_total) AS capex_total, sum(opex_fuel) AS opex_fuel, sum(opex_total_nonfuel) AS opex_nonfuel,
         sum(coalesce(opex_total, opex_fuel + opex_total_nonfuel)) AS opex_total,
         sum(net_generation_mwh) AS ferc_net_generation_mwh, sum(capacity_mw) AS ferc_capacity_mw
  FROM 'data/out_ferc1__yearly_all_plants.parquet'
  WHERE report_year >= 2010 AND plant_id_pudl IS NOT NULL
  GROUP BY 1, 2;

CREATE OR REPLACE VIEW pty AS
  SELECT p.*, g.plant_id_pudl,
         CASE
           WHEN technology_description IN ('Conventional Steam Coal','Natural Gas Steam Turbine','Coal Integrated Gasification Combined Cycle',
                                           'Wood/Wood Waste Biomass','Municipal Solid Waste','Other Waste Biomass','Petroleum Coke','Other Gases') THEN 'steam'
           WHEN technology_description IN ('Natural Gas Fired Combustion Turbine','Other Natural Gas','Landfill Gas') THEN 'combustion_turbine'
           WHEN technology_description = 'Natural Gas Fired Combined Cycle' THEN 'combined_cycle'
           WHEN technology_description IN ('Natural Gas Internal Combustion Engine','Petroleum Liquids') THEN 'internal_combustion'
           WHEN technology_description = 'Nuclear' THEN 'nuclear'
           WHEN technology_description = 'Conventional Hydroelectric' THEN 'hydro'
           WHEN technology_description = 'Hydroelectric Pumped Storage' THEN 'storage'
           WHEN technology_description LIKE 'Solar%' THEN 'photovoltaic'
           WHEN technology_description LIKE '%Wind%' THEN 'wind'
           WHEN technology_description = 'Geothermal' THEN 'geothermal'
           WHEN technology_description = 'Batteries' THEN 'battery'
         END AS family
  FROM 'data/plant_tech_year.parquet' p
  JOIN (SELECT DISTINCT plant_id_eia, plant_id_pudl FROM 'data/eia_generator_month_2010plus.parquet' WHERE plant_id_pudl IS NOT NULL) g USING (plant_id_eia);

-- FERC plant_type -> the families it may land on (steam also accepts petroleum steam units filed as internal_combustion? no: keep strict, fall back below)
CREATE OR REPLACE VIEW fam AS
  SELECT * FROM (VALUES
    ('steam','steam'), ('combustion_turbine','combustion_turbine'), ('combined_cycle','combined_cycle'),
    ('internal_combustion','internal_combustion'), ('nuclear','nuclear'),
    ('hydro','hydro'), ('run_of_river','hydro'), ('run_of_river_with_storage','hydro'), ('storage','storage'), ('storage','hydro'),
    ('photovoltaic','photovoltaic'), ('solar_thermal','photovoltaic'), ('wind','wind'), ('geothermal','geothermal'), ('fuel_cell','combustion_turbine')
  ) t(plant_type, family);

-- step 1: candidate rows per FERC plant-year with a match rank
CREATE OR REPLACE TABLE cand AS
  SELECT f.plant_id_pudl, f.year, p.plant_id_eia, p.technology_description, p.operational_status,
         p.capacity_mw_months,
         CASE WHEN p.family IN (SELECT family FROM fam WHERE fam.plant_type = f.plant_type) THEN 1 ELSE 2 END AS fam_rank,
         CASE WHEN p.operational_status = 'existing' THEN 1 ELSE 2 END AS status_rank
  FROM ferc f JOIN pty p ON p.plant_id_pudl = f.plant_id_pudl AND p.year = f.year;

-- step 2: keep the best rank group per FERC plant-year; within it, share by capacity (largest-only when nothing matched the family)
CREATE OR REPLACE TABLE alloc AS
  WITH ranked AS (
    SELECT *, min(fam_rank) OVER (PARTITION BY plant_id_pudl, year) AS best_fam,
              min(status_rank) OVER (PARTITION BY plant_id_pudl, year, fam_rank) AS best_status
    FROM cand),
  kept AS (
    SELECT * FROM ranked WHERE fam_rank = best_fam AND status_rank = best_status),
  shares AS (
    SELECT *,
      CASE WHEN fam_rank = 1
           THEN capacity_mw_months / nullif(sum(capacity_mw_months) OVER (PARTITION BY plant_id_pudl, year), 0)
           ELSE CASE WHEN row_number() OVER (PARTITION BY plant_id_pudl, year ORDER BY capacity_mw_months DESC NULLS LAST) = 1 THEN 1.0 ELSE 0.0 END
      END AS share
    FROM kept)
  SELECT * FROM shares WHERE share > 0;

COPY (
  SELECT a.plant_id_eia, a.technology_description, a.operational_status, a.year,
         round(sum(f.capex_total * a.share)) AS ferc_capex_total,
         round(sum(f.opex_fuel * a.share)) AS ferc_opex_fuel,
         round(sum(f.opex_nonfuel * a.share)) AS ferc_opex_nonfuel,
         round(sum(f.opex_total * a.share)) AS ferc_opex_total,
         round(sum(f.ferc_net_generation_mwh * a.share)) AS ferc_net_generation_mwh,
         sum(f.ferc_records) AS ferc_records,
         CASE WHEN min(a.fam_rank) = 1 THEN 'plant_type match' ELSE 'largest technology' END AS ferc_allocation
  FROM alloc a JOIN ferc f USING (plant_id_pudl, year)
  GROUP BY 1, 2, 3, 4
) TO 'data/ferc_plant_tech_year.parquet' (FORMAT parquet, COMPRESSION snappy);

SELECT count(*) AS rows_out, count(DISTINCT plant_id_eia) AS plants, round(sum(ferc_capex_total)/1e9) AS capex_bn, round(sum(ferc_opex_total)/1e9) AS opex_bn,
       count(*) FILTER (WHERE ferc_allocation = 'plant_type match') AS matched_rows
FROM 'data/ferc_plant_tech_year.parquet';
SELECT round(sum(capex_total)/1e9) AS ferc_capex_bn_total FROM ferc;
