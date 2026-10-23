import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  backupKey,
  backupSettings,
  type BackupManifest,
  type BackupSettings,
} from "./backup.ts";
import { loadConfig } from "./config.ts";
import { createS3Client } from "./s3.ts";

export interface RestoreResult {
  readonly manifest: BackupManifest;
  readonly databasePath: string;
  readonly originalsDir: string;
}

function parseManifest(bytes: Buffer): BackupManifest {
  const value = JSON.parse(bytes.toString("utf8")) as Partial<BackupManifest>;
  if (
    value.version !== 1 ||
    typeof value.id !== "string" ||
    typeof value.database?.key !== "string" ||
    !Array.isArray(value.originals)
  ) {
    throw new Error("backup manifest is missing required fields");
  }
  return value as BackupManifest;
}

/** Reject a manifest path that could escape the restore destination. */
function safeRelativePath(path: string): string {
  const normal = normalize(path);
  if (
    normal === "" ||
    normal === ".." ||
    normal.startsWith(`..${sep}`) ||
    isAbsolute(normal)
  ) {
    throw new Error(`unsafe original path in backup manifest: ${path}`);
  }
  return normal;
}

function verify(bytes: Buffer, expected: string, what: string): void {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new Error(`restored ${what} failed its checksum`);
  }
}

/**
 * Download the newest backup (or a named one) from S3-compatible storage and
 * lay it out as `familio.db` and `originals/` under `destination`, matching the
 * container's DATABASE_PATH and ORIGINALS_DIR defaults. Each object is checked
 * against the manifest's SHA-256 before it is written.
 */
export async function restoreBackup(
  settings: BackupSettings,
  destination: string,
  backupId?: string,
): Promise<RestoreResult> {
  const s3 = createS3Client(settings);
  const manifestKey = backupId
    ? backupKey(settings.prefix, "backups", backupId, "manifest.json")
    : backupKey(settings.prefix, "latest.json");
  const manifest = parseManifest(await s3.getObject(manifestKey));

  const databasePath = join(destination, "familio.db");
  const originalsDir = join(destination, "originals");
  mkdirSync(originalsDir, { recursive: true });

  const databaseBytes = await s3.getObject(manifest.database.key);
  verify(databaseBytes, manifest.database.sha256, "database");
  writeFileSync(databasePath, databaseBytes);

  for (const original of manifest.originals) {
    const path = safeRelativePath(original.path);
    const bytes = await s3.getObject(original.key);
    verify(bytes, original.sha256, `original ${original.path}`);
    const target = join(originalsDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }

  return { manifest, databasePath, originalsDir };
}

function usage(): string {
  return (
    "Usage: npm run restore -- --destination <dir> [--backup <id>]\n" +
    "Restores the latest (or named) backup into <dir>/familio.db and " +
    "<dir>/originals using the BACKUP_S3_* environment variables."
  );
}

async function main(): Promise<void> {
  let destination: string | undefined;
  let backupId: string | undefined;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--destination") destination = args[++i];
    else if (args[i] === "--backup") backupId = args[++i];
  }
  if (!destination) {
    console.error(usage());
    process.exit(1);
  }

  const settings = backupSettings(loadConfig());
  if (!settings) {
    console.error("Backup storage is not configured (set BACKUP_S3_* variables)");
    process.exit(1);
  }

  const result = await restoreBackup(
    settings,
    resolve(destination),
    backupId,
  );
  console.log(
    `Restored backup ${result.manifest.id} (${result.manifest.originals.length} originals) ` +
      `to ${resolve(destination)}`,
  );
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
