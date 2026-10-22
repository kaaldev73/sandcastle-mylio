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
