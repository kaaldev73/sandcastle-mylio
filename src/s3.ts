import { createHash, createHmac } from "node:crypto";

/**
 * A deliberately small S3-compatible client: enough to PUT backup objects and
 * GET them back during a restore, using AWS Signature Version 4 over fetch.
 * Keeping it in-repo avoids a cloud SDK dependency for the few operations the
 * backup job needs (PRD: stdlib-first where practical).
 */
export interface S3Config {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface S3Client {
  putObject(key: string, body: Buffer, contentType?: string): Promise<void>;
  getObject(key: string): Promise<Buffer>;
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

/** RFC 3986 URI encoding as required by SigV4 (unreserved marks left alone). */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function createS3Client(config: S3Config): S3Client {
  const base = new URL(config.endpoint);
  const basePath = base.pathname.replace(/\/+$/, "");

  /** Build the canonical path (also the request path) for an object key. */
  function pathFor(key: string): string {
    const segments = [config.bucket, ...key.split("/")].map(uriEncode);
    return `${basePath}/${segments.join("/")}`;
  }

  /** Sign a request and return the headers to send, including Authorization. */
  function signedHeaders(
    method: string,
    canonicalUri: string,
    payloadHash: string,
  ): Record<string, string> {
    const now = new Date();
    const stamp = amzDate(now);
    const dateStamp = stamp.slice(0, 8);
    const headers: Record<string, string> = {
      host: base.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": stamp,
    };
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names
      .map((name) => `${name}:${headers[name]}\n`)
      .join("");
    const signed = names.join(";");
    const canonicalRequest = [
      method,
      canonicalUri,
      "",
      canonicalHeaders,
      signed,
      payloadHash,
    ].join("\n");
    const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      stamp,
      scope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const signingKey = hmac(
      hmac(
        hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region),
        "s3",
      ),
      "aws4_request",
    );
    const signature = createHmac("sha256", signingKey)
      .update(stringToSign)
      .digest("hex");
    return {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signed}, Signature=${signature}`,
    };
  }

  async function fail(method: string, key: string, res: Response): Promise<never> {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `S3 ${method} ${key} failed with ${res.status}${
        detail ? `: ${detail.slice(0, 500)}` : ""
      }`,
    );
  }

  return {
    async putObject(key, body, contentType): Promise<void> {
      const canonicalUri = pathFor(key);
      const headers = signedHeaders("PUT", canonicalUri, sha256Hex(body));
      if (contentType) headers["content-type"] = contentType;
      const res = await fetch(`${base.origin}${canonicalUri}`, {
        method: "PUT",
        headers,
        body,
      });
      if (!res.ok) await fail("PUT", key, res);
    },

    async getObject(key): Promise<Buffer> {
      const canonicalUri = pathFor(key);
      const headers = signedHeaders("GET", canonicalUri, EMPTY_SHA256);
      const res = await fetch(`${base.origin}${canonicalUri}`, {
        method: "GET",
        headers,
      });
      if (!res.ok) await fail("GET", key, res);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
