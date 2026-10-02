# PUDL generator explorer

A faceted explorer over PUDL's EIA, EPA and FERC data, running entirely in the
browser on [facetful](https://www.npmjs.com/package/facetful), with the same
"one URL filter state drives every panel" design as `gem-explorer`, without the
AI panel.

## Data model

The 4.46M-row generator-month table is the build input, not what the browser
loads. Two pre-aggregated tables share their dimension column names, so one
WHERE clause works on either:

| table | grain | rows | gzipped image | drives |
|---|---|---|---|---|
| `generator_tech_wide` | plant × generator × technology | 42,257 | 3.6 MB | grid, facets, totals, years chart, map |
| `plant_tech_year` | plant × technology × status × year | 230,891 | 10.9 MB | seasonality, FERC cost measures |
| `places_us` | US populated places, GeoNames cities1000 | 17,343 | 0.3 MB | the "near a town" box, fetched on first use |

`generator_tech_wide` (`../scripts/build-generator-wide.sql`) is **wide, not
long**: seventeen years of history live as columns, `gen_2010 … gen_2026` and
the same for `cap`, `co2`, `cost`, `mmbtu` and `mon`. A year filter therefore
chooses which columns to sum rather than which rows to keep. The columns are
zero-filled rather than nullable, which costs nothing in the image and is 4.2×
faster than the same sum through `coalesce()`.

Identity columns use `max_by(col, year)` so a plant's name and status come from
its latest year rather than alphabetically. Grain is plant × generator ×
technology rather than plant × generator: at the coarser grain, attributing a
generator to its latest fuel moved 1,094 TWh from coal to gas.

`plant_tech_year` (`../scripts/build-aggregates.sql`) carries twelve monthly
columns each for generation, fuel cost, fuel burned and CO₂, so the seasonality
chart is one query summing them and the month dimension needs no rows of its
own.

Rows hold additive quantities only — capacity-months, generation MWh, fuel cost,
MMBtu, CO₂ tonnes, FERC dollars — so average GW, capacity factor, CO₂ intensity
and $/MWh are computed at query time and stay correct under any filter.

Joined sources (`../scripts/build-emissions.sql`, `../scripts/build-costs.sql`):

- **EPA CEMS** hourly emissions, 2010 onward, aggregated one year per DuckDB
  process to unit × month (`data/cems/<year>.parquet`), then allocated to EIA
  generators through PUDL's `core_epa__assn_eia_epacamd` crosswalk (nearest
  crosswalk year, 2018–2024). A stack feeding several generators is split by
  nameplate capacity; stacks with no crosswalk row fall back to the plant's
  fossil generators. `cems_allocation` records `measured` / `capacity-split` /
  `plant-fallback` / `mixed` and is a facet. 99.9% of source tonnes land on a
  plant-technology-year row. CEMS covers fossil units > 25 MW only, so intensity
  is null (not zero) elsewhere.
- **FERC Form 1** per-plant costs (`out_ferc1__yearly_all_plants`) joined by
  `plant_id_pudl` + year, co-owner records summed, dollars placed on the
  technology rows whose family matches FERC `plant_type` (split by capacity),
  else on the largest technology. `ferc_allocation` is a facet. Regulated
  utilities only: 1,609 plants, $6.49T of the $6.78T plant-in-service.

Prototype history: the first version loaded the full 4.46M-row table (43 MB
gzipped, ~2.8 s to settle). It proved ~5M rows is facetful's usable ceiling and
the aggregated model replaced it. A `generator_year` table (485K rows, 12.5 MB)
was the grid's source until the wide table replaced it.

## Run

```
cd ~/projects/pudl
python3 -m http.server 8766 --bind 127.0.0.1   # any static server rooted at the pudl dir
                                               # (8765 is the browserdb dev server)
xdg-open http://localhost:8766/explorer/
```

On the tailnet it is served straight from the directory by `tailscale serve --bg
--https=8444 /home/david/projects/pudl` (no local server process) at
https://lenovo.tail6804fa.ts.net:8444/explorer/ (tailnet only, not Funnel).
tailscale's file server sends the right types for `.mjs`, `.wasm` and `.gz`.
HTTPS matters: OPFS caching needs a secure context. The public copy is
https://kindly.github.io/pudl-explorer/.

Loading: the page fetches `data/<table>.facetful.gz`, gunzips it with the
browser's `DecompressionStream`, stores the image in OPFS and opens it lazily
(`loadOpfs`). The OPFS file name carries the served file's ETag (or size +
last-modified), so a new data file is picked up and stale versions pruned; a
repeat visit fetches nothing. The small table opens first and the page is
interactive before the plant table arrives.

## The engine

facetful comes from npm. `package.json` pins the range, `sync-vendor.mjs` copies
the published package into `vendor/facetful-<version>/`, and `engine.js` is the
only file that names that path. Nothing in `vendor/` is edited by hand.

```
npm install                  # into explorer/
npm run sync-vendor          # node_modules/facetful -> vendor/facetful-<version>
node sync-vendor.mjs --check # fails if the copy has drifted; runs first in `npm test`
```

There is still no build step: `explorer/` is plain ES modules and the browser
fetches `index.js`, `worker.js` and the wasm by URL, which is why the package
has to sit in the repo rather than in `node_modules`. **The version is in the
directory name on purpose.** `worker.js` imports `core.js` by a relative URL of
its own, so a query string on the worker cannot reach it; a versioned path gives
every file inside a fresh URL on upgrade, which matters most for the 680 KB
wasm. `node_modules` is gitignored.

The engine is not free to grow: 0.3.1's wasm was 441 KB raw and 180 KB gzipped,
0.7.1's is 680 KB and 279 KB. That ~100 KB is small against 14.5 MB of data, but
it is paid on every cold visit, and the joins, materialization and UDFs that
bought it are not yet used here.

### Cache busting

The host sends no `Cache-Control`, and a hand-written version stamp went stale
twice and pinned old files on iOS. `stamp.mjs` now derives the stamp from a
sha256 of `app.js`, `sql.js`, `map.js`, `theme.css` and `engine.js`, writes it
into the `?v=` on every asset URL and into `version.json`, and is idempotent.
Every browser harness imports it, so the tree is never served unstamped.

`index.html` cannot carry a query of its own, so the page fetches `version.json`
uncached at boot and compares it with the stamp compiled into `app.js`. A
mismatch shows a banner naming both builds with a reload link, rather than
silently running old code.

hyparquet 1.29.2 is also vendored, used only by `build-image.mjs`, not the page.
It decodes Snappy but not zstd, so parquet must be written with
`COMPRESSION snappy`.

## Rebuilding the data

```
duckdb < ../scripts/build-generator-month.sql      # PUDL S3 -> data/eia_generator_month_2010plus.parquet
DUCKDB_INIT=proxy.sql bash ../scripts/cems-years.sh  # EPA CEMS hourly -> data/cems/<year>.parquet (one DuckDB per year, ~1 min each)
duckdb < ../scripts/build-emissions.sql            # -> data/cems_plant_tech_year.parquet, data/cems_generator_year.parquet
duckdb < ../scripts/build-costs.sql                # -> data/ferc_plant_tech_year.parquet
duckdb < ../scripts/build-aggregates.sql           # -> data/plant_tech_year.parquet
duckdb < ../scripts/build-generator-wide.sql       # -> data/generator_tech_wide.parquet
for t in generator_tech_wide plant_tech_year; do
  node --max-old-space-size=6144 build-image.mjs ../data/$t.parquet   # parquet -> .facetful
  gzip -k -6 -f ../data/$t.facetful                                   # served as .facetful.gz
done
node stamp.mjs                                     # re-stamp the asset URLs
```

The towns table is separate and rarely rebuilt:

```
mkdir -p .geonames && cd .geonames
curl -LO https://download.geonames.org/export/dump/cities1000.zip && unzip cities1000.zip
curl -LO https://download.geonames.org/export/dump/admin1CodesASCII.txt
cd .. && node scripts/build-places.mjs .geonames   # -> data/places_us.facetful(.gz)
```

## Tests

```
npm test     # sync-vendor --check, sql-smoke, gridcheck, stickycheck,
             # freezecheck, measurecols, stalecheck, cdp-test
```

The rest below are run individually.

| harness | checks |
|---|---|
| `sql-smoke.mjs` | 3,664 queries: every panel × filter state × measure × sort direction, both tables |
| `cfcheck.mjs` | capacity factor matches a direct calculation, and every yearly value is a real percentage |
| `scalecheck.mjs` | CO₂ per MW against the figure implied by intensity and capacity factor |
| `gridcheck.mjs` | grid height never changes; unused rows are genuinely blank; the last row is reachable |
| `stickycheck.mjs` | both row-pinning modes keep every row inside the box |
| `freezecheck.mjs` | nothing scrolling under the frozen columns shows through, with a negative control |
| `measurecols.mjs` | the measure sparkline follows the measure and vanishes when there is none |
| `ratiocheck.mjs` | non-additive measures draw lines not stacks, and size the map by an additive basis |
| `facetsort.mjs` | every facet header either sorts both ways or does not offer to |
| `stalecheck.mjs` | the stale-shell banner fires on a version mismatch and stays quiet otherwise |
| `nearcheck.mjs` | the near filter: autocomplete, the filter, the shared link, and that the towns image is not fetched unless used |
| `cdp-test.mjs` | headless Chromium end to end, screenshots to cwd (`FRESH=1` for an empty profile) |
| `livecheck.mjs` | loads the deployed site and checks it boots and renders |
| `bench.mjs`, `countperf.mjs` | engine comparison; `FACETFUL_OLD=<dir>` points at a build to compare against |
| `phonesim.mjs` | mobile viewport under heavy CPU throttling |

Every harness cleans up its browser profile from a process exit handler, not
only on the success path.

## What is on the page

- **Header totals**: distinct plants, generators, TWh, average fleet GW
  (capacity-months ÷ calendar months in range), generation-weighted capacity
  factor, year range.
- **Measure selector**, generated from the measure definitions so it cannot
  drift: generation TWh, average GW, capacity factor %, CO₂ Mt, CO₂ intensity
  t/MWh, CO₂ per MW·yr, fuel cost $bn, fuel burned TBtu, FERC plant-in-service
  $bn, FERC operating cost $/MWh.
- **Ratio measures are treated as non-additive.** Capacity factor, both CO₂
  intensities and FERC $/MWh draw the years chart as one line per fuel rather
  than a stack, size map circles by an additive basis (capacity or emissions)
  with the ratio in the tooltip, and order facets by plant count. Stacking a
  ratio means nothing, and sizing circles by one draws a 2 MW solar site like a
  power station.
- **Eleven facets**, each a `GROUP BY` that leaves out its own filter: fuel,
  technology, operational status, state, balancing authority, utility (top 300),
  site capacity, first-commissioned decade, plus measure-specific ones that
  appear with their measure: CO₂ intensity bucket and CEMS coverage with the
  emissions measures, FERC 1 costs with the cost measures. Every header sorts in
  both directions, except site capacity and the CO₂ intensity bucket, which are
  scales: their order carries the meaning, so their headers are plain text
  rather than controls that do nothing.
- **Years** stacked by fuel; drag to brush a range (`year=2018..2024`). The
  legend doubles as the fuel filter.
- **Seasonality**: calendar-month bars summed over the selected years, stacked
  by fuel. Hidden for measures with no monthly series. Display only.
- **Plants map**: MapLibre GL (vendored 6.9) on Carto's Positron basemap, one
  circle per plant × fuel. Hover shows name, fuel and value; click pins a card
  with technology mix, MW, first online, capacity factor, CO₂ and FERC opex
  under the current filters, a **GEM wiki** link where GEM knows the plant, and
  a "show only this plant" button. Clicking never changes the filters by itself.
- **Grid**: one row per generator, all 42,257 of them, with infinite scroll.
  Plant and Gen stay frozen through horizontal scroll. Generation is always a
  sparkline; a second sparkline follows the selected measure and is absent when
  that measure has nothing per-generator to draw. Seventeen years of bars come
  back with the row, so there is no second query, and years outside the filter
  are drawn faded.
- **GEM wiki links**: `data/gem_us_plants_eia.csv` is exported from GEM's
  database. Because GEM splits sites by technology, each plant × PUDL fuel type
  picks the GEM plant whose fuel categories match, else the largest at that EIA
  id. 11,703 of 18,937 plants get a link.
- **Near a town**: type a US town, pick from the autocomplete, and every panel filters to
  plants within the chosen radius. Ported from gem-explorer. The whole filter travels in
  one URL parameter, `near=<lat>,<lon>,<km>,<label>`, so a shared link filters immediately
  without waiting for the towns table — which is itself only fetched the first time someone
  types in the box, so a visitor who never uses it pays nothing. The clause is
  `geo_distance(...) <= km*1000`, a facetful UDF that arrived with the UDF bundle in 0.5
  and is on by default. It is cheaper than no filter at all, because it prunes rows before
  the distinct count: a facet over the plant table is 1.4 ms with it against 1.2 ms
  without, and the generator table drops from 0.5 ms to 0.2 ms. The map draws the radius
  and frames it.
- **Search**: words AND'ed, each matched with `LIKE` on plant and utility name.
- Footer shows settle time for the whole page and per-panel engine ms.
- `?griddebug=1` pins a readout of the heights, pool size, visible rows and row
  hold mode, for devices with no debugger attached.

## The grid

It is custom, not a table library, because the page is meant to stay light.

Rows are virtualised over a fixed, recycled pool of row elements, painted
synchronously inside the scroll handler so they land in the same frame as the
movement rather than a frame behind. The whole filtered result is fetched into
memory shortly after the first page, so scrolling never waits on the engine.
`.tall` carries the scroll height and the row block is pinned inside it, so no
row can scroll out of view and a late frame shows stale rows rather than a blank
gap. Pinning is checked at runtime: if the block is left a whole row behind
twice running, the grid switches to holding it with a transform instead.

Two traps worth knowing, both of which bit this grid:

- Sizing the pool from `scroller.clientHeight` and then writing
  `scroller.style.height` back is a feedback loop. With `box-sizing: border-box`
  the 1px border comes out of the height you set, so each paint measures a pixel
  less and loses a row every 25 paints. On a phone, where a gesture is many
  paints, the grid walks down to one row. The height now comes from CSS and is
  never written from JS.
- `.grid .grow { display: grid }` outranks the browser's `[hidden]` rule, so
  hiding an unused pool slot did nothing and it kept showing its last contents.
  There is an explicit rule for it now.

## Findings about facetful

Written up in full in [`../docs/facetful-notes.md`](../docs/facetful-notes.md)
and [`../docs/facetful-count-distinct.md`](../docs/facetful-count-distinct.md).
In short:

- **Wide beats long for a year filter.** Summing seventeen zero-filled columns
  is 2.2 ms where `coalesce()` over the same columns is 9.2 ms.
- **`count(distinct)` was the floor**, unmoved by the optimisation round that
  took the page 2× faster. 0.3.1 then cut it 2–3×: a distinct plant count over
  230,891 rows went from 6.0 ms to 1.8 ms. The gain landed on integer columns;
  dictionary columns were already 0.3 ms.
- **Both images are perfectly clustered** on `plant_id_eia`, 18,937 plants in
  18,937 runs. That is not luck: writing in plant order rather than date order
  took the prototype image from 122 MB to 43 MB gzipped, so compression pressure
  pushes writers into it anyway.
- **Row order dominates compressed size.** Chrome's `DecompressionStream` is
  gzip and deflate only, so brotli and zstd (41–44 MB on the prototype) are not
  reachable without a JS decoder.
- Historic gaps, all since fixed upstream or worked around: wasm pointers went
  negative past a 2 GB heap (fixed in 0.2.0); `1e6` does not lex, write
  `1000000.0`; `GROUP BY` needs the expression, not the select alias;
  `lower(col) LIKE` defeats the per-distinct-value path and `LIKE` is already
  case-insensitive.

Current shape on facetful 0.7.1: a cold first settle is 489 ms (95 ms of it in
the engine), warm settles are 117–139 ms (40–50 ms engine), and a year-range
change is 278 ms (51 ms engine). The full query suite is 22 ms on the plant
table and 41–44 ms on the generator table.
