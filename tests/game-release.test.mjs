import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRelease, publishRelease, unregisterGame } from "../scripts/game-release.mjs";
import { gameOrigin } from "../scripts/game-origin.mjs";
import { fixtureGames, loadLocalGames, localCatalog } from "../scripts/local-games.mjs";

const manifest = fileURLToPath(new URL("fixture-games/probe/game.json", import.meta.url));
function memoryStore() {
  const objects = new Map(); let sequence = 0;
  return {
    objects,
    async get(key) { return objects.get(key) || null; },
    async exists(key) { return objects.has(key); },
    async put(key, body, options) {
      const current = objects.get(key);
      if (options.ifNoneMatch === "*" && current || options.ifMatch && current?.etag !== options.ifMatch) throw Object.assign(new Error("Precondition"), {status:412});
      objects.set(key, {body, etag: String(++sequence), ...options});
    },
  };
}
test("publish/register/update/remove independently of site files; immutable retry", async () => {
  const release = await prepareRelease(manifest);
  const store = memoryStore();
  await publishRelease(store, release);
  const first = JSON.parse(store.objects.get("games.json").body);
  assert.equal(first[0].release, release.game.release);
  // assets/ files as blobs, code and the cover under the release, files.json and the catalog.
  const blobs = release.assets.filter((asset) => asset.blob);
  const code = release.assets.filter((asset) => !asset.blob);
  const objectCount = blobs.length + code.length + 1 + 2;
  assert.ok(blobs.length && code.length);
  assert.equal(store.objects.size, objectCount);
  assert.equal(store.objects.get("games.json").cache, "no-store");
  const prefix = `games/${release.game.id}/${release.game.version}/${release.game.release}/`;
  const listed = JSON.parse(store.objects.get(`${prefix}files.json`).body);
  assert.deepEqual(listed.files, release.assets.map((asset) => asset.path));
  for (const asset of blobs) {
    assert.equal(listed.blobs[asset.path], `${asset.hash}${asset.path.slice(asset.path.lastIndexOf("."))}`);
    assert.equal(store.objects.get(`blobs/${asset.blob}`).cache, "public, max-age=31536000, immutable");
    assert.equal(store.objects.has(prefix + asset.path), asset.path === release.game.cover, `${asset.path} lives only as a blob`);
  }
  // A new version with unchanged assets uploads none of them again.
  const uploads = [];
  const put = store.put.bind(store);
  store.put = async (key, ...rest) => { uploads.push(key); return put(key, ...rest); };
  await publishRelease(store, { ...release, game: { ...release.game, version: "9.9.9", release: "f".repeat(64) } });
  assert.ok(!uploads.some((key) => key.startsWith("blobs/")), `no blob re-uploaded: ${uploads}`);
  store.put = put;
  for (const key of uploads) if (key !== "games.json") store.objects.delete(key);
  await publishRelease(store, release);
  await publishRelease(store, {...release, game:{...release.game, title:"Updated"}});
  assert.equal(JSON.parse(store.objects.get("games.json").body)[0].title, "Updated");
  await unregisterGame(store, release.game.id);
  assert.deepEqual(JSON.parse(store.objects.get("games.json").body), []);
  assert.equal(store.objects.size, objectCount);
});
test("upload failure leaves catalog unchanged; concurrent publisher cannot overwrite it", async () => {
  const release = await prepareRelease(manifest);
  const store = memoryStore();
  await publishRelease(store, release);
  const original = store.objects.get("games.json");
  const put = store.put.bind(store);
  store.put = async (key, body, opts) => { if (key !== "games.json") throw new Error("offline"); return put(key,body,opts); };
  await assert.rejects(publishRelease(store, release), /offline/);
  assert.equal(store.objects.get("games.json"), original);
  store.put = async (key, body, opts) => {
    if (key === "games.json") store.objects.set(key, {...original, etag:"concurrent"});
    return put(key,body,opts);
  };
  await assert.rejects(publishRelease(store, release), /Catalog changed/);
  assert.equal(store.objects.get("games.json").etag, "concurrent");
});
test("explicit file list rejects traversal, secrets, missing imports and symlinks", async () => {
  const dir = await mkdtemp(join(tmpdir(),"fundev-release-"));
  try {
    const {game} = await prepareRelease(manifest); delete game.release; delete game.cover;
    const path=join(dir,"game.json");
    await writeFile(join(dir,"game.js"), "export function createGame() { return {}; }");
    for (const file of ["../secret.json", ".env", "a/../secret.json", "game.json", "files.json", "node_modules/secret.js"]) {
      await writeFile(path,JSON.stringify({...game,files:["game.js",file]}));
      await assert.rejects(prepareRelease(path),/Invalid runtime/);
    }
    await symlink(join(dir,"game.js"),join(dir,"linked.js"));
    await writeFile(path,JSON.stringify({...game,files:["game.js","linked.js"]}));
    await assert.rejects(prepareRelease(path),/Symlink/);
    await writeFile(path,JSON.stringify({...game,files:["game.js"]}));
    await writeFile(join(dir,"game.js"),"import './missing.js';");
    await assert.rejects(prepareRelease(path),/Unlisted/);
    // assets/ files are served by content hash, so modules cannot import into or out of them.
    await mkdir(join(dir,"assets"));
    await writeFile(join(dir,"assets","lib.js"),"export const x = 1;");
    await writeFile(join(dir,"game.js"),"import './assets/lib.js';");
    await writeFile(path,JSON.stringify({...game,files:["game.js","assets/lib.js"]}));
    await assert.rejects(prepareRelease(path),/across assets/);
    await writeFile(join(dir,"game.js"),"export function createGame() { return {}; }");
    await writeFile(join(dir,"assets","lib.js"),"import '../game.js';");
    await assert.rejects(prepareRelease(path),/across assets/);
    await writeFile(path,JSON.stringify({...game,files:["game.js","assets/absent.glb"]}));
    await assert.rejects(prepareRelease(path),/missing; run npm run assets/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test("source origin configuration rejects URL injection and local endpoints", () => {
  assert.equal(gameOrigin("https://games.example.com/"),"https://games.example.com");
  for(const value of ["http://games.example.com","https://x.example.com/a","https://user@x.example.com","https://127.0.0.1","https://x.localhost","https://x.example.com:443/a","https://x.example.com?q=1"]) assert.throws(()=>gameOrigin(value));
});
test("local game sources build an unhashed preview catalog and require matching directory IDs", async () => {
  const releases = await loadLocalGames(fixtureGames);
  const ids = releases.map((entry) => entry.game.id);
  assert.deepEqual(ids, [...ids].sort(), "sorted by ID");
  const release = releases.find((entry) => entry.game.id === "probe");
  assert.ok(release);
  assert.ok(release.assets.every((asset) => !/^(?:dev\/|package\.json|README\.md)/.test(asset.path)));
  assert.equal(localCatalog([release])[0].release, undefined);
  const dir = await mkdtemp(join(tmpdir(), "fundev-games-"));
  try {
    const {game} = await prepareRelease(manifest); delete game.release; delete game.cover;
    await mkdir(join(dir, "other-name"));
    await writeFile(join(dir, "other-name", "game.js"), "export function createGame() { return {}; }");
    await writeFile(join(dir, "other-name", "game.json"), JSON.stringify({...game, files:["game.js"]}));
    await assert.rejects(loadLocalGames(dir), /must use id "other-name"/);
  } finally { await rm(dir, {recursive:true, force:true}); }
});
