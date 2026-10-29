import type { DatabaseSync } from "node:sqlite";

import type { Auth, Ctx } from "./auth.ts";
import { HttpError, sendJson } from "./http.ts";
import { ASSET_COLUMNS, publicAsset, type AssetRow } from "./assets.ts";
import { libraryAccessibleBy, type LibraryRow } from "./libraries.ts";

/**
 * The modes of sharing (PRD #12): a Member can move or copy an Asset from
 * their private Library into the Family Library. The mode is always spelled
 * out in the request and echoed back in the answer, so what happened to the
 * photo is never ambiguous.
 */
type ShareMode = "move" | "copy";

const MODES: readonly ShareMode[] = ["move", "copy"];

/** What the share endpoint reports back: the action taken and where. */
interface ShareAnswer {
  action: "moved" | "copied";
  shared: true;
  sharedTo: { id: number; kind: string };
  asset: Record<string, unknown>;
}

/**
 * Read the requested mode from the body. Missing or unrecognised values are a
 * 400 sharing the valid spellings, so a client is never left guessing why
 * nothing was shared.
 */
function readMode(body: Record<string, unknown>): ShareMode {
  const raw = [body.mode, body.action, body.verb].find(
    (v) => typeof v === "string" && v.trim() !== "",
  );
  const mode = typeof raw === "string" ? raw.trim().toLowerCase() : null;
  if (mode === null || !MODES.includes(mode as ShareMode)) {
    throw new HttpError(
      400,
      "invalid_share",
      `Provide a "mode" of "move" or "copy" (got ${raw === undefined ? "none" : JSON.stringify(raw)}).`,
    );
  }
  return mode as ShareMode;
}

/**
 * Share to the Family Library (PRD #12, ADR 0003): the owner of a private
 * Library can move or copy one of its Assets into the Family Library, where
 * every Member sees it. Sharing anything else — another Member's private
 * Asset, or an Asset already in the Family Library — is refused.
 */
export function createShare(db: DatabaseSync, auth: Auth) {
  /** The single Family Library every Member shares (seeded on first boot). */
  const familyLibrary = (): LibraryRow => {
    const lib = db
      .prepare("SELECT id, kind, owner_id FROM library WHERE kind = 'family'")
      .get() as LibraryRow | undefined;
    if (!lib) throw new HttpError(500, "family_library_missing");
    return lib;
  };

  const sharedAnswer = (
    action: ShareAnswer["action"],
    family: LibraryRow,
    asset: AssetRow,
  ): ShareAnswer => ({
    action,
    shared: true,
    sharedTo: { id: family.id, kind: family.kind },
    asset: publicAsset(asset),
  });

  const shareAsset = (ctx: Ctx, forcedMode: ShareMode | null): void => {
    const member = auth.currentMember(ctx.cookies);
    if (!member) throw new HttpError(401, "unauthenticated");

    const mode = forcedMode === null ? readMode(ctx.body) : forcedMode;
    if (
      forcedMode !== null &&
      typeof ctx.body.mode === "string" &&
      ctx.body.mode.trim().toLowerCase() !== forcedMode
    ) {
      throw new HttpError(
        400,
        "invalid_share",
        `This URL performs "${forcedMode}"; drop the conflicting "mode" from the body, or use /api/assets/:id/share to name the mode there.`,
      );
    }

    const asset = db
      .prepare(`SELECT ${ASSET_COLUMNS} FROM asset WHERE id = ?`)
      .get(Number(ctx.params.id)) as AssetRow | undefined;
    const lib =
      asset === undefined
        ? null
        : libraryAccessibleBy(db, asset.library_id, member.id);
    if (!asset || !lib) throw new HttpError(404, "asset_not_found");

    // Only an Asset in the Member's own private Library can be shared
    // (ADR 0003). One already in the Family Library is shared once and
    // cannot be shared again; the answer is the same 409 for anyone who
    // tampers, without revealing who uploaded it.
    if (lib.kind === "family") {
      throw new HttpError(
        409,
        "already_shared",
        "This Asset already belongs to the Family Library.",
      );
    }
    if (lib.owner_id !== member.id) {
      throw new HttpError(
        403,
        "forbidden",
        "Only the Asset's owner can share it.",
      );
    }

    const family = familyLibrary();

    if (mode === "move") {
      // Move: the Asset changes Library. Ratings and the date correction
      // travel with it — it is the same Asset, rehomed; the original file
      // on disk is never rewritten.
      db.prepare("UPDATE asset SET library_id = ? WHERE id = ?").run(
        family.id,
        asset.id,
      );
      sendJson(ctx.res, 200, sharedAnswer("moved", family, asset));
      return;
    }

    // Copy: a second Asset in the Family Library pointing at the same
    // original on disk (content-addressed storage, so the bytes are stored
    // once) with the derived thumbnail, dates and location carried over.
    // Ratings do not travel: the Family copy starts unjudged. Retrying with
    // identical bytes resolves to the Asset already in the Family Library,
    // the same idempotence an Upload enjoys (never a doubted double).
    const existing = db
      .prepare(
        `SELECT ${ASSET_COLUMNS} FROM asset
          WHERE library_id = ? AND content_hash = ? ORDER BY id LIMIT 1`,
      )
      .get(family.id, asset.content_hash) as AssetRow | undefined;
    if (existing) {
      sendJson(ctx.res, 200, sharedAnswer("copied", family, existing));
      return;
    }

    const info = db
      .prepare(
        `INSERT INTO asset (library_id, uploader_id, filename, mime_type,
            byte_size, content_hash, capture_date, capture_source,
            storage_path, thumbnail, thumbnail_mime, date_override,
            latitude, longitude, created_at)
         SELECT ?, ?, filename, mime_type, byte_size, content_hash,
            capture_date, capture_source, storage_path, thumbnail,
            thumbnail_mime, date_override, latitude, longitude, ?
           FROM asset WHERE id = ?`,
      )
      .run(family.id, member.id, Date.now(), asset.id);
    const copy = db
      .prepare(`SELECT ${ASSET_COLUMNS} FROM asset WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as unknown as AssetRow;
    sendJson(ctx.res, 201, sharedAnswer("copied", family, copy));
  };

  return {
    /**
     * POST /api/assets/:id/share — share one of the caller's private Assets
     * into the Family Library. Body {"mode": "move"} rehomes the Asset;
     * {"mode": "copy"} adds a Family copy and leaves the private one. The
     * answer labels what happened (`action: "moved" | "copied"`) and names
     * the Library it landed in.
     */
    share(ctx: Ctx): void {
      shareAsset(ctx, null);
    },

    /** POST /api/assets/:id/share/move — move, stated in the URL. */
    move(ctx: Ctx): void {
      shareAsset(ctx, "move");
    },

    /** POST /api/assets/:id/share/copy — copy, stated in the URL. */
    copy(ctx: Ctx): void {
      shareAsset(ctx, "copy");
    },
  };
}

export type Share = ReturnType<typeof createShare>;
