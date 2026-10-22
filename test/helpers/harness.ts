import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, type App } from "../../src/app.ts";
import { loadConfig } from "../../src/config.ts";

export interface TestApp {
  /** Base URL the real server is listening on, e.g. http://127.0.0.1:54321 */
  readonly baseUrl: string;
  /** Absolute path to this app's temporary originals folder. */
  readonly originalsDir: string;
  /** Absolute path to this app's temporary SQLite database file. */
  readonly databasePath: string;
  /** Convenience fetch bound to baseUrl. Accepts a path like "/health". */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
}

/**
 * Boot the real app in-process against a fresh temporary SQLite database and
 * originals folder, listening on an ephemeral port. Every API test drives the
 * app only through its returned baseUrl. Call stop() to shut down and clean up.
 */
export async function startTestApp(
  envOverrides: Record<string, string> = {},
): Promise<TestApp> {
  const workDir = mkdtempSync(join(tmpdir(), "familio-test-"));
  const databasePath = join(workDir, "familio.db");
  const originalsDir = join(workDir, "originals");

  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "0",
    DATABASE_PATH: databasePath,
    ORIGINALS_DIR: originalsDir,
    SESSION_SECRET: "test-secret-value-at-least-sixteen-chars",
    ...envOverrides,
  });

  let app: App;
  try {
    app = await createApp(config);
  } catch (err) {
    rmSync(workDir, { recursive: true, force: true });
    throw err;
  }
  const baseUrl = await app.listen();

  return {
    baseUrl,
    originalsDir,
    databasePath,
    fetch(path, init) {
      return fetch(new URL(path, baseUrl), init);
    },
    async stop() {
      await app.close();
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}
