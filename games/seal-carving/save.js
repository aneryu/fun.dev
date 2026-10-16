// The saved game: which seal is on the bench, and for every seal begun so far its carving
// (see carve.js serialize), its cleared ground (serializeClear) and whether it is finished. Snapshots stay a few kilobytes.
import { seals } from "./seals.js";

// 3: strokes at any angle (1 and 2 had other stroke formats; their carvings are dropped).
export const SCHEMA = 3;

export function createState() {
  return { current: seals[0].id, seals: {}, unlockAll: false };
}

export function deserialize(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("Unsupported save.");
  if (![1, 2, SCHEMA].includes(snapshot.schemaVersion)) throw new Error(`Unsupported save version ${snapshot.schemaVersion}.`);
  const data = snapshot.data;
  if (!data || typeof data !== "object" || typeof data.current !== "string" || typeof data.seals !== "object" || data.seals === null) throw new Error("Malformed save.");
  const state = createState();
  // Seals that no longer exist are dropped; unknown fields are ignored.
  for (const seal of seals) {
    const entry = data.seals[seal.id];
    // An older carving no longer matches the stroke format: the seals keep their place, their
    // carvings start afresh.
    if (snapshot.schemaVersion < SCHEMA && entry && typeof entry === "object") { state.seals[seal.id] = { cuts: null, done: false }; continue; }
    if (!entry || typeof entry !== "object") continue;
    state.seals[seal.id] = {
      cuts: typeof entry.cuts === "string" ? entry.cuts : null,
      done: entry.done === true,
    };
  }
  if (seals.some((seal) => seal.id === data.current)) state.current = data.current;
  state.unlockAll = data.unlockAll === true;
  return state;
}

export function serialize(state) {
  return { schemaVersion: SCHEMA, data: { current: state.current, seals: state.seals, unlockAll: state.unlockAll } };
}

// Seals open in order: the first, and each one after a finished seal (or all, by the cheat).
export function unlocked(state, id) {
  const index = seals.findIndex((seal) => seal.id === id);
  return state.unlockAll || index === 0 || Boolean(state.seals[seals[index - 1]?.id]?.done);
}

export function finishedCount(state) {
  return seals.filter((seal) => state.seals[seal.id]?.done).length;
}
