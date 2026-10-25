import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import type { Auth, Ctx } from "./auth.ts";
import type { Config } from "./config.ts";
import { requireDate } from "./dates.ts";
import { readCaptureDate, readGpsLocation } from "./exif.ts";
import { HttpError, readJsonBody, readRawBody, sendJson } from "./http.ts";
import {
  detectImageType,
  makeThumbnail,
  type Thumbnail,
} from "./images.ts";
import { libraryAccessibleBy } from "./libraries.ts";
import {
  applyRatingChange,
  ratingChangeFromBody,
} from "./rating.ts";
import { parsePaging } from "./paging.ts";
import {
  assetInScope,
  assetScope,
  assetsBefore,
  assetsInScope,
  neighbouringAsset,
  scopeOrder,
  scopeWhere,
} from "./scope.ts";

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
  flag: "unflagged" | "pick" | "reject";
  stars: number;
  latitude: number | null;
  longitude: number | null;
}

/** Columns selected wherever an AssetRow is read, kept in sync in one place. */
export const ASSET_COLUMNS = `id, library_id, filename, mime_type, byte_size, content_hash,
         capture_date, date_override, capture_source, storage_path, thumbnail, thumbnail_mime,
         flag, stars, latitude, longitude`;

/**
 * ASSET_COLUMNS without the thumbnail blobs. Listing and navigation never
 * show the preview bytes (the thumbnail endpoint serves them), so a grid
 * sweep over thousands of Assets does not drag every blob out of SQLite.
 */
export const ASSET_COLUMNS_LIGHT = `id, library_id, filename, mime_type, byte_size, content_hash,
         capture_date, date_override, capture_source, storage_path,
         flag, stars, latitude, longitude`;

/** ASSET_COLUMNS prefixed for use in a join against an asset table aliased `a`. */
const JOINED_ASSET_COLUMNS = ASSET_COLUMNS.split(",")
  .map((c) => `a.${c.trim()}`)
  .join(", ");

/** The date an Asset sits at in the Timeline: a correction wins if present. */
export function effectiveDate(a: AssetRow): number {
  return a.date_override ?? a.capture_date;
}

/** Public, grid-ready shape of an Asset; storage details are never exposed. */
export function publicAsset(a: AssetRow): Record<string, unknown> {
  const rejected = a.flag === "reject";
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mime_type,
    byteSize: a.byte_size,
    contentHash: a.content_hash,
    captureDate: new Date(effectiveDate(a)).toISOString(),
    captureSource: a.capture_source,
    dateOverridden: a.date_override !== null,
    latitude: a.latitude,
    longitude: a.longitude,
    hasLocation: a.latitude !== null && a.longitude !== null,
    flag: a.flag,
    ratingFlag: a.flag,
    stars: a.stars,
    pick: a.flag === "pick",
    rejected,
    dimmed: rejected,
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

/**
 * Read the client's upload key, the handle that makes an Upload resumable:
 * a retry (or the client of an interrupted batch) sends the same key and gets
 * the Asset its earlier attempt already saved, with nothing doubled. Accepted
 * under X-Upload-Key or X-Upload-Id; absent means the keyless flow.
 */
function uploadKeyHeader(ctx: Ctx): string | null {
  const raw = header(ctx, "x-upload-key") ?? header(ctx, "x-upload-id");
  const key = raw?.trim() ?? "";
  return key !== "" ? key : null;
}

/** Formats the Upload endpoint accepts, for a human-readable rejection. */
const SUPPORTED_FORMATS =
  "JPEG, PNG, GIF, WebP, TIFF, HEIC/HEIF and common RAW formats";

/** Most files one batch Upload action may carry; larger sets send more than
 * one batch, each file still resumable through its own upload key. */
const BATCH_MAX_FILES = 100;

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

  // Location: when the photo carries GPS metadata, keep the extracted
  // coordinates as derived data; when it does not, the Asset simply stays
  // without a place and remains fully findable (PRD #13).
  const location = readGpsLocation(input.bytes);

  // Store the original untouched, content-addressed so identical bytes are
  // written once. Writing before the row keeps the DB from ever pointing at a
  // missing file.
  const storagePath = join(config.ORIGINALS_DIR, `${contentHash}${type.ext}`);
  if (!existsSync(storagePath)) writeFileSync(storagePath, input.bytes);

  const info = db
    .prepare(
      `INSERT INTO asset (library_id, uploader_id, filename, mime_type,
          byte_size, content_hash, capture_date, capture_source, storage_path,
          thumbnail, thumbnail_mime, latitude, longitude, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      location?.latitude ?? null,
      location?.longitude ?? null,
      Date.now(),
    );

  return db
    .prepare(`SELECT ${ASSET_COLUMNS} FROM asset WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as unknown as AssetRow;
}

/** A trimmed, non-empty string field on a batch entry, or null. */
function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A positive epoch-ms number field on a batch entry, or null. */
function optionalEpochMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/** One file's outcome within a batch Upload response. */
interface BatchResult {
  filename: string | null;
  status: "uploaded" | "duplicate" | "failed";
  asset?: Record<string, unknown>;
  error?: string;
  message?: string;
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

  /** A Library the Member may access, or throw 404 (never revealing why). */
  const requireLibrary = (libraryId: number, memberId: number): void => {
    if (!libraryAccessibleBy(db, libraryId, memberId)) {
      throw new HttpError(404, "library_not_found");
    }
  };

  /** Record an upload key → Asset binding, so a retry resolves to the same
   * Asset. Only the first outcome for a key is kept (INSERT OR IGNORE): a
   * resumed Upload keeps its original result even if the retry differs. */
  const rememberSession = (
    libraryId: number,
    uploaderId: number,
    uploadKey: string | null,
    assetId: number,
  ): void => {
    if (!uploadKey) return;
    db.prepare(
      `INSERT OR IGNORE INTO upload_session
         (library_id, uploader_id, upload_key, asset_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(libraryId, uploaderId, uploadKey, assetId, now());
  };

  /**
   * Store one file into a Library — the core of both the single Upload and the
   * batch action. Idempotent twice over: an upload key already bound to an
   * Asset returns that Asset untouched, and bytes already present in the
   * Library (matched by content hash) return the existing Asset rather than
   * saving a second one (PRD Upload: no half-saved or doubled Assets). The
   * Asset is resolved fully — original stored, thumbnail made, row inserted —
   * before any caller learns of it.
   */
  const storeAsset = async (
    member: { id: number },
    libraryId: number,
    input: {
      bytes: Buffer;
      filename: string | null;
      modifiedMs: number | null;
      uploadKey: string | null;
    },
  ): Promise<{ created: boolean; asset: AssetRow }> => {
    // 1. Resume: a key we already served hands back its Asset as-is. The
    // lookup is scoped to the Library and uploader, so a key never crosses
    // either boundary.
    if (input.uploadKey) {
      const prior = db
        .prepare(
          `SELECT ${JOINED_ASSET_COLUMNS}
             FROM upload_session us
             JOIN asset a ON a.id = us.asset_id
            WHERE us.library_id = ? AND us.uploader_id = ? AND us.upload_key = ?`,
        )
        .get(libraryId, member.id, input.uploadKey) as AssetRow | undefined;
      if (prior) {
        return { created: false, asset: prior };
      }
    }

    // 2. Idempotence without a key: identical bytes in the same Library are
    // the same Asset. Returning the existing row keeps the grid free of
    // doubles (PRD Upload: no half-saved or doubled Assets).
    const contentHash = createHash("sha256").update(input.bytes).digest("hex");
    const existing = db
      .prepare(
        `SELECT ${ASSET_COLUMNS} FROM asset
          WHERE library_id = ? AND content_hash = ? ORDER BY id LIMIT 1`,
      )
      .get(libraryId, contentHash) as AssetRow | undefined;
    if (existing) {
      rememberSession(libraryId, member.id, input.uploadKey, existing.id);
      return { created: false, asset: existing };
    }

    // 3. New file: the shared ingestion path keeps browser Upload and Server
    // Import in agreement (original stored, thumbnail made, row inserted).
    const asset = await ingestAsset(db, config, {
      libraryId,
      uploaderId: member.id,
      bytes: input.bytes,
      filename: input.filename,
      fileDateMs: input.modifiedMs,
    });
    rememberSession(libraryId, member.id, input.uploadKey, asset.id);
    return { created: true, asset };
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
     * raw image bytes; the original filename, the file's own date and the
     * resumable upload key ride in the X-Filename, X-File-Modified-Ms and
     * X-Upload-Key headers. The original is stored byte-for-byte, its content
     * hash recorded, a thumbnail generated, and the capture date read from the
     * file (EXIF), falling back to the file date. Retrying with the same key,
     * or re-uploading identical bytes, returns the existing Asset instead of a
     * double; a fresh upload answers 201, a repeat 200.
     */
    async upload(ctx: Ctx): Promise<void> {
      const member = requireMember(ctx);
      const libraryId = Number(ctx.params.id);
      requireLibrary(libraryId, member.id);

      const bytes = await readRawBody(ctx.req, config.UPLOAD_MAX_BYTES);
      const stored = await storeAsset(member, libraryId, {
        bytes,
        filename: clientFilename(ctx),
        modifiedMs: fileDateHeader(ctx),
        uploadKey: uploadKeyHeader(ctx),
      });
      sendJson(ctx.res, stored.created ? 201 : 200, publicAsset(stored.asset));
    },

    /**
     * POST /api/libraries/:id/assets/batch — Bulk Upload: many files in one
     * action with a per-file status, so a Member adding a whole holiday at
     * once sees exactly what made it in (PRD Upload). The JSON body carries
     * the files as base64; each is stored independently — a failure is
     * reported for that file alone and never aborts the rest. Files may carry
     * an upload key, so an interrupted batch can be rerun as-is: files that
     * already landed return their existing Assets (as "duplicate") and the
     * failed ones are simply retried.
     */
    async uploadBatch(ctx: Ctx): Promise<void> {
      const member = requireMember(ctx);
      const libraryId = Number(ctx.params.id);
      requireLibrary(libraryId, member.id);

      // Raw route: the body is parsed and size-capped here so one request can
      // carry a whole batch rather than a single upload's worth of bytes.
      const batchBodyLimit = config.UPLOAD_MAX_BYTES * 8;
      const body = await readJsonBody(ctx.req, batchBodyLimit);
      const files = body.files;
      if (!Array.isArray(files) || files.length === 0) {
        throw new HttpError(
          400,
          "invalid_batch",
          "Provide a non-empty 'files' array of { filename, modifiedMs, uploadKey, contentBase64 } entries.",
        );
      }
      if (files.length > BATCH_MAX_FILES) {
        throw new HttpError(
          400,
          "invalid_batch",
          `A batch holds at most ${BATCH_MAX_FILES} files; send the rest in another batch.`,
        );
      }

      const results: BatchResult[] = [];

      for (const file of files as Record<string, unknown>[]) {
        const filename = optionalString(file.filename);
        const modifiedMs = optionalEpochMs(file.modifiedMs);
        const uploadKey = optionalString(file.uploadKey);

        try {
          const decoded =
            typeof file.contentBase64 === "string"
              ? Buffer.from(file.contentBase64, "base64")
              : Buffer.alloc(0);
          if (decoded.length === 0) {
            throw new HttpError(
              415,
              "bad_file",
              `${describeFile(filename)} carried no decodable content.`,
            );
          }
          if (decoded.length > config.UPLOAD_MAX_BYTES) {
            throw new HttpError(413, "payload_too_large");
          }

          const stored = await storeAsset(member, libraryId, {
            bytes: decoded,
            filename,
            modifiedMs,
            uploadKey,
          });
          results.push({
            filename,
            status: stored.created ? "uploaded" : "duplicate",
            asset: publicAsset(stored.asset),
          });
        } catch (err) {
          // Per-file failure: report it and keep the batch going. Positive
          // failures become their status/code; anything unexpected defaults
          // to a plain internal error for that file only.
          const http = err instanceof HttpError ? err : undefined;
          results.push({
            filename,
            status: "failed",
            error: http?.code ?? "internal_error",
            message: http?.detail,
          });
        }
      }

      sendJson(ctx.res, 200, { results });
    },

    /**
     * GET /api/libraries/:id/assets — the Library's Assets as a grid, ordered
     * by capture date (PRD Timeline ordering), newest first (`order=oldest`
     * flips it). Optional from/to bounds (or start/end) limit the grid to a
     * date range and Rating selectors narrow it, matching Timeline. A phone
     * (or any client) pages with `limit` (per-page aliases work) plus
     * `offset`/`skip` or a 1-based `page`: a paged answer carries the total,
     * the window's offset and `hasMore`/`nextOffset` so the client can keep
     * walking a Library of thousands of Assets in bounded steps.
     */
    list(ctx: Ctx): void {
      const member = requireMember(ctx);
      const libraryId = Number(ctx.params.id);
      requireLibrary(libraryId, member.id);
      const url = new URL(ctx.req.url ?? "/", "http://familio.local");
      const scope = assetScope(libraryId, url);
      const where = scopeWhere(scope);
      const paging = parsePaging(url.searchParams);

      // A paged answer needs SQL LIMIT/OFFSET whenever a limit was asked for
      // or the window starts past the first row; SQLite reads a negative
      // LIMIT as "no limit", so an offset-only page skips without a cap.
      const paged = paging.limit !== null || paging.offset > 0;
      const limitSql = paged ? " LIMIT ? OFFSET ?" : "";
      const pagingParams = paged ? [paging.limit ?? -1, paging.offset] : [];

      const rows = db
        .prepare(
          `SELECT ${ASSET_COLUMNS_LIGHT} FROM asset WHERE ${where}
           ${scopeOrder(scope)}${limitSql}`,
        )
        .all(...scope.params, ...pagingParams) as unknown as AssetRow[];

      // Only a paginated request pays for the total count; an unpaged answer
      // holds everything anyway.
      const total = paged ? assetsInScope(db, scope) : rows.length;
      const morePages = paging.offset + rows.length < total;

      sendJson(ctx.res, 200, {
        assets: rows.map(publicAsset),
        total,
        count: rows.length,
        limit: paging.limit,
        offset: paging.offset,
        hasMore: morePages,
        nextOffset: morePages ? paging.offset + rows.length : null,
      });
    },

    /**
     * GET /api/libraries/:id/assets/:assetId/neighbors — the single-Asset
     * view: the Asset plus what sits immediately before and after it in the
     * view's ordering (capture date, corrections win), so a Member can flip
     * through photos full-screen without re-listing the grid. Accepts the
     * same date-range, Rating and order filters as the grid, under
     * `/neighbors` or `/neighbours`, Library named or not
     * (GET /api/assets/:id/neighbors). When the Asset itself is filtered out
     * of the view (e.g. hidden Rejected), it still anchors its neighbours and
     * carries no position.
     */
    neighbours(ctx: Ctx): void {
      const member = requireMember(ctx);
      const asset = accessibleAsset(Number(ctx.params.assetId), member.id);
      if (
        ctx.params.id !== undefined &&
        Number(ctx.params.id) !== asset.library_id
      ) {
        throw new HttpError(404, "asset_not_found");
      }

      const url = new URL(ctx.req.url ?? "/", "http://familio.local");
      const scope = assetScope(asset.library_id, url);
      const previous = neighbouringAsset(db, scope, asset, "previous");
      const next = neighbouringAsset(db, scope, asset, "next");
      const current = publicAsset(asset);
      const total = assetsInScope(db, scope);

      sendJson(ctx.res, 200, {
        asset: current,
        current,
        previous: previous === null ? null : publicAsset(previous),
        next: next === null ? null : publicAsset(next),
        position: assetInScope(db, scope, asset.id)
          ? assetsBefore(db, scope, asset) + 1
          : null,
        total,
        hasPrevious: previous !== null,
        hasNext: next !== null,
      });
    },

    /**
     * PATCH /api/assets/:id/date — correct an Asset's Timeline date. The
     * correction is stored separately from the derived capture date, and the
     * original file on disk is never rewritten (PRD Timeline).
     */
    updateDate(ctx: Ctx): void {
      applyDateCorrection(ctx);
    },

    /**
     * PATCH /api/assets/:id — update an Asset in place. Accepts a captureDate
     * correction and/or Rating fields, so a client can adjust either without
     * touching the original file.
     */
    update(ctx: Ctx): void {
      const member = requireMember(ctx);
      const asset = accessibleAsset(Number(ctx.params.id), member.id);
      const hasDate = ["date", "captureDate", "capture_date"].some((key) =>
        Object.prototype.hasOwnProperty.call(ctx.body, key),
      );
      if (hasDate) {
        const raw =
          ctx.body.date ?? ctx.body.captureDate ?? ctx.body.capture_date;
        const date = requireDate(raw);
        db.prepare("UPDATE asset SET date_override = ? WHERE id = ?").run(
          date,
          asset.id,
        );
      }
      const change = ratingChangeFromBody(ctx.body);
      applyRatingChange(db, asset.id, change);
      if (!hasDate && change.flag === undefined && change.stars === undefined) {
        throw new HttpError(400, "missing_update");
      }
      const updated = accessibleAsset(asset.id, member.id);
      sendJson(ctx.res, 200, publicAsset(updated));
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
