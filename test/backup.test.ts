import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { makeJpeg, makePng } from "./helpers/images.ts";
import { startFakeS3, type FakeS3 } from "./helpers/s3.ts";
import { startTestApp, sessionCookie, type TestApp } from "./helpers/harness.ts";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const PASSWORD = "correct-horse-battery";
const ADMIN_EMAIL = "admin@example.com";

interface Library {
  id: number;
  kind: "private" | "family";
}

interface Asset {
  id: number;
  filename: string;
  originalUrl: string;
}

interface BackupRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "failure";
  error: string | null;
  objectCount: number;
  byteSize: number;
}

function backupEnv(s3: FakeS3): Record<string, string> {
  return {
    BACKUP_S3_ENDPOINT: s3.endpoint,
    BACKUP_S3_BUCKET: "test-bucket",
    BACKUP_S3_ACCESS_KEY_ID: "test-access-key",
    BACKUP_S3_SECRET_ACCESS_KEY: "test-secret-key",
    BACKUP_S3_PREFIX: "familio",
    BACKUP_INTERVAL_SECONDS: "0",
  };
}

async function setupAdmin(app: TestApp): Promise<string> {
  const res = await app.fetch("/api/setup", {
    method: "POST",
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
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
  assert.equal(res.status, 200);
  return ((await res.json()) as { libraries: Library[] }).libraries;
}

async function privateLibrary(app: TestApp, cookie: string): Promise<Library> {
  return (await libraries(app, cookie)).find((l) => l.kind === "private")!;
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

async function status(
  app: TestApp,
  cookie: string,
): Promise<{
  configured: boolean;
  intervalSeconds: number | null;
  bucket: string | null;
  lastRun: BackupRun | null;
}> {
  const res = await app.fetch("/api/admin/backups", { headers: { cookie } });
  assert.equal(res.status, 200);
  return (await res.json()) as {
    configured: boolean;
    intervalSeconds: number | null;
    bucket: string | null;
    lastRun: BackupRun | null;
  };
}

test("a backup uploads a consistent database snapshot and the originals off-box", async () => {
  const s3 = await startFakeS3();
  const app = await startTestApp(backupEnv(s3));
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const bytes = await makeJpeg();
    await upload(app, cookie, lib.id, bytes, "holiday.jpg");

    const res = await app.fetch("/api/admin/backups", {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(res.status, 201);
    const { backup } = (await res.json()) as { backup: BackupRun };
    assert.equal(backup.status, "success");
    assert.ok(backup.finishedAt);
    assert.ok(backup.objectCount >= 4);
    assert.ok(backup.byteSize > 0);

    // The status endpoint reports the same successful run to the Admin.
    const state = await status(app, cookie);
    assert.equal(state.configured, true);
    assert.equal(state.bucket, "test-bucket");
    assert.equal(state.lastRun?.status, "success");
    assert.equal(state.lastRun?.id, backup.id);

    // Everything needed for a restore is present off-box: a latest pointer, a
    // manifest, a real SQLite snapshot and the untouched original.
    const latest = s3.objects.get("familio/latest.json");
    assert.ok(latest, "latest.json must be uploaded");
    const manifest = JSON.parse(latest.toString("utf8")) as {
      version: number;
      id: string;
      database: { key: string };
      originals: { key: string; path: string; sha256: string }[];
    };
    assert.equal(manifest.version, 1);
    assert.equal(manifest.originals.length, 1);
    assert.equal(manifest.originals[0].path.endsWith(".jpg"), true);
    assert.ok(s3.objects.has(manifest.database.key));
    assert.ok(s3.objects.has(manifest.originals[0].key));
    assert.ok(s3.objects.has(`familio/backups/${manifest.id}/manifest.json`));
    assert.equal(
      s3.objects
        .get(manifest.database.key)!
        .subarray(0, 16)
        .toString("latin1"),
      "SQLite format 3\0",
    );
  } finally {
    await app.stop();
    await s3.stop();
  }
});

test("a failed backup is recorded and visible to Admins", async () => {
  const s3 = await startFakeS3();
  s3.failPut = true;
  const app = await startTestApp(backupEnv(s3));
  try {
    const cookie = await setupAdmin(app);
    const res = await app.fetch("/api/admin/backups", {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(res.status, 502);

    const state = await status(app, cookie);
    assert.equal(state.lastRun?.status, "failure");
    assert.ok(state.lastRun?.finishedAt);
    assert.match(state.lastRun?.error ?? "", /500/);
  } finally {
    await app.stop();
    await s3.stop();
  }
});

test("only Admins can see backup status, run backups or read disk usage", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const memberCookie = await joinMember(app, adminCookie, "mem@example.com");

    // Disk usage is real and adds up.
    const diskRes = await app.fetch("/api/admin/disk", {
      headers: { cookie: adminCookie },
    });
    assert.equal(diskRes.status, 200);
    const disk = (await diskRes.json()) as {
      totalBytes: number;
      usedBytes: number;
      freeBytes: number;
      availableBytes: number;
    };
    assert.ok(disk.totalBytes > 0);
    assert.ok(disk.usedBytes >= 0);
    assert.ok(disk.freeBytes >= 0);
    assert.equal(disk.totalBytes, disk.usedBytes + disk.freeBytes);
    assert.ok(disk.availableBytes >= 0);

    // Without backup storage configured, there is no last run and a manual
    // run is refused rather than silently doing nothing.
    const state = await status(app, adminCookie);
    assert.equal(state.configured, false);
    assert.equal(state.lastRun, null);
    const run = await app.fetch("/api/admin/backups", {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    assert.equal(run.status, 409);

    for (const path of ["/api/admin/backups", "/api/admin/disk"]) {
      assert.equal(
        (await app.fetch(path, { headers: { cookie: memberCookie } })).status,
        403,
      );
      assert.equal((await app.fetch(path)).status, 401);
    }
    assert.equal(
      (
        await app.fetch("/api/admin/backups", {
          method: "POST",
          headers: { cookie: memberCookie },
        })
      ).status,
      403,
    );
  } finally {
    await app.stop();
  }
});

test("the scheduled job runs a backup without a manual trigger", async () => {
  const s3 = await startFakeS3();
  const app = await startTestApp({
    ...backupEnv(s3),
    BACKUP_INTERVAL_SECONDS: "1",
  });
  try {
    const cookie = await setupAdmin(app);
    const deadline = Date.now() + 8_000;
    let lastRun: BackupRun | null = null;
    while (Date.now() < deadline) {
      lastRun = (await status(app, cookie)).lastRun;
      if (lastRun?.status === "success") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(lastRun?.status, "success");
    assert.ok(s3.objects.has("familio/latest.json"));
  } finally {
    await app.stop();
    await s3.stop();
  }
});

test("the documented restore script recovers the database and originals", async () => {
  const s3 = await startFakeS3();
  const app = await startTestApp(backupEnv(s3));
  const restoreDir = mkdtempSync(join(tmpdir(), "familio-restore-"));
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const bytes = await makeJpeg();
    const uploaded = await upload(app, cookie, lib.id, bytes, "restored.jpg");

    const backup = await app.fetch("/api/admin/backups", {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(backup.status, 201);

    await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(repoRoot, "src", "restore.ts"),
        "--destination",
        restoreDir,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...backupEnv(s3),
          DATABASE_PATH: join(restoreDir, "familio.db"),
          ORIGINALS_DIR: join(restoreDir, "originals"),
          SESSION_SECRET: "restore-secret-value-at-least-sixteen-chars",
        },
      },
    );

    // Boot a fresh app on the restored files and prove the Admin, Library and
    // Asset (including its original bytes) all came back.
    const restored = await startTestApp({
      DATABASE_PATH: join(restoreDir, "familio.db"),
      ORIGINALS_DIR: join(restoreDir, "originals"),
    });
    try {
      const login = await restored.fetch("/api/login", {
        method: "POST",
        body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
      });
      assert.equal(login.status, 200);
      const restoredCookie = sessionCookie(login)!;

      const restoredLib = await privateLibrary(restored, restoredCookie);
      assert.equal(restoredLib.id, lib.id);
      const list = await restored.fetch(
        `/api/libraries/${lib.id}/assets`,
        { headers: { cookie: restoredCookie } },
      );
      const { assets } = (await list.json()) as { assets: Asset[] };
      assert.equal(assets.length, 1);
      assert.equal(assets[0].id, uploaded.id);
      assert.equal(assets[0].filename, "restored.jpg");

      const download = await restored.fetch(assets[0].originalUrl, {
        headers: { cookie: restoredCookie },
      });
      assert.equal(download.status, 200);
      const restoredBytes = Buffer.from(await download.arrayBuffer());
      assert.ok(restoredBytes.equals(bytes));
    } finally {
      await restored.stop();
    }
  } finally {
    await app.stop();
    await s3.stop();
    rmSync(restoreDir, { recursive: true, force: true });
  }
});

test("restore can pick a named backup and replaces stale local data", async () => {
  const s3 = await startFakeS3();
  const app = await startTestApp(backupEnv(s3));
  const restoreDir = mkdtempSync(join(tmpdir(), "familio-restore-"));
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);

    const firstBytes = await makeJpeg();
    const first = await upload(app, cookie, lib.id, firstBytes, "first.jpg");
    assert.equal(
      (
        await app.fetch("/api/admin/backups", {
          method: "POST",
          headers: { cookie },
        })
      ).status,
      201,
    );
    const firstBackupId = (
      JSON.parse(s3.objects.get("familio/latest.json")!.toString("utf8")) as {
        id: string;
      }
    ).id;

    await upload(app, cookie, lib.id, await makePng(), "second.png");
    assert.equal(
      (
        await app.fetch("/api/admin/backups", {
          method: "POST",
          headers: { cookie },
        })
      ).status,
      201,
    );
    const secondBackupId = (
      JSON.parse(s3.objects.get("familio/latest.json")!.toString("utf8")) as {
        id: string;
      }
    ).id;
    assert.notEqual(firstBackupId, secondBackupId);

    // A previous restore or a crashed run may have left stale files behind.
    mkdirSync(join(restoreDir, "originals"), { recursive: true });
    writeFileSync(join(restoreDir, "originals", "stale.jpg"), "stale");
    writeFileSync(join(restoreDir, "familio.db-wal"), "stale");
    writeFileSync(join(restoreDir, "familio.db-shm"), "stale");

    await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(repoRoot, "src", "restore.ts"),
        "--destination",
        restoreDir,
        "--backup",
        firstBackupId,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...backupEnv(s3),
          DATABASE_PATH: join(restoreDir, "familio.db"),
          ORIGINALS_DIR: join(restoreDir, "originals"),
          SESSION_SECRET: "restore-secret-value-at-least-sixteen-chars",
        },
      },
    );

    assert.equal(existsSync(join(restoreDir, "familio.db-wal")), false);
    assert.equal(existsSync(join(restoreDir, "familio.db-shm")), false);
    assert.equal(existsSync(join(restoreDir, "originals", "stale.jpg")), false);

    const restored = await startTestApp({
      DATABASE_PATH: join(restoreDir, "familio.db"),
      ORIGINALS_DIR: join(restoreDir, "originals"),
    });
    try {
      const login = await restored.fetch("/api/login", {
        method: "POST",
        body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
      });
      assert.equal(login.status, 200);
      const restoredCookie = sessionCookie(login)!;
      const list = await restored.fetch(`/api/libraries/${lib.id}/assets`, {
        headers: { cookie: restoredCookie },
      });
      const { assets } = (await list.json()) as { assets: Asset[] };
      assert.deepEqual(
        assets.map((asset) => asset.id),
        [first.id],
      );
    } finally {
      await restored.stop();
    }
  } finally {
    await app.stop();
    await s3.stop();
    rmSync(restoreDir, { recursive: true, force: true });
  }
});
