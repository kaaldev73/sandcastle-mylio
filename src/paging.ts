import { HttpError } from "./http.ts";

/**
 * Result of parsing a request's paging query. `limit` is null when the
 * request did not ask for a page (callers then return everything, as before
 * paging existed); `offset` is the number of rows or periods to skip;
 * `requested` says whether the client asked for paging at all, so callers
 * return paging metadata only on paginated requests.
 */
export interface Paging {
  readonly limit: number | null;
  readonly offset: number;
  readonly requested: boolean;
}

const LIMIT_KEYS = [
  "limit",
  "perPage",
  "per_page",
  "pageSize",
  "page_size",
  "count",
  "size",
  "take",
] as const;

const OFFSET_KEYS = ["offset", "skip"] as const;
const PAGE_KEYS = ["page"] as const;

function queryFirst(
  params: URLSearchParams,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = params.get(key);
    if (value !== null && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function integer(value: string, code: string, minimum: number): number {
  const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new HttpError(400, code);
  }
  return parsed;
}

/**
 * Parse the paging query of a list endpoint: a page size (`limit` and the
 * common per-page aliases) plus where to start (`offset`/`skip`, or a 1-based
 * `page`, which needs a limit to be meaningful). A present-but-invalid value
 * is a 400 so a client never silently sees a different page than it asked
 * for. Defaults to unpaged. An explicit `offset=0` is valid and paged.
 */
export function parsePaging(params: URLSearchParams): Paging {
  const limitRaw = queryFirst(params, LIMIT_KEYS);
  const offsetRaw = queryFirst(params, OFFSET_KEYS);
  const pageRaw = queryFirst(params, PAGE_KEYS);

  if (
    limitRaw === undefined &&
    offsetRaw === undefined &&
    pageRaw === undefined
  ) {
    return { limit: null, offset: 0, requested: false };
  }

  const limit =
    limitRaw === undefined ? null : integer(limitRaw, "invalid_limit", 1);
  let offset = 0;
  if (offsetRaw !== undefined) {
    offset = integer(offsetRaw, "invalid_offset", 0);
  } else if (pageRaw !== undefined) {
    const page = integer(pageRaw, "invalid_page", 1);
    if (limit === null) {
      throw new HttpError(
        400,
        "invalid_page",
        "A page number needs a limit to paginate by.",
      );
    }
    offset = (page - 1) * limit;
  }
  return { limit, offset, requested: true };
}
