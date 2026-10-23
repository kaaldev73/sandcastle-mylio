import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
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
  originalUrl: string;
}

interface AlbumSummary {
  id: number;
  name: string;
  libraryId: number;
  assetCount: number;
}

interface Album extends AlbumSummary {
  assets: Asset[];
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
  filename: string,
): Promise<Asset> {
  const res = await app.fetch(`/api/libraries/${libraryId}/assets`, {
    method: "POST",
    headers: { cookie, "x-filename": filename },
    body: bytes,
  });
  assert.equal(res.status, 201);
  return (await res.json()) as Asset;
}

async function createAlbum(
  app: TestApp,
  cookie: string,
  libraryId: number,
  name: string,
): Promise<Album> {
  const res = await app.fetch(`/api/libraries/${libraryId}/albums`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ name }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as Album;
}

async function listAlbums(
  app: TestApp,
  cookie: string,
  libraryId: number,
): Promise<AlbumSummary[]> {
  const res = await app.fetch(`/api/libraries/${libraryId}/albums`, {
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { albums: AlbumSummary[] }).albums;
}

async function openAlbum(
  app: TestApp,
  cookie: string,
  albumId: number,
): Promise<Album> {
  const res = await app.fetch(`/api/albums/${albumId}`, {
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Album;
}

async function addAsset(
  app: TestApp,
  cookie: string,
  albumId: number,
  assetId: number,
): Promise<Album> {
  const res = await app.fetch(`/api/albums/${albumId}/assets`, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({ assetId }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Album;
}

async function removeAsset(
  app: TestApp,
  cookie: string,
  albumId: number,
  assetId: number,
): Promise<Album> {
  const res = await app.fetch(`/api/albums/${albumId}/assets/${assetId}`, {
    method: "DELETE",
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Album;
}

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

test("a Member creates, lists and renames an Album inside a Library", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);

    const created = await createAlbum(app, cookie, lib.id, "Summer");
    assert.equal(created.name, "Summer");
    assert.equal(created.libraryId, lib.id);
    assert.equal(created.assetCount, 0);
    assert.deepEqual(created.assets, []);

    const listed = await listAlbums(app, cookie, lib.id);
    assert.deepEqual(
      listed.map((a) => ({ id: a.id, name: a.name, assetCount: a.assetCount })),
      [{ id: created.id, name: "Summer", assetCount: 0 }],
    );

    const renamed = await app.fetch(`/api/albums/${created.id}`, {
      method: "PATCH",
      headers: { cookie },
      body: JSON.stringify({ name: "Summer 2024" }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as Album).name, "Summer 2024");
    assert.equal((await openAlbum(app, cookie, created.id)).name, "Summer 2024");

    const blank = await app.fetch(`/api/libraries/${lib.id}/albums`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "   " }),
    });
    assert.equal(blank.status, 400);
  } finally {
    await app.stop();
  }
});

test("adding and removing an Asset never copies or deletes its file", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const bytes = await makeJpeg();
    const asset = await upload(app, cookie, lib.id, bytes, "holiday.jpg");
    const album = await createAlbum(app, cookie, lib.id, "Trip");

    const before = readdirSync(app.originalsDir).sort();

    const added = await addAsset(app, cookie, album.id, asset.id);
    assert.equal(added.assetCount, 1);
    assert.deepEqual(added.assets.map((a) => a.id), [asset.id]);
    assert.deepEqual(readdirSync(app.originalsDir).sort(), before);

    // The Asset is still in the Library, unchanged and downloadable.
    assert.ok((await listAssets(app, cookie, lib.id)).some((a) => a.id === asset.id));
    const dl = await app.fetch(asset.originalUrl, { headers: { cookie } });
    assert.equal(dl.status, 200);
    assert.ok(Buffer.from(await dl.arrayBuffer()).equals(bytes));

    const removed = await removeAsset(app, cookie, album.id, asset.id);
    assert.equal(removed.assetCount, 0);
    assert.deepEqual(removed.assets, []);
    assert.ok((await listAssets(app, cookie, lib.id)).some((a) => a.id === asset.id));
    assert.deepEqual(readdirSync(app.originalsDir).sort(), before);
  } finally {
    await app.stop();
  }
});

test("deleting an Album removes only the grouping and leaves its Assets in the Library", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const first = await upload(app, cookie, lib.id, await makeJpeg(), "one.jpg");
    const second = await upload(app, cookie, lib.id, await makePng(), "two.png");
    const album = await createAlbum(app, cookie, lib.id, "Keepers");
    await addAsset(app, cookie, album.id, first.id);
    await addAsset(app, cookie, album.id, second.id);

    const del = await app.fetch(`/api/albums/${album.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(del.status, 204);

    assert.equal(
      (await app.fetch(`/api/albums/${album.id}`, { headers: { cookie } })).status,
      404,
    );
    const libraryAssets = await listAssets(app, cookie, lib.id);
    assert.deepEqual(libraryAssets.map((a) => a.id).sort(), [first.id, second.id].sort());

    for (const asset of [first, second]) {
      const dl = await app.fetch(asset.originalUrl, { headers: { cookie } });
      assert.equal(dl.status, 200);
    }
  } finally {
    await app.stop();
  }
});

test("one Asset can be in many Albums without being duplicated", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const asset = await upload(app, cookie, lib.id, await makeJpeg(), "shared.jpg");
    const first = await createAlbum(app, cookie, lib.id, "First");
    const second = await createAlbum(app, cookie, lib.id, "Second");

    await addAsset(app, cookie, first.id, asset.id);
    await addAsset(app, cookie, second.id, asset.id);
    // Adding twice is a no-op, not a duplicate membership.
    const again = await addAsset(app, cookie, first.id, asset.id);
    assert.equal(again.assetCount, 1);
    assert.deepEqual(again.assets.map((a) => a.id), [asset.id]);

    assert.deepEqual(
      (await openAlbum(app, cookie, first.id)).assets.map((a) => a.id),
      [asset.id],
    );
    assert.deepEqual(
      (await openAlbum(app, cookie, second.id)).assets.map((a) => a.id),
      [asset.id],
    );

    await removeAsset(app, cookie, first.id, asset.id);
    assert.deepEqual((await openAlbum(app, cookie, first.id)).assets, []);
    assert.deepEqual(
      (await openAlbum(app, cookie, second.id)).assets.map((a) => a.id),
      [asset.id],
    );
    assert.ok((await listAssets(app, cookie, lib.id)).some((a) => a.id === asset.id));
  } finally {
    await app.stop();
  }
});

test("an Asset can only join an Album in its own Library", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const privateLib = await privateLibrary(app, cookie);
    const family = await familyLibrary(app, cookie);
    const privateAsset = await upload(app, cookie, privateLib.id, await makeJpeg(), "private.jpg");
    const familyAlbum = await createAlbum(app, cookie, family.id, "Family");

    const res = await app.fetch(`/api/albums/${familyAlbum.id}/assets`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ assetId: privateAsset.id }),
    });
    assert.equal(res.status, 404);
    assert.equal((await openAlbum(app, cookie, familyAlbum.id)).assetCount, 0);
  } finally {
    await app.stop();
  }
});

test("Albums are private to Members who can access their Library", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const bobCookie = await joinMember(app, adminCookie, "bob@example.com");
    const bobPrivate = await privateLibrary(app, bobCookie);
    const album = await createAlbum(app, bobCookie, bobPrivate.id, "Bob's trip");

    const requests: Promise<Response>[] = [
      app.fetch(`/api/libraries/${bobPrivate.id}/albums`, {
        headers: { cookie: aliceCookie },
      }),
      app.fetch(`/api/libraries/${bobPrivate.id}/albums`, {
        method: "POST",
        headers: { cookie: aliceCookie },
        body: JSON.stringify({ name: "Sneaky" }),
      }),
      app.fetch(`/api/albums/${album.id}`, { headers: { cookie: aliceCookie } }),
      app.fetch(`/api/albums/${album.id}`, {
        method: "PATCH",
        headers: { cookie: aliceCookie },
        body: JSON.stringify({ name: "Taken over" }),
      }),
      app.fetch(`/api/albums/${album.id}`, {
        method: "DELETE",
        headers: { cookie: aliceCookie },
      }),
      app.fetch(`/api/albums/${album.id}/assets`, {
        method: "POST",
        headers: { cookie: aliceCookie },
        body: JSON.stringify({ assetId: 1 }),
      }),
    ];
    for (const res of await Promise.all(requests)) assert.equal(res.status, 404);

    // The Admin has no special access either (ADR 0003).
    assert.equal(
      (await app.fetch(`/api/albums/${album.id}`, { headers: { cookie: adminCookie } })).status,
      404,
    );
  } finally {
    await app.stop();
  }
});

test("Album endpoints require authentication and 404 on unknown Albums or Assets", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const album = await createAlbum(app, cookie, lib.id, "Photos");

    const unauth = [
      await app.fetch(`/api/libraries/${lib.id}/albums`),
      await app.fetch(`/api/libraries/${lib.id}/albums`, {
        method: "POST",
        body: JSON.stringify({ name: "No" }),
      }),
      await app.fetch(`/api/albums/${album.id}`),
      await app.fetch(`/api/albums/${album.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "No" }),
      }),
      await app.fetch(`/api/albums/${album.id}`, { method: "DELETE" }),
      await app.fetch(`/api/albums/${album.id}/assets`, {
        method: "POST",
        body: JSON.stringify({ assetId: 1 }),
      }),
    ];
    for (const res of unauth) assert.equal(res.status, 401);

    assert.equal(
      (await app.fetch("/api/albums/999999", { headers: { cookie } })).status,
      404,
    );
    assert.equal(
      (
        await app.fetch(`/api/albums/${album.id}/assets`, {
          method: "POST",
          headers: { cookie },
          body: JSON.stringify({ assetId: 999999 }),
        })
      ).status,
      404,
    );
  } finally {
    await app.stop();
  }
});
