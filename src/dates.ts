import { HttpError } from "./http.ts";

/** A half-open or inclusive date scope used by Timeline and date filters. */
export interface DateRange {
  from: number | null;
  to: number | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function startOfUtcDay(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day);
}

function endOfUtcDay(year: number, month: number, day: number): number {
  return startOfUtcDay(year, month, day + 1) - 1;
}

function startOfUtcMonth(year: number, month: number): number {
  return Date.UTC(year, month - 1, 1);
}

function endOfUtcMonth(year: number, month: number): number {
  return Date.UTC(year, month, 1) - 1;
}

function startOfUtcYear(year: number): number {
  return Date.UTC(year, 0, 1);
}

function endOfUtcYear(year: number): number {
  return Date.UTC(year + 1, 0, 1) - 1;
}

/** Normalise a decade's start year, accepting "2020", "2020s" or "2020-01-01". */
export function parseDecade(value: string): number | null {
  const m = /^(\d{4})s?$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  return Date.UTC(Math.floor(year / 10) * 10, 0, 1);
}

/**
 * Parse a date query/body value into epoch milliseconds. Accepts epoch
 * milliseconds, epoch seconds, ISO timestamps, and the partial forms a
 * Timeline uses: "2020", "2020-05", "2020-05-06" and "2020s". Partial values
 * denote a whole year/month/day, with `edge` deciding whether the start or end
 * of that span is wanted — so a date-only `to` includes the whole day.
 */
export function parseDateMs(
  value: unknown,
  edge: "start" | "end" = "start",
): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;

  const decade = /^(\d{4})s$/.exec(text);
  if (decade) {
    const start = parseDecade(text)!;
    return edge === "start" ? start : Date.UTC(Number(decade[1]) + 1, 0, 1) - 1;
  }

  const year = /^(\d{4})$/.exec(text);
  if (year) {
    const y = Number(year[1]);
    return edge === "start" ? startOfUtcYear(y) : endOfUtcYear(y);
  }

  const month = /^(\d{4})-(\d{2})$/.exec(text);
  if (month) {
    const y = Number(month[1]);
    const m = Number(month[2]);
    if (m < 1 || m > 12) return null;
    return edge === "start" ? startOfUtcMonth(y, m) : endOfUtcMonth(y, m);
  }

  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    const y = Number(day[1]);
    const m = Number(day[2]);
    const d = Number(day[3]);
    const start = startOfUtcDay(y, m, d);
    const check = new Date(start);
    if (
      check.getUTCFullYear() !== y ||
      check.getUTCMonth() !== m - 1 ||
      check.getUTCDate() !== d
    ) {
      return null;
    }
    return edge === "start" ? start : start + MS_PER_DAY - 1;
  }

  // Bare numbers are epoch seconds or milliseconds; four-digit values are
  // handled above as years, so this does not swallow "2020".
  if (/^-?\d+$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) return null;
    return Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Parse an ISO date, rejecting anything that is not a real date. */
export function requireDate(
  value: unknown,
  errorCode = "invalid_date",
): number {
  const ms = parseDateMs(value);
  if (ms === null) throw new HttpError(400, errorCode);
  return ms;
}

/**
 * Read an optional from/to (or start/end, after/before) range from a query
 * string. Partial dates are expanded to whole days/years so a range such as
 * from=2020-01-01&to=2020-12-31 includes the last day.
 */
export function dateRangeFromQuery(url: URL): DateRange {
  const valueFor = (names: string[]): string | undefined => {
    for (const name of names) {
      const value = url.searchParams.get(name);
      if (value !== null && value.trim() !== "") return value;
    }
    return undefined;
  };

  const fromRaw = valueFor(["from", "start", "after"]);
  const toRaw = valueFor(["to", "end", "before"]);

  const from = fromRaw === undefined ? null : parseDateMs(fromRaw, "start");
  const to = toRaw === undefined ? null : parseDateMs(toRaw, "end");

  if (fromRaw !== undefined && from === null) {
    throw new HttpError(400, "invalid_from");
  }
  if (toRaw !== undefined && to === null) {
    throw new HttpError(400, "invalid_to");
  }
  if (from !== null && to !== null && from > to) {
    throw new HttpError(400, "invalid_date_range");
  }
  return { from, to };
}

/** Intersect two ranges; null bounds are unbounded. */
export function intersectRanges(a: DateRange, b: DateRange): DateRange {
  const maxOf = (x: number | null, y: number | null): number | null =>
    x === null ? y : y === null ? x : Math.max(x, y);
  const minOf = (x: number | null, y: number | null): number | null =>
    x === null ? y : y === null ? x : Math.min(x, y);
  const from = maxOf(a.from, b.from);
  const to = minOf(a.to, b.to);
  if (from !== null && to !== null && from > to) {
    return { from: -1, to: -2 };
  }
  return { from, to };
}

/** Whole-year bounds for a calendar year, as an inclusive range. */
export function yearRange(year: number): DateRange {
  return { from: startOfUtcYear(year), to: endOfUtcYear(year) };
}

/** Whole-month bounds for a calendar month, as an inclusive range. */
export function monthRange(year: number, month: number): DateRange {
  return { from: startOfUtcMonth(year, month), to: endOfUtcMonth(year, month) };
}

/** Whole-day bounds for a calendar day, as an inclusive range. */
export function dayRange(year: number, month: number, day: number): DateRange {
  return {
    from: startOfUtcDay(year, month, day),
    to: endOfUtcDay(year, month, day),
  };
}

/** Whole-decade bounds, keyed by its starting year (e.g. 2020 → 2020s). */
export function decadeRange(startYear: number): DateRange {
  return {
    from: Date.UTC(startYear, 0, 1),
    to: Date.UTC(startYear + 10, 0, 1) - 1,
  };
}
