import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as THREE from "three";
import { KEY_RULE, TRANSITIONS, transitionClip, armClearance, bankAngle, bankPose, bodyPoints, characterObject, characterSoles, characterTracks, clipGait, clipTracks, createFootLock, createGait, createWalker, lookPose, locomotionClip, locomotionClips, locomotionStyle, retargetClip, trackPositions, twoBoneIK, DEFAULT_DATA, FEATURES, faceTint, garmentsFor, generateCharacter, LODS, parametersFor, PARAMETERS, SLOTS } from "../site/runtime/kit/character.js";
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
  const motions = JSON.parse(readFileSync(new URL("../site/runtime/kit/character/clips/motions.json", import.meta.url)));
  const load = (id) => clipTracks(skeleton, retargetClip(locomotionClip(motions, "m", id), skeleton, rig));
  const [idle, walk, jog] = ["idle", "walk", "jog"].map(load);
  const g = { idle: clipGait(skeleton, idle), walk: clipGait(skeleton, walk), jog: clipGait(skeleton, jog) };
  assert.ok(g.idle.speed < 0.2, `idle stands (${g.idle.speed})`);
  assert.ok(g.walk.speed > 0.4 && g.walk.speed < 2, `walk ${g.walk.speed} m/s`);
  assert.ok(g.jog.speed > g.walk.speed * 1.2 && g.jog.speed < 6, `jog ${g.jog.speed} m/s`);
  const gait = createGait(skeleton, [jog, idle, walk]);
  assert.deepEqual(gait.clips.map((c) => c.name), ["idle", "walk", "jog"], "by speed, idle first");
  const sum = (w) => Object.values(w).reduce((a, b) => a + b, 0);
  for (const [speed, want] of [[0, { idle: 1 }], [g.walk.speed, { walk: 1 }], [(g.walk.speed + g.jog.speed) / 2, { walk: 0.5, jog: 0.5 }], [g.jog.speed * 2, { jog: 1 }]]) {
    for (let k = 0; k < 120; k++) gait.update(1 / 60, speed);   // the idle comes and goes over 0.3 s, the blend's speed follows at 4 m/s²
    const pose = gait.update(1 / 60, speed);
    assert.ok(Math.abs(sum(pose.weights) - 1) < 1e-9, "weights sum to 1");
    for (const [name, w] of Object.entries(want)) assert.ok(Math.abs((pose.weights[name] ?? 0) - w) < 1e-6, `at ${speed.toFixed(2)} m/s ${name} weighs ${pose.weights[name]}`);
    for (const q of Object.values(pose.rotations)) assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-6);
    assert.ok(pose.hips.every(Number.isFinite));
  }
  assert.throws(() => createGait(skeleton, [idle]), /moving clip/);
});

test("motions keep the rule for key poses from reference motion: at most five per motion and body, the main joints only, in steps of 5° and whole centimetres", () => {
  const motions = JSON.parse(readFileSync(new URL("../site/runtime/kit/character/clips/motions.json", import.meta.url)));
  const joints = new Set(KEY_RULE.joints), onStep = (v) => v.every((x) => Number.isInteger(x) && x % KEY_RULE.step === 0);
  const cm = (v) => v.every((x) => Math.abs(x * 100 - Math.round(x * 100)) < 1e-9);
  const rest = new Set([...KEY_RULE.joints, "leftHand", "rightHand", "leftToes", "rightToes", "leftMiddleProximal", "rightMiddleProximal"]);
  assert.deepEqual(Object.keys(motions).sort(), ["bodies", "rule"]);
  for (const [body, m] of Object.entries(motions.bodies)) {
    assert.deepEqual(Object.keys(m).sort(), ["motions", "rest", "stand"], `${body}: only rest positions, a standing pose and motions`);
    for (const r of Object.keys(m.rest)) assert.ok(rest.has(r), `${body} rest of ${r}`);
    for (const [r, v] of Object.entries(m.stand)) { assert.ok(joints.has(r), `${body} stand ${r}`); assert.ok(onStep(v), `${body} stand ${r} ${v}`); }
    for (const [name, g] of Object.entries(m.motions)) {
      assert.ok(g.keys.length <= KEY_RULE.keys, `${body} ${name}: ${g.keys.length} key poses`);
      const twentieths = (v) => v.every((x) => Math.abs(x * 20 - Math.round(x * 20)) < 1e-9);
      if (g.cycle) assert.deepEqual(Object.keys(g).filter((k) => !["cycle", "bob", "keys"].includes(k)), [], `${body} ${name}: only a cycle, a bob and key poses`);
      else {
        assert.deepEqual(Object.keys(g).sort(), ["duration", "keys", "travel", "turn", "window"], `${body} ${name}: a transition's length, turn, travel, window and key poses`);
        assert.ok(twentieths([g.duration, ...g.window]) && cm([g.travel]) && g.turn % KEY_RULE.step === 0, `${body} ${name}: its scalars`);
      }
      if (g.bob != null) assert.ok(cm([g.bob]), `${body} ${name} bob`);
      for (const { phase, time, pose } of g.keys) {
        if (g.cycle) assert.ok(phase >= 0 && phase < 1);
        else assert.ok(twentieths([time]) && time <= g.duration, `${body} ${name}: a key at ${time}`);
        for (const [r, v] of Object.entries(pose)) {
          if (r === "hipsOffset") { assert.ok(cm(v), `${body} ${name} hips ${v}`); continue; }
          assert.ok(joints.has(r), `${body} ${name}: ${r} is not a main joint`);
          assert.ok(onStep(v), `${body} ${name} ${r}: ${v} not in steps of ${KEY_RULE.step}°`);
        }
      }
    }
  }
});

test("locomotion: the model's gaits loop, go faster in turn, start at the left heel strike and take a style; planted, the feet hold", () => {
  const model = JSON.parse(readFileSync(new URL("../site/runtime/kit/character/clips/motions.json", import.meta.url)));
  for (const body of ["m", "f"]) {
    const { skeleton, rig } = generateCharacter({ seed: 4, lod: 2, params: { body } });
    const clips = locomotionClips(model, body);
    assert.deepEqual(clips.map((c) => c.name), ["idle", "stroll", "walk", "brisk", "jog", "run", "sprint"]);
    const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
    let last = 0;
    for (const clip of clips) {
      // The loop's seam is no bigger a step than the clip's others.
      for (const q of Object.values(clip.rotations)) {
        const at = (f) => [...q.slice(f * 4, f * 4 + 4)], n = clip.frames;
        let most = 0;
        for (let f = 1; f < n; f++) most = Math.max(most, angle(at(f - 1), at(f)));
        assert.ok(angle(at(n - 1), at(0)) <= most * 1.5 + 1e-3, `${body} ${clip.name}: the loop jumps`);
      }
      const tracks = clipTracks(skeleton, retargetClip(clip, skeleton, rig)), gait = clipGait(skeleton, tracks);
      if (clip.name === "idle") { assert.ok(gait.speed < 0.1, `${body} idle stands (${gait.speed})`); continue; }
      assert.ok(gait.speed > last * 1.05, `${body} ${clip.name}: ${gait.speed.toFixed(2)} m/s after ${last.toFixed(2)}`);
      last = gait.speed;
      assert.ok(gait.contact < 0.1 || gait.contact > 0.9, `${body} ${clip.name}: the left foot comes down at phase ${gait.contact}`);
    }
    assert.ok(last > 4, `${body} sprints at ${last.toFixed(2)} m/s`);
    // Walking and running at speeds between the gaits, a planted foot moves under 2 cm while the gait says it is down.
    const tracks = clips.map((clip) => clipTracks(skeleton, retargetClip(clip, skeleton, rig)));
    for (const speed of [0.7, 1.2, 2.5, 4]) {
      const gait = createGait(skeleton, tracks), feet = createFootLock(skeleton), dt = 1 / 60, held = {};
      let travel = 0, most = 0;
      for (let f = 0; f < 400; f++) {
        const pose = gait.update(dt, speed); travel += speed * dt;
        feet.apply(pose, { forward: speed * dt, dt });
        if (f < 100) continue;
        const one = { frames: 1, rotations: Object.fromEntries(Object.entries(pose.rotations).map(([id, q]) => [id, Float32Array.from(q)])), hips: Float32Array.from(pose.hips), times: [0], duration: 1 };
        const at = trackPositions(skeleton, one, ["l_foot", "r_foot"]);
        for (const id of ["l_foot", "r_foot"]) {
          const z = at[id][0][2] + travel;
          if (pose.contacts[id] > 0.99) { held[id] ??= z; most = Math.max(most, Math.abs(z - held[id])); } else held[id] = null;
        }
      }
      assert.ok(most < 0.02, `${body} at ${speed} m/s a planted foot moves ${(most * 100).toFixed(1)} cm`);
    }
  }
  // A style: the arms swing wider, the pace takes shorter cycles; a seed's own style is its own.
  const swing = (clip) => {
    const q = clip.rotations.leftUpperArm, x = [];
    for (let f = 0; f < clip.frames; f++) x.push(2 * Math.atan2(q[f * 4], q[f * 4 + 3]));
    return Math.max(...x) - Math.min(...x);
  };
  const plain = locomotionClip(model, "m", "walk"), wide = locomotionClip(model, "m", "walk", { style: { arms: 1.5, pace: 1.1 } });
  assert.ok(swing(wide) > swing(plain) * 1.3, "arms 1.5 swing wider");
  assert.ok(wide.frames < plain.frames, "a faster pace, a shorter cycle");
  assert.deepEqual(locomotionStyle(7), locomotionStyle(7));
  assert.notDeepEqual(locomotionStyle(7), locomotionStyle(8));
  for (const v of Object.values(locomotionStyle("crowd"))) assert.ok(v > 0.8 && v < 1.2);
});

test("steering: a turn leans the body in about the ground and turns the head; the walker eases its speed, lean and look", () => {
  const character = generateCharacter({ seed: 5, lod: 2 }), { skeleton, rig } = character;
  const rot = ([x, y, z, w], v) => { const u = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]], t = u.map((c) => 2 * c); return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]]; };
  assert.ok(Math.abs(bankAngle(3, 1) - Math.atan(3 / 9.81)) < 1e-9 && bankAngle(3, -1) < 0 && bankAngle(20, 5) === 0.35, "the lean of a turn, limited");
  const rest = () => ({ rotations: Object.fromEntries(skeleton.bones.map((b, i) => [b.id, b.parentIndex < 0 ? [...b.rotation] : null])), hips: [...skeleton.bones[0].position] });
  const pose = rest();
  // Local rest rotations from the bones' world ones.
  const mul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
  skeleton.bones.forEach((b) => { if (b.parentIndex >= 0) { const p = skeleton.bones[b.parentIndex].rotation; pose.rotations[b.id] = mul([-p[0], -p[1], -p[2], p[3]], b.rotation); } });
  const one = (p) => ({ frames: 1, rotations: Object.fromEntries(Object.entries(p.rotations).map(([id, q]) => [id, Float32Array.from(q)])), hips: Float32Array.from(p.hips), times: [0], duration: 1 });
  const head = rig.roles.head, before = trackPositions(skeleton, one(pose), [head])[head][0];
  const leant = bankPose(skeleton, structuredClone(pose), 0.2), after = trackPositions(skeleton, one(leant), [head])[head][0];
  assert.ok(after[0] - before[0] > 0.2 && after[1] < before[1], `leaning left (+x) the head goes left and down (${after.map((v) => v.toFixed(2))})`);
  assert.ok(Math.abs(leant.hips[0] - pose.hips[0] - Math.sin(0.2) * pose.hips[1]) < 1e-6, "pivoting on the ground under the hips");
  const looked = lookPose(skeleton, rig, structuredClone(pose), 0.5);
  const world = (p, id) => { const w = []; skeleton.bones.forEach((b, i) => { w[i] = b.parentIndex < 0 ? p.rotations[b.id] : mul(w[b.parentIndex], p.rotations[b.id]); }); return w[skeleton.bones.findIndex((b) => b.id === id)]; };
  const ahead = (p) => { const q = world(p, head), r = skeleton.bones.find((b) => b.id === head).rotation, d = mul(q, [-r[0], -r[1], -r[2], r[3]]), f = rot(d, [0, 0, 1]); return Math.atan2(f[0], f[2]); };
  assert.ok(Math.abs(ahead(looked) - ahead(pose) - 0.5) < 1e-6, "the head turns by the whole look");
  assert.deepEqual(looked.rotations[skeleton.bones[0].id], pose.rotations[skeleton.bones[0].id], "the hips stay");
  // The walker: from standing toward 3 m/s at 2.5 m/s², leaning into a turn over time.
  const model = JSON.parse(readFileSync(new URL("../site/runtime/kit/character/clips/motions.json", import.meta.url)));
  const object = characterObject(THREE, character), walker = createWalker(THREE, object, character, locomotionClips(model, character.semantic.body));
  walker.update(0.1, { speed: 3, turn: 0.5 });
  assert.ok(Math.abs(walker.state.speed - 0.25) < 1e-9, `eases its speed (${walker.state.speed})`);
  for (let k = 0; k < 120; k++) walker.update(1 / 30, { speed: 3, turn: 0.5 });
  assert.equal(walker.state.speed, 3);
  assert.ok(Math.abs(walker.state.lean - bankAngle(3, 0.5)) < 0.01, `leans into the turn (${walker.state.lean})`);
  assert.ok(walker.state.look > 0.15, "looks into the turn");
  for (let k = 0; k < 60; k++) walker.update(1 / 30, { speed: 0 });
  assert.equal(walker.state.speed, 0, "and stops");
});

test("transitions: a walker starts, stops, turns on the spot toward a facing and turns about while running", () => {
  const motions = JSON.parse(readFileSync(new URL("../site/runtime/kit/character/clips/motions.json", import.meta.url)));
  for (const body of ["m", "f"]) {
    const character = generateCharacter({ seed: 8, lod: 2, params: { body } }), object = characterObject(THREE, character);
    const transitions = TRANSITIONS.flatMap((name) => ["left", "right"].map((side) => transitionClip(motions, body, name, { side })));
    for (const clip of transitions) assert.ok(clip.frames > 10 && clip.motion.end <= clip.motion.duration && !clip.loop, clip.name);
    assert.ok(transitions.find((c) => c.name === "turn90Right").motion.turn < 0 && transitions.find((c) => c.name === "turn90Left").motion.turn > 0, "the right turns the other way");
    const walker = createWalker(THREE, object, character, locomotionClips(motions, body), { transitions });
    const seen = new Set();
    const run = (seconds, ask) => { for (let k = 0; k < seconds * 30; k++) { walker.update(1 / 30, ask); if (walker.state.playing) seen.add(walker.state.playing.replace(/(Left|Right)$/, "")); } };
    run(0.5, { speed: 0 }); run(3, { speed: 1.4 }); run(3, { speed: 0 });
    run(3, { speed: 0, facing: Math.PI / 2 });
    assert.ok(Math.abs(Math.atan2(Math.sin(object.rotation.y - Math.PI / 2), Math.cos(object.rotation.y - Math.PI / 2))) < 0.05, `${body}: turned to face the left (${object.rotation.y})`);
    run(3, { speed: 4, facing: Math.PI / 2 }); run(4, { speed: 4, facing: -Math.PI / 2 }); run(4, { speed: 0, facing: -Math.PI / 2 });
    for (const kind of ["walkStart", "walkStop", "turn90", "runStart", "runTurn180", "runStop"]) assert.ok(seen.has(kind), `${body}: played ${kind} (${[...seen]})`);
    assert.ok(Math.abs(Math.atan2(Math.sin(object.rotation.y + Math.PI / 2), Math.cos(object.rotation.y + Math.PI / 2))) < 0.1, `${body}: faces about (${object.rotation.y})`);
    assert.equal(walker.state.speed, 0);
  }
});

test("turning on the spot, the walker steps round: one foot at a time, as it turns (none after), ending where it stood, facing about", () => {
  const motions = JSON.parse(readFileSync(new URL("../site/runtime/kit/character/clips/motions.json", import.meta.url)));
  for (const body of ["m", "f"]) {
    const character = generateCharacter({ seed: 9, lod: 2, params: { body } }), object = characterObject(THREE, character);
    const walker = createWalker(THREE, object, character, locomotionClips(motions, body));
    for (let k = 0; k < 60; k++) walker.update(1 / 60, { speed: 0 });
    const feet = ["l_foot", "r_foot"].map((id) => object.skeleton.bones.find((b) => b.name === id)), v = new THREE.Vector3();
    const rest = feet.map((b) => { object.updateMatrixWorld(true); return b.getWorldPosition(v).y; }), stepped = [false, false];
    let lifted = [false, false], late = 0;
    for (let k = 0; k < 240; k++) {
      walker.update(1 / 60, { speed: 0, facing: Math.PI });
      object.updateMatrixWorld(true);
      const up = feet.map((b, i) => b.getWorldPosition(v).y > rest[i] + 0.02);
      up.forEach((u, i) => { if (u) stepped[i] = true; });
      // A step begun with the turn nearly done (within 10°) is one left over, after the turn.
      const left = Math.abs(Math.atan2(Math.sin(object.rotation.y - Math.PI), Math.cos(object.rotation.y - Math.PI)));
      up.forEach((u, i) => { if (u && !lifted[i] && left < 0.17) late++; });
      lifted = up;
      assert.ok(!(up[0] && up[1]), `${body}: both feet up at once`);
    }
    assert.ok(stepped[0] && stepped[1], `${body}: both feet stepped (${stepped})`);
    assert.equal(late, 0, `${body}: steps after the turn`);
    assert.ok(Math.abs(Math.atan2(Math.sin(object.rotation.y - Math.PI), Math.cos(object.rotation.y - Math.PI))) < 0.03, `${body}: faces about (${object.rotation.y})`);
    // It turns about where its feet stand, toward the foot on the side it turns to: the origin goes
    // round that, a turn about moving it a stride's length or so (the reference's, 30 cm).
    assert.ok(object.position.length() < 0.4, `${body}: where it stood (${object.position.length()})`);
  }
});

test("a character's clips stay on the ground, feet and body, with the hands out of the thighs", () => {
  const model = JSON.parse(readFileSync(new URL("../site/runtime/kit/character/clips/motions.json", import.meta.url)));
  const clipOf = (id) => JSON.parse(readFileSync(new URL(`../site/runtime/kit/character/clips/${id}.json`, import.meta.url)));
  const mul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
  const rot = ([x, y, z, w], v) => { const u = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]], t = u.map((c) => 2 * c); return [v[0] + w * t[0] + y * t[2] - z * t[1], v[1] + w * t[1] + z * t[0] - x * t[2], v[2] + w * t[2] + x * t[1] - y * t[0]]; };
  const sub = (a, b) => a.map((v, k) => v - b[k]), add = (a, b) => a.map((v, k) => v + b[k]);
  const seg = (p, a, b) => { const ab = sub(b, a), t = Math.max(0, Math.min(1, sub(p, a).reduce((s, v, k) => s + v * ab[k], 0) / ab.reduce((s, v) => s + v * v, 0))); return Math.hypot(...sub(p, add(a, ab.map((v) => v * t)))); };
  for (const body of ["m", "f"]) {
    const character = generateCharacter({ seed: 6, lod: 1, params: { body } }), { skeleton } = character, bones = skeleton.bones, index = new Map(bones.map((b, i) => [b.id, i]));
    const points = [...bodyPoints(character), ...Object.entries(characterSoles(character)).flatMap(([id, ps]) => ps.map((at) => ({ bone: index.get(id), at })))];
    const clear = armClearance(character);
    for (const [name, clip] of [["walk_formal", clipOf("walk_formal")], ["death", clipOf("death")], ["crouch", clipOf("crouch_idle")], ...locomotionClips(model, body).map((c) => [`loco ${c.name}`, c])]) {
      const t = characterTracks(character, clip);
      let low = 0, deep = 0;
      for (let f = 0; f < t.times.length; f++) {
        const W = [], P = [];
        bones.forEach((b, i) => {
          const l = [...t.rotations[b.id].slice(f * 4, f * 4 + 4)];
          if (b.parentIndex < 0) { W[i] = l; P[i] = [...t.hips.slice(f * 3, f * 3 + 3)]; return; }
          const pb = bones[b.parentIndex];
          W[i] = mul(W[b.parentIndex], l); P[i] = add(P[b.parentIndex], rot(W[b.parentIndex], rot([-pb.rotation[0], -pb.rotation[1], -pb.rotation[2], pb.rotation[3]], sub(b.position, pb.position))));
        });
        for (const p of points) low = Math.min(low, P[p.bone][1] + rot(W[p.bone], p.at)[1]);
        for (const [hand, hs] of Object.entries(clear.hands)) for (const o of hs) {
          const p = add(P[index.get(hand)], rot(W[index.get(hand)], o));
          for (const c of clear.capsules) deep = Math.max(deep, c.radius - seg(p, P[index.get(c.a)], P[index.get(c.b)]));
        }
      }
      assert.ok(low > -0.012, `${body} ${name}: a point ${(-low * 100).toFixed(1)} cm under the ground`);
      if (!["death", "crouch"].includes(name)) assert.ok(deep < 0.012, `${body} ${name}: a hand ${(deep * 100).toFixed(1)} cm in the body`);
    }
  }
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
  const walk = clipTracks(skeleton, retargetClip(locomotionClip(JSON.parse(readFileSync(new URL("../site/runtime/kit/character/clips/motions.json", import.meta.url))), "m", "walk"), skeleton, rig));
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
  assert.ok(on < 0.015, `planted, it slides ${on}`);   // the lock eases in and out over 0.08 s
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

