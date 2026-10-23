import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { backup as sqliteBackup, type DatabaseSync } from "node:sqlite";

import type { Auth, Ctx } from "./auth.ts";
import type { Config } from "./config.ts";
import { HttpError, sendJson } from "./http.ts";
import { createS3Client, type S3Client } from "./s3.ts";

export interface BackupSettings {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly prefix: string;
}

/** Join key segments, trimming stray slashes from the configured prefix. */
export function backupKey(...parts: string[]): string {
  return parts
    .flatMap((part) => part.split("/"))
    .filter((part) => part !== "")
    .join("/");
}

/** Backup settings from config, or null when no backup storage is configured. */
export function backupSettings(config: Config): BackupSettings | null {
  if (
    !config.BACKUP_S3_ENDPOINT ||
    !config.BACKUP_S3_BUCKET ||
    !config.BACKUP_S3_ACCESS_KEY_ID ||
    !config.BACKUP_S3_SECRET_ACCESS_KEY
  ) {
    return null;
  }
  return {
    endpoint: config.BACKUP_S3_ENDPOINT,
    bucket: config.BACKUP_S3_BUCKET,
    region: config.BACKUP_S3_REGION,
    accessKeyId: config.BACKUP_S3_ACCESS_KEY_ID,
    secretAccessKey: config.BACKUP_S3_SECRET_ACCESS_KEY,
    prefix: config.BACKUP_S3_PREFIX,
  };
}

/** One uploaded original, referenced by the manifest so a restore is exact. */
export interface BackupManifestOriginal {
  readonly path: string;
  readonly key: string;
  readonly byteSize: number;
  readonly sha256: string;
}

/**
 * The manifest written beside each backup. `latest.json` is the same document,
 * so a restore needs only one well-known key to find the newest complete set.
 */
export interface BackupManifest {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly database: {
    readonly key: string;
    readonly byteSize: number;
    readonly sha256: string;
  };
  readonly originals: readonly BackupManifestOriginal[];
  readonly totalBytes: number;
}

interface BackupRunRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  status: "running" | "success" | "failure";
  error: string | null;
  object_count: number;
  byte_size: number;
}

function publicRun(row: BackupRunRow): Record<string, unknown> {
  return {
    id: row.id,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt:
      row.finished_at === null
        ? null
        : new Date(row.finished_at).toISOString(),
    status: row.status,
    error: row.error,
    objectCount: row.object_count,
    byteSize: row.byte_size,
  };
}

/** Recursively list files under a directory, relative to its root. */
function listFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(relative(root, full));
    }
  };
  walk(root);
  return found;
}

/**
 * Build the backups API and scheduled job. Originals are copied untouched and
 * the database is snapshotted with SQLite's online backup API, so the copy is
 * consistent even while Members are uploading. Admins can trigger a run, see
 * the latest run's outcome, and check the data volume's disk usage.
 */
export function createBackups(db: DatabaseSync, auth: Auth, config: Config) {
  const settings = backupSettings(config);
  const s3: S3Client | null = settings ? createS3Client(settings) : null;
  const now = () => Date.now();
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  const requireAdmin = (cookies: Map<string, string>) => {
    const member = auth.currentMember(cookies);
    if (!member) throw new HttpError(401, "unauthenticated");
    if (member.role !== "admin") throw new HttpError(403, "forbidden");
    return member;
  };

  const lastRunRow = (): BackupRunRow | undefined =>
    db
      .prepare(
        `SELECT id, started_at, finished_at, status, error, object_count, byte_size
         FROM backup_run ORDER BY id DESC LIMIT 1`,
      )
      .get() as BackupRunRow | undefined;

  const insertRun = (): number => {
    const info = db
      .prepare(
        `INSERT INTO backup_run (started_at, status, object_count, byte_size)
         VALUES (?, 'running', 0, 0)`,
      )
      .run(now());
    return Number(info.lastInsertRowid);
  };

  const finishRun = (
    id: number,
    status: "success" | "failure",
    objectCount: number,
    byteSize: number,
    error: string | null,
  ): void => {
    db.prepare(
      `UPDATE backup_run
       SET finished_at = ?, status = ?, object_count = ?, byte_size = ?, error = ?
       WHERE id = ?`,
    ).run(now(), status, objectCount, byteSize, error, id);
  };

  async function run(): Promise<BackupRunRow> {
    if (!settings || !s3) throw new HttpError(409, "backup_not_configured");
    if (running) throw new HttpError(409, "backup_in_progress");

    running = true;
    // A previous process may have died mid-run; its "running" row can never
    // finish, so record it as interrupted rather than showing it forever.
    db.prepare(
      `UPDATE backup_run
       SET status = 'failure', finished_at = ?, error = 'interrupted'
       WHERE status = 'running'`,
    ).run(now());

    const runId = insertRun();
    const workDir = mkdtempSync(join(tmpdir(), "familio-backup-"));
    let objectCount = 0;
    let byteSize = 0;

    try {
      const backupId = new Date().toISOString().replace(/[:.]/g, "-");
      const baseKey = backupKey(settings.prefix, "backups", backupId);

      // SQLite's online backup produces a transactionally consistent snapshot
      // without stopping the live database.
      const snapshotPath = join(workDir, "familio.db");
      await sqliteBackup(db, snapshotPath);
      const databaseBytes = readFileSync(snapshotPath);
      const databaseKey = `${baseKey}/database.sqlite`;
      await s3.putObject(
        databaseKey,
        databaseBytes,
        "application/vnd.sqlite3",
      );
      objectCount++;
      byteSize += databaseBytes.length;

      const originals: BackupManifestOriginal[] = [];
      for (const file of listFiles(config.ORIGINALS_DIR)) {
        const path = file.split(sep).join("/");
        const data = readFileSync(join(config.ORIGINALS_DIR, file));
        const key = `${baseKey}/originals/${path}`;
        await s3.putObject(key, data);
        objectCount++;
        byteSize += data.length;
        originals.push({
          path,
          key,
          byteSize: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        });
      }

      const manifest: BackupManifest = {
        version: 1,
        id: backupId,
        createdAt: new Date().toISOString(),
        database: {
          key: databaseKey,
          byteSize: databaseBytes.length,
          sha256: createHash("sha256").update(databaseBytes).digest("hex"),
        },
        originals,
        totalBytes:
          databaseBytes.length +
          originals.reduce((sum, original) => sum + original.byteSize, 0),
      };
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      await s3.putObject(
        `${baseKey}/manifest.json`,
        manifestBytes,
        "application/json",
      );
      objectCount++;
      byteSize += manifestBytes.length;

      // Publish latest.json last: it only ever points at a complete backup.
      await s3.putObject(
        backupKey(settings.prefix, "latest.json"),
        manifestBytes,
        "application/json",
      );
      objectCount++;
      byteSize += manifestBytes.length;

      finishRun(runId, "success", objectCount, byteSize, null);
      return lastRunRow()!;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finishRun(runId, "failure", objectCount, byteSize, message.slice(0, 2000));
      throw new HttpError(502, "backup_failed");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      running = false;
    }
  }

  return {
    /** Start the periodic job; a no-op when backup storage is unconfigured. */
    start(): void {
      if (!settings || config.BACKUP_INTERVAL_SECONDS <= 0 || timer) return;
      timer = setInterval(() => {
        void run().catch(() => {
          // The failure is recorded in backup_run and shown to Admins.
        });
      }, config.BACKUP_INTERVAL_SECONDS * 1000);
      timer.unref();
    },

    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },

    /** GET /api/admin/backups — configuration and the most recent run. */
    status({ res, cookies }: Ctx): void {
      requireAdmin(cookies);
      const lastRun = lastRunRow();
      sendJson(res, 200, {
        configured: settings !== null,
        intervalSeconds: settings ? config.BACKUP_INTERVAL_SECONDS : null,
        bucket: settings?.bucket ?? null,
        lastRun: lastRun ? publicRun(lastRun) : null,
      });
    },

    /** POST /api/admin/backups — run a backup now (the schedule does this too). */
    async runNow({ res, cookies }: Ctx): Promise<void> {
      requireAdmin(cookies);
      const row = await run();
      sendJson(res, 201, { backup: publicRun(row) });
    },

    /** GET /api/admin/disk — space used and remaining on the data volume. */
    disk({ res, cookies }: Ctx): void {
      requireAdmin(cookies);
      const stats = statfsSync(config.ORIGINALS_DIR);
      const blockSize = Number(stats.bsize);
      const totalBytes = Number(stats.blocks) * blockSize;
      const freeBytes = Number(stats.bfree) * blockSize;
      const availableBytes = Number(stats.bavail) * blockSize;
      sendJson(res, 200, {
        path: config.ORIGINALS_DIR,
        totalBytes,
        usedBytes: totalBytes - freeBytes,
        freeBytes,
        availableBytes,
      });
    },
  };
}

export type Backups = ReturnType<typeof createBackups>;
