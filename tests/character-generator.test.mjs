import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { clipGait, clipTracks, createFootLock, createGait, retargetClip, trackPositions, twoBoneIK, DEFAULT_DATA, FEATURES, faceTint, garmentsFor, generateCharacter, LODS, parametersFor, PARAMETERS, SLOTS } from "../site/runtime/kit/character.js";
import { TEST_DATA } from "./helpers/character-data.mjs";

// kit/character (docs/character-generator.md): the generated body is closed, outward, mirrored,
// skinned with at most four normalised influences, joined at seam rings of the specified
// counts, and reproducible from its inputs; garments go over it, in islands of their own, and
// the body faces they cover are dropped. The repository's data (MakeHuman's CC0 people) and a small
// test set made from it (tests/helpers/character-data.mjs: a top, faces) stand in for any data set.

// Two bodies (the second without eyeballs), the test set's top fitted to the first only, no faces.
const TWO = { id: "two", shapes: { body: TEST_DATA.shapes.body, plain: { ...DEFAULT_DATA.shapes.f, eyes: false } }, garments: TEST_DATA.garments, faces: {} };

/** Every garment slot empty: the body alone. */
const NAKED = Object.fromEntries(SLOTS.map((slot) => [slot, "none"]));

const SEAM_COUNTS = [{ neck: 16, waist: 24, wrist: 12, ankle: 16 }, { neck: 8, waist: 12, wrist: 8, ankle: 8 }, { neck: 8, waist: 8, wrist: 4, ankle: 4 }];
const REQUIRED_ROLES = ["hips", "spine", "head", "leftUpperArm", "leftLowerArm", "leftHand", "rightUpperArm", "rightLowerArm", "rightHand",
  "leftUpperLeg", "leftLowerLeg", "leftFoot", "rightUpperLeg", "rightLowerLeg", "rightFoot"];

const point = (a, i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];

/** Problems with a generated mesh's shared topology (empty when it is sound). */
function topologyProblems({ positions, indices }) {
  const problems = [];
  const edges = new Map();
  for (let f = 0; f < indices.length; f += 3) {
    const v = [indices[f], indices[f + 1], indices[f + 2]];
    for (let k = 0; k < 3; k++) {
      const key = `${v[k]}>${v[(k + 1) % 3]}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
    const [a, b, c] = v.map((i) => point(positions, i));
    const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
    if (Math.hypot(...n) < 1e-10) problems.push(`degenerate face ${f / 3}`);
  }
  for (const [key, count] of edges) {
    const [a, b] = key.split(">");
    if (count !== 1) problems.push(`edge ${key} used ${count} times in one direction`);
    if (edges.get(`${b}>${a}`) !== 1) problems.push(`edge ${key} has no opposite (open or flipped)`);
  }
  let volume = 0;
  for (let f = 0; f < indices.length; f += 3) {
    const [a, b, c] = [indices[f], indices[f + 1], indices[f + 2]].map((i) => point(positions, i));
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  if (!(volume > 0)) problems.push(`signed volume ${volume} is not positive (faces point inward)`);
  for (const x of positions) if (!Number.isFinite(x)) { problems.push("a position is not finite"); break; }
  return problems.slice(0, 10);
}

for (const lod of [0, 1, 2]) {
  test(`LOD${lod}: a closed, outward, non-degenerate surface`, () => {
    for (const seed of [1, 2, 3, "alice"]) {
      assert.deepEqual(topologyProblems(generateCharacter({ seed, lod, params: NAKED }).mesh.topology), [], `seed ${seed}`);
      assert.deepEqual(topologyProblems(generateCharacter({ seed, lod, params: NAKED, data: TEST_DATA }).mesh.topology), [], `seed ${seed}, with eyeballs`);
    }
  });

  test(`LOD${lod}: left and right mirror exactly, normals included`, () => {
    const { positions, normals } = generateCharacter({ seed: 5, lod, params: NAKED, data: TEST_DATA }).mesh.topology;
    const key = (p) => p.map((x) => x.toFixed(7)).join(",");
    const at = new Map();
    for (let i = 0; i < positions.length / 3; i++) at.set(key(point(positions, i)), i);
    for (let i = 0; i < positions.length / 3; i++) {
      const p = point(positions, i);
      const j = at.get(key([-p[0], p[1], p[2]]));
      assert.ok(j !== undefined, `vertex ${i} at ${p} has no mirror image`);
      const n = point(normals, i), m = point(normals, j);
      assert.ok(Math.abs(n[0] + m[0]) < 1e-9 && Math.abs(n[1] - m[1]) < 1e-9 && Math.abs(n[2] - m[2]) < 1e-9, `normal of ${i}`);
      assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-9, `normal of ${i} is a unit vector`);
    }
  });

  test(`LOD${lod}: seam rings have the specified counts and join their segments`, () => {
    const { mesh } = generateCharacter({ seed: 9, lod });
    const { seams, topology } = mesh;
    if (!seams) return;   // a body from a reference mesh is one piece, with no seam rings
    const counts = SEAM_COUNTS[lod];
    assert.equal(seams.neck.length, counts.neck);
    assert.equal(seams.waist.length, counts.waist);
    for (const side of ["l", "r"]) {
      assert.equal(seams[`${side}_wrist`].length, counts.wrist);
      assert.equal(seams[`${side}_ankle`].length, counts.ankle);
    }
    const islandsOf = new Map();
    topology.islands.forEach((island, f) => {
      for (let k = 0; k < 3; k++) {
        const v = topology.indices[f * 3 + k];
        if (!islandsOf.has(v)) islandsOf.set(v, new Set());
        islandsOf.get(v).add(island.replace(/\.[lr]$/, ""));
      }
    });
    const joins = { neck: ["torso", "head"], waist: ["torso", "hips"], l_wrist: ["arm", "hand"], r_wrist: ["arm", "hand"],
      l_ankle: ["leg", "foot"], r_ankle: ["leg", "foot"] };
    for (const [seam, [a, b]] of Object.entries(joins)) {
      for (const v of seams[seam]) assert.ok(islandsOf.get(v)?.has(a) && islandsOf.get(v)?.has(b), `${seam} vertex ${v} joins ${a} and ${b}`);
    }
    // Ring order: index 0 at the front, counter-clockwise about the bone's +Y; right index i is
    // the mirror of left index (n − i) mod n.
    for (const seam of ["wrist", "ankle"]) {
      const l = seams[`l_${seam}`], r = seams[`r_${seam}`], n = l.length;
      for (let i = 0; i < n; i++) {
        const pl = point(topology.positions, l[(n - i) % n]), pr = point(topology.positions, r[i]);
        assert.ok(Math.abs(pl[0] + pr[0]) < 1e-9 && Math.abs(pl[1] - pr[1]) < 1e-9 && Math.abs(pl[2] - pr[2]) < 1e-9, `${seam} ${i}`);
      }
    }
    const neck = seams.neck.map((v) => point(topology.positions, v));
    assert.equal(neck[0][0], 0, "the neck ring starts on the centre line");
    assert.ok(neck[0][2] > neck[counts.neck / 2][2], "at the front");
    assert.ok(neck[counts.neck / 4][0] > 0, "and turns to the left (+x) first");
  });

  test(`LOD${lod}: skin weights are normalised, at most four, on real bones`, () => {
    const c = generateCharacter({ seed: 4, lod });
    const { joints, weights, positions } = c.mesh;
    for (let i = 0; i < positions.length / 3; i++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += weights[i * 4 + k];
        assert.ok(joints[i * 4 + k] < c.skeleton.bones.length);
        if (k) assert.ok(weights[i * 4 + k] <= weights[i * 4 + k - 1] + 1e-7, "heaviest first");
      }
      assert.ok(Math.abs(sum - 1) < 1e-5, `vertex ${i} weights sum to ${sum}`);
    }
  });
}

test("the skeleton: 84 bones, parents first, right-handed frames, +Y to the child, mirrored sides", () => {
  const { skeleton, rig } = generateCharacter({ seed: 1 });
  const bones = skeleton.bones;
  assert.equal(bones.length, 84);
  assert.equal(new Set(bones.map((b) => b.id)).size, 84);
  const index = new Map(bones.map((b, i) => [b.id, i]));
  bones.forEach((b, i) => {
    assert.ok(b.parentIndex < i, `${b.id} after its parent`);
    const { x, y, z } = b.axes;
    const dot = (a, c) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
    assert.ok(Math.abs(dot(x, y)) < 1e-9 && Math.abs(dot(y, z)) < 1e-9 && Math.abs(dot(z, x)) < 1e-9, `${b.id} orthogonal`);
    const xy = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    assert.ok(dot(xy, z) > 0.999999, `${b.id} right-handed`);
    const children = bones.filter((c) => c.parent === b.id && dot(c.position.map((v, k) => v - b.position[k]), c.position.map((v, k) => v - b.position[k])) > 1e-8);
    if (children.length && !b.id.startsWith("face") && b.id !== "hips" && b.id !== "head") {
      assert.ok(children.some((c) => dot(y, c.position.map((v, k) => v - b.position[k])) > 0), `${b.id} +Y points to a child`);
    }
    if (b.id.startsWith("r_")) {
      const l = bones[index.get(b.id.replace(/^r_/, "l_"))];
      const m = (v) => [-v[0], v[1], v[2]];
      const close = (a, c) => a.every((v, k) => Math.abs(v - c[k]) < 1e-12);
      assert.ok(close(b.position, m(l.position)), `${b.id} position`);
      assert.ok(close(b.axes.x, m(l.axes.x).map((v) => -v)) && close(b.axes.y, m(l.axes.y)) && close(b.axes.z, m(l.axes.z)), `${b.id} frame`);
    }
  });
  assert.equal(rig.name, "fundev-character");
  assert.equal(rig.rest, "A", "the bodies rest in an A-pose");
  for (const role of REQUIRED_ROLES) assert.ok(index.has(rig.roles[role]), `role ${role}`);
  // Hinge joints flex about +X: a positive turn of the forearm about its X moves the hand forward.
  const fore = bones[index.get("l_forearm")];
  assert.ok(fore.axes.z[2] > 0.7, "the elbow flexes forward");   // the rest pose holds the forearms a little forward
  assert.ok(bones[index.get("l_calf")].axes.z[2] < -0.99, "the knee flexes backward");
});

test("the same inputs give the same arrays; the body parameter picks the shape from the data set", () => {
  const a = generateCharacter({ seed: 42, lod: 0 }), b = generateCharacter({ seed: 42, lod: 0 });
  for (const key of ["positions", "normals", "uvs", "joints", "weights", "indices"]) assert.deepEqual(a.mesh[key], b.mesh[key], key);
  assert.ok(["m", "f"].includes(a.semantic.body));
  assert.equal(a.data, "cc0");
  assert.equal(a.rig.rest, "A", "MakeHuman's rest pose");
  const m = generateCharacter({ seed: 42, params: { body: "body" }, data: TWO }), e = generateCharacter({ seed: 42, params: { body: "plain" }, data: TWO });
  assert.equal(e.semantic.body, "plain");
  assert.notDeepEqual(m.mesh.positions, e.mesh.positions);
  const bodies = new Set(Array.from({ length: 40 }, (_, seed) => generateCharacter({ seed, lod: 2, data: TWO }).semantic.body));
  assert.deepEqual([...bodies].sort(), ["body", "plain"], "seeds draw both bodies");
  assert.deepEqual(parametersFor(TWO).find((p) => p.id === "body").options, ["body", "plain"]);
  assert.throws(() => generateCharacter({ lod: 3 }), /lod/);
  assert.throws(() => generateCharacter({ params: { body: "x" } }), /body/);
});

test("body UVs stay in [0, 1]; garments are islands named by their ids, with finite UVs", () => {
  const { mesh } = generateCharacter({ seed: 3, params: NAKED });
  for (const v of mesh.uvs) assert.ok(v >= 0 && v <= 1);
  assert.ok(mesh.groups.every((g) => g.count > 0));
  assert.deepEqual([...new Set(mesh.groups.map((g) => g.island))].sort(), ["eyes", "skin"], "one skin and the eyeballs");
  assert.deepEqual([...new Set(generateCharacter({ seed: 3, params: { body: "plain" }, data: TWO }).mesh.groups.map((g) => g.island))].sort(), ["skin"], "a body without eyeballs");
  const dressed = generateCharacter({ seed: 3, data: TEST_DATA });
  for (const v of dressed.mesh.uvs) assert.ok(Number.isFinite(v));   // a garment's own texture may repeat
  const worn = SLOTS.map((slot) => dressed.semantic[slot]).filter((id) => id !== "none");
  assert.ok(worn.length > 0, "a seed dresses its character");
  for (const id of worn) assert.ok(dressed.mesh.groups.some((g) => g.island === id && g.count > 0), id);
});

test("the feet stand on the floor (within 5 mm) and the head reaches the stature", () => {
  for (const seed of [1, 2, 3]) {
    const c = generateCharacter({ seed, params: NAKED });
    const ys = [];
    for (let i = 1; i < c.mesh.positions.length; i += 3) ys.push(c.mesh.positions[i]);
    // The feet are the source's, simplified: the sole's lowest point may move up a few millimetres.
    assert.ok(Math.min(...ys) >= 0 && Math.min(...ys) < 0.005, `lowest point ${Math.min(...ys)}`);
    // The stature is the base shape's crown; a face may raise or lower it a little.
    assert.ok(Math.abs(Math.max(...ys) - c.stature) < 0.03, `highest point ${Math.max(...ys)}`);
  }
});

test("garments: fitted per body, covering body faces they hide, the same on both sides", () => {
  const data = TEST_DATA;
  for (const body of Object.keys(data.shapes)) {
    const naked = generateCharacter({ seed: 1, params: { body, ...NAKED }, data });
    for (const slot of SLOTS) {
      for (const id of garmentsFor(body, slot, data)) {
        const g = data.garments[body][id];
        assert.equal(g.mesh.length, LODS.length, `${body} ${id} has every LOD`);
        assert.equal(g.hides.length, LODS.length);
        for (let lod = 0; lod < LODS.length; lod++) {
          const level = data.shapes[body].mesh[lod];
          for (const k of g.hides[lod]) assert.ok(Number.isInteger(k) && k >= 0 && k < level.f.length, `${body} ${id} LOD${lod} hides face ${k}`);
          assert.equal(g.mesh[lod].fuv.length, g.mesh[lod].f.length);
          // Tucks: [vertex, dx, dy, dz] of the left half, a few centimetres at most, none off the centre line.
          const t = g.tucks[lod];
          assert.equal(t.length % 4, 0);
          for (let n = 0; n < t.length; n += 4) {
            assert.ok(Number.isInteger(t[n]) && t[n] < level.p.length, `${body} ${id} LOD${lod} tucks vertex ${t[n]}`);
            assert.ok(Math.hypot(t[n + 1], t[n + 2], t[n + 3]) < 0.04, `${body} ${id} tuck of ${t[n]}`);
            if (level.p[t[n]][0] === 0) assert.equal(t[n + 1], 0, "the centre line stays on x = 0");
          }
        }
        const worn = generateCharacter({ seed: 1, params: { body, ...NAKED, [slot]: id }, data });
        const bodyFaces = (c) => c.mesh.groups.filter((gr) => !data.garments[body][gr.island]).reduce((n, gr) => n + gr.count / 3, 0);
        // Each hidden face of the left half goes with its mirror image.
        assert.equal(bodyFaces(naked) - bodyFaces(worn), 2 * g.hides[0].length, `${body} ${id}`);
        if (slot !== "hair") assert.ok(g.hides[0].length > 0, `${body} ${id} covers some of the body`);
      }
    }
  }
  assert.throws(() => generateCharacter({ params: { body: "plain", top: "tube" }, data: TWO }), /not fitted to body plain/);
  assert.throws(() => generateCharacter({ params: { top: "cape" }, data }), /top/);
  // A body given is dressed from its own garments.
  for (let seed = 0; seed < 20; seed++) {
    for (const body of Object.keys(TWO.shapes)) {
      const { semantic } = generateCharacter({ seed, lod: 2, params: { body }, data: TWO });
      for (const slot of SLOTS) assert.ok(semantic[slot] === "none" || TWO.garments[body]?.[semantic[slot]], `seed ${seed} ${body} ${slot}`);
    }
  }
});

test("eye colours: a parameter drawn from the seed, picking a cell of the eye texture", () => {
  const colours = parametersFor(TEST_DATA).find((p) => p.id === "eyes").options;
  assert.ok(!parametersFor({ id: "none", shapes: { plain: TWO.shapes.plain }, garments: {}, faces: {} }).some((p) => p.id === "eyes"), "a data set without eyeballs has no eye colour");
  const drawn = new Set(Array.from({ length: 60 }, (_, seed) => generateCharacter({ seed, lod: 2, data: TEST_DATA }).semantic.eyes));
  assert.ok(drawn.size > 3, "seeds vary the eyes");
  const uvsOf = (eyes) => {
    const { mesh } = generateCharacter({ seed: 1, lod: 2, params: { ...NAKED, eyes }, data: TEST_DATA });
    const g = mesh.groups.find((gr) => gr.island === "eyes"), us = [];
    for (let i = g.start; i < g.start + g.count; i++) us.push(mesh.uvs[mesh.indices[i] * 2]);
    return [Math.min(...us), Math.max(...us)];
  };
  colours.forEach((colour, k) => {
    const [lo, hi] = uvsOf(colour);
    assert.ok(lo >= k / 8 - 1e-9 && hi <= (k + 1) / 8 + 1e-9, `${colour} in cell ${k}`);
  });
  assert.throws(() => generateCharacter({ params: { eyes: "violet" }, data: TEST_DATA }), /eyes/);
});

test("garment colours: a variant of the worn garment, drawn per garment, set or checked when given", () => {
  const data = TEST_DATA;
  for (let seed = 0; seed < 30; seed++) {
    const { semantic } = generateCharacter({ seed, lod: 2, data });
    for (const slot of SLOTS) {
      const colours = data.garments[semantic.body][semantic[slot]]?.colours ?? [];
      assert.ok(semantic[slot] === "none" ? semantic[`${slot}Colour`] === "none" : colours.includes(semantic[`${slot}Colour`]), `seed ${seed} ${slot}`);
    }
    // Taking the shoes off keeps the top's colour.
    const barefoot = generateCharacter({ seed, lod: 2, params: { shoes: "none" }, data }).semantic;
    assert.equal(barefoot.topColour, semantic.topColour);
    assert.equal(barefoot.shoesColour, "none");
  }
  const drawn = new Set(Array.from({ length: 60 }, (_, seed) => generateCharacter({ seed, lod: 2, params: { top: "tube" }, data }).semantic.topColour));
  assert.deepEqual([...drawn].sort(), ["a", "b"], "seeds draw every colour");
  assert.equal(generateCharacter({ params: { top: "tube", topColour: "b" }, data }).semantic.topColour, "b");
  assert.throws(() => generateCharacter({ params: { top: "tube", topColour: "c" }, data }), /topColour/);
  assert.throws(() => generateCharacter({ params: { top: "none", topColour: "a" }, data }), /topColour/);
});

test("faces: a blend of two of the body's faces and feature sliders move the head only, symmetrically", () => {
  const plain = { ...NAKED, faceMix: 0, ...Object.fromEntries(FEATURES.map(([id]) => [id, 0])) };
  const data = TEST_DATA;
  for (const body of Object.keys(data.shapes)) {
    const F = data.faces[body];
    assert.equal(F.faces.length, 3, `${body} has its faces`);
    const at = (params, lod = 0) => generateCharacter({ seed: 1, lod, params: { body, ...plain, ...params }, data });
    const base = at({ face: F.faces[0], face2: F.faces[0] });
    for (const face of [F.faces[1], F.faces[2]]) {
      const other = at({ face, face2: face });
      const tb = base.mesh.topology, to = other.mesh.topology;
      assert.equal(tb.positions.length, to.positions.length, "the same topology");
      let moved = 0, most = 0;
      for (let i = 0; i < tb.positions.length / 3; i++) {
        const d = Math.hypot(...[0, 1, 2].map((k) => to.positions[i * 3 + k] - tb.positions[i * 3 + k]));
        if (d > 1e-9) { moved++; most = Math.max(most, d); assert.ok(tb.positions[i * 3 + 1] > 1.45, `${body} ${face}: only the head moves (vertex ${i})`); }
      }
      assert.ok(moved > 100 && most < 0.03, `${body} ${face}: ${moved} vertices moved, at most ${most}`);
      // A blend halfway lies halfway.
      const half = at({ face: F.faces[0], face2: face, faceMix: 0.5 }).mesh.topology.positions;
      for (let i = 0; i < half.length; i++) assert.ok(Math.abs(half[i] - (tb.positions[i] + to.positions[i]) / 2) < 1e-9);
    }
    // Every slider moves something, and both ways of a two-sided one differ.
    for (const [id, minus] of FEATURES) {
      const p = at({ face: F.faces[0], face2: F.faces[0], [id]: 1 }).mesh.positions;
      assert.notDeepEqual(p, base.mesh.positions, `${body} ${id}`);
      if (minus) assert.notDeepEqual(at({ face: F.faces[0], face2: F.faces[0], [id]: -1 }).mesh.positions, p, `${body} ${id} both ways`);
    }
    for (const lod of [1, 2]) assert.deepEqual(topologyProblems(at({ face: F.faces[1], face2: F.faces[2], faceMix: 0.3, jaw_width: 1, nose_length: -1 }, lod).mesh.topology), []);
    const tint = faceTint(body, { face: F.faces[0], face2: F.faces[2], faceMix: 0.5 }, data.faces);
    assert.ok(tint.every((x) => x > 0 && x <= 1.2), `${body} tint ${tint}`);
  }
  assert.throws(() => generateCharacter({ params: { faceMix: 2 }, data }), /faceMix/);
  assert.throws(() => generateCharacter({ params: { face: "99" }, data }), /face/);
  assert.ok(!parametersFor(TWO).some((p) => p.id === "face"), "a data set without faces has no face parameters");
});

test("clips: world rotation changes become local rotations for any generated skeleton", () => {
  const { skeleton } = generateCharacter({ seed: 3, lod: 2 });
  const bones = skeleton.bones, index = new Map(bones.map((b, i) => [b.id, i]));
  const mul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
  const close = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-5) || a.every((v, k) => Math.abs(v + b[k]) < 1e-5);
  // A turn of 90° about Y for the left forearm, from frame 1; nothing else moves.
  const turn = [0, Math.SQRT1_2, 0, Math.SQRT1_2], id = [0, 0, 0, 1];
  const clip = { name: "test", fps: 30, frames: 2, loop: true, root: [0, 0, 0, 0, 0.1, 0], rotations: { l_forearm: [...id, ...turn] } };
  const t = clipTracks(skeleton, clip);
  assert.equal(t.times.length, 2);
  // Frame 0 is the rest pose: each local rotation composes back to the rest world rotation.
  const worldAt = (f) => { const w = []; bones.forEach((b, i) => { const l = [...t.rotations[b.id].slice(f * 4, f * 4 + 4)]; w[i] = b.parentIndex < 0 ? l : mul(w[b.parentIndex], l); }); return w; };
  worldAt(0).forEach((q, i) => assert.ok(close(q, bones[i].rotation), `${bones[i].id} at rest`));
  // Frame 1: the forearm and its children turn by the change; its parents stay.
  const w1 = worldAt(1);
  for (const bid of ["l_forearm", "l_hand", "l_finger11"]) assert.ok(close(w1[index.get(bid)], mul(turn, bones[index.get(bid)].rotation)), `${bid} turned`);
  for (const bid of ["l_upperarm", "spine3", "r_forearm"]) assert.ok(close(w1[index.get(bid)], bones[index.get(bid)].rotation), `${bid} stays`);
  assert.ok(Math.abs(t.hips[4] - (bones[0].position[1] + 0.1)) < 1e-6, "the hips' offset");
});

test("clips by role: a T-pose source points the A-pose skeleton's bones where its own point", () => {
  const { skeleton, rig } = generateCharacter({ seed: 3, lod: 2 });
  const bones = skeleton.bones, at = (role) => bones.find((b) => b.id === rig.roles[role]);
  const rot = (q, v) => { const [x, y, z, w] = q, u = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]];
    const t = [2 * u[0], 2 * u[1], 2 * u[2]]; return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]]; };
  const mul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
  const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  // The source: arms out level (a T-pose); frame 1 turns the left upper arm 90° about −z (down).
  const arm = [1, 0, 0];
  const rest = { hips: [0, 1, 0], spine: [0, 1.1, 0], leftUpperArm: [0.2, 1.45, 0], leftLowerArm: [0.2 + 0.3 * arm[0], 1.45 + 0.3 * arm[1], 0], leftHand: [0.2 + 0.55 * arm[0], 1.45 + 0.55 * arm[1], 0] };
  const down = [0, 0, -Math.SQRT1_2, Math.SQRT1_2], id = [0, 0, 0, 1];
  const roleClip = { name: "t", fps: 30, frames: 2, loop: false, rest, hips: [0, 0, 0, 0, 0, 0],
    rotations: { hips: [...id, ...id], leftUpperArm: [...id, ...down], leftLowerArm: [...id, ...down] } };
  const t = clipTracks(skeleton, retargetClip(roleClip, skeleton, rig));
  const worldAt = (f) => { const w = []; bones.forEach((b, i) => { const l = [...t.rotations[b.id].slice(f * 4, f * 4 + 4)]; w[i] = b.parentIndex < 0 ? l : mul(w[b.parentIndex], l); }); return w; };
  const upper = at("leftUpperArm"), lower = at("leftLowerArm"), ui = bones.indexOf(upper);
  const restDir = unit(lower.position.map((v, k) => v - upper.position[k]));
  assert.ok(restDir[1] < -0.5 && restDir[0] > 0.3, "our rest pose is an A-pose: the upper arm points down and out");
  for (const [f, want] of [[0, arm], [1, rot(down, arm)]]) {
    const w = worldAt(f)[ui], d = mul(w, [-upper.rotation[0], -upper.rotation[1], -upper.rotation[2], upper.rotation[3]]);
    const dir = rot(d, restDir);
    assert.ok(Math.hypot(...dir.map((v, k) => v - want[k])) < 1e-4, `frame ${f}: the upper arm points ${dir.map((v) => v.toFixed(3))}, not ${want.map((v) => v.toFixed(3))}`);
  }
});

test("clips by role: the trunk and shoulders stand as the skeleton's rest does in the source's standing pose", () => {
  const { skeleton, rig } = generateCharacter({ seed: 3, lod: 2 });
  const bones = skeleton.bones;
  const mul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
  const close = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-5) || a.every((v, k) => Math.abs(v + b[k]) < 1e-5);
  // The source stands with its chest and shoulder tipped forward 20° from its rest; frame 0 is that
  // standing pose, frame 1 bends the chest 10° further.
  const tip = (deg) => [Math.sin((deg * Math.PI) / 360), 0, 0, Math.cos((deg * Math.PI) / 360)], id = [0, 0, 0, 1];
  const rest = { hips: [0, 1, 0], spine: [0, 1.1, 0], chest: [0, 1.2, 0], upperChest: [0, 1.3, 0], neck: [0, 1.45, 0], head: [0, 1.55, 0], leftShoulder: [0.02, 1.42, 0], leftUpperArm: [0.18, 1.42, 0] };
  const roleClip = { name: "t", fps: 30, frames: 2, loop: false, rest, hips: [0, 0, 0, 0, 0, 0],
    stand: { upperChest: tip(20), leftShoulder: tip(20) },
    rotations: { hips: [...id, ...id], upperChest: [...tip(20), ...tip(30)], leftShoulder: [...tip(20), ...tip(20)] } };
  const t = clipTracks(skeleton, retargetClip(roleClip, skeleton, rig));
  const worldAt = (f) => { const w = []; bones.forEach((b, i) => { const l = [...t.rotations[b.id].slice(f * 4, f * 4 + 4)]; w[i] = b.parentIndex < 0 ? l : mul(w[b.parentIndex], l); }); return w; };
  const chest = bones.findIndex((b) => b.id === rig.roles.upperChest), shoulder = bones.findIndex((b) => b.id === rig.roles.leftShoulder);
  assert.ok(close(worldAt(0)[chest], bones[chest].rotation), "standing, the chest is at rest");
  assert.ok(close(worldAt(0)[shoulder], bones[shoulder].rotation), "standing, the shoulder is at rest");
  assert.ok(close(worldAt(1)[chest], mul(tip(10), bones[chest].rotation)), "the chest bends by the change from standing");
});

test("gait: clip speeds from the stance foot, and a blend by speed that keeps the feet in step", () => {
  const { skeleton, rig } = generateCharacter({ seed: 2, lod: 2 });
  const load = (id) => clipTracks(skeleton, retargetClip(JSON.parse(readFileSync(new URL(`../site/runtime/kit/character/clips/${id}.json`, import.meta.url))), skeleton, rig));
  const [idle, walk, jog] = ["idle", "walk", "jog"].map(load);
  const g = { idle: clipGait(skeleton, idle), walk: clipGait(skeleton, walk), jog: clipGait(skeleton, jog) };
  assert.ok(g.idle.speed < 0.2, `idle stands (${g.idle.speed})`);
  assert.ok(g.walk.speed > 0.4 && g.walk.speed < 2, `walk ${g.walk.speed} m/s`);
  assert.ok(g.jog.speed > g.walk.speed * 1.5 && g.jog.speed < 6, `jog ${g.jog.speed} m/s`);
  const gait = createGait(skeleton, [jog, idle, walk]);
  assert.deepEqual(gait.clips.map((c) => c.name), ["idle", "walk", "jog"], "by speed, idle first");
  const sum = (w) => Object.values(w).reduce((a, b) => a + b, 0);
  for (const [speed, want] of [[0, { idle: 1 }], [g.walk.speed, { walk: 1 }], [(g.walk.speed + g.jog.speed) / 2, { walk: 0.5, jog: 0.5 }], [g.jog.speed * 2, { jog: 1 }]]) {
    const pose = gait.update(1 / 60, speed);
    assert.ok(Math.abs(sum(pose.weights) - 1) < 1e-9, "weights sum to 1");
    for (const [name, w] of Object.entries(want)) assert.ok(Math.abs((pose.weights[name] ?? 0) - w) < 1e-6, `at ${speed.toFixed(2)} m/s ${name} weighs ${pose.weights[name]}`);
    for (const q of Object.values(pose.rotations)) assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-6);
    assert.ok(pose.hips.every(Number.isFinite));
  }
  assert.throws(() => createGait(skeleton, [idle]), /moving clip/);
});

test("feet IK: two-bone IK reaches its target bending the way it bends, and planted feet stop sliding", () => {
  const rot = ([x, y, z, w], v) => { const u = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]], t = u.map((c) => 2 * c);
    return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]]; };
  const add = (a, b) => a.map((v, k) => v + b[k]), sub = (a, b) => a.map((v, k) => v - b[k]);
  const a = [0, 1, 0], b = [0, 0.55, 0.05], c = [0, 0.1, 0];   // a leg, its knee forward
  for (const target of [[0, 0.2, 0.2], [0.1, 0.3, -0.1], [0, -1, 0]]) {
    const [qa, qb] = twoBoneIK(a, b, c, target);
    const knee = add(a, rot(qa, sub(b, a))), end = add(knee, rot(qb, rot(qa, sub(c, b))));
    assert.ok(Math.abs(Math.hypot(...sub(knee, a)) - Math.hypot(...sub(b, a))) < 1e-9 && Math.abs(Math.hypot(...sub(end, knee)) - Math.hypot(...sub(c, b))) < 1e-9, "the bones keep their lengths");
    const reach = Math.hypot(...sub(b, a)) + Math.hypot(...sub(c, b)), want = Math.hypot(...sub(target, a)) <= reach ? target : add(a, sub(target, a).map((v) => (v * reach) / Math.hypot(...sub(target, a))));
    assert.ok(Math.hypot(...sub(end, want)) < 1e-5, `reaches ${target} (${end.map((v) => v.toFixed(3))})`);
    // The knee stays on its side of the line from hip to ankle: the bend's plane keeps its sense.
    const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    if (Math.hypot(...sub(target, a)) < reach) assert.ok(dot(cross(sub(c, a), sub(b, a)), cross(sub(end, a), sub(knee, a))) > 0, `the knee bends the same way for ${target}`);
  }
  // Walking a straight line 15 % faster than the walk: unplanted, the stance foot slides; planted, it does not.
  const { skeleton, rig } = generateCharacter({ seed: 2, lod: 2 });
  const walk = clipTracks(skeleton, retargetClip(JSON.parse(readFileSync(new URL("../site/runtime/kit/character/clips/walk.json", import.meta.url))), skeleton, rig));
  const speed = clipGait(skeleton, walk).speed * 1.15, dt = 1 / 60;
  const slide = (plant) => {
    const gait = createGait(skeleton, [walk]), feet = createFootLock(skeleton);
    let travel = 0, run = null, most = 0;
    const low = Math.min(...trackPositions(skeleton, walk, ["l_foot"]).l_foot.map((p) => p[1]));
    for (let f = 0; f < 300; f++) {
      const pose = gait.update(dt, speed); travel += speed * dt;
      if (plant) feet.apply(pose, { forward: speed * dt, dt });
      const one = { frames: 1, rotations: Object.fromEntries(Object.entries(pose.rotations).map(([id, q]) => [id, Float32Array.from(q)])), hips: Float32Array.from(pose.hips), times: [0], duration: 1 };
      const ankle = trackPositions(skeleton, one, ["l_foot"]).l_foot[0], z = ankle[2] + travel;
      // While the foot is flat (within 1 cm of its lowest; above that the heel lifts to push off).
      if (f > 60 && ankle[1] < low + 0.01) { run ??= z; most = Math.max(most, Math.abs(z - run)); } else run = null;
    }
    return most;
  };
  const off = slide(false), on = slide(true);
  assert.ok(off > 0.02, `unplanted, the foot slides ${off}`);
  assert.ok(on < 0.01, `planted, it slides ${on}`);
});

test("the repository's data: every texture it names is beside it, every asset CC0", () => {
  const names = new Set([...Object.values(DEFAULT_DATA.textures), ...Object.values(DEFAULT_DATA.faces).flatMap((f) => f.skins ?? []),
    ...Object.values(DEFAULT_DATA.garments).flatMap((g) => Object.values(g).map((x) => x.texture).filter(Boolean))]);
  assert.ok(names.size > 10);
  for (const name of names) assert.ok(existsSync(new URL(name, DEFAULT_DATA.textureRoot)), `texture ${name}`);
  assert.ok(DEFAULT_DATA.sources.length > 10);
  for (const source of DEFAULT_DATA.sources) assert.match(source.license, /^CC0/i, `${source.id}: ${source.license}`);
});

test("1 000 random characters generate sound meshes", () => {
  let seed = 0;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  for (let k = 0; k < 1000; k++) {
    // Every other one from the test set (garments and faces), with some of its parameters set.
    const data = k % 2 ? TEST_DATA : DEFAULT_DATA, params = {};
    if (rand() < 0.5) params.body = pick(parametersFor(data).find((p) => p.id === "body").options);
    const lod = k % LODS.length;
    // The body alone is closed; dressed, every value is finite and every island has faces.
    const naked = generateCharacter({ seed: k, params: { ...params, ...NAKED }, lod, data });
    assert.deepEqual(topologyProblems(naked.mesh.topology), [], `seed ${k} lod ${lod} ${JSON.stringify(params)}`);
    const body = naked.semantic.body;
    // A garment that covers other slots (an outfit) leaves them unchosen.
    const covered = new Set();
    for (const slot of SLOTS) {
      if (covered.has(slot) || rand() >= 0.5) continue;
      params[slot] = pick(["none", ...garmentsFor(body, slot, data)]);
      for (const other of data.garments[body]?.[params[slot]]?.covers ?? []) covered.add(other);
    }
    for (const p of parametersFor(data)) if (p.range && rand() < 0.2) params[p.id] = p.range[0] + rand() * (p.range[1] - p.range[0]);
    const c = generateCharacter({ seed: k, params, lod, data });
    for (const key of ["positions", "normals", "uvs", "weights"]) assert.ok(c.mesh[key].every(Number.isFinite), `seed ${k} ${key}`);
    assert.ok(c.mesh.groups.every((g) => g.count > 0), `seed ${k} empty island`);
  }
});

test("golden: seed 1 at LOD0 is unchanged (bump GENERATOR_VERSION when this changes on purpose)", () => {
  const { mesh } = generateCharacter({ seed: 1, lod: 0 });
  const hash = createHash("sha256");
  for (const key of ["positions", "normals", "uvs", "joints", "weights", "indices"]) hash.update(Buffer.from(mesh[key].buffer));
  assert.equal(hash.digest("hex").slice(0, 16), "cc87e8c68824e542");
});

