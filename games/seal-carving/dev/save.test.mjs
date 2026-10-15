import { test } from "node:test";
import assert from "node:assert/strict";
import { seals } from "../seals.js";
import * as saving from "../save.js";

test("saves round-trip and drop what they do not know", () => {
  const state = saving.createState();
  state.seals[seals[0].id] = { cuts: "AAAA", done: true };
  const snapshot = saving.serialize(state);
  snapshot.data.seals.gone = { cuts: "x", done: true };
  snapshot.data.extra = 1;
  const again = saving.deserialize(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(again.seals, { [seals[0].id]: { cuts: "AAAA", done: true } });
  assert.equal(again.current, seals[0].id);
});

test("version 1 carvings are dropped; unsupported or malformed saves are refused", () => {
  const old = saving.deserialize({ schemaVersion: 1, data: { current: seals[1].id, seals: { [seals[0].id]: { cuts: "AAAA", done: true } } } });
  assert.deepEqual(old.seals[seals[0].id], { cuts: null, done: false });
  assert.equal(old.current, seals[1].id);
  assert.throws(() => saving.deserialize({ schemaVersion: 3, data: {} }));
  assert.throws(() => saving.deserialize({ schemaVersion: 1, data: { current: 3, seals: {} } }));
  assert.throws(() => saving.deserialize(null));
});

test("seals open in order, or all with the cheat", () => {
  const state = saving.createState();
  assert.equal(saving.unlocked(state, seals[0].id), true);
  assert.equal(saving.unlocked(state, seals[1].id), false);
  state.seals[seals[0].id] = { cuts: null, done: true };
  assert.equal(saving.unlocked(state, seals[1].id), true);
  assert.equal(saving.unlocked(state, seals[2].id), false);
  state.unlockAll = true;
  assert.equal(saving.unlocked(state, seals.at(-1).id), true);
  assert.equal(saving.finishedCount(state), 1);
});
