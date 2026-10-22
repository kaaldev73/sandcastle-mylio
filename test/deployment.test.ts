import assert from "node:assert/strict";
import { test } from "node:test";

import { startTestApp, type TestApp } from "./helpers/harness.ts";

const PASSWORD = "correct-horse-battery";
const ADMIN_EMAIL = "admin@example.com";

/** The raw Set-Cookie header for the session the first Admin's setup starts. */
async function setupSessionSetCookie(app: TestApp): Promise<string> {
  const res = await app.fetch("/api/setup", {
    method: "POST",
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
  });
  assert.equal(res.status, 201);
  const raw = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("familio_session="));
  assert.ok(raw, "setup should set a session cookie");
  return raw;
}

test("session cookie is Secure by default, so sessions ride HTTPS only", async () => {
  // Production serves behind Coolify's HTTPS proxy (ADR 0002); the default
  // must mark the session cookie Secure so a browser never sends it in clear.
  const app = await startTestApp();
  try {
    const cookie = await setupSessionSetCookie(app);
    assert.match(cookie, /;\s*Secure/i);
    // Still carries the protections it had before.
    assert.match(cookie, /;\s*HttpOnly/i);
    assert.match(cookie, /;\s*SameSite=Lax/i);
  } finally {
    await app.stop();
  }
});

test("SECURE_COOKIES=false drops Secure for plain-HTTP local runs", async () => {
  const app = await startTestApp({ SECURE_COOKIES: "false" });
  try {
    const cookie = await setupSessionSetCookie(app);
    assert.doesNotMatch(cookie, /;\s*Secure/i);
    assert.match(cookie, /;\s*HttpOnly/i);
  } finally {
    await app.stop();
  }
});
