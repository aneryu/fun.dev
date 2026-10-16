import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { glbStats, readGLB } from "../server/glb.js";
import { boxGLB, modelStack } from "./helpers/models.mjs";

const stack = await modelStack();
after(() => stack.runtime.dispose());
const metadata = (name = "书椅", extra = {}) => JSON.stringify({ name: { zh: name, en: "Desk chair" }, type: "prop", kit: "reading_room", tags: ["chair"], ...extra });
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("GLB stats: size, bounds and triangles from accessor bounds and node transforms", () => {
  assert.deepEqual(glbStats(readGLB(boxGLB({ size: [0.48, 0.85, 0.5] }))), { size: [0.48, 0.85, 0.5], min: [-0.24, 0, -0.25], max: [0.24, 0.85, 0.25], triangles: 12 });
  const moved = glbStats(readGLB(boxGLB({ extra: { nodes: [{ children: [1], translation: [1, 0, 0] }, { mesh: 0, scale: [2, 1, 1] }] } })));
  assert.deepEqual(moved.min, [0, 0, -0.5]);
  assert.deepEqual(moved.size, [2, 1, 1]);
  assert.throws(() => readGLB(new TextEncoder().encode("not a glb at all, really")), /not a GLB/);
  assert.throws(() => readGLB(boxGLB({ extra: { buffers: [{ byteLength: 120, uri: "box.bin" }] } })), /embedded/);
  assert.throws(() => readGLB(boxGLB({ extra: { extensionsRequired: ["EXT_meshopt_compression"] } })), /unsupported/);
});

test("uploads need the token and valid addresses", async () => {
  assert.equal((await stack.upload("desk_chair_01/v001", metadata(), { type: "application/json", auth: null })).status, 401);
  assert.equal((await stack.upload("desk_chair_01/v001", metadata(), { type: "application/json", auth: "Bearer wrong" })).status, 401);
  assert.equal((await (await stack.upload("Desk-Chair/v001", metadata(), { type: "application/json" })).json()).error, "invalid_id");
  assert.equal((await (await stack.upload("desk_chair_01/1", metadata(), { type: "application/json" })).json()).error, "invalid_version");
  assert.equal((await stack.upload("desk_chair_01/v001/../x", png)).status, 400, "dot segments resolve to another, invalid address");
  assert.equal((await (await stack.upload("desk_chair_01/v001/Model.GLB", png)).json()).error, "invalid_file_name");
  assert.equal((await (await stack.upload("desk_chair_01/v001", JSON.stringify({ name: "chair" }), { type: "application/json" })).json()).error, "invalid_metadata");
  assert.equal((await (await stack.upload("desk_chair_01/v001/model.glb", png)).json()).error, "invalid_glb");
  const noType = await (await stack.upload("desk_chair_01/v001", metadata("书椅", { type: undefined }), { type: "application/json" })).json();
  assert.deepEqual([noType.error, noType.detail], ["invalid_metadata", "type must be one of prop, piece"]);
  const planned = await (await stack.upload("desk_chair_01/v001", metadata("书椅", { type: "character" }), { type: "application/json" })).json();
  assert.equal(planned.detail, "type character is planned but not accepted yet");
  assert.equal((await stack.upload("desk_chair_01/v001", undefined, { method: "GET" })).status, 404);
});

test("a version is pending with metadata, model.glb and preview.png; review approves and publishes it", async () => {
  const glb = boxGLB({ size: [0.48, 0.85, 0.5] });
  let status = await (await stack.upload("desk_chair_01/v001/model.glb", glb)).json();
  assert.equal(status.status, "incomplete");
  assert.deepEqual(status.stats.size, [0.48, 0.85, 0.5]);
  assert.equal(status.stats.triangles, 12);
  assert.equal((await (await stack.upload("desk_chair_01/v001", metadata(), { type: "application/json" })).json()).status, "incomplete");
  await stack.upload("desk_chair_01/v001/qa.json", "{}");
  await stack.upload("desk_chair_01/v001/source.blend", new Uint8Array([1, 2, 3]));
  status = await (await stack.upload("desk_chair_01/v001/preview.png", png)).json();
  assert.equal(status.status, "pending");
  assert.deepEqual(Object.keys(status.files).sort(), ["model.glb", "preview.png", "qa.json", "source.blend"]);
  assert.deepEqual(status.files["model.glb"], { sha256: sha(glb), size: glb.length });

  const pending = await (await stack.console("/api/versions")).json();
  assert.deepEqual(pending.versions.map((item) => [item.id, item.version, item.name.zh]), [["desk_chair_01", "v001", "书椅"]]);
  const preview = await stack.console("/files/desk_chair_01/v001/preview.png");
  assert.equal(preview.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await preview.arrayBuffer()), png);

  const edited = await (await stack.console("/api/models/desk_chair_01", { method: "PATCH", body: { name: { zh: "书桌椅", en: "Desk chair" }, tags: ["chair", "indoor"] } })).json();
  assert.equal(edited.name.zh, "书桌椅");
  assert.equal((await stack.console("/api/models/desk_chair_01/v001/approve", { method: "POST", body: {} })).status, 200);

  const bucket = await stack.publicBucket();
  const blob = await bucket.get(`blobs/${sha(glb)}.glb`);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), glb);
  assert.equal(blob.httpMetadata.cacheControl, "public, max-age=31536000, immutable");
  assert.ok(await bucket.head(`blobs/${sha(new Uint8Array([1, 2, 3]))}.blend`), ".blend is published");
  assert.equal(await bucket.head(`blobs/${sha(new TextEncoder().encode("{}"))}.json`), null, "qa.json stays private");
  const catalog = JSON.parse(await (await bucket.get("models.json")).text());
  assert.equal(catalog.licence, "CC0-1.0");
  assert.deepEqual(catalog.models.map((model) => [model.id, model.name.zh, model.type, model.kit, model.tags]), [["desk_chair_01", "书桌椅", "prop", "reading_room", ["chair", "indoor"]]]);
  assert.deepEqual(Object.keys(catalog.models[0].versions[0].files).sort(), ["model.glb", "preview.png", "source.blend"]);

  // Approved versions are immutable; a new version goes through review again.
  assert.equal((await stack.upload("desk_chair_01/v001/model.glb", glb)).status, 409);
  assert.equal((await stack.upload("desk_chair_01/v001", metadata(), { type: "application/json" })).status, 409);
  assert.equal((await stack.console("/api/models/desk_chair_01/v001/approve", { method: "POST", body: {} })).status, 409);
  // The type is fixed once a version is approved, for the pipeline and the reviewer alike.
  assert.equal((await (await stack.upload("desk_chair_01/v002", metadata("书椅", { type: "piece" }), { type: "application/json" })).json()).error, "type_locked");
  assert.equal((await (await stack.console("/api/models/desk_chair_01", { method: "PATCH", body: { type: "piece" } })).json()).error, "type_locked");
  // Unlisting removes the model from the catalog; its blobs stay.
  await stack.console("/api/models/desk_chair_01", { method: "PATCH", body: { listed: false } });
  assert.deepEqual(JSON.parse(await (await bucket.get("models.json")).text()).models, []);
  assert.ok(await bucket.head(`blobs/${sha(glb)}.glb`));
  await stack.console("/api/models/desk_chair_01", { method: "PATCH", body: { listed: true } });
});

test("a rejected version carries the note and returns to pending when fixed", async () => {
  await stack.upload("sofa_corner_01/v001", metadata("转角沙发"), { type: "application/json" });
  await stack.upload("sofa_corner_01/v001/model.glb", boxGLB({ lift: 0.02 }));
  await stack.upload("sofa_corner_01/v001/preview.png", png);
  assert.equal((await stack.console("/api/models/sofa_corner_01/v001/reject", { method: "POST", body: { note: "Floats 2 cm above the floor." } })).status, 200);
  let status = await (await stack.upload("sofa_corner_01/v001", undefined, { method: "GET" })).json();
  assert.deepEqual([status.status, status.note], ["rejected", "Floats 2 cm above the floor."]);
  assert.equal(status.stats.min[1], 0.02);
  status = await (await stack.upload("sofa_corner_01/v001/model.glb", boxGLB())).json();
  assert.equal(status.status, "pending");
});

test("the console accepts only a valid Access token for the owner, and same-origin changes", async () => {
  assert.equal((await stack.console("/", { jwt: "" })).status, 403);
  assert.equal((await stack.console("/", { jwt: await stack.token({ email: "someone@else.dev" }) })).status, 403);
  assert.equal((await stack.console("/", { jwt: await stack.token({ aud: ["other"] }) })).status, 403);
  assert.equal((await stack.console("/", { jwt: await stack.token({ exp: 1 }) })).status, 403);
  const forged = (await stack.token()).split(".");
  forged[1] = Buffer.from(JSON.stringify({ aud: ["aud"], iss: "https://team.test", email: "owner@fun.dev", exp: 9e9, admin: true })).toString("base64url");
  assert.equal((await stack.console("/", { jwt: forged.join(".") })).status, 403);
  assert.equal(await (await stack.console("/")).text(), "console page");
  assert.equal((await stack.console("/api/models/desk_chair_01", { method: "PATCH", body: { listed: true }, headers: { "X-Fun-Console": "" } })).status, 403);
  assert.equal((await stack.console("/api/models/desk_chair_01", { method: "PATCH", body: { listed: true }, headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
});
