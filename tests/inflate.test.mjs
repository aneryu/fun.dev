import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { InflateError, inflateRaw } from "../site/runtime/kit/inflate.js";

// The kit's own inflate (for hosts without DecompressionStream) against zlib's encoder at
// every level, including stored blocks (level 0), fixed codes (short inputs) and dynamic codes.
function sample(kind, size, seed = 1) {
  const bytes = new Uint8Array(size);
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) >>> 0) >>> 16;
  for (let i = 0; i < size; i++) {
    if (kind === "random") bytes[i] = next() & 255;
    else if (kind === "text") bytes[i] = "the quick brown fox jumps over the lazy dog 0123456789 "[next() % 55].charCodeAt(0);
    else if (kind === "floats") bytes[i] = i % 4 === 3 ? 0x3f + (next() & 3) : next() & 255;
    else bytes[i] = (i >> 6) & 255;
  }
  return bytes;
}

const cases = [];
for (const kind of ["random", "text", "floats", "runs"]) for (const size of [0, 1, 5, 300, 70000, 300000]) cases.push([kind, size]);
for (const [kind, size] of cases) for (const level of [0, 1, 6, 9]) {
  test(`${kind} ${size} bytes, level ${level}`, () => {
    const raw = sample(kind, size);
    const packed = new Uint8Array(deflateRawSync(raw, { level }));
    assert.deepEqual(inflateRaw(packed, raw.length), raw);
  });
}

test("refuses output beyond or short of the declared length", () => {
  const raw = sample("text", 5000);
  const packed = new Uint8Array(deflateRawSync(raw));
  assert.throws(() => inflateRaw(packed, raw.length - 1), InflateError);
  assert.throws(() => inflateRaw(packed, raw.length + 1), InflateError);
});

test("refuses truncated and corrupted streams", () => {
  const raw = sample("text", 5000);
  const packed = new Uint8Array(deflateRawSync(raw));
  assert.throws(() => inflateRaw(packed.subarray(0, packed.length >> 1), raw.length), InflateError);
  const broken = packed.slice();
  broken[0] = 7; // BFINAL + block type 3
  assert.throws(() => inflateRaw(broken, raw.length), InflateError);
  assert.throws(() => inflateRaw(new Uint8Array(0), 1), InflateError);
});

test("the .fun3d container falls back to the kit's inflate without DecompressionStream", async () => {
  const { packChunks, unpackChunks } = await import("../site/runtime/kit/fun3d-container.js");
  const json = new TextEncoder().encode(JSON.stringify({ fun3d: "1.0", note: "x".repeat(4000) }));
  const bin = sample("floats", 50000);
  const file = await packChunks([{ type: "JSON", bytes: json, deflate: true }, { type: "BIN ", bytes: bin, deflate: true }]);
  const native = globalThis.DecompressionStream;
  delete globalThis.DecompressionStream;
  try {
    assert.equal(typeof globalThis.DecompressionStream, "undefined");
    const chunks = await unpackChunks(file);
    assert.deepEqual(chunks[0].bytes, json);
    assert.deepEqual(chunks[1].bytes, bin);
  } finally { globalThis.DecompressionStream = native; }
});
