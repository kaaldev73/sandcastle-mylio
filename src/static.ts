import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Folder holding the web UI: plain HTML and ES modules, no build step. */
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

/** The app only loads its own scripts and styles; nothing from other origins. */
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

async function send(
  res: ServerResponse,
  file: string,
  head: boolean,
): Promise<boolean> {
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    return false;
  }
  res.writeHead(200, {
    "content-type":
      CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": data.length,
    // Revalidate so a redeploy is picked up without a hard refresh.
    "cache-control": "no-cache",
    ...SECURITY_HEADERS,
  });
  res.end(head ? undefined : data);
  return true;
}

/**
 * Serve the web UI for a GET/HEAD request to a non-API path: a static asset if
 * it exists, the app shell (index.html) for any other extensionless path so
 * client-side routes survive a reload, and a plain 404 for a missing asset.
 * Needs no authentication — the shell holds no data; the API enforces access.
 */
export async function serveWeb(
  res: ServerResponse,
  path: string,
  head: boolean,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = "/";
  }
  const relative = normalize(decoded).replace(/^([/\\])+/, "");
  const file = join(WEB_DIR, relative);
  const inside = file === WEB_DIR || file.startsWith(WEB_DIR + sep);

  if (inside && relative !== "" && extname(relative) !== "") {
    if (await send(res, file, head)) return;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(head ? undefined : "Not found");
    return;
  }
  if (!(await send(res, join(WEB_DIR, "index.html"), head))) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Web UI missing");
  }
}
