import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import type { Auth, Ctx } from "./auth.ts";
import type { Config } from "./config.ts";
import { dateRangeFromQuery, requireDate } from "./dates.ts";
import { readCaptureDate } from "./exif.ts";
import { HttpError, readRawBody, sendJson } from "./http.ts";
import {
  detectImageType,
  makeThumbnail,
  type Thumbnail,
} from "./images.ts";
import { libraryAccessibleBy } from "./libraries.ts";

export interface AssetRow {
  id: number;
  library_id: number;
  filename: string;
  mime_type: string;
  byte_size: number;
  content_hash: string;
  capture_date: number;
  date_override: number | null;
  capture_source: "exif" | "file";
  storage_path: string;
  thumbnail: Uint8Array;
  thumbnail_mime: string;
}

/** Columns selected wherever an AssetRow is read, kept in sync in one place. */
export const ASSET_COLUMNS = `id, library_id, filename, mime_type, byte_size, content_hash,
         capture_date, date_override, capture_source, storage_path, thumbnail, thumbnail_mime`;

/** The date an Asset sits at in the Timeline: a correction wins if present. */
export function effectiveDate(a: AssetRow): number {
  return a.date_override ?? a.capture_date;
}

/** Public, grid-ready shape of an Asset; storage details are never exposed. */
export function publicAsset(a: AssetRow): Record<string, unknown> {
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mime_type,
    byteSize: a.byte_size,
    contentHash: a.content_hash,
    captureDate: new Date(effectiveDate(a)).toISOString(),
    captureSource: a.capture_source,
    dateOverridden: a.date_override !== null,
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

/** Formats the Upload endpoint accepts, for a human-readable rejection. */
const SUPPORTED_FORMATS =
  "JPEG, PNG, GIF, WebP, TIFF, HEIC/HEIF and common RAW formats";

/** Describe a submitted file in an error, or fall back to a neutral phrase. */
function describeFile(name: string | null): string {
  return name === null ? "this file" : `"${name}"`;
}

export interface IngestInput {
  readonly libraryId: number;
  readonly uploaderId: number;
  readonly bytes: Buffer;
  /** Original filename; null falls back to a generated upload name. */
  readonly filename: string | null;
  /** File date fallback in epoch ms; null uses the moment of ingestion. */
  readonly fileDateMs: number | null;
}

/**
 * Store one image as an Asset in a Library. Shared by browser Upload and
 * Server Import so both paths agree: the original is kept byte-for-byte, its
 * content hash is recorded, a thumbnail is generated, and the capture date is
 * read from the file (EXIF), falling back to the file date. Throws
 * HttpError(415) for unsupported or corrupt images; callers decide whether
 * that is fatal or a per-file report.
 */
export async function ingestAsset(
  db: DatabaseSync,
  config: Config,
  input: IngestInput,
): Promise<AssetRow> {
  const submittedName =
    input.filename === null ? null : input.filename.trim() || null;
  const type = detectImageType(input.bytes);
  if (!type) {
    throw new HttpError(
      415,
      "unsupported_type",
      `${describeFile(submittedName)} is not a supported image. ` +
        `Supported formats are ${SUPPORTED_FORMATS}.`,
    );
  }

  const contentHash = createHash("sha256").update(input.bytes).digest("hex");

  // Capture date: the file's own metadata wins; otherwise the file date the
  // client sent; otherwise the moment of ingestion. Never fail for want of a
  // date — the Timeline must still place every Asset.
  let captureDate = readCaptureDate(input.bytes);
  let captureSource: "exif" | "file" = "exif";
  if (captureDate === null) {
    captureSource = "file";
    captureDate = input.fileDateMs ?? Date.now();
  }

  let thumbnail: Thumbnail;
  try {
    thumbnail = await makeThumbnail(input.bytes);
  } catch {
    throw new HttpError(
      415,
      "corrupt_image",
      `Could not generate a preview for ${describeFile(submittedName)}; ` +
        "the file appears to be corrupt or incomplete.",
    );
  }

  // Store the original untouched, content-addressed so identical bytes are
  // written once. Writing before the row keeps the DB from ever pointing at a
  // missing file.
  const storagePath = join(config.ORIGINALS_DIR, `${contentHash}${type.ext}`);
  if (!existsSync(storagePath)) writeFileSync(storagePath, input.bytes);

  const info = db
    .prepare(
      `INSERT INTO asset (library_id, uploader_id, filename, mime_type,
         byte_size, content_hash, capture_date, capture_source, storage_path,
         thumbnail, thumbnail_mime, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.libraryId,
      input.uploaderId,
      submittedName ?? `upload${type.ext}`,
      type.mime,
      input.bytes.length,
      contentHash,
      captureDate,
      captureSource,
      storagePath,
      thumbnail.data,
      thumbnail.mime,
      Date.now(),
    );

  return db
    .prepare(`SELECT ${ASSET_COLUMNS} FROM asset WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as unknown as AssetRow;
}

/**
 * Build the Assets API: Upload a photo into a Library, list a Library's Assets
 * as a grid, and download an Asset's thumbnail or untouched original. Every
 * request is access-checked server-side against the authenticated Member —
 * nobody can upload into or read another Member's private Library (ADR 0003).
 */
export function createAssets(db: DatabaseSync, auth: Auth, config: Config) {
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

  /** Apply a date correction shared by the two PATCH route aliases. */
  const applyDateCorrection = (ctx: Ctx): void => {
    const member = requireMember(ctx);
    const asset = accessibleAsset(Number(ctx.params.id), member.id);
    const raw =
      ctx.body.date ?? ctx.body.captureDate ?? ctx.body.capture_date;
    const date = requireDate(raw);
    db.prepare("UPDATE asset SET date_override = ? WHERE id = ?").run(
      date,
      asset.id,
    );
    const updated = accessibleAsset(asset.id, member.id);
    sendJson(ctx.res, 200, publicAsset(updated));
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
      const asset = await ingestAsset(db, config, {
        libraryId,
        uploaderId: member.id,
        bytes,
        filename: clientFilename(ctx),
        fileDateMs: fileDateHeader(ctx),
      });
      sendJson(ctx.res, 201, publicAsset(asset));
    },

    /**
     * GET /api/libraries/:id/assets — the Library's Assets as a grid, ordered
     * by capture date (PRD Timeline ordering), newest first. Optional from/to
     * bounds (or start/end) limit the grid to a date range, matching Timeline.
     */
    list(ctx: Ctx): void {
      const member = requireMember(ctx);
      const libraryId = Number(ctx.params.id);
      if (!libraryAccessibleBy(db, libraryId, member.id)) {
        throw new HttpError(404, "library_not_found");
      }
      const range = dateRangeFromQuery(
        new URL(ctx.req.url ?? "/", "http://familio.local"),
      );
      const clauses = ["library_id = ?"];
      const params: (number | string)[] = [libraryId];
      if (range.from !== null) {
        clauses.push("COALESCE(date_override, capture_date) >= ?");
        params.push(range.from);
      }
      if (range.to !== null) {
        clauses.push("COALESCE(date_override, capture_date) <= ?");
        params.push(range.to);
      }
      const assets = db
        .prepare(
          `SELECT ${ASSET_COLUMNS} FROM asset WHERE ${clauses.join(" AND ")}
           ORDER BY COALESCE(date_override, capture_date) DESC, id DESC`,
        )
        .all(...params) as unknown as AssetRow[];
      sendJson(ctx.res, 200, { assets: assets.map(publicAsset) });
    },

    /**
     * PATCH /api/assets/:id/date — correct an Asset's Timeline date. The
     * correction is stored separately from the derived capture date, and the
     * original file on disk is never rewritten (PRD Timeline).
     */
    updateDate(ctx: Ctx): void {
      applyDateCorrection(ctx);
    },

    /** PATCH /api/assets/:id — alias accepting a captureDate correction. */
    update(ctx: Ctx): void {
      applyDateCorrection(ctx);
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
