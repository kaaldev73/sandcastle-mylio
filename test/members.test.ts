import assert from "node:assert/strict";
import { test } from "node:test";

import { makeJpeg } from "./helpers/images.ts";
import { startTestApp, sessionCookie, type TestApp } from "./helpers/harness.ts";

const PASSWORD = "correct-horse-battery";
const ADMIN_EMAIL = "admin@example.com";

interface Library {
  id: number;
  kind: "private" | "family";
}

interface Member {
  id: number;
  email: string;
  role: "admin" | "member";
}

interface Asset {
  id: number;
  originalUrl: string;
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

/** Admin invites an email, the invitee accepts; returns member and cookie. */
async function joinMember(
  app: TestApp,
  adminCookie: string,
  email: string,
): Promise<{ member: Member; cookie: string }> {
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
  return {
    member: (await accepted.json()) as Member,
    cookie: sessionCookie(accepted)!,
  };
}

async function listLibraries(app: TestApp, cookie: string): Promise<Library[]> {
  const res = await app.fetch("/api/libraries", { headers: { cookie } });
  assert.equal(res.status, 200);
  return ((await res.json()) as { libraries: Library[] }).libraries;
}

async function privateLibrary(app: TestApp, cookie: string): Promise<Library> {
  return (await listLibraries(app, cookie)).find((l) => l.kind === "private")!;
}

async function familyLibrary(app: TestApp, cookie: string): Promise<Library> {
  return (await listLibraries(app, cookie)).find((l) => l.kind === "family")!;
}

async function listMembers(app: TestApp, cookie: string): Promise<Member[]> {
  const res = await app.fetch("/api/members", { headers: { cookie } });
  assert.equal(res.status, 200);
  return ((await res.json()) as { members: Member[] }).members;
}

async function upload(
  app: TestApp,
  cookie: string,
  libraryId: number,
): Promise<Asset> {
  const res = await app.fetch(`/api/libraries/${libraryId}/assets`, {
    method: "POST",
    headers: { cookie, "x-filename": "photo.jpg" },
    body: await makeJpeg(),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as Asset;
}

async function assetIds(
  app: TestApp,
  cookie: string,
  libraryId: number,
): Promise<number[]> {
  const res = await app.fetch(`/api/libraries/${libraryId}/assets`, {
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { assets: Asset[] }).assets.map((a) => a.id);
}

function removeMember(
  app: TestApp,
  cookie: string,
  memberId: number,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return app.fetch(`/api/members/${memberId}`, {
    method: "DELETE",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function login(
  app: TestApp,
  email: string,
  password = PASSWORD,
): Promise<Response> {
  return app.fetch("/api/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

test("an Admin can list the active Members", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const { member } = await joinMember(app, adminCookie, "mem@example.com");

    const members = await listMembers(app, adminCookie);
    assert.deepEqual(
      members.map((m) => m.email).sort(),
      [ADMIN_EMAIL, "mem@example.com"],
    );
    assert.ok(members.some((m) => m.id === member.id));
  } finally {
    await app.stop();
  }
});

test("only an Admin can list or remove Members", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const { member, cookie: memberCookie } = await joinMember(
      app,
      adminCookie,
      "mem@example.com",
    );

    assert.equal((await app.fetch("/api/members")).status, 401);
    assert.equal(
      (await app.fetch("/api/members", { headers: { cookie: memberCookie } }))
        .status,
      403,
    );

    assert.equal(
      (await app.fetch(`/api/members/${member.id}`, { method: "DELETE" }))
        .status,
      401,
    );
    assert.equal(
      (await removeMember(app, memberCookie, member.id)).status,
      403,
    );
  } finally {
    await app.stop();
  }
});

test("a removed Member can no longer log in, and their sessions are ended", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const { member, cookie: memberCookie } = await joinMember(
      app,
      adminCookie,
      "mem@example.com",
    );

    const res = await removeMember(app, adminCookie, member.id);
    assert.equal(res.status, 200);

    // The session held before removal is invalid immediately.
    assert.equal(
      (await app.fetch("/api/me", { headers: { cookie: memberCookie } })).status,
      401,
    );
    // And no new login is possible.
    assert.equal((await login(app, "mem@example.com")).status, 401);
    // The removed Member disappears from the Member list.
    assert.ok(!(await listMembers(app, adminCookie)).some((m) => m.id === member.id));
  } finally {
    await app.stop();
  }
});

test("by default removal keeps the private Library and its Assets", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const { member, cookie: memberCookie } = await joinMember(
      app,
      adminCookie,
      "mem@example.com",
    );
    const library = await privateLibrary(app, memberCookie);
    const asset = await upload(app, memberCookie, library.id);

    const res = await removeMember(app, adminCookie, member.id);
    assert.equal(res.status, 200);

    // The Library is retained and remains available to the Admin, with its
    // original intact, so the default removes access but loses no data.
    const retained = (await listLibraries(app, adminCookie)).find(
      (l) => l.id === library.id,
    );
    assert.ok(retained, "retained private Library should still be listed");
    assert.equal(retained.kind, "private");
    assert.deepEqual(await assetIds(app, adminCookie, library.id), [asset.id]);
    assert.equal(
      (await app.fetch(asset.originalUrl, { headers: { cookie: adminCookie } }))
        .status,
      200,
    );
  } finally {
    await app.stop();
  }
});

test("transfer moves the private Library's Assets into the Family Library", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const { member, cookie: memberCookie } = await joinMember(
      app,
      adminCookie,
      "mem@example.com",
    );
    const privateLib = await privateLibrary(app, memberCookie);
    const family = await familyLibrary(app, memberCookie);
    const asset = await upload(app, memberCookie, privateLib.id);

    const res = await removeMember(app, adminCookie, member.id, {
      library: "transfer",
    });
    assert.equal(res.status, 200);

    assert.ok((await assetIds(app, adminCookie, family.id)).includes(asset.id));
    assert.equal(
      (await app.fetch(`/api/libraries/${privateLib.id}`, {
        headers: { cookie: adminCookie },
      })).status,
      404,
    );
    assert.equal((await login(app, "mem@example.com")).status, 401);
  } finally {
    await app.stop();
  }
});

test("deleting the Library needs explicit confirmation", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const { member, cookie: memberCookie } = await joinMember(
      app,
      adminCookie,
      "mem@example.com",
    );
    const library = await privateLibrary(app, memberCookie);
    const asset = await upload(app, memberCookie, library.id);

    const unconfirmed = await removeMember(app, adminCookie, member.id, {
      library: "delete",
    });
    assert.equal(unconfirmed.status, 400);

    // Nothing was removed: the Member can still log in and the Asset is there.
    assert.equal((await login(app, "mem@example.com")).status, 200);
    assert.deepEqual(await assetIds(app, memberCookie, library.id), [asset.id]);

    const confirmed = await removeMember(app, adminCookie, member.id, {
      library: "delete",
      confirm: true,
    });
    assert.equal(confirmed.status, 200);

    assert.equal((await login(app, "mem@example.com")).status, 401);
    assert.equal(
      (await app.fetch(`/api/libraries/${library.id}`, {
        headers: { cookie: adminCookie },
      })).status,
      404,
    );
    assert.equal(
      (await app.fetch(asset.originalUrl, { headers: { cookie: adminCookie } }))
        .status,
      404,
    );
  } finally {
    await app.stop();
  }
});

test("removing a Member leaves Assets they uploaded to the Family Library alone", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const { member, cookie: memberCookie } = await joinMember(
      app,
      adminCookie,
      "mem@example.com",
    );
    const privateLib = await privateLibrary(app, memberCookie);
    const family = await familyLibrary(app, memberCookie);
    const shared = await upload(app, memberCookie, family.id);

    const res = await removeMember(app, adminCookie, member.id, {
      library: "delete",
      confirm: "delete",
    });
    assert.equal(res.status, 200);

    assert.ok((await assetIds(app, adminCookie, family.id)).includes(shared.id));
    assert.equal(
      (await app.fetch(`/api/libraries/${privateLib.id}`, {
        headers: { cookie: adminCookie },
      })).status,
      404,
    );
  } finally {
    await app.stop();
  }
});

test("an Admin cannot remove themselves", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const me = (await (
      await app.fetch("/api/me", { headers: { cookie: adminCookie } })
    ).json()) as Member;

    const res = await removeMember(app, adminCookie, me.id);
    assert.equal(res.status, 409);
    assert.ok((await listMembers(app, adminCookie)).some((m) => m.id === me.id));
  } finally {
    await app.stop();
  }
});

test("removing an unknown or already removed Member is a 404", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const { member } = await joinMember(app, adminCookie, "mem@example.com");

    assert.equal((await removeMember(app, adminCookie, 999999)).status, 404);
    assert.equal(
      (await removeMember(app, adminCookie, member.id)).status,
      200,
    );
    assert.equal(
      (await removeMember(app, adminCookie, member.id)).status,
      404,
    );
  } finally {
    await app.stop();
  }
});
