import type { DatabaseSync } from "node:sqlite";

import { ASSET_COLUMNS, publicAsset, type AssetRow } from "./assets.ts";
import type { Auth, Ctx } from "./auth.ts";
import { isConfirmed } from "./deletion.ts";
import { HttpError, sendJson } from "./http.ts";
import { libraryAccessibleBy } from "./libraries.ts";

/** Rank of a flag when merging Ratings: a Pick outranks a Reject. */
const FLAG_RANK = { unflagged: 0, reject: 1, pick: 2 } as const;

interface Candidate {
  asset: AssetRow;
  albums: number;
}

/** How much a Member has invested in a copy: the suggested keeper is the max. */
function keeperScore(c: Candidate): number[] {
  return [FLAG_RANK[c.asset.flag], c.asset.stars, c.albums, -c.asset.id];
}

function compareScores(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/**
 * Duplicates: find, review, resolve. A Duplicate is two Assets in the same
 * Library whose originals are byte-identical (GLOSSARY), so grouping is by
 * content hash only; similar images never match. Listing changes nothing.
 * Resolving needs explicit confirmation, keeps one Asset, merges Ratings and
 * Album memberships from the others into it, and sends the others to the
 * recoverable state (deleted_at), never straight to permanent removal.
 */
export function createDuplicates(db: DatabaseSync, auth: Auth) {
  const requireLibrary = (ctx: Ctx): number => {
    const member = auth.currentMember(ctx.cookies);
    if (!member) throw new HttpError(401, "unauthenticated");
    const libraryId = Number(ctx.params.id);
    if (!libraryAccessibleBy(db, libraryId, member.id)) {
      throw new HttpError(404, "library_not_found");
    }
    return libraryId;
  };

  /** Live Assets of the Library sharing a hash with at least one other. */
  const candidatesByHash = (libraryId: number): Map<string, Candidate[]> => {
    const rows = db
      .prepare(
        `SELECT ${ASSET_COLUMNS},
                (SELECT COUNT(*) FROM album_asset aa WHERE aa.asset_id = asset.id) AS albums
           FROM asset
          WHERE library_id = ? AND deleted_at IS NULL
            AND content_hash IN (
              SELECT content_hash FROM asset
               WHERE library_id = ? AND deleted_at IS NULL
               GROUP BY content_hash HAVING COUNT(*) > 1)
          ORDER BY id`,
      )
      .all(libraryId, libraryId) as unknown as (AssetRow & {
      albums: number;
    })[];
    const sets = new Map<string, Candidate[]>();
    for (const row of rows) {
      const list = sets.get(row.content_hash) ?? [];
      list.push({ asset: row, albums: row.albums });
      sets.set(row.content_hash, list);
    }
    return sets;
  };

  const findAsset = (id: number): AssetRow | undefined =>
    db.prepare(`SELECT ${ASSET_COLUMNS} FROM asset WHERE id = ?`).get(id) as
      | AssetRow
      | undefined;

  const suggest = (set: Candidate[]): Candidate =>
    set.reduce((best, c) =>
      compareScores(keeperScore(c), keeperScore(best)) > 0 ? c : best,
    );

  return {
    /** GET /api/libraries/:id/duplicates — sets of byte-identical Assets. */
    list(ctx: Ctx): void {
      const libraryId = requireLibrary(ctx);
      const sets = [...candidatesByHash(libraryId).entries()].map(
        ([contentHash, set]) => {
          const keeper = suggest(set);
          return {
            contentHash,
            suggestedKeeperId: keeper.asset.id,
            suggestedKeeper: publicAsset(keeper.asset),
            assets: set.map((c) => ({
              ...publicAsset(c.asset),
              albumCount: c.albums,
            })),
          };
        },
      );
      sendJson(ctx.res, 200, { sets, count: sets.length });
    },

    /**
     * POST /api/libraries/:id/duplicates/resolve — body {keeperId, confirm}.
     * Keeps `keeperId` and retires every other live Duplicate of it.
     */
    resolve(ctx: Ctx): void {
      const libraryId = requireLibrary(ctx);
      const keeperId = Number(ctx.body.keeperId ?? ctx.body.keepAssetId);
      if (!Number.isInteger(keeperId) || keeperId <= 0) {
        throw new HttpError(400, "missing_keeperId");
      }
      const keeper = findAsset(keeperId);
      if (
        !keeper ||
        keeper.library_id !== libraryId ||
        keeper.deleted_at !== null
      ) {
        throw new HttpError(404, "asset_not_found");
      }
      const set = candidatesByHash(libraryId).get(keeper.content_hash);
      if (!set) throw new HttpError(409, "not_duplicate");
      if (!isConfirmed(ctx)) throw new HttpError(400, "confirmation_required");

      const removed = set.map((c) => c.asset).filter((a) => a.id !== keeper.id);
      let flag = keeper.flag;
      let stars = keeper.stars;
      for (const a of removed) {
        if (FLAG_RANK[a.flag] > FLAG_RANK[flag]) flag = a.flag;
        stars = Math.max(stars, a.stars);
      }

      const now = Date.now();
      db.exec("BEGIN");
      try {
        db.prepare("UPDATE asset SET flag = ?, stars = ? WHERE id = ?").run(
          flag,
          stars,
          keeper.id,
        );
        const copyAlbums = db.prepare(
          `INSERT OR IGNORE INTO album_asset (album_id, asset_id, added_at)
           SELECT album_id, ?, added_at FROM album_asset WHERE asset_id = ?`,
        );
        const retire = db.prepare("UPDATE asset SET deleted_at = ? WHERE id = ?");
        for (const a of removed) {
          copyAlbums.run(keeper.id, a.id);
          retire.run(now, a.id);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }

      const kept = findAsset(keeper.id)!;
      sendJson(ctx.res, 200, {
        status: "ok",
        kept: publicAsset(kept),
        removed: removed.map((a) => ({ id: a.id, deleted: true })),
        removedCount: removed.length,
      });
    },
  };
}

export type Duplicates = ReturnType<typeof createDuplicates>;
