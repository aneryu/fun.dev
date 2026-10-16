import { readFile, readdir } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// A box GLB: `size` metres wide/high/deep, standing on y = 0 unless `lift` moves it.
export function boxGLB({ size = [1, 1, 1], lift = 0, extra = {} } = {}) {
  const [x, y, z] = size.map((value) => value / 2);
  const positions = new Float32Array([-x, 0, -z, x, 0, -z, x, 0, z, -x, 0, z, -x, 2 * y, -z, x, 2 * y, -z, x, 2 * y, z, -x, 2 * y, z].map((value, index) => index % 3 === 1 ? value + lift : value));
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]);
  const binary = new Uint8Array(positions.byteLength + indices.byteLength);
  binary.set(new Uint8Array(positions.buffer), 0);
  binary.set(new Uint8Array(indices.buffer), positions.byteLength);
  const gltf = {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [-x, lift, -z], max: [x, 2 * y + lift, z] },
      { bufferView: 1, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }, { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength }],
    buffers: [{ byteLength: binary.byteLength }],
    ...extra,
  };
  let text = JSON.stringify(gltf);
  while (text.length % 4) text += " ";
  const jsonBytes = new TextEncoder().encode(text);
  const total = 12 + 8 + jsonBytes.length + 8 + binary.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true); view.setUint32(16, 0x4e4f534a, true); out.set(jsonBytes, 20);
  view.setUint32(20 + jsonBytes.length, binary.length, true); view.setUint32(24 + jsonBytes.length, 0x004e4942, true); out.set(binary, 28 + jsonBytes.length);
  return out;
}

// The upload API (as on api.fun.dev) and the console Worker (console.fun.dev) over one local D1
// and two local R2 buckets. Console requests carry a JWT signed by a test Access key.
export async function modelStack() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "test", alg: "RS256" };
  const bundle = await build({
    stdin: { contents: 'import console from "./server/console.js"; import { handleModelUpload } from "./server/models.js"; export default { fetch(r, e) { return new URL(r.url).hostname === "api.test" ? handleModelUpload(r, e) : console.fetch(r, e); } };', resolveDir: process.cwd() },
    bundle: true, write: false, format: "esm", platform: "browser",
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-13",
    d1Databases: ["MODELS_DB"], r2Buckets: ["MODELS_SOURCES", "MODELS_PUBLIC"],
    serviceBindings: { ASSETS: () => new Response("console page") },
    bindings: { MODELS_TOKEN: "secret-token", ACCESS_TEAM: "team.test", ACCESS_AUD: "aud", CONSOLE_EMAIL: "owner@fun.dev", ACCESS_CERTS: JSON.stringify({ keys: [jwk] }) },
  }));
  const db = await runtime.getD1Database("MODELS_DB");
  for (const name of (await readdir(new URL("../../migrations-models/", import.meta.url))).filter((file) => file.endsWith(".sql")).sort()) {
    const schema = (await readFile(new URL(`../../migrations-models/${name}`, import.meta.url), "utf8")).replace(/^--.*$/gm, "");
    for (const statement of schema.split(";").map((part) => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  const b64 = (data) => Buffer.from(data).toString("base64url");
  async function token(claims = {}) {
    const head = b64(JSON.stringify({ alg: "RS256", kid: "test" }));
    const body = b64(JSON.stringify({ aud: ["aud"], iss: "https://team.test", email: "owner@fun.dev", exp: Math.floor(Date.now() / 1000) + 600, ...claims }));
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64(signature)}`;
  }
  const upload = (path, body, { method = "PUT", type, auth = "Bearer secret-token" } = {}) => runtime.dispatchFetch(`https://api.test/api/models/${path}`, {
    method, body, headers: { ...(auth ? { Authorization: auth } : {}), ...(type ? { "Content-Type": type } : {}) },
  });
  const consoleFetch = async (path, { method = "GET", body, jwt, headers = {} } = {}) => runtime.dispatchFetch(`https://console.test${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Cf-Access-Jwt-Assertion": jwt ?? await token(), ...(method === "GET" ? {} : { "X-Fun-Console": "1", "Content-Type": "application/json" }), ...headers },
  });
  return { runtime, db, upload, console: consoleFetch, token, publicBucket: () => runtime.getR2Bucket("MODELS_PUBLIC") };
}
