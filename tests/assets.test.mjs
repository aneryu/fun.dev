import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const work = await mkdtemp(join(tmpdir(), "fundev-assets-"));
process.env.FUNDEV_BLOBS = join(work, "cache");
const { formatLock, parseLock, sync, blobPath } = await import("../scripts/blobs.mjs");
test.after(() => rm(work, { recursive: true, force: true }));

// A checkout with one game; a second checkout shares the blob cache like a worktree.
async function checkout(name) {
  const base = join(work, name);
  await mkdir(join(base, "games", "demo", "assets"), { recursive: true });
  await mkdir(join(base, "sources"), { recursive: true });
  return base;
}
const quiet = { log: () => {} };
const lock = (base) => readFile(join(base, "games", "demo", "assets.lock"), "utf8");
const exists = (path) => stat(path).then(() => true, () => false);

test("lock lines are sorted and parsed; a path listed twice is a merge conflict", () => {
  const hash = "a".repeat(64);
  const entries = new Map([["b/2.bin", { hash, size: 2 }], ["a/1.bin", { hash, size: 1 }]]);
  const text = formatLock(entries);
  assert.equal(text, `${hash} 1 a/1.bin\n${hash} 2 b/2.bin\n`);
  assert.deepEqual([...parseLock(text)], [...entries].reverse());
  assert.throws(() => parseLock(`${text}${"b".repeat(64)} 3 a/1.bin\n`), /listed twice/);
  assert.throws(() => parseLock("not a lock line\n"), /expected/);
});

test("three-way sync: local edits update the lock, lock changes update the files", async () => {
  const a = await checkout("a");
  await writeFile(join(a, "games/demo/assets/model.glb"), "one");
  await writeFile(join(a, "sources/texture.png"), "texture");
  assert.deepEqual((await sync({ base: a, games: join(a, "games"), ...quiet })).problems, []);
  assert.match(await lock(a), / 3 assets\/model\.glb\n$/);
  assert.match(await readFile(join(a, "sources/sources.lock"), "utf8"), / 7 texture\.png\n$/);

  // Another checkout with only the locks (a fresh worktree) restores the files from the cache.
  const b = await checkout("b");
  await writeFile(join(b, "games/demo/assets.lock"), await lock(a));
  await writeFile(join(b, "sources/sources.lock"), await readFile(join(a, "sources/sources.lock")));
  assert.deepEqual((await sync({ base: b, games: join(b, "games"), mode: "restore", ...quiet })).problems, []);
  assert.equal(await readFile(join(b, "games/demo/assets/model.glb"), "utf8"), "one");

  // b edits the file: its lock changes; a receives the new lock (a merge) and its file follows.
  await writeFile(join(b, "games/demo/assets/model.glb"), "two!");
  assert.equal((await sync({ base: b, games: join(b, "games"), mode: "check", ...quiet })).changes.length, 1, "check reports the edit");
  await sync({ base: b, games: join(b, "games"), ...quiet });
  await writeFile(join(a, "games/demo/assets.lock"), await lock(b));
  await sync({ base: a, games: join(a, "games"), ...quiet });
  assert.equal(await readFile(join(a, "games/demo/assets/model.glb"), "utf8"), "two!");

  // Deleting a file unlists it; the other checkout then deletes it too.
  await rm(join(a, "games/demo/assets/model.glb"));
  await sync({ base: a, games: join(a, "games"), ...quiet });
  assert.equal(await lock(a), "");
  await writeFile(join(b, "games/demo/assets.lock"), "");
  await sync({ base: b, games: join(b, "games"), ...quiet });
  assert.equal(await exists(join(b, "games/demo/assets/model.glb")), false);
});

test("restore never edits a lock, keeps local deletions, and conflicts need a choice", async () => {
  const c = await checkout("c");
  await writeFile(join(c, "games/demo/assets/a.bin"), "a");
  await sync({ base: c, games: join(c, "games"), ...quiet });
  const before = await lock(c);
  await writeFile(join(c, "games/demo/assets/b.bin"), "b");
  await rm(join(c, "games/demo/assets/a.bin"));
  await sync({ base: c, games: join(c, "games"), mode: "restore", ...quiet });
  assert.equal(await lock(c), before, "restore leaves the lock alone");
  assert.equal(await exists(join(c, "games/demo/assets/a.bin")), false, "a deletion is not undone by restore");
  await sync({ base: c, games: join(c, "games"), ...quiet });
  assert.doesNotMatch(await lock(c), /a\.bin/);

  // Both sides changed b.bin since the last sync.
  await writeFile(join(c, "games/demo/assets/b.bin"), "local");
  const other = (await lock(c)).replace(/^[a-f0-9]{64} 1 /m, `${"c".repeat(64)} 1 `);
  await writeFile(join(c, "games/demo/assets.lock"), other);
  const { problems } = await sync({ base: c, games: join(c, "games"), ...quiet });
  assert.match(problems.join(), /changed both/);
  await sync({ base: c, games: join(c, "games"), prefer: "local", ...quiet });
  assert.match(await lock(c), / 5 assets\/b\.bin/);
  assert.ok(await exists(blobPath((await lock(c)).slice(0, 64))), "the chosen content is in the cache");
});

test("a lock entry missing from the cache is reported, not invented", async () => {
  const d = await checkout("d");
  await writeFile(join(d, "games/demo/assets.lock"), `${"d".repeat(64)} 4 assets/gone.bin\n`);
  const { problems } = await sync({ base: d, games: join(d, "games"), mode: "restore", ...quiet });
  assert.match(problems.join(), /Not in the local blob cache.*gone\.bin/);
});
