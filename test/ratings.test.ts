import assert from "node:assert/strict";
import { test } from "node:test";

import { makeJpeg } from "./helpers/images.ts";
import { startTestApp, sessionCookie, type TestApp } from "./helpers/harness.ts";

const PASSWORD = "correct-horse-battery";

interface Library {
  id: number;
  kind: "private" | "family";
}

type Flag = "pick" | "reject" | "unflagged";

interface Asset {
  id: number;
  filename: string;
  flag: Flag;
  ratingFlag: Flag;
  stars: number;
  pick: boolean;
  rejected: boolean;
  dimmed: boolean;
  captureDate: string;
  originalUrl: string;
}

interface Review {
  total: number;
  position: number;
  current: Asset | null;
  previous: Asset | null;
  next: Asset | null;
  shortcuts: Record<string, string[]>;
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
  filename: string,
  fileModifiedMs?: number,
): Promise<Asset> {
  const headers: Record<string, string> = { cookie, "x-filename": filename };
  if (fileModifiedMs !== undefined) {
    headers["x-file-modified-ms"] = String(fileModifiedMs);
  }
  const res = await app.fetch(`/api/libraries/${libraryId}/assets`, {
    method: "POST",
    headers,
    body: await makeJpeg(),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as Asset;
}

async function rate(
  app: TestApp,
  cookie: string,
  assetId: number,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.fetch(`/api/assets/${assetId}/rating`, {
    method: "PATCH",
    headers: { cookie },
    body: JSON.stringify(body),
  });
}

async function list(
  app: TestApp,
  cookie: string,
  libraryId: number,
  query = "",
): Promise<Asset[]> {
  const res = await app.fetch(
    `/api/libraries/${libraryId}/assets${query === "" ? "" : `?${query}`}`,
    { headers: { cookie } },
  );
  assert.equal(res.status, 200);
  return ((await res.json()) as { assets: Asset[] }).assets;
}

async function review(
  app: TestApp,
  cookie: string,
  libraryId: number,
  query = "",
): Promise<Review> {
  const res = await app.fetch(
    `/api/libraries/${libraryId}/review${query === "" ? "" : `?${query}`}`,
    { headers: { cookie } },
  );
  assert.equal(res.status, 200);
  return (await res.json()) as Review;
}

test("a Member can set and clear a Pick, Reject or unflagged flag on an Asset", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const asset = await upload(app, cookie, lib.id, "one.jpg");

    assert.equal(asset.flag, "unflagged");
    assert.equal(asset.stars, 0);
    assert.equal(asset.rejected, false);

    const picked = await rate(app, cookie, asset.id, { flag: "pick" });
    assert.equal(picked.status, 200);
    let updated = (await picked.json()) as Asset;
    assert.equal(updated.flag, "pick");
    assert.equal(updated.ratingFlag, "pick");
    assert.equal(updated.pick, true);
    assert.equal(updated.rejected, false);

    const rejected = await rate(app, cookie, asset.id, { flag: "Reject" });
    assert.equal(rejected.status, 200);
    updated = (await rejected.json()) as Asset;
    assert.equal(updated.flag, "reject");
    assert.equal(updated.rejected, true);
    assert.equal(updated.dimmed, true);

    const cleared = await rate(app, cookie, asset.id, { flag: "unflagged" });
    assert.equal(cleared.status, 200);
    updated = (await cleared.json()) as Asset;
    assert.equal(updated.flag, "unflagged");
    assert.equal(updated.rejected, false);

    // The generic Asset PATCH accepts rating fields too.
    const viaPatch = await app.fetch(`/api/assets/${asset.id}`, {
      method: "PATCH",
      headers: { cookie },
      body: JSON.stringify({ ratingFlag: "pick" }),
    });
    assert.equal(viaPatch.status, 200);
    assert.equal(((await viaPatch.json()) as Asset).flag, "pick");

    const invalid = await rate(app, cookie, asset.id, { flag: "maybe" });
    assert.equal(invalid.status, 400);
    assert.equal(((await invalid.json()) as { error: string }).error, "invalid_flag");
  } finally {
    await app.stop();
  }
});

test("a Member can set 1-5 stars and clear them", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const asset = await upload(app, cookie, lib.id, "stars.jpg");

    for (const stars of [1, 2, 3, 4, 5]) {
      const res = await rate(app, cookie, asset.id, { stars });
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as Asset).stars, stars);
    }

    const cleared = await rate(app, cookie, asset.id, { stars: 0 });
    assert.equal(cleared.status, 200);
    assert.equal(((await cleared.json()) as Asset).stars, 0);

    const clearedAgain = await rate(app, cookie, asset.id, { stars: null });
    assert.equal(clearedAgain.status, 200);
    assert.equal(((await clearedAgain.json()) as Asset).stars, 0);

    for (const bad of [-1, 6, 2.5, "many"]) {
      const res = await rate(app, cookie, asset.id, { stars: bad });
      assert.equal(res.status, 400, `stars=${String(bad)} should be rejected`);
      assert.equal(
        ((await res.json()) as { error: string }).error,
        "invalid_stars",
      );
    }

    const missing = await rate(app, cookie, asset.id, {});
    assert.equal(missing.status, 400);
    assert.equal(((await missing.json()) as { error: string }).error, "missing_rating");
  } finally {
    await app.stop();
  }
});

test("Rating can be set and cleared in bulk for Assets in a Library", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const a = await upload(app, cookie, lib.id, "a.jpg");
    const b = await upload(app, cookie, lib.id, "b.jpg");
    const c = await upload(app, cookie, lib.id, "c.jpg");

    const bulk = await app.fetch(`/api/libraries/${lib.id}/assets/ratings`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ assetIds: [a.id, b.id], flag: "pick", stars: 4 }),
    });
    assert.equal(bulk.status, 200);
    const body = (await bulk.json()) as { updated: Asset[] };
    assert.equal(body.updated.length, 2);
    assert.deepEqual(
      body.updated.map((asset) => asset.id).sort((x, y) => x - y),
      [a.id, b.id].sort((x, y) => x - y),
    );
    assert.ok(body.updated.every((asset) => asset.flag === "pick" && asset.stars === 4));

    assert.equal((await list(app, cookie, lib.id, "flag=pick")).length, 2);
    assert.equal((await list(app, cookie, lib.id, "stars=4")).length, 2);
    const untouched = (await list(app, cookie, lib.id)).find((x) => x.id === c.id)!;
    assert.equal(untouched.flag, "unflagged");
    assert.equal(untouched.stars, 0);

    const clear = await app.fetch(`/api/libraries/${lib.id}/assets/ratings`, {
      method: "PATCH",
      headers: { cookie },
      body: JSON.stringify({ ids: [a.id, b.id], flag: "unflagged", stars: 0 }),
    });
    assert.equal(clear.status, 200);
    assert.ok(
      (await list(app, cookie, lib.id)).every(
        (asset) => asset.flag === "unflagged" && asset.stars === 0,
      ),
    );

    const empty = await app.fetch(`/api/libraries/${lib.id}/assets/ratings`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ assetIds: [], flag: "pick" }),
    });
    assert.equal(empty.status, 400);
    assert.equal(((await empty.json()) as { error: string }).error, "missing_assetIds");

    const otherLib = await (async () => {
      const res = await app.fetch("/api/libraries", { headers: { cookie } });
      const all = ((await res.json()) as { libraries: Library[] }).libraries;
      return all.find((l) => l.kind === "family")!;
    })();
    const wrongLibrary = await app.fetch(
      `/api/libraries/${otherLib.id}/assets/ratings`,
      {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ assetIds: [a.id], flag: "pick" }),
      },
    );
    assert.equal(wrongLibrary.status, 404);
  } finally {
    await app.stop();
  }
});

test("keyboard shortcuts P, X and 1-5 rate the current Asset in a review view", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const older = await upload(
      app,
      cookie,
      lib.id,
      "older.jpg",
      Date.UTC(2020, 0, 1),
    );
    const newest = await upload(
      app,
      cookie,
      lib.id,
      "newest.jpg",
      Date.UTC(2021, 0, 1),
    );

    const queue = await review(app, cookie, lib.id);
    assert.equal(queue.current?.id, newest.id, "review starts at the newest Asset");
    assert.equal(queue.next?.id, older.id);
    assert.equal(queue.previous, null);
    assert.equal(queue.total, 2);
    assert.equal(queue.position, 1);
    assert.ok(queue.shortcuts.pick.includes("P"));
    assert.ok(queue.shortcuts.reject.includes("X"));
    assert.ok(queue.shortcuts.stars.includes("5"));

    const press = (assetId: number, key: string) =>
      app.fetch(`/api/libraries/${lib.id}/review`, {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ assetId, key }),
      });

    const picked = await press(newest.id, "P");
    assert.equal(picked.status, 200);
    let result = (await picked.json()) as Review & {
      asset: Asset;
      applied: { flag?: Flag; stars?: number };
    };
    assert.equal(result.asset.flag, "pick");
    assert.equal(result.applied.flag, "pick");
    assert.equal(result.current?.id, older.id, "advances to the next Asset");

    const rejected = await press(newest.id, "X");
    assert.equal(rejected.status, 200);
    result = (await rejected.json()) as typeof result;
    assert.equal(result.asset.flag, "reject");

    for (const stars of [1, 2, 3, 4, 5]) {
      const res = await press(newest.id, String(stars));
      assert.equal(res.status, 200);
      result = (await res.json()) as typeof result;
      assert.equal(result.asset.stars, stars);
    }

    // The review view also accepts the action on a per-Asset path.
    const perAsset = await app.fetch(
      `/api/libraries/${lib.id}/review/${newest.id}`,
      {
        method: "POST",
        headers: { cookie },
        body: JSON.stringify({ key: "P" }),
      },
    );
    assert.equal(perAsset.status, 200);
    assert.equal(((await perAsset.json()) as { asset: Asset }).asset.flag, "pick");

    const badKey = await press(newest.id, "Q");
    assert.equal(badKey.status, 400);
    assert.equal(((await badKey.json()) as { error: string }).error, "invalid_key");
  } finally {
    await app.stop();
  }
});

test("Rating filters narrow the Asset grid and Timeline", async () => {
  const app = await startTestApp();
  try {
    const cookie = await setupAdmin(app);
    const lib = await privateLibrary(app, cookie);
    const best = await upload(app, cookie, lib.id, "best.jpg");
    const rejected = await upload(app, cookie, lib.id, "rejected.jpg");
    const unrated = await upload(app, cookie, lib.id, "unrated.jpg");

    await rate(app, cookie, best.id, { flag: "pick", stars: 5 });
    await rate(app, cookie, rejected.id, { flag: "reject", stars: 2 });

    assert.deepEqual(
      (await list(app, cookie, lib.id, "flag=pick")).map((a) => a.id),
      [best.id],
    );
    assert.deepEqual(
      (await list(app, cookie, lib.id, "flag=reject")).map((a) => a.id),
      [rejected.id],
    );
    assert.deepEqual(
      (await list(app, cookie, lib.id, "flag=unflagged")).map((a) => a.id),
      [unrated.id],
    );
    assert.deepEqual(
      (await list(app, cookie, lib.id, "stars=5")).map((a) => a.id),
      [best.id],
    );
    assert.deepEqual(
      (await list(app, cookie, lib.id, "minStars=3")).map((a) => a.id),
      [best.id],
    );
    assert.deepEqual(
      (await list(app, cookie, lib.id, "maxStars=2"))
        .map((a) => a.id)
        .sort((x, y) => x - y),
      [rejected.id, unrated.id].sort((x, y) => x - y),
    );

    const defaults = await list(app, cookie, lib.id);
    assert.equal(defaults.length, 3, "Rejected Assets stay in the grid by default");
    const dimmed = defaults.find((a) => a.id === rejected.id)!;
    assert.equal(dimmed.rejected, true);
    assert.equal(dimmed.dimmed, true);

    const hidden = await list(app, cookie, lib.id, "hideRejected=true");
    assert.deepEqual(
      hidden.map((a) => a.id).sort((x, y) => x - y),
      [best.id, unrated.id].sort((x, y) => x - y),
    );

    const hiddenAlias = await list(app, cookie, lib.id, "includeRejected=false");
    assert.equal(hiddenAlias.some((a) => a.id === rejected.id), false);

    const allTimeline = await app.fetch(
      `/api/libraries/${lib.id}/timeline?level=year`,
      { headers: { cookie } },
    );
    assert.equal(allTimeline.status, 200);
    assert.equal(((await allTimeline.json()) as { total: number }).total, 3);

    const picks = await app.fetch(
      `/api/libraries/${lib.id}/timeline?level=year&flag=pick`,
      { headers: { cookie } },
    );
    assert.equal(picks.status, 200);
    const pickTimeline = (await picks.json()) as {
      total: number;
      periods: { cover: Asset }[];
    };
    assert.equal(pickTimeline.total, 1);
    assert.equal(pickTimeline.periods[0].cover.id, best.id);

    const noRejects = await app.fetch(
      `/api/libraries/${lib.id}/timeline?level=year&hideRejected=true`,
      { headers: { cookie } },
    );
    assert.equal(((await noRejects.json()) as { total: number }).total, 2);

    const invalid = await app.fetch(
      `/api/libraries/${lib.id}/assets?flag=maybe`,
      { headers: { cookie } },
    );
    assert.equal(invalid.status, 400);
    assert.equal(((await invalid.json()) as { error: string }).error, "invalid_flag");
  } finally {
    await app.stop();
  }
});

test("Rating respects Library access and requires authentication", async () => {
  const app = await startTestApp();
  try {
    const adminCookie = await setupAdmin(app);
    const aliceCookie = await joinMember(app, adminCookie, "alice@example.com");
    const bobCookie = await joinMember(app, adminCookie, "bob@example.com");
    const bobPrivate = await privateLibrary(app, bobCookie);
    const asset = await upload(app, bobCookie, bobPrivate.id, "bob.jpg");

    assert.equal((await rate(app, "", asset.id, { flag: "pick" })).status, 401);
    assert.equal(
      (await rate(app, aliceCookie, asset.id, { flag: "pick" })).status,
      404,
    );
    assert.equal(
      (
        await app.fetch(`/api/libraries/${bobPrivate.id}/assets/ratings`, {
          method: "POST",
          headers: { cookie: aliceCookie },
          body: JSON.stringify({ assetIds: [asset.id], flag: "pick" }),
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await app.fetch(`/api/libraries/${bobPrivate.id}/review`, {
          headers: { cookie: aliceCookie },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await app.fetch(`/api/libraries/${bobPrivate.id}/review`, {
          method: "POST",
          headers: { cookie: aliceCookie },
          body: JSON.stringify({ assetId: asset.id, key: "P" }),
        })
      ).status,
      404,
    );

    const own = await rate(app, bobCookie, asset.id, { flag: "pick" });
    assert.equal(own.status, 200);
    assert.equal(((await own.json()) as Asset).flag, "pick");
  } finally {
    await app.stop();
  }
});
