import type { DatabaseSync } from "node:sqlite";

import { ASSET_COLUMNS, effectiveDate, type AssetRow } from "./assets.ts";
import { dateRangeFromQuery } from "./dates.ts";
import { ratingFilterFromQuery } from "./rating.ts";

/**
 * The SQL scope of a flat, date-ordered Asset listing in one Library: the
 * Library filter plus any date-range and Rating filters, and whether the
 * oldest come first. The grid, the Timeline's day lists and the neighbours of
 * a single-Asset view all share it so they always agree on what a view shows.
 */
export interface AssetScope {
  clauses: string[];
  params: (string | number)[];
  ascending: boolean;
}

/** Interpret an ordering query, oldest-first aliases included. */
function ascendingFromQuery(url: URL): boolean {
  const raw = (
    url.searchParams.get("order") ??
    url.searchParams.get("direction") ??
    url.searchParams.get("sort") ??
    ""
  ).toLowerCase();
  return raw === "asc" || raw === "ascending" || raw === "oldest";
}

/** Build the Listing scope of one Library from a request URL. */
export function assetScope(libraryId: number, url: URL): AssetScope {
  const range = dateRangeFromQuery(url);
  const rating = ratingFilterFromQuery(url);
  const clauses = ["library_id = ?", ...rating.clauses];
  const params: (string | number)[] = [libraryId, ...rating.params];
  if (range.from !== null) {
    clauses.push("COALESCE(date_override, capture_date) >= ?");
    params.push(range.from);
  }
  if (range.to !== null) {
    clauses.push("COALESCE(date_override, capture_date) <= ?");
    params.push(range.to);
  }
  return { clauses, params, ascending: ascendingFromQuery(url) };
}

/** The SQL ORDER BY for a scope: capture date (corrections win), then id. */
export function scopeOrder(scope: AssetScope): string {
  const word = scope.ascending ? "ASC" : "DESC";
  return `ORDER BY COALESCE(date_override, capture_date) ${word}, id ${word}`;
}

/** The scope's filters as a WHERE-fragment (without the WHERE keyword). */
export function scopeWhere(scope: AssetScope): string {
  return scope.clauses.join(" AND ");
}

/** How many Assets a view shows. */
export function assetsInScope(db: DatabaseSync, scope: AssetScope): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM asset WHERE ${scopeWhere(scope)}`,
    )
    .get(...scope.params) as { n: number };
  return row.n;
}

/** Does this Asset sit in the view (i.e. would the grid list it)? */
export function assetInScope(
  db: DatabaseSync,
  scope: AssetScope,
  assetId: number,
): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM asset WHERE id = ? AND ${scopeWhere(scope)}`,
      )
      .get(assetId, ...scope.params) !== undefined
  );
}

/** How many Assets of the view come before this one in its ordering. */
export function assetsBefore(
  db: DatabaseSync,
  scope: AssetScope,
  asset: AssetRow,
): number {
  const date = effectiveDate(asset);
  const comparison =
    scope.ascending
      ? `(COALESCE(date_override, capture_date) < ? OR
          (COALESCE(date_override, capture_date) = ? AND id < ?))`
      : `(COALESCE(date_override, capture_date) > ? OR
          (COALESCE(date_override, capture_date) = ? AND id > ?))`;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM asset
       WHERE ${scopeWhere(scope)} AND ${comparison}`,
    )
    .get(...scope.params, date, date, asset.id) as { n: number };
  return row.n;
}

/**
 * The Asset immediately before or after another in the view's ordering:
 * "next" walks towards newer in an oldest-first view and towards older in a
 * newest-first one, mirroring how a client flips through photos.
 */
export function neighbouringAsset(
  db: DatabaseSync,
  scope: AssetScope,
  asset: AssetRow,
  direction: "next" | "previous",
): AssetRow | null {
  const date = effectiveDate(asset);
  const older = (direction === "next") !== scope.ascending;
  const comparison = older
    ? `(COALESCE(date_override, capture_date) < ? OR
        (COALESCE(date_override, capture_date) = ? AND id < ?))`
    : `(COALESCE(date_override, capture_date) > ? OR
        (COALESCE(date_override, capture_date) = ? AND id > ?))`;
  const word = older ? "DESC" : "ASC";
  const row = db
    .prepare(
      `SELECT ${ASSET_COLUMNS} FROM asset
       WHERE ${scopeWhere(scope)} AND ${comparison}
       ORDER BY COALESCE(date_override, capture_date) ${word}, id ${word}
       LIMIT 1`,
    )
    .get(...scope.params, date, date, asset.id) as AssetRow | undefined;
  return row ?? null;
}

/** The first Asset of the view in its ordering, or null when it is empty. */
export function firstAssetInScope(
  db: DatabaseSync,
  scope: AssetScope,
): AssetRow | null {
  const word = scope.ascending ? "ASC" : "DESC";
  const row = db
    .prepare(
      `SELECT ${ASSET_COLUMNS} FROM asset
       WHERE ${scopeWhere(scope)}
       ORDER BY COALESCE(date_override, capture_date) ${word}, id ${word}
       LIMIT 1`,
    )
    .get(...scope.params) as AssetRow | undefined;
  return row ?? null;
}
