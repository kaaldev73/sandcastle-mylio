import assert from "node:assert/strict";
import { test } from "node:test";

import { makeJpegWithCaptureDate, makePng } from "./helpers/images.ts";
import { startTestApp, sessionCookie, type TestApp } from "./helpers/harness.ts";

const PASSWORD = "correct-horse-battery";

interface Library {
  id: number;
  kind: "private" | "family";
}

interface Asset {
  id: number;
  filename: string;
  captureDate: string;
  captureSource: "exif" | "file";
  dateOverridden: boolean;
  thumbnailUrl: string;
  originalUrl: string;
}

interface Period {
  level: string;
  key: string;
  label: string;
  start: string;
  end: string;
  count: number;
  assetCount: number;
  cover: Asset;
  coverAsset: Asset;
  assets?: Asset[];
}

interface Timeline {
  level: string;
  total: number;
  periods: Period[];
  assets?: Asset[];
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

async function libraries(app: TestApp, cookie: string): Promise<Library[]> {
  const res = await app.fetch("/api/libraries", { headers: { cookie } });
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
  options: { filename?: string; fileModifiedMs?: number } = {},
): Promise<Asset> {
  const headers: Record<string, string> = { cookie };
  if (options.filename) headers["x-filename"] = options.filename;
  if (options.fileModifiedMs) {
    headers["x-file-modified-ms"] = String(options.fileModifiedMs);
  }
  const res = await app.fetch(`/api/libraries/${libraryId}/assets`, {
    method: "POST",
    headers,
    body: bytes,
  });
  assert.equal(res.status, 201);
  return (await res.json()) as Asset;
}

async function uploadExif(
  app: TestApp,
  cookie: string,
  libraryId: number,
  exifDate: string,
  filename = "photo.jpg",
): Promise<Asset> {
  return upload(app, cookie, libraryId, await makeJpegWithCaptureDate(exifDate), {
    filename,
  });
}

async function timeline(
  app: TestApp,
  cookie: string,
  libraryId: number,
  query = "",
): Promise<Response> {
  return app.fetch(
    `/api/libraries/${libraryId}/timeline${query === "" ? "" : `?${query}`}`,
    { headers: { cookie } },
  );
}

async function timelineOk(
  app: TestApp,
  cookie: string,
  libraryId: number,
  query = "",
): Promise<Timeline> {
  const res = await timeline(app, cookie, libraryId, query);
  assert.equal(res.status, 200);
  return (await res.json()) as Timeline;
}

test("Timeline drills decade → year → month → day with covers and counts", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);

    const old = await uploadExif(app, cookie, lib.id, "2019:03:04 05:06:07");
    const morning = await uploadExif(
      app,
      cookie,
      lib.id,
      "2021:06:15 10:30:00",
    );
    const evening = await uploadExif(
      app,
      cookie,
      lib.id,
      "2021:06:15 20:00:00",
    );
    const july = await uploadExif(app, cookie, lib.id, "2021:07:01 08:00:00");

    const decades = await timelineOk(app, cookie, lib.id, "level=decade");
    assert.equal(decades.level, "decade");
    assert.deepEqual(
      decades.periods.map((p) => p.key),
      ["2020", "2010"],
      "newest decade first",
    );
    const decade2010 = decades.periods.find((p) => p.key === "2010")!;
    assert.equal(decade2010.count, 1);
    assert.equal(decade2010.assetCount, 1);
    assert.equal(decade2010.cover.id, old.id);
    assert.equal(decade2010.coverAsset.id, old.id);
    assert.equal(
      decade2010.cover.thumbnailUrl,
      `/api/assets/${old.id}/thumbnail`,
    );
    assert.equal(decade2010.label, "2010s");
    const decade2020 = decades.periods.find((p) => p.key === "2020")!;
    assert.equal(decade2020.count, 3);
    assert.equal(decade2020.cover.id, july.id, "cover is the newest Asset");

    const years = await timelineOk(
      app,
      cookie,
      lib.id,
      "level=year&decade=2020",
    );
    assert.deepEqual(
      years.periods.map((p) => p.key),
      ["2021"],
    );
    assert.equal(years.periods[0].count, 3);
    assert.equal(years.periods[0].cover.id, july.id);

    const months = await timelineOk(
      app,
      cookie,
      lib.id,
      "level=month&year=2021",
    );
    assert.deepEqual(
      months.periods.map((p) => p.key),
      ["2021-07", "2021-06"],
    );
    assert.equal(months.periods.find((p) => p.key === "2021-06")!.count, 2);

    const days = await timelineOk(
      app,
      cookie,
      lib.id,
      "level=day&month=2021-06",
    );
    assert.deepEqual(
      days.periods.map((p) => p.key),
      ["2021-06-15"],
    );
    const day = days.periods[0];
    assert.equal(day.count, 2);
    assert.equal(day.cover.id, evening.id, "cover is the latest that day");
    assert.equal(day.assets?.length, 2);
    assert.equal(days.assets?.length, 2);
    assert.ok(
      days.assets!.some((a) => a.id === morning.id) &&
        days.assets!.some((a) => a.id === evening.id),
    );
  } finally {
    await app.stop();
  }
});

test("a date-range filter limits the Timeline and the Asset grid", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);

    await uploadExif(app, cookie, lib.id, "2018:02:03 04:05:06");
    const inside = await uploadExif(app, cookie, lib.id, "2020:07:08 09:10:11");
    await uploadExif(app, cookie, lib.id, "2022:11:12 13:14:15");

    const years = await timelineOk(
      app,
      cookie,
      lib.id,
      "level=year&from=2019-01-01&to=2021-12-31",
    );
    assert.deepEqual(
      years.periods.map((p) => p.key),
      ["2020"],
    );
    assert.equal(years.total, 1);
    assert.equal(years.periods[0].cover.id, inside.id);

    const decades = await timelineOk(
      app,
      cookie,
      lib.id,
      "level=decade&from=2019-01-01&to=2021-12-31",
    );
    assert.deepEqual(
      decades.periods.map((p) => p.key),
      ["2020"],
    );

    const yearOnly = await timelineOk(
      app,
      cookie,
      lib.id,
      "level=year&from=2020&to=2020",
    );
    assert.deepEqual(
      yearOnly.periods.map((p) => p.key),
      ["2020"],
    );
    assert.equal(yearOnly.total, 1);

    const grid = await app.fetch(
      `/api/libraries/${lib.id}/assets?from=2019-01-01&to=2021-12-31`,
      { headers: { cookie } },
    );
    assert.equal(grid.status, 200);
    const { assets } = (await grid.json()) as { assets: Asset[] };
    assert.deepEqual(
      assets.map((a) => a.id),
      [inside.id],
    );

    const tooLate = await timeline(
      app,
      cookie,
      lib.id,
      "from=2022-01-01&to=2021-01-01",
    );
    assert.equal(tooLate.status, 400);
  } finally {
    await app.stop();
  }
});

test("correcting an Asset's date moves it in the Timeline without altering the original", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);

    const bytes = await makeJpegWithCaptureDate("2010:01:02 03:04:05");
    const asset = await upload(app, cookie, lib.id, bytes, {
      filename: "scanned.jpg",
    });
    const before = await timelineOk(app, cookie, lib.id, "level=decade");
    assert.ok(before.periods.some((p) => p.key === "2010"));

    const original = await app.fetch(asset.originalUrl, {
      headers: { cookie },
    });
    const originalBytes = Buffer.from(await original.arrayBuffer());
    assert.ok(originalBytes.equals(bytes));

    const patched = await app.fetch(`/api/assets/${asset.id}/date`, {
      method: "PATCH",
      headers: { cookie },
      body: JSON.stringify({ date: "2020-05-06T12:00:00.000Z" }),
    });
    assert.equal(patched.status, 200);
    const updated = (await patched.json()) as Asset;
    assert.equal(updated.id, asset.id);
    assert.equal(updated.captureDate, "2020-05-06T12:00:00.000Z");
    assert.equal(updated.captureSource, "exif");
    assert.equal(updated.dateOverridden, true);

    const after = await timelineOk(app, cookie, lib.id, "level=decade");
    assert.ok(!after.periods.some((p) => p.key === "2010"));
    const may = await timelineOk(
      app,
      cookie,
      lib.id,
      "level=month&year=2020",
    );
    assert.deepEqual(
      may.periods.map((p) => p.key),
      ["2020-05"],
    );
    assert.equal(may.periods[0].cover.id, asset.id);

    const afterDownload = await app.fetch(asset.originalUrl, {
      headers: { cookie },
    });
    assert.ok(Buffer.from(await afterDownload.arrayBuffer()).equals(bytes));

    // The alias PATCH /api/assets/:id accepts the same correction.
    const alias = await app.fetch(`/api/assets/${asset.id}`, {
      method: "PATCH",
      headers: { cookie },
      body: JSON.stringify({ captureDate: "2021-09-10T11:12:13.000Z" }),
    });
    assert.equal(alias.status, 200);
    assert.equal(
      ((await alias.json()) as Asset).captureDate,
      "2021-09-10T11:12:13.000Z",
    );
  } finally {
    await app.stop();
  }
});

test("Assets with no EXIF date remain findable in the Timeline", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);

    const fileModifiedMs = Date.UTC(1985, 4, 20, 6, 7, 8);
    const datedByFile = await upload(
      app,
      cookie,
      lib.id,
      await makePng(),
      { filename: "scan.png", fileModifiedMs },
    );
    assert.equal(datedByFile.captureSource, "file");

    // A photo with neither EXIF nor a client-supplied file date still lands
    // in the Timeline at its Upload fallback date.
    const undated = await upload(app, cookie, lib.id, await makePng(), {
      filename: "mystery.png",
    });

    const all = await timelineOk(app, cookie, lib.id, "level=year");
    assert.equal(all.total, 2);
    assert.ok(all.periods.some((p) => p.key === "1985"));

    const fallbackDay = undated.captureDate.slice(0, 10);
    const day = await timelineOk(
      app,
      cookie,
      lib.id,
      `level=day&day=${fallbackDay}`,
    );
    assert.equal(day.total, 1);
    assert.equal(day.periods[0].cover.id, undated.id);

    const ranged = await timelineOk(
      app,
      cookie,
      lib.id,
      "level=year&from=1985-01-01&to=1985-12-31",
    );
    assert.deepEqual(
      ranged.periods.map((p) => p.key),
      ["1985"],
    );
    assert.equal(ranged.periods[0].cover.id, datedByFile.id);
  } finally {
    await app.stop();
  }
});

test("Timeline drill-down works through path segments and back", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);

    await uploadExif(app, cookie, lib.id, "2018:02:03 04:05:06");
    await uploadExif(app, cookie, lib.id, "2020:06:15 10:30:00");
    await uploadExif(app, cookie, lib.id, "2021:07:01 08:00:00");

    const root = await timeline(app, cookie, lib.id, "");
    assert.equal(root.status, 200);
    assert.deepEqual(
      ((await root.json()) as Timeline).periods.map((p) => p.key),
      ["2020", "2010"],
    );

    // A trailing slash on the root still means the default (decade) level.
    assert.equal((await timeline(app, cookie, lib.id, "")).status, 200);
    const trailing = await app.fetch(
      `/api/libraries/${lib.id}/timeline/`,
      { headers: { cookie } },
    );
    assert.equal(trailing.status, 200);

    // A full date for the decade selector is normalised to its decade.
    const years = await timelineOk(app, cookie, lib.id, "level=year&decade=2020-01-01");
    assert.deepEqual(
      years.periods.map((p) => p.key),
      ["2021", "2020"],
    );

    const pathYears = await app.fetch(
      `/api/libraries/${lib.id}/timeline/year/2020s`,
      { headers: { cookie } },
    );
    assert.equal(pathYears.status, 200);
    assert.deepEqual(
      ((await pathYears.json()) as Timeline).periods.map((p) => p.key),
      ["2021", "2020"],
    );

    const pathMonths = await app.fetch(
      `/api/libraries/${lib.id}/timeline/month/2020`,
      { headers: { cookie } },
    );
    assert.deepEqual(
      ((await pathMonths.json()) as Timeline).periods.map((p) => p.key),
      ["2020-06"],
    );

    const pathDays = await app.fetch(
      `/api/libraries/${lib.id}/timeline/day/2020-06`,
      { headers: { cookie } },
    );
    assert.deepEqual(
      ((await pathDays.json()) as Timeline).periods.map((p) => p.key),
      ["2020-06-15"],
    );

    // Back out to the decade level without any parent selector.
    const back = await app.fetch(
      `/api/libraries/${lib.id}/timeline/decade`,
      { headers: { cookie } },
    );
    assert.deepEqual(
      ((await back.json()) as Timeline).periods.map((p) => p.key),
      ["2020", "2010"],
    );
  } finally {
    await app.stop();
  }
});

test("Timeline and date correction respect Library access", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const bobCookie = await joinMember(app, adminCookie, "bob@example.com");
    const bobPrivate = await privateLibrary(app, bobCookie);
    const asset = await uploadExif(
      app,
      bobCookie,
      bobPrivate.id,
      "2020:01:02 03:04:05",
    );

    assert.equal(
      (await timeline(app, aliceCookie, bobPrivate.id)).status,
      404,
    );
    assert.equal(
      (await timeline(app, bobCookie, bobPrivate.id)).status,
      200,
    );

    const patch = await app.fetch(`/api/assets/${asset.id}/date`, {
      method: "PATCH",
      headers: { cookie: aliceCookie },
      body: JSON.stringify({ date: "2000-01-01T00:00:00.000Z" }),
    });
    assert.equal(patch.status, 404);

    assert.equal(
      (await timeline(app, "", bobPrivate.id)).status,
      401,
    );
  } finally {
    await app.stop();
  }
});

test("Timeline rejects an unknown level or an invalid corrected date", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const asset = await uploadExif(
      app,
      cookie,
      lib.id,
      "2020:01:02 03:04:05",
    );

    assert.equal(
      (await timeline(app, cookie, lib.id, "level=century")).status,
      400,
    );
    const patch = await app.fetch(`/api/assets/${asset.id}/date`, {
      method: "PATCH",
      headers: { cookie },
      body: JSON.stringify({ date: "not-a-date" }),
    });
    assert.equal(patch.status, 400);
    assert.equal(((await patch.json()) as { error: string }).error, "invalid_date");
  } finally {
    await app.stop();
  }
});
