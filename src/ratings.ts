import type { DatabaseSync } from "node:sqlite";

import { ASSET_COLUMNS, publicAsset, type AssetRow } from "./assets.ts";
import type { Auth, Ctx } from "./auth.ts";
import { firstValue, HttpError, sendJson } from "./http.ts";
import { libraryAccessibleBy } from "./libraries.ts";
import {
  applyRatingChange,
  ratingChangeFromBody,
  ratingChangeFromKey,
  type RatingChange,
} from "./rating.ts";
import {
  assetInScope,
  assetScope,
  assetsBefore,
  assetsInScope,
  firstAssetInScope,
  neighbouringAsset,
  type AssetScope,
} from "./scope.ts";

const SHORTCUTS = {
  pick: ["P"],
  reject: ["X"],
  unflag: ["U"],
  stars: ["1", "2", "3", "4", "5"],
  clearStars: ["0"],
};

function positiveInt(value: unknown, code: string): number {
  let id = NaN;
  if (typeof value === "number") {
    id = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    id = Number(value.trim());
  }
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, code);
  return id;
}

function assetIdsFrom(
  body: Record<string, unknown>,
  query: URLSearchParams,
): number[] {
  let raw = firstValue(body, query, [
    "assetIds",
    "asset_ids",
    "ids",
    "assetId",
    "asset_id",
    "id",
  ]);
  if (typeof raw === "string") {
    raw = raw.split(",");
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, "missing_assetIds");
  }
  const ids = new Set<number>();
  for (const value of raw) {
    ids.add(positiveInt(value, "invalid_assetId"));
  }
  return [...ids];
}

/**
 * Build the Rating API: set or clear an Asset's Pick/Reject flag and 1-5
 * stars, individually or in bulk, filter a Library by Rating, and drive a
 * Quick review queue with the P, X and 1-5 keyboard shortcuts. Rejected
 * Assets stay in the Library; clients dim them with the returned `rejected`
 * (and `dimmed`) field or hide them with `hideRejected=true`. Access is
 * enforced server-side against the authenticated Member (ADR 0003).
 */
export function createRatings(db: DatabaseSync, auth: Auth) {
  const requireMember = (ctx: Ctx) => {
    const member = auth.currentMember(ctx.cookies);
    if (!member) throw new HttpError(401, "unauthenticated");
    return member;
  };

  const requireLibrary = (libraryId: number, memberId: number): void => {
    if (!libraryAccessibleBy(db, libraryId, memberId)) {
      throw new HttpError(404, "library_not_found");
    }
  };

  const assetById = (assetId: number): AssetRow | undefined =>
    db
      .prepare(`SELECT ${ASSET_COLUMNS} FROM asset WHERE id = ?`)
      .get(assetId) as AssetRow | undefined;

  const accessibleAsset = (assetId: number, memberId: number): AssetRow => {
    const asset = assetById(assetId);
    if (!asset || !libraryAccessibleBy(db, asset.library_id, memberId)) {
      throw new HttpError(404, "asset_not_found");
    }
    return asset;
  };

  /** Resolve the Rating change in a body, or fail when none was supplied. */
  const changeOrThrow = (
    body: Record<string, unknown>,
    code = "missing_rating",
  ): RatingChange => {
    const change = ratingChangeFromBody(body);
    if (change.flag === undefined && change.stars === undefined) {
      throw new HttpError(400, code);
    }
    return change;
  };

  /** Select the row coming after/before an Asset in the filtered queue. */
  const neighbour = (
    scope: AssetScope,
    asset: AssetRow,
    direction: "next" | "previous",
  ): AssetRow | null => neighbouringAsset(db, scope, asset, direction);

  const rowsBefore = (scope: AssetScope, asset: AssetRow): number =>
    assetsBefore(db, scope, asset);

  const total = (scope: AssetScope): number => assetsInScope(db, scope);

  const firstInQueue = (scope: AssetScope): AssetRow | null =>
    firstAssetInScope(db, scope);

  const matchesScope = (scope: AssetScope, assetId: number): boolean =>
    assetInScope(db, scope, assetId);

  /** Current/neighbours/position for the review view. */
  const reviewState = (
    scope: AssetScope,
    current: AssetRow | null,
  ): Record<string, unknown> => {
    const totalRows = total(scope);
    if (!current) {
      return {
        total: totalRows,
        position: 0,
        current: null,
        asset: null,
        previous: null,
        next: null,
        shortcuts: SHORTCUTS,
      };
    }
    const previous = neighbour(scope, current, "previous");
    const next = neighbour(scope, current, "next");
    return {
      total: totalRows,
      position: rowsBefore(scope, current) + 1,
      current: publicAsset(current),
      asset: publicAsset(current),
      previous: previous === null ? null : publicAsset(previous),
      next: next === null ? null : publicAsset(next),
      shortcuts: SHORTCUTS,
    };
  };

  const urlOf = (ctx: Ctx): URL =>
    new URL(ctx.req.url ?? "/", "http://familio.local");

  /** GET /api/libraries/:id/review — one Asset plus its neighbours. */
  const review = (ctx: Ctx): void => {
    const member = requireMember(ctx);
    const libraryId = Number(ctx.params.id);
    requireLibrary(libraryId, member.id);
    const url = urlOf(ctx);
    const scope = assetScope(libraryId, url);

    const anchorRaw = firstValue(ctx.body, url.searchParams, [
      "assetId",
      "asset_id",
      "current",
      "cursor",
      "start",
      "id",
    ]);
    let current: AssetRow | null;
    if (anchorRaw === undefined || anchorRaw === null || anchorRaw === "") {
      current = firstInQueue(scope);
    } else {
      const anchorId = positiveInt(anchorRaw, "invalid_assetId");
      const anchor = accessibleAsset(anchorId, member.id);
      if (anchor.library_id !== libraryId) {
        throw new HttpError(404, "asset_not_found");
      }
      current = matchesScope(scope, anchor.id)
        ? anchor
        : neighbour(scope, anchor, "next");
    }

    sendJson(ctx.res, 200, reviewState(scope, current));
  };

  /** POST /api/libraries/:id/review[/:assetId] — apply a keyboard action. */
  const reviewAction = (ctx: Ctx): void => {
    const member = requireMember(ctx);
    const libraryId = Number(ctx.params.id);
    requireLibrary(libraryId, member.id);
    const url = urlOf(ctx);

    const assetIdRaw =
      ctx.params.assetId ??
      firstValue(ctx.body, url.searchParams, [
        "assetId",
        "asset_id",
        "current",
        "currentId",
        "current_id",
        "cursor",
        "id",
      ]);
    if (assetIdRaw === undefined || assetIdRaw === null || assetIdRaw === "") {
      throw new HttpError(400, "missing_assetId");
    }
    const asset = accessibleAsset(
      positiveInt(assetIdRaw, "invalid_assetId"),
      member.id,
    );
    if (asset.library_id !== libraryId) {
      throw new HttpError(404, "asset_not_found");
    }

    const key = firstValue(ctx.body, url.searchParams, [
      "key",
      "shortcut",
      "action",
    ]);
    const change =
      key === undefined || key === null || key === ""
        ? ratingChangeFromBody(ctx.body)
        : ratingChangeFromKey(key);

    const directionRaw = String(
      firstValue(ctx.body, url.searchParams, ["move", "nav"]) ?? "next",
    ).toLowerCase();
    const direction =
      ["prev", "previous", "back", "before"].includes(directionRaw)
        ? "previous"
        : "next";

    if (change.flag === undefined && change.stars === undefined) {
      throw new HttpError(400, key === undefined ? "missing_rating" : "invalid_key");
    }

    applyRatingChange(db, asset.id, change);
    const updated = accessibleAsset(asset.id, member.id);

    const scope = assetScope(libraryId, url);
    const nextCurrent = neighbour(scope, updated, direction);
    sendJson(ctx.res, 200, {
      ...reviewState(scope, nextCurrent),
      asset: publicAsset(updated),
      rated: publicAsset(updated),
      applied: change,
      key: key ?? null,
    });
  };

  /** PATCH /api/assets/:id/rating — set/clear a flag and/or stars. */
  const update = (ctx: Ctx): void => {
    const member = requireMember(ctx);
    const asset = accessibleAsset(Number(ctx.params.id), member.id);
    const change = changeOrThrow(ctx.body);
    applyRatingChange(db, asset.id, change);
    sendJson(
      ctx.res,
      200,
      publicAsset(accessibleAsset(asset.id, member.id)),
    );
  };

  const updateFlag = (ctx: Ctx): void => {
    const member = requireMember(ctx);
    const asset = accessibleAsset(Number(ctx.params.id), member.id);
    const change = changeOrThrow(ctx.body, "missing_flag");
    if (change.flag === undefined) throw new HttpError(400, "missing_flag");
    applyRatingChange(db, asset.id, { flag: change.flag });
    sendJson(
      ctx.res,
      200,
      publicAsset(accessibleAsset(asset.id, member.id)),
    );
  };

  const updateStars = (ctx: Ctx): void => {
    const member = requireMember(ctx);
    const asset = accessibleAsset(Number(ctx.params.id), member.id);
    const change = changeOrThrow(ctx.body, "missing_stars");
    if (change.stars === undefined) throw new HttpError(400, "missing_stars");
    applyRatingChange(db, asset.id, { stars: change.stars });
    sendJson(
      ctx.res,
      200,
      publicAsset(accessibleAsset(asset.id, member.id)),
    );
  };

  /** POST/PATCH /api/libraries/:id/assets/ratings — bulk set/clear. */
  const bulk = (ctx: Ctx): void => {
    const member = requireMember(ctx);
    const libraryId =
      ctx.params.id === undefined ? null : Number(ctx.params.id);
    if (libraryId !== null) requireLibrary(libraryId, member.id);

    const change = changeOrThrow(ctx.body);
    const ids = assetIdsFrom(ctx.body, urlOf(ctx).searchParams);

    // Check every Asset first so a bad id leaves no partial bulk change.
    const assets: AssetRow[] = [];
    for (const id of ids) {
      const asset = accessibleAsset(id, member.id);
      if (libraryId !== null && asset.library_id !== libraryId) {
        throw new HttpError(404, "asset_not_found");
      }
      assets.push(asset);
    }

    db.exec("BEGIN");
    try {
      for (const asset of assets) {
        applyRatingChange(db, asset.id, change);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    const updated = assets.map((asset) =>
      publicAsset(accessibleAsset(asset.id, member.id)),
    );
    sendJson(ctx.res, 200, {
      updated,
      assets: updated,
      count: updated.length,
    });
  };

  return {
    update,
    updateFlag,
    updateStars,
    bulk,
    review,
    reviewAction,
  };
}

export type Ratings = ReturnType<typeof createRatings>;
