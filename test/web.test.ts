import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { after, before, test } from "node:test";

import { startTestApp, type TestApp } from "./helpers/harness.ts";

let app: TestApp;

before(async () => {
  app = await startTestApp();
});

after(async () => {
  await app.stop();
});

test("GET / serves the app shell without authentication", async () => {
  const res = await app.fetch("/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  const html = await res.text();
  assert.match(html, /<script type="module" src="\/app\.js">/);
});

test("static assets are served with the right content types", async () => {
  const expected: Record<string, RegExp> = {
    "/app.js": /^text\/javascript/,
    "/api.js": /^text\/javascript/,
    "/auth.js": /^text\/javascript/,
    "/style.css": /^text\/css/,
  };
  for (const [path, type] of Object.entries(expected)) {
    const res = await app.fetch(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type") ?? "", type, path);
  }
});

test("unknown non-API paths fall back to the app; missing assets and /api/* 404", async () => {
  for (const path of ["/signin", "/invite?token=abc", "/some/deep/route"]) {
    const res = await app.fetch(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  }
  const missing = await app.fetch("/nope.js");
  assert.equal(missing.status, 404);

  const api = await app.fetch("/api/does-not-exist");
  assert.equal(api.status, 404);
  assert.match(api.headers.get("content-type") ?? "", /json/);
  assert.deepEqual(await api.json(), { error: "not_found" });
});

test("path traversal cannot read outside the web folder", async () => {
  const res = await app.fetch("/..%2fpackage.json");
    assert.ok(!(await res.text()).includes('"dependencies"'));
});

test("the pages call only API endpoints that exist", async () => {
  const dir = new URL("../web/", import.meta.url);
  const paths = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const m of src.matchAll(/api\(\s*"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*"(\/api\/[^"]+)"/g)) {
      paths.add(`${m[1]} ${m[2]}`);
    }
  }
  assert.ok(paths.size >= 8, "expected the UI to call the account endpoints");
  for (const entry of paths) {
    const [method, path] = entry.split(" ");
    const res = await app.fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" ? undefined : "{}",
    });
    const body = (await res.json()) as { error?: string };
    assert.notEqual(body.error, "not_found", `${entry} is not an API endpoint`);
  }
});

test("client code holds no secrets and the session cookie is HttpOnly", async () => {
  const dir = new URL("../web/", import.meta.url);
  for (const f of readdirSync(dir)) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.ok(!/SESSION_SECRET|document\.cookie/.test(src), f);
  }
  const res = await app.fetch("/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@example.com", password: "correct horse battery" }),
  });
  assert.equal(res.status, 201);
  assert.match(res.headers.getSetCookie().join(";"), /HttpOnly/);
});

test("the Library switcher's endpoint lists private and Family Libraries", async () => {
  const login = await app.fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@example.com", password: "correct horse battery" }),
  });
  const cookie = login.headers.getSetCookie()[0].split(";", 1)[0];
  const res = await app.fetch("/api/libraries", { headers: { cookie } });
  const { libraries } = (await res.json()) as { libraries: { kind: string }[] };
  assert.deepEqual(libraries.map((l) => l.kind).sort(), ["family", "private"]);
});
