# PUDL generator explorer

A faceted explorer over PUDL's `out_eia__monthly_generators` table, running
entirely in the browser on [facetful](../../browserdb) — the same engine and the
same "one URL filter state drives every panel" design as `gem-explorer`, without
the AI panel.

## Data model

The 4.46M-row generator-month table is the build input, not what the browser
loads. Two pre-aggregated tables (`../scripts/build-aggregates.sql`) share their
dimension column names, so one WHERE clause works on either:

| table | grain | rows | gzipped image | drives |
|---|---|---|---|---|
| `plant_tech_year` | plant × technology × operational status × year | 230,891 | 11.1 MB | facets, totals, years chart, seasonality, map |
| `generator_year` | generator × year | 485,231 | 12.5 MB | grid, plant drill-down |

Rows hold additive quantities only — capacity-months, generation MWh, fuel cost,
MMBtu, CO₂/SO₂/NOₓ tonnes, FERC dollars — so average GW, capacity factor,
CO₂ intensity and $/MWh are computed at query time and stay correct under any
filter. `plant_tech_year` also carries twelve monthly columns each for
generation, fuel cost, fuel burned and CO₂; the seasonality chart is one query
summing them, which is why the month dimension needs no rows of its own.
Site capacity bucket and first-commissioned decade are group-level attributes
stamped on both tables so a filter means the same thing in each.

Joined sources (`../scripts/build-emissions.sql`, `../scripts/build-costs.sql`):

- **EPA CEMS** hourly emissions, 2010 onward, aggregated one year per DuckDB
  process to unit × month (`data/cems/<year>.parquet`), then allocated to EIA
  generators through PUDL's `core_epa__assn_eia_epacamd` crosswalk (nearest
  crosswalk year, 2018–2024). A stack feeding several generators is split by
  nameplate capacity; stacks with no crosswalk row fall back to the plant's
  fossil generators. `cems_allocation` records `measured` / `capacity-split` /
  `plant-fallback` / `mixed` and is a facet. 99.9% of source tonnes land on a
  plant-technology-year row. CEMS covers fossil units > 25 MW only, so
  intensity is null (not zero) elsewhere.
- **FERC Form 1** per-plant costs (`out_ferc1__yearly_all_plants`) joined by
  `plant_id_pudl` + year, co-owner records summed, dollars placed on the
  technology rows whose family matches FERC `plant_type` (split by capacity),
  else on the largest technology. `ferc_allocation` is a facet. Regulated
  utilities only: 1,609 plants, $6.49T of the $6.78T plant-in-service.

Prototype history: the first version loaded the full 4.46M-row table
(43 MB gzipped, ~2.8 s to settle a page). It proved ~5M rows is facetful's usable
ceiling and the aggregated model replaced it; see the findings section.

## Run

```
cd ~/projects/pudl
python3 -m http.server 8766 --bind 127.0.0.1   # any static server rooted at the pudl dir
                                               # (8765 is taken by the browserdb dev server)
xdg-open http://localhost:8766/explorer/
```

On the tailnet it is served straight from the directory by
`tailscale serve --bg --https=8444 /home/david/projects/pudl` (no local server
process) at https://lenovo.tail6804fa.ts.net:8444/explorer/ (tailnet only, not
Funnel). tailscale's file server sends the right types for `.mjs`, `.wasm` and
`.gz`. HTTPS matters: OPFS caching needs a secure context. The public copy is
https://kindly.github.io/pudl-explorer/.

There is no build step. `explorer/` is plain ES modules; `vendor/` holds a copy
of `browserdb/js/facetful` (with one patch, see below) and hyparquet 1.29.2
(only used by `build-image.mjs`, not by the page).

Loading: the page fetches `data/<table>.facetful.gz`, gunzips it with the
browser's `DecompressionStream`, stores the image in OPFS and opens it lazily
(`loadOpfs`). The OPFS file name carries the served file's ETag (or size +
last-modified), so a new data file is picked up and stale versions are pruned;
a repeat visit fetches nothing. The small table opens first and the page is
interactive before the generator table arrives. `reset stored data` clears OPFS.

## Rebuilding the data

```
duckdb < ../scripts/build-generator-month.sql      # PUDL S3 -> data/eia_generator_month_2010plus.parquet
DUCKDB_INIT=proxy.sql bash ../scripts/cems-years.sh                                 # EPA CEMS hourly -> data/cems/<year>.parquet (one DuckDB per year, ~1 min each)
duckdb < ../scripts/build-emissions.sql            # -> data/cems_plant_tech_year.parquet, data/cems_generator_year.parquet
duckdb < ../scripts/build-costs.sql                # -> data/ferc_plant_tech_year.parquet
duckdb < ../scripts/build-aggregates.sql           # -> data/plant_tech_year.parquet, data/generator_year.parquet
for t in plant_tech_year generator_year; do
  node --max-old-space-size=6144 build-image.mjs ../data/$t.parquet   # parquet -> .facetful (same code path as the browser)
  gzip -k -6 -f ../data/$t.facetful                                    # served as .facetful.gz
done
node sql-smoke.mjs        # every panel query × 4 filter states × 5 measures, both tables
node cdp-test.mjs         # headless Chromium end-to-end, screenshots to cwd (FRESH=1 for an empty profile)
```

hyparquet only decodes Snappy (not zstd), so parquet must be written with
`COMPRESSION snappy`.

## What is on the page

- **Header totals**: distinct plants, TWh, average fleet GW (capacity-months ÷
  calendar months in range), generation-weighted capacity factor, year range.
- **Measure selector** applies to every facet, chart and the map: TWh generated,
  average GW, fuel cost $bn, fuel burned TBtu, or plant count.
- **Eleven facets**, each a `GROUP BY` that leaves out its own filter: fuel type,
  technology, operational status, state, balancing authority, utility (top 300),
  site capacity bucket, first-commissioned decade, plus measure-specific ones
  that appear only with their measure: CO₂ intensity bucket and CEMS coverage
  with the emissions measures, FERC 1 coverage with the cost measures. Rows show a bar scaled by the
  measure, the row count and the measure under a column header (value · rows ·
  e.g. "Gen TWh") that also sorts. Click toggles, multi-select within a facet is
  `IN`, across facets is `AND`.
- **Years** stacked by fuel; drag to brush a year range (`year=2018..2024`).
  The legend doubles as the fuel filter.
- **Seasonality**: calendar-month bars summed over the selected years from the
  monthly columns, stacked by fuel. Display only; there is no month filter.
- **Plants map**: MapLibre GL (vendored 6.9) on Carto's Positron basemap, one
  circle per plant × fuel with a non-zero value, area ∝ measure, zoom and pan; hover for the name,
  click to drill into the plant (`plant=<plant_id_eia>`). Falls back to a blank
  background when the basemap is unreachable.
- **Grid**: top 100 generator-years for the current sort with capacity, MWh,
  capacity factor, heat rate, fuel cost, online and retirement dates. Plant names
  link to the drill-down.
- **Search**: words AND'ed, each matched with `LIKE` on plant and utility name.
- Footer shows settle time for the whole page and per-panel engine ms.

## Findings about facetful at 4.5M rows

Engine timings are from Node running the same wasm (single thread), so browser
numbers are similar.

Bugs / gaps found:

1. **Signed wasm pointers** — with a table this size the wasm heap grows past
   2 GB and `image_ptr`/`col_*_ptr`/`alloc` return negative i32s, so
   `imageBytes()` throws `RangeError: Start offset -1481302392 is outside the
   bounds of the buffer`. `vendor/facetful/unsigned-pointers.patch` adds
   `>>> 0` to every pointer read in `core.js`. Worth upstreaming to
   `browserdb/js/facetful/core.js`.
2. **No scientific notation**: `1e6` fails to lex (`expected ')' ... found
   'e6'`). Write `1000000.0`.
3. **GROUP BY does not accept select aliases**; the expression must be repeated.
4. **Image size**: 658 MB for a 59 MB parquet — every numeric column is f64
   with no compression, so the `image` path is only sensible gzipped + OPFS.
   Row order dominates the compressed size: sorted by date the image gzips to
   122 MB (a generator's repeats are ~230 KB apart, outside gzip's 32 KB
   window); sorted by generator it gzips to 43 MB. Long-window codecs on the
   date-sorted file: zstd -19 --long 44 MB, xz 42 MB, brotli q11 41 MB — but
   Chrome's DecompressionStream only does gzip/deflate, so gzip + generator
   order is the sweet spot for GitHub's 100 MB file limit. The trade-off is
   that year filters no longer prune row groups (~2 ms → ~70 ms per query).
5. **hyparquet** is Snappy-only; PUDL's own files are Snappy but DuckDB's
   default zstd output is not readable.

Performance shape (`sql-smoke.mjs`, `query-test.mjs`), single-threaded wasm:

On the 4.46M-row generator-month table (prototype):

| query | ms |
|---|---|
| facet on a dictionary column (`group by state`), any filter | 30–50 |
| same with `count(distinct plant_id_eia)` added | +170 |
| facet on a computed key (`CASE` buckets, `(year(d)/10)*10`) | ~450 → precomputed as real columns |
| two-key group (`year × fuel`, 170 groups) | ~500 |
| map (`plant × lat × lon × fuel`, 21K groups) | ~720 |
| top-100 with explicit columns, `order by net_generation_mwh` | ~40 |
| `LIKE '%x%'` on one dictionary column | 35 |
| `lower(col) LIKE` | 470 — `lower()` defeats the per-distinct-value path; `LIKE` is already case-insensitive |
| whole page (14 panels), no filters | ~2.7 s engine time |

On the two aggregated tables (current): the whole page of ~30 queries is
150–280 ms in the engine, the slowest single query is the map at ~40 ms, and a
plant drill-down page is ~50 ms.

At 5M rows facet lists were interactive but multi-key charts, the map and text
search dominated settle time; pre-aggregating to ~0.5M rows made every panel
interactive and cut the download from 43 MB to 20 MB.
