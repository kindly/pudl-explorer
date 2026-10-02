# pudl-explorer

https://kindly.github.io/pudl-explorer/explorer/

A faceted, in-browser explorer for US power plant data from
[PUDL](https://catalyst.coop/pudl/) (Catalyst Cooperative's cleaned EIA, EPA and
FERC data), running entirely on static files with
[facetful](https://www.npmjs.com/package/facetful), a WebAssembly columnar SQL
engine built for exactly this — no server, no database.

**Live:** https://kindly.github.io/pudl-explorer/. A first visit downloads about
14.5 MB of compiled columnar images; repeat visits load them from the browser's
own storage and fetch nothing.

- `explorer/` — the page and its vendored dependencies; see
  [`explorer/README.md`](explorer/README.md) for the data model, what each panel
  does, how the engine is vendored, and what we learned about facetful at this
  scale.
- `data/*.facetful.gz` — the two tables the page loads: generator × technology
  with seventeen years of history as columns (42K rows, 3.6 MB) and plant ×
  technology × status × year with monthly detail (231K rows, 10.9 MB), both with
  EPA CEMS emissions and FERC Form 1 costs joined on.
- `scripts/` — the DuckDB rebuild recipe from PUDL's public S3 bucket.
- `docs/` — performance write-ups for the engine author.

Data © the US EIA, EPA and FERC via PUDL (CC-BY-4.0). Code MIT.
