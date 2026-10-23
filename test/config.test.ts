import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError, loadConfig } from "../src/config.ts";

const valid = {
  DATABASE_PATH: "/tmp/familio.db",
  ORIGINALS_DIR: "/tmp/originals",
  SESSION_SECRET: "a-sufficiently-long-secret-value",
};

test("missing required values fail fast with a clear message", () => {
  assert.throws(
    () => loadConfig({}),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      // The message names every missing required variable so an operator can
      // fix them all at once.
      assert.match(err.message, /DATABASE_PATH/);
      assert.match(err.message, /ORIGINALS_DIR/);
      assert.match(err.message, /SESSION_SECRET/);
      return true;
    },
  );
});

test("a too-short SESSION_SECRET is rejected", () => {
  assert.throws(
    () => loadConfig({ ...valid, SESSION_SECRET: "short" }),
    (err: unknown) =>
      err instanceof ConfigError && /SESSION_SECRET/.test(err.message),
  );
});

test("valid environment produces a frozen config with defaults applied", () => {
  const config = loadConfig(valid);
  assert.equal(config.PORT, 3000);
  assert.equal(config.DATABASE_PATH, valid.DATABASE_PATH);
  assert.equal(config.ORIGINALS_DIR, valid.ORIGINALS_DIR);
  assert.ok(Object.isFrozen(config));
});

test("the import folder can be supplied through a common alias", () => {
  const config = loadConfig({ ...valid, IMPORT_DIR: "/srv/imports" });
  assert.equal(config.SERVER_IMPORT_DIR, "/srv/imports");
});

test("an explicit SERVER_IMPORT_DIR wins over an alias", () => {
  const config = loadConfig({
    ...valid,
    SERVER_IMPORT_DIR: "/canonical",
    IMPORT_DIR: "/alias",
  });
  assert.equal(config.SERVER_IMPORT_DIR, "/canonical");
});

test("backup target variables must be supplied together", () => {
  assert.throws(
    () =>
      loadConfig({
        ...valid,
        BACKUP_S3_ENDPOINT: "http://127.0.0.1:9000",
      }),
    (err: unknown) =>
      err instanceof ConfigError &&
      /BACKUP_S3_BUCKET/.test(err.message) &&
      /BACKUP_S3_ACCESS_KEY_ID/.test(err.message) &&
      /BACKUP_S3_SECRET_ACCESS_KEY/.test(err.message),
  );
});

test("a complete backup target is accepted with region and prefix defaults", () => {
  const config = loadConfig({
    ...valid,
    BACKUP_S3_ENDPOINT: "http://127.0.0.1:9000",
    BACKUP_S3_BUCKET: "photos",
    BACKUP_S3_ACCESS_KEY_ID: "key",
    BACKUP_S3_SECRET_ACCESS_KEY: "secret",
  });
  assert.equal(config.BACKUP_S3_REGION, "us-east-1");
  assert.equal(config.BACKUP_S3_PREFIX, "familio");
  assert.equal(config.BACKUP_INTERVAL_SECONDS, 86400);
});
