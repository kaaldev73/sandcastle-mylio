import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import type { Auth, Ctx } from "./auth.ts";
import type { Config } from "./config.ts";
import { dateRangeFromQuery, requireDate } from "./dates.ts";
import { readCaptureDate } from "./exif.ts";
import { HttpError, readJsonBody, readRawBody, sendJson } from "./http.ts";
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

/** Describe the uploaded file in an error, or fall back to a neutral phrase. */
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

  /** Record an upload key → Asset binding, so a retry resolves to the same
   * Asset. Only the first outcome for a key is kept (INSERT OR IGNORE): a
   * resumed Upload keeps its original result even if the retry differs. */
  const rememberSession = (
    libraryId: number,
    uploaderId: number,
    uploadKey: string,
    assetId: number,
  ): void => {
    if (uploadKey === "") return;
    db.prepare(
      `INSERT OR IGNORE INTO upload_session
         (library_id, uploader_id, upload_key, asset_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(libraryId, uploaderId, uploadKey, assetId, Date.now());
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
  ): Promise<{ created: boolean; resumed: boolean; asset: AssetRow }> => {
    // 1. Resume: a key we already served hands back its Asset as-is.
    if (input.uploadKey) {
      const prior = db
        .prepare(
          `SELECT ${JOINED_ASSET_COLUMNS}
             FROM upload_session us
             JOIN asset a ON a.id = us.asset_id
            WHERE us.library_id = ? AND us.uploader_id = ? AND us.upload_key = ?`,
        )
        .get(libraryId, member.id, input.uploadKey) as AssetRow | undefined;
      if (prior && prior.library_id === libraryId) {
        return { created: false, resumed: true, asset: prior };
      }
    }

    const type = detectImageType(input.bytes);
    if (!type) {
      throw new HttpError(
        415,
        "unsupported_type",
        `${describeFile(input.filename)} is not a supported image. ` +
          `Supported formats are ${SUPPORTED_FORMATS}.`,
      );
    }

    const contentHash = createHash("sha256").update(input.bytes).digest("hex");

    // Capture date: the file's own metadata wins; otherwise the file date the
    // client sent; otherwise the moment of upload. Never fail for want of a
    // date — the Timeline must still place every Asset.
    let captureDate = readCaptureDate(input.bytes);
    let captureSource: "exif" | "file" = "exif";
    if (captureDate === null) {
      captureSource = "file";
      captureDate = input.modifiedMs ?? now();
    }

    let thumbnail: Thumbnail;
    try {
      thumbnail = await makeThumbnail(input.bytes);
    } catch {
      throw new HttpError(
        415,
        "corrupt_image",
        `Could not generate a preview for ${describeFile(input.filename)}; ` +
          "the file appears to be corrupt or incomplete.",
      );
    }

    // 2. Idempotence without a key: identical bytes in the same Library are
    // the same Asset. Content-addressed storage already writes the original
    // once; returning the existing row keeps the grid free of doubles.
    const existing = db
      .prepare(
        `SELECT ${ASSET_COLUMNS} FROM asset
          WHERE library_id = ? AND content_hash = ? ORDER BY id LIMIT 1`,
      )
      .get(libraryId, contentHash) as AssetRow | undefined;
    if (existing) {
      rememberSession(libraryId, member.id, input.uploadKey ?? "", existing.id);
      return { created: false, resumed: false, asset: existing };
    }

    // Store the original untouched, content-addressed so identical bytes are
    // written once. Writing before the row keeps the DB from ever pointing at
    // a missing file.
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
        libraryId,
        member.id,
        input.filename ?? `upload${type.ext}`,
        type.mime,
        input.bytes.length,
        contentHash,
        captureDate,
        captureSource,
        storagePath,
        thumbnail.data,
        thumbnail.mime,
        now(),
      );

    const assetId = Number(info.lastInsertRowid);
    rememberSession(libraryId, member.id, input.uploadKey ?? "", assetId);
    return { created: true, resumed: false, asset: accessibleAsset(assetId, member.id) };
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
      if (!libraryAccessibleBy(db, libraryId, member.id)) {
        throw new HttpError(404, "library_not_found");
      }

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
      if (!libraryAccessibleBy(db, libraryId, member.id)) {
        throw new HttpError(404, "library_not_found");
      }

      // Raw route: the body is parsed here with a batch-sized limit rather
      // than the per-upload default.
      const body = await readJsonBody(ctx.req, config.UPLOAD_MAX_BYTES * 8);
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

      const results: {
        filename: string | null;
        status: "uploaded" | "duplicate" | "failed";
        asset?: Record<string, unknown>;
        error?: string;
        message?: string;
      }[] = [];

      for (const file of files as Record<string, unknown>[]) {
        const filename =
          typeof file.filename === "string" && file.filename.trim() !== ""
            ? file.filename.trim()
            : null;
        const modifiedMs =
          typeof file.modifiedMs === "number" &&
          Number.isFinite(file.modifiedMs) &&
          file.modifiedMs > 0
            ? file.modifiedMs
            : null;
        const uploadKey =
          typeof file.uploadKey === "string" && file.uploadKey.trim() !== ""
            ? file.uploadKey.trim()
            : null;

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
            message: http?.detail ?? undefined,
          });
        }
      }

      sendJson(ctx.res, 200, { results });
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
