import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { createAssets } from "./assets.ts";
import { createAuth, type Ctx } from "./auth.ts";
import type { Config } from "./config.ts";
import { openDatabase } from "./db.ts";
import { HttpError, parseCookies, readJsonBody, sendJson } from "./http.ts";
import { createLibraries } from "./libraries.ts";

export interface App {
  /** Start listening on config.PORT. Returns the base URL actually bound. */
  listen(): Promise<string>;
  /** Stop the server and close the database. */
  close(): Promise<void>;
}

type Handler = (ctx: Ctx) => void | Promise<void>;

/**
 * Build the Familio app: open the database (running migrations), and wire up
 * the HTTP server. The HTTP API is the single seam everything is tested
 * through (PRD Testing Decisions). createApp does the work that can fail fast
 * (config already validated, database/migrations); listen() only binds a port.
 */
export async function createApp(config: Config): Promise<App> {
  const db: DatabaseSync = openDatabase(config);
  const auth = createAuth(db, config);
  const libraries = createLibraries(db, auth);
  const assets = createAssets(db, auth, config);

  // method + path → handler. Body is parsed for every route uniformly; GET
  // handlers simply ignore it.
  const routes = new Map<string, Handler>([
    ["POST /api/setup", auth.setup],
    ["POST /api/invitations", auth.invite],
    ["POST /api/invitations/accept", auth.acceptInvite],
    ["POST /api/login", auth.login],
    ["POST /api/logout", auth.logout],
    ["GET /api/me", auth.me],
    ["POST /api/password-reset/request", auth.requestPasswordReset],
    ["POST /api/password-reset/confirm", auth.confirmPasswordReset],
    ["GET /api/libraries", libraries.list],
  ]);

  // Dynamic routes with a path parameter, tried when no static route matches.
  // `raw` routes receive the unparsed request body (binary Uploads); every
  // other route gets the JSON body parsed uniformly.
  const dynamicRoutes: {
    method: string;
    pattern: RegExp;
    handler: Handler;
    keys: readonly string[];
    raw?: boolean;
  }[] = [
    {
      method: "GET",
      pattern: /^\/api\/libraries\/(\d+)$/,
      handler: libraries.get,
      keys: ["id"],
    },
    {
      method: "POST",
      pattern: /^\/api\/libraries\/(\d+)\/assets$/,
      handler: assets.upload,
      keys: ["id"],
      raw: true,
    },
    {
      method: "GET",
      pattern: /^\/api\/libraries\/(\d+)\/assets$/,
      handler: assets.list,
      keys: ["id"],
    },
    {
      method: "GET",
      pattern: /^\/api\/assets\/(\d+)\/thumbnail$/,
      handler: assets.thumbnail,
      keys: ["id"],
    },
    {
      method: "GET",
      pattern: /^\/api\/assets\/(\d+)\/original$/,
      handler: assets.original,
      keys: ["id"],
    },
  ];

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code });
      } else {
        sendJson(res, 500, { error: "internal_error" });
      }
    });
  });

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0];

    if (method === "GET" && path === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    let handler = routes.get(`${method} ${path}`);
    let params: Record<string, string> = {};
    let raw = false;
    if (!handler) {
      for (const route of dynamicRoutes) {
        if (route.method !== method) continue;
        const match = route.pattern.exec(path);
        if (!match) continue;
        handler = route.handler;
        raw = route.raw ?? false;
        params = Object.fromEntries(
          route.keys.map((key, i) => [key, match[i + 1]]),
        );
        break;
      }
    }
    if (!handler) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    // GET carries no body; raw routes read it themselves (binary Upload); the
    // rest get a parsed JSON object.
    const body = method === "GET" || raw ? {} : await readJsonBody(req);
    await handler({ req, res, cookies, body, params });
  }

  return {
    listen() {
      return new Promise<string>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.PORT, config.HOST, () => {
          server.removeListener("error", reject);
          const address = server.address() as AddressInfo;
          // 0.0.0.0 is not a connectable address; report loopback for callers.
          const host = config.HOST === "0.0.0.0" ? "127.0.0.1" : config.HOST;
          resolve(`http://${host}:${address.port}`);
        });
      });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          db.close();
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
