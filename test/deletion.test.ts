import assert from "node:assert/strict";
import { test } from "node:test";

import { makeJpeg } from "./helpers/images.ts";
import { startTestApp, sessionCookie, type TestApp } from "./helpers/harness.ts";

const PASSWORD = "correct-horse-battery";

interface Library {
  id: number;
  kind: "private" | "family";
}

interface Asset {
  id: number;
  filename: string;
  flag: "pick" | "reject" | "unflagged";
  stars: number;
  deleted: boolean;
  deletedAt: string | null;
  originalUrl: string;
}

interface Album {
  id: number;
  name: string;
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

async function upload(
  app: TestApp,
  cookie: string,
  libraryId: number,
  filename: string,
): Promise<Asset> {
  const res = await app.fetch(`/api/libraries/${libraryId}/assets`, {
    method: "POST",
    headers: { cookie, "x-filename": filename },
    body: await makeJpeg(),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as Asset;
}

async function list(
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

async function deleted(
  app: TestApp,
  cookie: string,
  libraryId: number,
): Promise<Asset[]> {
  const res = await app.fetch(`/api/libraries/${libraryId}/deleted`, {
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { assets: Asset[] }).assets;
}

function remove(
  app: TestApp,
  cookie: string,
  assetId: number,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return app.fetch(`/api/assets/${assetId}`, {
    method: "DELETE",
    headers: { cookie },
    body: JSON.stringify(body),
  });
}

function restore(
  app: TestApp,
  cookie: string,
  assetId: number,
): Promise<Response> {
  return app.fetch(`/api/assets/${assetId}/restore`, {
    method: "POST",
    headers: { cookie },
  });
}

function purge(
  app: TestApp,
  cookie: string,
  assetId: number,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return app.fetch(`/api/assets/${assetId}/permanent`, {
    method: "DELETE",
    headers: { cookie },
    body: JSON.stringify(body),
  });
}

test("deleting an Asset requires confirmation and hides it from the Timeline and grid", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const asset = await upload(app, cookie, lib.id, "holiday.jpg");

    const unconfirmed = await remove(app, cookie, asset.id);
    assert.equal(unconfirmed.status, 400);
    assert.equal(
      ((await unconfirmed.json()) as { error: string }).error,
      "confirmation_required",
    );
    assert.equal((await list(app, cookie, lib.id)).length, 1);
    assert.equal((await deleted(app, cookie, lib.id)).length, 0);

    const removed = await remove(app, cookie, asset.id, { confirm: true });
    assert.equal(removed.status, 200);
    const body = (await removed.json()) as Asset;
    assert.equal(body.deleted, true);
    assert.ok(body.deletedAt);

    assert.equal((await list(app, cookie, lib.id)).length, 0);
    const timeline = await app.fetch(
      `/api/libraries/${lib.id}/timeline?level=year`,
      { headers: { cookie } },
    );
    assert.equal(timeline.status, 200);
    assert.equal(((await timeline.json()) as { total: number }).total, 0);

    // The recoverable Asset is still listed in the deleted view, and its
    // original is untouched until permanent removal.
    const trash = await deleted(app, cookie, lib.id);
    assert.deepEqual(
      trash.map((a) => a.id),
      [asset.id],
    );
    assert.equal(
      (await app.fetch(asset.originalUrl, { headers: { cookie } })).status,
      200,
    );
  } finally {
    await app.stop();
  }
});

test("restoring an Asset brings back its Rating and Album memberships", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const asset = await upload(app, cookie, lib.id, "favourite.jpg");

    const created = await app.fetch(`/api/libraries/${lib.id}/albums`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "Best of" }),
    });
    assert.equal(created.status, 201);
    const album = (await created.json()) as Album;

    const added = await app.fetch(`/api/albums/${album.id}/assets`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ assetId: asset.id }),
    });
    assert.equal(added.status, 200);

    const rated = await app.fetch(`/api/assets/${asset.id}/rating`, {
      method: "PATCH",
      headers: { cookie },
      body: JSON.stringify({ flag: "pick", stars: 5 }),
    });
    assert.equal(rated.status, 200);

    assert.equal((await remove(app, cookie, asset.id, { confirm: true })).status, 200);
    assert.equal(
      (await app.fetch(`/api/albums/${album.id}`, { headers: { cookie } })).status,
      200,
    );
    const whileDeleted = (await (
      await app.fetch(`/api/albums/${album.id}`, { headers: { cookie } })
    ).json()) as Album;
    assert.equal(whileDeleted.assets.length, 0, "deleted Assets leave Album views");

    const restored = await restore(app, cookie, asset.id);
    assert.equal(restored.status, 200);
    const body = (await restored.json()) as Asset;
    assert.equal(body.deleted, false);
    assert.equal(body.deletedAt, null);
    assert.equal(body.flag, "pick");
    assert.equal(body.stars, 5);

    const assets = await list(app, cookie, lib.id);
    assert.deepEqual(
      assets.map((a) => a.id),
      [asset.id],
    );
    const inAlbum = (await (
      await app.fetch(`/api/albums/${album.id}`, { headers: { cookie } })
    ).json()) as Album;
    assert.deepEqual(
      inAlbum.assets.map((a) => a.id),
      [asset.id],
    );
    assert.equal((await deleted(app, cookie, lib.id)).length, 0);
  } finally {
    await app.stop();
  }
});

test("permanent removal is a separate confirmed step that deletes the original", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const asset = await upload(app, cookie, lib.id, "oops.jpg");

    assert.equal((await remove(app, cookie, asset.id, { confirm: true })).status, 200);

    const unconfirmed = await purge(app, cookie, asset.id);
    assert.equal(unconfirmed.status, 400);
    assert.equal(
      ((await unconfirmed.json()) as { error: string }).error,
      "confirmation_required",
    );
    assert.equal((await deleted(app, cookie, lib.id)).length, 1);

    const purged = await purge(app, cookie, asset.id, { confirm: true });
    assert.equal(purged.status, 200);

    assert.equal((await deleted(app, cookie, lib.id)).length, 0);
    assert.equal(
      (await app.fetch(asset.originalUrl, { headers: { cookie } })).status,
      404,
    );
    assert.equal((await restore(app, cookie, asset.id)).status, 404);
  } finally {
    await app.stop();
  }
});

test("permanent removal keeps a shared original while another Asset still uses it", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const family = (await libraries(app, cookie)).find(
      (l) => l.kind === "family",
    )!;
    const bytes = await makeJpeg();

    const uploadBytes = async (libraryId: number): Promise<Asset> => {
      const res = await app.fetch(`/api/libraries/${libraryId}/assets`, {
        method: "POST",
        headers: { cookie, "x-filename": "same.jpg" },
        body: bytes,
      });
      assert.equal(res.status, 201);
      return (await res.json()) as Asset;
    };

    const privateCopy = await uploadBytes(lib.id);
    const familyCopy = await uploadBytes(family.id);
    assert.notEqual(privateCopy.id, familyCopy.id);

    assert.equal((await remove(app, cookie, privateCopy.id, { confirm: true })).status, 200);
    assert.equal((await purge(app, cookie, privateCopy.id, { confirm: true })).status, 200);

    const download = await app.fetch(familyCopy.originalUrl, {
      headers: { cookie },
    });
    assert.equal(download.status, 200);
    assert.ok(Buffer.from(await download.arrayBuffer()).equals(bytes));
  } finally {
    await app.stop();
  }
});

test("a Member cannot delete, restore, purge or list another Member's private Assets", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const bobCookie = await joinMember(app, adminCookie, "bob@example.com");
    const bobPrivate = await privateLibrary(app, bobCookie);
    const asset = await upload(app, bobCookie, bobPrivate.id, "bob.jpg");

    assert.equal((await remove(app, "", asset.id, { confirm: true })).status, 401);
    assert.equal(
      (await remove(app, aliceCookie, asset.id, { confirm: true })).status,
      404,
    );
    assert.equal((await restore(app, aliceCookie, asset.id)).status, 404);
    assert.equal(
      (await purge(app, aliceCookie, asset.id, { confirm: true })).status,
      404,
    );
    assert.equal(
      (
        await app.fetch(`/api/libraries/${bobPrivate.id}/deleted`, {
          headers: { cookie: aliceCookie },
        })
      ).status,
      404,
    );

    // Bob's Asset is untouched by the failed attempts.
    assert.equal((await list(app, bobCookie, bobPrivate.id)).length, 1);
  } finally {
    await app.stop();
  }
});

test("deleting removes an Asset from Album counts and the review queue", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const asset = await upload(app, cookie, lib.id, "queue.jpg");

    const album = (await (
      await app.fetch(`/api/libraries/${lib.id}/albums`, {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ name: "Queue" }),
      })
    ).json()) as Album;
    await app.fetch(`/api/albums/${album.id}/assets`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ assetId: asset.id }),
    });

    assert.equal((await remove(app, cookie, asset.id, { confirm: true })).status, 200);

    const albums = await app.fetch(`/api/libraries/${lib.id}/albums`, {
      headers: { cookie },
    });
    const listBody = (await albums.json()) as {
      albums: { id: number; assetCount: number }[];
    };
    assert.equal(listBody.albums[0].assetCount, 0);

    const review = await app.fetch(`/api/libraries/${lib.id}/review`, {
      headers: { cookie },
    });
    assert.equal(review.status, 200);
    assert.equal(((await review.json()) as { total: number }).total, 0);
  } finally {
    await app.stop();
  }
});
