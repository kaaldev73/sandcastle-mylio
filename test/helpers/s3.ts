import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeS3 {
  /** Base URL to point BACKUP_S3_ENDPOINT at. */
  readonly endpoint: string;
  /** Objects keyed by bucket-relative key, exactly as the app PUT them. */
  readonly objects: Map<string, Buffer>;
  /** When true, every PUT fails so the failure path can be exercised. */
  failPut: boolean;
  stop(): Promise<void>;
}

/**
 * A tiny in-memory S3-compatible endpoint for backup tests. It accepts path
 * style PUT/GET requests and ignores signatures: the app's real SigV4 client
 * is exercised, but the bytes never leave the test process.
 */
export async function startFakeS3(bucket = "test-bucket"): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const state = { failPut: false };

  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://fake").pathname;
    const key = decodeURIComponent(path).replace(new RegExp(`^/${bucket}/`), "");

    if (req.method === "PUT") {
      if (state.failPut) {
        req.resume();
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("injected failure");
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200, { etag: '"test"' });
        res.end();
      });
      return;
    }

    if (req.method === "GET") {
      const body = objects.get(key);
      if (!body) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-length": body.length });
      res.end(body);
      return;
    }

    res.writeHead(405);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
    get failPut() {
      return state.failPut;
    },
    set failPut(value: boolean) {
      state.failPut = value;
    },
    stop() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
