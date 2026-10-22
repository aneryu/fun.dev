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

// A box GLB skinned to a humanoid skeleton (joint positions only; the checks read the JSON),
// with Mixamo joint names (`prefix`). The rest pose faces +Z unless `arms` points the left arm
// elsewhere; `drop` (degrees) lowers the arms from a T-pose. `rig` adds the skin's extras.rig
// (`roles` by Mixamo name: true), `vrm` VRM's humanBones instead.
export function characterGLB({ prefix = "mixamorig:", arms = 1, drop: armDrop = 0, remove = [], more = false, pose = true, rig = null, vrm = false } = {}) {
  const joints = { Hips: [0, 1, 0], Spine: [0, 1.1, 0], Spine1: [0, 1.2, 0], Spine2: [0, 1.3, 0], Neck: [0, 1.5, 0], Head: [0, 1.6, 0] };
  const c = Math.cos((armDrop * Math.PI) / 180), s = Math.sin((armDrop * Math.PI) / 180);
  for (const [side, sign] of [["Left", arms], ["Right", -arms]]) {
    const along = (d) => [sign * (0.18 + d * c), 1.45 - d * s, 0];
    Object.assign(joints, { [side + "Shoulder"]: [sign * 0.05, 1.45, 0], [side + "Arm"]: along(0), [side + "ForeArm"]: along(0.27),
      [side + "Hand"]: along(0.52), [side + "UpLeg"]: [sign * 0.1, 0.95, 0], [side + "Leg"]: [sign * 0.1, 0.5, 0], [side + "Foot"]: [sign * 0.1, 0.08, 0], [side + "ToeBase"]: [sign * 0.1, 0.02, 0.1] });
  }
  const names = Object.keys(joints).filter((name) => !remove.includes(name));
  const nodes = [{ mesh: 0, skin: 0 }, ...names.map((name) => ({ name: prefix + name, translation: joints[name] }))];
  const ROLE = { hips: "Hips", spine: "Spine", head: "Head", leftUpperArm: "LeftArm", leftLowerArm: "LeftForeArm", leftHand: "LeftHand", rightUpperArm: "RightArm",
    rightLowerArm: "RightForeArm", rightHand: "RightHand", leftUpperLeg: "LeftUpLeg", leftLowerLeg: "LeftLeg", leftFoot: "LeftFoot", rightUpperLeg: "RightUpLeg", rightLowerLeg: "RightLeg", rightFoot: "RightFoot" };
  const present = Object.entries(ROLE).filter(([, name]) => names.includes(name));
  const skin = { joints: names.map((_, index) => index + 1) };
  if (rig) skin.extras = { rig: { ...rig, roles: rig.roles === true ? Object.fromEntries(present.map(([role, name]) => [role, prefix.replace(/:$/, ":") + name])) : rig.roles } };
  const extensions = vrm ? { extensions: { VRMC_vrm: { specVersion: "1.0", humanoid: { humanBones: Object.fromEntries(present.map(([role, name]) => [role, { node: names.indexOf(name) + 1 }])) } } } } : {};
  const glb = boxGLB({ size: [0.5, 1.7, 0.3] });
  const length = new DataView(glb.buffer).getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length)));
  if (more) gltf.meshes[0].primitives[0].attributes.JOINTS_1 = 0;
  return boxGLB({ size: [0.5, 1.7, 0.3], extra: { nodes, meshes: gltf.meshes, skins: [skin], ...extensions, ...(pose ? { animations: [{ name: "pose_display", channels: [], samplers: [] }] } : {}) } });
}

// The console Worker (console.fun.dev) over one local D1 and two local R2 buckets. Requests carry
// a JWT signed by a test Access key.
export async function modelStack() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "test", alg: "RS256" };
  const bundle = await build({
    stdin: { contents: 'export { default } from "./server/console.js";', resolveDir: process.cwd() },
    bundle: true, write: false, format: "esm", platform: "browser",
  });
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-10-13",
    d1Databases: ["MODELS_DB"], r2Buckets: ["MODELS_SOURCES", "MODELS_PUBLIC"],
    serviceBindings: { ASSETS: () => new Response("console page") },
    bindings: { ACCESS_TEAM: "team.test", ACCESS_AUD: "aud", CONSOLE_EMAIL: "owner@fun.dev", ACCESS_CERTS: JSON.stringify({ keys: [jwk] }) },
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
  const consoleFetch = async (path, { method = "GET", body, jwt, headers = {} } = {}) => runtime.dispatchFetch(`https://console.test${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Cf-Access-Jwt-Assertion": jwt ?? await token(), ...(method === "GET" ? {} : { "X-Fun-Console": "1", "Content-Type": "application/json" }), ...headers },
  });
  // The console page's upload routes: PUT /api/upload/<id>/<version>[/<file>], GET for the status.
  const upload = async (path, body, { method = "PUT", type, headers = {} } = {}) => runtime.dispatchFetch(`https://console.test/api/upload/${path}`, {
    method, body, headers: { "Cf-Access-Jwt-Assertion": await token(), ...(method === "GET" ? {} : { "X-Fun-Console": "1" }), ...(type ? { "Content-Type": type } : {}), ...headers },
  });
  return { runtime, db, upload, console: consoleFetch, token, publicBucket: () => runtime.getR2Bucket("MODELS_PUBLIC"), privateBucket: () => runtime.getR2Bucket("MODELS_SOURCES") };
}
