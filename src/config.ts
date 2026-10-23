import { z } from "zod";

/** The Backup target variables that must all be supplied together, or none. */
const BACKUP_REQUIRED_KEYS = [
  "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_ACCESS_KEY_ID",
  "BACKUP_S3_SECRET_ACCESS_KEY",
] as const;

/**
 * All configuration comes from environment variables (PRD decision: nothing
 * sensitive in code). Missing or invalid required values fail fast with a
 * clear message. This schema is the single source of truth for config.
 */
const configSchema = z
  .object({
    /** Address to bind. Defaults to all interfaces so the container is reachable
     * behind Coolify's proxy; tests bind loopback. */
    HOST: z.string().min(1).default("0.0.0.0"),
    /** Port the HTTP server listens on. "0" picks an ephemeral port (tests). */
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    /** Path to the SQLite database file. Its directory must be writable. */
    DATABASE_PATH: z.string().min(1, "DATABASE_PATH is required"),
    /** Directory where original Asset files are stored, untouched. */
    ORIGINALS_DIR: z.string().min(1, "ORIGINALS_DIR is required"),
    /** Secret used to sign sessions. Must be long enough to be unguessable. */
    SESSION_SECRET: z
      .string()
      .min(16, "SESSION_SECRET must be at least 16 characters"),
    /** Mark the session cookie Secure so browsers only send it over HTTPS.
     * Defaults to true: production is served behind Coolify's HTTPS proxy
     * (ADR 0002). Set false only for a plain-HTTP local run. */
    SECURE_COOKIES: z.stringbool().default(true),
    /** How long a login session stays valid, in seconds. Default 7 days. */
    SESSION_TTL_SECONDS: z.coerce.number().int().min(0).default(604800),
    /** How long an unaccepted invitation stays valid, in seconds. Default 7 days. */
    INVITE_TTL_SECONDS: z.coerce.number().int().min(0).default(604800),
    /** How long a password-reset token stays valid, in seconds. Default 1 hour. */
    PASSWORD_RESET_TTL_SECONDS: z.coerce.number().int().min(0).default(3600),
    /** Failed logins allowed per email within the window before blocking. */
    LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(5),
    /** Sliding window for login failure counting, in seconds. Default 15 min. */
    LOGIN_WINDOW_SECONDS: z.coerce.number().int().min(1).default(900),
    /** Largest Upload accepted, in bytes. Default 50 MB — enough for a JPEG or
     * PNG from any phone or camera. */
    UPLOAD_MAX_BYTES: z.coerce.number().int().min(1).default(52_428_800),
    /** S3-compatible endpoint for off-box backups. Backup is disabled when
     * this (and the other required backup variables) are unset. */
    BACKUP_S3_ENDPOINT: z.string().url().optional(),
    /** Bucket that receives database snapshots and originals. */
    BACKUP_S3_BUCKET: z.string().min(1).optional(),
    /** S3 access key id; supplied only through the environment. */
    BACKUP_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    /** S3 secret access key; supplied only through the environment. */
    BACKUP_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** S3 region used for request signing. */
    BACKUP_S3_REGION: z.string().min(1).default("us-east-1"),
    /** Key prefix under which backups are written. */
    BACKUP_S3_PREFIX: z.string().default("familio"),
    /** Seconds between scheduled backups. 0 disables the schedule. */
    BACKUP_INTERVAL_SECONDS: z.coerce.number().int().min(0).default(86400),
  })
  .superRefine((cfg, ctx) => {
    const present = BACKUP_REQUIRED_KEYS.filter(
      (key) => cfg[key] !== undefined,
    );
    if (present.length === 0 || present.length === BACKUP_REQUIRED_KEYS.length) {
      return;
    }
    for (const key of BACKUP_REQUIRED_KEYS) {
      if (cfg[key] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `${key} is required when backup storage is configured`,
        });
      }
    }
  });

export type Config = Readonly<z.infer<typeof configSchema>>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Parse and validate configuration from the given environment (defaults to
 * process.env). Throws ConfigError with a human-readable summary of every
 * problem when a required value is missing or invalid.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const key = issue.path.join(".") || "(root)";
        return `  - ${key}: ${issue.message}`;
      })
      .join("\n");
    throw new ConfigError(
      `Invalid configuration from environment variables:\n${details}`,
    );
  }
  return Object.freeze(result.data);
}
