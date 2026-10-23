import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { makeJpeg, makeJpegWithCaptureDate, makePng } from "./helpers/images.ts";
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
  captureDate: string;
  captureSource: "exif" | "file";
  originalUrl: string;
}

interface ImportResult {
  imported: number;
  skipped: number;
  unsupported: number;
  failed: number;
  assets: Asset[];
  skippedFiles: { path: string; assetId: number }[];
  unsupportedFiles: { path: string; reason: string }[];
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

async function privateLibrary(app: TestApp, cookie: string): Promise<Library> {
  const res = await app.fetch("/api/libraries", { headers: { cookie } });
  const { libraries } = (await res.json()) as { libraries: Library[] };
  return libraries.find((library) => library.kind === "private")!;
}

function importFolder(
  app: TestApp,
  cookie: string,
  libraryId: number,
): Promise<Response> {
  return app.fetch(`/api/libraries/${libraryId}/import`, {
    method: "POST",
    headers: { cookie },
  });
}

test("an Admin imports a folder into a chosen Library, keeping originals and reading dates", async () => {
  const importRoot = mkdtempSync(join(tmpdir(), "familio-import-"));
  const app = await startTestApp({ SERVER_IMPORT_DIR: importRoot });
  try {
    const cookie = await setupAdmin(app);
    const library = await privateLibrary(app, cookie);

    const exifBytes = await makeJpegWithCaptureDate("2021:06:15 10:30:00");
    const plainBytes = await makePng();
    mkdirSync(join(importRoot, "trip"));
    writeFileSync(join(importRoot, "trip", "holiday.jpg"), exifBytes);
    writeFileSync(join(importRoot, "scanned.png"), plainBytes);
    const fileDate = Date.UTC(2019, 0, 2, 3, 4, 5);
    utimesSync(
      join(importRoot, "scanned.png"),
      fileDate / 1000,
      fileDate / 1000,
    );
    writeFileSync(join(importRoot, "notes.txt"), "not a photo");

    const res = await importFolder(app, cookie, library.id);
    assert.equal(res.status, 200);
    const result = (await res.json()) as ImportResult;
    assert.equal(result.imported, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.unsupported, 1);
    assert.equal(result.failed, 0);
    assert.deepEqual(
      result.unsupportedFiles.map((file) => file.path),
      ["notes.txt"],
    );

    const list = await app.fetch(`/api/libraries/${library.id}/assets`, {
      headers: { cookie },
    });
    const { assets } = (await list.json()) as { assets: Asset[] };
    assert.equal(assets.length, 2);
    const jpeg = assets.find((asset) => asset.filename === "holiday.jpg")!;
    const png = assets.find((asset) => asset.filename === "scanned.png")!;
    assert.equal(jpeg.captureSource, "exif");
    assert.equal(jpeg.captureDate, "2021-06-15T10:30:00.000Z");
    assert.equal(png.captureSource, "file");
    assert.equal(png.captureDate, new Date(fileDate).toISOString());

    // The original is stored untouched and still sits in the import folder.
    const download = await app.fetch(jpeg.originalUrl, { headers: { cookie } });
    assert.equal(download.status, 200);
    assert.ok(Buffer.from(await download.arrayBuffer()).equals(exifBytes));
  } finally {
    await app.stop();
    rmSync(importRoot, { recursive: true, force: true });
  }
});

test("re-running a Server Import skips files already imported", async () => {
  const importRoot = mkdtempSync(join(tmpdir(), "familio-import-"));
  const app = await startTestApp({ SERVER_IMPORT_DIR: importRoot });
  try {
    const cookie = await setupAdmin(app);
    const library = await privateLibrary(app, cookie);
    writeFileSync(join(importRoot, "one.jpg"), await makeJpeg());

    const first = (await (
      await importFolder(app, cookie, library.id)
    ).json()) as ImportResult;
    assert.equal(first.imported, 1);

    const second = (await (
      await importFolder(app, cookie, library.id)
    ).json()) as ImportResult;
    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 1);
    assert.equal(second.skippedFiles.length, 1);

    const list = await app.fetch(`/api/libraries/${library.id}/assets`, {
      headers: { cookie },
    });
    const { assets } = (await list.json()) as { assets: Asset[] };
    assert.equal(assets.length, 1);
  } finally {
    await app.stop();
    rmSync(importRoot, { recursive: true, force: true });
  }
});

test("only Admins can run a Server Import", async () => {
  const importRoot = mkdtempSync(join(tmpdir(), "familio-import-"));
  const app = await startTestApp({ SERVER_IMPORT_DIR: importRoot });
  try {
    const adminCookie = await setupAdmin(app);
    const memberCookie = await joinMember(app, adminCookie, "mem@example.com");
    const memberLibrary = await privateLibrary(app, memberCookie);

    assert.equal(
      (await importFolder(app, memberCookie, memberLibrary.id)).status,
      403,
    );
    assert.equal(
      (await importFolder(app, adminCookie, memberLibrary.id)).status,
      404,
    );
    assert.equal(
      (
        await app.fetch(`/api/libraries/${memberLibrary.id}/import`, {
          method: "POST",
        })
      ).status,
      401,
    );
  } finally {
    await app.stop();
    rmSync(importRoot, { recursive: true, force: true });
  }
});

test("a Server Import without a configured folder is refused clearly", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const library = await privateLibrary(app, cookie);
    const res = await importFolder(app, cookie, library.id);
    assert.equal(res.status, 409);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "import_not_configured",
    );
  } finally {
    await app.stop();
  }
});

test("an Admin can choose the Library through the admin import endpoint", async () => {
  const importRoot = mkdtempSync(join(tmpdir(), "familio-import-"));
  const app = await startTestApp({ SERVER_IMPORT_DIR: importRoot });
  try {
    const cookie = await setupAdmin(app);
    const library = await privateLibrary(app, cookie);
    writeFileSync(join(importRoot, "one.jpg"), await makeJpeg());

    const res = await app.fetch("/api/admin/import", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ libraryId: library.id }),
    });
    assert.equal(res.status, 200);
    const result = (await res.json()) as ImportResult;
    assert.equal(result.imported, 1);
    assert.equal(result.assets.length, 1);
  } finally {
    await app.stop();
    rmSync(importRoot, { recursive: true, force: true });
  }
});

test("a Server Import can target a subfolder and cannot escape the configured folder", async () => {
  const importRoot = mkdtempSync(join(tmpdir(), "familio-import-"));
  const app = await startTestApp({ SERVER_IMPORT_DIR: importRoot });
  try {
    const cookie = await setupAdmin(app);
    const library = await privateLibrary(app, cookie);
    mkdirSync(join(importRoot, "trip"));
    writeFileSync(join(importRoot, "trip", "one.jpg"), await makeJpeg());
    writeFileSync(join(importRoot, "outside.jpg"), await makeJpeg());

    const res = await app.fetch(`/api/libraries/${library.id}/import`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ folder: "trip" }),
    });
    assert.equal(res.status, 200);
    const result = (await res.json()) as ImportResult;
    assert.equal(result.imported, 1);
    assert.equal(result.assets[0].filename, "one.jpg");

    const escape = await app.fetch(`/api/libraries/${library.id}/import`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ folder: ".." }),
    });
    assert.equal(escape.status, 400);
  } finally {
    await app.stop();
    rmSync(importRoot, { recursive: true, force: true });
  }
});
