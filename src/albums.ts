import type { DatabaseSync } from "node:sqlite";

import { ASSET_COLUMNS, type AssetRow, publicAsset } from "./assets.ts";
import type { Auth, Ctx } from "./auth.ts";
import { HttpError, requireString, sendJson } from "./http.ts";
import { libraryAccessibleBy } from "./libraries.ts";

interface AlbumRow {
  id: number;
  library_id: number;
  name: string;
}

interface AlbumListRow extends AlbumRow {
  asset_count: number;
}

/** Summary shape of an Album for listings; its Library id is safe to expose. */
function publicAlbum(a: AlbumRow, assetCount: number): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    libraryId: a.library_id,
    assetCount,
  };
}

/**
 * Build the Albums API: a Member creates, renames and deletes Albums inside a
 * Library they can access, and adds or removes Assets without ever copying or
 * deleting the underlying files (GLOSSARY, PRD Albums). An Album is a virtual
 * grouping — membership is a join row, so one Asset can live in many Albums and
 * deleting an Album leaves every Asset in the Library. Access is enforced
 * server-side on every request against the authenticated Member (ADR 0003):
 * reaching an Album means reaching its Library.
 */
export function createAlbums(db: DatabaseSync, auth: Auth) {
  const now = () => Date.now();

  const requireMember = (ctx: Ctx) => {
    const member = auth.currentMember(ctx.cookies);
    if (!member) throw new HttpError(401, "unauthenticated");
    return member;
  };

  /** Resolve a Library the Member may access, or throw 404. */
  const requireLibrary = (libraryId: number, memberId: number): void => {
    if (!libraryAccessibleBy(db, libraryId, memberId)) {
      throw new HttpError(404, "library_not_found");
    }
  };

  /** Fetch an Album whose Library the Member may access, or throw 404. */
  const accessibleAlbum = (albumId: number, memberId: number): AlbumRow => {
    const album = db
      .prepare("SELECT id, library_id, name FROM album WHERE id = ?")
      .get(albumId) as AlbumRow | undefined;
    if (!album || !libraryAccessibleBy(db, album.library_id, memberId)) {
      throw new HttpError(404, "album_not_found");
    }
    return album;
  };

  /** Read an Asset id from the body, accepting a JSON number or numeric string. */
  const requireAssetId = (body: Record<string, unknown>): number => {
    const raw = body.assetId;
    let id = NaN;
    if (typeof raw === "number") {
      id = raw;
    } else if (typeof raw === "string" && raw.trim() !== "") {
      id = Number(raw);
    }
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError(400, "missing_assetId");
    }
    return id;
  };

  /** The Album with its Assets, ordered like the grid (newest capture first). */
  const albumWithAssets = (album: AlbumRow): Record<string, unknown> => {
    const assets = db
      .prepare(
        `SELECT ${ASSET_COLUMNS} FROM asset
         WHERE deleted_at IS NULL
           AND id IN (SELECT asset_id FROM album_asset WHERE album_id = ?)
         ORDER BY COALESCE(date_override, capture_date) DESC, id DESC`,
      )
      .all(album.id) as unknown as AssetRow[];
    return {
      ...publicAlbum(album, assets.length),
      assets: assets.map(publicAsset),
    };
  };

  return {
    /** POST /api/libraries/:id/albums — create an Album in the Library. */
    create(ctx: Ctx): void {
      const member = requireMember(ctx);
      const libraryId = Number(ctx.params.id);
      requireLibrary(libraryId, member.id);

      const name = requireString(ctx.body, "name").trim();
      const info = db
        .prepare(
          "INSERT INTO album (library_id, name, created_at) VALUES (?, ?, ?)",
        )
        .run(libraryId, name, now());
      const album = accessibleAlbum(Number(info.lastInsertRowid), member.id);
      sendJson(ctx.res, 201, albumWithAssets(album));
    },

    /** GET /api/libraries/:id/albums — the Library's Albums. */
    list(ctx: Ctx): void {
      const member = requireMember(ctx);
      const libraryId = Number(ctx.params.id);
      requireLibrary(libraryId, member.id);

      const albums = db
        .prepare(
          `SELECT a.id, a.library_id, a.name,
                  COUNT(CASE WHEN asset.deleted_at IS NULL THEN aa.asset_id END)
                    AS asset_count
           FROM album a
           LEFT JOIN album_asset aa ON aa.album_id = a.id
           LEFT JOIN asset ON asset.id = aa.asset_id
           WHERE a.library_id = ?
           GROUP BY a.id
           ORDER BY a.id`,
        )
        .all(libraryId) as unknown as AlbumListRow[];
      sendJson(ctx.res, 200, {
        albums: albums.map((a) => publicAlbum(a, a.asset_count)),
      });
    },

    /** GET /api/albums/:id — open an Album and list its Assets. */
    get(ctx: Ctx): void {
      const member = requireMember(ctx);
      const album = accessibleAlbum(Number(ctx.params.id), member.id);
      sendJson(ctx.res, 200, albumWithAssets(album));
    },

    /** PATCH /api/albums/:id — rename an Album; its Assets are untouched. */
    rename(ctx: Ctx): void {
      const member = requireMember(ctx);
      const album = accessibleAlbum(Number(ctx.params.id), member.id);
      const name = requireString(ctx.body, "name").trim();
      db.prepare("UPDATE album SET name = ? WHERE id = ?").run(name, album.id);
      sendJson(ctx.res, 200, albumWithAssets({ ...album, name }));
    },

    /**
     * DELETE /api/albums/:id — delete an Album. Only its membership rows
     * cascade away; every Asset remains in the Library (PRD Albums).
     */
    remove(ctx: Ctx): void {
      const member = requireMember(ctx);
      const album = accessibleAlbum(Number(ctx.params.id), member.id);
      db.prepare("DELETE FROM album WHERE id = ?").run(album.id);
      ctx.res.writeHead(204).end();
    },

    /**
     * POST /api/albums/:id/assets — add an Asset to the Album. The Asset must
     * live in the Album's own Library; nothing is copied. Adding an Asset
     * already present is a no-op, so a retried request cannot double it up.
     */
    addAsset(ctx: Ctx): void {
      const member = requireMember(ctx);
      const album = accessibleAlbum(Number(ctx.params.id), member.id);

      const assetId = requireAssetId(ctx.body);
      const asset = db
        .prepare(
          "SELECT 1 FROM asset WHERE id = ? AND library_id = ? AND deleted_at IS NULL",
        )
        .get(assetId, album.library_id);
      if (!asset) throw new HttpError(404, "asset_not_found");

      db.prepare(
        `INSERT INTO album_asset (album_id, asset_id, added_at) VALUES (?, ?, ?)
         ON CONFLICT (album_id, asset_id) DO NOTHING`,
      ).run(album.id, assetId, now());
      sendJson(ctx.res, 200, albumWithAssets(album));
    },

    /**
     * DELETE /api/albums/:id/assets/:assetId — remove an Asset from the Album.
     * Only the membership is dropped; the Asset's file is never deleted and it
     * stays in the Library (PRD Albums).
     */
    removeAsset(ctx: Ctx): void {
      const member = requireMember(ctx);
      const album = accessibleAlbum(Number(ctx.params.id), member.id);
      db.prepare(
        "DELETE FROM album_asset WHERE album_id = ? AND asset_id = ?",
      ).run(album.id, Number(ctx.params.assetId));
      sendJson(ctx.res, 200, albumWithAssets(album));
    },
  };
}

export type Albums = ReturnType<typeof createAlbums>;
