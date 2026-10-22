import { createApp } from "./app.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";

/** Container entry point: load config from env, boot the app, start serving. */
async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const app = await createApp(config);
  const baseUrl = await app.listen();
  console.log(`Familio listening on ${baseUrl}`);

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down`);
    app.close().then(
      () => process.exit(0),
      (err) => {
        console.error(err);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
