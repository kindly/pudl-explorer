// The one place the facetful build is named.
//
// The directory carries the version because a query string cannot reach every file: worker.js
// imports core.js by a relative URL of its own, so `worker.js?v=x` still pulls whatever core.js the
// browser has cached. Putting the version in the path gives every file inside a fresh URL on
// upgrade, which matters most for the 460 KB wasm. sync-vendor.mjs rewrites DIR; nothing else here
// or in vendor/ is edited by hand.
//
// Only URLs live here, so node harnesses can import it without pulling in the browser entry point.
export const DIR = "./vendor/facetful-0.3.0/";

export const indexUrl = new URL(DIR + "index.js", import.meta.url);
export const coreUrl = new URL(DIR + "core.js", import.meta.url);
export const parquetUrl = new URL(DIR + "parquet.js", import.meta.url);
export const workerUrl = new URL(DIR + "worker.js", import.meta.url);
export const wasmUrl = new URL(DIR + "facetful_wasm.wasm", import.meta.url);
