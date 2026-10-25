import assert from "node:assert/strict";
import { test } from "node:test";

import { makeJpeg, makePng } from "./helpers/images.ts";
import { sessionCookie, startTestApp, type TestApp } from "./helpers/harness.ts";

const PASSWORD = "correct-horse-battery";

interface Library {
  id: number;
  kind: "private" | "family";
}

interface Asset {
  id: number;
  filename: string;
  contentHash: string;
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

async function listLibraries(app: TestApp, cookie: string): Promise<Library[]> {
  const res = await app.fetch("/api/libraries", { headers: { cookie } });
  const { libraries } = (await res.json()) as { libraries: Library[] };
  return libraries;
}

async function privateLibrary(app: TestApp, cookie: string): Promise<Library> {
  return (await listLibraries(app, cookie)).find((l) => l.kind === "private")!;
}

async function listAssets(app: TestApp, cookie: string, libraryId: number): Promise<Asset[]> {
  const res = await app.fetch(`/api/libraries/${libraryId}/assets`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return ((await res.json()) as { assets: Asset[] }).assets;
}

/** Upload one file through the raw single-file endpoint. */
function upload(
  app: TestApp,
  cookie: string,
  libraryId: number,
  bytes: Buffer,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.fetch(`/api/libraries/${libraryId}/assets`, {
    method: "POST",
    headers: { cookie, ...headers },
    body: bytes,
  });
}

/** One file as the client submits it in a batch Upload action. */
interface BatchFile {
  filename?: string;
  modifiedMs?: number;
  uploadKey?: string;
  contentBase64?: string;
}

/** Send one batch Upload action: many files in a single request. */
function batch(
  app: TestApp,
  cookie: string,
  libraryId: number,
  files: BatchFile[],
): Promise<Response> {
  return app.fetch(`/api/libraries/${libraryId}/assets/batch`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ files }),
  });
}

interface BatchResult {
  filename: string | null;
  status: "uploaded" | "duplicate" | "failed";
  asset?: Asset;
  error?: string;
  message?: string;
}

test("re-uploading the same file into a Library does not create a second Asset", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const bytes = await makeJpeg();

    const first = await upload(app, cookie, lib.id, bytes, { "x-filename": "holiday.jpg" });
    assert.equal(first.status, 201);
    const one = (await first.json()) as Asset;

    const second = await upload(app, cookie, lib.id, bytes, { "x-filename": "holiday.jpg" });
    assert.equal(second.status, 200);
    const two = (await second.json()) as Asset;

    assert.equal(two.id, one.id, "same bytes must land on the same Asset");
    const assets = await listAssets(app, cookie, lib.id);
    assert.equal(assets.length, 1);
  } finally {
    await app.stop();
  }
});

test("an interrupted Upload retried with the same upload key returns the same Asset, without doubling", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const bytes = await makeJpeg();

    const first = await upload(app, cookie, lib.id, bytes, { "x-upload-key": "upload-abc" });
    assert.equal(first.status, 201);
    const one = (await first.json()) as Asset;

    const retry = await upload(app, cookie, lib.id, bytes, { "x-upload-key": "upload-abc" });
    assert.equal(retry.status, 200);
    const two = (await retry.json()) as Asset;
    assert.equal(two.id, one.id);

    const assets = await listAssets(app, cookie, lib.id);
    assert.equal(assets.length, 1);
  } finally {
    await app.stop();
  }
});

test("the same upload key in a different Library is a separate upload", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const memberCookie = await joinMember(app, adminCookie, "mem@example.com");
    const privateLib = await privateLibrary(app, memberCookie);
    const family = (await listLibraries(app, memberCookie)).find(
      (l) => l.kind === "family",
    )!;
    const bytes = await makeJpeg();

    const first = await upload(app, memberCookie, privateLib.id, bytes, {
      "x-upload-key": "key-1",
    });
    assert.equal(first.status, 201);
    const second = await upload(app, memberCookie, family.id, bytes, {
      "x-upload-key": "key-1",
    });
    assert.equal(second.status, 201);

    const assets = await listAssets(app, memberCookie, privateLib.id);
    const familyAssets = await listAssets(app, memberCookie, family.id);
    assert.equal(assets.length, 1);
    assert.equal(familyAssets.length, 1);
  } finally {
    await app.stop();
  }
});

test("a batch Upload reports a status for every file and keeps going past failures", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const jpeg = await makeJpeg();
    const png = await makePng();

    const res = await batch(app, cookie, lib.id, [
      { filename: "a.jpg", contentBase64: jpeg.toString("base64"), uploadKey: "b1" },
      { filename: "notes.txt", contentBase64: Buffer.from("not an image").toString("base64") },
      { filename: "b.png", contentBase64: png.toString("base64"), uploadKey: "b2" },
      { filename: "broken.jpg", contentBase64: Buffer.from("not really an image at all!").toString("base64") },
    ]);
    assert.equal(res.status, 200);
    const { results } = (await res.json()) as { results: BatchResult[] };

    assert.equal(results.length, 4, "one status per submitted file, in order");
    assert.equal(results[0].status, "uploaded");
    assert.ok(results[0].asset);
    assert.equal(results[1].status, "failed");
    assert.equal(results[1].error, "unsupported_type");
    assert.match(results[1].message ?? "", /notes\.txt/);
    assert.equal(results[2].status, "uploaded");
    assert.ok(results[2].asset);
    assert.equal(results[3].status, "failed");
    assert.equal(results[3].error, "unsupported_type");

    const assets = await listAssets(app, cookie, lib.id);
    assert.equal(assets.length, 2, "the good files landed despite the failures");
  } finally {
    await app.stop();
  }
});

test("a batch Upload is resumable: rerunning it with the same upload keys creates nothing twice", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const jpeg = await makeJpeg();
    const png = await makePng();

    const files = [
      { filename: "a.jpg", contentBase64: jpeg.toString("base64"), uploadKey: "k1" },
      { filename: "b.png", contentBase64: png.toString("base64"), uploadKey: "k2" },
    ];
    const first = await batch(app, cookie, lib.id, files);
    assert.equal(first.status, 200);
    const { results: firstResults } = (await first.json()) as { results: BatchResult[] };
    assert.ok(firstResults.every((r) => r.status === "uploaded"));

    // The same batch action rerun after an interruption: already-saved files
    // must come back as the same Assets, not new ones.
    const second = await batch(app, cookie, lib.id, files);
    assert.equal(second.status, 200);
    const { results: secondResults } = (await second.json()) as { results: BatchResult[] };
    assert.deepEqual(
      secondResults.map((r) => r.status),
      ["duplicate", "duplicate"],
    );
    assert.equal(secondResults[0].asset!.id, firstResults[0].asset!.id);
    assert.equal(secondResults[1].asset!.id, firstResults[1].asset!.id);

    const assets = await listAssets(app, cookie, lib.id);
    assert.equal(assets.length, 2);
  } finally {
    await app.stop();
  }
});

test("a batch Upload rejects a malformed request out of hand", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);

    assert.equal((await batch(app, cookie, lib.id, [])).status, 400);
    assert.equal(
      (await app.fetch(`/api/libraries/${lib.id}/assets/batch`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({}),
      })).status,
      400,
    );
  } finally {
    await app.stop();
  }
});

test("a batch Upload respects Library access rules", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const memberCookie = await joinMember(app, adminCookie, "mem@example.com");
    const memberPrivate = await privateLibrary(app, memberCookie);

    const res = await batch(app, adminCookie, memberPrivate.id, [
      { filename: "a.jpg", contentBase64: (await makeJpeg()).toString("base64") },
    ]);
    assert.equal(res.status, 404);

    const anon = await app.fetch(`/api/libraries/${memberPrivate.id}/assets/batch`, {
      method: "POST",
      body: JSON.stringify({ files: [] }),
    });
    assert.equal(anon.status, 401);
  } finally {
    await app.stop();
  }
});
