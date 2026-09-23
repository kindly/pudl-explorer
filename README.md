# pudl-explorer

https://kindly.github.io/pudl-explorer/explorer/

A faceted, in-browser explorer for US power plant data from
[PUDL](https://catalyst.coop/pudl/) (Catalyst Cooperative's cleaned EIA, EPA and
FERC data), running entirely on static files with
facetful, a WebAssembly columnar SQL engine built for exactly this (~170 KB) — no server, no database.

**Live:** open `explorer/` on the published site. First visit downloads ~24 MB
of compiled columnar images; repeat visits load from the browser's own storage.

- `explorer/` — the page and its vendored dependencies; see
  [`explorer/README.md`](explorer/README.md) for the data model, what each panel
  does, and what we learned about facetful at this scale.
- `data/*.facetful.gz` — the two tables the page loads: plant × technology ×
  status × year (231K rows) and generator × year (485K rows), with EPA CEMS
  emissions and FERC Form 1 costs joined on.
- `scripts/` — the DuckDB rebuild recipe from PUDL's public S3 bucket.

Data © the US EIA, EPA and FERC via PUDL (CC-BY-4.0). Code MIT.
