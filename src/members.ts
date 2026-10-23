import { unlinkSync } from "node:fs";

import type { DatabaseSync } from "node:sqlite";

import type { Auth, Ctx } from "./auth.ts";
import { HttpError, sendJson } from "./http.ts";

type LibraryDisposition = "keep" | "transfer" | "delete";

interface MemberRow {
  id: number;
  email: string;
  role: "admin" | "member";
  removed_at: number | null;
}

const ACTION_BODY_KEYS = [
  "library",
  "libraryAction",
  "library_action",
  "libraryDisposition",
  "library_disposition",
  "privateLibrary",
  "private_library",
  "disposition",
  "action",
] as const;

const ACTION_QUERY_KEYS = [
  "library",
  "libraryAction",
  "libraryDisposition",
  "disposition",
  "action",
] as const;

const CONFIRM_BODY_KEYS = [
  "confirm",
  "confirmation",
  "confirmDelete",
  "confirm_delete",
  "confirmLibraryDelete",
  "confirm_library_delete",
] as const;

const CONFIRM_QUERY_KEYS = ["confirm", "confirmation"] as const;

const CONFIRMATIONS = new Set(["true", "yes", "delete", "confirm"]);

/** The public shape of a Member; removal state and credentials stay hidden. */
function publicMember(m: MemberRow): { id: number; email: string; role: string } {
  return { id: m.id, email: m.email, role: m.role };
}

/**
 * Read the first non-nullish value from the body, then from the query string.
 * Body values win so a client can override a stale query parameter.
 */
function firstValue(
  body: Record<string, unknown>,
  query: URLSearchParams,
  bodyKeys: readonly string[],
  queryKeys: readonly string[],
): unknown {
  for (const key of bodyKeys) {
    const value = body[key];
    if (value !== undefined && value !== null) return value;
  }
  for (const key of queryKeys) {
    const value = query.get(key);
    if (value !== null) return value;
  }
  return undefined;
}

function parseDisposition(raw: unknown): LibraryDisposition {
  if (raw === undefined || raw === null || raw === "") return "keep";
  if (typeof raw !== "string") {
    throw new HttpError(400, "invalid_library_action");
  }

  const normalised = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (normalised) {
    case "keep":
    case "retain":
      return "keep";
    case "transfer":
    case "transfer_to_family":
    case "family":
    case "move_to_family":
      return "transfer";
    case "delete":
    case "purge":
      return "delete";
    default:
      throw new HttpError(400, "invalid_library_action");
  }
}

/**
 * Read what should happen to a removed Member's private Library. The safe
 * default is to keep it, so omitting the choice never loses data. `delete`
 * additionally needs an explicit confirmation.
 */
function readDisposition(ctx: Ctx): {
  action: LibraryDisposition;
  confirmed: boolean;
} {
  const query = new URL(ctx.req.url ?? "/", "http://localhost").searchParams;
  const action = parseDisposition(
    firstValue(ctx.body, query, ACTION_BODY_KEYS, ACTION_QUERY_KEYS),
  );
  const rawConfirm = firstValue(
    ctx.body,
    query,
    CONFIRM_BODY_KEYS,
    CONFIRM_QUERY_KEYS,
  );
  const confirmed =
    rawConfirm === true ||
    (typeof rawConfirm === "string" &&
      CONFIRMATIONS.has(rawConfirm.trim().toLowerCase()));

  return { action, confirmed };
}

/**
 * Unlink originals no surviving Asset references. Originals are
 * content-addressed and may be shared, so each path is checked first.
 */
function removeUnreferencedOriginals(
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

/**
 * Build the Member management API. An Admin can list the active Members and
 * remove one, choosing whether to keep, transfer to the Family Library, or
 * delete the removed Member's private Library. Removal is a soft delete: the
 * account can no longer log in, while historical data keeps working.
 */
export function createMembers(db: DatabaseSync, auth: Auth) {
  const requireAdmin = (ctx: Ctx) => {
    const member = auth.currentMember(ctx.cookies);
    if (!member) throw new HttpError(401, "unauthenticated");
    if (member.role !== "admin") throw new HttpError(403, "forbidden");
    return member;
  };

  const privateLibraryOf = (memberId: number): { id: number } | undefined =>
    db
      .prepare(
        "SELECT id FROM library WHERE kind = 'private' AND owner_id = ?",
      )
      .get(memberId) as { id: number } | undefined;

  return {
    /** GET /api/members — the active Members, visible to Admins only. */
    list(ctx: Ctx): void {
      requireAdmin(ctx);
      const members = db
        .prepare(
          "SELECT id, email, role, removed_at FROM member WHERE removed_at IS NULL ORDER BY id",
        )
        .all() as unknown as MemberRow[];
      sendJson(ctx.res, 200, { members: members.map(publicMember) });
    },

    /**
     * DELETE /api/members/:id (also POST /api/members/:id/remove) — remove an
     * Admin-selected Member. Their private Library is kept by default; it can
     * instead be transferred into the Family Library, or deleted only with
     * explicit confirmation.
     */
    remove(ctx: Ctx): void {
      const admin = requireAdmin(ctx);
      const memberId = Number(ctx.params.id);
      if (memberId === admin.id) {
        throw new HttpError(409, "cannot_remove_self");
      }

      const target = db
        .prepare(
          "SELECT id, email, role, removed_at FROM member WHERE id = ?",
        )
        .get(memberId) as MemberRow | undefined;
      if (!target || target.removed_at !== null) {
        throw new HttpError(404, "member_not_found");
      }

      const { action, confirmed } = readDisposition(ctx);
      if (action === "delete" && !confirmed) {
        throw new HttpError(400, "confirmation_required");
      }

      const privateLibrary = privateLibraryOf(memberId);
      let assetCount = 0;
      let storagePaths: string[] = [];
      if (privateLibrary) {
        assetCount = (
          db
            .prepare("SELECT COUNT(*) AS n FROM asset WHERE library_id = ?")
            .get(privateLibrary.id) as { n: number }
        ).n;
        if (action === "delete") {
          storagePaths = (
            db
              .prepare(
                "SELECT DISTINCT storage_path FROM asset WHERE library_id = ?",
              )
              .all(privateLibrary.id) as { storage_path: string }[]
          ).map((row) => row.storage_path);
        }
      }

      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM session WHERE member_id = ?").run(memberId);
        db.prepare("DELETE FROM password_reset WHERE member_id = ?").run(
          memberId,
        );

        if (privateLibrary && action === "transfer") {
          const family = db
            .prepare("SELECT id FROM library WHERE kind = 'family'")
            .get() as { id: number };
          db.prepare("UPDATE asset SET library_id = ? WHERE library_id = ?").run(
            family.id,
            privateLibrary.id,
          );
          // Albums are part of the Library too, so carry their groupings
          // across rather than letting the Library deletion cascade them away.
          db.prepare("UPDATE album SET library_id = ? WHERE library_id = ?").run(
            family.id,
            privateLibrary.id,
          );
        }

        if (privateLibrary && action !== "keep") {
          db.prepare("DELETE FROM library WHERE id = ?").run(
            privateLibrary.id,
          );
        }

        db.prepare("UPDATE member SET removed_at = ? WHERE id = ?").run(
          Date.now(),
          memberId,
        );
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }

      if (action === "delete") {
        removeUnreferencedOriginals(db, storagePaths);
      }

      sendJson(ctx.res, 200, {
        status: "ok",
        member: publicMember(target),
        library: action,
        assetCount,
      });
    },
  };
}

export type Members = ReturnType<typeof createMembers>;
