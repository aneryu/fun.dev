import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boxGLB } from "./helpers/models.mjs";

// A stand-in for games.fun.dev: one model's page data and its blob. The blob cache is a fresh folder.
const glb = Buffer.from(boxGLB({ size: [0.5, 0.9, 0.5] }));
const sha = createHash("sha256").update(glb).digest("hex");
const detail = { licence: "CC0-1.0", id: "desk_chair_01", name: { zh: "书椅", en: "Desk chair" }, type: "prop", kit: null, tags: [], listed: true, versions: [{ version: "v002", files: { "model.glb": { sha256: sha, size: glb.length } }, stats: {} }] };
let requests = 0, online = true;
const server = createServer((request, response) => {
  requests++;
  if (!online) { response.socket.destroy(); return; }
  if (request.url === "/library/desk_chair_01.json") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(detail)); }
  else if (request.url === `/blobs/${sha}.glb`) { response.writeHead(200); response.end(glb); }
  else { response.writeHead(404); response.end(); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const work = await mkdtemp(join(tmpdir(), "library-models-"));
process.env.FUNDEV_MODELS_ORIGIN = `http://127.0.0.1:${server.address().port}`;
process.env.FUNDEV_BLOBS = join(work, "cache");
const { prepareRelease, fileIndex } = await import("../scripts/game-release.mjs");
const { forgetCatalog } = await import("../scripts/library-models.mjs");
after(async () => { server.close(); await rm(work, { recursive: true, force: true }); });

async function game(models, files = ["game.js"]) {
  const directory = await mkdtemp(join(work, "game-"));
  await writeFile(join(directory, "game.json"), JSON.stringify({ id: "demo", version: "1.0.0", apiVersion: 2, title: "Demo", description: "Demo", category: "Toy", platforms: ["mobile"], files, ...(models ? { models } : {}) }));
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

test("unknown models, bad versions and files under models/ are refused", async () => {
  await assert.rejects(prepareRelease(await game({ desk_chair_01: "v009" })), /not an approved library model/);
  await assert.rejects(prepareRelease(await game({ unknown_01: "v001" })), /not an approved library model/);
  await assert.rejects(prepareRelease(await game({ "Desk-Chair": "v001" })), /must map a library id/);
  await assert.rejects(prepareRelease(await game(undefined, ["game.js", "models/own.glb"])), /reserved for library models/);
});
