import type { DatabaseSync } from "node:sqlite";

import {
  ASSET_COLUMNS_LIGHT,
  effectiveDate,
  publicAsset,
  type AssetRow,
} from "./assets.ts";
import type { Auth, Ctx } from "./auth.ts";
import {
  dateRangeFromQuery,
  dayRange,
  decadeRange,
  intersectRanges,
  monthRange,
  parseDecade,
  type DateRange,
  yearRange,
} from "./dates.ts";
import { HttpError, sendJson } from "./http.ts";
import { libraryAccessibleBy } from "./libraries.ts";
import { parsePaging, pageSlice } from "./paging.ts";
import { ratingFilterFromQuery } from "./rating.ts";

type Level = "decade" | "year" | "month" | "day";

const LEVELS: readonly Level[] = ["decade", "year", "month", "day"];

function normaliseLevel(raw: string | null | undefined): Level {
  const value = (raw ?? "decade").trim().toLowerCase().replace(/s$/, "");
  if ((LEVELS as readonly string[]).includes(value)) return value as Level;
  throw new HttpError(400, "invalid_level");
}

interface Period {
  key: string;
  label: string;
  start: number;
  end: number;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Calendar period a date belongs to at the requested Timeline level. */
function periodFor(level: Level, date: Date): Period {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();

  switch (level) {
    case "decade": {
      const startYear = Math.floor(year / 10) * 10;
      return {
        key: String(startYear),
        label: `${startYear}s`,
        start: Date.UTC(startYear, 0, 1),
        end: Date.UTC(startYear + 10, 0, 1) - 1,
      };
    }
    case "year":
      return {
        key: String(year),
        label: String(year),
        start: Date.UTC(year, 0, 1),
        end: Date.UTC(year + 1, 0, 1) - 1,
      };
    case "month": {
      const key = `${year}-${pad(month)}`;
      return {
        key,
        label: key,
        start: Date.UTC(year, month - 1, 1),
        end: Date.UTC(year, month, 1) - 1,
      };
    }
    case "day": {
      const key = `${year}-${pad(month)}-${pad(day)}`;
      return {
        key,
        label: key,
        start: Date.UTC(year, month - 1, day),
        end: Date.UTC(year, month - 1, day + 1) - 1,
      };
    }
  }
}

function yearOf(raw: string): number | null {
  const match = /^(\d{4})/.exec(raw.trim());
  if (!match) return null;
  return Number(match[1]);
}

/**
 * Interpret a parent period key as the span the next level drills into. A
 * plain year is a decade when the target level is "year", otherwise the year
 * itself; a year-month is a month; a full date is a day.
 */
function parentRange(raw: string, level: Level): DateRange | null {
  const text = raw.trim();
  if (/^\d{4}s$/.test(text)) {
    const start = parseDecade(text);
    return start === null ? null : decadeRange(new Date(start).getUTCFullYear());
  }
  if (/^\d{4}$/.test(text)) {
    const year = Number(text);
    return level === "year"
      ? decadeRange(Math.floor(year / 10) * 10)
      : yearRange(year);
  }
  const month = /^(\d{4})-(\d{1,2})$/.exec(text);
  if (month) {
    const year = Number(month[1]);
    const value = Number(month[2]);
    if (value < 1 || value > 12) return null;
    return monthRange(year, value);
  }
  const day = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (day) {
    return dayRange(Number(day[1]), Number(day[2]), Number(day[3]));
  }
  return null;
}

/**
 * Resolve the scope of one Timeline query from the date range and the
 * drill-down selectors. Every selector narrows the result; an impossible
 * combination yields an empty range.
 */
function resolveScope(params: URLSearchParams, level: Level): DateRange {
  let range = dateRangeFromQuery(new URL(`http://familio.local/?${params}`));

  const decadeRaw = params.get("decade");
  if (decadeRaw !== null && decadeRaw.trim() !== "") {
    const start = parseDecade(decadeRaw);
    if (start === null) throw new HttpError(400, "invalid_decade");
    range = intersectRanges(range, decadeRange(new Date(start).getUTCFullYear()));
  }

  const yearRaw = params.get("year");
  let selectedYear: number | null = null;
  if (yearRaw !== null && yearRaw.trim() !== "") {
    selectedYear = yearOf(yearRaw);
    if (selectedYear === null) throw new HttpError(400, "invalid_year");
    range = intersectRanges(range, yearRange(selectedYear));
  }

  const monthRaw = params.get("month");
  let selectedMonth: number | null = null;
  if (monthRaw !== null && monthRaw.trim() !== "") {
    const full = /^(\d{4})-(\d{1,2})$/.exec(monthRaw.trim());
    if (full) {
      selectedYear = Number(full[1]);
      selectedMonth = Number(full[2]);
    } else if (/^\d{1,2}$/.test(monthRaw.trim())) {
      selectedMonth = Number(monthRaw.trim());
    } else {
      throw new HttpError(400, "invalid_month");
    }
    if (
      selectedMonth < 1 ||
      selectedMonth > 12 ||
      selectedYear === null
    ) {
      throw new HttpError(400, "invalid_month");
    }
    range = intersectRanges(range, monthRange(selectedYear, selectedMonth));
  }

  const dayRaw = params.get("day");
  if (dayRaw !== null && dayRaw.trim() !== "") {
    const full = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dayRaw.trim());
    let year = selectedYear;
    let month = selectedMonth;
    let day: number;
    if (full) {
      year = Number(full[1]);
      month = Number(full[2]);
      day = Number(full[3]);
    } else if (/^\d{1,2}$/.test(dayRaw.trim())) {
      day = Number(dayRaw.trim());
    } else {
      throw new HttpError(400, "invalid_day");
    }
    if (year === null || month === null) {
      throw new HttpError(400, "invalid_day");
    }
    range = intersectRanges(range, dayRange(year, month, day));
  }

  const parentRaw =
    params.get("parent") ??
    params.get("period") ??
    params.get("key") ??
    params.get("at") ??
    params.get("date") ??
    params.get("cursor");
  if (parentRaw !== null && parentRaw.trim() !== "") {
    const parent = parentRange(parentRaw, level);
    if (parent === null) throw new HttpError(400, "invalid_period");
    range = intersectRanges(range, parent);
  }

  return range;
}

interface PeriodBucket {
  period: Period;
  assets: AssetRow[];
}

/** One Timeline period as the API returns it (`assets` at day level only). */
interface PeriodView {
  level: Level;
  key: string;
  period: string;
  label: string;
  start: string;
  end: string;
  startDate: string;
  endDate: string;
  from: string;
  to: string;
  count: number;
  assetCount: number;
  total: number;
  cover: Record<string, unknown>;
  coverAsset: Record<string, unknown>;
  coverId: number;
  coverAssetId: number;
  assets?: Record<string, unknown>[];
}

/**
 * Build the Timeline API: a read view over one Library that drills from decade
 * to year to month to day, each period carrying its count and a cover Asset
 * (the newest one), filterable by date range. Dates are the effective capture
 * date — a Member's correction wins over the derived EXIF/file date — while
 * the original file remains untouched (PRD Timeline, ADR 0003).
 */
export function createTimeline(db: DatabaseSync, auth: Auth) {
  const requireMember = (ctx: Ctx) => {
    const member = auth.currentMember(ctx.cookies);
    if (!member) throw new HttpError(401, "unauthenticated");
    return member;
  };

  const list = (ctx: Ctx): void => {
    const member = requireMember(ctx);
    const libraryId = Number(ctx.params.id);
    if (!libraryAccessibleBy(db, libraryId, member.id)) {
      throw new HttpError(404, "library_not_found");
    }

    const url = new URL(ctx.req.url ?? "/", "http://familio.local");
    // Path form: /timeline/year/2020 drills into 2020 while /timeline?…
    // uses query selectors. Both ultimately use the same scope resolver.
    const pathParts = (ctx.params.path ?? "")
      .split("/")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    let level = normaliseLevel(
      url.searchParams.get("level") ??
        url.searchParams.get("zoom") ??
        url.searchParams.get("depth"),
    );
    let parentFromPath = "";
    if (pathParts.length > 0) {
      const first = pathParts[0].replace(/s$/, "").toLowerCase();
      if ((LEVELS as readonly string[]).includes(first)) {
        level = first as Level;
        parentFromPath = pathParts.slice(1).join("-");
      } else {
        parentFromPath = pathParts.join("-");
      }
    }
    if (parentFromPath !== "") {
      url.searchParams.set("parent", parentFromPath);
    }

    const scope = resolveScope(url.searchParams, level);
    const clauses = ["library_id = ?"];
    const queryParams: (number | string)[] = [libraryId];
    if (scope.from !== null) {
      clauses.push("COALESCE(date_override, capture_date) >= ?");
      queryParams.push(scope.from);
    }
    if (scope.to !== null) {
      clauses.push("COALESCE(date_override, capture_date) <= ?");
      queryParams.push(scope.to);
    }
    const rating = ratingFilterFromQuery(url);
    clauses.push(...rating.clauses);
    queryParams.push(...rating.params);

    // Enumeration only: rows come back without their preview blobs — a sweep
    // across thousands of Assets must not drag every thumbnail out of SQLite.
    // Nothing shown in a Timeline needs the bytes; previews load per-Asset.
    const assets = db
      .prepare(
        `SELECT ${ASSET_COLUMNS_LIGHT} FROM asset WHERE ${clauses.join(" AND ")}
         ORDER BY COALESCE(date_override, capture_date) DESC, id DESC`,
      )
      .all(...queryParams) as unknown as AssetRow[];

    const paging = parsePaging(url.searchParams);

    const buckets = new Map<string, PeriodBucket>();
    for (const asset of assets) {
      const period = periodFor(level, new Date(effectiveDate(asset)));
      const bucket = buckets.get(period.key);
      if (bucket) {
        bucket.assets.push(asset);
      } else {
        buckets.set(period.key, { period, assets: [asset] });
      }
    }

    const order = url.searchParams.get("order") === "asc" ? 1 : -1;

    // A whole-day drill-down is also useful as a flat Asset list; include the
    // matching Assets at the top level for clients that render a day directly.
    // At day level a page windows that flat list, and each day then shows the
    // Assets of the day that fall in the page.
    const daySequence =
      level === "day" && paging.requested
        ? pageSlice(assets, paging)
        : assets;
    const dayWindowIds = new Set(daySequence.map((asset) => asset.id));

    const allPeriods: PeriodView[] = [];
    for (const bucket of [...buckets.values()].sort(
      (a, b) => (a.period.start - b.period.start) * order,
    )) {
      const { period, assets: inPeriod } = bucket;
      const visible =
        level === "day" && paging.requested
          ? inPeriod.filter((asset) => dayWindowIds.has(asset.id))
          : inPeriod;
      if (visible.length === 0) continue;
      const startIso = new Date(period.start).toISOString();
      const endIso = new Date(period.end).toISOString();
      const cover = publicAsset(visible[0]);
      allPeriods.push({
        level,
        key: period.key,
        period: period.key,
        label: period.label,
        start: startIso,
        end: endIso,
        startDate: startIso,
        endDate: endIso,
        from: startIso,
        to: endIso,
        count: visible.length,
        assetCount: visible.length,
        total: inPeriod.length,
        cover,
        coverAsset: cover,
        coverId: visible[0].id,
        coverAssetId: visible[0].id,
        ...(level === "day" ? { assets: visible.map(publicAsset) } : {}),
      });
    }

    // At period levels a page windows the periods themselves; at day level it
    // has already windowed the Asset list they hold.
    const responsePeriods =
      paging.requested && level !== "day"
        ? pageSlice(allPeriods, paging)
        : allPeriods;
    const primaryCount =
      level === "day" ? daySequence.length : responsePeriods.length;
    const primaryTotal = level === "day" ? assets.length : allPeriods.length;
    const morePages = paging.offset + primaryCount < primaryTotal;

    const dayAssets = level === "day" ? daySequence.map(publicAsset) : undefined;

    sendJson(ctx.res, 200, {
      level,
      total: assets.length,
      assetCount: assets.length,
      periodCount: buckets.size,
      periods: responsePeriods,
      items: responsePeriods,
      limit: paging.limit,
      offset: paging.offset,
      count: primaryCount,
      hasMore: morePages,
      nextOffset: morePages ? paging.offset + primaryCount : null,
      ...(dayAssets === undefined ? {} : { assets: dayAssets }),
    });
  };

  return {
    /** GET /api/libraries/:id/timeline — periods with counts and covers. */
    list,

    /** GET /api/timeline/:id — alias for the same Library Timeline. */
    listForLibrary(ctx: Ctx): void {
      list(ctx);
    },
  };
}

export type Timeline = ReturnType<typeof createTimeline>;
