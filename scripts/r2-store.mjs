import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

export function createR2Store(env = process.env, requestHandler) {
  const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
  if (![R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY].every(Boolean)) throw new Error("Set R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY locally.");
  const endpoint = new URL(R2_ENDPOINT);
  if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".r2.cloudflarestorage.com") || endpoint.username || endpoint.password || endpoint.port || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new Error("Expected the R2 HTTPS S3 endpoint.");
  const client = new S3Client({ region: "auto", endpoint: endpoint.origin, credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED", maxAttempts: 1, ...(requestHandler ? { requestHandler } : {}) });
  async function send(command) {
    try { return await client.send(command); }
    catch (error) { const failure = new Error(`R2 request failed (${error.$metadata?.httpStatusCode || "network"}).`); failure.status = error.$metadata?.httpStatusCode; throw failure; }
  }
  return {
    async get(key) {
      try {
        const object = await send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
        return { body: Buffer.from(await object.Body.transformToByteArray()), etag: object.ETag };
      } catch (error) { if (error.status === 404) return null; throw error; }
    },
    async put(key, body, options) {
      await send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: body, ContentType: options.type, CacheControl: options.cache, IfMatch: options.ifMatch, IfNoneMatch: options.ifNoneMatch }));
    },
    close() { client.destroy(); },
  };
}
