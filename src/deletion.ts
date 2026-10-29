import type { DatabaseSync } from "node:sqlite";

import { ASSET_COLUMNS, publicAsset, type AssetRow } from "./assets.ts";
import type { Auth, Ctx } from "./auth.ts";
import { firstValue, HttpError, sendJson } from "./http.ts";
import { libraryAccessibleBy } from "./libraries.ts";
import { removeUnreferencedOriginals } from "./originals.ts";

const CONFIRM_KEYS = [
  "confirm",
  "confirmed",
  "confirmation",
  "confirmDelete",
  "confirm_delete",
  "confirmDeletion",
  "confirm_deletion",
  "confirmRemoval",
  "confirm_removal",
  "confirmPermanent",
  "confirm_permanent",
  "confirmPurge",
  "confirm_purge",
] as const;

const PERMANENT_KEYS = [
  "permanent",
  "hard",
  "hardDelete",
  "hard_delete",
  "purge",
] as const;

const CONFIRMATIONS = new Set([
  "true",
  "yes",
  "1",
  "on",
  "delete",
  "confirm",
  "permanent",
  "purge",
]);

function queryOf(ctx: Ctx): URLSearchParams {
  return new URL(ctx.req.url ?? "/", "http://familio.local").searchParams;
}

function truthy(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    (typeof value === "string" &&
      CONFIRMATIONS.has(value.trim().toLowerCase()))
  );
}

/**
 * Read an explicit confirmation from the body or query string. Deleting,
 * restoring and permanently removing are all destructive or state-changing
 * enough that the client must say so deliberately, matching Member removal.
 */
export function isConfirmed(ctx: Ctx): boolean {
  return truthy(firstValue(ctx.body, queryOf(ctx), CONFIRM_KEYS));
}

function requireConfirmation(ctx: Ctx): void {
  if (!isConfirmed(ctx)) {
    throw new HttpError(400, "confirmation_required");
  }
}

/**
 * Build the Delete and recover API. Deleting an Asset is a soft delete: the
 * row, its Rating, its Album memberships and the original file all stay put,
 * while a non-NULL deleted_at hides it from the Timeline, grid, Albums and
 * review queue. Restoring clears that timestamp, bringing the Asset back with
 * everything intact. Permanent removal is a separate, confirmed step that
 * deletes the row and unlinks the original once no other Asset uses it. Every
 * request is access-checked against the authenticated Member's Library.
 */
export function createDeletion(db: DatabaseSync, auth: Auth) {
  const requireMember = (ctx: Ctx) => {
    const member = auth.currentMember(ctx.cookies);
    if (!member) throw new HttpError(401, "unauthenticated");
    return member;
  };

  /** Fetch an Asset the Member may see, or throw 404 (never revealing why). */
  const accessibleAsset = (assetId: number, memberId: number): AssetRow => {
    const asset = db
      .prepare(`SELECT ${ASSET_COLUMNS} FROM asset WHERE id = ?`)
      .get(assetId) as AssetRow | undefined;
    if (!asset || !libraryAccessibleBy(db, asset.library_id, memberId)) {
      throw new HttpError(404, "asset_not_found");
    }
    return asset;
  };

  /**
   * Resolve the Asset addressed by a route. Asset-scoped paths carry it in
   * :id; Library-scoped aliases carry the Library in :id and the Asset in
   * :assetId, and must not let an Asset from another Library slip through.
   */
  const targetAsset = (ctx: Ctx, memberId: number): AssetRow => {
    const assetId = Number(ctx.params.assetId ?? ctx.params.id);
    const asset = accessibleAsset(assetId, memberId);
    if (
      ctx.params.assetId !== undefined &&
      asset.library_id !== Number(ctx.params.id)
    ) {
      throw new HttpError(404, "asset_not_found");
    }
    return asset;
  };

  /** Permanently remove the row and unlink its original if unreferenced. */
  const purgeAsset = (asset: AssetRow): void => {
    db.prepare("DELETE FROM asset WHERE id = ?").run(asset.id);
    removeUnreferencedOriginals(db, [asset.storage_path]);
  };

  return {
    /**
     * GET /api/libraries/:id/deleted — the Library's recoverable Assets,
     * newest deletion first, so a Member can find one to restore or purge.
     */
    listDeleted(ctx: Ctx): void {
      const member = requireMember(ctx);
      const libraryId = Number(ctx.params.id);
      if (!libraryAccessibleBy(db, libraryId, member.id)) {
        throw new HttpError(404, "library_not_found");
      }
      const assets = db
        .prepare(
          `SELECT ${ASSET_COLUMNS} FROM asset
           WHERE library_id = ? AND deleted_at IS NOT NULL
           ORDER BY deleted_at DESC, id DESC`,
        )
        .all(libraryId) as unknown as AssetRow[];
      sendJson(ctx.res, 200, {
        assets: assets.map(publicAsset),
        deleted: assets.map(publicAsset),
        count: assets.length,
      });
    },

    /**
     * DELETE /api/assets/:id — move an Asset to the recoverable state. Requires
     * explicit confirmation; the Asset disappears from the Timeline but its
     * Rating, Album memberships and original stay intact until purged.
     */
    remove(ctx: Ctx): void {
      const member = requireMember(ctx);
      const asset = targetAsset(ctx, member.id);
      requireConfirmation(ctx);

      // A single request may also ask for permanent removal (e.g.
      // ?permanent=true); it still needs the same confirmation.
      if (truthy(firstValue(ctx.body, queryOf(ctx), PERMANENT_KEYS))) {
        purgeAsset(asset);
        sendJson(ctx.res, 200, {
          status: "ok",
          id: asset.id,
          deleted: true,
          purged: true,
          permanent: true,
        });
        return;
      }

      if (asset.deleted_at === null) {
        db.prepare("UPDATE asset SET deleted_at = ? WHERE id = ?").run(
          Date.now(),
          asset.id,
        );
      }
      sendJson(ctx.res, 200, publicAsset(accessibleAsset(asset.id, member.id)));
    },

    /**
     * POST /api/assets/:id/restore — bring a deleted Asset back. Its Rating and
     * Album memberships were never removed, so they reappear with it.
     */
    restore(ctx: Ctx): void {
      const member = requireMember(ctx);
      const asset = targetAsset(ctx, member.id);
      if (asset.deleted_at !== null) {
        db.prepare("UPDATE asset SET deleted_at = NULL WHERE id = ?").run(
          asset.id,
        );
      }
      sendJson(ctx.res, 200, publicAsset(accessibleAsset(asset.id, member.id)));
    },

    /**
     * DELETE /api/assets/:id/permanent — permanently remove an Asset. This is
     * a separate, confirmed step: it deletes the row (and memberships) and then
     * the original file, unless another Asset still references that content.
     */
    purge(ctx: Ctx): void {
      const member = requireMember(ctx);
      const asset = targetAsset(ctx, member.id);
      requireConfirmation(ctx);

      purgeAsset(asset);

      sendJson(ctx.res, 200, {
        status: "ok",
        id: asset.id,
        deleted: true,
        purged: true,
        permanent: true,
      });
    },
  };
}

export type Deletion = ReturnType<typeof createDeletion>;
