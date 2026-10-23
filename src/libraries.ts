import type { DatabaseSync } from "node:sqlite";

import type { Auth, Ctx } from "./auth.ts";
import { HttpError, sendJson } from "./http.ts";

export interface LibraryRow {
  id: number;
  kind: "private" | "family";
  owner_id: number | null;
}

/** Public shape of a Library returned to clients; owner_id is never exposed. */
function publicLibrary(l: LibraryRow): { id: number; kind: string } {
  return { id: l.id, kind: l.kind };
}

/**
 * Return a Library if the given Member may access it, else null. The Family
 * Library is visible to every Member; a private Library only to its owner
 * (Admins get no special read access, ADR 0003). A private Library retained
 * after its owner was removed is visible to Admins for management. An unknown
 * id and another Member's private Library are indistinguishable — both null —
 * so callers never reveal which private Libraries exist. This is the one
 * server-side access rule reused by every Library- and Asset-scoped request.
 */
export function libraryAccessibleBy(
  db: DatabaseSync,
  libraryId: number,
  memberId: number,
): LibraryRow | null {
  const lib = db
    .prepare(
      `SELECT l.id, l.kind, l.owner_id, m.removed_at AS owner_removed
       FROM library l LEFT JOIN member m ON m.id = l.owner_id
       WHERE l.id = ?`,
    )
    .get(libraryId) as (LibraryRow & { owner_removed: number | null }) |
    undefined;
  if (!lib) return null;
  if (lib.kind === "family" || lib.owner_id === memberId) return lib;
  // A retained private Library belongs to a removed Member. It is no longer
  // anyone's private space, so an Admin may manage it (its data survives the
  // removal); no other Member can see it.
  if (lib.owner_removed === null) return null;
  const member = db
    .prepare("SELECT role FROM member WHERE id = ?")
    .get(memberId) as { role: string } | undefined;
  return member?.role === "admin" ? lib : null;
}

/**
 * Create a Member's private Library. Called when a Member joins (the first
 * Admin at setup, everyone else on accepting an invitation), so every Member
 * owns exactly one private Library (ADR 0003).
 */
export function createPrivateLibrary(db: DatabaseSync, ownerId: number): void {
  db.prepare("INSERT INTO library (kind, owner_id) VALUES ('private', ?)").run(
    ownerId,
  );
}

/**
 * Build the Libraries API: a Member can list and open their own private
 * Library and the shared Family Library, and nothing else. Access is enforced
 * on the server for every request against the authenticated Member — Admins
 * get no special read access to a private Library (ADR 0003).
 */
export function createLibraries(db: DatabaseSync, auth: Auth) {
  const accessible = (member: {
    id: number;
    role: string;
  }): LibraryRow[] =>
    db
      .prepare(
        `SELECT id, kind, owner_id FROM library
         WHERE kind = 'family' OR owner_id = ?
            OR (? = 'admin' AND kind = 'private' AND owner_id IN (
              SELECT id FROM member WHERE removed_at IS NOT NULL
            ))
         ORDER BY id`,
      )
      .all(member.id, member.role) as unknown as LibraryRow[];

  return {
    /** GET /api/libraries — the Member's private Library and the Family Library. */
    list({ res, cookies }: Ctx): void {
      const member = auth.currentMember(cookies);
      if (!member) throw new HttpError(401, "unauthenticated");
      sendJson(res, 200, {
        libraries: accessible(member).map(publicLibrary),
      });
    },

    /** GET /api/libraries/:id — open a single Library the Member may access. */
    get({ res, cookies, params }: Ctx): void {
      const member = auth.currentMember(cookies);
      if (!member) throw new HttpError(401, "unauthenticated");

      const lib = libraryAccessibleBy(db, Number(params.id), member.id);
      if (!lib) throw new HttpError(404, "library_not_found");
      sendJson(res, 200, publicLibrary(lib));
    },
  };
}

export type Libraries = ReturnType<typeof createLibraries>;
