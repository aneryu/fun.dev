import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Fallback store through the logged-in Wrangler CLI, for publishing without S3 keys.
// Wrangler has no conditional writes: If-Match / If-None-Match are emulated by re-reading
// the object just before writing (ETag = SHA-256 of its body). Safe for a single operator,
// not for concurrent publishers; prefer the S3 store when R2 keys are configured.
const cli = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const env = { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false", WRANGLER_SEND_METRICS: "false" };
const digest = (body) => `"${createHash("sha256").update(body).digest("hex")}"`;

export function createWranglerStore(bucket = process.env.R2_BUCKET) {
  if (!bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error("Set R2_BUCKET to the R2 bucket name.");
  const directory = mkdtempSync(join(tmpdir(), "fundev-r2-"));
  function get(key) {
    try {
      const body = execFileSync(process.execPath, [cli, "r2", "object", "get", `${bucket}/${key}`, "--remote", "--pipe"], { env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024 });
      return { body, etag: digest(body) };
    } catch (error) {
      if (/does not exist|NoSuchKey|10007|not found/i.test(`${error.stderr}${error.stdout}`)) return null;
      throw new Error(`Wrangler R2 get failed for ${key}.`);
    }
  }
  return {
    async get(key) { return get(key); },
    async put(key, body, options) {
      const current = options.ifMatch || options.ifNoneMatch ? get(key) : null;
      if ((options.ifNoneMatch === "*" && current) || (options.ifMatch && current?.etag !== options.ifMatch)) {
        throw Object.assign(new Error(`Precondition failed for ${key}.`), { status: 412 });
      }
      const file = join(directory, "object");
      writeFileSync(file, body);
      execFileSync(process.execPath, [cli, "r2", "object", "put", `${bucket}/${key}`, "--remote", "--file", file,
        ...(options.type ? ["--content-type", options.type] : []), ...(options.cache ? ["--cache-control", options.cache] : [])], { env, stdio: "ignore" });
    },
    close() { rmSync(directory, { recursive: true, force: true }); },
  };
}
