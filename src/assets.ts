import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import type { Auth, Ctx } from "./auth.ts";
import type { Config } from "./config.ts";
import { readCaptureDate } from "./exif.ts";
import { HttpError, readRawBody, sendJson } from "./http.ts";
import {
  detectImageType,
  makeThumbnail,
  type Thumbnail,
} from "./images.ts";
import { libraryAccessibleBy } from "./libraries.ts";

interface AssetRow {
  id: number;
  library_id: number;
  filename: string;
  mime_type: string;
  byte_size: number;
  content_hash: string;
  capture_date: number;
  capture_source: "exif" | "file";
  storage_path: string;
  thumbnail: Uint8Array;
  thumbnail_mime: string;
}

/** Columns selected wherever an AssetRow is read, kept in sync in one place. */
const ASSET_COLUMNS = `id, library_id, filename, mime_type, byte_size, content_hash,
         capture_date, capture_source, storage_path, thumbnail, thumbnail_mime`;

/** Public, grid-ready shape of an Asset; storage details are never exposed. */
function publicAsset(a: AssetRow): Record<string, unknown> {
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mime_type,
    byteSize: a.byte_size,
    contentHash: a.content_hash,
    captureDate: new Date(a.capture_date).toISOString(),
    captureSource: a.capture_source,
    thumbnailUrl: `/api/assets/${a.id}/thumbnail`,
    originalUrl: `/api/assets/${a.id}/original`,
  };
}

/** Read a single request header value, collapsing the array form Node may give. */
function header(ctx: Ctx, name: string): string | undefined {
  const raw = ctx.req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Read an optional epoch-ms "file date" the client sends for its upload. */
function fileDateHeader(ctx: Ctx): number | null {
  const value = header(ctx, "x-file-modified-ms");
  if (!value) return null;
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Read the client-supplied original filename, or null when none was sent. */
function clientFilename(ctx: Ctx): string | null {
  const name = header(ctx, "x-filename")?.trim() ?? "";
  return name !== "" ? name : null;
}

/** Read the client-supplied original filename, falling back to a safe default. */
function filenameHeader(ctx: Ctx, ext: string): string {
  return clientFilename(ctx) ?? `upload${ext}`;
}

/** Formats the Upload endpoint accepts, for a human-readable rejection. */
const SUPPORTED_FORMATS =
  "JPEG, PNG, GIF, WebP, TIFF, HEIC/HEIF and common RAW formats";

/** Name a file in an error message without leaking anything or being vague. */
function describeFile(name: string | null): string {
  return name === null ? "this file" : `"${name}"`;
}

/**
 * Build the Assets API: Upload a photo into a Library, list a Library's Assets
 * as a grid, and download an Asset's thumbnail or untouched original. Every
 * request is access-checked server-side against the authenticated Member —
 * nobody can upload into or read another Member's private Library (ADR 0003).
 */
export function createAssets(db: DatabaseSync, auth: Auth, config: Config) {
  const now = () => Date.now();

  /** Resolve the current Member or throw 401. */
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

  return {
    /**
     * POST /api/libraries/:id/assets — Upload a photo. The request body is the
     * raw image bytes; the original filename and the file's own date ride in
     * the X-Filename and X-File-Modified-Ms headers. The original is stored
     * byte-for-byte, its content hash recorded, a thumbnail generated, and the
     * capture date read from the file (EXIF), falling back to the file date.
     */
    async upload(ctx: Ctx): Promise<void> {
      const member = requireMember(ctx);
      const libraryId = Number(ctx.params.id);
      if (!libraryAccessibleBy(db, libraryId, member.id)) {
        throw new HttpError(404, "library_not_found");
      }

      const bytes = await readRawBody(ctx.req, config.UPLOAD_MAX_BYTES);
      const submittedName = clientFilename(ctx);
      const type = detectImageType(bytes);
      if (!type) {
        throw new HttpError(
          415,
          "unsupported_type",
          `${describeFile(submittedName)} is not a supported image. ` +
            `Supported formats are ${SUPPORTED_FORMATS}.`,
        );
      }

      const contentHash = createHash("sha256").update(bytes).digest("hex");

      // Capture date: the file's own metadata wins; otherwise the file date the
      // client sent; otherwise the moment of upload. Never fail for want of a
      // date — the Timeline must still place every Asset.
      let captureDate = readCaptureDate(bytes);
      let captureSource: "exif" | "file" = "exif";
      if (captureDate === null) {
        captureSource = "file";
        captureDate = fileDateHeader(ctx) ?? now();
      }

      let thumbnail: Thumbnail;
      try {
        thumbnail = await makeThumbnail(bytes);
      } catch {
        throw new HttpError(
          415,
          "corrupt_image",
          `Could not generate a preview for ${describeFile(submittedName)}; ` +
            "the file appears to be corrupt or incomplete.",
        );
      }

      // Store the original untouched, content-addressed so identical bytes are
      // written once. Writing before the row keeps the DB from ever pointing at
      // a missing file.
      const storagePath = join(config.ORIGINALS_DIR, `${contentHash}${type.ext}`);
      if (!existsSync(storagePath)) writeFileSync(storagePath, bytes);

      const info = db
        .prepare(
          `INSERT INTO asset (library_id, uploader_id, filename, mime_type,
             byte_size, content_hash, capture_date, capture_source, storage_path,
             thumbnail, thumbnail_mime, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          libraryId,
          member.id,
          filenameHeader(ctx, type.ext),
          type.mime,
          bytes.length,
          contentHash,
          captureDate,
          captureSource,
          storagePath,
          thumbnail.data,
          thumbnail.mime,
          now(),
        );

      const asset = accessibleAsset(Number(info.lastInsertRowid), member.id);
      sendJson(ctx.res, 201, publicAsset(asset));
    },

    /**
     * GET /api/libraries/:id/assets — the Library's Assets as a grid, ordered
     * by capture date (PRD Timeline ordering), newest first.
     */
    list(ctx: Ctx): void {
      const member = requireMember(ctx);
      const libraryId = Number(ctx.params.id);
      if (!libraryAccessibleBy(db, libraryId, member.id)) {
        throw new HttpError(404, "library_not_found");
      }
      const assets = db
        .prepare(
          `SELECT ${ASSET_COLUMNS} FROM asset WHERE library_id = ?
           ORDER BY capture_date DESC, id DESC`,
        )
        .all(libraryId) as unknown as AssetRow[];
      sendJson(ctx.res, 200, { assets: assets.map(publicAsset) });
    },

    /** GET /api/assets/:id/thumbnail — the generated thumbnail image. */
    thumbnail(ctx: Ctx): void {
      const member = requireMember(ctx);
      const asset = accessibleAsset(Number(ctx.params.id), member.id);
      const body = Buffer.from(asset.thumbnail);
      ctx.res.writeHead(200, {
        "content-type": asset.thumbnail_mime,
        "content-length": body.length,
      });
      ctx.res.end(body);
    },

    /**
     * GET /api/assets/:id/original — the untouched original, byte-for-byte as
     * uploaded, offered as a download.
     */
    original(ctx: Ctx): void {
      const member = requireMember(ctx);
      const asset = accessibleAsset(Number(ctx.params.id), member.id);
      const body = readFileSync(asset.storage_path);
      ctx.res.writeHead(200, {
        "content-type": asset.mime_type,
        "content-length": body.length,
        "content-disposition": `attachment; filename="${asset.filename.replace(/"/g, "")}"`,
      });
      ctx.res.end(body);
    },
  };
}

export type Assets = ReturnType<typeof createAssets>;
