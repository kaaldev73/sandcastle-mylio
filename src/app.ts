import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { createAuth, type Ctx } from "./auth.ts";
import type { Config } from "./config.ts";
import { openDatabase } from "./db.ts";
import { HttpError, parseCookies, readJsonBody, sendJson } from "./http.ts";

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
  ]);

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

    const handler = routes.get(`${method} ${path}`);
    if (!handler) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    const body = method === "GET" ? {} : await readJsonBody(req);
    await handler({ req, res, cookies, body });
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
