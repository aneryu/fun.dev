import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyStrike, createState, formatMerit, newlyUnlocked, skins, unlocked, deserialize, dropChance, FIRST_PITY, formatNumber, items, PITY, rollDrop,
  serialize, strikeValue,
} from "../economy.js";
import { report, simulate } from "./simulate.mjs";

const fixed = (...values) => { let i = 0; return () => values[i++ % values.length]; };

test("a strike is worth 1 merit, times zen and 福报; relics change nothing", () => {
  assert.equal(strikeValue(), 1);
  assert.equal(strikeValue({ zen: 2 }), 2);
  assert.equal(strikeValue({ zen: 2, luck: { id: "fortune" } }), 6);
  assert.equal(strikeValue({ luck: { id: "chance" } }), 1);
});

test("only chanting strikes drop; pity guarantees a drop; merit only grows", () => {
  const state = createState();
  assert.equal(applyStrike(state, { chanting: false, random: () => 0 }).drop, null);
  assert.equal(applyStrike(state, { interval: 0.5, random: () => 0.99 }).drop, null);
  assert.equal(state.merit, 2);
  state.sinceDrop = FIRST_PITY;
  assert.equal(dropChance(state), 1);
  state.stats.drops = 1;
  assert.ok(dropChance(state, { interval: 0.5 }) < 1);
  state.sinceDrop = PITY;
  assert.equal(dropChance(state), 1);
});

test("mashing faster than the steady tempo lowers the drop chance; 好运 raises it", () => {
  const state = createState();
  state.stats.drops = 1;
  assert.ok(dropChance(state, { interval: 0.2 }) < dropChance(state, { interval: 0.5 }));
  assert.equal(dropChance(state, { interval: 0.7 }), dropChance(state, { interval: 1.5 }));
  assert.equal(dropChance(state, { interval: 0.5, luck: { id: "chance" } }), dropChance(state, { interval: 0.5 }) * 3);
});

test("every relic drops once; a full collection only drops luck", () => {
  const state = createState();
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    const drop = rollDrop(state, fixed(0.9, (i * 0.37) % 1));
    assert.equal(drop.kind, "item");
    assert.ok(!seen.has(drop.id));
    seen.add(drop.id);
    state.collection[drop.id] = 1;
  }
  // With nothing left to collect, every drop is luck.
  assert.deepEqual(rollDrop(state, fixed(0.9)), { kind: "luck", id: "chance", seconds: 30 });
  assert.deepEqual(rollDrop(createState(), fixed(0.1, 0.4)), { kind: "luck", id: "fortune", seconds: 30 });
});

test("saves round-trip, migrate older saves and reject anything unexpected", () => {
  const state = createState();
  state.merit = 1234.5; state.collection.bowl = 1; state.stats.strikes = 9; state.sinceDrop = 12.5;
  state.relics = { bowl: { off: true, x: 1.5, z: 0.8 } };
  assert.deepEqual(deserialize(JSON.parse(JSON.stringify(serialize(state)))), state);
  assert.equal(deserialize({ schemaVersion: 1, data: { merit: 42 } }).merit, 42);
  assert.equal(deserialize({ schemaVersion: 2, data: { merit: 3, lifetime: 900 } }).merit, 900);
  // The 2.0 draft: stars count as collected; retired relics are dropped.
  const draft = serialize(createState());
  draft.data.collection.bowl = 3; draft.data.collection.string = 2;
  draft.data.relics = { bowl: { x: "far" }, beads: { off: true }, ghost: { off: true } };
  const migrated = deserialize(draft);
  assert.deepEqual(migrated.relics, { beads: { off: true } });
  assert.equal(migrated.collection.bowl, 1);
  assert.equal("string" in migrated.collection, false);
  const data = serialize(state).data;
  for (const bad of [
    { schemaVersion: 1, data: { merit: -1 } }, { schemaVersion: 4, data },
    { schemaVersion: 3, data: { ...data, merit: Infinity } },
    { schemaVersion: 3, data: { ...data, collection: { ...data.collection, bowl: 4 } } },
  ]) assert.throws(() => deserialize(bad));
});

test("numbers abbreviate with locale units; every relic is bilingual", () => {
  assert.equal(formatNumber(9999, "zh"), "9999");
  assert.equal(formatNumber(12345, "zh"), "1.23万");
  assert.equal(formatNumber(1500, "en"), "1.5K");
  assert.equal(formatMerit(30128.7, "zh"), "30,128");
  assert.equal(formatMerit(99999999, "en"), "99,999,999");
  assert.equal(formatMerit(3.2e9, "zh"), "32亿");
  assert.equal(new Set(items.map((item) => item.id)).size, 12);
  for (const item of items) for (const locale of ["zh", "en"]) assert.ok(item.name[locale] && item.does[locale]);
});

// Pacing (DESIGN-economy.md): about 20 minutes of steady tapping to collect all 12.
test("a steady player completes the collection in about 20 minutes; mashing is slower", (t) => {
  const runs = (style) => Array.from({ length: 30 }, (_, i) => simulate({ style, seed: i + 1 }));
  const steady = runs("steady"), mash = runs("mash");
  const mean = (list) => list.reduce((sum, run) => sum + run.completedAt, 0) / list.length / 60;
  t.diagnostic(`\n${report(steady[0])}\n稳定平均 ${mean(steady).toFixed(1)} 分，狂点平均 ${mean(mash).toFixed(1)} 分`);
  assert.ok(steady.every((run) => run.completedAt !== null));
  assert.ok(mean(steady) >= 15 && mean(steady) <= 25, `steady ${mean(steady)} min`);
  assert.ok(mean(mash) > mean(steady), "mashing is not faster");
  for (const run of steady) {
    assert.ok(run.firstDrop <= 40, `first drop after ${run.firstDrop} s`);
    assert.ok(run.longestGap <= 4 * 60, `waited ${run.longestGap} s`);
  }
});

test("skins unlock with merit; saves keep known skins and fall back otherwise", () => {
  const state = createState();
  assert.deepEqual(state.skin, { fish: "wood", cushion: "red" });
  const lacquer = skins.fish.find((skin) => skin.id === "lacquer");
  assert.equal(unlocked(state, lacquer), false);
  state.merit = 500;
  assert.equal(unlocked(state, lacquer), true);
  assert.deepEqual(newlyUnlocked(199, 500).map((skin) => skin.id), ["lacquer", "blue"]);
  state.skin = { fish: "jade", cushion: "nope" };
  const loaded = deserialize(serialize(state));
  assert.deepEqual(loaded.skin, { fish: "jade", cushion: "red" });
  for (const part of ["fish", "cushion"]) assert.equal(new Set(skins[part].map((skin) => skin.id)).size, 6);
});
