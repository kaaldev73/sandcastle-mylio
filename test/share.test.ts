import assert from "node:assert/strict";
import { test } from "node:test";

import { makeJpeg, makePng } from "./helpers/images.ts";
import { startTestApp, sessionCookie, type TestApp } from "./helpers/harness.ts";

const PASSWORD = "correct-horse-battery";

interface Library {
  id: number;
  kind: "private" | "family";
}

interface Asset {
  id: number;
  filename: string;
  mimeType: string;
  byteSize: number;
  contentHash: string;
  originalUrl: string;
  thumbnailUrl: string;
}

async function setupAdmin(app: TestApp): Promise<string> {
  const res = await app.fetch("/api/setup", {
    method: "POST",
    body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }),
  });
  assert.equal(res.status, 201);
  return sessionCookie(res)!;
}

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

async function libraries(app: TestApp, cookie: string): Promise<Library[]> {
  const res = await app.fetch("/api/libraries", { headers: { cookie } });
  return ((await res.json()) as { libraries: Library[] }).libraries;
}

async function privateLibrary(app: TestApp, cookie: string): Promise<Library> {
  return (await libraries(app, cookie)).find((l) => l.kind === "private")!;
}

async function familyLibrary(app: TestApp, cookie: string): Promise<Library> {
  return (await libraries(app, cookie)).find((l) => l.kind === "family")!;
}

async function upload(
  app: TestApp,
  cookie: string,
  libraryId: number,
  bytes: Buffer,
  filename?: string,
): Promise<Asset> {
  const res = await app.fetch(`/api/libraries/${libraryId}/assets`, {
    method: "POST",
    headers: { cookie, ...(filename ? { "x-filename": filename } : {}) },
    body: bytes,
  });
  assert.equal(res.status, 201);
  return (await res.json()) as Asset;
}

/** List a Library's Assets as seen by the holder of `cookie`. */
async function listAssets(
  app: TestApp,
  cookie: string,
  libraryId: number,
): Promise<Asset[]> {
  const res = await app.fetch(`/api/libraries/${libraryId}/assets`, {
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { assets: Asset[] }).assets;
}

/** Share an Asset with a named mode, asserting the request succeeded. */
async function share(
  app: TestApp,
  cookie: string,
  assetId: number,
  mode: string,
): Promise<Response> {
  return app.fetch(`/api/assets/${assetId}/share`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ mode }),
  });
}

test("copying an Asset to the Family Library leaves a second Asset there and the private one intact", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const alicePrivate = await privateLibrary(app, aliceCookie);
    const family = await familyLibrary(app, aliceCookie);

    const bytes = await makeJpeg();
    const original = await upload(app, aliceCookie, alicePrivate.id, bytes, "beach.jpg");

    const res = await share(app, aliceCookie, original.id, "copy");
    assert.equal(res.status, 201);
    const answer = (await res.json()) as { action: string; asset: Asset };
    assert.equal(answer.action, "copied");

    // The Family Library now holds a second Asset with the same content…
    const shared = answer.asset;
    assert.notEqual(shared.id, original.id);
    assert.equal(shared.filename, "beach.jpg");
    assert.equal(shared.contentHash, original.contentHash);

    const familyAssets = await listAssets(app, aliceCookie, family.id);
    assert.ok(familyAssets.some((a) => a.id === shared.id));
    // …and the private Library keeps its own untouched.
    const privateAssets = await listAssets(app, aliceCookie, alicePrivate.id);
    assert.deepEqual(privateAssets.map((a) => a.id), [original.id]);
  } finally {
    await app.stop();
  }
});

test("a Member can hide their remaining private Assets from everyone else", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const bobCookie = await joinMember(app, adminCookie, "bob@example.com");
    const alicePrivate = await privateLibrary(app, aliceCookie);

    const privateBytes = await makePng();
    const keptPrivate = await upload(app, aliceCookie, alicePrivate.id, privateBytes, "personal.png");

    // Bob's own private Library is entirely elsewhere: not listed, nor openable.
    const bobPrivate = await privateLibrary(app, bobCookie);
    assert.notEqual(bobPrivate.id, alicePrivate.id);
    assert.equal(
      (await app.fetch(`/api/libraries/${alicePrivate.id}`, { headers: { cookie: bobCookie } }))
        .status,
      404,
    );
    // And Bob cannot reach the Asset Bob never saw by any of its addresses.
    assert.equal(
      (await app.fetch(keptPrivate.originalUrl, { headers: { cookie: bobCookie } })).status,
      404,
    );
    assert.equal(
      (await app.fetch(keptPrivate.thumbnailUrl, { headers: { cookie: bobCookie } })).status,
      404,
    );
  } finally {
    await app.stop();
  }
});

test("shared Assets appear for all Members in the Family Library, including thumbnails and originals", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const bobCookie = await joinMember(app, adminCookie, "bob@example.com");
    const alicePrivate = await privateLibrary(app, aliceCookie);
    const family = await familyLibrary(app, bobCookie);

    const bytes = await makeJpeg();
    const original = await upload(app, aliceCookie, alicePrivate.id, bytes, "beach.jpg");
    const copied = (await (
      await share(app, aliceCookie, original.id, "copy")
    ).json()) as { asset: Asset };

    // Another Member sees the same shared Asset in the Family Library and
    // can use it — original and thumbnail both.
    const bobFamily = await listAssets(app, bobCookie, family.id);
    assert.ok(bobFamily.some((a) => a.id === copied.asset.id));

    const dl = await app.fetch(copied.asset.originalUrl, {
      headers: { cookie: bobCookie },
    });
    assert.equal(dl.status, 200);
    assert.ok(Buffer.from(await dl.arrayBuffer()).equals(bytes));

    const thumb = await app.fetch(copied.asset.thumbnailUrl, {
      headers: { cookie: bobCookie },
    });
    assert.equal(thumb.status, 200);
  } finally {
    await app.stop();
  }
});

test("moving an Asset rehomes it: same id, gone from the private Library, seen in the Family one", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const alicePrivate = await privateLibrary(app, aliceCookie);
    const family = await familyLibrary(app, aliceCookie);

    const bytes = await makeJpeg();
    const original = await upload(app, aliceCookie, alicePrivate.id, bytes, "beach.jpg");

    const res = await share(app, aliceCookie, original.id, "move");
    assert.equal(res.status, 200);
    const answer = (await res.json()) as { action: string; asset: Asset };
    assert.equal(answer.action, "moved");
    assert.equal(answer.asset.id, original.id);

    const familyAssets = await listAssets(app, aliceCookie, family.id);
    assert.ok(familyAssets.some((a) => a.id === original.id));
    const privateAssets = await listAssets(app, aliceCookie, alicePrivate.id);
    assert.deepEqual(privateAssets.map((a) => a.id), []);

    // The moved Asset keeps everything: it still downloads byte-for-byte
    // under its existing address, with the filename it came in as.
    const dl = await app.fetch(original.originalUrl, {
      headers: { cookie: aliceCookie },
    });
    assert.equal(dl.status, 200);
    assert.ok(Buffer.from(await dl.arrayBuffer()).equals(bytes));
  } finally {
    await app.stop();
  }
});

test("only the Asset's owner can share it", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const bobCookie = await joinMember(app, adminCookie, "bob@example.com");
    const alicePrivate = await privateLibrary(app, aliceCookie);

    const original = await upload(app, aliceCookie, alicePrivate.id, await makeJpeg());

    // Bob cannot see Alice's private Asset, so the share attempt lands
    // exactly like a share of an Asset that does not exist.
    assert.equal((await share(app, bobCookie, original.id, "move")).status, 404);
    assert.equal((await share(app, bobCookie, original.id, "copy")).status, 404);

    // Nor does an Admin have the power: it is not their private Library.
    assert.equal((await share(app, adminCookie, original.id, "move")).status, 404);
  } finally {
    await app.stop();
  }
});

test("the Member's private Library stays private for everything not shared", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const bobCookie = await joinMember(app, adminCookie, "bob@example.com");
    const alicePrivate = await privateLibrary(app, aliceCookie);
    const family = await familyLibrary(app, bobCookie);

    const kept = await upload(app, aliceCookie, alicePrivate.id, await makePng(), "personal.png");
    const bytes = await makeJpeg();
    const shared = await upload(app, aliceCookie, alicePrivate.id, bytes, "beach.jpg");
    const shareRes = (await (
      await share(app, aliceCookie, shared.id, "copy")
    ).json()) as { asset: Asset };

    // Bob's Family Library view holds exactly the one shared photo.
    const familyAssets = await listAssets(app, bobCookie, family.id);
    assert.deepEqual(familyAssets.map((a) => a.id), [shareRes.asset.id]);
    assert.equal(
      (await app.fetch(kept.originalUrl, { headers: { cookie: bobCookie } })).status,
      404,
    );
  } finally {
    await app.stop();
  }
});

test("an Asset already in the Family Library cannot be shared again", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const bobCookie = await joinMember(app, adminCookie, "bob@example.com");
    const family = await familyLibrary(app, aliceCookie);

    const shared = await upload(app, aliceCookie, family.id, await makeJpeg());

    for (const cookie of [aliceCookie, bobCookie]) {
      const res = await share(app, cookie, shared.id, "move");
      assert.equal(res.status, 409);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "already_shared");
    }
  } finally {
    await app.stop();
  }
});

test("a retried copy returns the Asset already in the Family Library instead of doubling it", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const alicePrivate = await privateLibrary(app, aliceCookie);
    const family = await familyLibrary(app, aliceCookie);

    const original = await upload(app, aliceCookie, alicePrivate.id, await makeJpeg(), "beach.jpg");
    const first = await share(app, aliceCookie, original.id, "copy");
    const second = await share(app, aliceCookie, original.id, "copy");
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    const firstAsset = ((await first.json()) as { asset: Asset }).asset;
    const secondAsset = ((await second.json()) as { asset: Asset }).asset;
    assert.equal(secondAsset.id, firstAsset.id);

    const familyAssets = await listAssets(app, aliceCookie, family.id);
    assert.equal(familyAssets.length, 1);
  } finally {
    await app.stop();
  }
});

test("sharing without a mode — or with a nonsense one — is refused with a clear message", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const alicePrivate = await privateLibrary(app, aliceCookie);
    const original = await upload(app, aliceCookie, alicePrivate.id, await makeJpeg());

    for (const body of [JSON.stringify({}), JSON.stringify({ mode: "warp" })]) {
      const res = await app.fetch(`/api/assets/${original.id}/share`, {
        method: "POST",
        headers: { cookie: aliceCookie },
        body,
      });
      assert.equal(res.status, 400);
      const error = (await res.json()) as { error: string; message: string };
      assert.equal(error.error, "invalid_share");
      assert.match(error.message, /move/);
      assert.match(error.message, /copy/);
    }
  } finally {
    await app.stop();
  }
});

test("the explicit share URLs label the action themselves", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const alicePrivate = await privateLibrary(app, aliceCookie);

    const ownerOwn = await upload(app, aliceCookie, alicePrivate.id, await makeJpeg());
    const copyRes = await app.fetch(`/api/assets/${ownerOwn.id}/share/copy`, {
      method: "POST",
      headers: { cookie: aliceCookie },
      body: JSON.stringify({}),
    });
    assert.equal(copyRes.status, 201);
    const copyAnswer = (await copyRes.json()) as { action: string };
    assert.equal(copyAnswer.action, "copied");
  } finally {
    await app.stop();
  }
});

test("sharing an Asset requires authentication", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const alicePrivate = await privateLibrary(app, adminCookie);
    const original = await upload(app, adminCookie, alicePrivate.id, await makeJpeg());

    const res = await app.fetch(`/api/assets/${original.id}/share`, {
      method: "POST",
      body: JSON.stringify({ mode: "move" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await app.stop();
  }
});
