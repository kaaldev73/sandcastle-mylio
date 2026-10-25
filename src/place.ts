import { HttpError } from "./http.ts";
import type { SqlFilter } from "./rating.ts";

/**
 * Build the SQL predicate for Location ("place") filters from a query string
 * (PRD: filter a Library by place where the photo has location data). A place
 * is a point plus a radius in kilometres, given as decimal degrees; the match
 * is a bounding box around that point — generous by up to √2 of the radius on
 * the diagonal, well inside "somewhere" for the map-less place finder this
 * seam serves. Coordinates govern precision; Photos without location data
 * never match a place, but stay in unfiltered views.
 */

/** Mean meridian length of one degree of latitude, in kilometres. */
const KM_PER_DEGREE = 111.32;

/** Radius used when a place is named without one. */
const DEFAULT_RADIUS_KM = 100;

/** No radius may exceed the widest span a place can sensibly name. */
const MAX_RADIUS_KM = 20015;

function queryFirst(url: URL, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value !== null && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function queryHas(url: URL, names: readonly string[]): boolean {
  return names.some((name) => url.searchParams.has(name));
}

const LAT_KEYS = ["lat", "latitude"] as const;
const LON_KEYS = ["lon", "lng", "longitude"] as const;
const RADIUS_KEYS = ["radius", "radiusKm", "radius_km", "distanceKm", "maxDistanceKm"] as const;

/** A number from a query value, or null when it is not one. */
function number(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse "a,b" style coordinates, or null when the text is not a pair. */
function parsePoint(place: string): { lat: number; lon: number } | null {
  const match = /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/.exec(place);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** Latitude status of Assets with usable coordinates (see 0012-place). */
const LOCATED = "latitude IS NOT NULL AND longitude IS NOT NULL";

/**
 * Build the SQL predicate for Location filters from a query string. Accepts a
 * lat/lon pair (`place="lat,lon"`, or lat/latitude + lon/lng/longitude) with a
 * radius in kilometres (aliases, 100 km default), and one-way selectors for
 * only-with/without location. Supported together with the date and Rating
 * filters; they "and" together.
 */
export function placeFilterFromQuery(url: URL): SqlFilter {
  const filter: SqlFilter = { clauses: [], params: [] };

  let point: { lat: number; lon: number } | null = null;

  const placeRaw = queryFirst(url, ["place", "near"]);
  if (placeRaw !== undefined) {
    point = parsePoint(placeRaw);
    if (point === null) {
      throw new HttpError(400, "invalid_place");
    }
  }

  const latRaw = queryFirst(url, LAT_KEYS);
  const lonRaw = queryFirst(url, LON_KEYS);
  if (latRaw !== undefined || lonRaw !== undefined) {
    // A single coordinate names no place; both must be given together.
    const lat = latRaw === undefined ? null : number(latRaw);
    const lon = lonRaw === undefined ? null : number(lonRaw);
    if (lat === null || lon === null) throw new HttpError(400, "invalid_place");
    point = { lat, lon };
  }

  if (point !== null) {
    if (point.lat < -90 || point.lat > 90) throw new HttpError(400, "invalid_latitude");
    if (point.lon < -180 || point.lon > 180) throw new HttpError(400, "invalid_longitude");

    const radiusRaw = queryFirst(url, RADIUS_KEYS);
    let radius = DEFAULT_RADIUS_KM;
    if (radiusRaw !== undefined) {
      const parsed = number(radiusRaw);
      if (
        parsed === null ||
        parsed <= 0 ||
        parsed > MAX_RADIUS_KM
      ) {
        throw new HttpError(400, "invalid_radius");
      }
      radius = parsed;
    }

    const halfLat = radius / KM_PER_DEGREE;
    const halfLon = radius / (KM_PER_DEGREE * Math.cos((point.lat * Math.PI) / 180));

    filter.clauses.push("latitude >= ?", "latitude <= ?", "longitude >= ?", "longitude <= ?");
    filter.params.push(
      point.lat - halfLat,
      point.lat + halfLat,
      point.lon - halfLon,
      point.lon + halfLon,
    );
    // The bounding box already requires both; say so in place of the search
    // instead of letting rows with only one coordinate through the box.
    filter.clauses.push(LOCATED);
  }

  if (queryHas(url, ["withLocation", "hasLocation", "located"])) {
    filter.clauses.push(LOCATED);
  } else if (queryHas(url, ["withoutLocation", "noLocation", "unlocated"])) {
    filter.clauses.push("latitude IS NULL OR longitude IS NULL");
  }

  return filter;
}
