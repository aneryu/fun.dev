import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { glbSkeleton, glbStats, readGLB } from "../server/glb.js";
import { characterProblems, characterWarnings, cleanTags, inspectVersion, textWarnings } from "../server/model-rules.js";
import { boxGLB, characterGLB, modelStack } from "./helpers/models.mjs";
import { applyPlan, convertVersions, warningsOf } from "../scripts/models-admin.mjs";
import { publish, putDerived, retypeModel } from "../server/models.js";

const stack = await modelStack();
after(() => stack.runtime.dispose());
const metadata = (name = "书椅", extra = {}) => JSON.stringify({ name: { zh: name, en: "Desk chair" }, type: "prop", description: { zh: "木腿绿垫的书桌椅，适合书房。", en: "A wooden desk chair with a green seat; fits a study." }, kit: "reading_room", tags: ["chair"], ...extra });
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

test("characters: the Mixamo skeleton in a T-pose facing +z, four influences, a display pose", () => {
  const skeleton = glbSkeleton(readGLB(characterGLB()));
  assert.equal(skeleton.count, 22);
  assert.deepEqual(skeleton.joints.LeftHand, [0.7, 1.45, 0]);
  assert.deepEqual(skeleton.animations, ["pose_display"]);
  assert.deepEqual(characterProblems(readGLB(characterGLB())), []);
  assert.deepEqual(characterProblems(readGLB(characterGLB({ prefix: "mixamorig" }))), [], "three.js-style names without the colon");
  assert.equal(glbSkeleton(readGLB(boxGLB())), null);
  assert.match(characterProblems(readGLB(boxGLB()))[0], /skinned mesh/);
  assert.match(characterProblems(readGLB(characterGLB({ prefix: "" }))).join(), /Mixamo names/);
  assert.match(characterProblems(readGLB(characterGLB({ drop: ["LeftToeBase"] }))).join(), /lacks LeftToeBase/);
  assert.match(characterProblems(readGLB(characterGLB({ more: true }))).join(), /4 joint influences/);
  assert.match(characterProblems(readGLB(characterGLB({ arms: -1 }))).join(), /T-pose facing \+z/, "facing -z puts the left hand at -x");
  assert.deepEqual(characterWarnings(readGLB(characterGLB({ pose: false }))), ["no pose_display animation: pages show the T-pose"]);
  const meta = JSON.stringify({ name: { zh: "通勤男子", en: "Commuter" }, type: "character", description: { zh: "穿蓝衬衫的上班族。", en: "An office worker in a blue shirt." } });
  assert.deepEqual(inspectVersion({ id: "commuter_01", version: "v001", meta, files: [{ name: "model.glb", bytes: characterGLB() }] }).problems, []);
  assert.match(inspectVersion({ id: "commuter_01", version: "v001", meta, files: [{ name: "model.glb", bytes: boxGLB() }] }).problems.join(), /skinned mesh/);
});

test("tags that say nothing are dropped, and production jargon in names and descriptions is flagged", () => {
  assert.deepEqual(cleanTags(["chair", "low-poly", "static", "prop", "reading_room", "chair", "indoor"], { type: "prop", kit: "reading_room" }), ["chair", "indoor"]);
  assert.equal(textWarnings({ name: { zh: "无品牌低多边形城市轿车", en: "City sedan" }, description: { zh: "小轿车。", en: "A sedan." } }).length, 1);
  assert.equal(textWarnings({ name: { zh: "熨衣板", en: "Ironing board" }, description: { zh: "展开的熨衣板。", en: "Static visual model without animation." } }).length, 1);
  assert.deepEqual(textWarnings({ name: { zh: "书椅", en: "Desk chair" }, description: { zh: "木腿书椅，适合书房。", en: "A wooden desk chair for a study." } }), []);
});

test("uploads need valid addresses, metadata and GLBs", async () => {
  assert.equal((await (await stack.upload("Desk-Chair/v001", metadata(), { type: "application/json" })).json()).error, "invalid_id");
  assert.equal((await (await stack.upload("desk_chair_01/1", metadata(), { type: "application/json" })).json()).error, "invalid_version");
  assert.equal((await stack.upload("desk_chair_01/v001/../x", png)).status, 400, "dot segments resolve to another, invalid address");
  assert.equal((await (await stack.upload("desk_chair_01/v001/Model.GLB", png)).json()).error, "invalid_file_name");
  assert.equal((await (await stack.upload("desk_chair_01/v001", JSON.stringify({ name: "chair" }), { type: "application/json" })).json()).error, "invalid_metadata");
  assert.equal((await (await stack.upload("desk_chair_01/v001/model.glb", png)).json()).error, "invalid_glb");
  const noDescription = await (await stack.upload("desk_chair_01/v001", metadata("书椅", { description: undefined }), { type: "application/json" })).json();
  assert.equal(noDescription.error, "invalid_metadata");
  const noType = await (await stack.upload("desk_chair_01/v001", metadata("书椅", { type: undefined }), { type: "application/json" })).json();
  assert.deepEqual([noType.error, noType.detail], ["invalid_metadata", "type must be one of prop, piece, vehicle, character"]);
  const planned = await (await stack.upload("desk_chair_01/v001", metadata("书椅", { type: "creature" }), { type: "application/json" })).json();
  assert.equal(planned.detail, "type creature is planned but not accepted yet");
  assert.equal((await (await stack.upload("desk_chair_01/v001", undefined, { method: "GET" })).json()).status, "new");
});

const indexOf = async (bucket, locale = "zh") => JSON.parse(await (await bucket.get(`library/index.${locale}.json`)).text());
const detailOf = async (bucket, id) => JSON.parse(await (await bucket.get(`library/${id}.json`)).text());

test("public files go to the public store at upload; approving lists the version and writes the snapshots", async () => {
  const glb = boxGLB({ size: [0.48, 0.85, 0.5] });
  const bucket = await stack.publicBucket(), sources = await stack.privateBucket();
  let status = await (await stack.upload("desk_chair_01/v001/model.glb", glb)).json();
  assert.equal(status.status, "incomplete");
  assert.deepEqual(status.stats.size, [0.48, 0.85, 0.5]);
  assert.equal(status.stats.triangles, 12);
  // Pending with metadata and model.glb; the thumbnail may come later, from review.
  assert.equal((await (await stack.upload("desk_chair_01/v001", metadata("书椅", { tags: ["chair", "low-poly", "prop", "reading_room"] }), { type: "application/json" })).json()).status, "pending");
  await stack.upload("desk_chair_01/v001/qa.json", "{}");
  await stack.upload("desk_chair_01/v001/preview.png", png);
  await stack.upload("desk_chair_01/v001/source.blend", new Uint8Array([1, 2, 3]));
  status = await (await stack.upload("desk_chair_01/v001/thumbnail.png", png)).json();
  assert.equal(status.status, "pending");
  assert.deepEqual(Object.keys(status.files).sort(), ["model.glb", "preview.png", "qa.json", "source.blend", "thumbnail.png"]);
  assert.deepEqual(status.files["model.glb"], { sha256: sha(glb), size: glb.length });

  // Before any approval: public files are in the public store by content, the rest private.
  const blob = await bucket.get(`blobs/${sha(glb)}.glb`);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), glb);
  assert.equal(blob.httpMetadata.cacheControl, "public, max-age=31536000, immutable");
  assert.ok(await bucket.head(`blobs/${sha(new Uint8Array([1, 2, 3]))}.blend`));
  assert.ok(await sources.head("models/desk_chair_01/v001/qa.json"));
  assert.ok(await sources.head("models/desk_chair_01/v001/preview.png"), "the maker's preview stays private");
  assert.equal(await bucket.head("library/index.zh.json"), null, "nothing is listed yet");
  const model = await (await stack.console("/api/models/desk_chair_01")).json();
  assert.deepEqual(model.tags, ["chair"], "tags that say nothing are dropped");

  const pending = await (await stack.console("/api/versions")).json();
  assert.deepEqual(pending.versions.map((item) => [item.id, item.version, item.name.zh]), [["desk_chair_01", "v001", "书椅"]]);
  for (const [file, body] of [["thumbnail.png", png], ["qa.json", new TextEncoder().encode("{}")]]) {
    const response = await stack.console(`/files/desk_chair_01/v001/${file}`);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body, `${file} for review`);
  }

  const edited = await (await stack.console("/api/models/desk_chair_01", { method: "PATCH", body: { name: { zh: "书桌椅", en: "Desk chair" }, tags: ["chair", "indoor"] } })).json();
  assert.equal(edited.name.zh, "书桌椅");
  assert.equal((await stack.console("/api/models/desk_chair_01/v001/approve", { method: "POST", body: {} })).status, 200);

  const index = await indexOf(bucket);
  assert.deepEqual(index.fields, ["id", "name", "description", "type", "kit", "tags", "size", "version", "thumbnail"]);
  assert.deepEqual(index.models, [["desk_chair_01", "书桌椅", "木腿绿垫的书桌椅，适合书房。", "prop", "reading_room", "chair indoor", [0.48, 0.85, 0.5], "v001", sha(png)]]);
  assert.deepEqual(index.kits, {}, "kits without a description are left out");
  assert.equal((await indexOf(bucket, "en")).models[0][2], "A wooden desk chair with a green seat; fits a study.");
  assert.match(await (await bucket.get("library/index.zh.json")).text(), /\n\["desk_chair_01",/, "one model per line");
  const detail = await detailOf(bucket, "desk_chair_01");
  assert.deepEqual([detail.name.zh, detail.listed, detail.versions.length], ["书桌椅", true, 1]);
  assert.deepEqual(Object.keys(detail.versions[0].files).sort(), ["model.glb", "source.blend", "thumbnail.png"]);

  // An approved version keeps its model and source; a new thumbnail replaces the old one at once.
  assert.equal((await stack.upload("desk_chair_01/v001/model.glb", glb)).status, 409);
  assert.equal((await stack.upload("desk_chair_01/v001", metadata(), { type: "application/json" })).status, 409);
  assert.equal((await stack.console("/api/models/desk_chair_01/v001/approve", { method: "POST", body: {} })).status, 409);
  const newThumbnail = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]);
  assert.equal((await stack.upload("desk_chair_01/v001/thumbnail.png", newThumbnail)).status, 200);
  assert.equal((await indexOf(bucket)).models[0][8], sha(newThumbnail));
  // The type is fixed once a version is approved, for the pipeline and the reviewer alike.
  assert.equal((await (await stack.upload("desk_chair_01/v002", metadata("书椅", { type: "piece" }), { type: "application/json" })).json()).error, "type_locked");
  assert.equal((await (await stack.console("/api/models/desk_chair_01", { method: "PATCH", body: { type: "piece" } })).json()).error, "type_locked");
  // Unlisting leaves the index at once; the page data and the blobs stay.
  await stack.console("/api/models/desk_chair_01", { method: "PATCH", body: { listed: false } });
  assert.deepEqual((await indexOf(bucket)).models, []);
  assert.equal((await detailOf(bucket, "desk_chair_01")).listed, false);
  assert.ok(await bucket.head(`blobs/${sha(glb)}.glb`));
  await stack.console("/api/models/desk_chair_01", { method: "PATCH", body: { listed: true } });
});

test("a file replaced before it was ever listed leaves the public store, unless another version uses it", async () => {
  const bucket = await stack.publicBucket();
  const first = boxGLB({ size: [0.3, 0.3, 0.3] }), second = boxGLB({ size: [0.31, 0.3, 0.3] });
  await stack.upload("lamp_draft_01/v001/model.glb", first);
  await stack.upload("lamp_draft_02/v001/model.glb", first);
  await stack.upload("lamp_draft_01/v001/model.glb", second);
  assert.ok(await bucket.head(`blobs/${sha(first)}.glb`), "still used by lamp_draft_02");
  await stack.upload("lamp_draft_02/v001/model.glb", second);
  assert.equal(await bucket.head(`blobs/${sha(first)}.glb`), null, "no longer used: removed");
});

test("an uploader's SHA-256 is used as the address and checked by the store", async () => {
  const glb = boxGLB({ size: [0.2, 0.2, 0.2] });
  let response = await stack.upload("hashed_01/v001/model.glb", glb, { headers: { "X-Content-SHA256": sha(glb) } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).files["model.glb"].sha256, sha(glb));
  response = await stack.upload("hashed_01/v001/model.glb", glb, { headers: { "X-Content-SHA256": "0".repeat(64) } });
  assert.equal((await response.json()).error, "checksum_mismatch");
  assert.equal((await stack.upload("hashed_01/v001/model.glb", glb, { headers: { "X-Content-SHA256": "nope" } })).status, 400);
});

test("bulk approval lists several versions and publishes them in the same request", async () => {
  for (const id of ["bulk_a_01", "bulk_b_01", "bulk_c_01"]) {
    await stack.upload(`${id}/v001`, metadata(id), { type: "application/json" });
    await stack.upload(`${id}/v001/model.glb`, boxGLB({ size: [0.3, 0.3, 0.3] }));
    await stack.upload(`${id}/v001/thumbnail.png`, png);
  }
  await stack.db.prepare("INSERT INTO kits(id, description, updated_at) VALUES('reading_room', ?, 0)").bind(JSON.stringify({ zh: "书房家具，座高 0.45 m。", en: "Study furniture, seats at 0.45 m." })).run();
  const bucket = await stack.publicBucket();
  const listed = async () => (await indexOf(bucket)).models.map((row) => row[0]);
  let result = await (await stack.console("/api/approve", { method: "POST", body: { versions: ["bulk_a_01/v001", "bulk_b_01/v001", "missing_01/v001", "Bad/v001"] } })).json();
  assert.deepEqual(result.approved, ["bulk_a_01/v001", "bulk_b_01/v001"]);
  assert.deepEqual(result.failed.map((item) => item.error), ["not_found", "invalid_id"]);
  const first = await listed();
  assert.ok(["bulk_a_01", "bulk_b_01"].every((id) => first.includes(id)) && !first.includes("bulk_c_01"), "published by the same request");
  result = await (await stack.console("/api/approve", { method: "POST", body: { versions: ["bulk_c_01/v001"] } })).json();
  assert.deepEqual(result.approved, ["bulk_c_01/v001"]);
  const after = await listed();
  assert.ok(["bulk_a_01", "bulk_b_01", "bulk_c_01"].every((id) => after.includes(id)));
  assert.equal((await indexOf(bucket, "en")).kits.reading_room, "Study furniture, seats at 0.45 m.");
  assert.equal((await detailOf(bucket, "bulk_a_01")).kitDescription.zh, "书房家具，座高 0.45 m。");
  assert.equal((await stack.console("/api/approve", { method: "POST", body: { versions: Array(11).fill("bulk_a_01/v001") } })).status, 400);

  // The fallback rewrites pages and indexes from the database.
  await bucket.delete("library/index.zh.json");
  await bucket.delete("library/bulk_c_01.json");
  const rebuilt = await (await stack.console("/api/rebuild", { method: "POST", body: { ids: ["bulk_c_01"] } })).json();
  assert.equal(rebuilt.listed, (await indexOf(bucket)).models.length);
  assert.ok(await bucket.head("library/bulk_c_01.json"));
  assert.equal((await stack.console("/api/rebuild", { method: "POST", body: { ids: Array(21).fill("bulk_a_01") } })).status, 400);
});

test("a maintainer's plan edits, rejects and approves through the same functions, then publishes once", async () => {
  for (const id of ["plan_a_01", "plan_b_01"]) {
    await stack.upload(`${id}/v001`, metadata(id, { name: { zh: "低多边形台灯", en: "Lamp" }, kit: null }), { type: "application/json" });
    await stack.upload(`${id}/v001/model.glb`, boxGLB({ size: [0.2, 0.4, 0.2] }));
    await stack.upload(`${id}/v001/thumbnail.png`, png);
  }
  const env = { MODELS_DB: stack.db, MODELS_PUBLIC: await stack.publicBucket(), MODELS_SOURCES: await stack.privateBucket() };
  const before = (await (await stack.console("/api/versions")).json()).versions.find((item) => item.id === "plan_a_01");
  assert.match(warningsOf(before).join(), /production jargon/);
  const plan = {
    kits: { desk_lamps: { zh: "台灯，底座直径 0.2 米。", en: "Desk lamps on 0.2 m bases." } },
    models: { plan_a_01: { name: { zh: "台灯", en: "Table lamp" }, kit: "desk_lamps", tags: ["lamp", "low-poly"] }, missing_01: { listed: false } },
    reject: { "plan_b_01/v001": "The shade is missing." },
    approve: ["plan_a_01/v001"],
  };
  assert.deepEqual((await applyPlan(env, plan, { dryRun: true, log: () => {} })).failed, [], "a dry run changes nothing");
  assert.equal(await env.MODELS_PUBLIC.head("library/plan_a_01.json"), null);
  const report = await applyPlan(env, plan, { log: () => {} });
  assert.deepEqual([report.kits, report.models, report.rejected, report.approved], [["desk_lamps"], ["plan_a_01"], ["plan_b_01/v001"], ["plan_a_01/v001"]]);
  assert.deepEqual(report.failed.map((item) => item.item), ["model missing_01"]);
  const detail = await detailOf(env.MODELS_PUBLIC, "plan_a_01");
  assert.deepEqual([detail.name.zh, detail.kit, detail.kitDescription.en, detail.tags], ["台灯", "desk_lamps", "Desk lamps on 0.2 m bases.", ["lamp"]]);
  const row = (await indexOf(env.MODELS_PUBLIC)).models.find((entry) => entry[0] === "plan_a_01");
  assert.equal(row[1], "台灯");
  assert.equal((await (await stack.upload("plan_b_01/v001", undefined, { method: "GET" })).json()).note, "The shade is missing.");
});

test("a rejected version carries the note and returns to pending when fixed, without its old thumbnail", async () => {
  const thumbnail = new Uint8Array([...png, 42]);
  await stack.upload("sofa_corner_01/v001", metadata("转角沙发"), { type: "application/json" });
  await stack.upload("sofa_corner_01/v001/model.glb", boxGLB({ lift: 0.02 }));
  await stack.upload("sofa_corner_01/v001/thumbnail.png", thumbnail);
  assert.equal((await stack.console("/api/models/sofa_corner_01/v001/reject", { method: "POST", body: { note: "Floats 2 cm above the floor." } })).status, 200);
  let status = await (await stack.upload("sofa_corner_01/v001", undefined, { method: "GET" })).json();
  assert.deepEqual([status.status, status.note], ["rejected", "Floats 2 cm above the floor."]);
  assert.equal(status.stats.min[1], 0.02);
  status = await (await stack.upload("sofa_corner_01/v001/model.glb", boxGLB())).json();
  assert.equal(status.status, "pending");
  // The thumbnail showed the old model: it goes, to be rendered again.
  assert.equal(status.files["thumbnail.png"], undefined);
  assert.equal(await (await stack.publicBucket()).head(`blobs/${sha(thumbnail)}.png`), null);
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
  // Uploads are console changes too: signed in, same origin, with the header.
  assert.equal((await stack.console("/api/upload/never_seen_01/v001", { method: "PUT", body: { name: { zh: "新", en: "New" }, type: "prop" }, jwt: "" })).status, 403);
  assert.equal((await stack.console("/api/upload/never_seen_01/v001", { method: "PUT", body: { name: { zh: "新", en: "New" }, type: "prop" }, headers: { "X-Fun-Console": "" } })).status, 403);
  assert.equal((await stack.console("/api/models/desk_chair_01", { method: "PATCH", body: { listed: true }, headers: { "X-Fun-Console": "" } })).status, 403);
  assert.equal((await stack.console("/api/models/desk_chair_01", { method: "PATCH", body: { listed: true }, headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
});

test("a character is approved only when its GLB meets the character rules", async () => {
  const meta = (extra = {}) => JSON.stringify({ name: { zh: "通勤男子", en: "Commuter" }, type: "character", description: { zh: "穿蓝衬衫的上班族。", en: "An office worker in a blue shirt." }, ...extra });
  await stack.upload("commuter_01/v001", meta(), { type: "application/json" });
  let status = await (await stack.upload("commuter_01/v001/model.glb", boxGLB({ size: [0.5, 1.7, 0.3] }))).json();
  assert.equal(status.status, "pending");
  let refused = await (await stack.console("/api/models/commuter_01/v001/approve", { method: "POST", body: {} })).json();
  assert.equal(refused.error, "not_a_character");
  status = await (await stack.upload("commuter_01/v002/model.glb", characterGLB({ arms: -1 }))).json();
  assert.match(status.stats.character.problems.join(), /T-pose/);
  status = await (await stack.upload("commuter_01/v003/model.glb", characterGLB())).json();
  assert.deepEqual(status.stats.character, { joints: 22, problems: [], display: true });
  assert.deepEqual(warningsOf({ ...status, id: "commuter_01", version: "v003", type: "character", description: {}, files: { ...status.files, "thumbnail.png": {} } }), []);
  assert.equal((await stack.console("/api/models/commuter_01/v003/approve", { method: "POST", body: {} })).status, 200);
});

test("derived .fun3d files are recorded for approved versions and published; a maintainer may retype", async () => {
  const env = { MODELS_DB: stack.db, MODELS_PUBLIC: await stack.publicBucket(), MODELS_SOURCES: await stack.privateBucket() };
  await stack.upload("wagon_01/v001", metadata("小货车"), { type: "application/json" });
  await stack.upload("wagon_01/v001/model.glb", boxGLB({ size: [1.8, 1.4, 4] }));
  await stack.upload("wagon_01/v001/thumbnail.png", png);
  const bytes = new Uint8Array([0x89, 0x46, 0x55, 0x4e, 0x33, 0x44, 0x0d, 0x0a, 1, 2, 3, 4]);
  const record = { converter: `sha256:${"a".repeat(64)}`, profile: "fundev-library@1" };
  // Only approved versions have derived files.
  await assert.rejects(putDerived(env, "wagon_01", "v001", bytes, record), (error) => error.code === "not_approved");
  assert.equal((await stack.console("/api/models/wagon_01/v001/approve", { method: "POST" })).status, 200);
  const listed = (await (await stack.console("/api/versions?status=approved")).json()).versions.find((item) => item.id === "wagon_01");
  assert.equal(listed.derived, null);
  assert.ok(warningsOf(listed).includes("not converted"));
  const derived = await putDerived(env, "wagon_01", "v001", bytes, { ...record, report: { triangles: 12 } });
  assert.equal(derived.sha256, sha(bytes));
  assert.ok(await env.MODELS_PUBLIC.head(`blobs/${sha(bytes)}.fun3d`), "stored by content in the public bucket");
  await publish(env, ["wagon_01"]);
  const detail = await detailOf(env.MODELS_PUBLIC, "wagon_01");
  assert.deepEqual(detail.versions[0].derived, { sha256: sha(bytes), size: bytes.length, converter: record.converter, profile: record.profile }, "pages carry the address and the converter, not the report");
  assert.deepEqual((await (await stack.console("/api/versions?status=approved")).json()).versions.find((item) => item.id === "wagon_01").derived.report, { triangles: 12 });
  // The maintenance command converts through the real converter and publishes once; current files are kept.
  const report = await convertVersions(env, [listed], { log: () => {} });
  assert.deepEqual([report.converted, report.failed], [["wagon_01/v001"], []]);
  const converted = (await detailOf(env.MODELS_PUBLIC, "wagon_01")).versions[0].derived;
  assert.equal(converted.profile, "fundev-library@1");
  assert.equal(converted.converter, report.converter);
  assert.notEqual(converted.sha256, sha(bytes));
  assert.ok(await env.MODELS_PUBLIC.head(`blobs/${converted.sha256}.fun3d`));
  const again = (await (await stack.console("/api/versions?status=approved")).json()).versions.filter((item) => item.id === "wagon_01");
  assert.equal(again[0].updated, listed.updated, "derived records leave the version's updated time (the console's order) alone");
  assert.deepEqual((await convertVersions(env, again, { log: () => {} })).skipped, ["wagon_01/v001"]);
  // The console refuses to retype an approved model; the maintainer's one-time retype republishes.
  assert.equal((await stack.console("/api/models/wagon_01", { method: "PATCH", body: { type: "vehicle" } })).status, 409);
  await retypeModel(env, "wagon_01", "vehicle");
  assert.equal((await detailOf(env.MODELS_PUBLIC, "wagon_01")).type, "vehicle");
  await assert.rejects(retypeModel(env, "wagon_01", "spaceship"), (error) => error.code === "invalid_metadata");
});
