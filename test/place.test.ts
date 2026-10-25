import assert from "node:assert/strict";
import { test } from "node:test";

import { makeJpegWithGps, makePng } from "./helpers/images.ts";
import { sessionCookie, startTestApp, type TestApp } from "./helpers/harness.ts";

const PASSWORD = "correct-horse-battery";

interface Library {
  id: number;
  kind: "private" | "family";
}

/** Grid/Timeline-ready shape of an Asset the API answers with. */
interface Asset {
  id: number;
  filename: string;
  latitude: number | null;
  longitude: number | null;
  hasLocation: boolean;
}

async function setupAdmin(app: TestApp): Promise<string> {
  const res = await app.fetch("/api/setup", {
    method: "POST",
    body: JSON.stringify({ email: "admin@example.com", password: PASSWORD }),
  });
  assert.equal(res.status, 201);
  return sessionCookie(res)!;
}

async function listLibraries(app: TestApp, cookie: string): Promise<Library[]> {
  const res = await app.fetch("/api/libraries", { headers: { cookie } });
  const { libraries } = (await res.json()) as { libraries: Library[] };
  return libraries;
}

async function privateLibrary(app: TestApp, cookie: string): Promise<Library> {
  return (await listLibraries(app, cookie)).find((l) => l.kind === "private")!;
}

function upload(
  app: TestApp,
  cookie: string,
  libraryId: number,
  bytes: Buffer,
): Promise<Response> {
  return app.fetch(`/api/libraries/${libraryId}/assets`, {
    method: "POST",
    headers: { cookie },
    body: bytes,
  });
}

async function uploadAll(
  app: TestApp,
  cookie: string,
  libraryId: number,
  images: Promise<Buffer>[],
): Promise<number[]> {
  const ids: number[] = [];
  for (const image of images) {
    const res = await upload(app, cookie, libraryId, await image);
    assert.equal(res.status, 201);
    const asset = (await res.json()) as Asset;
    ids.push(asset.id);
  }
  return ids;
}

async function listAssets(
  app: TestApp,
  cookie: string,
  libraryId: number,
  query = "",
): Promise<{ assets: Asset[]; total: number }> {
  const res = await app.fetch(`/api/libraries/${libraryId}/assets${query}`, {
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { assets: Asset[]; total: number };
  return json;
}

async function timeline(
  app: TestApp,
  cookie: string,
  libraryId: number,
  query = "",
): Promise<{
  total: number;
  periods: { assets?: Asset[] }[];
}> {
  const res = await app.fetch(
    `/api/libraries/${libraryId}/timeline${query}`,
    { headers: { cookie } },
  );
  assert.equal(res.status, 200);
  return (await res.json()) as { total: number; periods: { assets?: Asset[] }[] };
}

const DMS_TOLERANCE = 1e-4;

test("a geotagged photo carries the place it was taken", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);

    const res = await upload(app, cookie, lib.id, await makeJpegWithGps(52.3676, 4.9041));
    assert.equal(res.status, 201);
    const asset = (await res.json()) as Asset;

    assert.equal(asset.hasLocation, true);
    assert.ok(asset.latitude !== null);
    assert.ok(Math.abs(asset.latitude - 52.3676) < DMS_TOLERANCE);
    assert.ok(asset.longitude !== null);
    assert.ok(Math.abs(asset.longitude - 4.9041) < DMS_TOLERANCE);

    // The grid shows the same place afterwards.
    const { assets } = await listAssets(app, cookie, lib.id);
    const seen = assets.find((a) => a.id === asset.id);
    assert.ok(seen);
    assert.equal(seen.hasLocation, true);
  } finally {
    await app.stop();
  }
});

test("a photo without GPS stays findable and lands in the Timeline", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);

    const res = await upload(app, cookie, lib.id, await makePng());
    assert.equal(res.status, 201);
    const asset = (await res.json()) as Asset;

    assert.equal(asset.hasLocation, false);
    assert.equal(asset.latitude, null);
    assert.equal(asset.longitude, null);

    // Still reachable in the grid...
    const grid = await listAssets(app, cookie, lib.id);
    assert.ok(grid.assets.some((a) => a.id === asset.id));

    // ...and not lost from the Timeline.
    const view = await timeline(app, cookie, lib.id, "?level=day");
    assert.equal(view.total, 1);
    const days = view.periods.flatMap((p) => (p.assets ?? []).map((a) => a.id));
    assert.ok(days.includes(asset.id));
  } finally {
    await app.stop();
  }
});

test("filtering a Library by place returns the matching Assets, and the rest stay out", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);

    const ids = await uploadAll(app, cookie, lib.id, [
      makeJpegWithGps(52.3676, 4.9041), // Amsterdam
      makeJpegWithGps(52.52, 13.405), // Berlin
      makeJpegWithGps(-33.8688, 151.2093), // Sydney
      makePng(), // no location
    ]);
    const [amsterdam, berlin, sydney, unplaced] = ids;

    // Narrowly around Amsterdam: only the Amsterdam photo is in.
    const nearAmsterdam = await listAssets(app, cookie, lib.id, "?lat=52.3676&lon=4.9041");
    assert.deepEqual(
      nearAmsterdam.assets.map((a) => a.id),
      [amsterdam],
    );
    assert.equal(nearAmsterdam.total, 1);

    // A tighter radius keeps it in.
    const tight = await listAssets(
      app,
      cookie,
      lib.id,
      "?latitude=52.3676&longitude=4.9041&radius=5",
    );
    assert.deepEqual(tight.assets.map((a) => a.id), [amsterdam]);

    // Southern hemisphere: signs come from the GPS references.
    const nearSydney = await listAssets(app, cookie, lib.id, "?lat=-33.8688&lon=151.2093");
    assert.deepEqual(nearSydney.assets.map((a) => a.id), [sydney]);

    // Berlin is a different place entirely from Amsterdam's point.
    const nearBerlin = await listAssets(app, cookie, lib.id, "?place=52.52,13.405");
    assert.deepEqual(nearBerlin.assets.map((a) => a.id), [berlin]);

    // Somewhere in the middle of the ocean has nothing — and no unplaced Asset.
    const ocean = await listAssets(app, cookie, lib.id, "?lat=0&lon=0&radius=10");
    assert.deepEqual(ocean.assets, []);
    assert.equal(ocean.total, 0);

    // Filters can ask explicitly for only / other-than located Assets.
    {
      const onlyPlaced = await listAssets(app, cookie, lib.id, "?withLocation=true");
      assert.equal(onlyPlaced.total, 3);
      assert.ok(onlyPlaced.assets.every((a) => a.hasLocation));
    }
    {
      const onlyUnplaced = await listAssets(app, cookie, lib.id, "?withoutLocation=true");
      assert.deepEqual(onlyUnplaced.assets.map((a) => a.id), [unplaced]);
    }
  } finally {
    await app.stop();
  }
});

test("the place filter narrows the Timeline too", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);

    const ids = await uploadAll(app, cookie, lib.id, [
      makeJpegWithGps(52.3676, 4.9041),
      makeJpegWithGps(52.52, 13.405),
      makePng(),
    ]);
    const [amsterdam] = ids;

    const unfiltered = await timeline(app, cookie, lib.id);
    assert.equal(unfiltered.total, 3);

    const filtered = await timeline(
      app,
      cookie,
      lib.id,
      "?lat=52.3676&lon=4.9041&level=day",
    );
    assert.equal(filtered.total, 1);

    // The matching Asset is inside the periods the filtered Timeline shows.
    const dayIds = filtered.periods.flatMap((p) => (p.assets ?? []).map((a) => a.id));
    assert.deepEqual(dayIds, [amsterdam]);
  } finally {
    await app.stop();
  }
});

test("an unusable place filter is rejected, never silently broadened", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    await upload(app, cookie, lib.id, await makeJpegWithGps(52.3676, 4.9041));

    // One coordinate alone names no place.
    assert.equal(
      (await app.fetch(`/api/libraries/${lib.id}/assets?lat=52.3676`, { headers: { cookie } }))
        .status,
      400,
    );
    assert.equal(
      (await app.fetch(`/api/libraries/${lib.id}/assets?lon=4.9041`, { headers: { cookie } }))
        .status,
      400,
    );
    // Out-of-range coordinates.
    assert.equal(
      (await app.fetch(`/api/libraries/${lib.id}/assets?lat=91&lon=0`, { headers: { cookie } }))
        .status,
      400,
    );
    assert.equal(
      (
        await app.fetch(`/api/libraries/${lib.id}/assets?place=0,-181`, {
          headers: { cookie },
        })
      ).status,
      400,
    );
    // A radius must be positive and sane.
    assert.equal(
      (
        await app.fetch(`/api/libraries/${lib.id}/assets?lat=52&lon=4&radius=0`, {
          headers: { cookie },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await app.fetch(`/api/libraries/${lib.id}/assets?lat=52&lon=4&radius=banana`, {
          headers: { cookie },
        })
      ).status,
      400,
    );

    // A named place that is not coordinates is a bad value, if unguessable.
    assert.equal(
      (await app.fetch(`/api/libraries/${lib.id}/assets?place=Amsterdam`, { headers: { cookie } }))
        .status,
      400,
    );
  } finally {
    await app.stop();
  }
});
