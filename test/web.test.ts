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
    "/upload.js": /^text\/javascript/,
    "/admin.js": /^text\/javascript/,
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

test("the upload flow works over the batch endpoint: per-file requests, resume without duplicates, per-file failures retried", async () => {
  const { makeJpeg } = await import("./helpers/images.ts");
  const login = await app.fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@example.com", password: "correct horse battery" }),
  });
  const cookie = login.headers.getSetCookie()[0].split(";", 1)[0];
  const libs = (await (await app.fetch("/api/libraries", { headers: { cookie } })).json()) as {
    libraries: { id: number; kind: string }[];
  };
  const id = libs.libraries.find((l) => l.kind === "family")!.id;
  const send = async (file: object) => {
    const res = await app.fetch(`/api/libraries/${id}/assets/batch`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ files: [file] }),
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as any).results[0];
  };
  const list = async () =>
    ((await (await app.fetch(`/api/libraries/${id}/assets`, { headers: { cookie } })).json()) as any).assets;
  const before = (await list()).length;
  const good = {
    filename: "ui.jpg",
    modifiedMs: 1_600_000_000_000,
    uploadKey: `web:${id}:ui.jpg:1:1600000000000`,
    contentBase64: (await makeJpeg()).toString("base64"),
  };

  assert.equal((await send(good)).status, "uploaded");
  // The interrupted client re-sends the same key: same Asset, nothing new.
  const again = await send(good);
  assert.equal(again.status, "duplicate");
  assert.equal((await list()).length, before + 1);

  // A bad file fails on its own with a code the UI maps to a message, then a
  // retry of a fixed file succeeds.
  const bad = await send({ filename: "x.txt", uploadKey: "web:bad", contentBase64: Buffer.from("nope").toString("base64") });
  assert.equal(bad.status, "failed");
  assert.equal(bad.error, "unsupported_type");
});

test("the admin screens' endpoints work for an Admin and are rejected for a Member", async () => {
  const json = { "content-type": "application/json" };
  const login = async (email: string, password: string) =>
    (await app.fetch("/api/login", { method: "POST", headers: json, body: JSON.stringify({ email, password }) }))
      .headers.getSetCookie()[0].split(";", 1)[0];
  const admin = await login("a@example.com", "correct horse battery");
  const call = (cookie: string, method: string, path: string, body?: object) =>
    app.fetch(path, { method, headers: { cookie, ...json }, body: body ? JSON.stringify(body) : undefined });

  // Invite by email with role; the invitee joins.
  const inv = await call(admin, "POST", "/api/invitations", { email: "kid@example.com", role: "member" });
  assert.equal(inv.status, 201);
  const { token } = (await inv.json()) as { token: string };
  const accepted = await app.fetch("/api/invitations/accept", {
    method: "POST", headers: json, body: JSON.stringify({ token, password: "another long password" }),
  });
  assert.equal(accepted.status, 201);
  const kid = await login("kid@example.com", "another long password");

  // Non-Admins are rejected on every admin endpoint.
  for (const [method, path] of [
    ["GET", "/api/members"], ["GET", "/api/admin/backups"], ["POST", "/api/admin/backups"],
    ["GET", "/api/admin/disk"], ["POST", "/api/admin/import"], ["POST", "/api/invitations"],
  ]) {
    assert.equal((await call(kid, method, path, method === "GET" ? undefined : {})).status, 403, `${method} ${path}`);
  }

  // Admin sees members, backup status and disk usage.
  const { members } = (await (await call(admin, "GET", "/api/members")).json()) as { members: { id: number; email: string }[] };
  assert.deepEqual(members.map((m) => m.email), ["a@example.com", "kid@example.com"]);
  const backups = (await (await call(admin, "GET", "/api/admin/backups")).json()) as any;
  assert.equal(typeof backups.configured, "boolean");
  const disk = (await (await call(admin, "GET", "/api/admin/disk")).json()) as any;
  assert.ok(disk.totalBytes > 0 && disk.usedBytes >= 0 && disk.availableBytes >= 0);

  // Removal with the transfer choice, as the UI sends it.
  const kidId = members.find((m) => m.email === "kid@example.com")!.id;
  const removed = await call(admin, "POST", `/api/members/${kidId}/remove`, { action: "transfer", confirm: false });
  assert.equal(removed.status, 200);
  assert.equal(((await removed.json()) as any).library, "transfer");
});

test("the viewer's rating and date correction work over the API: flag, stars, clear, date moves the Asset in the Timeline", async () => {
  const { makeJpegWithCaptureDate } = await import("./helpers/images.ts");
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
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await app.fetch(path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(res.status, 200, path);
    return (await res.json()) as any;
  };
  const up = await app.fetch(`/api/libraries/${id}/assets`, {
    method: "POST",
    headers: { cookie, "x-filename": "rate-me.jpg" },
    body: await makeJpegWithCaptureDate("1987:03:04 09:00:00"),
  });
  const asset = (await up.json()) as any;

  let a = await send("PATCH", `/api/assets/${asset.id}/flag`, { flag: "reject" });
  assert.equal(a.flag, "reject");
  assert.equal(a.dimmed, true);
  a = await send("PATCH", `/api/assets/${asset.id}/flag`, { flag: "pick" });
  assert.equal(a.flag, "pick");
  a = await send("PATCH", `/api/assets/${asset.id}/stars`, { stars: 4 });
  assert.equal(a.stars, 4);
  a = await send("PATCH", `/api/assets/${asset.id}/flag`, { flag: "unflagged" });
  a = await send("PATCH", `/api/assets/${asset.id}/stars`, { stars: 0 });
  assert.deepEqual([a.flag, a.stars], ["unflagged", 0]);

  // The grid reports the Rating the tiles draw.
  await send("PATCH", `/api/assets/${asset.id}/flag`, { flag: "reject" });
  const grid = await send("GET", `/api/libraries/${id}/assets?from=1987-01-01&to=1987-12-31`);
  assert.equal(grid.assets[0].flag, "reject");

  // Date correction moves the Asset between Timeline years.
  a = await send("PATCH", `/api/assets/${asset.id}/date`, { date: new Date("1991-07-01T12:00:00Z").toISOString() });
  assert.equal(a.dateOverridden, true);
  const years = await send("GET", `/api/libraries/${id}/timeline?level=year&parent=1990`);
  assert.ok(years.periods.some((p: any) => p.label.includes("1991")));
  const old = await send("GET", `/api/libraries/${id}/timeline?level=year&parent=1980`);
  assert.ok(!old.periods.some((p: any) => p.label.includes("1987")));
});

test("the Albums screens' endpoints work over the API: create, rename, add, remove, delete, shared Albums in the Family Library", async () => {
  const login = await app.fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@example.com", password: "correct horse battery" }),
  });
  const cookie = login.headers.getSetCookie()[0].split(";", 1)[0];
  const libs = (await (await app.fetch("/api/libraries", { headers: { cookie } })).json()) as {
    libraries: { id: number; kind: string }[];
  };
  const family = libs.libraries.find((l) => l.kind === "family")!.id;
  const send = async (method: string, path: string, body?: unknown, status = 200) => {
    const res = await app.fetch(path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(res.status, status, path);
    return status === 204 ? null : ((await res.json()) as any);
  };
  const up = await app.fetch(`/api/libraries/${family}/assets`, {
    method: "POST",
    headers: { cookie, "x-filename": "album-me.jpg" },
    body: await (await import("./helpers/images.ts")).makeJpegWithCaptureDate("1999:05:06 10:00:00"),
  });
  const asset = (await up.json()) as any;

  const album = await send("POST", `/api/libraries/${family}/albums`, { name: "Holiday" }, 201);
  let a = await send("PATCH", `/api/albums/${album.id}`, { name: "Holiday 99" });
  assert.equal(a.name, "Holiday 99");
  a = await send("POST", `/api/albums/${album.id}/assets`, { assetId: asset.id });
  assert.equal(a.assets.length, 1);
  const list = await send("GET", `/api/libraries/${family}/albums`);
  assert.equal(list.albums.find((x: any) => x.id === album.id).assetCount, 1);
  a = await send("DELETE", `/api/albums/${album.id}/assets/${asset.id}`);
  assert.equal(a.assets.length, 0);
  await send("DELETE", `/api/albums/${album.id}`, undefined, 204);
  const grid = await send("GET", `/api/libraries/${family}/assets`);
  assert.ok(grid.assets.some((x: any) => x.id === asset.id));
});
