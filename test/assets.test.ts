import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import sharp from "sharp";

import { makeJpeg, makeJpegWithCaptureDate, makePng } from "./helpers/images.ts";
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
  captureDate: string;
  captureSource: "exif" | "file";
  thumbnailUrl: string;
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

async function joinMember(app: TestApp, adminCookie: string, email: string): Promise<string> {
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

interface UploadHeaders {
  filename?: string;
  fileModifiedMs?: number;
}

function upload(
  app: TestApp,
  cookie: string,
  libraryId: number,
  bytes: Buffer,
  extra: UploadHeaders = {},
): Promise<Response> {
  const headers: Record<string, string> = { cookie };
  if (extra.filename) headers["x-filename"] = extra.filename;
  if (extra.fileModifiedMs) headers["x-file-modified-ms"] = String(extra.fileModifiedMs);
  return app.fetch(`/api/libraries/${libraryId}/assets`, {
    method: "POST",
    headers,
    body: bytes,
  });
}

test("Upload stores the original byte-for-byte, records its content hash, and downloads identically", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const bytes = await makeJpeg();

    const res = await upload(app, cookie, lib.id, bytes, { filename: "holiday.jpg" });
    assert.equal(res.status, 201);
    const asset = (await res.json()) as Asset;
    assert.equal(asset.filename, "holiday.jpg");
    assert.equal(asset.mimeType, "image/jpeg");
    assert.equal(asset.byteSize, bytes.length);
    assert.equal(asset.contentHash, createHash("sha256").update(bytes).digest("hex"));

    const dl = await app.fetch(asset.originalUrl, { headers: { cookie } });
    assert.equal(dl.status, 200);
    const downloaded = Buffer.from(await dl.arrayBuffer());
    assert.ok(downloaded.equals(bytes), "downloaded original must be byte-for-byte identical");
  } finally {
    await app.stop();
  }
});

test("a thumbnail is generated and shown in the grid", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const uploaded = (await (await upload(app, cookie, lib.id, await makePng())).json()) as Asset;

    // The grid lists the Asset with a thumbnail reference.
    const listRes = await app.fetch(`/api/libraries/${lib.id}/assets`, { headers: { cookie } });
    assert.equal(listRes.status, 200);
    const { assets } = (await listRes.json()) as { assets: Asset[] };
    assert.equal(assets.length, 1);
    assert.equal(assets[0].id, uploaded.id);
    assert.equal(assets[0].thumbnailUrl, `/api/assets/${uploaded.id}/thumbnail`);

    // The thumbnail is a real, smaller image.
    const thumbRes = await app.fetch(uploaded.thumbnailUrl, { headers: { cookie } });
    assert.equal(thumbRes.status, 200);
    const thumb = Buffer.from(await thumbRes.arrayBuffer());
    const meta = await sharp(thumb).metadata();
    assert.ok((meta.width ?? 0) <= 256 && (meta.height ?? 0) <= 256);
    assert.ok(meta.width! > 0 && meta.height! > 0);
  } finally {
    await app.stop();
  }
});

test("capture date is read from the file's EXIF when present", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const bytes = await makeJpegWithCaptureDate("2021:06:15 10:30:00");

    const asset = (await (await upload(app, cookie, lib.id, bytes)).json()) as Asset;
    assert.equal(asset.captureSource, "exif");
    assert.equal(asset.captureDate, "2021-06-15T10:30:00.000Z");
  } finally {
    await app.stop();
  }
});

test("capture date falls back to the file date when the file carries none", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const fileModifiedMs = Date.UTC(2019, 0, 2, 3, 4, 5); // PNG has no capture date

    const asset = (await (
      await upload(app, cookie, lib.id, await makePng(), { fileModifiedMs })
    ).json()) as Asset;
    assert.equal(asset.captureSource, "file");
    assert.equal(asset.captureDate, new Date(fileModifiedMs).toISOString());
  } finally {
    await app.stop();
  }
});

test("an unsupported file is rejected", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const res = await upload(app, cookie, lib.id, Buffer.from("this is not an image"));
    assert.equal(res.status, 415);
  } finally {
    await app.stop();
  }
});

test("a Member can Upload to and view the Family Library", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const memberCookie = await joinMember(app, adminCookie, "mem@example.com");
    const family = await familyLibrary(app, memberCookie);

    const asset = (await (
      await upload(app, memberCookie, family.id, await makeJpeg())
    ).json()) as Asset;

    // The Admin sees the same shared Asset in the Family Library.
    const listRes = await app.fetch(`/api/libraries/${family.id}/assets`, {
      headers: { cookie: adminCookie },
    });
    const { assets } = (await listRes.json()) as { assets: Asset[] };
    assert.ok(assets.some((a) => a.id === asset.id));
  } finally {
    await app.stop();
  }
});

test("a Member cannot Upload into another Member's private Library", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const bobCookie = await joinMember(app, adminCookie, "bob@example.com");
    const bobPrivate = await privateLibrary(app, bobCookie);

    const res = await upload(app, aliceCookie, bobPrivate.id, await makeJpeg());
    assert.equal(res.status, 404);
  } finally {
    await app.stop();
  }
});

test("a Member cannot view, download or thumbnail an Asset in another Member's private Library", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const bobCookie = await joinMember(app, adminCookie, "bob@example.com");
    const bobPrivate = await privateLibrary(app, bobCookie);

    const asset = (await (
      await upload(app, bobCookie, bobPrivate.id, await makeJpeg())
    ).json()) as Asset;

    // Alice cannot list Bob's Library, nor reach his Asset by id.
    assert.equal(
      (await app.fetch(`/api/libraries/${bobPrivate.id}/assets`, { headers: { cookie: aliceCookie } }))
        .status,
      404,
    );
    assert.equal(
      (await app.fetch(asset.originalUrl, { headers: { cookie: aliceCookie } })).status,
      404,
    );
    assert.equal(
      (await app.fetch(asset.thumbnailUrl, { headers: { cookie: aliceCookie } })).status,
      404,
    );
  } finally {
    await app.stop();
  }
});

test("an Admin has no special access to a Member's private Asset", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const memberCookie = await joinMember(app, adminCookie, "mem@example.com");
    const memberPrivate = await privateLibrary(app, memberCookie);

    const asset = (await (
      await upload(app, memberCookie, memberPrivate.id, await makeJpeg())
    ).json()) as Asset;

    assert.equal(
      (await app.fetch(asset.originalUrl, { headers: { cookie: adminCookie } })).status,
      404,
    );
  } finally {
    await app.stop();
  }
});

test("Uploading and viewing Assets requires authentication", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);

    const up = await app.fetch(`/api/libraries/${lib.id}/assets`, {
      method: "POST",
      body: await makeJpeg(),
    });
    assert.equal(up.status, 401);

    const list = await app.fetch(`/api/libraries/${lib.id}/assets`);
    assert.equal(list.status, 401);
  } finally {
    await app.stop();
  }
});
