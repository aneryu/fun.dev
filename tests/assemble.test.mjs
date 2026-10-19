import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAssembly, boxSockets, compose, decompose, multiply, invert, apply } from "../site/runtime/kit/assemble.js";

// kit/assemble.js (docs/worlds.md §5): pieces with sockets grow into tracks and networks.
const tile = (size, sides, extra = {}) => ({ bounds: { min: [-size[0] / 2, 0, -size[2] / 2], max: [size[0] / 2, size[1], size[2] / 2] }, sockets: boxSockets({ min: [-size[0] / 2, 0, -size[2] / 2], max: [size[0] / 2, size[1], size[2] / 2] }, sides), ...extra });
const near = (a, b, tolerance = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

test("the transform helpers agree with Three.js's Euler XYZ convention", () => {
  const m = compose([1, 2, 3], [30, 45, 60], 1);
  const d = decompose(m);
  assert.ok(near(d.position, [1, 2, 3]) && near(d.rotation, [30, 45, 60], 1e-3), JSON.stringify(d));
  assert.ok(near(apply(multiply(m, invert(m)), [5, 6, 7]), [5, 6, 7], 1e-9), "m × m⁻¹ is the identity");
  // Yaw 90° turns +Z into +X.
  assert.ok(near(apply(compose([0, 0, 0], [0, 90, 0]), [0, 0, 1]), [1, 0, 0], 1e-9));
});

test("a chain of straights continues in one direction and a sequence turns corners", () => {
  // A 2 m straight with in/out sockets along z, a corner that turns +z into +x.
  const straight = tile([1, 0.2, 2], { n: "rail", s: "rail" });
  // A corner with distinct in and out tags, so a chain always enters it the same way.
  const corner = { bounds: { min: [-0.5, 0, -0.5], max: [0.5, 0.2, 0.5] }, sockets: { in: { position: [0, 0, -0.5], rotation: [0, 180, 0], tags: ["rail_in"] }, out: { position: [0.5, 0, 0], rotation: [0, 90, 0], tags: ["rail_out"] } } };
  const mates = [["rail", "rail"], ["rail", "rail_in"], ["rail_out", "rail"]];
  const chain = evaluateAssembly({ seed: 1, count: 4, frontier: "last", from: "s", sequence: [0] }, [straight]);
  assert.equal(chain.placed, 4);
  assert.deepEqual(chain.rows[0].map((r) => r.slice(0, 3)), [[0, 0, 0], [0, 0, 2], [0, 0, 4], [0, 0, 6]], "each straight mates the last one's far end");
  assert.equal(chain.open.length, 2, "both ends of the chain stay open");
  // The start piece stands first; the sequence names the pieces that follow it.
  const turned = evaluateAssembly({ seed: 1, count: 4, frontier: "last", from: "s", sequence: [0, 1, 0], mates }, [straight, corner]);
  assert.equal(turned.placed, 4);
  const [cornerRow] = turned.rows[1];
  assert.ok(near(cornerRow.slice(0, 3), [0, 0, 3.5], 1e-6) && near(cornerRow.slice(3, 6), [0, 0, 0], 1e-6), `the corner meets the second straight's end: ${cornerRow}`);
  const after = turned.rows[0][2];
  const yaw = ((after[4] % 360) + 360) % 360;
  assert.ok(near(after.slice(0, 3), [1.5, 0, 3.5], 1e-6) && (Math.abs(yaw - 90) < 1e-6 || Math.abs(yaw - 270) < 1e-6), `the straight after the corner runs along +x: ${after}`);
});

test("growth fills a bounded area with mating tiles, never overlapping, and closers cap the ends", () => {
  const cross = tile([2, 0.2, 2], { n: "road", s: "road", e: "road", w: "road" }, { weight: 1 });
  const straight = tile([2, 0.2, 2], { n: "road", s: "road" }, { weight: 3 });
  // A thin barrier caps an open road end; it fits inside the bounds where a tile would not.
  const end = tile([1.6, 0.2, 0.2], { n: "road" }, { closer: true });
  const bounds = [[-5.5, -5.5], [5.5, -5.5], [5.5, 5.5], [-5.5, 5.5]];
  const result = evaluateAssembly({ seed: 7, count: 30, bounds, close: true }, [cross, straight, end]);
  const all = result.rows.slice(0, 2).flatMap((rows, i) => rows.map((r) => ({ piece: i, x: r[0], z: r[2] })));
  assert.ok(all.length >= 10 && all.length <= 25, `tiles placed: ${all.length}`);
  const cells = new Set(all.map((t) => `${Math.round(t.x)},${Math.round(t.z)}`));
  assert.equal(cells.size, all.length, "no two tiles share a cell");
  assert.ok(all.every((t) => Math.abs(t.x) <= 4 && Math.abs(t.z) <= 4), "every tile stays inside the bounds");
  assert.ok(result.rows[2].length > 0, "closers were used");
  assert.equal(result.open.length, 0, "nothing stays open once closers can cap");
  assert.deepEqual(evaluateAssembly({ seed: 7, count: 30, bounds, close: true }, [cross, straight, end]).rows, result.rows, "deterministic");
});

test("tags mate by the rule's table, and a piece that fits nowhere leaves the socket open", () => {
  const plug = tile([1, 1, 1], { s: "plug" });
  const socketed = tile([1, 1, 1], { n: "socket", s: "plug" });
  const strict = evaluateAssembly({ seed: 1, count: 5, start: 0, mates: [["a", "b"]] }, [plug, socketed]);
  assert.equal(strict.placed, 1, "with a table that names neither tag, nothing mates");
  const loose = evaluateAssembly({ seed: 1, count: 3, start: 0 }, [plug]);
  assert.equal(loose.placed, 2, "without a table, equal tags mate: plug meets plug once, then both ends are used");
  const mated = evaluateAssembly({ seed: 1, count: 5, start: 0, mates: [["plug", "socket"]] }, [plug, socketed]);
  assert.equal(evaluateAssembly({ seed: 1, count: 5, start: 0, mates: [["socket", "plug"]] }, [plug, socketed]).placed, 1, "pairs are [open, new]: a plug end accepts nothing here");
  assert.equal(mated.placed, 5);
  assert.deepEqual(mated.rows[1].map((r) => r[2]), [1, 2, 3, 4], "each piece a metre further along +z");
});
