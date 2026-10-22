import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { startTestApp } from "./helpers/harness.ts";

const workDir = mkdtempSync(join(tmpdir(), "familio-migrate-"));
const sharedPaths = {
  DATABASE_PATH: join(workDir, "familio.db"),
  ORIGINALS_DIR: join(workDir, "originals"),
};

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test("migrations are idempotent across restarts against the same database", async () => {
  // First boot creates the schema.
  const first = await startTestApp(sharedPaths);
  assert.equal((await first.fetch("/health")).status, 200);
  await first.stop();

  // Second boot against the same database re-runs migrations; it must not
  // fail (e.g. "table already exists") and the app must still serve.
  const second = await startTestApp(sharedPaths);
  const res = await second.fetch("/health");
  assert.equal(res.status, 200);
  await second.stop();
});
