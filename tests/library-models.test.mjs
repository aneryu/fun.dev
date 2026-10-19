import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { boxGLB } from "./helpers/models.mjs";

// A stand-in for cdn.fun.dev: one model's page data and its blob. The blob cache is a fresh folder.
const glb = Buffer.from(boxGLB({ size: [0.5, 0.9, 0.5] }));
const sha = createHash("sha256").update(glb).digest("hex");
const detail = { licence: "CC0-1.0", id: "desk_chair_01", name: { zh: "书椅", en: "Desk chair" }, type: "prop", kit: null, tags: [], listed: true, versions: [{ version: "v002", files: { "model.glb": { sha256: sha, size: glb.length } }, stats: {} }] };
// A derived file the library may publish for v002 (any bytes: builds trust the library's record).
const published = Buffer.from("published derived bytes"), publishedSha = createHash("sha256").update(published).digest("hex");
let requests = 0, online = true, blobRequests = [];
const server = createServer((request, response) => {
  requests++;
  if (!online) { response.socket.destroy(); return; }
  if (request.url.startsWith("/blobs/")) blobRequests.push(request.url);
  if (request.url === "/library/desk_chair_01.json") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(detail)); }
  else if (request.url === `/blobs/${sha}.glb`) { response.writeHead(200); response.end(glb); }
  else if (request.url === `/blobs/${publishedSha}.fun3d`) { response.writeHead(200); response.end(published); }
  else { response.writeHead(404); response.end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const work = await mkdtemp(join(tmpdir(), "library-models-"));
process.env.FUNDEV_MODELS_ORIGIN = `http://127.0.0.1:${server.address().port}`;
process.env.FUNDEV_BLOBS = join(work, "cache");
const { prepareRelease, fileIndex } = await import("../scripts/game-release.mjs");
const { forgetCatalog } = await import("../scripts/library-models.mjs");
after(async () => { server.close(); await rm(work, { recursive: true, force: true }); });

async function game(models, files = ["game.js"], extra = {}) {
  const directory = await mkdtemp(join(work, "game-"));
  await writeFile(join(directory, "game.json"), JSON.stringify({ id: "demo", version: "1.0.0", apiVersion: 3, title: "Demo", description: "Demo", category: "Toy", platforms: ["mobile"], files, ...(models ? { models } : {}), ...extra }));
  await writeFile(join(directory, "game.js"), "export function createGame() {}\n");
  return join(directory, "game.json");
}

test("declared library models become pinned blobs at models/<id>.glb", async () => {
  const release = await prepareRelease(await game({ desk_chair_01: "v002" }));
  const model = release.assets.find((asset) => asset.path === "models/desk_chair_01.glb");
  assert.equal(model.blob, `${sha}.glb`);
  assert.deepEqual(model.body, glb);
  assert.equal(release.game.models, undefined, "the catalog entry stays as before");
  assert.deepEqual(fileIndex(release.assets).blobs["models/desk_chair_01.glb"], `${sha}.glb`);
  const plain = await prepareRelease(await game());
  assert.notEqual(release.game.release, plain.game.release, "the pinned model is part of the release");

  // Offline later: the cached page data and blob are enough.
  online = false;
  forgetCatalog();
  const before = requests;
  assert.equal((await prepareRelease(await game({ desk_chair_01: "v002" }))).game.release, release.game.release);
  assert.ok(requests > before, "it did try the network first");
  online = true;
});

test("modelFormat fun3d derives files through the converter, caches them and writes models.lock", async () => {
  const manifest = await game({ desk_chair_01: "v002" }, ["game.js"], { modelFormat: "fun3d" });
  const release = await prepareRelease(manifest);
  const model = release.assets.find((asset) => asset.path === "models/desk_chair_01@v002.fun3d");
  assert.ok(model, "the derived file is a runtime file");
  assert.equal(model.blob, `${model.hash}.fun3d`);
  assert.deepEqual([...model.body.subarray(0, 8)], [0x89, 0x46, 0x55, 0x4e, 0x33, 0x44, 0x0d, 0x0a], "a .fun3d file");
  assert.equal(release.game.modelFormat, undefined, "the catalog entry stays as before");
  const lock = await readFile(join(dirname(manifest), "models.lock"), "utf8");
  assert.match(lock, /^# library models derived by fundev-library@1, converter sha256:[0-9a-f]{64}\n/);
  assert.match(lock, new RegExp(`${model.hash} ${model.body.length} models/desk_chair_01@v002.fun3d\n`));
  // The second build converts nothing: the derived blob comes from the cache, even offline.
  online = false;
  forgetCatalog();
  const again = await prepareRelease(await game({ desk_chair_01: "v002" }, ["game.js"], { modelFormat: "fun3d" }));
  assert.equal(again.game.release, release.game.release);
  online = true;
  await assert.rejects(prepareRelease(await game({ desk_chair_01: "v002" }, ["game.js"], { modelFormat: "obj" })), /modelFormat must be one of/);
});

test("a derived file the library published with this converter is downloaded instead of converted", async () => {
  const { converterStamp } = await import("../scripts/fun3d-convert.mjs");
  detail.versions[0].derived = { sha256: publishedSha, size: published.length, converter: await converterStamp(), profile: "fundev-library@1" };
  forgetCatalog();
  blobRequests = [];
  const release = await prepareRelease(await game({ desk_chair_01: "v002" }, ["game.js"], { modelFormat: "fun3d" }));
  const model = release.assets.find((asset) => asset.path === "models/desk_chair_01@v002.fun3d");
  assert.deepEqual(model.body, published);
  assert.deepEqual(blobRequests, [`/blobs/${publishedSha}.fun3d`], "the published file is fetched once; the GLB is already cached");
  // Another converter's file is not used: the build converts for itself.
  detail.versions[0].derived.converter = `sha256:${"b".repeat(64)}`;
  forgetCatalog();
  const own = (await prepareRelease(await game({ desk_chair_01: "v002" }, ["game.js"], { modelFormat: "fun3d" }))).assets.find((asset) => asset.path.endsWith(".fun3d"));
  assert.notDeepEqual(own.body, published);
  assert.deepEqual([...own.body.subarray(0, 8)], [0x89, 0x46, 0x55, 0x4e, 0x33, 0x44, 0x0d, 0x0a]);
  delete detail.versions[0].derived;
  forgetCatalog();
});

test("convert derives bundled GLBs to .fun3d beside them, cached by source and converter", async () => {
  const directory = await mkdtemp(join(work, "game-"));
  await mkdir(join(directory, "assets", "props"), { recursive: true });
  await writeFile(join(directory, "assets", "props", "crate.glb"), Buffer.from(boxGLB({ size: [1, 1, 1] })));
  await writeFile(join(directory, "assets", "props", "wall.glb"), Buffer.from(boxGLB({ size: [3, 2, 0.2] })));
  await writeFile(join(directory, "game.js"), "export function createGame() {}\n");
  const write = (convert) => writeFile(join(directory, "game.json"), JSON.stringify({ id: "demo", version: "1.0.0", apiVersion: 3, title: "Demo", description: "Demo", category: "Toy", platforms: ["mobile"], files: ["game.js", "assets/props/crate.glb", "assets/props/wall.glb"], convert }));
  await write(["assets/props/crate.glb", { files: "assets/props/w*.glb", type: "piece" }]);
  const release = await prepareRelease(join(directory, "game.json"));
  const crate = release.assets.find((asset) => asset.path === "assets/props/crate.fun3d"), wall = release.assets.find((asset) => asset.path === "assets/props/wall.fun3d");
  assert.ok(crate && wall, "a .fun3d beside each matched GLB");
  assert.equal(crate.blob, `${crate.hash}.fun3d`);
  assert.deepEqual([...crate.body.subarray(0, 8)], [0x89, 0x46, 0x55, 0x4e, 0x33, 0x44, 0x0d, 0x0a]);
  assert.equal(release.game.convert, undefined, "the catalog entry stays as before");
  assert.deepEqual(fileIndex(release.assets).blobs["assets/props/wall.fun3d"], `${wall.hash}.fun3d`);
  const again = await prepareRelease(join(directory, "game.json"));
  assert.equal(again.game.release, release.game.release, "derivation is deterministic and cached");
  await write(["assets/props/*.obj"]);
  await assert.rejects(prepareRelease(join(directory, "game.json")), /must be a pattern of .glb files/);
  await write(["assets/props/missing_*.glb"]);
  await assert.rejects(prepareRelease(join(directory, "game.json")), /matches no listed file/);
  await write([{ files: "assets/props/*.glb", type: "spaceship" }]);
  await assert.rejects(prepareRelease(join(directory, "game.json")), /with a type among/);
});

test("unknown models, bad versions and files under models/ are refused", async () => {
  await assert.rejects(prepareRelease(await game({ desk_chair_01: "v009" })), /not an approved library model/);
  await assert.rejects(prepareRelease(await game({ unknown_01: "v001" })), /not an approved library model/);
  await assert.rejects(prepareRelease(await game({ "Desk-Chair": "v001" })), /must map a library id/);
  await assert.rejects(prepareRelease(await game(undefined, ["game.js", "models/own.glb"])), /reserved for library models/);
});
