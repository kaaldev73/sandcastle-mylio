import type { DatabaseSync } from "node:sqlite";

/**
 * Ordered list of migrations. Each has a stable, unique `id` and a `up` that
 * applies its schema changes. Append new migrations; never edit or reorder an
 * already-released one. Running migrations is idempotent: a migration whose id
 * is already recorded is skipped.
 */
export interface Migration {
  readonly id: string;
  up(db: DatabaseSync): void;
}

export const migrations: readonly Migration[] = [
  {
    id: "0001-initial",
    up(db) {
      // Minimal starting schema for the walking skeleton. Later tickets add
      // Members, Libraries, Assets, Albums, Ratings, etc.
      db.exec(`
        CREATE TABLE library (
          id          INTEGER PRIMARY KEY,
          kind        TEXT NOT NULL CHECK (kind IN ('private', 'family')),
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    id: "0002-accounts",
    up(db) {
      // Accounts, invitations, sessions, password resets and a log of login
      // attempts (for rate limiting). All timestamps are epoch milliseconds
      // (INTEGER) so expiry and window comparisons are plain arithmetic.
      // Email is unique case-insensitively; it is also normalised in code.
      db.exec(`
        CREATE TABLE member (
          id             INTEGER PRIMARY KEY,
          email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash  TEXT NOT NULL,
          role           TEXT NOT NULL CHECK (role IN ('admin', 'member')),
          created_at     INTEGER NOT NULL
        );

        CREATE TABLE invitation (
          id           INTEGER PRIMARY KEY,
          email        TEXT NOT NULL COLLATE NOCASE,
          token_hash   TEXT NOT NULL UNIQUE,
          role         TEXT NOT NULL CHECK (role IN ('admin', 'member')),
          invited_by   INTEGER NOT NULL REFERENCES member(id),
          expires_at   INTEGER NOT NULL,
          accepted_at  INTEGER,
          created_at   INTEGER NOT NULL
        );

        CREATE TABLE session (
          id          INTEGER PRIMARY KEY,
          token_hash  TEXT NOT NULL UNIQUE,
          member_id   INTEGER NOT NULL REFERENCES member(id) ON DELETE CASCADE,
          expires_at  INTEGER NOT NULL,
          created_at  INTEGER NOT NULL
        );

        CREATE TABLE password_reset (
          id          INTEGER PRIMARY KEY,
          token_hash  TEXT NOT NULL UNIQUE,
          member_id   INTEGER NOT NULL REFERENCES member(id) ON DELETE CASCADE,
          expires_at  INTEGER NOT NULL,
          used_at     INTEGER,
          created_at  INTEGER NOT NULL
        );

        CREATE TABLE login_attempt (
          id          INTEGER PRIMARY KEY,
          email       TEXT NOT NULL COLLATE NOCASE,
          succeeded   INTEGER NOT NULL,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX idx_login_attempt_email ON login_attempt (email, created_at);
      `);
    },
  },
  {
    id: "0003-libraries",
    up(db) {
      // Give the placeholder `library` table an owner and the access rule it
      // carries (ADR 0003). A private Library is owned by exactly one Member
      // (owner_id set, unique); the single Family Library has no owner
      // (owner_id NULL) and is visible to all. The Family Library exists from
      // the very first boot, so seed it here. Cascade a Library away with its
      // owner so a removed Member leaves no orphan private Library.
      db.exec(`
        ALTER TABLE library
          ADD COLUMN owner_id INTEGER REFERENCES member(id) ON DELETE CASCADE;

        CREATE UNIQUE INDEX idx_library_owner
          ON library (owner_id) WHERE owner_id IS NOT NULL;
        CREATE UNIQUE INDEX idx_library_family
          ON library (kind) WHERE kind = 'family';

        INSERT INTO library (kind) VALUES ('family');
      `);
    },
  },
  {
    id: "0004-assets",
    up(db) {
      // An Asset is a single photo stored in exactly one Library (ADR 0003).
      // The original file is kept untouched on disk (content-addressed by its
      // SHA-256 hash); the thumbnail is derived data stored separately (here,
      // a small BLOB) and can always be regenerated from the original. The
      // capture date is epoch milliseconds so Timeline ordering is plain
      // arithmetic; capture_source records whether it came from the file's
      // metadata ('exif') or the file date fallback ('file').
      db.exec(`
        CREATE TABLE asset (
          id              INTEGER PRIMARY KEY,
          library_id      INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
          uploader_id     INTEGER NOT NULL REFERENCES member(id),
          filename        TEXT NOT NULL,
          mime_type       TEXT NOT NULL,
          byte_size       INTEGER NOT NULL,
          content_hash    TEXT NOT NULL,
          capture_date    INTEGER NOT NULL,
          capture_source  TEXT NOT NULL CHECK (capture_source IN ('exif', 'file')),
          storage_path    TEXT NOT NULL,
          thumbnail       BLOB NOT NULL,
          thumbnail_mime  TEXT NOT NULL,
          created_at      INTEGER NOT NULL
        );
        CREATE INDEX idx_asset_library ON asset (library_id, capture_date);
        CREATE INDEX idx_asset_hash ON asset (library_id, content_hash);
      `);
    },
  },
];

/**
 * Apply every migration that has not already been recorded, in order, each in
 * its own transaction. Safe to run on every start: already-applied migrations
 * are skipped, so calling this repeatedly is a no-op. Returns the ids applied
 * by this call (empty when the database is already up to date).
 */
export function runMigrations(
  db: DatabaseSync,
  toApply: readonly Migration[] = migrations,
): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (
      db.prepare("SELECT id FROM schema_migrations").all() as { id: string }[]
    ).map((row) => row.id),
  );

  const record = db.prepare("INSERT INTO schema_migrations (id) VALUES (?)");
  const done: string[] = [];

  for (const migration of toApply) {
    if (applied.has(migration.id)) continue;
    db.exec("BEGIN");
    try {
      migration.up(db);
      record.run(migration.id);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `Migration "${migration.id}" failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
    done.push(migration.id);
  }

  return done;
}
