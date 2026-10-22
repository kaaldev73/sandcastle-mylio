import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import type { Config } from "./config.ts";
import {
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from "./crypto.ts";
import { HttpError, requireString, sendJson } from "./http.ts";
import { createPrivateLibrary } from "./libraries.ts";

const COOKIE_NAME = "familio_session";
const MIN_PASSWORD_LENGTH = 8;

interface MemberRow {
  id: number;
  email: string;
  role: "admin" | "member";
  password_hash: string;
}

/** Public shape of a member returned to clients. */
function publicMember(m: MemberRow): {
  id: number;
  email: string;
  role: string;
} {
  return { id: m.id, email: m.email, role: m.role };
}

/** The context a route handler receives. Body is already parsed for POSTs. */
export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  cookies: Map<string, string>;
  body: Record<string, unknown>;
  /** Path parameters captured from a dynamic route (e.g. `:id`); {} otherwise. */
  params: Record<string, string>;
}

/**
 * Build the accounts/authentication API against a database and config. Covers:
 * bootstrapping the first Admin, invite-only account creation, login/logout
 * with hashed passwords and expiring sessions, login rate limiting, and
 * password reset. Everything is exercised through the HTTP seam.
 */
export function createAuth(db: DatabaseSync, config: Config) {
  const now = () => Date.now();

  const findMemberByEmail = (email: string): MemberRow | undefined =>
    db
      .prepare(
        "SELECT id, email, role, password_hash FROM member WHERE email = ?",
      )
      .get(email) as MemberRow | undefined;

  /** Create a session for a member and set the session cookie. */
  const startSession = (res: ServerResponse, memberId: number): void => {
    const token = generateToken();
    const expiresAt = now() + config.SESSION_TTL_SECONDS * 1000;
    db.prepare(
      "INSERT INTO session (token_hash, member_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).run(hashToken(token), memberId, expiresAt, now());
    res.setHeader(
      "set-cookie",
      `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${config.SESSION_TTL_SECONDS}`,
    );
  };

  /** Resolve the member for a request's session cookie, or null. */
  const currentMember = (cookies: Map<string, string>): MemberRow | null => {
    const token = cookies.get(COOKIE_NAME);
    if (!token) return null;
    const tokenHash = hashToken(token);
    const row = db
      .prepare(
        `SELECT m.id, m.email, m.role, m.password_hash, s.expires_at AS expires_at
         FROM session s JOIN member m ON m.id = s.member_id
         WHERE s.token_hash = ?`,
      )
      .get(tokenHash) as (MemberRow & { expires_at: number }) | undefined;
    if (!row) return null;
    if (row.expires_at <= now()) {
      db.prepare("DELETE FROM session WHERE token_hash = ?").run(tokenHash);
      return null;
    }
    return row;
  };

  const normaliseEmail = (raw: string): string => raw.trim().toLowerCase();

  const requirePassword = (body: Record<string, unknown>): string => {
    const password = requireString(body, "password");
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(400, "weak_password");
    }
    return password;
  };

  const memberCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM member").get() as { n: number }).n;

  return {
    currentMember,

    /** POST /api/setup — create the first Admin, exactly once. */
    setup({ res, body }: Ctx): void {
      if (memberCount() > 0) throw new HttpError(409, "already_initialised");
      const email = normaliseEmail(requireString(body, "email"));
      const password = requirePassword(body);
      const info = db
        .prepare(
          "INSERT INTO member (email, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)",
        )
        .run(email, hashPassword(password), now());
      const memberId = Number(info.lastInsertRowid);
      createPrivateLibrary(db, memberId);
      const member = findMemberByEmail(email)!;
      startSession(res, memberId);
      sendJson(res, 201, publicMember(member));
    },

    /** POST /api/invitations — Admin invites someone. Single-use, expiring. */
    invite({ res, cookies, body }: Ctx): void {
      const admin = currentMember(cookies);
      if (!admin) throw new HttpError(401, "unauthenticated");
      if (admin.role !== "admin") throw new HttpError(403, "forbidden");

      const email = normaliseEmail(requireString(body, "email"));
      const roleRaw = typeof body.role === "string" ? body.role : "member";
      if (roleRaw !== "member" && roleRaw !== "admin") {
        throw new HttpError(400, "invalid_role");
      }
      if (findMemberByEmail(email)) throw new HttpError(409, "already_member");

      const token = generateToken();
      const expiresAt = now() + config.INVITE_TTL_SECONDS * 1000;
      db.prepare(
        `INSERT INTO invitation (email, token_hash, role, invited_by, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(email, hashToken(token), roleRaw, admin.id, expiresAt, now());

      // The token is returned so the Admin can send the invite link. There is
      // no public sign-up: an account can only be created with a token.
      sendJson(res, 201, {
        email,
        role: roleRaw,
        token,
        expiresAt: new Date(expiresAt).toISOString(),
      });
    },

    /** POST /api/invitations/accept — accept an invite and set a password. */
    acceptInvite({ res, body }: Ctx): void {
      const token = requireString(body, "token");
      const password = requirePassword(body);

      const invite = db
        .prepare(
          "SELECT id, email, role, expires_at, accepted_at FROM invitation WHERE token_hash = ?",
        )
        .get(hashToken(token)) as
        | {
            id: number;
            email: string;
            role: "admin" | "member";
            expires_at: number;
            accepted_at: number | null;
          }
        | undefined;

      if (!invite) throw new HttpError(404, "invalid_invitation");
      if (invite.accepted_at !== null) {
        throw new HttpError(409, "invitation_already_used");
      }
      if (invite.expires_at <= now()) {
        throw new HttpError(410, "invitation_expired");
      }
      if (findMemberByEmail(invite.email)) {
        throw new HttpError(409, "already_member");
      }

      const info = db
        .prepare(
          "INSERT INTO member (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(invite.email, hashPassword(password), invite.role, now());
      const memberId = Number(info.lastInsertRowid);
      db.prepare("UPDATE invitation SET accepted_at = ? WHERE id = ?").run(
        now(),
        invite.id,
      );
      createPrivateLibrary(db, memberId);

      const member = findMemberByEmail(invite.email)!;
      startSession(res, memberId);
      sendJson(res, 201, publicMember(member));
    },

    /** POST /api/login — authenticate; rate-limited per email. */
    login({ res, body }: Ctx): void {
      const email = normaliseEmail(requireString(body, "email"));
      const password = requireString(body, "password");

      const cutoff = now() - config.LOGIN_WINDOW_SECONDS * 1000;
      const failures = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM login_attempt WHERE email = ? AND succeeded = 0 AND created_at > ?",
          )
          .get(email, cutoff) as { n: number }
      ).n;
      if (failures >= config.LOGIN_MAX_FAILURES) {
        throw new HttpError(429, "too_many_attempts");
      }

      const member = findMemberByEmail(email);
      const ok =
        member !== undefined && verifyPassword(password, member.password_hash);

      db.prepare(
        "INSERT INTO login_attempt (email, succeeded, created_at) VALUES (?, ?, ?)",
      ).run(email, ok ? 1 : 0, now());

      if (!ok || !member) throw new HttpError(401, "invalid_credentials");

      // Successful login clears the failure counter for this email.
      db.prepare(
        "DELETE FROM login_attempt WHERE email = ? AND succeeded = 0",
      ).run(email);
      startSession(res, member.id);
      sendJson(res, 200, publicMember(member));
    },

    /** POST /api/logout — end the current session. Idempotent. */
    logout({ res, cookies }: Ctx): void {
      const token = cookies.get(COOKIE_NAME);
      if (token) {
        db.prepare("DELETE FROM session WHERE token_hash = ?").run(
          hashToken(token),
        );
      }
      res.setHeader(
        "set-cookie",
        `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
      );
      sendJson(res, 200, { status: "ok" });
    },

    /** GET /api/me — the current member, or 401. */
    me({ res, cookies }: Ctx): void {
      const member = currentMember(cookies);
      if (!member) throw new HttpError(401, "unauthenticated");
      sendJson(res, 200, publicMember(member));
    },

    /** POST /api/password-reset/request — issue a reset token for an email. */
    requestPasswordReset({ res, body }: Ctx): void {
      const email = normaliseEmail(requireString(body, "email"));
      const member = findMemberByEmail(email);
      // Always answer 200 so the endpoint does not reveal whether an email is
      // registered. A token is only issued (and, for this slice, returned)
      // when the email belongs to a Member.
      const response: { status: string; token?: string } = { status: "ok" };
      if (member) {
        const token = generateToken();
        const expiresAt = now() + config.PASSWORD_RESET_TTL_SECONDS * 1000;
        db.prepare(
          `INSERT INTO password_reset (token_hash, member_id, expires_at, created_at)
           VALUES (?, ?, ?, ?)`,
        ).run(hashToken(token), member.id, expiresAt, now());
        // NOTE: until email delivery exists (later ticket), the token is
        // returned here so the reset flow works end to end. It must be sent
        // out-of-band and not returned once email is wired up.
        response.token = token;
      }
      sendJson(res, 200, response);
    },

    /** POST /api/password-reset/confirm — set a new password from a token. */
    confirmPasswordReset({ res, body }: Ctx): void {
      const token = requireString(body, "token");
      const password = requirePassword(body);

      const reset = db
        .prepare(
          "SELECT id, member_id, expires_at, used_at FROM password_reset WHERE token_hash = ?",
        )
        .get(hashToken(token)) as
        | {
            id: number;
            member_id: number;
            expires_at: number;
            used_at: number | null;
          }
        | undefined;

      if (!reset) throw new HttpError(404, "invalid_reset");
      if (reset.used_at !== null) throw new HttpError(409, "reset_already_used");
      if (reset.expires_at <= now()) throw new HttpError(410, "reset_expired");

      db.prepare("UPDATE member SET password_hash = ? WHERE id = ?").run(
        hashPassword(password),
        reset.member_id,
      );
      db.prepare("UPDATE password_reset SET used_at = ? WHERE id = ?").run(
        now(),
        reset.id,
      );
      // Invalidate existing sessions so a reset locks out anyone holding the
      // old password's session.
      db.prepare("DELETE FROM session WHERE member_id = ?").run(
        reset.member_id,
      );
      sendJson(res, 200, { status: "ok" });
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
