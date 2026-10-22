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
