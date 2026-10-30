import assert from "node:assert/strict";
import { test } from "node:test";

import { startTestApp, sessionCookie, type TestApp } from "./helpers/harness.ts";

const PASSWORD = "correct-horse-battery";
const ADMIN_EMAIL = "admin@example.com";

interface Library {
  id: number;
  kind: "private" | "family";
}

/** Bootstrap the first Admin and return the admin's session cookie. */
async function setupAdmin(app: TestApp): Promise<string> {
  const res = await app.fetch("/api/setup", {
    method: "POST",
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
  });
  assert.equal(res.status, 201);
  return sessionCookie(res)!;
}

/** Admin invites an email, the invitee accepts; returns the new member's cookie. */
async function joinMember(
  app: TestApp,
  adminCookie: string,
  email: string,
): Promise<string> {
  const invited = await app.fetch("/api/invitations", {
    method: "POST",
    headers: { cookie: adminCookie },
    body: JSON.stringify({ email }),
  });
  assert.equal(invited.status, 201);
  const { token } = (await invited.json()) as { token: string };

  const accepted = await app.fetch("/api/invitations/accept", {
    method: "POST",
    body: JSON.stringify({ token, password: PASSWORD }),
  });
  assert.equal(accepted.status, 201);
  return sessionCookie(accepted)!;
}

/** List the libraries visible to the holder of `cookie`. */
async function listLibraries(app: TestApp, cookie: string): Promise<Library[]> {
  const res = await app.fetch("/api/libraries", { headers: { cookie } });
  assert.equal(res.status, 200);
  return ((await res.json()) as { libraries: Library[] }).libraries;
}

test("a Member sees exactly their own private Library and the Family Library", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const memberCookie = await joinMember(app, adminCookie, "mem@example.com");

    const libs = await listLibraries(app, memberCookie);
    const kinds = libs.map((l) => l.kind).sort();
    assert.deepEqual(kinds, ["family", "private"]);
    assert.equal(libs.length, 2);
  } finally {
    await app.stop();
  }
});

test("the Family Library exists from setup and the first Admin gets a private Library", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const libs = await listLibraries(app, adminCookie);
    const kinds = libs.map((l) => l.kind).sort();
    assert.deepEqual(kinds, ["family", "private"]);
  } finally {
    await app.stop();
  }
});

test("a Member can open their own private Library and the Family Library", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const memberCookie = await joinMember(app, adminCookie, "mem@example.com");

    for (const lib of await listLibraries(app, memberCookie)) {
      const res = await app.fetch(`/api/libraries/${lib.id}`, {
        headers: { cookie: memberCookie },
      });
      assert.equal(res.status, 200);
      const opened = (await res.json()) as Library;
      assert.equal(opened.id, lib.id);
      assert.equal(opened.kind, lib.kind);
    }
  } finally {
    await app.stop();
  }
});

test("a Member cannot list or open another Member's private Library", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const bobCookie = await joinMember(app, adminCookie, "bob@example.com");

    const bobPrivate = (await listLibraries(app, bobCookie)).find(
      (l) => l.kind === "private",
    )!;

    // Alice's listing never mentions Bob's private Library.
    const aliceLibs = await listLibraries(app, aliceCookie);
    assert.ok(!aliceLibs.some((l) => l.id === bobPrivate.id));

    // And she cannot open it by id.
    const res = await app.fetch(`/api/libraries/${bobPrivate.id}`, {
      headers: { cookie: aliceCookie },
    });
    assert.equal(res.status, 404);
  } finally {
    await app.stop();
  }
});

test("an Admin has no special read access to a Member's private Library", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const memberCookie = await joinMember(app, adminCookie, "mem@example.com");

    const memberPrivate = (await listLibraries(app, memberCookie)).find(
      (l) => l.kind === "private",
    )!;

    // The member's private Library is absent from the Admin's listing...
    const adminLibs = await listLibraries(app, adminCookie);
    assert.ok(!adminLibs.some((l) => l.id === memberPrivate.id));

    // ...and the Admin cannot open it either (ADR 0003).
    const res = await app.fetch(`/api/libraries/${memberPrivate.id}`, {
      headers: { cookie: adminCookie },
    });
    assert.equal(res.status, 404);
  } finally {
    await app.stop();
  }
});

test("listing or opening a Library requires authentication", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const familyLib = (await listLibraries(app, adminCookie)).find(
      (l) => l.kind === "family",
    )!;

    const list = await app.fetch("/api/libraries");
    assert.equal(list.status, 401);

    const open = await app.fetch(`/api/libraries/${familyLib.id}`);
    assert.equal(open.status, 401);
  } finally {
    await app.stop();
  }
});

test("opening a Library that does not exist is a 404", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const res = await app.fetch("/api/libraries/999999", {
      headers: { cookie: adminCookie },
    });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "library_not_found" });
  } finally {
    await app.stop();
  }
});

test("each listed Library says whether it is the Member's own private Library", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const memberCookie = await joinMember(app, adminCookie, "mine@example.com");

    const mine = (await listLibraries(app, memberCookie)) as (Library & { mine: boolean })[];
    assert.deepEqual(
      mine.map((l) => [l.kind, l.mine]).sort(),
      [["family", false], ["private", true]],
    );

    // Once the Member is removed, their retained private Library is listed
    // to the Admin but is not the Admin's own.
    const members = (await (await app.fetch("/api/members", { headers: { cookie: adminCookie } })).json()) as {
      members: { id: number; email: string }[];
    };
    const target = members.members.find((m) => m.email === "mine@example.com")!;
    const removed = await app.fetch(`/api/members/${target.id}/remove`, {
      method: "POST",
      headers: { cookie: adminCookie },
      body: JSON.stringify({ action: "keep" }),
    });
    assert.equal(removed.status, 200);
    const adminView = (await listLibraries(app, adminCookie)) as (Library & { mine: boolean })[];
    assert.equal(adminView.filter((l) => l.kind === "private").length, 2);
    assert.equal(adminView.filter((l) => l.mine).length, 1);
  } finally {
    await app.stop();
  }
});
