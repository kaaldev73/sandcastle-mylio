import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startTestApp, type TestApp } from "./helpers/harness.ts";

let app: TestApp;

before(async () => {
  app = await startTestApp();
});

after(async () => {
  await app.stop();
});

test("GET /health returns OK", async () => {
  const res = await app.fetch("/health");

  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, "ok");
});
