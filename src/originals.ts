import { unlinkSync } from "node:fs";

import type { DatabaseSync } from "node:sqlite";

/**
 * Unlink originals no surviving Asset references. Originals are
 * content-addressed and may be shared, so each path is checked first.
 */
export function removeUnreferencedOriginals(
  db: DatabaseSync,
  storagePaths: readonly string[],
): void {
  for (const path of storagePaths) {
    const remaining = (
      db
        .prepare("SELECT COUNT(*) AS n FROM asset WHERE storage_path = ?")
        .get(path) as { n: number }
    ).n;
    if (remaining > 0) continue;
    try {
      unlinkSync(path);
    } catch {
      // The file may already be gone; the database is the source of truth.
    }
  }
}
