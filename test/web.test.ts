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
    "/browse.js": /^text\/javascript/,
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
    // The path is a string literal, optionally followed by `+ identifier` and
    // further literals; identifiers stand in as id 1 (or nothing for a query).
    for (const m of src.matchAll(
      /api\(\s*"(GET|POST|PUT|PATCH|DELETE)"\s*,\s*("[^"]*"(?:\s*\+\s*(?:"[^"]*"|[\w.()]+))*)/g,
    )) {
      const path = [...m[2].matchAll(/"([^"]*)"|([\w.()]+)/g)]
        .map((t) => t[1] ?? (/^query/i.test(t[2]) ? "" : "1"))
        .join("");
      if (path.startsWith("/api/")) paths.add(`${m[1]} ${path}`);
    }
  }
  assert.ok(paths.size >= 11, `expected the UI to call the account and browse endpoints, got ${[...paths]}`);
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

test("the browse flow works over the API the UI calls: drill-down, paged grid, viewer, place filter", async () => {
  const { makeJpegWithCaptureDate, makeJpegWithGps } = await import("./helpers/images.ts");
  const login = await app.fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@example.com", password: "correct horse battery" }),
  });
  const cookie = login.headers.getSetCookie()[0].split(";", 1)[0];
  const libs = (await (await app.fetch("/api/libraries", { headers: { cookie } })).json()) as {
    libraries: { id: number; kind: string }[];
  };
  const id = libs.libraries.find((l) => l.kind === "private")!.id;
  const get = async (path: string) => {
    const res = await app.fetch(path, { headers: { cookie } });
    assert.equal(res.status, 200, path);
    return (await res.json()) as any;
  };
  const upload = async (bytes: Buffer, name: string) => {
    const res = await app.fetch(`/api/libraries/${id}/assets`, {
      method: "POST",
      headers: { cookie, "x-filename": name },
      body: bytes,
    });
    assert.equal(res.status, 201);
  };
  await upload(await makeJpegWithCaptureDate("2021:06:15 10:00:00"), "dated.jpg");
  await upload(await makeJpegWithGps(48.85, 2.35), "paris.jpg");
  await upload(await makeJpegWithGps(-33.86, 151.2), "sydney.jpg");

  // Timeline: decade with a cover, then parent-scoped year level.
  const decades = await get(`/api/libraries/${id}/timeline?level=decade`);
  assert.ok(decades.periods.length >= 1);
  assert.ok(decades.periods[0].cover.thumbnailUrl);
  const years = await get(
    `/api/libraries/${id}/timeline?level=year&parent=${decades.periods[0].key}`,
  );
  assert.ok(years.periods.length >= 1);

  // Paged grid walks without fetching everything.
  const first = await get(`/api/libraries/${id}/assets?limit=2&offset=0`);
  assert.equal(first.assets.length, 2);
  assert.equal(first.hasMore, true);
  const second = await get(`/api/libraries/${id}/assets?limit=2&offset=${first.nextOffset}`);
  assert.equal(second.assets.length, 1);
  assert.equal(second.hasMore, false);

  // Place filter narrows; photos without a location stay reachable.
  const near = await get(`/api/libraries/${id}/assets?place=48.8,2.3&radiusKm=50`);
  assert.deepEqual(near.assets.map((a: any) => a.filename), ["paris.jpg"]);
  const without = await get(`/api/libraries/${id}/assets?withoutLocation=1`);
  assert.deepEqual(without.assets.map((a: any) => a.filename), ["dated.jpg"]);

  // Viewer: neighbours and the original behind the asset.
  const mid = first.assets[0];
  const view = await get(`/api/assets/${mid.id}/neighbors`);
  assert.equal(view.hasNext, true);
  const original = await app.fetch(view.asset.originalUrl, { headers: { cookie } });
  assert.equal(original.status, 200);
  assert.match(original.headers.get("content-type") ?? "", /^image\//);
});
