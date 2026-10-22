import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import type { Config } from "./config.ts";
import { openDatabase } from "./db.ts";

export interface App {
  /** Start listening on config.PORT. Returns the base URL actually bound. */
  listen(): Promise<string>;
  /** Stop the server and close the database. */
  close(): Promise<void>;
}

/**
 * Build the Familio app: open the database (running migrations), and wire up
 * the HTTP server. The HTTP API is the single seam everything is tested
 * through (PRD Testing Decisions). createApp does the work that can fail fast
 * (config already validated, database/migrations); listen() only binds a port.
 */
export async function createApp(config: Config): Promise<App> {
  const db: DatabaseSync = openDatabase(config);

  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  });

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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}
