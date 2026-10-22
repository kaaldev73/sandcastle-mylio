import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { startTestApp, sessionCookie, type TestApp } from "./helpers/harness.ts";

const PASSWORD = "correct-horse-battery";
const ADMIN_EMAIL = "admin@example.com";

/** Bootstrap the first Admin and return the admin's session cookie. */
async function setupAdmin(app: TestApp): Promise<string> {
  const res = await app.fetch("/api/setup", {
    method: "POST",
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
  });
  assert.equal(res.status, 201);
  const cookie = sessionCookie(res);
  assert.ok(cookie, "setup should start a session");
  return cookie;
}

/** Admin invites an email; returns the single-use invitation token. */
async function invite(
  app: TestApp,
  adminCookie: string,
  email: string,
): Promise<string> {
  const res = await app.fetch("/api/invitations", {
    method: "POST",
    headers: { cookie: adminCookie },
    body: JSON.stringify({ email }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { token: string };
  return body.token;
}

test("the first Admin can be bootstrapped exactly once", async () => {
  const app = await startTestApp();
  try {
    const first = await app.fetch("/api/setup", {
      method: "POST",
      body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
    });
    assert.equal(first.status, 201);
    const body = (await first.json()) as { role: string; email: string };
    assert.equal(body.role, "admin");
    assert.equal(body.email, ADMIN_EMAIL);

    // A second setup is refused: there is only ever one bootstrap.
    const second = await app.fetch("/api/setup", {
      method: "POST",
      body: JSON.stringify({ email: "other@example.com", password: PASSWORD }),
    });
    assert.equal(second.status, 409);
  } finally {
    await app.stop();
  }
});

test("there is no public sign-up: accounts need a valid invitation", async () => {
  const app = await startTestApp();
  try {
    await setupAdmin(app);
    // No endpoint creates an account without a token; a bogus token is refused.
    const res = await app.fetch("/api/invitations/accept", {
      method: "POST",
      body: JSON.stringify({ token: "not-a-real-token", password: PASSWORD }),
    });
    assert.equal(res.status, 404);
  } finally {
    await app.stop();
  }
});

test("an Admin invites a Member who accepts, sets a password and logs in", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const token = await invite(app, adminCookie, "member@example.com");

    const accept = await app.fetch("/api/invitations/accept", {
      method: "POST",
      body: JSON.stringify({ token, password: "member-password" }),
    });
    assert.equal(accept.status, 201);
    const member = (await accept.json()) as { role: string; email: string };
    assert.equal(member.role, "member");
    assert.equal(member.email, "member@example.com");

    // The Member can now log in with the password they chose.
    const login = await app.fetch("/api/login", {
      method: "POST",
      body: JSON.stringify({
        email: "member@example.com",
        password: "member-password",
      }),
    });
    assert.equal(login.status, 200);
  } finally {
    await app.stop();
  }
});

test("an invitation is single-use", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const token = await invite(app, adminCookie, "once@example.com");

    const first = await app.fetch("/api/invitations/accept", {
      method: "POST",
      body: JSON.stringify({ token, password: PASSWORD }),
    });
    assert.equal(first.status, 201);

    const second = await app.fetch("/api/invitations/accept", {
      method: "POST",
      body: JSON.stringify({ token, password: PASSWORD }),
    });
    assert.equal(second.status, 409);
  } finally {
    await app.stop();
  }
});

test("an expired invitation cannot be accepted", async () => {
  const app = await startTestApp({ INVITE_TTL_SECONDS: "0" });
  try {
    const adminCookie = await setupAdmin(app);
    const token = await invite(app, adminCookie, "late@example.com");

    const res = await app.fetch("/api/invitations/accept", {
      method: "POST",
      body: JSON.stringify({ token, password: PASSWORD }),
    });
    assert.equal(res.status, 410);
  } finally {
    await app.stop();
  }
});

test("only an authenticated Admin can invite", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);

    // Unauthenticated: rejected.
    const anon = await app.fetch("/api/invitations", {
      method: "POST",
      body: JSON.stringify({ email: "x@example.com" }),
    });
    assert.equal(anon.status, 401);

    // A plain Member cannot invite.
    const token = await invite(app, adminCookie, "plain@example.com");
    const accept = await app.fetch("/api/invitations/accept", {
      method: "POST",
      body: JSON.stringify({ token, password: PASSWORD }),
    });
    const memberCookie = sessionCookie(accept)!;
    const asMember = await app.fetch("/api/invitations", {
      method: "POST",
      headers: { cookie: memberCookie },
      body: JSON.stringify({ email: "y@example.com" }),
    });
    assert.equal(asMember.status, 403);
  } finally {
    await app.stop();
  }
});

test("login and logout work and sessions carry identity", async () => {
  const app = await startTestApp();
  try {
    await setupAdmin(app);

    const login = await app.fetch("/api/login", {
      method: "POST",
      body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = sessionCookie(login)!;

    const me = await app.fetch("/api/me", { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as { email: string }).email, ADMIN_EMAIL);

    const logout = await app.fetch("/api/logout", {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(logout.status, 200);

    // The session no longer identifies anyone.
    const after = await app.fetch("/api/me", { headers: { cookie } });
    assert.equal(after.status, 401);
  } finally {
    await app.stop();
  }
});

test("a wrong password is rejected", async () => {
  const app = await startTestApp();
  try {
    await setupAdmin(app);
    const res = await app.fetch("/api/login", {
      method: "POST",
      body: JSON.stringify({ email: ADMIN_EMAIL, password: "wrong" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await app.stop();
  }
});

test("passwords are stored hashed, never in plaintext", async () => {
  const app = await startTestApp();
  try {
    await setupAdmin(app);
    // Inspect storage directly: the stored value must be a scrypt hash, not the
    // password. (The HTTP API never exposes the hash.)
    const db = new DatabaseSync(app.databasePath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT password_hash FROM member WHERE email = ?")
        .get(ADMIN_EMAIL) as { password_hash: string };
      assert.ok(row.password_hash.startsWith("scrypt$"));
      assert.ok(!row.password_hash.includes(PASSWORD));
    } finally {
      db.close();
    }
  } finally {
    await app.stop();
  }
});

test("a session expires", async () => {
  const app = await startTestApp({ SESSION_TTL_SECONDS: "0" });
  try {
    const cookie = await setupAdmin(app);
    const me = await app.fetch("/api/me", { headers: { cookie } });
    assert.equal(me.status, 401);
  } finally {
    await app.stop();
  }
});

test("repeated failed logins are blocked", async () => {
  const app = await startTestApp({ LOGIN_MAX_FAILURES: "3" });
  try {
    await setupAdmin(app);
    for (let i = 0; i < 3; i++) {
      const res = await app.fetch("/api/login", {
        method: "POST",
        body: JSON.stringify({ email: ADMIN_EMAIL, password: "wrong" }),
      });
      assert.equal(res.status, 401);
    }
    // Further attempts are blocked, even with the correct password.
    const blocked = await app.fetch("/api/login", {
      method: "POST",
      body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
    });
    assert.equal(blocked.status, 429);
  } finally {
    await app.stop();
  }
});

test("a successful login clears the failure counter", async () => {
  const app = await startTestApp({ LOGIN_MAX_FAILURES: "3" });
  try {
    await setupAdmin(app);
    for (let i = 0; i < 2; i++) {
      await app.fetch("/api/login", {
        method: "POST",
        body: JSON.stringify({ email: ADMIN_EMAIL, password: "wrong" }),
      });
    }
    const good = await app.fetch("/api/login", {
      method: "POST",
      body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
    });
    assert.equal(good.status, 200);
    // Two more failures should not trip the limit, because the counter reset.
    for (let i = 0; i < 2; i++) {
      const res = await app.fetch("/api/login", {
        method: "POST",
        body: JSON.stringify({ email: ADMIN_EMAIL, password: "wrong" }),
      });
      assert.equal(res.status, 401);
    }
  } finally {
    await app.stop();
  }
});

test("password reset works end to end", async () => {
  const app = await startTestApp();
  try {
    const oldCookie = await setupAdmin(app);

    const request = await app.fetch("/api/password-reset/request", {
      method: "POST",
      body: JSON.stringify({ email: ADMIN_EMAIL }),
    });
    assert.equal(request.status, 200);
    const token = ((await request.json()) as { token: string }).token;
    assert.ok(token);

    const confirm = await app.fetch("/api/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify({ token, password: "brand-new-password" }),
    });
    assert.equal(confirm.status, 200);

    // Old password no longer works; the new one does.
    const oldLogin = await app.fetch("/api/login", {
      method: "POST",
      body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await app.fetch("/api/login", {
      method: "POST",
      body: JSON.stringify({
        email: ADMIN_EMAIL,
        password: "brand-new-password",
      }),
    });
    assert.equal(newLogin.status, 200);

    // Sessions held before the reset are invalidated.
    const me = await app.fetch("/api/me", { headers: { cookie: oldCookie } });
    assert.equal(me.status, 401);
  } finally {
    await app.stop();
  }
});

test("a reset token is single-use", async () => {
  const app = await startTestApp();
  try {
    await setupAdmin(app);
    const token = ((await (
      await app.fetch("/api/password-reset/request", {
        method: "POST",
        body: JSON.stringify({ email: ADMIN_EMAIL }),
      })
    ).json()) as { token: string }).token;

    const first = await app.fetch("/api/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify({ token, password: "new-password-one" }),
    });
    assert.equal(first.status, 200);

    const second = await app.fetch("/api/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify({ token, password: "new-password-two" }),
    });
    assert.equal(second.status, 409);
  } finally {
    await app.stop();
  }
});

test("an expired reset token is refused", async () => {
  const app = await startTestApp({ PASSWORD_RESET_TTL_SECONDS: "0" });
  try {
    await setupAdmin(app);
    const token = ((await (
      await app.fetch("/api/password-reset/request", {
        method: "POST",
        body: JSON.stringify({ email: ADMIN_EMAIL }),
      })
    ).json()) as { token: string }).token;

    const res = await app.fetch("/api/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify({ token, password: "whatever-password" }),
    });
    assert.equal(res.status, 410);
  } finally {
    await app.stop();
  }
});

test("a reset request for an unknown email does not reveal that", async () => {
  const app = await startTestApp();
  try {
    await setupAdmin(app);
    const res = await app.fetch("/api/password-reset/request", {
      method: "POST",
      body: JSON.stringify({ email: "nobody@example.com" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { token?: string };
    assert.equal(body.token, undefined);
  } finally {
    await app.stop();
  }
});
