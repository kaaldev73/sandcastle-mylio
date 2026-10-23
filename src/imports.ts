import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  type Dirent,
} from "node:fs";
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type { DatabaseSync } from "node:sqlite";

import { ingestAsset, publicAsset, type AssetRow } from "./assets.ts";
import type { Auth, Ctx } from "./auth.ts";
import type { Config } from "./config.ts";
import { firstValue, HttpError, sendJson } from "./http.ts";
import { libraryAccessibleBy } from "./libraries.ts";

const LIBRARY_KEYS = [
  "libraryId",
  "library_id",
  "library",
  "targetLibrary",
  "target_library",
  "targetLibraryId",
  "target_library_id",
] as const;

const PATH_KEYS = [
  "path",
  "folder",
  "source",
  "directory",
  "importPath",
  "import_path",
  "sourcePath",
  "source_path",
  "subfolder",
  "subFolder",
  "sub_folder",
] as const;

interface SkippedFile {
  path: string;
  assetId: number;
  reason: "already_imported";
}

interface ProblemFile {
  path: string;
  reason: string;
}

interface SourceFile {
  /** Path relative to the configured import folder, always with "/". */
  path: string;
  absolutePath: string;
}

function parseLibraryId(ctx: Ctx, query: URLSearchParams): number {
  const raw = ctx.params.id ?? firstValue(ctx.body, query, LIBRARY_KEYS);
  const id = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, "missing_library");
  }
  return id;
}

/** Render a filesystem path with "/" separators, stable across platforms. */
function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

/**
 * List regular files below a folder, skipping symlinks and other specials. A
 * folder that cannot be read is reported and the walk continues, so one bad
 * directory never aborts the whole import.
 */
function listFiles(
  root: string,
  failed: ProblemFile[],
  dir = root,
): SourceFile[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    failed.push({
      path: dir === root ? "." : toPosixPath(relative(root, dir)),
      reason: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const files: SourceFile[] = [];
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, failed, absolutePath));
    } else if (entry.isFile()) {
      files.push({
        path: toPosixPath(relative(root, absolutePath)),
        absolutePath,
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Build the Server Import API. An Admin brings photos from a folder already on
 * the server into a chosen Library. It shares ingestion with Upload, so the
 * original is kept byte-for-byte and dates are read the same way. Each source
 * path is recorded per Library: re-running the same import skips files already
 * brought in. Unsupported and unreadable files are reported per file and never
 * abort the run.
 */
export function createImports(db: DatabaseSync, auth: Auth, config: Config) {
  const requireAdmin = (ctx: Ctx) => {
    const member = auth.currentMember(ctx.cookies);
    if (!member) throw new HttpError(401, "unauthenticated");
    if (member.role !== "admin") throw new HttpError(403, "forbidden");
    return member;
  };

  /** Resolve the folder to read, confined to the configured import root. */
  const resolveSource = (
    ctx: Ctx,
    query: URLSearchParams,
  ): { root: string; folder: string; label: string } => {
    if (!config.SERVER_IMPORT_DIR) {
      throw new HttpError(409, "import_not_configured");
    }
    const root = resolve(config.SERVER_IMPORT_DIR);
    const requested = firstValue(ctx.body, query, PATH_KEYS);
    if (requested !== undefined && typeof requested !== "string") {
      throw new HttpError(400, "invalid_import_path");
    }
    const folder =
      typeof requested === "string" && requested.trim() !== ""
        ? resolve(root, requested.trim())
        : root;
    const inside = relative(root, folder);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new HttpError(400, "invalid_import_path");
    }
    if (!existsSync(folder) || !statSync(folder).isDirectory()) {
      throw new HttpError(404, "import_folder_not_found");
    }
    return {
      root,
      folder,
      label: inside === "" ? "." : toPosixPath(inside),
    };
  };

  return {
    /**
     * POST /api/libraries/:id/import — import the configured folder into the
     * chosen Library. Also available as POST /api/admin/import with the
     * Library id in the body. Admin only. Returns counts, imported Assets and
     * per-file skipped/unsupported/failed reports.
     */
    async run(ctx: Ctx): Promise<void> {
      const admin = requireAdmin(ctx);
      const query = new URL(ctx.req.url ?? "/", "http://familio.local")
        .searchParams;
      const libraryId = parseLibraryId(ctx, query);
      if (!libraryAccessibleBy(db, libraryId, admin.id)) {
        throw new HttpError(404, "library_not_found");
      }
      const { root, folder, label } = resolveSource(ctx, query);

      const imported: AssetRow[] = [];
      const skipped: SkippedFile[] = [];
      const unsupported: ProblemFile[] = [];
      const failed: ProblemFile[] = [];
      const files = listFiles(root, failed, folder);

      const alreadyImported = db.prepare(
        `SELECT asset_id FROM server_import_file
         WHERE library_id = ? AND source_path = ?`,
      );
      const recordImported = db.prepare(
        `INSERT INTO server_import_file
           (library_id, source_path, content_hash, asset_id, imported_at)
         VALUES (?, ?, ?, ?, ?)`,
      );

      for (const file of files) {
        const existing = alreadyImported.get(libraryId, file.path) as
          | { asset_id: number }
          | undefined;
        if (existing) {
          skipped.push({
            path: file.path,
            assetId: existing.asset_id,
            reason: "already_imported",
          });
          continue;
        }

        let bytes: Buffer;
        let fileDateMs: number | null;
        try {
          bytes = readFileSync(file.absolutePath);
          fileDateMs = statSync(file.absolutePath).mtimeMs;
        } catch (err) {
          failed.push({
            path: file.path,
            reason: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        try {
          const asset = await ingestAsset(db, config, {
            libraryId,
            uploaderId: admin.id,
            bytes,
            filename: basename(file.absolutePath),
            fileDateMs,
          });
          recordImported.run(
            libraryId,
            file.path,
            asset.content_hash,
            asset.id,
            Date.now(),
          );
          imported.push(asset);
        } catch (err) {
          if (!(err instanceof HttpError) || err.status !== 415) throw err;
          const problem = { path: file.path, reason: err.detail ?? err.code };
          if (err.code === "unsupported_type") unsupported.push(problem);
          else failed.push(problem);
        }
      }

      const assets = imported.map(publicAsset);
      const counts = {
        imported: imported.length,
        skipped: skipped.length,
        unsupported: unsupported.length,
        failed: failed.length,
      };
      sendJson(ctx.res, 200, {
        status: "ok",
        libraryId,
        source: label,
        ...counts,
        importedCount: counts.imported,
        skippedCount: counts.skipped,
        unsupportedCount: counts.unsupported,
        failedCount: counts.failed,
        assets,
        importedAssets: assets,
        skippedFiles: skipped,
        unsupportedFiles: unsupported,
        failedFiles: failed,
      });
    },
  };
}

export type Imports = ReturnType<typeof createImports>;
