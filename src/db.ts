import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Config } from "./config.ts";
import { runMigrations } from "./migrations.ts";

/**
 * Open the SQLite database in write-ahead-log mode (ADR 0002), ensure its
 * parent directory and the originals folder exist, and apply any pending
 * migrations. Idempotent: safe to call on every start.
 */
export function openDatabase(config: Config): DatabaseSync {
  mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
  mkdirSync(config.ORIGINALS_DIR, { recursive: true });

  const db = new DatabaseSync(config.DATABASE_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  runMigrations(db);

  return db;
}
