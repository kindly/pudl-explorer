// MapLibre plant map. Positron basemap (same as gem-explorer), one circle per plant × fuel,
// radius ∝ √measure, colour by fuel. Falls back to a blank background style when the
// basemap cannot be fetched (offline, blocked), so the dots still render.
import { Map as MLMap, NavigationControl } from "./vendor/maplibre/maplibre-gl.mjs";

const STYLE_URL = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const BLANK_STYLE = { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#eef3f5" } }] };
const US_BOUNDS = [[-125.5, 24], [-66, 50]];

async function fetchStyle() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(STYLE_URL, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error(String(r.status));
    return await r.json();
  } catch (e) {
    console.warn("basemap style unavailable, using blank background", e.message);
    return BLANK_STYLE;
  }
}

/**
 * createPlantMap(container, { onHover(props|null, lngLat), onClick(props) }) -> { update(features), ready }
 * features: [{ p, f, lat, lon, v, r, c }]  (r = radius px, c = colour)
 */
export async function createPlantMap(container, { onHover, onClick } = {}) {
  const style = await fetchStyle();
  const map = new MLMap({
    container, style, bounds: US_BOUNDS, fitBoundsOptions: { padding: 10 },
    attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false,
  });
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  map.touchZoomRotate.disableRotation();
  let pending = null;
  const ready = new Promise((res) => map.on("load", () => {
    map.addSource("plants", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "plants", type: "circle", source: "plants",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, ["get", "r"], 7, ["*", ["get", "r"], 2.2], 10, ["*", ["get", "r"], 4]],
        "circle-color": ["get", "c"],
        "circle-opacity": 0.72,
        "circle-stroke-color": "rgba(0,36,48,0.35)",
        "circle-stroke-width": 0.6,
      },
    });
    map.on("mousemove", "plants", (e) => { map.getCanvas().style.cursor = "pointer"; onHover?.(e.features[0].properties, e.lngLat); });
    map.on("mouseleave", "plants", () => { map.getCanvas().style.cursor = ""; onHover?.(null); });
    map.on("click", "plants", (e) => onClick?.(e.features[0].properties));
    if (pending) { map.getSource("plants").setData(pending); pending = null; }
    res();
  }));
  function update(points) {
    const data = {
      type: "FeatureCollection",
      // big dots first in the array draw underneath: sort ascending by radius so small ones stay clickable
      features: points.slice().sort((a, b) => b.r - a.r).map((q) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [q.lon, q.lat] },
        properties: { p: q.p, f: q.f ?? "", v: q.v, r: q.r, c: q.c },
      })),
    };
    const src = map.getSource("plants");
    if (src) src.setData(data); else pending = data;
  }
  return { map, update, ready, fitUS: () => map.fitBounds(US_BOUNDS, { padding: 10, duration: 600 }) };
}
