-- The table the explorer's facets, totals, charts, map and detail grid all read.
-- Grain: plant x generator x technology. One row per generator in 96% of cases; a generator that
-- converted (coal -> gas) gets one row per technology so its history is attributed to the fuel it
-- actually ran on. 42,257 rows for 40,740 generators.
--
-- The yearly series are stored as columns, not rows. A year-range filter therefore selects which
-- columns to add up rather than filtering rows, so every measure still responds to every filter, and
-- the sparkline data arrives with the row instead of needing a second query.
--
-- Columns are ZERO-FILLED, never null. `coalesce()` in the query costs 3.8x the addition it guards
-- (9.2 ms vs 2.2 ms for a 17-column sum), and plain `a + b + c` over nullable columns silently drops
-- any generator missing from a single year. See docs/facetful-notes.md.
--
-- Run from the pudl directory after build-aggregates.sql:  duckdb < scripts/build-generator-wide.sql

COPY (
  SELECT plant_id_eia, generator_id, technology_description,
         dense_rank() OVER (ORDER BY plant_id_eia, generator_id) AS gen_key,
         any_value(plant_name_eia) AS plant_name_eia, any_value(state) AS state, any_value(county) AS county,
         any_value(ba_code) AS ba_code, any_value(latitude) AS latitude, any_value(longitude) AS longitude,
         -- identity resolved to the generator's latest year, not min()/max() over its history
         max_by(utility_name_eia, year) AS utility_name_eia, max_by(utility_id_eia, year) AS utility_id_eia,
         max_by(prime_mover_code, year) AS prime_mover_code, max_by(fuel_type_code_pudl, year) AS fuel_type_code_pudl,
         max_by(operational_status, year) AS operational_status, max_by(capacity_bucket, year) AS capacity_bucket,
         max_by(capacity_mw, year) AS capacity_mw,
         any_value(operating_decade) AS operating_decade,
         year(min(generator_operating_date)) AS first_operating_year,
         year(max(generator_retirement_date)) AS retirement_year,
         any_value(gem_wiki_url) AS gem_wiki_url, any_value(gem_plant_name) AS gem_plant_name,
         -- CEMS: a flag so "no monitor" is distinguishable from a genuine zero, plus how tonnes were attributed
         count(co2_tons) > 0 AS has_cems,
         max_by(cems_allocation, year) AS cems_allocation,
         CASE WHEN count(co2_tons) = 0 OR sum(net_generation_mwh) <= 0 THEN NULL
              WHEN sum(co2_tons) / sum(net_generation_mwh) < 0.2 THEN '< 0.2'
              WHEN sum(co2_tons) / sum(net_generation_mwh) < 0.4 THEN '0.2-0.4'
              WHEN sum(co2_tons) / sum(net_generation_mwh) < 0.6 THEN '0.4-0.6'
              WHEN sum(co2_tons) / sum(net_generation_mwh) < 0.9 THEN '0.6-0.9'
              ELSE '0.9+' END AS co2_intensity_bucket,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2010)), 0) AS gen_2010,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2011)), 0) AS gen_2011,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2012)), 0) AS gen_2012,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2013)), 0) AS gen_2013,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2014)), 0) AS gen_2014,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2015)), 0) AS gen_2015,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2016)), 0) AS gen_2016,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2017)), 0) AS gen_2017,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2018)), 0) AS gen_2018,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2019)), 0) AS gen_2019,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2020)), 0) AS gen_2020,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2021)), 0) AS gen_2021,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2022)), 0) AS gen_2022,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2023)), 0) AS gen_2023,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2024)), 0) AS gen_2024,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2025)), 0) AS gen_2025,
         coalesce(round(sum(net_generation_mwh) FILTER (WHERE year = 2026)), 0) AS gen_2026,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2010)), 0) AS cap_2010,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2011)), 0) AS cap_2011,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2012)), 0) AS cap_2012,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2013)), 0) AS cap_2013,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2014)), 0) AS cap_2014,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2015)), 0) AS cap_2015,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2016)), 0) AS cap_2016,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2017)), 0) AS cap_2017,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2018)), 0) AS cap_2018,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2019)), 0) AS cap_2019,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2020)), 0) AS cap_2020,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2021)), 0) AS cap_2021,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2022)), 0) AS cap_2022,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2023)), 0) AS cap_2023,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2024)), 0) AS cap_2024,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2025)), 0) AS cap_2025,
         coalesce(round(sum(capacity_mw_months) FILTER (WHERE year = 2026)), 0) AS cap_2026,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2010)), 0) AS co2_2010,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2011)), 0) AS co2_2011,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2012)), 0) AS co2_2012,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2013)), 0) AS co2_2013,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2014)), 0) AS co2_2014,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2015)), 0) AS co2_2015,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2016)), 0) AS co2_2016,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2017)), 0) AS co2_2017,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2018)), 0) AS co2_2018,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2019)), 0) AS co2_2019,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2020)), 0) AS co2_2020,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2021)), 0) AS co2_2021,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2022)), 0) AS co2_2022,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2023)), 0) AS co2_2023,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2024)), 0) AS co2_2024,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2025)), 0) AS co2_2025,
         coalesce(round(sum(co2_tons) FILTER (WHERE year = 2026)), 0) AS co2_2026,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2010)), 0) AS cost_2010,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2011)), 0) AS cost_2011,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2012)), 0) AS cost_2012,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2013)), 0) AS cost_2013,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2014)), 0) AS cost_2014,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2015)), 0) AS cost_2015,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2016)), 0) AS cost_2016,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2017)), 0) AS cost_2017,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2018)), 0) AS cost_2018,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2019)), 0) AS cost_2019,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2020)), 0) AS cost_2020,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2021)), 0) AS cost_2021,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2022)), 0) AS cost_2022,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2023)), 0) AS cost_2023,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2024)), 0) AS cost_2024,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2025)), 0) AS cost_2025,
         coalesce(round(sum(total_fuel_cost) FILTER (WHERE year = 2026)), 0) AS cost_2026,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2010)), 0) AS mmbtu_2010,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2011)), 0) AS mmbtu_2011,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2012)), 0) AS mmbtu_2012,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2013)), 0) AS mmbtu_2013,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2014)), 0) AS mmbtu_2014,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2015)), 0) AS mmbtu_2015,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2016)), 0) AS mmbtu_2016,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2017)), 0) AS mmbtu_2017,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2018)), 0) AS mmbtu_2018,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2019)), 0) AS mmbtu_2019,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2020)), 0) AS mmbtu_2020,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2021)), 0) AS mmbtu_2021,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2022)), 0) AS mmbtu_2022,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2023)), 0) AS mmbtu_2023,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2024)), 0) AS mmbtu_2024,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2025)), 0) AS mmbtu_2025,
         coalesce(round(sum(total_mmbtu) FILTER (WHERE year = 2026)), 0) AS mmbtu_2026,
         -- months actually reported, so average capacity divides by the real period length (2026 is one month)
         coalesce(max(n_months) FILTER (WHERE year = 2010), 0) AS mon_2010,
         coalesce(max(n_months) FILTER (WHERE year = 2011), 0) AS mon_2011,
         coalesce(max(n_months) FILTER (WHERE year = 2012), 0) AS mon_2012,
         coalesce(max(n_months) FILTER (WHERE year = 2013), 0) AS mon_2013,
         coalesce(max(n_months) FILTER (WHERE year = 2014), 0) AS mon_2014,
         coalesce(max(n_months) FILTER (WHERE year = 2015), 0) AS mon_2015,
         coalesce(max(n_months) FILTER (WHERE year = 2016), 0) AS mon_2016,
         coalesce(max(n_months) FILTER (WHERE year = 2017), 0) AS mon_2017,
         coalesce(max(n_months) FILTER (WHERE year = 2018), 0) AS mon_2018,
         coalesce(max(n_months) FILTER (WHERE year = 2019), 0) AS mon_2019,
         coalesce(max(n_months) FILTER (WHERE year = 2020), 0) AS mon_2020,
         coalesce(max(n_months) FILTER (WHERE year = 2021), 0) AS mon_2021,
         coalesce(max(n_months) FILTER (WHERE year = 2022), 0) AS mon_2022,
         coalesce(max(n_months) FILTER (WHERE year = 2023), 0) AS mon_2023,
         coalesce(max(n_months) FILTER (WHERE year = 2024), 0) AS mon_2024,
         coalesce(max(n_months) FILTER (WHERE year = 2025), 0) AS mon_2025,
         coalesce(max(n_months) FILTER (WHERE year = 2026), 0) AS mon_2026
  FROM 'data/generator_year.parquet'
  GROUP BY plant_id_eia, generator_id, technology_description
  ORDER BY plant_id_eia, generator_id, technology_description
) TO 'data/generator_tech_wide.parquet' (FORMAT parquet, COMPRESSION snappy, ROW_GROUP_SIZE 65536);

SELECT count(*) AS rows_out, count(DISTINCT gen_key) AS generators, count(DISTINCT plant_id_eia) AS plants,
       count(*) FILTER (WHERE has_cems) AS with_cems, count(gem_wiki_url) AS with_gem_wiki
FROM 'data/generator_tech_wide.parquet';
