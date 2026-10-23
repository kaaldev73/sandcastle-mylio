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
  {
    id: "0005-albums",
    up(db) {
      // An Album is a named, virtual grouping of Assets within one Library
      // (GLOSSARY, PRD Albums). Membership is a join row and never copies or
      // moves the Asset's file: the Asset still belongs to exactly one Library.
      // Deleting an Album cascades only its membership rows, leaving every
      // Asset in the Library untouched; deleting an Asset likewise drops its
      // memberships. The (album_id, asset_id) primary key makes an Asset appear
      // at most once per Album, and the same Asset may join many Albums.
      db.exec(`
        CREATE TABLE album (
          id          INTEGER PRIMARY KEY,
          library_id  INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
          name        TEXT NOT NULL,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX idx_album_library ON album (library_id);

        CREATE TABLE album_asset (
          album_id  INTEGER NOT NULL REFERENCES album(id) ON DELETE CASCADE,
          asset_id  INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
          added_at  INTEGER NOT NULL,
          PRIMARY KEY (album_id, asset_id)
        );
        CREATE INDEX idx_album_asset_asset ON album_asset (asset_id);
      `);
    },
  },
  {
    id: "0006-member-removal",
    up(db) {
      // Removing a Member is a soft delete: the row stays so historical
      // references (Assets they uploaded, invitations they sent) and a
      // retained private Library keep working. A non-NULL removed_at means
      // the Member cannot log in and is no longer listed as active.
      db.exec(`
        ALTER TABLE member ADD COLUMN removed_at INTEGER;
      `);
    },
  },
  {
    id: "0007-backups",
    up(db) {
      // Each scheduled or manual backup is one row, so Admins can see the last
      // run's time, outcome and size. Timestamps are epoch milliseconds; the
      // schedule itself is in memory and configured by environment variable.
      db.exec(`
        CREATE TABLE backup_run (
          id            INTEGER PRIMARY KEY,
          started_at    INTEGER NOT NULL,
          finished_at   INTEGER,
          status        TEXT NOT NULL CHECK (status IN ('running', 'success', 'failure')),
          error         TEXT,
          object_count  INTEGER NOT NULL DEFAULT 0,
          byte_size     INTEGER NOT NULL DEFAULT 0
        );
      `);
    },
  },
  {
    id: "0008-timeline-date-override",
    up(db) {
      // A Member may correct an Asset's date so scans and badly dated files
      // land in the right Timeline period. Keep the derived capture_date
      // untouched and store the correction separately; the effective date is
      // COALESCE(date_override, capture_date). The original file is never
      // rewritten. NULL means no correction has been made.
      db.exec(`
        ALTER TABLE asset ADD COLUMN date_override INTEGER;
        CREATE INDEX idx_asset_library_effective
          ON asset (library_id, COALESCE(date_override, capture_date));
      `);
    },
  },
  {
    id: "0009-server-import",
    up(db) {
      // Record which source files a Server Import has already brought into a
      // Library, so re-running the same folder skips them instead of making
      // duplicate Assets. The path is relative to the configured import folder
      // and uses forward slashes, so it is stable across platforms. Deleting an
      // Asset cascades its record away, allowing a deliberate re-import.
      db.exec(`
        CREATE TABLE server_import_file (
          id           INTEGER PRIMARY KEY,
          library_id   INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
          source_path  TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          asset_id     INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
          imported_at  INTEGER NOT NULL,
          UNIQUE (library_id, source_path)
        );
        CREATE INDEX idx_server_import_file_library
          ON server_import_file (library_id);
      `);
    },
  },
  {
    id: "0010-ratings",
    up(db) {
      // Rating is a Member's judgement of an Asset: a Pick/Reject/unflagged
      // flag and 1-5 stars (GLOSSARY, PRD Rating). A flag defaults to
      // unflagged and stars to 0 (no stars); 0 also clears the stars. Keeping
      // them as separate columns lets setting one leave the other untouched,
      // and lets either be cleared. The original file is never rewritten.
      db.exec(`
        ALTER TABLE asset ADD COLUMN flag TEXT NOT NULL DEFAULT 'unflagged'
          CHECK (flag IN ('pick', 'reject', 'unflagged'));
        ALTER TABLE asset ADD COLUMN stars INTEGER NOT NULL DEFAULT 0
          CHECK (stars BETWEEN 0 AND 5);
        CREATE INDEX idx_asset_library_flag ON asset (library_id, flag);
        CREATE INDEX idx_asset_library_stars ON asset (library_id, stars);
      `);
    },
  },
  {
    id: "0011-asset-deletion",
    up(db) {
      // Deleting an Asset moves it to a recoverable state: the row and its
      // original file stay put, but a non-NULL deleted_at hides it from the
      // Timeline, grid, Albums and review queue. Restoring clears the timestamp
      // so the Asset's Rating and Album memberships reappear untouched.
      // Permanent removal is a separate step that deletes the row (cascading
      // its memberships) and then unlinks the original if nothing else uses it.
      db.exec(`
        ALTER TABLE asset ADD COLUMN deleted_at INTEGER;
        CREATE INDEX idx_asset_library_deleted
          ON asset (library_id, deleted_at);
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
