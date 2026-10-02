// The "near a town" filter: plants within N km of a point.
//
// Ported from gem-explorer's near.ts. One URL param carries the whole thing —
// `near=<lat>,<lon>,<km>,<label>` — so a shared link filters immediately, without waiting
// for the places table, which is only needed to pick a place in the first place.
/** URL param / filter key. Not a column name, and not one of the DIMS. */
export const NEAR_PARAM = "near";

export const KM_OPTIONS = [10, 25, 50, 100, 200, 500];
export const DEFAULT_KM = 50;

/** "Austin, Texas" — display only. A place whose region repeats its name says it once
 *  (New York, New York), but the name itself is always kept. */
export function placeLabel(p) {
  return [p.name, ...[p.region].filter((s) => s && s !== p.name)].join(", ");
}

export function parseNear(v) {
  if (!v) return null;
  const [lat, lon, km, ...rest] = String(v).split(",");
  const n = { lat: Number(lat), lon: Number(lon), km: Number(km), label: rest.join(",").trim() };
  if (![n.lat, n.lon, n.km].every(Number.isFinite)) return null;
  if (Math.abs(n.lat) > 90 || Math.abs(n.lon) > 180 || n.km <= 0) return null;
  return n;
}

export const formatNear = (n) => `${n.lat},${n.lon},${n.km},${n.label}`;

/** The closest offered radius, so a hand-edited 30 km lands on a dropdown value. */
export const snapKm = (km) =>
  KM_OPTIONS.reduce((best, o) => (Math.abs(o - km) < Math.abs(best - km) ? o : best), DEFAULT_KM);

// The two SQL builders live in sql.js, which imports this file; keeping this one free of
// SQL avoids an import cycle.

/** The radius as a closed GeoJSON ring, for drawing the circle on the map. */
export function circleRing(n, steps = 96) {
  const R = 6371.0088;
  const d = n.km / R;
  const la = (n.lat * Math.PI) / 180;
  const lo = (n.lon * Math.PI) / 180;
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const b = (2 * Math.PI * i) / steps;
    const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    ring.push([(lo2 * 180) / Math.PI, (la2 * 180) / Math.PI]);
  }
  return ring;
}
