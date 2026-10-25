import type { DatabaseSync } from "node:sqlite";

import { HttpError } from "./http.ts";

/** The three Rating flags an Asset can carry (GLOSSARY, PRD Rating). */
export type RatingFlag = "unflagged" | "pick" | "reject";

/** A partial Rating change: only the fields present are updated. */
export interface RatingChange {
  flag?: RatingFlag;
  stars?: number;
}

/** Apply a partial Rating change to one Asset; omitted fields are untouched. */
export function applyRatingChange(
  db: DatabaseSync,
  assetId: number,
  change: RatingChange,
): void {
  const sets: string[] = [];
  const params: (string | number)[] = [];
  if (change.flag !== undefined) {
    sets.push("flag = ?");
    params.push(change.flag);
  }
  if (change.stars !== undefined) {
    sets.push("stars = ?");
    params.push(change.stars);
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE asset SET ${sets.join(", ")} WHERE id = ?`).run(
    ...params,
    assetId,
  );
}

const FLAG_WORDS: Readonly<Record<string, RatingFlag>> = {
  pick: "pick",
  picked: "pick",
  keep: "pick",
  kept: "pick",
  approve: "pick",
  approved: "pick",
  p: "pick",
  yes: "pick",
  true: "pick",
  "1": "pick",
  "+": "pick",
  reject: "reject",
  rejected: "reject",
  reject_photo: "reject",
  x: "reject",
  no: "reject",
  false: "reject",
  "-1": "reject",
  "-": "reject",
  trash: "reject",
  unflagged: "unflagged",
  unflag: "unflagged",
  none: "unflagged",
  neutral: "unflagged",
  clear: "unflagged",
  cleared: "unflagged",
  "0": "unflagged",
  "": "unflagged",
};

/** Normalise any accepted flag spelling; invalid values are a 400. */
export function normaliseFlag(value: unknown): RatingFlag {
  if (value === null) return "unflagged";
  if (typeof value === "boolean") return value ? "pick" : "unflagged";
  if (typeof value === "number") {
    if (value === 1) return "pick";
    if (value === -1) return "reject";
    if (value === 0) return "unflagged";
    throw new HttpError(400, "invalid_flag");
  }
  if (typeof value !== "string") throw new HttpError(400, "invalid_flag");
  const flag = FLAG_WORDS[value.trim().toLowerCase()];
  if (flag === undefined) throw new HttpError(400, "invalid_flag");
  return flag;
}

/** Normalise a stars value to 0-5; 0 and null clear the stars. */
export function normaliseStars(value: unknown): number {
  if (value === null) return 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (text === "" || text === "none" || text === "clear" || text === "unrated") {
      return 0;
    }
  }
  const stars =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;
  if (!Number.isInteger(stars) || stars < 0 || stars > 5) {
    throw new HttpError(400, "invalid_stars");
  }
  return stars;
}

function firstPresent(
  body: Record<string, unknown>,
  keys: readonly string[],
): { key: string; value: unknown } | null {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      return { key, value: body[key] };
    }
  }
  return null;
}

function flagWordTruthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return Boolean(value);
  const text = value.trim().toLowerCase();
  return !["", "0", "false", "no", "hide", "hidden", "exclude"].includes(text);
}

const FLAG_KEYS = [
  "flag",
  "ratingFlag",
  "rating_flag",
  "flagValue",
  "flag_value",
] as const;

const STAR_KEYS = [
  "stars",
  "star",
  "ratingStars",
  "rating_stars",
  "starRating",
  "star_rating",
] as const;

const RATING_KEYS = ["rating", "ratingValue", "rating_value"] as const;

/**
 * Read a Rating change from a request body. Accepts the canonical flag/stars
 * fields plus the common aliases (ratingFlag, pick/rejected booleans, rating
 * for stars). Returns an empty object when the body carries no Rating field;
 * callers decide whether that is an error.
 */
export function ratingChangeFromBody(
  body: Record<string, unknown>,
): RatingChange {
  const change: RatingChange = {};

  const explicitFlag = firstPresent(body, FLAG_KEYS);
  if (explicitFlag) {
    change.flag = normaliseFlag(explicitFlag.value);
  } else {
    const pick = firstPresent(body, ["pick", "picked", "keep"]);
    const reject = firstPresent(body, [
      "rejected",
      "reject",
      "trashed",
      "trash",
    ]);
    if (pick || reject) {
      if (reject && flagWordTruthy(reject.value)) {
        change.flag = "reject";
      } else if (pick && flagWordTruthy(pick.value)) {
        change.flag = "pick";
      } else {
        change.flag = "unflagged";
      }
    }
  }

  const stars = firstPresent(body, STAR_KEYS);
  if (stars) {
    change.stars = normaliseStars(stars.value);
  } else {
    const rating = firstPresent(body, RATING_KEYS);
    if (rating) {
      if (rating.value === -1 || rating.value === "-1") {
        if (change.flag === undefined) change.flag = "reject";
      } else {
        change.stars = normaliseStars(rating.value);
      }
    }
  }

  // A keyboard shortcut may also drive a plain per-Asset update.
  if (change.flag === undefined && change.stars === undefined) {
    const key = firstPresent(body, ["key", "shortcut"]);
    if (key) Object.assign(change, ratingChangeFromKey(key.value));
  }

  return change;
}

/**
 * Map the keyboard shortcuts of the Quick review view: P = Pick, X = Reject,
 * 1-5 = stars. Also accepts U to unflag and 0 to clear stars.
 */
export function ratingChangeFromKey(value: unknown): RatingChange {
  if (typeof value !== "string") throw new HttpError(400, "invalid_key");
  const key = value.trim().toLowerCase();
  switch (key) {
    case "p":
    case "pick":
      return { flag: "pick" };
    case "x":
    case "reject":
      return { flag: "reject" };
    case "u":
    case "unflag":
    case "unflagged":
      return { flag: "unflagged" };
    case "0":
    case "clear":
      return { stars: 0 };
    case "1":
    case "2":
    case "3":
    case "4":
    case "5":
      return { stars: Number(key) };
    default:
      throw new HttpError(400, "invalid_key");
  }
}

export interface SqlFilter {
  clauses: string[];
  params: (string | number)[];
}

export function queryFirst(
  url: URL,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value !== null && value.trim() !== "") return value.trim();
  }
  return undefined;
}

export function queryHas(url: URL, names: readonly string[]): boolean {
  return names.some((name) => url.searchParams.has(name));
}

function numericStars(value: string): number {
  const stars = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(stars) || stars < 0 || stars > 5) {
    throw new HttpError(400, "invalid_stars");
  }
  return stars;
}

/**
 * Build the SQL predicate for Rating filters from a query string. Supports
 * flag/pick/rejected selectors, star minimums and maximums, and hiding
 * Rejected Assets while keeping them in the Library (PRD Rating).
 */
export function ratingFilterFromQuery(url: URL): SqlFilter {
  const filter: SqlFilter = { clauses: [], params: [] };
  let flag: RatingFlag | undefined;
  let excludeRejected = false;

  const flagRaw = queryFirst(url, [
    "flag",
    "ratingFlag",
    "rating_flag",
    "flagFilter",
    "flag_filter",
  ]);
  if (flagRaw && !["all", "any", "*"].includes(flagRaw.toLowerCase())) {
    flag = normaliseFlag(flagRaw);
  }

  const pick = queryFirst(url, ["pick", "picked"]);
  if (pick && flagWordTruthy(pick)) flag = "pick";

  if (queryHas(url, ["hideRejected", "hide_rejected"])) {
    excludeRejected = flagWordTruthy(
      queryFirst(url, ["hideRejected", "hide_rejected"]),
    );
  }
  const includeRejected = queryFirst(url, [
    "includeRejected",
    "include_rejected",
  ]);
  if (includeRejected !== undefined && !flagWordTruthy(includeRejected)) {
    excludeRejected = true;
  }
  const showRejected = queryFirst(url, ["showRejected", "show_rejected"]);
  if (showRejected !== undefined && !flagWordTruthy(showRejected)) {
    excludeRejected = true;
  }

  const rejectedRaw = queryFirst(url, ["rejected", "reject"]);
  if (rejectedRaw !== undefined) {
    const text = rejectedRaw.toLowerCase();
    if (["hide", "hidden", "false", "exclude", "no", "0"].includes(text)) {
      excludeRejected = true;
    } else if (["only", "true", "show", "yes", "1"].includes(text)) {
      flag = "reject";
    } else {
      flag = normaliseFlag(rejectedRaw);
    }
  }

  if (flag !== undefined) {
    filter.clauses.push("flag = ?");
    filter.params.push(flag);
  }
  if (excludeRejected) {
    filter.clauses.push("flag != 'reject'");
  }

  const minRaw = queryFirst(url, [
    "minStars",
    "min_stars",
    "starsMin",
    "stars_min",
    "atLeastStars",
    "at_least_stars",
    "starsFrom",
    "stars_from",
  ]);
  const maxRaw = queryFirst(url, [
    "maxStars",
    "max_stars",
    "starsMax",
    "stars_max",
    "atMostStars",
    "at_most_stars",
    "starsTo",
    "stars_to",
  ]);
  const starsRaw = queryFirst(url, [
    "stars",
    "star",
    "starRating",
    "star_rating",
  ]);
  const ratingRaw = queryFirst(url, [
    "rating",
    "ratingStars",
    "rating_stars",
  ]);

  const addMin = (raw: string): void => {
    if (["all", "any", "*"].includes(raw.toLowerCase())) return;
    const stars = numericStars(raw);
    if (stars > 0) {
      filter.clauses.push("stars >= ?");
      filter.params.push(stars);
    }
  };
  const addMax = (raw: string): void => {
    if (["all", "any", "*"].includes(raw.toLowerCase())) return;
    const stars = numericStars(raw);
    if (stars < 5) {
      filter.clauses.push("stars <= ?");
      filter.params.push(stars);
    }
  };

  if (minRaw !== undefined) addMin(minRaw);
  if (maxRaw !== undefined) addMax(maxRaw);
  if (starsRaw !== undefined) {
    const range = /^(\d)-(\d)$/.exec(starsRaw);
    if (range) {
      addMin(range[1]);
      addMax(range[2]);
    } else {
      addMin(starsRaw);
    }
  }
  if (ratingRaw !== undefined) {
    const text = ratingRaw.toLowerCase();
    if (ratingRaw === "-1" || text === "reject" || text === "rejected") {
      if (flag === undefined) {
        filter.clauses.push("flag = 'reject'");
      }
    } else if (text === "pick" || text === "picked" || text === "keep") {
      if (flag === undefined) {
        filter.clauses.push("flag = 'pick'");
      }
    } else {
      addMin(ratingRaw);
    }
  }

  return filter;
}
