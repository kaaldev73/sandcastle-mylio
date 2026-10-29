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
  bytes: Buffer,
): Promise<Asset> {
  const res = await app.fetch(`/api/libraries/${libraryId}/assets`, {
    method: "POST",
    headers: { cookie, "x-filename": filename },
    body: bytes,
  });
  assert.equal(res.status, 201);
  return (await res.json()) as Asset;
}

async function post(app: TestApp, cookie: string, path: string, body: object) {
  return app.fetch(path, {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify(body),
  });
}

interface DupSet {
  contentHash: string;
  suggestedKeeperId: number;
  assets: Asset[];
}

async function dupes(app: TestApp, cookie: string, libraryId: number) {
  const res = await app.fetch(`/api/libraries/${libraryId}/duplicates`, {
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { sets: DupSet[] }).sets;
}

/** Two byte-identical Assets in the Family Library, via two moved shares. */
async function familyDuplicates(app: TestApp) {
  const admin = await setupAdmin(app);
  const bea = await joinMember(app, admin, "bea@example.com");
  const bytes = await makeJpeg();
  const family = (await libraries(app, admin)).find((l) => l.kind === "family")!;
  const a = await upload(app, admin, (await privateLibrary(app, admin)).id, "a.jpg", bytes);
  const b = await upload(app, bea, (await privateLibrary(app, bea)).id, "b.jpg", bytes);
  for (const [cookie, asset] of [[admin, a], [bea, b]] as const) {
    const res = await post(app, cookie, `/api/assets/${asset.id}/share`, { mode: "move" });
    assert.equal(res.status, 200);
  }
  return { admin, bea, family, a, b };
}

test("only byte-identical Assets are grouped, with a suggested keeper", async () => {
  const app = await startTestApp();
  try {
    const { admin, family, a, b } = await familyDuplicates(app);
    // A merely similar image is not a Duplicate.
    await upload(app, admin, family.id, "similar.jpg", await makeJpeg(121));

    // Rating the second copy makes it the suggested keeper.
    await app.fetch(`/api/assets/${b.id}/rating`, {
      method: "PATCH",
      headers: { cookie: admin },
      body: JSON.stringify({ stars: 4 }),
    });
    const sets = await dupes(app, admin, family.id);
    assert.equal(sets.length, 1);
    assert.deepEqual(sets[0]!.assets.map((x) => x.id).sort(), [a.id, b.id].sort());
    assert.equal(sets[0]!.suggestedKeeperId, b.id);
  } finally {
    await app.stop();
  }
});

test("resolving needs confirmation, merges Ratings and Albums, and makes copies recoverable", async () => {
  const app = await startTestApp();
  try {
    const { admin, family, a, b } = await familyDuplicates(app);
    const rate = (id: number, body: object) =>
      app.fetch(`/api/assets/${id}/rating`, {
        method: "PATCH",
        headers: { cookie: admin },
        body: JSON.stringify(body),
      });
    await rate(a.id, { stars: 5 });
    await rate(b.id, { flag: "pick" });
    const album = (await (await post(app, admin, `/api/libraries/${family.id}/albums`, { name: "Trip" })).json()) as { id: number };
    await post(app, admin, `/api/albums/${album.id}/assets`, { assetId: b.id });

    const path = `/api/libraries/${family.id}/duplicates/resolve`;
    const unconfirmed = await post(app, admin, path, { keeperId: a.id });
    assert.equal(unconfirmed.status, 400);
    assert.equal((await dupes(app, admin, family.id)).length, 1);

    const res = await post(app, admin, path, { keeperId: a.id, confirm: true });
    assert.equal(res.status, 200);
    const kept = ((await res.json()) as { kept: Asset }).kept;
    assert.equal(kept.id, a.id);
    assert.equal(kept.stars, 5);
    assert.equal(kept.flag, "pick");

    assert.equal((await dupes(app, admin, family.id)).length, 0);
    const albumRes = await app.fetch(`/api/albums/${album.id}`, { headers: { cookie: admin } });
    const inAlbum = ((await albumRes.json()) as { assets: Asset[] }).assets;
    assert.deepEqual(inAlbum.map((x) => x.id), [a.id]);

    const trash = await app.fetch(`/api/libraries/${family.id}/deleted`, { headers: { cookie: admin } });
    assert.deepEqual(((await trash.json()) as { assets: Asset[] }).assets.map((x) => x.id), [b.id]);
    assert.equal((await post(app, admin, `/api/assets/${b.id}/restore`, {})).status, 200);
  } finally {
    await app.stop();
  }
});

test("resolving a non-duplicate or another Library's Asset is refused", async () => {
  const app = await startTestApp();
  try {
    const { admin, bea, family, a } = await familyDuplicates(app);
    const solo = await upload(app, admin, family.id, "solo.jpg", await makeJpeg(130));
    const path = `/api/libraries/${family.id}/duplicates/resolve`;
    assert.equal((await post(app, admin, path, { keeperId: solo.id, confirm: true })).status, 409);
    assert.equal((await post(app, "", path, { keeperId: a.id, confirm: true })).status, 401);
    const beaPrivate = await privateLibrary(app, bea);
    const res = await app.fetch(`/api/libraries/${beaPrivate.id}/duplicates`, { headers: { cookie: admin } });
    assert.equal(res.status, 404);
  } finally {
    await app.stop();
  }
});
