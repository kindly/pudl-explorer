# `count(distinct)` is now the floor on this page — two ways out

> **Update, 0.3.1.** Most of this is now history: 0.3.1 cut `count(distinct)` by
> 2× to 3×, and the whole-page total by 1.5× to 1.8×. Measurements and what still
> stands are in [After 0.3.1](#after-031) at the end. The body below is the 0.3.0
> analysis that prompted it, left as written.

Follow-on to `facetful-notes.md`. That round took the whole page from 87.9 ms to
43.7 ms and left exactly one line unmoved: `count(distinct)`, 1.0×. It is now the
largest single cost in a facet query, and on the wider of the two tables it is most
of the query. This note measures it and compares three ways to remove it, one of
which does not work.

Measured against facetful 0.3.0, on the two images the PUDL explorer ships.

## Where the time goes

Every facet runs one query that returns three things at once: the group key, a plant
count, and a measure. The app builds it as

```sql
select <dim> as k,
       count(distinct plant_id_eia) as n,   -- shown on every row
       count(distinct gen_key) as g,        -- hover tooltip only
       round(sum(gen_2010 + … + gen_2026)/1000000.0, 3) as v
from t group by <dim> order by v desc limit 500
```

Taking that apart, best-of-15, milliseconds:

**`generator_tech_wide` — 42,257 rows, measure sums 17 year columns**

| dimension | `count(*)` | + 1 distinct | + 2 distinct | measure alone | counts alone |
|---|---|---|---|---|---|
| fuel | 3.2 | 4.6 | 6.0 | 2.3 | 3.7 |
| state | 2.4 | 3.9 | 5.7 | 2.4 | 3.8 |
| utility, limit 300 | 8.4 | 10.0 | 13.0 | 7.6 | 5.4 |

**`plant_tech_year` — 230,891 rows, measure sums 1 column**

| dimension | `count(*)` | + 1 distinct | measure alone | counts alone |
|---|---|---|---|---|
| fuel | 1.8 | 6.5 | 1.6 | 5.9 |
| state | 1.8 | 6.4 | 1.5 | 5.7 |
| utility, limit 300 | 7.4 | 12.2 | 6.3 | 7.8 |

Two things stand out.

On the plant table a single `count(distinct plant_id_eia)` takes a 1.8 ms query to
6.5 ms. That is **3.6×, from one aggregate**. On the generator table two distinct
counts roughly double it.

The plant table beats the generator table on plain `count(*)` — 1.8 ms against
3.2 ms — while holding 5.5× the rows. That is the 17-column measure sum showing up,
and it is the second cost worth attention after the counts.

## Route 1: clustered distinct columns

Both images are written in plant order, and the property is exact rather than
approximate:

| image | rows | distinct `plant_id_eia` | runs | non-decreasing |
|---|---|---|---|---|
| `generator_tech_wide` | 42,257 | 18,937 | 18,937 | 100% |
| `plant_tech_year` | 230,891 | 18,937 | 18,937 | 100% |

Runs equal distinct values, so every plant occupies one contiguous span. A hash set
is doing work it never needs to do: scanning in row order, the distinct count for a
group is "did this value differ from the previous row assigned to this group", one
comparison and no allocation.

Detect clustering once at open time, store it as a column flag, and swap the
aggregator. Cheap to build, exact, and it needs nothing from the writer beyond an
`ORDER BY` that most pipelines already have. There is a second reason to expect it
in the wild: on the earlier 4.5M-row generator-month image, writing in plant order
rather than date order took the gzipped file from 122 MB to 43 MB. Compression
pressure already pushes people into exactly the layout this optimisation wants.

The limit is that it is a property of the file, not of the model. Rewrite the table
in a different order and the optimisation silently stops applying. A plan-level
note, or a warning when a `count(distinct)` misses the fast path, would stop that
being invisible.

## Route 2: an array type, and a coarser grain

The stronger idea, because it removes the reason the distinct count exists at all.

A plant appears on 42,257 rows because its generators differ. Collapse to one row
per plant, hold the varying dimensions as arrays of dictionary codes, and counting
plants becomes `count(*)`: the duplication moves into array membership, where it
belongs. That is exact under any filter combination.

At plant grain the table is 18,937 rows. Arraying each dimension costs:

| dimension | codes | elements | vs base rows | length 1 |
|---|---|---|---|---|
| fuel | 10 | 21,093 | 0.50× | 89.8% |
| technology | 29 | 21,707 | 0.51× | 88.2% |
| operational status | 4 | 20,396 | 0.48× | 92.8% |
| state | 53 | 18,937 | 0.45× | 100% |
| balancing authority | 89 | 19,058 | 0.45× | 99.4% |
| utility | 8,261 | 19,035 | 0.45× | 99.5% |
| site capacity bucket | 6 | 20,322 | 0.48× | 93.3% |
| commissioning decade | 15 | 20,836 | 0.49× | 92.1% |
| CO₂ intensity bucket | 6 | 20,296 | 0.48× | 94.9% |
| CEMS coverage | 5 | 19,597 | 0.46× | 97.0% |

Summed over all ten, 201,277 elements against 422,570 flat cells — **0.48×**. So a
facet scan touches about half the elements, and the per-element work drops from a
hash-set insert to incrementing a dense counter indexed by dictionary code. Two
independent factors, both in the right direction.

Three things to design around.

**Singletons are the common case, 88% to 100%.** A conventional list column would
pay offsets on every row to serve the rare one. The singleton path wants to be free:
inline the value and spill multi-valued rows to a side structure, so the scan stays
branch-predictable.

**The measure does not collapse with the count.** A facet shows a number beside each
bar, and it must respond to a filter on an arrayed dimension — filtering to coal
should sum coal generation only. A scalar plant total cannot do that, and value
arrays aligned index-for-index with the dimension arrays are the flat table again in
nested form. The realistic shape is two images, arrays for counts and flat for
measures, with the caller merging on the group key. Worth stating in the docs,
because the obvious reading of the feature is that one image replaces two.

**Dense counters need bounded cardinality.** Utility has 8,261 codes here, which is
fine. A high-cardinality string column would want the hash path anyway.

## What does not work: deriving the counts after load

We considered the other feature under discussion — client-side SQL producing a
second table at load — as a way to precompute the counts. It cannot do it, and the
reason is a clean rule worth writing into the feature's documentation.

A derived table replaces `count(distinct k)` with `count(*)` only if deduplicating
is lossless, meaning each `k` contributes exactly one row per group after filtering.
That holds only when `k` is functionally determined by the grouping key. Here it is
deliberately not: nine of the ten dimensions vary inside a plant.

| dimension | plants with more than one value |
|---|---|
| technology | 2,226 (11.8%) |
| fuel | 1,936 (10.2%) |
| commissioning decade | 1,489 (7.9%) |
| operational status | 1,366 (7.2%) |
| site capacity bucket | 1,270 (6.7%) |
| state | 0 |

Distinct (plant, all ten dimensions) is 24,176 rows against 42,257 — a 1.75× shrink
that still double-counts any plant holding two technologies under one fuel. Wrong
numbers, not faster ones.

A table per (grouping dimension, filtered dimension) pair is exact, because
collapsing to distinct triples makes `count(*)` correct. That covers zero or one
active filter. Two filters need a table per triple, three per quadruple. Facets
exist to be combined, so the common case is the one it cannot serve.

None of this argues against the derive-after-load feature. It argues that its value
is the case discussed separately — shipping one detail image and materialising
rollups that exist purely to make queries fast — not this one.

## Suggested order

1. **Clustered distinct.** Small, exact, no format change, and it lands on data that
   already has the property. Removes most of 3.7 ms and 5.9 ms per facet here.
2. **Array type.** Larger, but it is a modelling primitive rather than a peephole: it
   shrinks images, removes a real wart where a two-technology plant is two rows, and
   does not depend on physical ordering.
3. The 17-column measure sum is the next floor once the counts are gone. Zero-filling
   already bought 4.2× over `coalesce()`; whether a wide additive sum can be
   vectorised further is a separate question.

## Reproducing

All figures come from node against the shipped images, driving the engine directly
through `explorer/engine.js`:

```js
import { coreUrl, wasmUrl } from "./explorer/engine.js";
const { instantiate } = await import(coreUrl.href);
const eng = await instantiate(readFileSync(wasmUrl));
const h = eng.openTable(readFileSync("data/generator_tech_wide.facetful")).handle;
```

Timings are best-of-15 on a warm image. Clustering and cardinality figures come from
pulling the raw column with `select plant_id_eia as p from t` and walking it.

---

## After 0.3.1

0.3.1 is wasm-only again: `core.js`, `index.js`, `worker.js`, `parquet.js` and
`index.d.ts` are byte-identical to 0.3.0. The wasm got **smaller**, 473,183 to
440,875 bytes.

### The page

Same suite as `facetful-notes.md`, best-of-15 against the shipped images.

| | 0.3.0 | 0.3.1 | |
|---|---|---|---|
| `plant_tech_year`, whole suite | 44.1 ms | 24.2 ms | **1.82×** |
| `generator_tech_wide`, whole suite | 71.6 ms | 47.2 ms | **1.52×** |
| totals (`count(distinct)`), pty | 6.5 ms | 2.2 ms | **2.92×** |
| map, `group by plant, fuel` | 19.5 / 22.3 ms | 8.1 / 6.9 ms | **2.4× / 3.2×** |
| facet utility, limit 300 | 7.6 / 11.1 ms | 3.6 / 5.1 ms | **2.1× / 2.2×** |

In the browser, engine time on first settle fell from 143 ms to 89 ms, and a
year-range change from 97 ms to 55 ms.

### The aggregate itself

Isolating it the same way as above, group by fuel:

| variant | 0.3.0 | 0.3.1 | |
|---|---|---|---|
| gw, one distinct only | 1.7 ms | 0.7 ms | **2.3×** |
| gw, two distincts only | 3.7 ms | 1.6 ms | **2.4×** |
| pty, one distinct only | 6.0 ms | 1.8 ms | **3.3×** |
| gw, `count(*)` only | 0.2 ms | 0.2 ms | 1.0× |
| gw, measure only | 2.2 ms | 2.2 ms | 1.0× |
| pty, measure only | 1.6 ms | 1.5 ms | 1.0× |

Repeated three times; the `count(*)` and measure rows sit in a 0.88× to 1.14× band
run to run, so those are unchanged and the distinct rows are the real signal.

### Which distinct counts got faster

| column | distinct | runs | clustered | 0.3.0 | 0.3.1 | |
|---|---|---|---|---|---|---|
| `plant_id_eia` (int) | 18,937 | 18,937 | yes | 2.0 ms | 1.0 ms | **2.04×** |
| `gen_key` (int) | 40,740 | 40,740 | yes | 2.5 ms | 1.2 ms | **2.09×** |
| `utility_name_eia` (dict) | 8,261 | 14,043 | no | 0.3 ms | 0.3 ms | 1.06× |
| `operational_status` (dict) | 4 | 7,843 | no | 0.3 ms | 0.3 ms | 1.07× |
| `technology_description` (dict) | 29 | 13,267 | no | 0.3 ms | 0.3 ms | 1.06× |

The gain lands entirely on the two integer columns. The dictionary columns were
already cheap and did not move.

**This does not confirm the clustered-scan theory**, and it is worth being explicit
about that. In this data the two integer columns are also the two clustered columns
and the two highest-cardinality ones, so type, clustering and cardinality are
confounded and these numbers cannot separate them. Telling them apart needs an
unclustered integer column of comparable cardinality, which neither image has. If
the implementation went down the integer route rather than the clustering route,
then a table written in a different order keeps the gain, which would be the better
outcome.

### What still stands

**Route 1 looks delivered**, whatever the mechanism. A distinct plant count now
costs about 1 ms on 230,891 rows instead of 6.

**Route 2, the array type, is no longer a count-performance argument.** At 0.7 ms
the counts are no longer the floor, and halving the scan again would be a small
absolute win. The case for arrays now rests on the two things in its favour that
were never about speed: images shrink, here 42,257 rows to 18,937, and the
modelling wart goes away where a plant with two technologies is two rows and gets
counted twice by anything using `count(*)`.

**The measure sum is now the floor.** On `generator_tech_wide` a facet is 3.5 ms,
of which 2.2 ms is summing seventeen year columns and 0.7 ms is the counts.
Zero-filling already bought 4.2× over `coalesce()` there. Whether a wide additive
sum can be vectorised further is the next question, and it is a bigger share of
this page than `count(distinct)` ever was.
