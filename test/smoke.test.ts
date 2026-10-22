import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Container smoke test (PRD Testing Decisions): boot the real entrypoint the
 * image runs — `src/main.ts`, the target of `npm run start` / the Dockerfile
 * CMD — against a temporary directory standing in for the mounted /data
 * volume, and drive it only over HTTP. It proves the container serves
 * requests, that data on the volume survives a restart/redeploy, and that
 * migrations re-apply on the second boot without losing data. Docker itself is
 * not exercised here; the deployment files are not unit tested (parent spec).
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const mainEntry = join(repoRoot, "src", "main.ts");

const SESSION_SECRET = "smoke-secret-value-at-least-sixteen-chars";
const ADMIN_EMAIL = "admin@example.com";
const PASSWORD = "correct-horse-battery";

interface RunningApp {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

/** Spawn `node --import tsx src/main.ts` with a volume dir and wait until it
 * announces the URL it is listening on, exactly as the container start does. */
function startContainer(volumeDir: string): Promise<RunningApp> {
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", mainEntry],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: "0",
        DATABASE_PATH: join(volumeDir, "familio.db"),
        ORIGINALS_DIR: join(volumeDir, "originals"),
        SESSION_SECRET,
      },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  return new Promise<RunningApp>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("container did not start within 15s"));
    }, 15_000);

    let out = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      out += chunk;
      const match = out.match(/listening on (http:\/\/\S+)/);
      if (!match) return;
      clearTimeout(timer);
      const baseUrl = match[1];
      resolve({
        baseUrl,
        stop() {
          return new Promise<void>((done) => {
            child.once("exit", () => done());
            child.kill("SIGTERM");
          });
        },
      });
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`container exited early with code ${code}`));
    });
  });
}

function post(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

test("the container serves requests and keeps volume data across a restart", async () => {
  const volumeDir = mkdtempSync(join(tmpdir(), "familio-smoke-"));
  try {
    // First boot: the image comes up and serves on the volume.
    const first = await startContainer(volumeDir);
    assert.equal((await fetch(new URL("/health", first.baseUrl))).status, 200);

    // Write data onto the volume: bootstrap the first Admin.
    const setup = await post(first.baseUrl, "/api/setup", {
      email: ADMIN_EMAIL,
      password: PASSWORD,
    });
    assert.equal(setup.status, 201);
    await first.stop();

    // Redeploy: a fresh process against the same volume must re-run migrations
    // cleanly and still hold the Admin — i.e. data survived and upgrades keep
    // it. A login that succeeds proves the member row persisted.
    const second = await startContainer(volumeDir);
    assert.equal((await fetch(new URL("/health", second.baseUrl))).status, 200);
    const login = await post(second.baseUrl, "/api/login", {
      email: ADMIN_EMAIL,
      password: PASSWORD,
    });
    assert.equal(login.status, 200);

    // The one-time bootstrap stays closed, further confirming the same data.
    const reSetup = await post(second.baseUrl, "/api/setup", {
      email: "other@example.com",
      password: PASSWORD,
    });
    assert.equal(reSetup.status, 409);
    await second.stop();
  } finally {
    rmSync(volumeDir, { recursive: true, force: true });
  }
});
