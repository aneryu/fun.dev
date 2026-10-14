import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRelease, publishRelease, unregisterGame } from "../scripts/game-release.mjs";
import { gameOrigin } from "../scripts/game-origin.mjs";

const manifest = fileURLToPath(new URL("../site/games/cyber-muyu/1.0.0/game.json", import.meta.url));
function memoryStore() {
  const objects = new Map(); let sequence = 0;
  return {
    objects,
    async get(key) { return objects.get(key) || null; },
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
  assert.equal(store.objects.size, release.assets.length + 1);
  assert.equal(store.objects.get("games.json").cache, "no-store");
  await publishRelease(store, release);
  await publishRelease(store, {...release, game:{...release.game, title:"Updated"}});
  assert.equal(JSON.parse(store.objects.get("games.json").body)[0].title, "Updated");
  await unregisterGame(store, release.game.id);
  assert.deepEqual(JSON.parse(store.objects.get("games.json").body), []);
  assert.equal(store.objects.size, release.assets.length + 1);
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
    const {game} = await prepareRelease(manifest); delete game.release;
    const path=join(dir,"game.json");
    await writeFile(join(dir,"game.js"), "export function createGame() { return {}; }");
    for (const file of ["../secret.json", ".env", "a/../secret.json", "game.json", "node_modules/secret.js"]) {
      await writeFile(path,JSON.stringify({...game,files:["game.js",file]}));
      await assert.rejects(prepareRelease(path),/Invalid runtime/);
    }
    await symlink(join(dir,"game.js"),join(dir,"linked.js"));
    await writeFile(path,JSON.stringify({...game,files:["game.js","linked.js"]}));
    await assert.rejects(prepareRelease(path),/Symlink/);
    await writeFile(path,JSON.stringify({...game,files:["game.js"]}));
    await writeFile(join(dir,"game.js"),"import './missing.js';");
    await assert.rejects(prepareRelease(path),/Unlisted/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test("source origin configuration rejects URL injection and local endpoints", () => {
  assert.equal(gameOrigin("https://games.example.com/"),"https://games.example.com");
  for(const value of ["http://games.example.com","https://x.example.com/a","https://user@x.example.com","https://127.0.0.1","https://x.localhost","https://x.example.com:443/a","https://x.example.com?q=1"]) assert.throws(()=>gameOrigin(value));
});
