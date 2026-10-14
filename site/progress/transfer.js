import { assert, identifier, snapshot } from "./format.js";

export const TRANSFER_TTL = 10 * 60 * 1000;
export const RECEIPT_TTL = 7 * 86400000;
export const MAX_PACKET_BYTES = 1024 * 1024;
export const randomSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, "0")).join("");
export const byteLength = value => new TextEncoder().encode(value).length;
export async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), x => x.toString(16).padStart(2, "0")).join("");
}
export function hex(value) { assert(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "invalid_transfer"); return value; }
export const transferId = (secret, deadline) => hash(`fun.dev.transfer.v1:${secret}:${deadline}`);
export function decodeLink(value) {
  assert(typeof value === "string" && value.length === 129, "invalid_transfer");
  const [id, token] = value.split(".");
  return { id: hex(id), token: hex(token) };
}
export function packet(value) {
  assert(value?.format === "fun.dev.transfer" && value.version === 1, "invalid_transfer");
  identifier(value.profileId);
  assert(Array.isArray(value.saves) && Array.isArray(value.alternatives) && value.saves.length + value.alternatives.length <= 128, "invalid_transfer");
  const game = entry => {
    assert(typeof entry?.gameId === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.gameId) && entry.gameId.length <= 100, "invalid_game");
    return { gameId: entry.gameId, snapshot: entry.snapshot === null ? null : snapshot(entry.snapshot) };
  };
  const saves = value.saves.map(game), alternatives = value.alternatives.map(game);
  assert(new Set(saves.map(x => x.gameId)).size === saves.length, "invalid_transfer");
  const result = { format: value.format, version: 1, profileId: value.profileId, saves, alternatives };
  assert(byteLength(JSON.stringify(result)) <= MAX_PACKET_BYTES, "save_too_large", 413);
  return result;
}
