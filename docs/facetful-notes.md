# facetful on a real faceted page: what the September build bought, and one trap

Notes from moving the PUDL explorer to the 12 September build of facetful, and from
benchmarking a second table shape we were considering. Written for whoever works on
the engine next; the workload is a live page rather than a synthetic suite.

## The workload

A static page with sixteen panels that all run one `WHERE` clause against two
compiled images in a single worker:

- `plant_tech_year` — 230,891 rows, ~90 columns. Eight to eleven facet lists
  (`group by <dictionary column>` with a count and a sum), header totals with
  `count(distinct)`, a year chart (`group by year, fuel`), a twelve-column
  seasonality sum, and a map (`group by plant, fuel` over 20,577 groups).
- `generator_year` — 485,231 rows, feeding a top-100 detail table.

Every panel re-runs on every filter change, so the number that matters is the sum
of all sixteen, not any one query.

## Upgrading the engine: 2× on the page

Nineteen commits on from the August build, including the vectorized literal
compares, int direct grouping and `pack_bits` work.

| query | Aug build | Sep build | |
|---|---|---|---|
| `LIKE '%x%'` across two dictionary columns | 4.5 ms | 0.4 ms | **11.8×** |
| year chart, `group by year, fuel` | 21.9 ms | 2.7 ms | **8.0×** |
| map, `group by plant, fuel`, 20,577 groups | 40.7 ms | 19.1 ms | **2.1×** |
| facet with a filter applied | 2.3 ms | 1.1 ms | **2.1×** |
| facet, no filter | 1.9 ms | 3.1 ms | 0.6× |
| totals (`count(distinct)`), utility top 300 | 7.0 / 7.5 ms | unchanged | 1.0× |
| **whole page** | **87.9 ms** | **43.7 ms** | **2.0×** |

In the browser, engine time on first settle fell from 195 ms to 143 ms. Ten queries
spanning facets, group-by, `LIKE`, `count(distinct)`, the map and the year chart
return byte-identical results on both builds.

The one regression is worth a look: unfiltered facets over ten groups went from
1.9 ms to 3.1 ms. It is under 1.5 ms and it disappears as soon as a filter is on,
so it reads like mask-cache setup on queries too cheap to amortise it. A cheap
guard (skip the mask cache when the predicate is absent) would remove it.

## The second shape: wide year columns

We considered replacing the tall detail table with one row per generator and the
yearly series as columns — `gen_2010 … gen_2026`, `cap_*`, `co2_*`, 42,257 rows and
~72 columns. A year-range filter then stops being a `WHERE` and becomes a choice of
which columns to add up, and sparkline data arrives with the row.

The new build does nothing for it: **174.5 ms → 166.3 ms, 1.05×**.

## Why: `coalesce`, not the arithmetic

Ungrouped scan of 42,257 rows:

| expression | time |
|---|---|
| `count(*)` | 0.02 ms |
| `sum(a)` | 0.66 ms |
| `sum(a + b)` | 1.01 ms |
| `sum(a + b + c + d)` | 2.03 ms |
| `sum(` 8 columns `)` | 4.03 ms |
| `sum(` 17 columns `)` | **2.18 ms** |
| `sum(coalesce(a,0) + … )` over the same 17 columns | **8.28 ms** |
| 17 separate `sum(col)` | 2.04 ms |

Seventeen columns of plain addition cost 0.13 ms per column. Wrapped in `coalesce`
they cost 0.49 ms per column — **3.8× the work, for a call that is a no-op on most
of those columns.** The multi-column arithmetic was never the problem.

## The fix was in our data, not the engine

The columns were null when a generator had no rows in that year, which is why the
query needed `coalesce` at all — without it, null propagation silently drops any
generator absent from any single year and the answer is wrong.

Storing `0` instead of `NULL` at build time lets the query drop `coalesce`:

| | time | correct |
|---|---|---|
| null-filled, `sum(coalesce × 17)` | 9.16 ms | yes |
| null-filled, `sum(plain × 17)` | 2.28 ms | **no** — null propagation |
| **zero-filled, `sum(plain × 17)`** | **2.23 ms** | **yes** |
| zero-filled, `sum(coalesce × 17)` | 7.41 ms | yes |

The whole proposed page: **166 ms → 72 ms**, on the same engine. The gzipped image
got slightly smaller too (3.45 MB → 3.32 MB), since a run of zeros compresses better
than a validity bitmap plus gaps.

## What is actually left for the engine

Two things, both small and both benchmarkable:

1. **Constant-fold `coalesce(col, k)` when the column has no nulls.** The compiled
   image already knows this — validity bitmaps are omitted entirely for null-free
   columns — so the planner can drop the call at bind time. That would have made
   the null-filled table as fast as the zero-filled one and saved a day of
   confusion. It is the difference between 0.13 ms and 0.49 ms per column per
   scan, on a call most people write defensively.
2. **`count(distinct <text>)` costs about 6 ms where `count(*)` costs 0.2 ms**
   (grouped by fuel over 42,257 rows: 0.20 ms → 14.86 ms with a distinct text
   count, 10.41 ms with a distinct int count). Dictionary columns already execute
   predicates once per distinct value; a distinct count over a dictionary column
   could in principle be a per-group bitmap over codes rather than a hash set.

Neither is blocking. With zero-filled columns the page is comfortably fast.

## Reproducing

`explorer/bench.mjs` runs both builds side by side over both table shapes and
prints the first two tables. `explorer/micro.mjs` produces the column-cost table,
`explorer/page-sim.mjs` the whole-panel-set comparison and `explorer/counts.mjs`
the cost of each kind of count. The null-versus-zero table needs the wide table
built both ways: drop the `coalesce(..., 0)` wrappers in
`scripts/build-generator-wide.sql` to get the null-filled variant. All three drive `core.js` directly in
Node against the prebuilt images, so there is no browser or worker in the loop.
Timings are the minimum of seven to nine runs on a warm image, single-threaded wasm.
