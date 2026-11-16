// The two S3 requests the corpus upload needs, signed with AWS Signature
// Version 4 (the scheme R2's S3 API takes). No query strings, no multipart: a
// single PUT holds up to 5 GB.
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import https from "node:https";

export interface Bucket {
  /** `https://<account id>.r2.cloudflarestorage.com` */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** R2 calls its one region `auto`. */
  region?: string;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** Percent-encode a path the way S3 canonicalizes it: everything but unreserved characters and `/`. */
export const encodePath = (path: string) =>
  path
    .split("/")
    .map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()))
    .join("/");

/**
 * The headers of a signed request, `authorization` included. `headers` are the
 * ones to sign besides `host`, `x-amz-date` and `x-amz-content-sha256`.
 */
export function signedHeaders(
  method: string,
  url: URL,
  payloadHash: string,
  b: Pick<Bucket, "accessKeyId" | "secretAccessKey" | "region">,
  headers: Record<string, string> = {},
  now = new Date(),
): Record<string, string> {
  const stamp = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = stamp.slice(0, 8);
  const region = b.region ?? "auto";
  const all: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": stamp };
  for (const [k, v] of Object.entries(headers)) all[k.toLowerCase()] = v.trim();
  const names = Object.keys(all).sort();
  const canonical = [
    method,
    url.pathname,
    "",
    ...names.map((n) => `${n}:${all[n]}`),
    "",
    names.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonical)].join("\n");
  const key = ["s3", "aws4_request"].reduce((k, part) => hmac(k, part), hmac(hmac("AWS4" + b.secretAccessKey, day), region));
  const signature = hmac(key, toSign).toString("hex");
  delete all.host;
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${b.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

export const objectUrl = (b: Bucket, key: string) => new URL(`${b.endpoint.replace(/\/$/, "")}/${b.bucket}/${encodePath(key)}`);

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** PUT a file or a string. The body is streamed, so a large archive never sits in memory. */
export async function putObject(b: Bucket, key: string, body: { file: string } | string, contentType: string): Promise<void> {
  const text = typeof body === "string" ? Buffer.from(body) : null;
  const size = text ? text.length : fs.statSync((body as { file: string }).file).size;
  const hash = text ? sha256(text) : await sha256File((body as { file: string }).file);
  const url = objectUrl(b, key);
  const headers = signedHeaders("PUT", url, hash, b, { "content-type": contentType });
  await new Promise<void>((resolve, reject) => {
    const req = https.request(url, { method: "PUT", headers: { ...headers, "content-length": size } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode === 200) resolve();
        else reject(new Error(`PUT ${key}: ${res.statusCode} ${Buffer.concat(chunks).toString().slice(0, 300)}`));
      });
    });
    req.on("error", reject);
    if (text) req.end(text);
    else fs.createReadStream((body as { file: string }).file).on("error", reject).pipe(req);
  });
}
