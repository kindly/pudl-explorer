-- Build data/eia_generator_month_2010plus.parquet from PUDL's stable release.
-- Run from the pudl directory:  duckdb < scripts/build-generator-month.sql
-- (inside the Claude sandbox, DuckDB needs SET http_proxy / http_proxy_username / http_proxy_password first)
INSTALL httpfs; LOAD httpfs;

COPY (
  SELECT report_date, year(report_date) AS year, month(report_date) AS month,
         plant_id_eia, plant_id_pudl, plant_name_eia, generator_id, utility_id_eia, utility_id_pudl, utility_name_eia,
         state, county, balancing_authority_code_eia AS ba_code,
         technology_description, prime_mover_code, energy_source_code_1, fuel_type_code_pudl,
         operational_status, generator_operating_date, generator_retirement_date,
         capacity_mw, summer_capacity_mw, winter_capacity_mw, energy_storage_capacity_mwh,
         net_generation_mwh, capacity_factor, total_mmbtu, total_fuel_cost, fuel_cost_per_mmbtu, fuel_cost_per_mwh, unit_heat_rate_mmbtu_per_mwh,
         latitude, longitude,
         -- precomputed facet keys: facetful groups dictionary columns in ~30 ms but computed CASE/arithmetic keys in ~450 ms
         CASE WHEN capacity_mw IS NULL THEN NULL WHEN capacity_mw < 1 THEN '< 1 MW' WHEN capacity_mw < 10 THEN '1-10 MW'
              WHEN capacity_mw < 100 THEN '10-100 MW' WHEN capacity_mw < 500 THEN '100-500 MW' ELSE '500+ MW' END AS capacity_bucket,
         CAST((year(generator_operating_date) // 10) * 10 AS INTEGER) AS operating_decade
  FROM read_parquet('https://s3.us-west-2.amazonaws.com/pudl.catalyst.coop/stable/out_eia__monthly_generators.parquet')
  WHERE report_date >= '2010-01-01'
  -- Sort by generator, not date: a generator's attributes repeat every month, so this order puts the
  -- repeats next to each other and the facetful image gzips to 43 MB instead of 122 MB (parquet 59 vs 131 MB).
  -- The price is losing row-group pruning on year filters (~2 ms -> ~70 ms per year-filtered query).
  ORDER BY plant_id_eia, generator_id, report_date
) TO 'data/eia_generator_month_2010plus.parquet'
  -- Snappy, not zstd: hyparquet (facetful's in-browser parquet reader) only decodes Snappy
  (FORMAT parquet, COMPRESSION snappy, ROW_GROUP_SIZE 262144);

-- Companion rollup used in the first data survey (not used by the explorer)
COPY (
  SELECT datetime_utc::date AS date, year(datetime_utc) AS year, month(datetime_utc) AS month,
         balancing_authority_code_eia AS ba_code, generation_energy_source AS energy_source,
         count(*) AS hours, count(net_generation_reported_mwh) AS hours_reported,
         round(sum(net_generation_reported_mwh),1) AS net_gen_reported_mwh,
         round(sum(net_generation_adjusted_mwh),1) AS net_gen_adjusted_mwh,
         round(sum(net_generation_imputed_eia_mwh),1) AS net_gen_imputed_mwh
  FROM read_parquet('https://s3.us-west-2.amazonaws.com/pudl.catalyst.coop/stable/core_eia930__hourly_net_generation_by_energy_source.parquet')
  GROUP BY ALL ORDER BY date, ba_code, energy_source
) TO 'data/eia930_daily_netgen_by_ba_source.parquet' (FORMAT parquet, COMPRESSION zstd);
