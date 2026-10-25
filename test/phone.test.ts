import assert from "node:assert/strict";
import { test } from "node:test";

import { startTestApp, sessionCookie, type TestApp } from "./helpers/harness.ts";

const PASSWORD = "correct-horse-battery";
const ADMIN_EMAIL = "admin@example.com";

interface Library {
  id: number;
  kind: "private" | "family";
}

interface Asset {
  id: number;
  filename: string;
  captureDate: string;
}

interface AssetPage {
  assets: Asset[];
  total: number;
  count: number;
  limit: number | null;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

interface NeighbourView {
  asset: Asset;
  previous: Asset | null;
  next: Asset | null;
  position: number | null;
  total: number;
}

/** An admin session against a fresh app (they own the private and Family Libraries). */
async function setupAdmin(app: TestApp): Promise<string> {
  const res = await app.fetch("/api/setup", {
    method: "POST",
    body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
  });
  assert.equal(res.status, 201);
  return sessionCookie(res)!;
}

async function privateLibrary(app: TestApp, cookie: string): Promise<Library> {
  const res = await app.fetch("/api/libraries", { headers: { cookie } });
  const { libraries } = (await res.json()) as { libraries: Library[] };
  return libraries.find((l) => l.kind === "private")!;
}

/** Base64 JPEG buffer, one per file, all distinct so nothing dedupes. */
async function jpegFile(n: number, width = 60): Promise<string> {
  const { default: sharp } = await import("sharp");
  const buf = await sharp({
    create: {
      width: width + n,
      height: 40,
      channels: 3,
      background: { r: n % 255, g: (n * 7) % 255, b: (n * 13) % 255 },
    },
  })
    .jpeg()
    .toBuffer();
  return buf.toString("base64");
}

/** Upload `n` distinct photos, oldest first, two per day: the first ten sit in
 * December 1996, the rest a month on, so Timeline periods are predictable. */
async function seedPhotos(
  app: TestApp,
  cookie: string,
  libraryId: number,
  n: number,
): Promise<Asset[]> {
  const DAY = 86_400_000;
  const base = Date.UTC(1996, 11, 1);
  for (let start = 0; start < n; start += 100) {
    const files = [];
    for (let i = start; i < Math.min(n, start + 100); i++) {
      files.push({
        filename: `p${i}.jpg`,
        modifiedMs: base + Math.floor(i / 2) * DAY + (i >= 10 ? 32 * DAY : 0),
        contentBase64: await jpegFile(i),
      });
    }
    const res = await app.fetch(`/api/libraries/${libraryId}/assets/batch`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ files }),
    });
    assert.equal(res.status, 200);
    const { results } = (await res.json()) as {
      results: { status: string }[];
    };
    for (const result of results) {
      assert.equal(result.status, "uploaded", "the scale fixture must be distinct");
    }
  }
  const res = await app.fetch(`/api/libraries/${libraryId}/assets`, {
    headers: { cookie },
  });
  return ((await res.json()) as { assets: Asset[] }).assets;
}

test("Grid lists a phone-sized page of Assets and pages through the rest", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const library = await privateLibrary(app, cookie);
    const originals = await seedPhotos(app, cookie, library.id, 13);

    const res = await app.fetch(
      `/api/libraries/${library.id}/assets?limit=5`,
      { headers: { cookie } },
    );
    assert.equal(res.status, 200);
    const page = (await res.json()) as AssetPage;
    assert.equal(page.assets.length, 5);
    assert.equal(page.count, 5);
    assert.equal(page.total, 13);
    assert.equal(page.limit, 5);
    assert.equal(page.offset, 0);
    assert.equal(page.hasMore, true);
    assert.equal(page.nextOffset, 5);
    // Newest first: the first page holds the top five of the full list.
    assert.deepEqual(
      page.assets.map((a) => a.id),
      originals.slice(0, 5).map((a) => a.id),
    );

    const second = await (
      await app.fetch(`/api/libraries/${library.id}/assets?limit=5&offset=5`, {
        headers: { cookie },
      })
    ).json() as AssetPage;
    assert.equal(second.assets.length, 5);
    assert.equal(second.hasMore, true);
    assert.equal(second.nextOffset, 10);
    assert.deepEqual(
      second.assets.map((a) => a.id),
      originals.slice(5, 10).map((a) => a.id),
    );

    const last = await (
      await app.fetch(`/api/libraries/${library.id}/assets?limit=5&offset=10`, {
        headers: { cookie },
      })
    ).json() as AssetPage;
    assert.equal(last.assets.length, 3);
    assert.equal(last.hasMore, false);
    assert.equal(last.nextOffset, null);
    assert.deepEqual(
      last.assets.map((a) => a.id),
      originals.slice(10).map((a) => a.id),
    );

    // A 1-based page number is the same thing as its offset.
    const third = await (
      await app.fetch(`/api/libraries/${library.id}/assets?limit=5&page=3`, {
        headers: { cookie },
      })
    ).json() as AssetPage;
    assert.equal(third.offset, 10);
    assert.deepEqual(
      third.assets.map((a) => a.id),
      originals.slice(10).map((a) => a.id),
    );
  } finally {
    await app.stop();
  }
});

test("Grid paging rejects nonsense requests", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const library = await privateLibrary(app, cookie);
    await seedPhotos(app, cookie, library.id, 3);

    for (const [query, code] of [
      ["limit=0", "invalid_limit"],
      ["limit=-2", "invalid_limit"],
      ["limit=lots", "invalid_limit"],
      ["offset=-1", "invalid_offset"],
      ["offset=soon", "invalid_offset"],
      ["page=0", "invalid_page"],
      ["page=two", "invalid_page"],
    ] as const) {
      const res = await app.fetch(
        `/api/libraries/${library.id}/assets?${query}`,
        { headers: { cookie } },
      );
      assert.equal(res.status, 400, query);
      assert.equal(((await res.json()) as { error: string }).error, code);
    }
  } finally {
    await app.stop();
  }
});

test("Unpaged grid keeps returning the whole Library", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const library = await privateLibrary(app, cookie);
    const originals = await seedPhotos(app, cookie, library.id, 7);
    const res = await app.fetch(`/api/libraries/${library.id}/assets`, {
      headers: { cookie },
    });
    const page = (await res.json()) as AssetPage;
    assert.equal(page.assets.length, 7);
    assert.equal(page.total, 7);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextOffset, null);
    assert.deepEqual(
      page.assets.map((a) => a.id),
      originals.map((a) => a.id),
    );
  } finally {
    await app.stop();
  }
});

test("Timeline pages its periods and a day's Assets", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const library = await privateLibrary(app, cookie);
    await seedPhotos(app, cookie, library.id, 13);

    const res = await app.fetch(
      `/api/libraries/${library.id}/timeline?level=month&limit=1`,
      { headers: { cookie } },
    );
    assert.equal(res.status, 200);
    const page = (await res.json()) as {
      level: string;
      total: number;
      periodCount: number;
      periods: { key: string; count: number }[];
      items: { key: string }[];
      limit: number | null;
      offset: number;
      hasMore: boolean;
    };
    assert.equal(page.level, "month");
    assert.equal(page.total, 13);
    assert.equal(page.periods.length, 1);
    assert.equal(page.periodCount, 2);
    assert.equal(page.hasMore, true);

    const later = (await (
      await app.fetch(
        `/api/libraries/${library.id}/timeline?level=month&limit=1&offset=1`,
        { headers: { cookie } },
      )
    ).json()) as typeof page;
    assert.equal(later.periods.length, 1);
    assert.equal(later.hasMore, false);
    // Newest first: the later month holds 3, the December 1996 one 10.
    assert.equal(page.periods[0].count, 3);
    assert.equal(later.periods[0].count, 10);

    // A day's Asset list pages too: two photos per December day, so the first
    // page is the two newest days and the drill keeps count and total each.
    const dayKey = later.periods[0].key;
    const day = (await (
      await app.fetch(
        `/api/libraries/${library.id}/timeline?level=day&parent=${dayKey}&limit=4`,
        { headers: { cookie } },
      )
    ).json()) as {
      total: number;
      assets: Asset[];
      periodCount: number;
      periods: { count: number; total: number; assets: Asset[] }[];
    };
    assert.equal(day.total, 10);
    assert.equal(day.periodCount, 5);
    assert.equal(day.assets.length, 4);
    assert.equal(day.periods.length, 2);
    assert.equal(day.periods[0].count, 2);
    assert.equal(day.periods[0].total, 2);

    // Inside a single day the window sits within that day alone.
    const sole = (await (
      await app.fetch(
        `/api/libraries/${library.id}/timeline?level=day&parent=1996-12-01&limit=1&offset=1`,
        { headers: { cookie } },
      )
    ).json()) as typeof day;
    assert.equal(sole.assets.length, 1);
    assert.equal(sole.periods.length, 1);
    assert.equal(sole.periods[0].count, 1);
    assert.equal(sole.periods[0].total, 2);
  } finally {
    await app.stop();
  }
});

test("Single-Asset view returns previous and next", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const library = await privateLibrary(app, cookie);
    await seedPhotos(app, cookie, library.id, 5);
    // newest → oldest: 4,3,2,1,0 (ids ascend with dates here)
    const res = await app.fetch(`/api/libraries/${library.id}/assets`, {
      headers: { cookie },
    });
    const { assets } = (await res.json()) as { assets: Asset[] };
    const middle = assets[2];

    const view = (await (
      await app.fetch(
        `/api/libraries/${library.id}/assets/${middle.id}/neighbors`,
        { headers: { cookie } },
      )
    ).json()) as NeighbourView;
    assert.equal(view.asset.id, middle.id);
    assert.equal(view.previous!.id, assets[1].id);
    assert.equal(view.next!.id, assets[3].id);
    assert.equal(view.position, 3);
    assert.equal(view.total, 5);

    const newest = assets[0];
    const first = (await (
      await app.fetch(
        `/api/libraries/${library.id}/assets/${newest.id}/neighbors`,
        { headers: { cookie } },
      )
    ).json()) as NeighbourView;
    assert.equal(first.previous, null);
    assert.equal(first.next!.id, assets[1].id);

    const oldest = assets[4];
    const last = (await (
      await app.fetch(
        `/api/libraries/${library.id}/assets/${oldest.id}/neighbors`,
        { headers: { cookie } },
      )
    ).json()) as NeighbourView;
    assert.equal(last.next, null);
    assert.equal(last.previous!.id, assets[3].id);

    // Oldest-first browsing flips the sides.
    const asc = (await (
      await app.fetch(
        `/api/libraries/${library.id}/assets/${newest.id}/neighbors?order=asc`,
        { headers: { cookie } },
      )
    ).json()) as NeighbourView;
    assert.equal(asc.next, null);
    assert.equal(asc.previous!.id, assets[1].id);

    // The Asset-only alias works without naming the Library.
    const aliased = (await (
      await app.fetch(`/api/assets/${middle.id}/neighbors`, {
        headers: { cookie },
      })
    ).json()) as NeighbourView;
    assert.equal(aliased.asset.id, middle.id);
    assert.equal(aliased.previous!.id, assets[1].id);
  } finally {
    await app.stop();
  }
});

test("Single-Asset next/previous respects the view's filters", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const library = await privateLibrary(app, cookie);
    await seedPhotos(app, cookie, library.id, 5);
    const { assets } = (await (
      await app.fetch(`/api/libraries/${library.id}/assets`, {
        headers: { cookie },
      })
    ).json()) as { assets: Asset[] };
    const middle = assets[2];

    // Reject a neighbour so a hideRejected view must skip over it.
    await app.fetch(`/api/assets/${assets[1].id}/rating`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ flag: "reject" }),
    });
    await app.fetch(`/api/assets/${assets[3].id}/rating`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ flag: "reject" }),
    });

    const view = (await (
      await app.fetch(
        `/api/libraries/${library.id}/assets/${middle.id}/neighbors?hideRejected=true`,
        { headers: { cookie } },
      )
    ).json()) as NeighbourView;
    assert.equal(view.asset.id, middle.id);
    assert.equal(view.position, 2);
    assert.equal(view.total, 3);
    assert.equal(view.previous!.id, assets[0].id);
    assert.equal(view.next!.id, assets[4].id);

    // A hidden Asset still anchors its neighbours: nothing crashes, no leak.
    const hidden = (await (
      await app.fetch(
        `/api/libraries/${library.id}/assets/${assets[1].id}/neighbors?hideRejected=true`,
        { headers: { cookie } },
      )
    ).json()) as NeighbourView;
    assert.equal(hidden.next!.id, middle.id);
    assert.equal(hidden.previous!.id, assets[0].id);
    assert.equal(hidden.position, null);

    // Another Member's Asset stays invisible.
    const invited = await app.fetch("/api/invitations", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ email: "other@example.com" }),
    });
    const { token } = (await invited.json()) as { token: string };
    const accepted = await app.fetch("/api/invitations/accept", {
      method: "POST",
      body: JSON.stringify({ token, password: PASSWORD }),
    });
    assert.equal(accepted.status, 201);
    const otherCookie = sessionCookie(accepted)!;
    const res = await app.fetch(
      `/api/libraries/${library.id}/assets/${middle.id}/neighbors`,
      { headers: { cookie: otherCookie } },
    );
    assert.equal(res.status, 404);
  } finally {
    await app.stop();
  }
});

test("Browsing thousands of Assets stays responsive", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const library = await privateLibrary(app, cookie);
    const TOTAL = 3000;
    const originals = await seedPhotos(app, cookie, library.id, TOTAL);

    const timed = async <T>(label: string, path: string): Promise<T> => {
      const started = performance.now();
      const res = await app.fetch(path, { headers: { cookie } });
      assert.equal(res.status, 200, label);
      const body = (await res.json()) as T;
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 4000, `${label} took ${elapsed.toFixed(0)}ms`);
      return body;
    };

    // A phone-sized grid page, and a Timeline drill-down, both answer fast.
    const page = await timed<AssetPage>(
      "paged grid",
      `/api/libraries/${library.id}/assets?limit=60`,
    );
    assert.equal(page.assets.length, 60);
    assert.equal(page.total, TOTAL);

    await timed(
      "timeline decades",
      `/api/libraries/${library.id}/timeline?level=decade`,
    );
    await timed(
      "timeline months",
      `/api/libraries/${library.id}/timeline?level=year&limit=12`,
    );

    // Flipping through single-Asset views stays quick too.
    const anchor = originals[Math.floor(TOTAL / 2)];
    const neighbours = await timed<NeighbourView>(
      "neighbours",
      `/api/assets/${anchor.id}/neighbors`,
    );
    assert.equal(neighbours.asset.id, anchor.id);
    assert.ok(neighbours.previous !== null);

    // And paging walks to the very end in bounded steps.
    const lastPage = await timed<AssetPage>(
      "last grid page",
      `/api/libraries/${library.id}/assets?limit=60&offset=${TOTAL - 10}`,
    );
    assert.equal(lastPage.assets.length, 10);
    assert.equal(lastPage.hasMore, false);
    assert.equal(lastPage.nextOffset, null);
  } finally {
    await app.stop();
  }
});
