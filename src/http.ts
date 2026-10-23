import type { IncomingMessage, ServerResponse } from "node:http";

/** Send a JSON response with the given status. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** An error carrying the HTTP status to send and a machine-readable code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }

  /**
   * Human-readable detail for the client, when there is more to say than the
   * machine-readable code. Undefined keeps the default code-only response.
   */
  get detail(): string | undefined {
    return this.message === this.code ? undefined : this.message;
  }
}

/**
 * Read and JSON-parse a request body. Throws HttpError(400) on a body that is
 * not a JSON object, or that exceeds the size limit.
 */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes = 1_000_000,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "payload_too_large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_json");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Read a raw request body into a single Buffer, used for binary Uploads (the
 * JSON parser would corrupt image bytes). Throws HttpError(413) if the body
 * exceeds the limit.
 */
export async function readRawBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "payload_too_large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a Cookie header into a name→value map. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out.set(name, decodeURIComponent(value));
  }
  return out;
}

/**
 * Read the first non-nullish value for a set of keys from the parsed body,
 * then from the query string. Body values win so a client can override a
 * stale query parameter.
 */
export function firstValue(
  body: Record<string, unknown>,
  query: URLSearchParams,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    const value = body[key];
    if (value !== undefined && value !== null) return value;
  }
  for (const key of keys) {
    const value = query.get(key);
    if (value !== null) return value;
  }
  return undefined;
}

/** Read a required non-empty string field from a parsed body. */
export function requireString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `missing_${field}`);
  }
  return value;
}
