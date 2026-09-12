// MapLibre plant map. Positron basemap (same as gem-explorer), one circle per plant × fuel,
// radius ∝ √measure, colour by fuel. Hover shows a tooltip that stays while the pointer is on
// the dot; click pins a popup that the app fills with details (GEM wiki link, drill-in button).
// Falls back to a blank background style when the basemap cannot be fetched, so dots still render.
import { Map as MLMap, NavigationControl, Popup } from "./vendor/maplibre/maplibre-gl.mjs";

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
 * createPlantMap(container, { hoverHtml(props) -> string, clickHtml(props) -> Promise<string|Node> })
 *   -> { map, update(points), fitUS() }
 * points: [{ p, f, lat, lon, v, r, c }]  (r = radius px at zoom 3, c = colour)
 */
export async function createPlantMap(container, { hoverHtml, clickHtml } = {}) {
  const style = await fetchStyle();
  const map = new MLMap({
    container, style, bounds: US_BOUNDS, fitBoundsOptions: { padding: 10 },
    attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false,
  });
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  map.on("error", (e) => console.warn("maplibre:", e.error?.message ?? e));
  map.once("idle", () => console.info("maplibre: basemap idle", style === BLANK_STYLE ? "(blank style)" : "(positron)", Object.keys(style.sources).join(",")));
  document.fonts?.ready.then(() => map.resize());
  window.addEventListener("load", () => map.resize());
  map.touchZoomRotate.disableRotation();

  const hover = new Popup({ closeButton: false, closeOnClick: false, offset: 8, className: "plant-hover", maxWidth: "22rem" });
  const pinned = new Popup({ closeButton: true, closeOnClick: true, offset: 10, className: "plant-pin", maxWidth: "26rem" });
  let hoverTimer = null, hoverP = null;

  let pending = null;
  await new Promise((res) => map.on("load", () => {
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
    map.on("mousemove", "plants", (e) => {
      map.getCanvas().style.cursor = "pointer";
      clearTimeout(hoverTimer);
      if (pinned.isOpen()) return; // a pinned popup owns the screen
      const f = e.features[0];
      hoverP = f.properties.p;
      hover.setLngLat(f.geometry.coordinates).setHTML(hoverHtml?.(f.properties) ?? "").addTo(map);
    });
    map.on("mouseleave", "plants", () => {
      map.getCanvas().style.cursor = "";
      // linger briefly so the pointer can cross a gap between dots without flicker
      hoverTimer = setTimeout(() => hover.remove(), 700);
    });
    map.on("click", "plants", async (e) => {
      const f = e.features[0];
      hover.remove();
      // the card is tall and arrives after the popup opens: anchor it away from the nearest map edge up front
      const { x, y } = e.point, w = map.getContainer().clientWidth, h = map.getContainer().clientHeight;
      pinned.options.anchor = (y > h * 0.4 ? "bottom" : "top") + (x > w * 0.7 ? "-right" : x < w * 0.3 ? "-left" : "");
      pinned.setLngLat(f.geometry.coordinates).setHTML('<div class="pp-loading">loading…</div>').addTo(map);
      const content = await clickHtml?.(f.properties);
      if (!pinned.isOpen()) return;
      if (typeof content === "string") pinned.setHTML(content); else if (content) pinned.setDOMContent(content);
    });
    if (pending) { map.getSource("plants").setData(pending); pending = null; }
    res();
  }));

  let zoomedIn = false;
  function update(points) {
    const data = {
      type: "FeatureCollection",
      // big dots first in the array draw underneath: sort descending by radius so small ones stay clickable
      features: points.slice().sort((a, b) => b.r - a.r).map((q) => ({
        type: "Feature", geometry: { type: "Point", coordinates: [q.lon, q.lat] },
        properties: { p: q.p, f: q.f ?? "", v: q.v, r: q.r, c: q.c },
      })),
    };
    const src = map.getSource("plants");
    if (src) src.setData(data); else pending = data;
    pinned.remove(); hover.remove();
    // a handful of points (a plant drill-down): fly to them; otherwise stay where the user left the view
    if (points.length && points.length <= 10) {
      const lons = points.map((q) => q.lon), lats = points.map((q) => q.lat);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 80, maxZoom: 9, duration: 700 });
    } else if (zoomedIn) { map.fitBounds(US_BOUNDS, { padding: 10, duration: 700 }); }
    zoomedIn = points.length > 0 && points.length <= 10;
  }
  /** Replace the hover tooltip's HTML if it is still showing plant `p` (used when a name arrives asynchronously). */
  const refreshHover = (p, html) => { if (hover.isOpen() && hoverP === p) hover.setHTML(html); };
  return { map, update, refreshHover, fitUS: () => map.fitBounds(US_BOUNDS, { padding: 10, duration: 600 }) };
}
